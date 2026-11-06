// The Scorers (#149): which finished runs are scored, and the score file a
// scored or skipped run gets, beside its Run record in the store, RUN_STORE
// (src/kit/runStore.ts). The judge prompt is src/kit/scorerPrompt.ts. Pure,
// no I/O.
import { createHash } from "node:crypto";
import { isObject } from "../agent/stream.ts";
import { type Rubric, rubricSet } from "./rubrics.ts";
import { isLive, type RateLimitReading, type ReplayRun, type RunRecord, type RunRecordRole, runStoreName } from "./runRecord.ts";

/**
 * The share of live first Implement runs scored: one in four. A run is in the
 * sample when the SHA-256 of its run id's decimal string falls in the lowest
 * quarter of the range, so every attempt of the run makes the same choice.
 */
export const SAMPLED_SHARE = 1 / 4;

/**
 * The weekly-limit utilization, from 0 to 1, at or above which a run isn't
 * scored, so scoring never pushes the factory into its Subscription's limit.
 */
export const SCORING_UTILIZATION_LIMIT = 0.75;

/**
 * The weekly-limit utilization, from 0 to 1, at or above which no replay
 * Ticket starts (#156), so a Replay stays in the lower half of the week's
 * budget (src/loop/replayGate.ts).
 */
export const REPLAY_UTILIZATION_LIMIT = 0.5;

/**
 * A skip the scoring plan decides from the run's record, before any judge
 * runs. A `weekly-limit` skip keeps the reading it was skipped for.
 */
export type PlanSkip =
  | { readonly reason: "weekly-limit"; readonly rateLimit: RateLimitReading }
  | { readonly reason: "no-transcript" | "infrastructure-failure" };

/** Why a judge that ran gave no scores: it failed, or its output wasn't valid. */
export type JudgeFailure = "judge-failed" | "judge-output-invalid";

/** Why a picked run has no scores: the scoring plan's reason, or the judge's. */
export type ScoreSkip = PlanSkip | { readonly reason: JudgeFailure };

/**
 * What scoring does with a finished run: leave it with no score file
 * (`not-sampled`), write a score file saying why it's skipped (`skip`), or
 * have the judge score it (`score`).
 */
export type ScoringPlan =
  | { readonly kind: "not-sampled" }
  | { readonly kind: "skip"; readonly skip: PlanSkip }
  | { readonly kind: "score" };

/** The scoring plan for the run whose Run record the push job just built. */
export function scoringPlan(record: RunRecord): ScoringPlan {
  if (!picked(record)) return { kind: "not-sampled" };
  if (record.transcript === null) return { kind: "skip", skip: { reason: "no-transcript" } };
  // A timeout is scored: a run that loops until it's stopped shows how it worked.
  const failure = record.infrastructureFailure;
  if (failure !== null && failure !== "timeout") return { kind: "skip", skip: { reason: "infrastructure-failure" } };
  const rateLimit = record.rateLimit;
  if (rateLimit !== null && atOrOver(rateLimit, SCORING_UTILIZATION_LIMIT)) return { kind: "skip", skip: { reason: "weekly-limit", rateLimit } };
  return { kind: "score" };
}

/**
 * Whether a weekly-limit reading says the Subscription is at or over `limit`,
 * a utilization from 0 to 1: any status but `allowed`, or a utilization at
 * `limit` or above. An `allowed` reading that gives no utilization is under it.
 */
export function atOrOver(reading: RateLimitReading, limit: number): boolean {
  return reading.status !== "allowed" || (reading.utilization !== null && reading.utilization >= limit);
}

/**
 * Whether scoring picks the run: only Implement runs, every Replay arm's,
 * Retry, Step-up and Request-changes run among them, and the sample of live
 * first runs. A Replay arm's run is never sampled, so every arm has a
 * process measure to compare (#156).
 */
function picked(record: RunRecord): boolean {
  if (record.role !== "implement") return false;
  return !isLive(record) || record.retry > 0 || record.stepUp || record.requestChanges || sampled(record.runId);
}

/** Whether a first Implement run is in the sample, by the SHA-256 of its run id's decimal string. */
function sampled(runId: number): boolean {
  return inSample(String(runId), SAMPLED_SHARE);
}

/**
 * Whether `key` is in a sample of `share` of all keys: whether its SHA-256
 * falls in the lowest `share` of the range. The same key always gets the same
 * answer, whatever other keys there are.
 */
export function inSample(key: string, share: number): boolean {
  const digest = createHash("sha256").update(key).digest();
  return digest.readUInt32BE(0) < share * 2 ** 32;
}

