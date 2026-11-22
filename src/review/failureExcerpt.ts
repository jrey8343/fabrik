// The Failure excerpt (GLOSSARY.md, #774): why a red Required check failed,
// read from what GitHub holds, so whoever fixes it sees why without opening
// GitHub. Two entry points: readFailureExcerpt reads one red check's excerpt
// as data, through a FailureReader a job builds on a token it already holds;
// renderFailureExcerpts renders a set of them under the cap. No I/O of its own.
//
// What real runs showed (#710's open points, tried on 2026-11-18):
// - A step's log reads as soon as that step has finished, while its job and
//   its workflow run are still going; a step still running, or not yet
//   started, answers 404, and so does the whole job's log until the job ends.
// - A first attempt's job stays readable by its id after the Kit re-runs its
//   workflow run's failed jobs: the job, its steps, each step's log and its
//   annotations, under the same id.
// - A job GitHub never gave a runner (no runner name, no steps) leaves no log
//   and no annotation at all. No job whose runner was killed mid-step turned
//   up in 370 failed jobs read across the Kit's and two Product repos; its
//   step's log, if GitHub holds none, reads as a step that left none.
// - A check run's error annotation has the level `failure`, not `error`.
import { allPages, GitHubError, type ReadClient, whyUnread } from "../github/client.ts";
import { withoutMentions } from "../loop/mentions.ts";

/** A check's name as Markdown code: a backtick in it can't end the span. */
export function checkCode(name: string): string {
  return `\`${name.replace(/`/g, "'")}\``;
}

/** A red check on a commit: its name, the link GitHub gives it, and the commit it failed on. */
export interface RedCheck {
  readonly name: string;
  /** For a GitHub Actions check, its job: …/actions/runs/<run>/job/<job>. */
  readonly link: string;
  readonly sha: string;
}

/** A step of a job, as `GET …/actions/jobs/{job}` gives it. */
export interface ActionsJobStep {
  readonly name: string;
  readonly number: number;
  readonly conclusion: string | null;
}

/** A GitHub Actions job, as `GET …/actions/jobs/{job}` gives it, and as a workflow run attempt's jobs list it, cut to what an excerpt reads. */
export interface ActionsJob {
  readonly id?: number;
  readonly name?: string;
  /** The job's page: …/actions/runs/<run>/job/<job>, the link a red check of it has. */
  readonly html_url?: string | null;
  /** The job's workflow run, and which attempt of it the job belongs to: a re-run's jobs are a new attempt's. */
  readonly run_id?: number;
  readonly run_attempt?: number;
  readonly status: string;
  readonly conclusion: string | null;
  /** The job's check run; its id is the job's, as observed (#710), and this is how to cross. */
  readonly check_run_url?: string;
  readonly steps?: readonly ActionsJobStep[];
}

/** A check run's annotation, as `GET …/check-runs/{id}/annotations` gives it. An error's level is `failure`. */
export interface CheckAnnotation {
  readonly path: string;
  readonly start_line: number | null;
  readonly annotation_level: string;
  readonly message: string;
}

/** A check run on a commit, as `GET …/commits/{ref}/check-runs` gives it, cut to what an outside check's excerpt reads. */
export interface CheckRun {
  readonly id: number;
  readonly name: string;
  /** The app that made it: `github-actions` for a GitHub Actions job. */
  readonly app?: { readonly slug?: string } | null;
  /** The integrator's page with the full details, which the Kit can't read. */
  readonly details_url?: string | null;
  readonly html_url?: string | null;
  readonly output?: { readonly title?: string | null; readonly summary?: string | null } | null;
}

/** A commit status, as `GET …/commits/{ref}/status` lists it: the latest for each context. */
export interface CommitStatus {
  readonly context: string;
  readonly state: string;
  readonly description: string | null;
  /** The service's page with the full build output, which the Kit can't read. */
  readonly target_url: string | null;
}

/**
 * What an excerpt reads from GitHub, each read on whichever token its job
 * holds. A read GitHub refuses throws.
 */
export interface FailureReader {
  job(jobId: number): Promise<ActionsJob>;
  /** One step's log, as plain text. */
  stepLog(jobId: number, step: number): Promise<string>;
  /** Every job of one attempt of a workflow run, each with its steps. */
  runJobs(runId: number, attempt: number): Promise<readonly ActionsJob[]>;
  annotations(checkRunId: number): Promise<readonly CheckAnnotation[]>;
  /** One check run, by its id: an outside check's red run, whose link is its page on GitHub. */
  checkRun(checkRunId: number): Promise<CheckRun>;
  /** The latest check runs named `name` on the commit `sha`. */
  checkRuns(sha: string, name: string): Promise<readonly CheckRun[]>;
  /**
   * The latest commit status of each context on the commit `sha`; null when
   * the reader's token holds no Commit statuses: read, as the Fabrik App's
   * doesn't, so a commit status can't be read and its excerpt says so.
   */
  readonly statuses: ((sha: string) => Promise<readonly CommitStatus[]>) | null;
}

/** A client that reads a log's plain text, as the GitHub class does, beside its REST calls. */
export interface LogClient extends Pick<ReadClient, "rest"> {
  logText(path: string): Promise<string>;
}

