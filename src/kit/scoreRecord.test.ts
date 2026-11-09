import { describe, expect, it } from "vitest";
import { aRunRecord } from "../__fixtures__/weeklySummary.ts";
import { noWait, storeWith } from "../__fixtures__/store.ts";
import type { RecordWrite } from "./recordWriter.ts";
import type { Rubric } from "./rubrics.ts";
import { judgeRunRecordFor } from "./runRecord.ts";
import { type ScoreFile, scoreFileFor, type ScoringOutcome } from "./scorer.ts";
import { recordedRunScoringSummary, type ScoreRecordFiles, scoreRecordedRun, scoreRecordSummary, writeScoreRecord } from "./scoreRecord.ts";

const RUBRICS: readonly Rubric[] = [
  { name: "efficiency", version: 1, threshold: 0.7, labels: ["clean", "repeated-calls"], text: "How directly the run worked." },
  { name: "skill-use", version: 1, threshold: 0.7, labels: ["followed", "missed-skill"], text: "Whether it used its skills." },
];

/** The rubrics as the push job reads them, from its checkout of the Kit commit that ran the run (aRunRecord's kitSha). */
const KIT = { sha: "f".repeat(40), rubrics: RUBRICS };

/** A sampled first Implement run on Ticket 7, its record and transcript in the store. */
const scored = aRunRecord({ runId: 1007, transcript: "transcripts/owner/product/2026-11/1007-1-implement.jsonl.gz" });
const SCORED_PATH = "runs/owner/product/2026-11/1007-1-implement.json";

const JUDGE_RECORD = "runs/owner/product/2026-11/1007-1-score.json";
const JUDGE_TRANSCRIPT = "transcripts/owner/product/2026-11/1007-1-score.jsonl.gz";
/** Where a judge re-run in the workflow run's second attempt files its own record and transcript. */
const JUDGE_RECORD_2 = "runs/owner/product/2026-11/1007-2-score.json";
const JUDGE_TRANSCRIPT_2 = "transcripts/owner/product/2026-11/1007-2-score.jsonl.gz";
const TRANSCRIPT_GZIP = new Uint8Array([0x1f, 0x8b, 8, 0]);

/** The judge's stream: an init and a clean result. */
const JUDGE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5-5", apiKeySource: "none" }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0.04 }),
];

const ANSWERS = [
  { scorer: "efficiency", score: 0.8, label: "clean", rationale: "Each call moved the work on." },
  { scorer: "skill-use", score: 0.5, label: "missed-skill", rationale: "Never loaded tdd." },
] as const;

const judged: ScoringOutcome = {
  kind: "judged",
  judge: { model: "claude-sonnet-5-5", record: JUDGE_RECORD, digestTrimmed: false },
  output: { answers: ANSWERS },
};

/**
 * What the score-record job writes for a judge run that ended with `outcome`,
 * its job ending with `jobResult` in the workflow run's `attempt`.
 */
function files(outcome: ScoringOutcome = judged, transcript: readonly string[] | null = JUDGE_LINES, jobResult = "success", attempt = "1"): ScoreRecordFiles {
  const judge = judgeRunRecordFor({
    scored,
    judge: { result: jobResult, outputs: { "secrets-step": "success", model: "claude-sonnet-5-5", effort: "", attempt } },
    judgeModel: "claude-sonnet-5-5",
    kitSha: "k".repeat(40),
    endedAt: "2026-11-04T12:06:00Z",
    failureReport: null,
    transcript,
  });
  // The score file names the judge's record wherever it went, as the score-record job's does.
  const judgedBy = outcome.kind === "skip" ? outcome : { ...outcome, judge: { ...outcome.judge, record: judge.recordPath } };
  const score = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: "2026-11-04T12:06:00Z", outcome: judgedBy });
  return { judge, judgeTranscriptGzip: transcript === null ? null : TRANSCRIPT_GZIP, score };
}

const decoded = (base64: string | undefined): unknown => JSON.parse(Buffer.from(base64 ?? "", "base64").toString("utf8"));

