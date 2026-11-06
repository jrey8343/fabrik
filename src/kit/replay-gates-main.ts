// The replay gates job's program (#156): runs a Replay arm's gates on its
// change (src/kit/replayGates.ts), the Sandbox's setup, build and tests from
// Kit config at the Ticket's baseSha, then the merged PR's hidden tests laid
// over the tree from its merge commit, and passes out how they went as
// gates.json, for the replay-record job. The Product's commands get the
// Sandbox's values and its test secrets, never a Claude token, and the job
// holds no write credential (ADR-0002). When the arm's change wasn't laid
// (src/kit/replay-patch-main.ts), it runs nothing and passes out nothing.
//   node src/kit/replay-gates-main.ts <product checkout>
// Env: FABRIK_BASE_SHA; FABRIK_LAID, the patch step's `laid`; FABRIK_SECRETS,
// what 1Password resolved (`toJSON(steps.op.outputs)`); FABRIK_HIDDEN_TESTS_FILE;
// FABRIK_OUT_DIR; FABRIK_TICKET and FABRIK_ARM.
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { readKitConfigWith } from "./checkout.ts";
import type { ReplayArmGates } from "./replay.ts";
import { type HiddenTestsAt, REPLAY_GATES_FILE, runReplayGates } from "./replayGates.ts";
import { testEnv } from "./secrets.ts";
import { writeSummary } from "./stepFiles.ts";

const run = promisify(execFile);

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/** A file at `sha`, or null when it isn't there: Kit config as the Ticket's baseSha holds it, whatever the arm's change did. */
async function fileAt(productDir: string, sha: string, path: string): Promise<string | null> {
  try {
    return (await run("git", ["show", `${sha}:${path}`], { cwd: productDir, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
}

/** A Product command in the checkout, with the env the gates give it, true when it exits 0. */
function command(productDir: string, env: NodeJS.ProcessEnv): (line: string) => Promise<boolean> {
  return (line) =>
    new Promise((resolve) => {
      console.log(`::group::${line}`);
      const child = spawn("bash", ["-c", line], { cwd: productDir, env, stdio: ["ignore", "inherit", "inherit"] });
      child.once("error", (error) => {
        console.log(error.message);
        console.log("::endgroup::");
        resolve(false);
      });
      child.once("exit", (code) => {
        console.log("::endgroup::");
        resolve(code === 0);
      });
    });
}

async function main(productDir: string): Promise<void> {
  if (process.env["FABRIK_LAID"] !== "true") {
    console.log("The arm's change wasn't laid, so its gates don't run.");
    return;
  }
  const baseSha = required("FABRIK_BASE_SHA");
  const resolved = await readKitConfigWith((path) => fileAt(productDir, baseSha, path));
  if (!resolved.ok) throw new Error(`The Kit config at ${baseSha} is invalid: ${resolved.errors.join("; ")}`);
  const { sandbox } = resolved.config;
  const hidden = JSON.parse(await readFile(required("FABRIK_HIDDEN_TESTS_FILE"), "utf8")) as HiddenTestsAt;
  const env = { ...process.env, ...testEnv(resolved.config, process.env["FABRIK_SECRETS"] || "{}") };
  delete env["FABRIK_SECRETS"];

  const outcome = await runReplayGates(sandbox, hidden.paths, {
    run: command(productDir, env),
    layHiddenTests: async (paths) => {
      await run("git", ["checkout", hidden.mergeCommit, "--", ...paths], { cwd: productDir });
    },
  });
  const arm = required("FABRIK_ARM");
  if (arm !== "baseline" && arm !== "variant") throw new Error(`FABRIK_ARM is ${arm}, not an arm`);
  const gates: ReplayArmGates = { ticket: Number(required("FABRIK_TICKET")), arm, run: Number(required("GITHUB_RUN_ID")), ...outcome };
  const outDir = required("FABRIK_OUT_DIR");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, REPLAY_GATES_FILE), `${JSON.stringify(gates, null, 2)}\n`);
  await writeSummary(`### Replay gates\n\nThe ${gates.arm} arm's gates: ${outcome.gates}; the merged PR's hidden tests: ${outcome.hiddenTests}.\n`);
}

const [productDir] = process.argv.slice(2);
if (productDir === undefined) {
  console.error("Usage: node src/kit/replay-gates-main.ts <product checkout>");
  process.exitCode = 2;
} else {
  main(resolve(productDir)).catch((error: unknown) => {
    console.log(`::error title=Replay gates failed::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