/**
 * The FailureReader on a job's own GitHub clients for `repo` (`owner/name`),
 * each named for the permission it needs: the job, its logs and its workflow
 * run attempt's jobs (#890) on `actions` (Actions: read); the annotations,
 * the other failed jobs' among them, and an outside check's check runs on
 * `checks` (Checks: read); an outside check's commit statuses on `statuses`
 * (Commit statuses: read, #777), or null where the job holds no token with
 * it. The Review's waits hand in their workflow token for all three; the Tick
 * and the Monitor hand in the Fabrik App's for `checks`, and null for
 * `statuses`, as the App holds no Commit statuses: read.
 */
export function failureReaderOf(
  repo: string,
  clients: { readonly actions: LogClient; readonly checks: Pick<ReadClient, "rest">; readonly statuses: Pick<ReadClient, "rest"> | null },
): FailureReader {
  const { actions, checks, statuses } = clients;
  return {
    job: async (jobId) => (await actions.rest("GET", `/repos/${repo}/actions/jobs/${jobId}`)) as ActionsJob,
    stepLog: (jobId, step) => actions.logText(`/repos/${repo}/actions/jobs/${jobId}/steps/${step}/logs`),
    runJobs: (runId, attempt) =>
      allPages<ActionsJob>(actions, `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs`, (page) => (page as { jobs: ActionsJob[] }).jobs),
    annotations: (checkRunId) => allPages<CheckAnnotation>(checks, `/repos/${repo}/check-runs/${checkRunId}/annotations`),
    checkRun: async (checkRunId) => (await checks.rest("GET", `/repos/${repo}/check-runs/${checkRunId}`)) as CheckRun,
    checkRuns: (sha, name) =>
      allPages<CheckRun>(checks, `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest`, (page) => (page as { check_runs: CheckRun[] }).check_runs),
    statuses:
      statuses === null
        ? null
        : (sha) => allPages<CommitStatus>(statuses, `/repos/${repo}/commits/${sha}/status`, (page) => (page as { statuses: CommitStatus[] }).statuses),
  };
}

/**
 * A failed step: its name, the last lines of its log, cleaned, and how many
 * lines before them aren't kept; or, when its log couldn't be read, no lines
 * and why.
 */
export interface FailedStep {
  readonly name: string;
  readonly lines: readonly string[];
  readonly earlier: number;
  readonly why?: string;
}

/** An error annotation: its file, line and message. */
export interface ExcerptAnnotation {
  readonly path: string;
  readonly line: number | null;
  readonly message: string;
}

/** What a failed job left: each failed step, none when no step failed, and its error annotations. */
export interface JobFailure {
  readonly steps: readonly FailedStep[];
  readonly annotations: readonly ExcerptAnnotation[];
  /** Why the annotations couldn't be read, when they couldn't. */
  readonly annotationsUnread?: string;
}

/** Another job of a red check's workflow run attempt that failed (#890): its name, its link and what it left. */
export interface FailedJob extends JobFailure {
  readonly name: string;
  readonly link: string;
}

/**
 * A red check's Failure excerpt, as data. A GitHub Actions check's holds each
 * failed step, none when no step failed, its error annotations, and the other
 * failed jobs of its workflow run attempt (#890); one that couldn't be read
 * holds only why. Each keeps the check's link.
 */
export type FailureExcerpt =
  | ({
      readonly kind: "actions";
      readonly check: string;
      readonly link: string;
      /** The other jobs of the same workflow run attempt that failed, left out when there are none. */
      readonly otherJobs?: readonly FailedJob[];
      /** How many more failed that weren't read, past the first OTHER_JOBS. */
      readonly otherJobsLeftOut?: number;
      /** Why the run attempt's jobs couldn't be read, when they couldn't. */
      readonly otherJobsUnread?: string;
    } & JobFailure)
  /** A commit status from an outside service (#777): its description, empty when it wrote none, and its target link. */
  | { readonly kind: "commit-status"; readonly check: string; readonly link: string; readonly description: string }
  /** A check run from an outside service (#777): its output's title and summary, each empty when it wrote none, its error annotations, and its details link. */
  | {
      readonly kind: "outside-check-run";
      readonly check: string;
      readonly link: string;
      readonly title: string;
      readonly summary: string;
      readonly annotations: readonly ExcerptAnnotation[];
      /** Why the annotations couldn't be read, when they couldn't. */
      readonly annotationsUnread?: string;
    }
  | { readonly kind: "unread"; readonly check: string; readonly link: string; readonly why: string };

/** How many of a failed step's last lines an excerpt keeps: a test runner prints its failures and summary last. */
export const STEP_LINES = 150;

/** A GitHub Actions job's link: …/actions/runs/<run>/job/<job>. */
const ACTIONS_JOB = /\/actions\/runs\/\d+\/job\/(\d+)/;
/** A job's check run, from its `check_run_url`. */
const CHECK_RUN = /\/check-runs\/(\d+)$/;
/** A check run's page on GitHub, as its `html_url` gives it: …/<owner>/<repo>/runs/<id>, the link the Tick has of a red run. */
const CHECK_RUN_PAGE = /^https:\/\/[^/]+\/[^/]+\/[^/]+\/runs\/(\d+)$/;