describe("Writing a judge run's files to the store", () => {
  it("writes the judge's transcript, then its Run record, then the score file", async () => {
    const store = storeWith();
    const run = files();

    const write = await writeScoreRecord(store, run, noWait);

    expect(store.writes).toEqual([JUDGE_TRANSCRIPT, JUDGE_RECORD, run.score.path]);
    expect(write).toEqual({
      kind: "written",
      score: run.score.file,
      judge: run.judge.record,
      scoreFile: { kind: "written" },
      written: [JUDGE_TRANSCRIPT, JUDGE_RECORD, run.score.path],
      existing: [],
    });
    expect(Buffer.from(store.held.get(JUDGE_TRANSCRIPT) ?? "", "base64")).toEqual(Buffer.from(TRANSCRIPT_GZIP));
    expect(decoded(store.held.get(JUDGE_RECORD))).toMatchObject({ role: "score", issue: 7, runId: 1007, runAttempt: 1 });
    expect(decoded(store.held.get(run.score.path))).toMatchObject({ record: SCORED_PATH, judge: { record: JUDGE_RECORD }, skip: null });
  });

  it("a re-run with the same rubrics leaves every file the store holds as it was, and writes no other", async () => {
    const run = files();
    const store = storeWith({ files: [JUDGE_TRANSCRIPT, JUDGE_RECORD, run.score.path] });

    const write = await writeScoreRecord(store, run, noWait);

    expect(write).toMatchObject({ kind: "written", written: [], existing: [JUDGE_TRANSCRIPT, JUDGE_RECORD, run.score.path] });
    expect([...store.held.entries()]).toEqual([
      [JUDGE_TRANSCRIPT, "earlier"],
      [JUDGE_RECORD, "earlier"],
      [run.score.path, "earlier"],
    ]);
  });

  it("a judge re-run after one whose output wasn't valid replaces the skip score file with its scores, beside a Run record of its own (#451)", async () => {
    const invalid = files({ ...judged, output: { answers: [] } });
    const first = storeWith();
    await writeScoreRecord(first, invalid, noWait);
    const store = storeWith({ contents: Object.fromEntries(first.held) });
    const rerun = files(judged, JUDGE_LINES, "success", "2");

    const write = await writeScoreRecord(store, rerun, noWait);

    expect(write).toMatchObject({
      kind: "written",
      written: [JUDGE_TRANSCRIPT_2, JUDGE_RECORD_2, rerun.score.path],
      existing: [],
      scoreFile: { kind: "replaced", skip: { reason: "judge-output-invalid" } },
    });
    expect(rerun.score.path).toBe(invalid.score.path);
    expect(decoded(store.held.get(rerun.score.path))).toMatchObject({
      judge: { record: JUDGE_RECORD_2 },
      skip: null,
      entries: [{ scorer: "efficiency", score: 0.8 }, { scorer: "skill-use", score: 0.5 }],
    });
    // The failed judge's record stays, so what both judges cost counts.
    expect(store.held.get(JUDGE_RECORD)).toBe(first.held.get(JUDGE_RECORD));
    expect(decoded(store.held.get(JUDGE_RECORD_2))).toMatchObject({ role: "score", runId: 1007, runAttempt: 2, totalCostUsd: 0.04 });
  });

  it("a judge re-run that fails again leaves the skip score file as it was, beside a Run record of its own", async () => {
    const failed = files({ kind: "judge-failed", judge: { ...judged.judge, digestTrimmed: null } }, null, "failure");
    const first = storeWith();
    await writeScoreRecord(first, failed, noWait);
    const store = storeWith({ contents: Object.fromEntries(first.held) });

    const write = await writeScoreRecord(store, files({ ...judged, output: { answers: [] } }, JUDGE_LINES, "success", "2"), noWait);

    expect(write).toMatchObject({
      kind: "written",
      written: [JUDGE_TRANSCRIPT_2, JUDGE_RECORD_2],
      existing: [failed.score.path],
      scoreFile: { kind: "kept", held: { skip: { reason: "judge-failed" } } },
    });
    expect(store.held.get(failed.score.path)).toBe(first.held.get(failed.score.path));
  });

  it("never replaces a score file that holds scores", async () => {
    const first = storeWith();
    await writeScoreRecord(first, files(), noWait);
    const store = storeWith({ contents: Object.fromEntries(first.held) });
    const rerun = files({ ...judged, output: { answers: [{ ...ANSWERS[0], score: 0.1 }, ANSWERS[1]] } }, JUDGE_LINES, "success", "2");

    const write = await writeScoreRecord(store, rerun, noWait);

    expect(write).toMatchObject({ kind: "written", existing: [rerun.score.path], scoreFile: { kind: "kept", held: { entries: [{ score: 0.8 }, { score: 0.5 }] } } });
    expect(store.held.get(rerun.score.path)).toBe(first.held.get(rerun.score.path));
  });

  it("writes the files a re-run finds missing, and leaves the others", async () => {
    const run = files();
    const store = storeWith({ files: [JUDGE_TRANSCRIPT, JUDGE_RECORD] });

    const write = await writeScoreRecord(store, run, noWait);

    expect(write).toMatchObject({ kind: "written", written: [run.score.path], existing: [JUDGE_TRANSCRIPT, JUDGE_RECORD] });
  });

  it("retries a write a parallel commit beat", async () => {
    const run = files();
    const store = storeWith({ conflicts: { [run.score.path]: 2 } });

    const write = await writeScoreRecord(store, run, noWait);

    expect(write).toMatchObject({ kind: "written", written: [JUDGE_TRANSCRIPT, JUDGE_RECORD, run.score.path], existing: [] });
    expect(store.writes.filter((path) => path === run.score.path)).toHaveLength(3);
  });

  it("writes the record and score file of a judge whose transcript didn't survive", async () => {
    const run = files({ kind: "judge-failed", judge: { model: "claude-sonnet-5-5", record: JUDGE_RECORD, digestTrimmed: null } }, null);
    const store = storeWith();

    const write = await writeScoreRecord(store, run, noWait);

    expect(write).toMatchObject({ kind: "written", written: [JUDGE_RECORD, run.score.path], existing: [] });
    expect(decoded(store.held.get(run.score.path))).toMatchObject({ skip: { reason: "judge-failed" }, entries: null });
  });

  it("writes nothing to a store that isn't private", async () => {
    const store = storeWith({ private: false });

    expect(await writeScoreRecord(store, files(), noWait)).toEqual({ kind: "public-store" });
    expect(store.writes).toEqual([]);
  });
});

