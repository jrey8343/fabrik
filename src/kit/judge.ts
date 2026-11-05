// The judge run (#149): how the judge launches, with no tools; how it checks
// its own answer; what the judge job leaves for the score-record job; and how
// the score-record job reads that back as how scoring ended. The judge job
// runs src/kit/judge-main.ts, the score-record job src/kit/score-record-main.ts.
// Pure, no I/O.
import type { AgentProvider } from "@ai-hero/sandcastle";
import { readFailureReport } from "../agent/failure.ts";
import { type Checked, claudeArgs } from "../agent/launch.ts";
import { streamMessageOf } from "../agent/stream.ts";
import type { FailureReport } from "../loop/types.ts";
import type { Rubric } from "./rubrics.ts";
import { type JudgeOutput, type JudgeRun, scoreEntries, type ScoringOutcome } from "./scorer.ts";

/**
 * What the judge adds to its `claude` launch: no built-in tools at all, and no
 * MCP server but those given on the command line, of which there are none. So
 * a transcript holding hostile text can at worst skew a score. Never `--bare`,
 * which the metered-billing preflight refuses.
 */
const NO_TOOLS = ["--tools", "", "--strict-mcp-config"] as const;

/** The end of every launch command Sandcastle's claudeCode() builds: the prompt on stdin. */
const PROMPT_ON_STDIN = " -p -";

/**
 * The provider with no tools, fresh or resumed: Sandcastle resumes the
 * session to ask for a fixed answer. Sandcastle 0.12.0's claudeCode() has no
 * option for it, so this adds the flags to the command it builds.
 */
export function withoutTools(provider: AgentProvider): AgentProvider {
  return {
    ...provider,
    buildPrintCommand(options) {
      const built = provider.buildPrintCommand(options);
      if (!built.command.endsWith(PROMPT_ON_STDIN)) throw new Error(`Can't take the tools away from an unexpected launch command: ${built.command}`);
      const flags = NO_TOOLS.map((flag) => (flag === "" ? "''" : flag)).join(" ");
      return { ...built, command: `${built.command.slice(0, -PROMPT_ON_STDIN.length)} ${flags}${PROMPT_ON_STDIN}` };
    },
  };
}

/** The judge's `claude` arguments, as the metered-billing preflight checks them: default effort, no tools. */
export function judgeClaudeArgs(model: string): string[] {
  return claudeArgs(model, null, NO_TOOLS);
}

/**
 * The judge's check of its own answer, as the score file will check it, so
 * the runner can ask it once to fix an answer the score file would refuse.
 */
export function readJudgeOutput(rubrics: readonly Rubric[]): (value: unknown) => Checked<JudgeOutput> {
  return (value) => {
    if (scoreEntries(rubrics, value) !== null) return { ok: true, output: value as JudgeOutput };
    return {
      ok: false,
      errors: [
        `The answer must be a JSON object whose \`answers\` hold exactly one answer per rubric, each with the rubric's name as \`scorer\`, a \`score\` from 0 to 1, a \`rationale\`, and a \`label\` from that rubric's list:`,
        ...rubrics.map((rubric) => `- \`${rubric.name}\`: one of ${rubric.labels.map((label) => `\`${label}\``).join(", ")}`),
      ],
    };
  };
}

/**
 * The judge job's key in loop.yml, whose `needs` entry the score-record job
 * reads as the push job reads an agent job's. Never named like the Implement
 * job, so Dispatch's count of Implement runs in flight passes it by.
 */
export const JUDGE_JOB = "score";

/** The judge's answer, in the judge job's `fabrik-judge-result` artifact. */
export const JUDGE_RESULT_FILE = "judge-result.json";

/** The judge's failure report, in the judge job's `fabrik-judge-failure` artifact: an agent failure report, for its Run record, plus whether its digest was trimmed. */
export const JUDGE_FAILURE_FILE = "judge-failure.json";

/** The judge's result file: its structured output, as the runner parsed it, and whether the transcript's digest was trimmed. */
export function judgeResultText(output: unknown, digestTrimmed: boolean): string {
  return `${JSON.stringify({ digestTrimmed, output }, null, 2)}\n`;
}

/** The judge's failure file: how it failed, and whether its digest was trimmed, or null if it failed before it built its prompt. */
export function judgeFailureText(report: FailureReport, digestTrimmed: boolean | null): string {
  return `${JSON.stringify({ ...report, digestTrimmed }, null, 2)}\n`;
}

/** What the judge job left: each file's text, or null if it left none. */
export interface JudgeArtifacts {
  readonly result: string | null;
  readonly failure: string | null;
}

/**
 * How scoring ended, from what the judge left: its output, for the score file
 * to check in full; `judge-output-invalid` when its output never met its
 * schema or its result can't be read; and `judge-failed` for any other
 * failure, or when it left nothing at all (cancelled by its timeout, or its
 * Claude token never loaded).
 */
export function judgeOutcome(artifacts: JudgeArtifacts, judge: Omit<JudgeRun, "digestTrimmed">): ScoringOutcome {
  if (artifacts.result !== null) {
    const result = streamMessageOf(artifacts.result);
    if (result === null) return { kind: "judge-output-invalid", judge: { ...judge, digestTrimmed: null } };
    return { kind: "judged", judge: { ...judge, digestTrimmed: trimmedOf(result["digestTrimmed"]) }, output: result["output"] };
  }
  if (artifacts.failure === null) return { kind: "judge-failed", judge: { ...judge, digestTrimmed: null } };
  const digestTrimmed = trimmedOf(streamMessageOf(artifacts.failure)?.["digestTrimmed"]);
  const kind = readFailureReport(artifacts.failure).failure === "missing-output" ? "judge-output-invalid" : "judge-failed";
  return { kind, judge: { ...judge, digestTrimmed } };
}

function trimmedOf(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
