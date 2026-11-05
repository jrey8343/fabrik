// How the judge launches (#149): with no tools, through the same `claude`
// arguments the metered-billing preflight checks for the agent roles
// (src/agent/launch.ts), and with its one answer checked as the score file
// will check it. The judge job runs it from src/kit/judge-main.ts. What the
// job leaves for the score-record job is src/kit/judge.ts, which needs none of
// this. Pure, no I/O.
import { type AgentProvider, Output, type OutputObjectDefinition } from "@ai-hero/sandcastle";
import { type Checked, claudeArgs, schemaOf } from "../agent/launch.ts";
import type { Rubric } from "./rubrics.ts";
import { type JudgeOutput, scoreEntries } from "./scorer.ts";
import { JUDGE_OUTPUT_TAG } from "./scorerPrompt.ts";

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
 * The provider with no tools. Sandcastle 0.12.0's claudeCode() has no option
 * for it, so this adds the flags to the command it builds.
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
 * The judge's structured output: its answer in the judge prompt's tag,
 * checked as the score file will check it. Never retried, so the judge reads
 * the transcript once: an answer that fails the check fails the judge
 * (missing-output), and the score file says judge-output-invalid.
 */
export function judgeOutput(rubrics: readonly Rubric[]): OutputObjectDefinition<JudgeOutput> {
  return Output.object({ tag: JUDGE_OUTPUT_TAG, schema: schemaOf(readJudgeOutput(rubrics)) });
}

/** The check of the judge's answer, whose errors say what each rubric owes, for its failure report. */
function readJudgeOutput(rubrics: readonly Rubric[]): (value: unknown) => Checked<JudgeOutput> {
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
