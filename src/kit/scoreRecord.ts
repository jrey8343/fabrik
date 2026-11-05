// What the score-record job writes (#149): the judge run's transcript, its Run
// record (role `score`) and the score file, each create-only and retrying on
// conflict through the record writer (src/kit/recordWriter.ts), to the store,
// RUN_STORE. Like the push job, the job runs no agent and no Product code. The
// files themselves are built by src/kit/runRecord.ts and src/kit/scorer.ts.
import { type StoreApi, type StoreFile, storeCommitMessage, storeJson, writeStoreFiles } from "./recordWriter.ts";
import type { RunRecord, RunRecordFiles } from "./runRecord.ts";
import { RUN_STORE_REPO } from "./runStore.ts";
import type { ScoreFile, ScoreFileFiles, ScoreSkip } from "./scorer.ts";

/** A judge run's files, as the score-record job writes them. */
export interface ScoreRecordFiles {
  /** The judge run's Run record, and where it and its transcript go. */
  readonly judge: RunRecordFiles;
  /** The judge's gzipped transcript, or null if none survived its run. */
  readonly judgeTranscriptGzip: Uint8Array | null;
  /** The score file, and where it goes. */
  readonly score: ScoreFileFiles;
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
    case "written": {
      const writes = [
        ...(outcome.written.length === 0 ? [] : [`Written to ${RUN_STORE_REPO}: ${outcome.written.join(", ")}.`]),
        ...(outcome.existing.length === 0 ? [] : [`Already there, left as it was: ${outcome.existing.join(", ")}.`]),
      ];
      return [scoredLine(outcome.score, outcome.judge), ...writes].join(" ");
    }
  }
}

/** What the score file says: each rubric's score, or why the run has none. */
function scoredLine(score: ScoreFile, judge: RunRecord): string {
  const run = `run ${score.runId}-${score.runAttempt} on #${score.issue}`;
  if (score.skip !== null) return `Not scored: ${whyNot(score.skip, judge)}, so ${run} gets a ${score.skip.reason} score file.`;
  const entries = (score.entries ?? []).map(
    (entry) => `${entry.scorer}@${entry.version} ${entry.score.toFixed(2)}, ${entry.pass ? "passed" : "failed"} (${entry.label})`,
  );
  return `Scored ${run}${score.digestTrimmed === true ? " from a trimmed transcript" : ""}: ${entries.join("; ")}.`;
}

function whyNot(skip: ScoreSkip, judge: RunRecord): string {
  switch (skip.reason) {
    case "judge-failed":
      return judge.infrastructureFailure === null ? "the judge failed" : `the judge failed (${judge.infrastructureFailure})`;
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
