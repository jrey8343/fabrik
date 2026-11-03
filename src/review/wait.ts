// The Review's checks job: waits for an agent PR's required checks to finish
// on its head, and tells the workflow how they ended. It holds only a
// read-only token and runs none of the PR's code; its job's timeout (the
// Review timeout) bounds the wait, and a timeout is an Infrastructure failure.
//   node src/review/wait.ts <product checkout>
// Env: GH_TOKEN (read-only), GITHUB_REPOSITORY, FABRIK_PULL_REQUEST, GITHUB_OUTPUT.
// Writes step outputs:
//   checks   "green", "red", or "stale" when the PR moved on, closed or left draft while waiting
//   head-sha the commit the checks ran on
//   failed   the required checks that didn't pass, as a JSON list
import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { readKitConfigFromCheckout } from "../kit/checkout.ts";
import { type CheckState, checksFromGh, requiredChecksOutcome } from "./checks.ts";

const run = promisify(execFile);

/** Long enough for a fresh push's check suites to register before an empty list counts as nothing gating. */
const SETTLE_MS = 60_000;
const POLL_MS = 30_000;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function gh(...args: string[]): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  try {
    const { stdout, stderr } = await run("gh", args, { maxBuffer: 16 * 1024 * 1024 });
    return { stdout, stderr, failed: false };
  } catch (error) {
    // `gh pr checks` exits non-zero while checks are pending or failed, still printing them.
    const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown };
    return { stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed: true };
  }
}

interface PullRequestState {
  readonly headRefOid: string;
  readonly isDraft: boolean;
  readonly state: string;
}

async function pullRequestState(repo: string, number: string): Promise<PullRequestState> {
  const { stdout } = await gh("pr", "view", number, "--repo", repo, "--json", "headRefOid,isDraft,state");
  return JSON.parse(stdout) as PullRequestState;
}

/** The PR head's checks: every one when Kit config names the gating checks, else only the required ones. */
async function checksOf(repo: string, number: string, gating: readonly string[]): Promise<CheckState[]> {
  const args = ["pr", "checks", number, "--repo", repo, "--json", "name,bucket"];
  return checksFromGh(await gh(...args, ...(gating.length === 0 ? ["--required"] : [])));
}

async function main(productDir: string): Promise<void> {
  const resolved = await readKitConfigFromCheckout(productDir);
  if (!resolved.ok) throw new Error(`The Kit config is invalid:\n${resolved.errors.map((e) => `- ${e}`).join("\n")}`);
  const gating = resolved.config.sandbox.checks;
  const repo = required("GITHUB_REPOSITORY");
  const number = required("FABRIK_PULL_REQUEST");

  const start = await pullRequestState(repo, number);
  const headSha = start.headRefOid;
  await sleep(SETTLE_MS);
  let outcome: { checks: string; failed: readonly string[] };
  for (;;) {
    const now = await pullRequestState(repo, number);
    if (now.headRefOid !== headSha || now.state !== "OPEN" || !now.isDraft) {
      outcome = { checks: "stale", failed: [] };
      break;
    }
    const result = requiredChecksOutcome(await checksOf(repo, number, gating), gating);
    if (result.kind === "green") outcome = { checks: "green", failed: [] };
    else if (result.kind === "red") outcome = { checks: "red", failed: result.failed };
    else {
      await sleep(POLL_MS);
      continue;
    }
    break;
  }
  console.log(`Required checks on #${number} at ${headSha}: ${outcome.checks}${outcome.failed.length > 0 ? ` (${outcome.failed.join(", ")})` : ""}`);
  await appendFile(
    required("GITHUB_OUTPUT"),
    `checks=${outcome.checks}\nhead-sha=${headSha}\nfailed=${JSON.stringify(outcome.failed)}\n`,
  );
}

const productDir = process.argv[2];
if (productDir === undefined) {
  console.error("Usage: node src/review/wait.ts <product checkout>");
  process.exitCode = 2;
} else {
  main(productDir).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
