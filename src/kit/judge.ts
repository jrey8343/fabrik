// The judge run (#149): what the judge job leaves for the score-record job,
// and how the score-record job reads that back as how scoring ended. The judge
// job runs src/kit/judge-main.ts, which launches the judge as
// src/kit/judgeLaunch.ts says; the score-record job runs
// src/kit/score-record-main.ts, which, like the push job, runs without the
// Kit's runtime dependencies, so nothing here imports them. Pure, no I/O.
import { readFailureReport } from "../agent/failure.ts";
import { isObject } from "../agent/stream.ts";
import type { FailureReport } from "../loop/types.ts";
import type { JudgeRun, ScoringOutcome } from "./scorer.ts";

/**
 * The judge job's key in loop.yml, whose `needs` entry the score-record job
 * reads as the push job reads an agent job's. Never named like the Implement
 * job, so Dispatch's count of Implement runs in flight passes it by.
 */
export const JUDGE_JOB = "score";

/** The judge's answer, in the judge job's `fabrik-judge-result` artifact. */
export const JUDGE_RESULT_FILE = "judge-result.json";

/** The judge's failure report, in the judge job's `fabrik-judge-failure` artifact: an agent failure report, for its Run record, plus whether its transcript was trimmed. */
export const JUDGE_FAILURE_FILE = "judge-failure.json";

/** The judge's result file: its structured output, as the runner parsed it, and whether the transcript was trimmed. */
export function judgeResultText(output: unknown, transcriptTrimmed: boolean): string {
  return `${JSON.stringify({ transcriptTrimmed, output }, null, 2)}\n`;
}

/** The judge's failure file: how it failed, and whether its transcript was trimmed, or null if it failed before it built its prompt. */
export function judgeFailureText(report: FailureReport, transcriptTrimmed: boolean | null): string {
  return `${JSON.stringify({ ...report, transcriptTrimmed }, null, 2)}\n`;
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
export function judgeOutcome(artifacts: JudgeArtifacts, judge: Omit<JudgeRun, "transcriptTrimmed">): ScoringOutcome {
  if (artifacts.result !== null) {
    const result = jsonObjectOf(artifacts.result);
    if (result === null) return { kind: "judge-output-invalid", judge: { ...judge, transcriptTrimmed: null } };
    return { kind: "judged", judge: { ...judge, transcriptTrimmed: trimmedOf(result["transcriptTrimmed"]) }, output: result["output"] };
  }
  if (artifacts.failure === null) return { kind: "judge-failed", judge: { ...judge, transcriptTrimmed: null } };
  const transcriptTrimmed = trimmedOf(jsonObjectOf(artifacts.failure)?.["transcriptTrimmed"]);
  const kind = readFailureReport(artifacts.failure).failure === "missing-output" ? "judge-output-invalid" : "judge-failed";
  return { kind, judge: { ...judge, transcriptTrimmed } };
}

/** A judge file's text as the JSON object it holds, or null if it holds anything else or isn't JSON. */
function jsonObjectOf(text: string): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function trimmedOf(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
