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
  jobOf,
  jobsOfUnfinishedRuns,
  KIT_JOB_NAME,
  PUSH_JOB_NAME,
  REPLAY_ARM_JOB_NAMES,
  REPLAY_RECORD_JOB_NAME,
  type RunInFlightFact,
  type RunJob,
  type RunKind,
  runsByJobNamesOf,
} from "../github/snapshot.ts";
import { type KitSaid, kitSaidIn } from "../kit/kitSaid.ts";
import type { AgentRole } from "../loop/types.ts";
import { CALLER_FILE } from "../setup/shims.ts";

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
  const [runs, tick] = await Promise.all([readInFlight(client, target), readTick(client, target)]);
  return { repo, readAt: now, runs, tick };
}

/**
 * The minutes after which a Tick that has not started is dead, as Home calls
 * it (#527), beside the Tick's interval (TICK_MINUTES). Nothing in the Kit
 * acts on it: the Dead-tick issue keeps its own 25 hours.
 */
export const TICK_DEAD_MINUTES = 120;

interface ListedScheduledRun {
  readonly status: string;
  readonly conclusion: string | null;
  readonly run_started_at?: string | null;
}

/** The statuses of a workflow run that has started its jobs: one GitHub refused at startup completes too, and is told by its conclusion. */
const STARTED_RUNS = ["in_progress", "completed"];

/**
 * When the repo's Tick last started: the newest scheduled run of its caller
 * workflow that started its jobs, in one request. A run GitHub refused at
 * startup has not started, nor one still waiting to begin. The daily Tick
 * check reads the same Tick from its check runs on the default branch.
 */
async function readTick(client: Pick<ReadClient, "rest">, repo: Repo): Promise<RunsRead["tick"]> {
  let page: { workflow_runs: ListedScheduledRun[] };
  try {
    page = (await client.rest("GET", `/repos/${repo.owner}/${repo.name}/actions/workflows/${CALLER_FILE}/runs?event=schedule&per_page=100`)) as typeof page;
  } catch {
    return "unread";
  }
  const started = page.workflow_runs.filter((run) => STARTED_RUNS.includes(run.status) && run.conclusion !== "startup_failure" && run.run_started_at != null);
  const newest = started.map((run) => run.run_started_at ?? "").sort().at(-1);
  return { lastStartedAt: newest ?? null };
}

/**
 * The Standing rule's runs-in-flight fact from a runs read: the one reader of
 * it, wherever it is read, the Weekly summary's gather included. Unread stays
 * unread. A Replay's run is in it too, though no Standing awaits one.
 */
export function runsInFlightFactOf(read: RunsRead): readonly RunInFlightFact[] | "unread" {
  if (read.runs === "unread") return "unread";
  return read.runs.map((run) => ({
    role: run.role,
    issue: run.issue,
    pullRequest: run.pullRequest,
    retry: run.retry,
    kind: run.kind,
    job: run.job,
    createdAt: run.createdAt,
    exact: run.exact,
    run: run.run,
    attempt: run.attempt,
    startedAt: run.startedAt,
  }));
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
  // Until the Kit job has completed, its closing step's name is the workflow file's text, and no agent job is listed.
  if (kit !== undefined && kit.status !== "completed") return [];
  const said = kit === undefined ? null : kitSaidIn(kit.steps);
  if (said === null) return byJobNamesOf(jobs);
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

/**
 * The runs a workflow run's jobs' names tell, as the Standing tells them, for
 * a run from a release before the closing step, or whose step can't be read:
 * not exact, with no model, at the job's page, but a Review's wait for its
 * checks, whose Review job isn't listed yet, at the run's.
 */
function byJobNamesOf(jobs: readonly ActionsJob[]): RunInFlight[] {
  return runsByJobNamesOf(jobs).map(({ fact, job }) => ({
    run: fact.run,
    attempt: fact.attempt,
    exact: false,
    role: fact.role,
    issue: fact.issue,
    pullRequest: fact.pullRequest,
    kind: fact.kind,
    retry: fact.retry,
    model: null,
    job: fact.job,
    createdAt: fact.createdAt,
    startedAt: fact.startedAt,
    url: fact.job === "waiting-on-checks" ? job.runUrl : job.url,
  }));
}
