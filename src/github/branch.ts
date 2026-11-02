// The push job's git work for an Implement run: rebuilds the agent branch from
// the bundle the agent job passed out, in an empty repository, reads the paths
// it changes for the trust-root guard, and pushes it as the Fabrik App. It
// never checks out a working tree or runs anything from the Product repo: a
// fresh `git init` has no hooks, and a bundle carries only objects and refs.
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BuiltBranch } from "../agent/result.ts";
import { parseNameStatus } from "../guard/changes.ts";
import type { BranchChanges } from "../loop/types.ts";
import type { Repo } from "./adapter.ts";

const run = promisify(execFile);

export interface AgentBranchGit {
  readonly changes: BranchChanges;
  /** Pushes the rebuilt branch to the Product repo, replacing any branch of that name. */
  push(branch: string): Promise<void>;
}

interface Remote {
  readonly serverUrl: string;
  readonly repo: Repo;
  readonly token: string;
}

/**
 * Rebuilds `branch` from `bundlePath` and reads what it changes. A branch with
 * no commits has no bundle and changes nothing.
 */
export async function rebuildAgentBranch(
  branch: BuiltBranch,
  bundlePath: string,
  remote: Remote,
): Promise<AgentBranchGit> {
  const dir = await mkdtemp(join(tmpdir(), "fabrik-branch-"));
  const url = `${remote.serverUrl}/${remote.repo.owner}/${remote.repo.name}.git`;
  // The token goes in an env-only config entry, so it never lands on disk or in argv.
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `http.${remote.serverUrl}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${remote.token}`).toString("base64")}`,
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: "/dev/null",
  };
  const git = async (...args: string[]): Promise<string> =>
    (await run("git", args, { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 })).stdout;

  await git("init", "--quiet", "--template=");
  const ref = `refs/heads/${branch.name}`;
  if (branch.head === null) {
    return {
      changes: { net: [], commits: [] },
      push: () => Promise.reject(new Error(`${branch.name} has no commits to push`)),
    };
  }

  // A first run's bundle needs only its base commit, which the remote already has. A
  // retry's may also need older commits: a Request-changes run can merge main into
  // the branch to resolve a conflict, so it takes the base's history too.
  const onItsOwnBranch = branch.base.ref === branch.name;
  await git("fetch", "--quiet", ...(onItsOwnBranch ? [] : ["--depth=1"]), url, branch.base.sha);
  await git("bundle", "verify", "--quiet", bundlePath);
  await git("fetch", "--quiet", bundlePath, `${ref}:${ref}`);
  const tip = (await git("rev-parse", "--verify", `${ref}^{commit}`)).trim();
  if (tip !== branch.head) throw new Error(`The bundle's ${branch.name} is at ${tip}, not ${branch.head}`);
  await git("merge-base", "--is-ancestor", branch.base.sha, tip).catch(() => {
    throw new Error(`${branch.name} doesn't start from ${branch.base.ref} at ${branch.base.sha}`);
  });

  const range = `${branch.base.sha}..${tip}`;
  const net = parseNameStatus(await git("diff", "--name-status", "-z", "-M", "--no-ext-diff", branch.base.sha, tip));
  const commits = parseNameStatus(
    await git("log", "--format=", "--name-status", "-z", "-M", "--diff-merges=first-parent", "--no-ext-diff", range),
  );
  return {
    changes: { net, commits },
    async push(name) {
      if (name !== branch.name) throw new Error(`Asked to push ${name}, but the bundle holds ${branch.name}`);
      // A retry builds on the branch itself, so it only fast-forwards it: a branch
      // that moved meanwhile refuses the push. A fresh run from main is forced,
      // replacing whatever an earlier run left on the agent branch.
      await git("push", "--quiet", ...(onItsOwnBranch ? [] : ["--force"]), url, `${ref}:${ref}`);
    },
  };
}