/** Whether a red check's link is a GitHub Actions job's, whose log the Kit reads on Actions: read. */
export function isActionsJobLink(link: string): boolean {
  return ACTIONS_JOB.test(link);
}

/**
 * Reads a red check's Failure excerpt from GitHub. For a GitHub Actions check:
 * the job's steps, each whose conclusion is failure with its own log alone,
 * cleaned and cut to its last 150 lines, and the check run's error
 * annotations. A check whose link names no GitHub Actions job is an outside
 * service's: a check run, or else a commit status, of its name on the head,
 * read for what the service wrote to GitHub (#777). A failure that can't be
 * read gives only why, never throwing:
 * a missing excerpt is never the error of the job that tried.
 *
 * A GitHub Actions check's also carries the other jobs of its job's workflow
 * run attempt that failed or timed out (#890), since a job that only gathers
 * other jobs' results names nothing itself: up to OTHER_JOBS of them, each
 * with its name, link, failed steps and error annotations, and the end of its
 * failed steps' logs only when no annotation of its names a file.
 */
export async function readFailureExcerpt(check: RedCheck, github: FailureReader): Promise<FailureExcerpt> {
  const unread = (why: string): FailureExcerpt => ({ kind: "unread", check: check.name, link: check.link, why });
  const jobId = Number(ACTIONS_JOB.exec(check.link)?.[1] ?? Number.NaN);
  if (!Number.isSafeInteger(jobId)) return outsideExcerpt(check, github);
  let job: ActionsJob;
  try {
    job = await github.job(jobId);
  } catch (error) {
    return unread(gone(error) ? "GitHub holds no such job any more, as when it is past the repo's retention period" : refusal(error));
  }
  if (job.status !== "completed") return unread("the job hadn't finished when the Kit read it");
  const steps: FailedStep[] = [];
  for (const step of failedStepsOf(job)) {
    steps.push(await failedStep(github, jobId, step));
  }
  const annotations = await errorAnnotations(github, checkRunIdOf(job, jobId));
  if ((job.steps ?? []).length === 0 && annotations.annotations.length === 0 && annotations.annotationsUnread === undefined) {
    return unread("the job never started, so it left no log and no annotation");
  }
  return { kind: "actions", check: check.name, link: check.link, steps, ...annotations, ...(await otherFailedJobs(github, jobId, job)) };
}

/** The id of a job's check run: it is the job's own, as observed (#710), and its check_run_url says so where GitHub gives one. */
function checkRunIdOf(job: ActionsJob, jobId: number): number {
  return Number(CHECK_RUN.exec(job.check_run_url ?? "")?.[1] ?? jobId);
}

/** A check run's error annotations as file, line and message, or why they couldn't be read. */
async function errorAnnotations(github: FailureReader, checkRunId: number): Promise<Pick<JobFailure, "annotations" | "annotationsUnread">> {
  try {
    const annotations = (await github.annotations(checkRunId))
      .filter(({ annotation_level }) => annotation_level === "failure")
      .map(({ path, start_line, message }) => ({ path, line: start_line, message }));
    return { annotations };
  } catch (error) {
    return { annotations: [], annotationsUnread: refusal(error) };
  }
}

/**
 * The other failed jobs of a red job's workflow run attempt (#890): a job
 * that only gathers other jobs' results says nothing of what failed, and the
 * job that failed does. Every one that failed or timed out is taken, not
 * only those the red job `needs`, which only the workflow file says. Each is
 * read for its failed steps' names and its error annotations, and for the
 * end of each failed step's log only when no annotation names a file: a test
 * runner that writes annotations has named the test, and one that writes
 * none leaves only the log to say it. A list that can't be read gives why.
 */
async function otherFailedJobs(
  github: FailureReader,
  jobId: number,
  job: ActionsJob,
): Promise<Pick<Extract<FailureExcerpt, { kind: "actions" }>, "otherJobs" | "otherJobsLeftOut" | "otherJobsUnread">> {
  if (job.run_id === undefined || job.run_attempt === undefined) return {};
  let jobs: readonly ActionsJob[];
  try {
    jobs = await github.runJobs(job.run_id, job.run_attempt);
  } catch (error) {
    return { otherJobsUnread: refusal(error) };
  }
  // A cancelled job is left out: most often another job stopped it, as a matrix's fail-fast does, and it says nothing of what failed.
  const failed = jobs.filter(
    (other): other is ActionsJob & { readonly id: number } =>
      other.id !== undefined && other.id !== jobId && other.status === "completed" && (other.conclusion === "failure" || other.conclusion === "timed_out"),
  );
  const otherJobs: FailedJob[] = [];
  for (const other of failed.slice(0, OTHER_JOBS)) {
    const annotations = await errorAnnotations(github, checkRunIdOf(other, other.id));
    const namesAFile = annotations.annotations.some(({ path }) => path !== NO_FILE);
    const steps: FailedStep[] = [];
    for (const step of failedStepsOf(other)) {
      steps.push(namesAFile ? { name: step.name, lines: [], earlier: 0 } : await failedStep(github, other.id, step));
    }
    otherJobs.push({ name: other.name ?? "", link: other.html_url ?? "", steps, ...annotations });
  }
  if (otherJobs.length === 0) return {};
  return { otherJobs, ...(failed.length > OTHER_JOBS ? { otherJobsLeftOut: failed.length - OTHER_JOBS } : {}) };
}

