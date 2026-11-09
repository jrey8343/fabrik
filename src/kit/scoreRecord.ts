// What the score-record job writes (#149): the judge run's transcript, its Run
// record (role `score`) and the score file, each create-only and retrying on
// conflict through the record writer (src/kit/recordWriter.ts), to the store,
// RUN_STORE, save that a judge re-run's scores replace the skip score file a
// failed judge left (#451). Like the push job, the job runs no agent and no Product code. The
// files themselves are built by src/kit/runRecord.ts and src/kit/scorer.ts.
// Also the push job's part, which runs the scoring plan on the run it just
// recorded, and writes a skip's score file itself.
import {
  type RecordWrite,
  type StoreApi,
  type StoreFile,
  type StoreWrite,
  storeCommitMessage,
  storeJson,
  storeWriteSummary,
  writeStoreFileReplacing,
  writeStoreFiles,
} from "./recordWriter.ts";
import type { RunRecord, RunRecordFiles } from "./runRecord.ts";
import {
  type KitRubrics,
  readScoreFile,
  type ScoreFile,
  type ScoreFileWithPath,
  scoreFileFor,
  type ScoreSkip,
  scoringPlan,
  scoringRubrics,
} from "./scorer.ts";

/** A judge run's files, as the score-record job writes them. */
export interface ScoreRecordFiles {
  /** The judge run's Run record, and where it and its transcript go. */
  readonly judge: RunRecordFiles;
  /** The judge's gzipped transcript, or null if none survived its run. */
  readonly judgeTranscriptGzip: Uint8Array | null;
  /** The score file, and where it goes. */
  readonly score: ScoreFileWithPath;
}

/**
 * What came of the score file: written; written over the skip score file a
 * failed judge left, which it names; or kept, the store already holding one
 * it leaves as it was, which `held` gives, null when the Kit can't read it.
 */
export type ScoreFileWrite =
  | { readonly kind: "written" }
  | { readonly kind: "replaced"; readonly skip: ScoreSkip }
  | { readonly kind: "kept"; readonly held: ScoreFile | null };

/** What writing a judge run's files came to. */
export type ScoreRecordWrite =
  | { readonly kind: "public-store" }
  | {
      readonly kind: "written";
      /** The score file and the judge's record built for this run, whether or not the store already held them. */
      readonly score: ScoreFile;
      readonly judge: RunRecord;
      /** What came of the score file, which says what the store holds for the run. */
      readonly scoreFile: ScoreFileWrite;
      readonly written: readonly string[];
      readonly existing: readonly string[];
    };

/**
 * Writes the judge's transcript, then its Run record, then the score file that
 * links to it, each only if the store doesn't hold it yet: a re-run of scoring
 * under the same rubrics leaves every file it finds as it was. The one
 * exception is a skip score file, which a judge with scores replaces: so a
 * judge re-run after a failed one, in the workflow run's next attempt, stores
 * its scores beside its own record, and the failed judge's record stays (#451).
 */
export async function writeScoreRecord(
  store: StoreApi,
  files: ScoreRecordFiles,
  wait: (ms: number) => Promise<void>,
): Promise<ScoreRecordWrite> {
  const { judge, judgeTranscriptGzip, score } = files;
  const message = storeCommitMessage(judge.record);
  const judgeFiles: StoreFile[] = [];
  if (judge.transcriptPath !== null && judgeTranscriptGzip !== null) judgeFiles.push({ path: judge.transcriptPath, content: judgeTranscriptGzip });
  judgeFiles.push({ path: judge.recordPath, content: storeJson(judge.record) });
  const write = await writeStoreFiles(store, judgeFiles, message, wait);
  if (write.kind === "public-store") return write;
  // The skip a judge with scores replaces, once the store shows it one.
  let replaced: ScoreSkip | null = null;
  const scoreWrite = await writeStoreFileReplacing(
    store,
    { path: score.path, content: storeJson(score.file) },
    (held) => {
      replaced = score.file.entries === null ? null : (heldScoreFile(held)?.skip ?? null);
      return replaced !== null;
    },
    message,
    wait,
  );
  const scoreFile: ScoreFileWrite =
    scoreWrite.kind === "kept"
      ? { kind: "kept", held: heldScoreFile(scoreWrite.held) }
      : replaced === null
        ? { kind: "written" }
        : { kind: "replaced", skip: replaced };
  const kept = scoreFile.kind === "kept";
  return {
    kind: "written",
    score: score.file,
    judge: judge.record,
    scoreFile,
    written: kept ? write.written : [...write.written, score.path],
    existing: kept ? [...write.existing, score.path] : write.existing,
  };
}

