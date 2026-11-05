import { claudeCode } from "@ai-hero/sandcastle";
import { describe, expect, it } from "vitest";
import { cleanLaunch } from "../__fixtures__/preflight.ts";
import { checkMeteredBilling } from "../preflight/meteredBilling.ts";
import type { Rubric } from "./rubrics.ts";
import { judgeClaudeArgs, judgeFailureText, judgeOutcome, judgeResultText, readJudgeOutput, withoutTools } from "./judge.ts";

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

describe("The judge's check of its own answer, which the runner asks it to fix once", () => {
  const rubrics: readonly Rubric[] = [
    { name: "efficiency", version: 1, threshold: 0.7, labels: ["clean", "repeated-calls"], text: "How directly the run worked." },
    { name: "skill-use", version: 1, threshold: 0.7, labels: ["followed", "missed-skill"], text: "Whether it used its skills." },
  ];
  const answer = (scorer: string, label: string) => ({ scorer, score: 0.8, label, rationale: "Why." });

  it("takes an answer per rubric, each with one of its labels", () => {
    const output = { answers: [answer("efficiency", "clean"), answer("skill-use", "followed")] };

    expect(readJudgeOutput(rubrics)(output)).toEqual({ ok: true, output });
  });

  it("refuses an answer the score file would refuse, saying what each rubric owes", () => {
    const check = readJudgeOutput(rubrics)({ answers: [answer("efficiency", "clean"), answer("skill-use", "clean")] });

    expect(check.ok).toBe(false);
    expect(check.ok ? [] : check.errors.join("\n")).toMatch(/`efficiency`: one of `clean`, `repeated-calls`[\s\S]*`skill-use`: one of `followed`, `missed-skill`/);
  });
});

describe("The judge's launch", () => {
  const judge = withoutTools(claudeCode("claude-sonnet-5-5"));
  /** A launch command's words, with Sandcastle's single quotes taken off. */
  const words = (command: string) => command.split(" ").map((word) => word.replace(/^'(.*)'$/, "$1"));

  it.each([
    ["a fresh session", {}],
    ["the session the runner resumes to ask for a fixed answer", { resumeSession: "4f6c0b1e" }],
  ])("runs %s with no tools and no MCP server", (_, resume) => {
    const { command } = judge.buildPrintCommand({ prompt: "Score this run.", dangerouslySkipPermissions: true, ...resume });

    expect(command).toMatch(/ --tools '' --strict-mcp-config -p -$/);
    expect(command).not.toContain("--bare");
  });

  it("keeps the prompt on stdin, as the runner gives it", () => {
    expect(judge.buildPrintCommand({ prompt: "Score this run.", dangerouslySkipPermissions: true }).stdin).toBe("Score this run.");
  });

  it("gives the metered-billing preflight the arguments it launches with, which it lets through", () => {
    const { command } = judge.buildPrintCommand({ prompt: "Score this run.", dangerouslySkipPermissions: true });
    const args = judgeClaudeArgs("claude-sonnet-5-5");

    expect(words(command)).toEqual(["claude", ...args]);
    expect(args).toEqual(expect.arrayContaining(["--model", "claude-sonnet-5-5", "--tools", "", "--strict-mcp-config"]));
    expect(checkMeteredBilling(cleanLaunch({ args }))).toEqual({ kind: "pass" });
  });
});