/** The Kit's rubrics as a scoring job read them from its Kit checkout, and the Kit commit it checked out. */
export interface KitRubrics {
  readonly sha: string;
  readonly rubrics: readonly Rubric[];
}

/**
 * The rubrics a run is scored, or skipped, under: always those of its pinned
 * release, the Kit commit that ran and recorded it (its record's `kitSha`).
 * A Replay's `kit` variant names a candidate Kit sha too, whose prompts and
 * Base skills its agents loaded, but never its rubrics, so both arms' scores
 * compare with each other and with live runs' (#156). Throws for rubrics read
 * at any other commit, so a score file is never built under them.
 */
export function scoringRubrics(scored: RunRecord, kit: KitRubrics): readonly Rubric[] {
  if (kit.sha === scored.kitSha) return kit.rubrics;
  const run = `Run ${scored.runId}-${scored.runAttempt} is scored under the rubrics of its pinned release ${scored.kitSha}`;
  if (kit.sha === scored.replay?.candidateSha) throw new Error(`${run}, never those of its candidate Kit sha ${kit.sha}`);
  throw new Error(`${run}, not those read at ${kit.sha}`);
}

/** One rubric's answer in the judge's structured output. */
export interface JudgeAnswer {
  /** The rubric's name, such as `efficiency`. */
  readonly scorer: string;
  /** How the run did on the rubric, from 0 to 1. */
  readonly score: number;
  /** One of the rubric's labels. */
  readonly label: string;
  /** One line on why. */
  readonly rationale: string;
}

/** The judge's structured output: one answer per rubric, in an object since a structured output's schema must be one. */
export interface JudgeOutput {
  readonly answers: readonly JudgeAnswer[];
}

/** The judge run that scored a run, as its score file names it. */
export interface JudgeRun {
  /** The Kit's judge model. */
  readonly model: string;
  /** The judge's Run record's store path, where what scoring cost lives. */
  readonly record: string;
  /** Whether the transcript's digest was trimmed to fit the judge's budget; null when the judge failed before it built its prompt. */
  readonly digestTrimmed: boolean | null;
}

/**
 * How scoring a picked run ended: skipped by the scoring plan before any
 * judge ran (the plan's own `skip`, as it gave it), judged, or failed by the
 * judge. The score-record job gives `judge-output-invalid` when the judge
 * left output it can't even parse.
 */
export type ScoringOutcome =
  | { readonly kind: "skip"; readonly skip: PlanSkip }
  | {
      readonly kind: "judged";
      readonly judge: JudgeRun;
      /** The judge's structured output, as parsed: checked here against JudgeOutput and the rubrics. */
      readonly output: unknown;
    }
  | { readonly kind: JudgeFailure; readonly judge: JudgeRun };

/** What the score file is made from. */
export interface ScoreFileInput {
  /** The scored run's Run record, and its store path. */
  readonly scored: RunRecord;
  readonly scoredPath: string;
  /** The rubrics the run was scored, or skipped, under. */
  readonly rubrics: readonly Rubric[];
  /** When scoring ended, as an ISO 8601 time. */
  readonly scoredAt: string;
  readonly outcome: ScoringOutcome;
}

/** One rubric's score in a score file. */
export interface ScoreEntry {
  readonly scorer: string;
  readonly version: number;
  readonly threshold: number;
  readonly score: number;
  /** Whether the score is at or above the rubric's threshold: the Kit's call, never the judge's. */
  readonly pass: boolean;
  readonly label: string;
  readonly rationale: string;
}

/** The schema a score file is written at: 2 added `replay`. */
export const SCORE_FILE_SCHEMA = 2;

/** The scores of one picked run under one rubric set, or why it has none; schema 2. */
export interface ScoreFile {
  readonly schema: typeof SCORE_FILE_SCHEMA;
  readonly kitSha: string;
  readonly repo: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly role: RunRecordRole;
  readonly issue: number;
  readonly pullRequest: number | null;
  /** The scored run's: null for a live run, else the Replay arm it was. */
  readonly replay: ReplayRun | null;
  /** The scored run's Run record's store path. */
  readonly record: string;
  readonly scoredAt: string;
  /** The rubric set the run was scored, or skipped, under: each rubric's `name@version`, in the rubrics' order. */
  readonly rubrics: readonly string[];
  /** The judge's model and Run record path, or null for a skip decided before any judge ran. */
  readonly judge: { readonly model: string; readonly record: string } | null;
  /** Whether the judge read a trimmed digest; null when no judge ran, or it failed before it built its prompt. */
  readonly digestTrimmed: boolean | null;
  readonly skip: ScoreSkip | null;
  /** One per rubric, in the rubrics' order. */
  readonly entries: readonly ScoreEntry[] | null;
}

