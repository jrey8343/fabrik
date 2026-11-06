// The replay score job's first program (#156): the scoring plan on the arm's
// Implement run, from the record the replay-record job will build of it
// (armScoring, src/kit/replayRecord.ts), so the judge runs only on a run the
// plan picks and a run it skips spends no judge run (#286). The replay-record
// job writes a skip's score file itself.
//   node src/kit/replay-scoring-plan-main.ts
// Env: FABRIK_KIT_OUTPUTS (`toJSON(needs.kit.outputs)`), FABRIK_ARM, and
// FABRIK_REPLAY_DIR, where the arm's Implement artifacts were downloaded, each
// into a folder named after it. Step outputs: `score` ("true" or "false") and `why`.
import { armRunArtifactsIn } from "./replayArtifacts.ts";
import { armScoring, replayRunContextOf } from "./replayRecord.ts";
import { isReplayArm } from "./runRecord.ts";
import { writeOutputs, writeSummary } from "./stepFiles.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const arm = required("FABRIK_ARM");
  if (!isReplayArm(arm)) throw new Error(`FABRIK_ARM is ${arm}, not an arm`);
  const context = replayRunContextOf(JSON.parse(required("FABRIK_KIT_OUTPUTS")) as Record<string, string>, {
    repo: required("GITHUB_REPOSITORY"),
    runId: Number(required("GITHUB_RUN_ID")),
    runAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
  });
  const implement = await armRunArtifactsIn(required("FABRIK_REPLAY_DIR"), "implement", arm);
  const { score, why } = armScoring(context, arm, implement, new Date().toISOString());
  await writeOutputs({ score: String(score), why });
  await writeSummary(`### Scores\n\n${score ? `The judge scores the ${arm} arm's Implement run: ${why}.` : `Not judged: ${why}.`}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
