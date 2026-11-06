// The last step of a Replay arm's Implement, Review and judge jobs (#156):
// writes the job's account of its run (armJobOf, src/kit/replayArtifacts.ts),
// which its artifact carries to the replay-record job, since the legs of the
// arms' matrix overwrite each other's job outputs. It runs whether the run
// passed, failed or was cancelled.
//   node <kit>/src/kit/replay-arm-main.ts <output file>
// Env, each from the job's `steps` and `job` contexts: FABRIK_AGENT_STEP (the
// agent step's outcome), FABRIK_SECRETS_STEP, FABRIK_JOB_STATUS,
// FABRIK_RAN_MODEL and FABRIK_RAN_EFFORT (what the runner passed), and
// FABRIK_NOT_RUN (why the job never started its run, or empty).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { armJobOf } from "./replayArtifacts.ts";

const env = (name: string): string => process.env[name] ?? "";

async function main(outFile: string): Promise<void> {
  const job = armJobOf({
    agent: env("FABRIK_AGENT_STEP"),
    secrets: env("FABRIK_SECRETS_STEP"),
    job: env("FABRIK_JOB_STATUS"),
    model: env("FABRIK_RAN_MODEL"),
    effort: env("FABRIK_RAN_EFFORT"),
    notRun: env("FABRIK_NOT_RUN"),
  });
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(job, null, 2)}\n`);
  console.log(job.ran ? `The run's job ended: ${job.job.result}.` : `The run never started: ${job.why}.`);
}

const [outFile] = process.argv.slice(2);
if (outFile === undefined) {
  console.error("Usage: node src/kit/replay-arm-main.ts <output file>");
  process.exitCode = 2;
} else {
  main(outFile).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