/**
 * A score file as read back from the store, at the current schema: a schema 1
 * file, written before there were Replays, as no replay's. Null for anything
 * that isn't a score file of a schema the Kit knows.
 */
export function readScoreFile(stored: unknown): ScoreFile | null {
  if (!isObject(stored)) return null;
  if (stored["schema"] === SCORE_FILE_SCHEMA) return stored as unknown as ScoreFile;
  if (stored["schema"] === 1) return { ...(stored as unknown as Omit<ScoreFile, "schema" | "replay">), schema: SCORE_FILE_SCHEMA, replay: null };
  return null;
}

/** A score file and where it goes in the store. */
export interface ScoreFileWithPath {
  readonly file: ScoreFile;
  readonly path: string;
}

/** The score file of a picked run: its scores, or why it has none. */
export function scoreFileFor(input: ScoreFileInput): ScoreFileWithPath {
  const { scored, rubrics, outcome } = input;
  const set = rubricSet(rubrics);
  const file: ScoreFile = {
    schema: SCORE_FILE_SCHEMA,
    kitSha: scored.kitSha,
    repo: scored.repo,
    runId: scored.runId,
    runAttempt: scored.runAttempt,
    role: scored.role,
    issue: scored.issue,
    pullRequest: scored.pullRequest,
    replay: scored.replay,
    record: input.scoredPath,
    scoredAt: input.scoredAt,
    rubrics: set.pairs,
    ...judgeOf(outcome),
    ...resultOf(rubrics, outcome),
  };
  // Beside the scored run's record, and named by the rubric set, so re-scoring under new rubric versions writes a new file.
  return { file, path: `scores/${runStoreName(scored)}-${set.hash}.json` };
}

/** The judge a score file names, if one ran. */
function judgeOf(outcome: ScoringOutcome): Pick<ScoreFile, "judge" | "digestTrimmed"> {
  if (outcome.kind === "skip") return { judge: null, digestTrimmed: null };
  const { model, record, digestTrimmed } = outcome.judge;
  return { judge: { model, record }, digestTrimmed };
}

/** A score file's result: its entries, or why it has none. */
function resultOf(rubrics: readonly Rubric[], outcome: ScoringOutcome): Pick<ScoreFile, "skip" | "entries"> {
  switch (outcome.kind) {
    case "skip":
      return { skip: outcome.skip, entries: null };
    case "judged": {
      const entries = scoreEntries(rubrics, outcome.output);
      return entries === null ? { skip: { reason: "judge-output-invalid" }, entries: null } : { skip: null, entries };
    }
    default:
      return { skip: { reason: outcome.kind }, entries: null };
  }
}

/**
 * Each rubric's score from the judge's output, in the rubrics' order, with
 * its pass from the rubric's threshold. Null, so the output is invalid as a
 * whole, unless it's a JudgeOutput answering each rubric exactly once with a
 * score from 0 to 1 and one of that rubric's labels. The judge's run checks
 * its answer with this too (src/kit/judgeLaunch.ts), so an answer the score
 * file would refuse fails the judge, with the reasons in its failure report.
 */
export function scoreEntries(rubrics: readonly Rubric[], output: unknown): readonly ScoreEntry[] | null {
  const answers = answersOf(output);
  if (answers === null || answers.length !== rubrics.length) return null;
  const entries: ScoreEntry[] = [];
  for (const rubric of rubrics) {
    const [answer, ...others] = answers.filter((a) => a.scorer === rubric.name);
    if (answer === undefined || others.length > 0) return null;
    const { score, label, rationale } = answer;
    if (score < 0 || score > 1 || !rubric.labels.includes(label)) return null;
    const { name, version, threshold } = rubric;
    entries.push({ scorer: name, version, threshold, score, pass: score >= threshold, label, rationale });
  }
  return entries;
}

/** The output's answers, if it has the JudgeOutput shape, else null. */
function answersOf(output: unknown): readonly JudgeAnswer[] | null {
  if (!isObject(output) || !Array.isArray(output["answers"])) return null;
  const answers: unknown[] = output["answers"];
  return answers.every(isAnswer) ? answers : null;
}

function isAnswer(value: unknown): value is JudgeAnswer {
  return (
    isObject(value) &&
    typeof value["scorer"] === "string" &&
    typeof value["score"] === "number" &&
    Number.isFinite(value["score"]) &&
    typeof value["label"] === "string" &&
    typeof value["rationale"] === "string"
  );
}
