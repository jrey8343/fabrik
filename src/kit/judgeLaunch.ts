// How the judge launches (#149): with no tools, through the same `claude`
// arguments the metered-billing preflight checks for the agent roles
// (src/agent/launch.ts), and checking its own answer as the score file will.
// The judge job runs it from src/kit/judge-main.ts. What the job leaves for
// the score-record job is src/kit/judge.ts, which needs none of this. Pure, no I/O.
import type { AgentProvider } from "@ai-hero/sandcastle";
import { type Checked, claudeArgs } from "../agent/launch.ts";
import type { Rubric } from "./rubrics.ts";
import { type JudgeOutput, scoreEntries } from "./scorer.ts";

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
