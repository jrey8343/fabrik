// The runs read (#617): one read of a repo's Actions that says which agent
// runs are in flight, each with what the Kit job's closing line said of it
// (#616), and when the repo's Tick last started. A run with no closing line,
// from a release before the step, is told by its jobs' names as the Standing
// tells it. It never throws: each half GitHub refuses or fails is "unread".
// The named runs read (#898) asks the same of named workflow runs alone, and
// its fold puts the answer into a runs read kept; what a workflow run's jobs
// tell is one rule for both (inFlightOf).
import type { ReadClient, Repo } from "../github/client.ts";
import {
  type ActionsJob,
  isAgentJobNamed,
  isJobNamed,
  jobOf,
  jobsOfRun,
  jobsOfUnfinishedRunsAt,
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
  /** The Touch-up number (#750); absent or null unless a Touch-up. */
  readonly touchUp?: number | null;
  readonly model: string | null;
  readonly job: RunJob;
  /** When Actions created the run, ISO 8601. */
  readonly createdAt: string;
  /** When its agent job got a runner, ISO 8601; null until it has. */
  readonly startedAt: string | null;
  /** The agent job's page, where its live log is; the run's page until that job is listed. */
  readonly url: string;
}

/**
 * What `owner/product` reads in Actions at `now`, ISO 8601: its runs in
 * flight, and when its Tick last started; never throws. It asks a listing of
 * every workflow run created in the last 24 hours, a page for each hundred,
 * at an address that stays the same within the hour (#898); one listing of
 * each unfinished run's jobs; and one of the Tick's scheduled runs.
 */
export async function readRuns(client: Pick<ReadClient, "rest">, repo: string, now: string): Promise<RunsRead> {
  const target = repoOf(repo);
  const [runs, tick] = await Promise.all([readInFlight(client, target, Date.parse(now)), readTick(client, target)]);
  return { repo, readAt: now, runs, tick };
}

/** What a read of named workflow runs says: for each, the runs in flight it tells of. */
export interface NamedRunsRead {
  /** The repo read, `owner/name`. */
  readonly repo: string;
  /** When it was read, ISO 8601. */
  readonly readAt: string;
  /** Each run named, once, in the order first named. */
  readonly named: readonly NamedRun[];
}

/** One workflow run a named runs read was asked about. */
export interface NamedRun {
  /** The Actions run. */
  readonly run: number;
  /** The runs in flight it tells of, as the whole runs read gives them: none once it has ended, routed no agent run, or is older than that read's window; unread when GitHub refused or failed. */
  readonly inFlight: readonly RunInFlight[] | "unread";
}

/**
 * What `owner/product` reads in Actions at `now`, ISO 8601, of these workflow
 * runs alone (#898): for each, the runs in flight it tells of, by the rule
 * the whole runs read tells them by, so a run the whole read would give is
 * given the same. It asks two requests at most for each run, the run and its
 * jobs, the jobs only of one not completed and in the whole read's window,
 * side by side, and nothing else: no listing, and no Tick. It never throws:
 * a run GitHub refuses or fails is unread, and that run alone.
 */
export async function readNamedRuns(client: Pick<ReadClient, "rest">, repo: string, runs: readonly number[], now: string): Promise<NamedRunsRead> {
  const target = repoOf(repo);
  const at = Date.parse(now);
  const named = await Promise.all(
    [...new Set(runs)].map(async (run): Promise<NamedRun> => {
      try {
        return { run, inFlight: inFlightOf(await jobsOfRun(client, target, run, at)) };
      } catch {
        return { run, inFlight: "unread" };
      }
    }),
  );
  return { repo, readAt: now, named };
}

/**
 * A runs read kept, with a named runs read of the same repo folded in
 * (#898): each run the named read read has its entries replaced by the
 * answer's, so one that ended has none, and one never kept is added in its
 * place by run, as the whole read orders them. An unread run's entries, every
 * run's not named, the Tick and when the kept read was made are left as
 * kept. Runs kept unread stay unread, since a named read never says which
 * other runs are in flight. Pure; throws on a named read of another repo.
 */
export function foldNamedRuns(kept: RunsRead, named: NamedRunsRead): RunsRead {
  if (named.repo !== kept.repo) throw new Error(`A named runs read of ${named.repo} can't be folded into the runs read of ${kept.repo}.`);
  if (kept.runs === "unread") return kept;
  const read = named.named.flatMap(({ run, inFlight }) => (inFlight === "unread" ? [] : [{ run, inFlight }]));
  const answered = new Set(read.map(({ run }) => run));
  const runs = [...kept.runs.filter(({ run }) => !answered.has(run)), ...read.flatMap(({ inFlight }) => inFlight)].toSorted((a, b) => a.run - b.run);
  return { ...kept, runs };
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
    ...(run.touchUp == null ? {} : { touchUp: run.touchUp }),
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

async function readInFlight(client: Pick<ReadClient, "rest">, repo: Repo, now: number): Promise<readonly RunInFlight[] | "unread"> {
  let jobs: ActionsJob[];
  try {
    jobs = await jobsOfUnfinishedRunsAt(client, repo, now);
  } catch {
    return "unread";
  }
  const runs = new Map<number, ActionsJob[]>();
  for (const job of jobs) runs.set(job.run, [...(runs.get(job.run) ?? []), job]);
  return [...runs.keys()].sort((a, b) => a - b).flatMap((run) => inFlightOf(runs.get(run) ?? []));
}

/** The run in flight one workflow run's jobs say, if any: the one rule the whole runs read and the named one tell a run by. */
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
    ...(said.touchUp === undefined || said.touchUp === 0 ? {} : { touchUp: said.touchUp }),
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
