// The judge job's program (#149): the Kit's fixed judge model (JUDGE_MODEL),
// at its default effort, scores one finished Implementer run on the Kit's
// rubrics from its transcript and its Ticket, in one read. It runs with no
// tools (src/kit/judgeLaunch.ts) through the same Sandcastle runner,
// metered-billing preflight and init check as the agent roles
// (src/agent/launch.ts), in an empty directory: never a Product checkout,
// never the Kit's. Its env holds no GitHub token, and its job holds only the
// read-only one, which reads the Ticket (ADR-0004). It leaves its answer, checked
// against the rubrics, or its failure report, for the score-record job, and
// its transcript beside them.
//   node src/kit/judge-main.ts
// Env:
//   FABRIK_TRANSCRIPT_DIR   the scored run's gzipped transcript (loop.yml's fabrik-transcript-implement)
//   FABRIK_TICKET_FILE      the Ticket's title and body (src/kit/judge-ticket-main.ts)
//   FABRIK_OUT_DIR          where to write judge-result.json or judge-failure.json, the agent log and the transcript
//   FABRIK_ROTATION         "true" when Subscription rotation is on, so overage in the stream kills the judge
//   CLAUDE_CODE_OAUTH_TOKEN, from the agent service account (ADR-0004)
// Writes the step outputs `model` and `effort`, for the judge's Run record.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeCode, run } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { leaveFailureReport, readyHook, setAgentEnv, streamWatch } from "../agent/launch.ts";
import { runSummary } from "../agent/summary.ts";
import { readTranscriptGzip, TRANSCRIPT_FILE } from "../agent/transcript.ts";
import type { FailureReport } from "../loop/types.ts";
import { readBytesIfPresent } from "./checkout.ts";
import { writeOutputs, writeSummary } from "./stepFiles.ts";
import { JUDGE_FAILURE_FILE, JUDGE_JOB, JUDGE_RESULT_FILE, judgeFailureText, judgeResultText } from "./judge.ts";
import { judgeClaudeArgs, judgeOutput, withoutTools } from "./judgeLaunch.ts";
import { loadRubrics } from "./kitFiles.ts";
import { JUDGE_MODEL, JUDGE_TIMEOUT_MINUTES } from "./runStore.ts";
import { type JudgedTicket, judgePrompt } from "./scorerPrompt.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/**
 * An empty git repository for the judge to run in: Sandcastle runs the agent
 * in a git checkout, and nothing in this one (no CLAUDE.md, no settings, no
 * MCP config) can steer it.
 */
async function emptyWorkingDir(): Promise<string> {
  const dir = await mkdtemp(join(process.env["RUNNER_TEMP"] || tmpdir(), "fabrik-judge-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "--quiet");
  git("-c", "user.name=Fabrik", "-c", "user.email=fabrik@users.noreply.github.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "The judge's empty working directory");
  return dir;
}

async function main(): Promise<void> {
  const outDir = resolve(required("FABRIK_OUT_DIR"));
  await mkdir(outDir, { recursive: true });
  // For the judge's Run record (src/kit/runRecord.ts): the model passed to the CLI, at its default effort.
  await writeOutputs({ model: JUDGE_MODEL, effort: "" });

  const abort = new AbortController();
  // With rotation on, a judge whose stream shows overage is stopped, as an agent run is.
  const watch = streamWatch(join(outDir, TRANSCRIPT_FILE), abort, { rotation: process.env["FABRIK_ROTATION"] === "true" });
  // Unknown until the prompt is built: a judge that fails before then can't say.
  let digestTrimmed: boolean | null = null;
  try {
    const gzip = await readBytesIfPresent(join(required("FABRIK_TRANSCRIPT_DIR"), `${TRANSCRIPT_FILE}.gz`));
    const scored = gzip === null ? null : readTranscriptGzip(gzip);
    if (scored === null) throw new Error("No transcript of the scored run survived to judge");
    const ticket = JSON.parse(await readFile(required("FABRIK_TICKET_FILE"), "utf8")) as JudgedTicket;
    const rubrics = await loadRubrics();
    const { prompt, trimmed } = judgePrompt({ transcript: scored.lines, ticket, rubrics });
    digestTrimmed = trimmed;

    // The agent inherits this process's env (noSandbox), so set what it needs here.
    setAgentEnv(judgeClaudeArgs(JUDGE_MODEL));
    const result = await run({
      name: JUDGE_JOB,
      agent: withoutTools(claudeCode(JUDGE_MODEL)),
      sandbox: noSandbox(),
      cwd: await emptyWorkingDir(),
      prompt,
      maxIterations: 1,
      output: judgeOutput(rubrics),
      // No setup: the judge runs nothing, so only the preflight.
      hooks: { sandbox: { onSandboxReady: [{ command: readyHook(null), timeoutMs: JUDGE_TIMEOUT_MINUTES * 60_000 }] } },
      signal: abort.signal,
      logging: { type: "file", path: join(outDir, "agent.log"), onAgentStreamEvent: watch.onAgentStreamEvent },
    });
    watch.checkInit();

    await writeFile(join(outDir, JUDGE_RESULT_FILE), judgeResultText((result as { output?: unknown }).output, trimmed));
    console.log(`The judge scored the run on ${rubrics.map((rubric) => rubric.name).join(", ")}${trimmed ? ", from a trimmed transcript" : ""}`);
  } catch (error) {
    // Left for the score-record job, which writes the judge's record and a judge-failed or judge-output-invalid score file.
    const text = (report: FailureReport) => judgeFailureText(report, digestTrimmed);
    await leaveFailureReport(error, watch, { path: join(outDir, JUDGE_FAILURE_FILE), title: "The judge failed", text });
    throw error;
  } finally {
    await writeSummary(runSummary({ role: JUDGE_JOB, effort: null, lines: watch.lines }));
  }
}

main().catch((error: unknown) => {
  console.log(`::error title=The judge failed::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