describe("The score-record job's step-summary line", () => {
  const written = (run: ScoreRecordFiles) =>
    ({
      kind: "written",
      score: run.score.file,
      judge: run.judge.record,
      scoreFile: { kind: "written" },
      written: [run.judge.recordPath, run.score.path],
      existing: [],
    }) as const;
  /** A judge re-run's write that found the score file already there, holding `held`. */
  const kept = (run: ScoreRecordFiles, held: ScoreFile | null) =>
    ({ ...written(run), scoreFile: { kind: "kept", held }, written: [run.judge.recordPath], existing: [run.score.path] }) as const;

  it("names each rubric's score, whether it passed and its label, and what was written", () => {
    const run = files();

    expect(scoreRecordSummary(written(run))).toBe(
      "Scored run 1007-1 on #7: efficiency@1 0.80, passed (clean); skill-use@1 0.50, failed (missed-skill). " +
        `Written to jrey8343/fabrik-runs: ${JUDGE_RECORD}, ${run.score.path}.`,
    );
  });

  it("says when the judge read a trimmed transcript", () => {
    const run = files({ ...judged, judge: { ...judged.judge, digestTrimmed: true } } as ScoringOutcome);

    expect(scoreRecordSummary(written(run))).toMatch(/^Scored run 1007-1 on #7 from a trimmed transcript: efficiency@1 0\.80/);
  });

  it("says why a judge that failed scored nothing, naming its failure", () => {
    const run = files({ kind: "judge-failed", judge: { ...judged.judge, digestTrimmed: null } }, null, "cancelled");

    expect(scoreRecordSummary(written(run))).toBe(
      "Not scored: the judge failed (timeout), so run 1007-1 on #7 gets a judge-failed score file. " +
        `Written to jrey8343/fabrik-runs: ${JUDGE_RECORD}, ${run.score.path}.`,
    );
  });

  it("says why a judge whose output wasn't valid scored nothing", () => {
    const run = files({ ...judged, output: { answers: [] } });

    expect(scoreRecordSummary(written(run))).toMatch(/^Not scored: the judge's output wasn't valid, so run 1007-1 on #7 gets a judge-output-invalid score file\. /);
  });

  it("says what a re-run found already there and left as it was, giving the scores the store holds, not its own (#451)", () => {
    const stored = files();
    const run = files({ ...judged, output: { answers: [{ ...ANSWERS[0], score: 0.1 }, ANSWERS[1]] } });
    const again = { ...kept(run, stored.score.file), written: [], existing: [run.judge.recordPath, run.score.path] };

    expect(scoreRecordSummary(again)).toBe(
      "Run 1007-1 on #7 was already scored, and the store keeps its score file: efficiency@1 0.80, passed (clean); skill-use@1 0.50, failed (missed-skill). " +
        `Already there, left as it was: ${JUDGE_RECORD}, ${run.score.path}.`,
    );
  });

  it("says a judge re-run's scores replaced the skip score file a failed judge left, and where it wrote them (#451)", () => {
    const run = files(judged, JUDGE_LINES, "success", "2");
    const replaced = { ...written(run), scoreFile: { kind: "replaced", skip: { reason: "judge-output-invalid" } } } as const;

    expect(scoreRecordSummary(replaced)).toBe(
      "Scored run 1007-1 on #7: efficiency@1 0.80, passed (clean); skill-use@1 0.50, failed (missed-skill). " +
        "They replace the judge-output-invalid score file an earlier judge left. " +
        `Written to jrey8343/fabrik-runs: ${JUDGE_RECORD_2}, ${run.score.path}.`,
    );
  });

  it("says why a judge re-run scored nothing, and which skip score file the store keeps", () => {
    const stored = files({ kind: "judge-failed", judge: { ...judged.judge, digestTrimmed: null } }, null, "cancelled");
    const run = files({ ...judged, output: { answers: [] } }, JUDGE_LINES, "success", "2");

    expect(scoreRecordSummary(kept(run, stored.score.file))).toBe(
      "Not scored: the judge's output wasn't valid. Run 1007-1 on #7 already has a judge-failed score file, which the store keeps. " +
        `Written to jrey8343/fabrik-runs: ${JUDGE_RECORD_2}. Already there, left as it was: ${run.score.path}.`,
    );
  });

  it("says when the score file the store keeps is one the Kit can't read", () => {
    const run = files();

    expect(scoreRecordSummary(kept(run, null))).toBe(
      "Run 1007-1 on #7 already has a score file the Kit can't read, which the store keeps. " +
        `Written to jrey8343/fabrik-runs: ${JUDGE_RECORD}. Already there, left as it was: ${run.score.path}.`,
    );
  });

  it("says nothing was scored when the judge job didn't run", () => {
    expect(scoreRecordSummary({ kind: "no-judge" })).toBe("Nothing scored: the judge job didn't run.");
  });

  it("says why nothing was written without a token for the store", () => {
    expect(scoreRecordSummary({ kind: "no-store-token" })).toBe("No score written: the Fabrik App couldn't get a token for jrey8343/fabrik-runs.");
  });

  it("says why nothing was written to a store that isn't private", () => {
    expect(scoreRecordSummary({ kind: "public-store" })).toBe(
      "No score written: jrey8343/fabrik-runs isn't private, and the Kit writes nothing to a store others can read. Make it private.",
    );
  });
});

describe("The push job's scoring of the run it just recorded", () => {
  /** A Retry on Ticket 7, always picked, whose record the push job just wrote. */
  const retry = aRunRecord({ runId: 1008, retry: 1, transcript: "transcripts/owner/product/2026-11/1008-1-implement.jsonl.gz" });
  const RETRY_PATH = "runs/owner/product/2026-11/1008-1-implement.json";
  const recorded = (record = retry, write: RecordWrite = { kind: "written", written: [RETRY_PATH], existing: [] }) => ({
    files: { record, recordPath: RETRY_PATH, transcriptPath: record.transcript },
    write,
  });

  it("asks the judge job to score a picked run, with its record's path and its kind (#450), and writes nothing itself", async () => {
    const store = storeWith();

    expect(await scoreRecordedRun(store, recorded(), KIT, "2026-11-04T12:01:00Z", noWait)).toEqual({
      kind: "score",
      record: RETRY_PATH,
      run: { kind: "retry", retry: 1, timedOut: false },
    });
    expect(store.writes).toEqual([]);
  });

  it("writes a picked run's skip score file itself, beside its record, when the plan skips it", async () => {
    const store = storeWith();

    const scoring = await scoreRecordedRun(store, recorded({ ...retry, transcript: null }), KIT, "2026-11-04T12:01:00Z", noWait);

    expect(store.writes).toHaveLength(1);
    const [path] = store.writes;
    expect(path).toMatch(/^scores\/owner\/product\/2026-11\/1008-1-implement-[0-9a-f]+\.json$/);
    expect(scoring).toMatchObject({ kind: "skip", write: { kind: "written", written: [path], existing: [] } });
    expect(decoded(store.held.get(path!))).toMatchObject({
      record: RETRY_PATH,
      scoredAt: "2026-11-04T12:01:00Z",
      judge: null,
      digestTrimmed: null,
      skip: { reason: "no-transcript" },
      entries: null,
    });
  });

  it("scores nothing when the record reached no store: one that isn't private, or no agent run to record", async () => {
    const store = storeWith();
    const scoredAt = "2026-11-04T12:01:00Z";

    expect(await scoreRecordedRun(store, recorded(retry, { kind: "public-store" }), KIT, scoredAt, noWait)).toEqual({ kind: "none" });
    expect(await scoreRecordedRun(store, recorded({ ...retry, transcript: null }, { kind: "public-store" }), KIT, scoredAt, noWait)).toEqual({
      kind: "none",
    });
    expect(await scoreRecordedRun(store, { files: null, write: { kind: "no-record" } }, KIT, scoredAt, noWait)).toEqual({ kind: "none" });
    expect(store.writes).toEqual([]);
  });

  it("plans on a record the store already held, and leaves a skip score file it already holds as it was", async () => {
    const skipped = { ...retry, transcript: null };
    const first = storeWith();
    await scoreRecordedRun(first, recorded(skipped), KIT, "2026-11-04T12:01:00Z", noWait);
    const store = storeWith({ files: first.writes });

    const again = recorded(skipped, { kind: "written", written: [], existing: [RETRY_PATH] });

    const scoring = await scoreRecordedRun(store, again, KIT, "2026-11-04T12:09:00Z", noWait);

    expect(scoring).toMatchObject({ kind: "skip", write: { kind: "written", written: [], existing: first.writes } });
    expect(store.held.get(first.writes[0]!)).toBe("earlier");
  });

  it("writes nothing, and asks for no score, for a run scoring doesn't consider", async () => {
    const store = storeWith();
    const review = aRunRecord({ runId: 1009, role: "review", transcript: "transcripts/owner/product/2026-11/1009-1-review.jsonl.gz" });

    expect(await scoreRecordedRun(store, recorded(review), KIT, "2026-11-04T12:01:00Z", noWait)).toEqual({ kind: "none" });
    expect(store.writes).toEqual([]);
  });
});

describe("The push job's step-summary line on scoring", () => {
  it("says nothing of a run scoring passes by, so a run that isn't sampled stays quiet", () => {
    expect(recordedRunScoringSummary({ kind: "none" })).toBeNull();
  });

  it("says the judge job scores a picked run", () => {
    expect(recordedRunScoringSummary({ kind: "score", record: SCORED_PATH, run: { kind: "first", retry: 0, timedOut: false } })).toBe(`Picked for scoring: the judge job scores ${SCORED_PATH}.`);
  });

  it("says why a picked run isn't scored, and where its skip score file went", () => {
    const outcome: ScoringOutcome = { kind: "skip", skip: { reason: "no-transcript" } };
    const skip = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: "2026-11-04T12:01:00Z", outcome });

    expect(recordedRunScoringSummary({ kind: "skip", score: skip.file, write: { kind: "written", written: [skip.path], existing: [] } })).toBe(
      `Not scored: no transcript of the run survived, so run 1007-1 on #7 gets a no-transcript score file. Written to jrey8343/fabrik-runs: ${skip.path}.`,
    );
  });

  it("says why a skip's score file wasn't written to a store that isn't private", () => {
    const outcome: ScoringOutcome = { kind: "skip", skip: { reason: "no-transcript" } };
    const skip = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: "2026-11-04T12:01:00Z", outcome });

    expect(recordedRunScoringSummary({ kind: "skip", score: skip.file, write: { kind: "public-store" } })).toBe(
      "No score written: jrey8343/fabrik-runs isn't private, and the Kit writes nothing to a store others can read. Make it private.",
    );
  });
});