/** A score file's text as the store holds it, read as a score file, or null if it isn't one the Kit can read. */
function heldScoreFile(text: string): ScoreFile | null {
  try {
    return readScoreFile(JSON.parse(text));
  } catch {
    return null;
  }
}

/** How the score-record job ended: a write, no judge run to record, or no token for the store. */
export type ScoreRecordOutcome = ScoreRecordWrite | { readonly kind: "no-judge" } | { readonly kind: "no-store-token" };

/** The score-record job's one step-summary line: what it scored, or why it didn't. */
export function scoreRecordSummary(outcome: ScoreRecordOutcome): string {
  switch (outcome.kind) {
    case "no-judge":
      return "Nothing scored: the judge job didn't run.";
    case "written":
      return `${storedLine(outcome.score, outcome.judge, outcome.scoreFile)} ${storeWriteSummary(SCORE, outcome)}`;
    default:
      return storeWriteSummary(SCORE, outcome);
  }
}

/** What the step summary calls a score file and the judge's files written with it. */
const SCORE = "score";

/** What a score file says, and what writing it came to. `judge` is null for a skip decided before any judge ran. */
function scoreWriteSummary(score: ScoreFile, judge: RunRecord | null, write: StoreWrite): string {
  if (write.kind === "public-store") return storeWriteSummary(SCORE, write);
  return `${scoredLine(score, judge)} ${storeWriteSummary(SCORE, write)}`;
}

/**
 * What the store holds for the run after the judge's write: the score file
 * built for it, written or written over a failed judge's skip, or the one the
 * store already held and kept, never scores the store doesn't hold (#451).
 */
function storedLine(score: ScoreFile, judge: RunRecord, scoreFile: ScoreFileWrite): string {
  switch (scoreFile.kind) {
    case "written":
      return scoredLine(score, judge);
    case "replaced":
      return `${scoredLine(score, judge)} They replace the ${scoreFile.skip.reason} score file an earlier judge left.`;
    case "kept": {
      const run = `Run ${score.runId}-${score.runAttempt} on #${score.issue}`;
      const why = score.skip === null ? "" : `Not scored: ${whyNot(score.skip, judge)}. `;
      const { held } = scoreFile;
      if (held === null) return `${why}${run} already has a score file the Kit can't read, which the store keeps.`;
      if (held.skip !== null) return `${why}${run} already has a ${held.skip.reason} score file, which the store keeps.`;
      return `${why}${run} was already scored, and the store keeps its score file: ${entriesOf(held)}.`;
    }
  }
}

/** What the score file says: each rubric's score, or why the run has none. `judge` is null for a skip decided before any judge ran. */
function scoredLine(score: ScoreFile, judge: RunRecord | null): string {
  const run = `run ${score.runId}-${score.runAttempt} on #${score.issue}`;
  if (score.skip !== null) return `Not scored: ${whyNot(score.skip, judge)}, so ${run} gets a ${score.skip.reason} score file.`;
  return `Scored ${run}${score.digestTrimmed === true ? " from a trimmed transcript" : ""}: ${entriesOf(score)}.`;
}

/** Each rubric's score in a score file, whether it passed and its label. */
function entriesOf(score: ScoreFile): string {
  return (score.entries ?? [])
    .map((entry) => `${entry.scorer}@${entry.version} ${entry.score.toFixed(2)}, ${entry.pass ? "passed" : "failed"} (${entry.label})`)
    .join("; ");
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
 * it writes itself, create-only, with the store token it already holds, under
 * the rubrics of the run's pinned release (scoringRubrics); a score it leaves
 * to the judge job.
 */
export async function scoreRecordedRun(
  store: StoreApi,
  recorded: { readonly files: RunRecordFiles | null; readonly write: RecordWrite },
  kit: KitRubrics,
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
      const score = scoreFileFor({ scored: record, scoredPath: recordPath, rubrics: scoringRubrics(record, kit), scoredAt, outcome: plan });
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
      return scoreWriteSummary(scoring.score, null, scoring.write);
  }
}
