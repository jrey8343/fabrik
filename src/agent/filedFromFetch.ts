// The Design job's fetch of the pull request its issue was filed from (#660):
// when the agent-inputs step read an open agent pull request from the issue's
// `From PR` line (readFiledFrom in src/agent/inputs.ts), its head is fetched
// into the job's checkout of the Product repo before the agent starts, with
// the history to compare it with the default branch, so the turn can read the
// branch it may settle a Roll-in onto. The job's read-only token rides in the
// git process's environment alone: nothing of it is written to the checkout,
// and the agent still holds no GitHub credential (ADR-0002).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Remote } from "../github/branch.ts";
import type { FiledFrom } from "./inputs.ts";

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
 * Fetches the head of the pull request `filedFrom` names into `checkout`,
 * under filedFromRef, with the full history of it and of the checked-out
 * commit, so their merge base is there. Gives the ref it left, or null when
 * there is no head to fetch (headIsFetched), which touches nothing. The
 * checkout's working tree, its HEAD and its configuration are left as they
 * were.
 */
export async function fetchFiledFrom(checkout: string, remote: Remote, filedFrom: FiledFrom): Promise<string | null> {
  if (!headIsFetched(filedFrom)) return null;
  const ref = filedFromRef(filedFrom.number);
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
  const started = await git("rev-parse", "HEAD");
  await git("fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--unshallow", url, started, `+${filedFrom.headSha}:${ref}`);
  return ref;
}
