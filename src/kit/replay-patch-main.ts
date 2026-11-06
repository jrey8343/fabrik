// Lays a Replay arm's patch (#156), its Implement run's diff from the Ticket's
// baseSha, on a fresh checkout of baseSha as one local commit, for the arm's
// gates and Review jobs, which never push it. An empty patch, from an arm that
// committed nothing, lays nothing and leaves the checkout at baseSha. Like the
// push job's guard (ADR-0005), it lays no patch that changes a Trust-root
// file, so an arm's change never steers its own Review; and with no patch, as
// when the arm's Implement run failed, there is nothing to judge. Either way it
// says why, and the job runs nothing on it.
//   node src/kit/replay-patch-main.ts <product checkout> <the arm's Implement artifact folder>
// Env: FABRIK_BASE_SHA, the commit the checkout must be at. Step outputs:
// `laid` ("true" or "false") and `why`, when it laid nothing.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { REPLAY_PATCH_FILE } from "../agent/replay.ts";
import { parseNameStatus } from "../guard/changes.ts";
import { checkTrustRoot } from "../guard/trust-root.ts";
import { IMPLEMENTER_AUTHOR } from "../loop/agentPullRequest.ts";
import { readBytesIfPresent } from "./checkout.ts";
import { writeOutputs, writeSummary } from "./stepFiles.ts";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
}

/** Lays the patch, or says why it laid none. */
async function lay(productDir: string, implementDir: string, baseSha: string): Promise<string | null> {
  const head = (await git(productDir, "rev-parse", "HEAD")).trim();
  if (head !== baseSha) throw new Error(`The checkout is at ${head}, not the replay's baseSha ${baseSha}`);
  const patchPath = join(implementDir, REPLAY_PATCH_FILE);
  const patch = await readBytesIfPresent(patchPath);
  if (patch === null) return "its Implement run left no patch";
  if (patch.length === 0) return null;
  await git(productDir, "apply", "--index", "--binary", patchPath);
  const { name, email } = IMPLEMENTER_AUTHOR;
  await git(productDir, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "--quiet", "--no-verify", "-m", "The replay arm's change");
  const guard = checkTrustRoot(parseNameStatus(await git(productDir, "diff", "--name-status", "-z", "-M", baseSha, "HEAD")));
  if (guard.kind !== "refuse") return null;
  await git(productDir, "reset", "--quiet", "--hard", baseSha);
  return `its patch changes files that steer or judge the agents, which the Kit never lays (ADR-0005): ${guard.paths.join(", ")}`;
}

async function main(productDir: string, implementDir: string): Promise<void> {
  const baseSha = process.env["FABRIK_BASE_SHA"] ?? "";
  if (baseSha === "") throw new Error("FABRIK_BASE_SHA is not set");
  const why = await lay(productDir, implementDir, baseSha);
  await writeOutputs({ laid: String(why === null), why: why ?? "" });
  if (why !== null) {
    console.log(`::warning title=Nothing to run on::The arm's change wasn't laid: ${why}`);
    await writeSummary(`### Replay arm\n\nThe arm's change wasn't laid, so nothing runs on it: ${why}.\n`);
  }
}

const [productDir, implementDir] = process.argv.slice(2);
if (productDir === undefined || implementDir === undefined) {
  console.error("Usage: node src/kit/replay-patch-main.ts <product checkout> <the arm's Implement artifact folder>");
  process.exitCode = 2;
} else {
  main(productDir, implementDir).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
