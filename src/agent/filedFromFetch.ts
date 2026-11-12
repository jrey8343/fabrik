// The Design job's fetch of the pull request its issue was filed from (#660):
// when the agent-inputs step read an open agent pull request from the issue's
// `From PR` line (readFiledFrom in src/agent/inputs.ts), its head is fetched
// into the job's checkout of the Product repo before the agent starts, with
// the history to compare it with the default branch, so the turn can read the
// branch it may settle a Roll-in onto. The job's read-only token rides in the
// git process's environment alone: nothing of it is written to the checkout,
// and the agent still holds no GitHub credential (ADR-0002).
//
// Run as the Design job's step, from the job's workspace, after the
// agent-inputs step and before any secret loads:
//   node kit/src/agent/filedFromFetch.ts product
// Env:
//   GH_TOKEN                the job's read-only token
//   FABRIK_FILED_FROM_FILE  the pull request the inputs step read (FILED_FROM_FILE)
//   FABRIK_OUT_DIR          where a fetch that fails leaves its failure report, for
//                           the job's "Pass the failure report" step
// and the runner's own GITHUB_REPOSITORY and GITHUB_SERVER_URL.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Remote } from "../github/branch.ts";
import type { FailureReport } from "../loop/types.ts";
import { FULL_SHA } from "../skills/lock.ts";
import { AGENT_FAILURE_FILE } from "./failure.ts";
import { type FiledFrom, filedFromOf } from "./inputs.ts";

const run = promisify(execFile);

/**
 * Where the head of the pull request an issue was filed from is fetched to.
 * It is outside `refs/heads/` and `refs/remotes/`, so no branch of the Product
 * repo can collide with it. The fetch and the turn's prompt both spell it here.
 */
export function filedFromRef(pullRequest: number): string {
  return `refs/fabrik/filed-from/${pullRequest}`;
}

/** A pull request an issue was filed from, as the inputs step read it. */
export type FiledFromPullRequest = Extract<FiledFrom, { kind: "pull-request" }>;

/**
 * Whether the head of the pull request an issue was filed from is fetched for
 * the turn: only an open agent pull request's, the one a Roll-in may be
 * settled onto. A merged one's work is on the default branch already, nothing
 * will merge a closed one's branch, and a Plain pull request takes no Roll-in.
 */
export function headIsFetched(filedFrom: FiledFrom): filedFrom is FiledFromPullRequest {
  return filedFrom.kind === "pull-request" && filedFrom.state === "open" && filedFrom.isAgent;
}

/**
 * The head of the pull request an issue was filed from couldn't be fetched.
 * Its message names the pull request, the commit and the ref, and gives what
 * the fetch answered, as a failed read's report names its request and GitHub's
 * answer.
 */
export class UnfetchedHeadError extends Error {
  override name = "UnfetchedHeadError";
}

/** How much of what a failed fetch printed its error carries. */
const ANSWER_LIMIT = 500;

/**
 * Fetches the head of the pull request `filedFrom` names into `checkout`,
 * under filedFromRef, with the full history of it and of the checked-out
 * commit, so their merge base is there. Gives the ref it left, or null when
 * there is no head to fetch (headIsFetched), which touches nothing. The
 * checkout's working tree, its HEAD and its configuration are left as they
 * were. The head is fetched by the commit the inputs step read, so the commit
 * under the ref is the one the turn's prompt names, wherever the branch has
 * moved since. A fetch that fails throws an UnfetchedHeadError.
 */
export async function fetchFiledFrom(checkout: string, remote: Remote, filedFrom: FiledFrom): Promise<string | null> {
  if (!headIsFetched(filedFrom)) return null;
  const ref = filedFromRef(filedFrom.number);
  // Never a name: a branch's would put that branch under the ref, and an option's would be read as one.
  if (!FULL_SHA.test(filedFrom.headSha)) {
    throw new UnfetchedHeadError(`fetching the head of #${filedFrom.number} to \`${ref}\`: the inputs name no commit for it`);
  }
  const url = `${remote.serverUrl}/${remote.repo.owner}/${remote.repo.name}.git`;
  // The token as the push job's git carries it (emptyRepository in src/github/branch.ts): an env-only
  // config entry for this server alone, so it never lands on disk or in argv. Hooks are off, since
  // a hook of the checkout would run with that environment.
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `http.${remote.serverUrl}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${remote.token}`).toString("base64")}`,
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: "/dev/null",
  };
  const git = async (...args: string[]) => (await run("git", args, { cwd: checkout, env })).stdout.trim();
  try {
    const started = await git("rev-parse", "HEAD");
    await git("fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--unshallow", url, started, `+${filedFrom.headSha}:${ref}`);
  } catch (error) {
    throw new UnfetchedHeadError(`fetching the head of #${filedFrom.number} (\`${filedFrom.headSha}\`) to \`${ref}\`: ${answerOf(error)}`, { cause: error });
  }
  return ref;
}

/** What a failed git command printed, on one line, or else how it failed. */
function answerOf(error: unknown): string {
  const printed = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
  const said = printed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("; ");
  const answer = said !== "" ? said : error instanceof Error ? error.message : String(error);
  return answer.length > ANSWER_LIMIT ? `${answer.slice(0, ANSWER_LIMIT)}…` : answer;
}

/**
 * What a fetch that failed leaves for the push job, or null for any other
 * error, which the push job reads as a crash: a failed read of the turn's
 * inputs, naming what could not be fetched, so the Kit's notice says so. Not
 * `refused`: the Operator's reply runs the turn again, on inputs read afresh.
 */
function unfetchedHeadReportFor(error: unknown): FailureReport | null {
  return error instanceof UnfetchedHeadError ? { failure: "unread-inputs", detail: error.message } : null;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/** The step: fetches for the pull request the inputs step wrote, and gives what it did, as one line. */
async function main(checkout: string): Promise<string> {
  const [owner, name] = required("GITHUB_REPOSITORY").split("/");
  if (owner === undefined || name === undefined) throw new Error("GITHUB_REPOSITORY is not owner/name");
  const remote = { serverUrl: process.env["GITHUB_SERVER_URL"] ?? "https://github.com", repo: { owner, name }, token: required("GH_TOKEN") };
  const filedFrom = filedFromOf(JSON.parse(await readFile(required("FABRIK_FILED_FROM_FILE"), "utf8")));
  if (filedFrom.kind === "none") return "The issue was filed from no pull request, so there is no head to fetch.";
  const ref = await fetchFiledFrom(checkout, remote, filedFrom);
  return ref === null
    ? `#${filedFrom.number} is not an open agent pull request, so its head is not fetched.`
    : `Fetched the head of #${filedFrom.number} (${filedFrom.headSha}) to ${ref}.`;
}

if (import.meta.main) {
  const checkout = process.argv[2];
  if (checkout === undefined) {
    console.error("Usage: node src/agent/filedFromFetch.ts <Product checkout>");
    process.exitCode = 2;
  } else {
    main(checkout).then(
      (did) => console.log(did),
      async (error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
        const report = unfetchedHeadReportFor(error);
        const failureDir = process.env["FABRIK_OUT_DIR"] ?? "";
        if (report === null || failureDir === "") return;
        await mkdir(failureDir, { recursive: true });
        await writeFile(join(failureDir, AGENT_FAILURE_FILE), JSON.stringify(report));
      },
    );
  }
}
