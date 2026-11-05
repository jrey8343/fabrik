// What the score-record job writes (#149): the judge run's transcript, its Run
// record (role `score`) and the score file, each create-only and retrying on
// conflict through the record writer (src/kit/recordWriter.ts), to the store,
// RUN_STORE. Like the push job, the job runs no agent and no Product code. The
// files themselves are built by src/kit/runRecord.ts and src/kit/scorer.ts.
// Also the push job's part, which runs the scoring plan on the run it just
// recorded, and writes a skip's score file itself.
import { type RecordWrite, type StoreApi, type StoreFile, type StoreWrite, storeCommitMessage, storeJson, writeStoreFiles } from "./recordWriter.ts";
import type { Rubric } from "./rubrics.ts";
import type { RunRecord, RunRecordFiles } from "./runRecord.ts";
import { RUN_STORE_REPO } from "./runStore.ts";
import { type ScoreFile, type ScoreFileWithPath, scoreFileFor, type ScoreSkip, scoringPlan } from "./scorer.ts";

/** A judge run's files, as the score-record job writes them. */
export interface ScoreRecordFiles {
  /** The judge run's Run record, and where it and its transcript go. */
  readonly judge: RunRecordFiles;
  /** The judge's gzipped transcript, or null if none survived its run. */
  readonly judgeTranscriptGzip: Uint8Array | null;
  /** The score file, and where it goes. */
  readonly score: ScoreFileWithPath;
}

/** What writing a judge run's files came to. */
export type ScoreRecordWrite =
  | { readonly kind: "public-store" }
  | {
      readonly kind: "written";
      /** The score file and the judge's record built for this run, whether or not the store already held them. */
      readonly score: ScoreFile;
      readonly judge: RunRecord;
      readonly written: readonly string[];
      readonly existing: readonly string[];
    };

/**
 * Writes the judge's transcript, then its Run record, then the score file that
 * links to it, each only if the store doesn't hold it yet: a re-run of scoring
 * under the same rubrics leaves every file it finds as it was.
 */
export async function writeScoreRecord(
  store: StoreApi,
  files: ScoreRecordFiles,
  wait: (ms: number) => Promise<void>,
): Promise<ScoreRecordWrite> {
  const { judge, judgeTranscriptGzip, score } = files;
  const toWrite: StoreFile[] = [];
  if (judge.transcriptPath !== null && judgeTranscriptGzip !== null) toWrite.push({ path: judge.transcriptPath, content: judgeTranscriptGzip });
  toWrite.push({ path: judge.recordPath, content: storeJson(judge.record) }, { path: score.path, content: storeJson(score.file) });
  const write = await writeStoreFiles(store, toWrite, storeCommitMessage(judge.record), wait);
  return write.kind === "public-store" ? write : { ...write, score: score.file, judge: judge.record };
}

/** How the score-record job ended: a write, no judge run to record, or no token for the store. */
export type ScoreRecordOutcome = ScoreRecordWrite | { readonly kind: "no-judge" } | { readonly kind: "no-store-token" };

/** The score-record job's one step-summary line: what it scored, or why it didn't. */
export function scoreRecordSummary(outcome: ScoreRecordOutcome): string {
  switch (outcome.kind) {
    case "no-judge":
      return "Nothing scored: the judge job didn't run.";
    case "no-store-token":
      return `No score written: the Fabrik App couldn't get a token for ${RUN_STORE_REPO}.`;
    case "public-store":
      return `No score written: ${RUN_STORE_REPO} isn't private, and scores never go to a store others can read. Make it private.`;
    case "written":
      return [scoredLine(outcome.score, outcome.judge), ...writesOf(outcome)].join(" ");
  }
}

