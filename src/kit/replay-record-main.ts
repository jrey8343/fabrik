// The replay-record job's program (#156), the replay's own push job
// (ADR-0009's shape): from what both arms' jobs left, it writes each arm's
// Implement and Review runs' Run records and transcripts, its patch and gates,
// and the judge's record and score file to the store, each create-only and
// retrying on conflict (src/kit/replayRecord.ts), and one step-summary line
// saying what it wrote. It runs no agent and no Product code. First, before
// it reads the rubrics or touches the store, it leaves how the Ticket's run
// ended in a file, which the job's run-loop step lands on the replay issue
// (src/main.ts), so neither a missing rubric nor a store problem leaves the
// Ticket in progress.
//   node src/kit/replay-record-main.ts
// Env: FABRIK_KIT_OUTPUTS (`toJSON(needs.kit.outputs)`), FABRIK_REPLAY_DIR,
// where the arms' artifacts were downloaded, each into a folder named after
// it, and FABRIK_STORE_TOKEN, scoped to the store, empty when it couldn't be
// minted. Step output: `ended`, the file it left.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GitHub } from "../github/client.ts";
import { loadRubrics } from "./kitFiles.ts";
import { recordWriteSummary } from "./recordWriter.ts";
import { armArtifactsIn } from "./replayArtifacts.ts";
import { REPLAY_RUN_ENDED_FILE, replayRunContextOf, replayRunEnded, replayRunFiles, writeReplayRun } from "./replayRecord.ts";
import { REPLAY_ARMS } from "./runRecord.ts";
import { writeOutputs, writeSummary } from "./stepFiles.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const context = replayRunContextOf(JSON.parse(required("FABRIK_KIT_OUTPUTS")) as Record<string, string>, {
    repo: required("GITHUB_REPOSITORY"),
    runId: Number(required("GITHUB_RUN_ID")),
    runAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
  });
  const dir = required("FABRIK_REPLAY_DIR");
  const [baseline, variant] = await Promise.all(REPLAY_ARMS.map((arm) => armArtifactsIn(dir, arm)));
  const arms = { baseline: baseline!, variant: variant! };
  const endedAt = new Date().toISOString();

  // How the run ended, left before anything else can fail, so the run lands whatever comes after.
  const ended = join(required("RUNNER_TEMP"), REPLAY_RUN_ENDED_FILE);
  const runEnded = replayRunEnded(context, arms, endedAt);
  await writeFile(ended, `${JSON.stringify(runEnded, null, 2)}\n`);
  const { end } = runEnded;
  await writeOutputs({ ended });
  console.log(`The replay of #${context.ticket}: ${"reason" in end ? `${end.kind}, ${end.reason}` : end.kind}.`);

  // The rubrics in this job's Kit checkout, at the Kit job's sha: the pinned release's, never a candidate's.
  const kit = { sha: context.kitSha, rubrics: await loadRubrics() };
  const files = replayRunFiles(context, arms, kit, endedAt);

  // No store, or the Fabrik App not on it: setup hasn't got that far, and the Loop still lands the run.
  const token = process.env["FABRIK_STORE_TOKEN"] ?? "";
  const outcome = token === "" ? ({ kind: "no-store-token" } as const) : await writeReplayRun(new GitHub(token, process.env["GITHUB_API_URL"]), files, (ms) => sleep(ms));
  await writeSummary(`### Run records\n\n${recordWriteSummary(outcome)}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
