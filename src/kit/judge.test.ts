import { describe, expect, it } from "vitest";
import { judgeFailureText, judgeOutcome, judgeResultText } from "./judge.ts";

/** The judge run as the score-record job names it: the model it ran and its record's path. */
const JUDGE = { model: "claude-sonnet-5-5", record: "runs/owner/product/2026-11/1007-1-score.json" };

const OUTPUT = { answers: [{ scorer: "efficiency", score: 0.8, label: "clean", rationale: "Each call moved the work on." }] };

describe("What the score-record job makes of the judge's artifacts", () => {
  it("a judge that answered gives its output to check, and says whether its digest was trimmed", () => {
    const result = judgeResultText(OUTPUT, true);

    expect(judgeOutcome({ result, failure: null }, JUDGE)).toEqual({ kind: "judged", judge: { ...JUDGE, digestTrimmed: true }, output: OUTPUT });
  });

  it("a judge whose output never met its schema gives judge-output-invalid", () => {
    const failure = judgeFailureText({ failure: "missing-output", detail: "the <score> tag failed validation" }, false);

    expect(judgeOutcome({ result: null, failure }, JUDGE)).toEqual({ kind: "judge-output-invalid", judge: { ...JUDGE, digestTrimmed: false } });
  });

  it.each(["crash", "provider-error", "dead-token", "weekly-limit", "metered-billing"] as const)(
    "a judge that failed with %s gives judge-failed",
    (failure) => {
      const text = judgeFailureText({ failure, detail: "it went wrong" }, true);

      expect(judgeOutcome({ result: null, failure: text }, JUDGE)).toEqual({ kind: "judge-failed", judge: { ...JUDGE, digestTrimmed: true } });
    },
  );

  it("a judge that failed before it built its prompt leaves whether its digest was trimmed unknown", () => {
    const failure = judgeFailureText({ failure: "crash", detail: "No transcript of the scored run to judge" }, null);

    expect(judgeOutcome({ result: null, failure }, JUDGE)).toEqual({ kind: "judge-failed", judge: { ...JUDGE, digestTrimmed: null } });
  });

  // Its timeout cancelled it, or its Claude token never loaded.
  it("a judge that left nothing gives judge-failed", () => {
    expect(judgeOutcome({ result: null, failure: null }, JUDGE)).toEqual({ kind: "judge-failed", judge: { ...JUDGE, digestTrimmed: null } });
  });

  it("a judge's result that can't be read gives judge-output-invalid", () => {
    expect(judgeOutcome({ result: "{ not json", failure: null }, JUDGE)).toEqual({
      kind: "judge-output-invalid",
      judge: { ...JUDGE, digestTrimmed: null },
    });
  });

  it("a failure report that can't be read counts as a judge failure", () => {
    expect(judgeOutcome({ result: null, failure: "{ not json" }, JUDGE)).toEqual({ kind: "judge-failed", judge: { ...JUDGE, digestTrimmed: null } });
  });
});
