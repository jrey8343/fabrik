import { describe, expect, it } from "vitest";
import { cleanLaunch } from "../__fixtures__/preflight.ts";
import { checkMeteredBilling } from "../preflight/meteredBilling.ts";
import { judgeAgent, judgeClaudeArgs, judgeOutput } from "./judgeLaunch.ts";
import type { Rubric } from "./rubrics.ts";
import { JUDGE_OUTPUT_TAG } from "./scorerPrompt.ts";

describe("The judge's answer, read from its one reply", () => {
  const rubrics: readonly Rubric[] = [
    { name: "efficiency", version: 1, threshold: 0.7, labels: ["clean", "repeated-calls"], text: "How directly the run worked." },
    { name: "test-first", version: 1, threshold: 0.8, labels: ["test-first", "test-after", "not-applicable"], text: "Whether it wrote its failing tests first." },
  ];
  const answer = (scorer: string, label: string) => ({ scorer, score: 0.8, label, rationale: "Why." });
  const check = (value: unknown) => judgeOutput(rubrics).schema["~standard"].validate(value);

  it("comes in the tag the judge prompt asks for", () => {
    expect(judgeOutput(rubrics).tag).toBe(JUDGE_OUTPUT_TAG);
  });

  it("takes an answer per rubric, each with one of its labels", async () => {
    const output = { answers: [answer("efficiency", "clean"), answer("test-first", "test-first")] };

    expect(await check(output)).toEqual({ value: output });
  });

  it("takes no score with not-applicable for a rubric that lists it, and refuses it for one that doesn't (#739)", async () => {
    const notApplicable = (scorer: string) => ({ scorer, score: null, label: "not-applicable", rationale: "A rebase alone." });
    const output = { answers: [answer("efficiency", "clean"), notApplicable("test-first")] };

    expect(await check(output)).toEqual({ value: output });
    expect(await check({ answers: [notApplicable("efficiency"), answer("test-first", "test-first")] })).toHaveProperty("issues");
  });

  it("refuses an answer the score file would refuse, saying what each rubric owes", async () => {
    const result = await check({ answers: [answer("efficiency", "clean"), answer("test-first", "clean")] });
    const issues = "issues" in result && result.issues !== undefined ? result.issues.map((issue) => issue.message).join("\n") : "";

    expect(issues).toMatch(/`efficiency`: one of `clean`, `repeated-calls`\n/);
    expect(issues).toMatch(/`test-first`: one of `test-first`, `test-after`, `not-applicable`, with a `score` of null for `not-applicable` alone/);
  });

  // A malformed answer fails the judge (missing-output), which the score file records as judge-output-invalid.
  it("is never asked for again, so the judge reads the transcript once", () => {
    expect(judgeOutput(rubrics).maxRetries ?? 0).toBe(0);
  });
});

describe("The judge's launch", () => {
  const judge = judgeAgent();
  /** A launch command's words, with Sandcastle's single quotes taken off. */
  const words = (command: string) => command.split(" ").map((word) => word.replace(/^'(.*)'$/, "$1"));

  // Named outright, so the judge's Run record says the level and a Claude Code upgrade can't change it unseen (#740).
  it("runs Sonnet 5.5 at medium effort", () => {
    const { command } = judge.buildPrintCommand({ prompt: "Score this run.", dangerouslySkipPermissions: true });

    expect(words(command)).toEqual(expect.arrayContaining(["--model", "claude-sonnet-5-5", "--effort", "medium"]));
  });

  it("runs with no tools and no MCP server", () => {
    const { command } = judge.buildPrintCommand({ prompt: "Score this run.", dangerouslySkipPermissions: true });

    expect(command).toMatch(/ --tools '' --strict-mcp-config -p -$/);
    expect(command).not.toContain("--bare");
  });

  it("keeps the prompt on stdin, as the runner gives it", () => {
    expect(judge.buildPrintCommand({ prompt: "Score this run.", dangerouslySkipPermissions: true }).stdin).toBe("Score this run.");
  });

  it("gives the metered-billing preflight the arguments it launches with, which it lets through", () => {
    const { command } = judge.buildPrintCommand({ prompt: "Score this run.", dangerouslySkipPermissions: true });
    const args = judgeClaudeArgs();

    expect(words(command)).toEqual(["claude", ...args]);
    expect(args).toEqual(expect.arrayContaining(["--model", "claude-sonnet-5-5", "--effort", "medium", "--tools", "", "--strict-mcp-config"]));
    expect(checkMeteredBilling(cleanLaunch({ args }))).toEqual({ kind: "pass" });
  });
});