/** A job's steps whose conclusion is failure. */
function failedStepsOf(job: ActionsJob): ActionsJobStep[] {
  return (job.steps ?? []).filter(({ conclusion }) => conclusion === "failure");
}

/** How many other failed jobs of a run attempt an excerpt reads: a wide matrix can fail in every job, each a read or two of its own. */
export const OTHER_JOBS = 10;

/**
 * The path GitHub gives an annotation that names no file, as the runner's own
 * of a step's exit code: such an annotation says a step failed, never where.
 */
const NO_FILE = ".github";

/**
 * A red check from an outside service's excerpt (#777): whatever the service
 * wrote to GitHub, as no log of its own can be read there. The red run itself
 * when the check's link is its check run's page on GitHub, by the id there,
 * as the Tick has it of a run that has since turned green (#778); else its
 * check run on the head by the check's name, when it reported as one, else
 * its commit status by context. Each keeps the service's own link, else the
 * check's.
 */
async function outsideExcerpt(check: RedCheck, github: FailureReader): Promise<FailureExcerpt> {
  const unread = (why: string): FailureExcerpt => ({ kind: "unread", check: check.name, link: check.link, why });
  const byId = Number(CHECK_RUN_PAGE.exec(check.link)?.[1] ?? Number.NaN);
  let run: CheckRun | undefined;
  let status: CommitStatus | undefined;
  try {
    if (Number.isSafeInteger(byId)) run = await github.checkRun(byId);
    else {
      run = (await github.checkRuns(check.sha, check.name)).find(({ name, app }) => name === check.name && app?.slug !== "github-actions");
      if (run === undefined) {
        const { statuses } = github;
        if (statuses === null) {
          return unread(
            "GitHub holds no check run by that name on the head, and the Kit can't read a commit status here: its token holds no Commit statuses: read, as the Fabrik App's doesn't",
          );
        }
        status = (await statuses(check.sha)).find(({ context }) => context === check.name);
      }
    }
  } catch (error) {
    return unread(gone(error) && Number.isSafeInteger(byId) ? "GitHub holds no such check run any more" : refusal(error));
  }
  if (run !== undefined) {
    return {
      kind: "outside-check-run",
      check: check.name,
      link: run.details_url || run.html_url || check.link,
      title: (run.output?.title ?? "").trim(),
      summary: (run.output?.summary ?? "").trim(),
      ...(await errorAnnotations(github, run.id)),
    };
  }
  if (status === undefined) return unread("GitHub holds no check run or commit status by that name on the head");
  return { kind: "commit-status", check: check.name, link: status.target_url || check.link, description: (status.description ?? "").trim() };
}

/** A failed step, with the last lines of its log, or why there are none. */
async function failedStep(github: FailureReader, jobId: number, step: ActionsJobStep): Promise<FailedStep> {
  let log: string;
  try {
    log = await github.stepLog(jobId, step.number);
  } catch (error) {
    const why = gone(error) ? "GitHub holds no log for this step: the runner left none, or it is past the repo's retention period" : refusal(error);
    return { name: step.name, lines: [], earlier: 0, why };
  }
  const lines = cleanLog(log);
  if (lines.length === 0) return { name: step.name, lines: [], earlier: 0, why: "the runner left no log lines for this step" };
  const earlier = Math.max(lines.length - STEP_LINES, 0);
  return { name: step.name, lines: lines.slice(earlier), earlier };
}

/** Whether GitHub answered that what was read isn't there: a 404, or a 410 for what it has deleted. */
function gone(error: unknown): boolean {
  return error instanceof GitHubError && (error.status === 404 || error.status === 410);
}

/** Why a read failed, in GitHub's own words where it gave some. */
function refusal(error: unknown): string {
  return `GitHub refused the read: ${whyUnread(error, "the read")}`;
}

/** The file the Review checks job's first wait passes its excerpts out in, as a JSON list, in its artifact. */
export const FAILURE_EXCERPTS_FILE = "failure-excerpts.json";
/** The file the wait after the Kit's re-run passes its excerpts out in: those of the checks that failed again. */
export const RERUN_FAILURE_EXCERPTS_FILE = "failure-excerpts-rerun.json";

/**
 * A red check's latest Failure excerpt and, for a check the Kit re-ran that
 * failed again, its first attempt's, read before the re-run (#776). Rendered,
 * the first attempt shows its failed steps' names and its annotations, with
 * no log lines, and a line says whether the same step failed both times.
 */
export type CheckExcerpt = FailureExcerpt & { readonly firstAttempt?: FailureExcerpt };

/**
 * Each red check's latest excerpt, from the files the Review's waits passed
 * out (null for one that's missing), each file one attempt: the re-run
 * wait's for a check that failed again, with the first wait's beside it as
 * its first attempt, else the first wait's alone. Read leniently: a file
 * that doesn't read, or an excerpt in it that doesn't, is none, and its
 * check says its failure couldn't be read.
 */
