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
import { GitHubError, whyUnread } from "../github/client.ts";

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

/** A GitHub Actions job, as `GET …/actions/jobs/{job}` gives it, cut to what an excerpt reads. */
export interface ActionsJob {
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

/** What an excerpt reads from GitHub, each read on whichever token its job holds. A read GitHub refuses throws. */
export interface FailureReader {
  job(jobId: number): Promise<ActionsJob>;
  /** One step's log, as plain text. */
  stepLog(jobId: number, step: number): Promise<string>;
  annotations(checkRunId: number): Promise<readonly CheckAnnotation[]>;
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

/**
 * A red check's Failure excerpt, as data. A GitHub Actions check's holds each
 * failed step, none when no step failed, and its error annotations; one that
 * couldn't be read holds only why. Each keeps the check's link.
 */
export type FailureExcerpt =
  | {
      readonly kind: "actions";
      readonly check: string;
      readonly link: string;
      readonly steps: readonly FailedStep[];
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

/**
 * Reads a red check's Failure excerpt from GitHub. For a GitHub Actions check:
 * the job's steps, each whose conclusion is failure with its own log alone,
 * cleaned and cut to its last 150 lines, and the check run's error
 * annotations. A failure that can't be read gives only why, never throwing:
 * a missing excerpt is never the error of the job that tried.
 */
export async function readFailureExcerpt(check: RedCheck, github: FailureReader): Promise<FailureExcerpt> {
  const unread = (why: string): FailureExcerpt => ({ kind: "unread", check: check.name, link: check.link, why });
  const jobId = Number(ACTIONS_JOB.exec(check.link)?.[1] ?? Number.NaN);
  if (!Number.isSafeInteger(jobId)) return unread("it isn't a GitHub Actions check, so the Kit reads no log for it");
  let job: ActionsJob;
  try {
    job = await github.job(jobId);
  } catch (error) {
    return unread(gone(error) ? "GitHub holds no such job any more, as when it is past the repo's retention period" : refusal(error));
  }
  if (job.status !== "completed") return unread("the job hadn't finished when the Kit read it");
  const steps: FailedStep[] = [];
  for (const step of (job.steps ?? []).filter(({ conclusion }) => conclusion === "failure")) {
    steps.push(await failedStep(github, jobId, step));
  }
  // The job's id is its check run's, as observed (#710); its check_run_url says so where GitHub gives one.
  const checkRunId = Number(CHECK_RUN.exec(job.check_run_url ?? "")?.[1] ?? jobId);
  let annotations: ExcerptAnnotation[] = [];
  let annotationsUnread: string | null = null;
  try {
    annotations = (await github.annotations(checkRunId))
      .filter(({ annotation_level }) => annotation_level === "failure")
      .map(({ path, start_line, message }) => ({ path, line: start_line, message }));
  } catch (error) {
    annotationsUnread = refusal(error);
  }
  if ((job.steps ?? []).length === 0 && annotations.length === 0 && annotationsUnread === null) {
    return unread("the job never started, so it left no log and no annotation");
  }
  return {
    kind: "actions",
    check: check.name,
    link: check.link,
    steps,
    annotations,
    ...(annotationsUnread === null ? {} : { annotationsUnread }),
  };
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
