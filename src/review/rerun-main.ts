// The Review's Re-run red checks job (#462, ADR-0018): re-runs the failed jobs
// of the workflow runs behind an agent PR's red GitHub Actions checks, once on
// the same head. It holds only `actions: write` on the workflow token, no
// secret, and checks out no Product code. A run already re-run on this head
// isn't re-run again: one round per head. A refusal, from GitHub or the token,
// re-runs nothing and says why, so the Execution flaw lands as it would have.
//   node src/review/rerun-main.ts
// Env: GH_TOKEN (actions: write), GITHUB_REPOSITORY, GITHUB_OUTPUT,
//   FABRIK_RED (the checks job's red output: the checks it can re-run, and the outside ones).
// Writes step outputs:
//   rerun     the checks it re-ran, as a JSON list for the Re-run checks' wait; empty when it re-ran none
//   rerun-at  when it re-ran them, ISO 8601
//   refused   why it re-ran none of them, when it could have; empty otherwise
import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { type RerunnableCheck, whyNotRerun } from "./rerun.ts";

const run = promisify(execFile);

/** How long it waits for GitHub to take a re-run up, so the wait that follows doesn't read the old results as the new. */
const QUEUED_WITHIN_MS = 2 * 60_000;
const POLL_MS = 5_000;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/** `gh api`, its failure's stderr kept. */
async function ghApi(...args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; stderr: string }> {
  try {
    const { stdout } = await run("gh", ["api", ...args], { maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stderr: String((error as { stderr?: unknown }).stderr ?? error) };
  }
}

interface WorkflowRun {
  readonly run_attempt: number;
  readonly status: string;
}

async function workflowRun(repo: string, id: number): Promise<WorkflowRun> {
  const read = await ghApi(`repos/${repo}/actions/runs/${id}`);
  if (!read.ok) throw new Error(`Reading workflow run ${id} failed: ${read.stderr.trim()}`);
  return JSON.parse(read.stdout) as WorkflowRun;
}

async function main(): Promise<void> {
  const repo = required("GITHUB_REPOSITORY");
  const red = JSON.parse(required("FABRIK_RED")) as { rerun: RerunnableCheck[]; outside: string[] };
  const out = async (rerun: readonly RerunnableCheck[], rerunAt: string, refused: string) => {
    await appendFile(required("GITHUB_OUTPUT"), `rerun=${JSON.stringify(rerun)}\nrerun-at=${rerunAt}\nrefused=${refused}\n`);
  };
  const runs = [...new Set(red.rerun.map((check) => check.run))];
  if (runs.length === 0) {
    console.log("None of the red checks is a GitHub Actions check, so there's nothing to re-run");
    return out([], "", "");
  }
  // One round per head: a run past its first attempt has been re-run on this head already, by the Kit or by hand.
  for (const id of runs) {
    if ((await workflowRun(repo, id)).run_attempt > 1) {
      console.log(`Workflow run ${id} has been re-run on this head already, so the Kit re-runs nothing`);
      return out([], "", "they had been re-run on this head already");
    }
  }
  const rerunAt = new Date().toISOString();
  for (const id of runs) {
    const posted = await ghApi("--method", "POST", `repos/${repo}/actions/runs/${id}/rerun-failed-jobs`);
    if (!posted.ok) {
      const why = whyNotRerun(posted.stderr);
      console.log(`Couldn't re-run workflow run ${id}: ${why}`);
      // A run re-run before this one failed is left to finish; the flaw lands as it stands.
      return out([], "", why.replace(/\n/g, " "));
    }
    console.log(`Re-running the failed jobs of workflow run ${id}`);
  }
  const deadline = Date.now() + QUEUED_WITHIN_MS;
  for (const id of runs) {
    while ((await workflowRun(repo, id)).status === "completed" && Date.now() < deadline) await sleep(POLL_MS);
  }
  await out(red.rerun, rerunAt, "");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