export function excerptsPassedOut(first: string | null, rerun: string | null): CheckExcerpt[] {
  const latest = new Map<string, CheckExcerpt>();
  for (const excerpt of excerptsIn(first)) latest.set(excerpt.check, excerpt);
  for (const excerpt of excerptsIn(rerun)) {
    const firstAttempt = latest.get(excerpt.check);
    latest.set(excerpt.check, firstAttempt === undefined ? excerpt : { ...excerpt, firstAttempt });
  }
  return [...latest.values()];
}

function excerptsIn(text: string | null): FailureExcerpt[] {
  if (text === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  return Array.isArray(value) ? value.filter(isExcerpt) : [];
}

const isString = (value: unknown): value is string => typeof value === "string";

function isExcerpt(value: unknown): value is FailureExcerpt {
  if (typeof value !== "object" || value === null) return false;
  const excerpt = value as Record<string, unknown>;
  if (!isString(excerpt["check"]) || !isString(excerpt["link"])) return false;
  if (excerpt["kind"] === "unread") return isString(excerpt["why"]);
  if (excerpt["kind"] === "commit-status") return isString(excerpt["description"]);
  const { annotations, annotationsUnread } = excerpt;
  const isStep = (step: unknown) => {
    const { name, lines, earlier, why } = (step ?? {}) as Record<string, unknown>;
    return isString(name) && Array.isArray(lines) && lines.every(isString) && typeof earlier === "number" && (why === undefined || isString(why));
  };
  const isAnnotation = (annotation: unknown) => {
    const { path, line, message } = (annotation ?? {}) as Record<string, unknown>;
    return isString(path) && (line === null || typeof line === "number") && isString(message);
  };
  if (excerpt["kind"] === "outside-check-run") {
    return (
      isString(excerpt["title"]) &&
      isString(excerpt["summary"]) &&
      Array.isArray(annotations) &&
      annotations.every(isAnnotation) &&
      (annotationsUnread === undefined || isString(annotationsUnread))
    );
  }
  if (excerpt["kind"] !== "actions") return false;
  const isJob = ({ steps, annotations, annotationsUnread }: Record<string, unknown>) =>
    Array.isArray(steps) && steps.every(isStep) && Array.isArray(annotations) && annotations.every(isAnnotation) && (annotationsUnread === undefined || isString(annotationsUnread));
  const isOtherJob = (job: unknown) => {
    const other = (job ?? {}) as Record<string, unknown>;
    return isString(other["name"]) && isString(other["link"]) && isJob(other);
  };
  const { otherJobs, otherJobsLeftOut, otherJobsUnread } = excerpt;
  return (
    isJob(excerpt) &&
    (otherJobs === undefined || (Array.isArray(otherJobs) && otherJobs.every(isOtherJob))) &&
    (otherJobsLeftOut === undefined || typeof otherJobsLeftOut === "number") &&
    (otherJobsUnread === undefined || isString(otherJobsUnread))
  );
}

/** The characters the log lines of all the red checks rendered together share, each line counted with its newline. */
export const LOG_CAP = 40_000;

/** What a shortened annotation message ends with. */
const SHORTENED = "_Shortened to fit GitHub's size limit._";

/**
 * Each excerpt as a Markdown list item under its check's name, in the order
 * given: the job link, each failed step's kept log lines, and its error
 * annotations as file, line and message. The failure text sits in fenced
 * blocks, as data a mention or a heading in it can't escape. A check that
 * failed both times then shows its first attempt, with no log lines, and
 * whether the same step failed both times (#776).
 *
 * After a check's own excerpt come the other failed jobs of its workflow run
 * (#890), each a list item under its name with its job link; one that is
 * itself a red check among `given` shows once, under its own name.
 *
 * The log lines share LOG_CAP equally between the excerpts that have any,
 * and a share one doesn't fill goes to no other. A check's share goes
 * equally to its jobs that have log lines, its own and the other failed
 * ones. Each job's lines are cut from the top, and the cut says how many
 * lines were left out and links the job. Annotations are outside the cap.
 * `room` is what the blocks may take
 * together, joined by blank lines, as what's left of a comment or issue body around them:
 * past it, the log lines are cut further, then the annotation messages are
 * shortened, each saying so, and last each block is only its check's name
 * and job link. The text is posted as the runner masked it.
 */
export function renderFailureExcerpts(given: readonly CheckExcerpt[], { room = Number.POSITIVE_INFINITY }: { readonly room?: number } = {}): string[] {
  const excerpts = shownOnce(given);
  const withLines = excerpts.filter((excerpt) => jobsWithLines(excerpt) > 0).length;
  const share = withLines === 0 ? 0 : Math.floor(LOG_CAP / withLines);
  const render = (share: number, messageMax: number) => excerpts.map((excerpt) => withFirstAttempt(excerpt, rendered(excerpt, share, messageMax), messageMax));
  const fits = (blocks: readonly string[]) => blocks.join("\n\n").length <= room;
  const whole = render(share, Number.POSITIVE_INFINITY);
  if (fits(whole)) return whole;
  // The largest share, then the longest message, that fits; each grows the blocks as it grows.
  const most = (max: number, fitsAt: (n: number) => boolean): number | null => {
    if (!fitsAt(0)) return null;
    let [low, high] = [0, max];
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fitsAt(mid)) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const cutShare = most(share, (n) => fits(render(n, Number.POSITIVE_INFINITY)));
  if (cutShare !== null) return render(cutShare, Number.POSITIVE_INFINITY);
  const longest = Math.max(0, ...excerpts.flatMap(attempts).flatMap(shortenable).map(({ length }) => length));
  const messageMax = most(longest, (n) => fits(render(0, n)));
  if (messageMax !== null) return render(0, messageMax);
  return excerpts.map((excerpt) => `${headOf(excerpt)}\n\n  Its Failure excerpt didn't fit within GitHub's size limit.`);
}

/** A check's excerpt and, when it failed both times, its first attempt's. */
function attempts(excerpt: CheckExcerpt): FailureExcerpt[] {
  return excerpt.firstAttempt === undefined ? [excerpt] : [excerpt, excerpt.firstAttempt];
}

/**
 * The excerpts, each without any other failed job that is itself a red check
 * among them (#890): rendered together, such a job shows once, under its own
 * name, and its log lines take their share of the cap once.
 */
function shownOnce(excerpts: readonly CheckExcerpt[]): CheckExcerpt[] {
  const redCheckJobs = new Set(
    excerpts
      .flatMap(attempts)
      .filter(({ kind }) => kind === "actions")
      .map(({ link }) => link),
  );
  const without = (excerpt: FailureExcerpt): FailureExcerpt => {
    if (excerpt.kind !== "actions" || excerpt.otherJobs === undefined) return excerpt;
    return { ...excerpt, otherJobs: excerpt.otherJobs.filter(({ link }) => link === "" || !redCheckJobs.has(link)) };
  };
  return excerpts.map((excerpt) => (excerpt.firstAttempt === undefined ? without(excerpt) : { ...without(excerpt), firstAttempt: without(excerpt.firstAttempt) }));
}

/** How many of a check's jobs kept log lines: its own and each other failed job of its workflow run (#890). */
function jobsWithLines(excerpt: FailureExcerpt): number {
  if (excerpt.kind !== "actions") return 0;
  return [excerpt, ...(excerpt.otherJobs ?? [])].filter(({ steps }) => steps.some((step) => step.lines.length > 0)).length;
}

/** The text of an excerpt a comment or issue body too long shortens: its annotation messages, and an outside check's description or title and summary (#777). */
function shortenable(excerpt: FailureExcerpt): string[] {
  const annotated: readonly Pick<JobFailure, "annotations">[] =
    excerpt.kind === "actions" ? [excerpt, ...(excerpt.otherJobs ?? [])] : excerpt.kind === "outside-check-run" ? [excerpt] : [];
  const messages = annotated.flatMap(({ annotations }) => annotations.map(({ message }) => message));
  if (excerpt.kind === "commit-status") return [excerpt.description];
  if (excerpt.kind === "outside-check-run") return [[excerpt.title, excerpt.summary].filter((part) => part !== "").join("\n\n"), ...messages];
  return messages;
}

/**
 * A check's block with, when it failed both times, its first attempt after
 * the re-run's excerpt (#776): the first attempt's failed steps by name and
 * its annotations, none of its log lines, so it takes none of the cap; then
 * one line on whether the same step failed both times.
 */
function withFirstAttempt(excerpt: CheckExcerpt, block: string, messageMax: number): string {
  const first = excerpt.firstAttempt;
  if (first === undefined) return block;
  const job = first.link === "" ? "" : ` ([the job](${first.link}))`;
  const parts: string[] = [];
  if (first.kind === "unread") parts.push(`Its first attempt, before the Kit re-ran it${job}, couldn't be read: ${prose(first.why)}.`);
  if (first.kind === "actions") {
    parts.push(...withoutLogLines(`Its first attempt, before the Kit re-ran it${job}`, first, messageMax));
    const names = (steps: readonly FailedStep[]) => steps.map(({ name }) => name);
    if (excerpt.kind === "actions") parts.push(sameStepLine(names(first.steps), names(excerpt.steps)));
    parts.push(...otherJobsParts(first, null, messageMax));
  }
  return [block, ...parts.map((part) => indent(part, 2))].join("\n\n");
}

/**
 * What a failed job left, said after `opening` with none of its log lines:
 * its failed steps by name, then its error annotations.
 */
function withoutLogLines(opening: string, job: JobFailure, messageMax: number): string[] {
  const steps = job.steps.map(({ name }) => name);
  const failed = steps.length === 0 ? "no step failed" : `the ${steps.length === 1 ? "step" : "steps"} ${listed(steps)} failed`;
  const start = `${opening}: ${failed}.`;
  if (job.annotationsUnread !== undefined) return [`${start} Its annotations couldn't be read: ${prose(job.annotationsUnread)}.`];
  if (job.annotations.length === 0) return [`${start} It has no error annotation.`];
  return [`${start} Its error annotations:`, job.annotations.map((annotation) => annotationItem(annotation, messageMax)).join("\n\n")];
}

/**
 * The other failed jobs of a red check's workflow run (#890), after the
 * check's own excerpt: each a list item under its name, with its job link.
 * One that kept the end of a step's log, or says why it has none, shows it
 * as the check's own job does, its lines held to `share` characters; any
 * other shows its failed steps by name and its annotations. A first
 * attempt's, whose `share` is null, show no log lines, as it shows none
 * itself (#776).
 */
function otherJobsParts(excerpt: Extract<FailureExcerpt, { kind: "actions" }>, share: number | null, messageMax: number): string[] {
  const jobs = excerpt.otherJobs ?? [];
  const firstAttempt = share === null;
  const parts: string[] = [];
  if (jobs.length > 0) {
    parts.push(firstAttempt ? "Other jobs failed on the first attempt too:" : "Other jobs of its workflow run failed too:");
    parts.push(jobs.map((job) => otherJobItem(job, share, messageMax)).join("\n\n"));
  }
  const leftOut = excerpt.otherJobsLeftOut ?? 0;
  if (leftOut > 0) {
    const run = WORKFLOW_RUN.exec(excerpt.link)?.[0];
    parts.push(`_${leftOut} more failed ${leftOut === 1 ? "job isn't" : "jobs aren't"} shown${run === undefined ? "" : `: [the workflow run](${run})`}._`);
  }
  if (excerpt.otherJobsUnread !== undefined) {
    parts.push(`The other jobs of ${firstAttempt ? "the first attempt" : "its workflow run"} couldn't be read: ${prose(excerpt.otherJobsUnread)}.`);
  }
  return parts;
}

/** A job's workflow run, at the start of the job's link. */
const WORKFLOW_RUN = /^.*\/actions\/runs\/\d+(?=\/job\/\d+)/;

/** One other failed job's list item: with the end of its log where it kept one and `share` isn't null, else its failed steps by name. */
function otherJobItem(job: FailedJob, share: number | null, messageMax: number): string {
  const head = `- ${checkCode(job.name)}${job.link === "" ? "" : ` ([the job](${job.link}))`}`;
  const withLog = share !== null && job.steps.some((step) => step.lines.length > 0 || step.why !== undefined);
  const [first, ...rest] = withLog ? [head, ...jobParts(job, job.link, share, messageMax)] : withoutLogLines(head, job, messageMax);
  return [first, ...rest.map((part) => indent(part, 2))].join("\n\n");
}

/** Whether the same step failed on the first attempt and on the re-run, naming both when they differ. */
function sameStepLine(first: readonly string[], rerun: readonly string[]): string {
  const same = first.length === rerun.length && first.every((name, i) => name === rerun[i]);
  if (same && first.length === 0) return "No step failed either time.";
  if (same) return `The same ${first.length === 1 ? "step" : "steps"}, ${listed(first)}, failed both times.`;
  const which = (names: readonly string[]) => (names.length === 0 ? "no step" : listed(names));
  return `Different steps failed: ${which(first)} the first time, and ${which(rerun)} on the re-run.`;
}

/** Names in backticks, as a list in prose. */
function listed(names: readonly string[]): string {
  const coded = names.map(checkCode);
  return coded.length <= 1 ? (coded[0] ?? "") : `${coded.slice(0, -1).join(", ")} and ${coded.at(-1)}`;
}

/** The check's name, and its job link, or an outside check's own link, when the excerpt has one. */
function headOf(excerpt: FailureExcerpt): string {
  const outside = excerpt.kind === "commit-status" || excerpt.kind === "outside-check-run";
  return `- ${checkCode(excerpt.check)}${excerpt.link === "" ? "" : ` ([${outside ? "the service's page" : "the job"}](${excerpt.link}))`}`;
}

/** One excerpt's block, its log lines held to `share` characters and each annotation message, or an outside check's text, to `messageMax`. */
function rendered(excerpt: FailureExcerpt, share: number, messageMax: number): string {
  const head = headOf(excerpt);
  const block = (parts: readonly string[]) => [head, "", ...parts.flatMap((part, i) => (i === 0 ? [indent(part, 2)] : ["", indent(part, 2)]))].join("\n");
  if (excerpt.kind === "unread") return [head, "", indent(`Its failure couldn't be read: ${prose(excerpt.why)}.`, 2)].join("\n");
  if (excerpt.kind === "commit-status" || excerpt.kind === "outside-check-run") return block(outsideParts(excerpt, messageMax));
  // A check's share goes equally to its jobs that have log lines (#890), and a part one doesn't fill goes to no other.
  const jobShare = Math.floor(share / Math.max(jobsWithLines(excerpt), 1));
  return block([...jobParts(excerpt, excerpt.link, jobShare, messageMax), ...otherJobsParts(excerpt, jobShare, messageMax)]);
}

/**
 * A failed job's paragraphs: each failed step with the last of its log lines,
 * held to `share` characters between them, then its error annotations.
 * `link` is the job's, for the whole log.
 */
function jobParts(job: JobFailure, link: string, share: number, messageMax: number): string[] {
  const kept = keptLines(job.steps, share);
  const parts: string[] = [];
  for (const [i, step] of job.steps.entries()) {
    if (step.why !== undefined) {
      parts.push(`The step ${checkCode(step.name)} failed, and its log couldn't be read: ${prose(step.why)}.`);
      continue;
    }
    const lines = kept[i]!;
    const leftOut = step.earlier + step.lines.length - lines.length;
    parts.push(`The step ${checkCode(step.name)} failed. The end of its log:`);
    if (leftOut > 0) parts.push(`_${leftOut} earlier lines left out: [the whole log](${link})._`);
    if (lines.length > 0) parts.push(fenced(lines));
  }
  const noStep = job.steps.length === 0 ? "No step failed. " : "";
  if (job.annotationsUnread !== undefined) parts.push(`${noStep}Its annotations couldn't be read: ${prose(job.annotationsUnread)}.`);
  else if (job.annotations.length === 0) parts.push(`${noStep}It has no error annotation.`);
  else {
    parts.push(`${noStep}Its error annotations:`);
    parts.push(job.annotations.map((annotation) => annotationItem(annotation, messageMax)).join("\n\n"));
  }
  return parts;
}

/**
 * An outside check's paragraphs (#777): that the service's own log can't be
 * reached, then what it wrote to GitHub, or that it wrote nothing. Its text
 * takes no share of the log lines' cap, and is shortened to `messageMax` as
 * an annotation message is.
 */
function outsideParts(excerpt: Extract<FailureExcerpt, { kind: "commit-status" | "outside-check-run" }>, messageMax: number): string[] {
  const unreachable = `A ${excerpt.kind === "commit-status" ? "commit status" : "check run"} from an outside service, whose own log can't be reached from GitHub.`;
  const text = (written: string) => [fenced(written.slice(0, messageMax).split(/\r?\n/)), ...(written.length > messageMax ? [SHORTENED] : [])];
  if (excerpt.kind === "commit-status") {
    if (excerpt.description === "") return [`${unreachable} It wrote nothing to GitHub but its result: no description.`];
    return [`${unreachable} Its description:`, ...text(excerpt.description)];
  }
  const { title, summary, annotations, annotationsUnread } = excerpt;
  if (title === "" && summary === "" && annotations.length === 0 && annotationsUnread === undefined) {
    return [`${unreachable} It wrote nothing to GitHub but its result: no title, summary or error annotation.`];
  }
  const written = [title, summary].filter((part) => part !== "");
  const what = title === "" ? (summary === "" ? null : "Its summary:") : summary === "" ? "Its title:" : "Its title and summary:";
  const parts = what === null ? [`${unreachable} It wrote no title or summary.`] : [`${unreachable} ${what}`, ...text(written.join("\n\n"))];
  if (annotationsUnread !== undefined) parts.push(`Its annotations couldn't be read: ${prose(annotationsUnread)}.`);
  else if (annotations.length === 0) parts.push("It has no error annotation.");
  else parts.push("Its error annotations:", annotations.map((annotation) => annotationItem(annotation, messageMax)).join("\n\n"));
  return parts;
}

function annotationItem({ path, line, message }: ExcerptAnnotation, messageMax: number): string {
  const short = message.length > messageMax;
  return [
    `- ${checkCode(path)}${line === null ? "" : `, line ${line}`}:`,
    "",
    indent(fenced(message.slice(0, messageMax).split(/\r?\n/)), 2),
    ...(short ? ["", indent(SHORTENED, 2)] : []),
  ].join("\n");
}

/**
 * The lines each step keeps under one check's share: the last lines of its
 * failed steps taken together, cut from the top, so a later step keeps its
 * lines before an earlier one does.
 */
function keptLines(steps: readonly FailedStep[], share: number): string[][] {
  let left = share;
  const kept: string[][] = steps.map(() => []);
  for (let s = steps.length - 1; s >= 0; s--) {
    const lines = steps[s]!.lines;
    let from = lines.length;
    while (from > 0 && lines[from - 1]!.length + 1 <= left) {
      from -= 1;
      left -= lines[from]!.length + 1;
    }
    kept[s] = lines.slice(from);
    if (from > 0) left = 0;
  }
  return kept;
}

/** Text from CI in a fenced block, its fence longer than any run of backticks in it. */
function fenced(lines: readonly string[]): string {
  const longest = Math.max(0, ...lines.map((line) => Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length))));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}text`, ...lines, fence].join("\n");
}

function indent(text: string, by: number): string {
  const pad = " ".repeat(by);
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `${pad}${line}`))
    .join("\n");
}

/** A reason in prose: no mention in it notifies anyone, and it doesn't end in a full stop of its own. */
function prose(text: string): string {
  return withoutMentions(text.trim().replace(/\.$/, ""));
}

/** A runner's timestamp at a line's start, as `2026-11-08T05:14:12.6748036Z `. */
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
/** An ANSI escape sequence. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** A step's log as its lines, without the byte-order mark, the timestamps, ANSI sequences or group lines. */
function cleanLog(log: string): string[] {
  const lines = log.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines
    .map((line) => line.replace(TIMESTAMP, "").replace(ANSI, ""))
    .filter((line) => !line.startsWith("##[group]") && !line.startsWith("##[endgroup]"));
}