/** What a write to the store wrote, and what it found already there and left as it was. */
function writesOf(write: { readonly written: readonly string[]; readonly existing: readonly string[] }): string[] {
  return [
    ...(write.written.length === 0 ? [] : [`Written to ${RUN_STORE_REPO}: ${write.written.join(", ")}.`]),
    ...(write.existing.length === 0 ? [] : [`Already there, left as it was: ${write.existing.join(", ")}.`]),
  ];
}

/** What the score file says: each rubric's score, or why the run has none. `judge` is null for a skip decided before any judge ran. */
function scoredLine(score: ScoreFile, judge: RunRecord | null): string {
  const run = `run ${score.runId}-${score.runAttempt} on #${score.issue}`;
  if (score.skip !== null) return `Not scored: ${whyNot(score.skip, judge)}, so ${run} gets a ${score.skip.reason} score file.`;
  const entries = (score.entries ?? []).map(
    (entry) => `${entry.scorer}@${entry.version} ${entry.score.toFixed(2)}, ${entry.pass ? "passed" : "failed"} (${entry.label})`,
  );
  return `Scored ${run}${score.digestTrimmed === true ? " from a trimmed transcript" : ""}: ${entries.join("; ")}.`;
}

function whyNot(skip: ScoreSkip, judge: RunRecord | null): string {
  switch (skip.reason) {
    case "judge-failed": {
      const failure = judge?.infrastructureFailure ?? null;
      return failure === null ? "the judge failed" : `the judge failed (${failure})`;
    }
    case "judge-output-invalid":
      return "the judge's output wasn't valid";
    case "weekly-limit":
      return "the Subscription was near its weekly limit";
    case "no-transcript":
      return "no transcript of the run survived";
    case "infrastructure-failure":
      return "the run ended in an Infrastructure failure";
  }
}

/**
 * What the push job's scoring of the run it just recorded came to: nothing
 * (`none`), the skip score file it wrote itself (`skip`), or a score asked of
 * the judge job, which gets the scored record's store path (`score`).
 */
export type RecordedRunScoring =
  | { readonly kind: "none" }
  | { readonly kind: "skip"; readonly score: ScoreFile; readonly write: StoreWrite }
  | { readonly kind: "score"; readonly record: string };

/**
 * The push job's part in scoring (#149): the scoring plan on the run whose
 * Run record it just wrote, or found already in the store. A skip's score file
 * it writes itself, create-only, with the store token it already holds; a
 * score it leaves to the judge job.
 */
export async function scoreRecordedRun(
  store: StoreApi,
  recorded: { readonly files: RunRecordFiles | null; readonly write: RecordWrite },
  rubrics: readonly Rubric[],
  scoredAt: string,
  wait: (ms: number) => Promise<void>,
): Promise<RecordedRunScoring> {
  // Without its record in a private store, a run has nothing for a score file to point at.
  if (recorded.files === null || recorded.write.kind !== "written") return { kind: "none" };
  const { record, recordPath } = recorded.files;
  const plan = scoringPlan(record);
  switch (plan.kind) {
    case "not-sampled":
      return { kind: "none" };
    case "score":
      return { kind: "score", record: recordPath };
    case "skip": {
      const score = scoreFileFor({ scored: record, scoredPath: recordPath, rubrics, scoredAt, outcome: plan });
      const write = await writeStoreFiles(store, [{ path: score.path, content: storeJson(score.file) }], storeCommitMessage(record), wait);
      return { kind: "skip", score: score.file, write };
    }
  }
}

/**
 * The push job's step-summary line on scoring the run it recorded, or null
 * for a run scoring passes by, so a run that isn't sampled adds nothing.
 */
export function recordedRunScoringSummary(scoring: RecordedRunScoring): string | null {
  switch (scoring.kind) {
    case "none":
      return null;
    case "score":
      return `Picked for scoring: the judge job scores ${scoring.record}.`;
    case "skip":
      if (scoring.write.kind === "public-store") return scoreRecordSummary(scoring.write);
      return [scoredLine(scoring.score, null), ...writesOf(scoring.write)].join(" ");
  }
}
