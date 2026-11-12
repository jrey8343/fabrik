import { describe, expect, it } from "vitest";
import { judgeFailureText, judgeOutcome, judgeResultText } from "./judge.ts";

/** The judge run as the score-record job names it: the model it ran and its record's path. */
const JUDGE = { model: "claude-sonnet-5-5", record: "runs/owner/product/2026-11/1007-1-score.json" };

const OUTPUT = { answers: [{ scorer: "efficiency", score: 0.8, label: "clean", rationale: "Each call moved the work on." }] };

describe("The files the judge job leaves for the score-record job", () => {
  it("the result file holds the judge's output and whether its transcript was trimmed", () => {
    expect(JSON.parse(judgeResultText(OUTPUT, true))).toEqual({ transcriptTrimmed: true, output: OUTPUT });
  });

  it("the failure file holds the failure report and whether the judge's transcript was trimmed, null when it never built its prompt", () => {
    const report = { failure: "crash", detail: "it went wrong" } as const;

    expect(JSON.parse(judgeFailureText(report, false))).toEqual({ ...report, transcriptTrimmed: false });
    expect(JSON.parse(judgeFailureText(report, null))).toEqual({ ...report, transcriptTrimmed: null });
  });
});

describe("What the score-record job makes of the judge's artifacts", () => {
  it("reads whether the transcript was trimmed from the result file and from the failure file", () => {
    const result = JSON.stringify({ transcriptTrimmed: true, output: OUTPUT });
    const failure = JSON.stringify({ failure: "crash", detail: "it went wrong", transcriptTrimmed: true });

    expect(judgeOutcome({ result, failure: null }, JUDGE)).toEqual({ kind: "judged", judge: { ...JUDGE, transcriptTrimmed: true }, output: OUTPUT });
    expect(judgeOutcome({ result: null, failure }, JUDGE)).toEqual({ kind: "judge-failed", judge: { ...JUDGE, transcriptTrimmed: true } });
  });

  it("a judge that answered gives its output to check, and says whether its transcript was trimmed", () => {
    const result = judgeResultText(OUTPUT, true);

    expect(judgeOutcome({ result, failure: null }, JUDGE)).toEqual({ kind: "judged", judge: { ...JUDGE, transcriptTrimmed: true }, output: OUTPUT });
  });

  it("a judge whose output never met its schema gives judge-output-invalid", () => {
    const failure = judgeFailureText({ failure: "missing-output", detail: "the <score> tag failed validation" }, false);

    expect(judgeOutcome({ result: null, failure }, JUDGE)).toEqual({ kind: "judge-output-invalid", judge: { ...JUDGE, transcriptTrimmed: false } });
  });

  it.each(["crash", "provider-error", "dead-token", "weekly-limit", "metered-billing"] as const)(
    "a judge that failed with %s gives judge-failed",
    (failure) => {
      const text = judgeFailureText({ failure, detail: "it went wrong" }, true);

      expect(judgeOutcome({ result: null, failure: text }, JUDGE)).toEqual({ kind: "judge-failed", judge: { ...JUDGE, transcriptTrimmed: true } });
    },
  );

  it("a judge that failed before it built its prompt leaves whether its transcript was trimmed unknown", () => {
    const failure = judgeFailureText({ failure: "crash", detail: "No transcript of the scored run to judge" }, null);

    expect(judgeOutcome({ result: null, failure }, JUDGE)).toEqual({ kind: "judge-failed", judge: { ...JUDGE, transcriptTrimmed: null } });
  });

  // Its timeout cancelled it, or its Claude token never loaded.
  it("a judge that left nothing gives judge-failed", () => {
    expect(judgeOutcome({ result: null, failure: null }, JUDGE)).toEqual({ kind: "judge-failed", judge: { ...JUDGE, transcriptTrimmed: null } });
  });

  it.each([
    ["isn't JSON", "{ not json"],
    ["holds no JSON object", "[]\n"],
  ])("a judge's result that %s gives judge-output-invalid", (_, result) => {
    expect(judgeOutcome({ result, failure: null }, JUDGE)).toEqual({
      kind: "judge-output-invalid",
      judge: { ...JUDGE, transcriptTrimmed: null },
    });
  });

  it("a failure report that can't be read counts as a judge failure", () => {
    expect(judgeOutcome({ result: null, failure: "{ not json" }, JUDGE)).toEqual({ kind: "judge-failed", judge: { ...JUDGE, transcriptTrimmed: null } });
  });
});
