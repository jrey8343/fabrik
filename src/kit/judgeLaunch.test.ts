import { claudeCode } from "@ai-hero/sandcastle";
import { describe, expect, it } from "vitest";
import { cleanLaunch } from "../__fixtures__/preflight.ts";
import { checkMeteredBilling } from "../preflight/meteredBilling.ts";
import { judgeClaudeArgs, readJudgeOutput, withoutTools } from "./judgeLaunch.ts";
import type { Rubric } from "./rubrics.ts";

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
