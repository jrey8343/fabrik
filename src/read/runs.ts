// The runs read (#617): one read of a repo's Actions that says which agent
// runs are in flight, each with what the Kit job's closing line said of it
// (#616), and when the repo's Tick last started. A run with no closing line,
// from a release before the step, is told by its jobs' names as the Standing
// tells it. It never throws: each half GitHub refuses or fails is "unread".
import type { ReadClient, Repo } from "../github/client.ts";
import {
  type ActionsJob,
  isAgentJobNamed,
  isJobNamed,
  jobsOfUnfinishedRuns,
  KIT_JOB_NAME,
  PUSH_JOB_NAME,
  REPLAY_ARM_JOB_NAMES,
  REPLAY_RECORD_JOB_NAME,
  type RunJob,
  type RunKind,
} from "../github/snapshot.ts";
import { type KitSaid, kitSaidIn } from "../kit/kitSaid.ts";
import type { AgentRole } from "../loop/types.ts";

/** What a read of a repo's Actions says: its runs in flight, and when its Tick last started. */
export interface RunsRead {
  /** The repo read, `owner/name`. */
  readonly repo: string;
  /** When it was read, ISO 8601. */
  readonly readAt: string;
  readonly runs: readonly RunInFlight[] | "unread";
  readonly tick: { readonly lastStartedAt: string | null } | "unread";
}

/** An agent run in flight, as Actions and the Kit job's closing line tell it. */
export interface RunInFlight {
  /** The Actions run, and its attempt. */
  readonly run: number;
  readonly attempt: number;
  /** True when read from the closing line, false when from job names. */
  readonly exact: boolean;
  readonly role: AgentRole | "replay";
  readonly issue: number | null;
  readonly pullRequest: number | null;
  readonly kind: RunKind | null;
  /** The Retry number; null unless a Retry. */
  readonly retry: number | null;
  readonly model: string | null;
  readonly job: RunJob;
  /** When Actions created the run, ISO 8601. */
  readonly createdAt: string;
  /** When its agent job got a runner, ISO 8601; null until it has. */
  readonly startedAt: string | null;
  /** The agent job's page, where its live log is; the run's page until that job is listed. */
  readonly url: string;
}

/** What `owner/product` reads in Actions: its runs in flight, and when its Tick last started; never throws. */
export async function readRuns(client: Pick<ReadClient, "rest">, repo: string, now: string): Promise<RunsRead> {
  const target = repoOf(repo);
  const runs = await readInFlight(client, target);
  return { repo, readAt: now, runs, tick: "unread" };
}

function repoOf(repo: string): Repo {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, name };
}

async function readInFlight(client: Pick<ReadClient, "rest">, repo: Repo): Promise<readonly RunInFlight[] | "unread"> {
  let jobs: ActionsJob[];
  try {
    jobs = await jobsOfUnfinishedRuns(client, repo);
  } catch {
    return "unread";
  }
  const runs = new Map<number, ActionsJob[]>();
  for (const job of jobs) runs.set(job.run, [...(runs.get(job.run) ?? []), job]);
  return [...runs.keys()].sort((a, b) => a - b).flatMap((run) => inFlightOf(runs.get(run) ?? []));
}

/** The run in flight one workflow run's jobs say, if any. */
function inFlightOf(jobs: readonly ActionsJob[]): RunInFlight[] {
  const named = (jobName: string) => jobs.find((job) => job.conclusion !== "skipped" && isJobNamed(job.name, jobName));
  const kit = named(KIT_JOB_NAME);
  if (kit === undefined || kit.status !== "completed") return [];
  const said = kitSaidIn(kit.steps);
  if (said === null) return [];
  if (said.replay !== null) return replayRunOf(said.replay, jobs, named(REPLAY_RECORD_JOB_NAME));
  if (said.run === null) return [];
  return exactRunOf(said.run, jobs, named(PUSH_JOB_NAME));
}

/**
 * A Replay's run, one entry on the replay issue: running once any of its
 * Arms' jobs has a runner, since the first of them got one, and waiting for a
 * runner before; none once the job that records it has finished. Its Arms are
 * several jobs, so its page is the run's.
 */
function replayRunOf(replay: NonNullable<KitSaid["replay"]>, jobs: readonly ActionsJob[], record: ActionsJob | undefined): RunInFlight[] {
  const [first] = jobs;
  if (first === undefined || record?.status === "completed") return [];
  const arms = jobs.filter((job) => job.conclusion !== "skipped" && REPLAY_ARM_JOB_NAMES.some((name) => isReplayArmNamed(job.name, name)));
  const started = arms.flatMap(({ startedAt }) => (startedAt === null ? [] : [startedAt])).sort();
  const running = started.length > 0 || record !== undefined;
  return [
    {
      run: first.run,
      attempt: first.attempt,
      exact: true,
      role: "replay",
      issue: replay.issue,
      pullRequest: null,
      kind: null,
      retry: null,
      model: null,
      job: running ? "running" : "waiting-for-runner",
      createdAt: first.createdAt,
      startedAt: started[0] ?? null,
      url: first.runUrl,
    },
  ];
}

/** Whether a job's name is an Arm's job's: `<name> (<arm>)`, after `<caller job> / ` when a caller workflow ran it. */
function isReplayArmNamed(name: string, jobName: string): boolean {
  const arm = / \([^()]+\)$/.exec(name);
  return arm !== null && isJobNamed(name.slice(0, arm.index), jobName);
}

/** The run a closing line names, from its agent job: none once its push job has finished, or once that job is passed over. */
function exactRunOf(said: NonNullable<KitSaid["run"]>, jobs: readonly ActionsJob[], push: ActionsJob | undefined): RunInFlight[] {
  if (push?.status === "completed") return [];
  const [first] = jobs;
  if (first === undefined) return [];
  const agent = jobs.find((job) => job.conclusion !== "skipped" && isAgentJobNamed(said.role, job.name));
  const base = {
    run: first.run,
    attempt: first.attempt,
    exact: true,
    role: said.role,
    issue: said.issue,
    pullRequest: said.pullRequest,
    kind: said.kind,
    retry: said.retry === 0 ? null : said.retry,
    model: said.model,
    createdAt: first.createdAt,
  };
  if (agent !== undefined) return [{ ...base, job: jobOf(agent), startedAt: agent.startedAt, url: agent.url }];
  // Its push job waits on every agent job, so once it is listed the agent job was passed over.
  if (push !== undefined) return [];
  // Actions lists no job still waiting on those before it: a Review's wait for its checks, a Retro's evidence.
  return [{ ...base, job: said.role === "review" ? "waiting-on-checks" : "waiting-for-runner", startedAt: null, url: first.runUrl }];
}

/** Where an agent job is, from its status: done is landing. */
function jobOf({ status }: ActionsJob): RunJob {
  if (status === "completed") return "landing";
  if (status === "in_progress") return "running";
  return status === "queued" ? "waiting-for-runner" : "blocked";
}
