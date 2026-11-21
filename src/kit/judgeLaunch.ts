// How the judge launches (#149): with no tools, through the same `claude`
// arguments the metered-billing preflight checks for the agent roles
// (src/agent/launch.ts), and with its one answer checked as the score file
// will check it. The judge job runs it from src/kit/judge-main.ts. What the
// job leaves for the score-record job is src/kit/judge.ts, which needs none of
// this. Pure, no I/O.
import { Output, type OutputObjectDefinition } from "@ai-hero/sandcastle";
import { type AgentLaunch, agentLaunch, type Checked, schemaOf } from "../agent/launch.ts";
import type { Rubric } from "./rubrics.ts";
import { JUDGE_EFFORT, JUDGE_MODEL } from "./runStore.ts";
import { type JudgeOutput, NOT_APPLICABLE, scoreEntries } from "./scorer.ts";
import { JUDGE_OUTPUT_TAG } from "./scorerPrompt.ts";

/**
 * What the judge adds to its `claude` launch: no built-in tools at all, and no
 * MCP server but those given on the command line, of which there are none. So
 * a transcript holding hostile text can at worst skew a score. Never `--bare`,
 * which the metered-billing preflight refuses.
 */
const NO_TOOLS = ["--tools", "", "--strict-mcp-config"] as const;

/**
 * The judge's launch: the Kit's judge model at the Kit's judge effort, with no
 * tools, on the launch every agent starts through (src/agent/launch.ts), so
 * its arguments are the ones the metered-billing preflight checks.
 */
export function judgeLaunch(): AgentLaunch {
  return agentLaunch(JUDGE_MODEL, JUDGE_EFFORT, JUDGE_OUTPUT_TAG, NO_TOOLS);
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
        ...rubrics.map((rubric) => {
          const labels = `- \`${rubric.name}\`: one of ${rubric.labels.map((label) => `\`${label}\``).join(", ")}`;
          return rubric.labels.includes(NOT_APPLICABLE) ? `${labels}, with a \`score\` of null for \`${NOT_APPLICABLE}\` alone` : labels;
        }),
      ],
    };
  };
}
