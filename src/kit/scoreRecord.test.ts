import { describe, expect, it } from "vitest";
import { aRunRecord } from "../__fixtures__/weeklySummary.ts";
import { noWait, storeWith } from "../__fixtures__/store.ts";
import type { Rubric } from "./rubrics.ts";
import { judgeRunRecordFor } from "./runRecord.ts";
import { scoreFileFor, type ScoringOutcome } from "./scorer.ts";
import { type ScoreRecordFiles, scoreRecordSummary, writeScoreRecord } from "./scoreRecord.ts";

const RUBRICS: readonly Rubric[] = [
  { name: "efficiency", version: 1, threshold: 0.7, labels: ["clean", "repeated-calls"], text: "How directly the run worked." },
  { name: "skill-use", version: 1, threshold: 0.7, labels: ["followed", "missed-skill"], text: "Whether it used its skills." },
];

/** A sampled first Implement run on Ticket 7, its record and transcript in the store. */
const scored = aRunRecord({ runId: 1007, transcript: "transcripts/owner/product/2026-11/1007-1-implement.jsonl.gz" });
const SCORED_PATH = "runs/owner/product/2026-11/1007-1-implement.json";

const JUDGE_RECORD = "runs/owner/product/2026-11/1007-1-score.json";
const JUDGE_TRANSCRIPT = "transcripts/owner/product/2026-11/1007-1-score.jsonl.gz";
const TRANSCRIPT_GZIP = new Uint8Array([0x1f, 0x8b, 8, 0]);

/** The judge's stream: an init and a clean result. */
const JUDGE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5-5", apiKeySource: "none" }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0.04 }),
];

const judged: ScoringOutcome = {
  kind: "judged",
  judge: { model: "claude-sonnet-5-5", record: JUDGE_RECORD, digestTrimmed: false },
  output: {
    answers: [
      { scorer: "efficiency", score: 0.8, label: "clean", rationale: "Each call moved the work on." },
      { scorer: "skill-use", score: 0.5, label: "missed-skill", rationale: "Never loaded tdd." },
    ],
  },
};

/** What the score-record job writes for a judge run that ended with `outcome`, its job ending with `jobResult`. */
function files(outcome: ScoringOutcome = judged, transcript: readonly string[] | null = JUDGE_LINES, jobResult = "success"): ScoreRecordFiles {
  const judge = judgeRunRecordFor({
    scored,
    judge: { result: jobResult, outputs: { "secrets-step": "success", model: "claude-sonnet-5-5", effort: "" } },
    judgeModel: "claude-sonnet-5-5",
    kitSha: "k".repeat(40),
    endedAt: "2026-11-04T12:06:00Z",
    failureReport: null,
    transcript,
  });
  const score = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: "2026-11-04T12:06:00Z", outcome });
  return { judge, judgeTranscriptGzip: transcript === null ? null : TRANSCRIPT_GZIP, score };
}

const decoded = (base64: string | undefined): unknown => JSON.parse(Buffer.from(base64 ?? "", "base64").toString("utf8"));

describe("Writing a judge run's files to the store", () => {
  it("writes the judge's transcript, then its Run record, then the score file", async () => {
    const store = storeWith();
    const run = files();

    const write = await writeScoreRecord(store, run, noWait);

    expect(store.writes).toEqual([JUDGE_TRANSCRIPT, JUDGE_RECORD, run.score.path]);
    expect(write).toEqual({ kind: "written", score: run.score.file, judge: run.judge.record, written: [JUDGE_TRANSCRIPT, JUDGE_RECORD, run.score.path], existing: [] });
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
    ({ kind: "written", score: run.score.file, judge: run.judge.record, written: [run.judge.recordPath, run.score.path], existing: [] }) as const;

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

  it("says what a re-run found already there and left as it was", () => {
    const run = files();
    const again = { ...written(run), written: [], existing: [run.judge.recordPath, run.score.path] };

    expect(scoreRecordSummary(again)).toBe(
      "Scored run 1007-1 on #7: efficiency@1 0.80, passed (clean); skill-use@1 0.50, failed (missed-skill). " +
        `Already there, left as it was: ${JUDGE_RECORD}, ${run.score.path}.`,
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
      "No score written: jrey8343/fabrik-runs isn't private, and scores never go to a store others can read. Make it private.",
    );
  });
});
