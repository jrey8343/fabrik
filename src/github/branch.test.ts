// The push job's git work, against real repositories on disk: a bare "GitHub"
// remote, served over file://, and the Implementer's clone.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkTrustRoot } from "../guard/trust-root.ts";
import { rebuildAgentBranch } from "./branch.ts";

const run = promisify(execFile);
const BRANCH = "fabrik/ticket-7";
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

let root: string;
let remote: string;
let clone: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, env })).stdout.trim();
}

async function commit(cwd: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), text);
  }
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** Rebuilds the clone's agent branch in the push job's way, from a bundle of what it made on top of `baseSha`. */
async function rebuild(baseSha: string) {
  const head = await git(clone, "rev-parse", "HEAD");
  const bundle = join(root, "agent-branch.bundle");
  await git(clone, "bundle", "create", "--quiet", bundle, `refs/heads/${BRANCH}`, `^${baseSha}`);
  return rebuildAgentBranch({ name: BRANCH, base: { ref: BRANCH, sha: baseSha }, head }, bundle, {
    serverUrl: `file://${root}`,
    repo: { owner: "acme", name: "shop" },
    token: "unused",
  });
}

const paths = (changes: readonly { path: string; from?: string }[]) => [...new Set(changes.map((change) => change.path))].sort();

/** The PR's head: main plus the first run's commit on the agent branch. Main then moves on, workflows included. */
let prHead: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fabrik-branch-test-"));
  remote = join(root, "acme", "shop.git");
  await mkdir(remote, { recursive: true });
  await git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  await git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");

  const seed = join(root, "seed");
  await git(root, "clone", "--quiet", remote, seed);
  await git(seed, "checkout", "--quiet", "-b", "main");
  await commit(seed, { "src/cart.ts": "cart v1\n", "src/shared.ts": "shared v1\n", ".github/workflows/ci.yml": "ci v1\n" }, "Start");
  await git(seed, "push", "--quiet", "origin", "main");
  await git(seed, "checkout", "--quiet", "-b", BRANCH);
  prHead = await commit(seed, { "src/feature.ts": "feature v1\n", "src/shared.ts": "shared from the PR\n" }, "First run");
  await git(seed, "push", "--quiet", "origin", BRANCH);
  await git(seed, "checkout", "--quiet", "main");
  await commit(seed, { ".github/workflows/ci.yml": "ci v2\n", "src/cart.ts": "cart v2\n", "AGENTS.md": "rules\n" }, "Main moves on");
  await git(seed, "push", "--quiet", "origin", "main");

  clone = join(root, "clone");
  await git(root, "clone", "--quiet", remote, clone);
  await git(clone, "checkout", "--quiet", "-B", BRANCH, `origin/${BRANCH}`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("A Request-changes run that brings in main", () => {
  it("merging main judges only the run's own changes, not what main already has", async () => {
    await git(clone, "merge", "--quiet", "--no-edit", "origin/main");
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "Fix");

    const branch = await rebuild(prHead);

    expect(paths(branch.changes.net)).toEqual(["src/feature.ts"]);
    expect(paths(branch.changes.commits)).not.toContain(".github/workflows/ci.yml");
    expect(paths(branch.changes.commits)).not.toContain("AGENTS.md");
    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "allow" });
  });

  it("rebasing onto main judges only the run's own changes, and the push replaces the PR's branch", async () => {
    await git(clone, "rebase", "--quiet", "origin/main");
    const tip = await commit(clone, { "src/feature.ts": "feature v2\n" }, "Fix");

    const branch = await rebuild(prHead);
    await branch.push(BRANCH);

    expect(paths(branch.changes.net)).toEqual(["src/feature.ts"]);
    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "allow" });
    expect(await git(remote, "rev-parse", `refs/heads/${BRANCH}`)).toBe(tip);
  });

  it("a rebase with nothing else still counts as a change: it brought the PR up to date with main", async () => {
    await git(clone, "rebase", "--quiet", "origin/main");

    const branch = await rebuild(prHead);

    expect(branch.changes.net).toEqual([]);
    expect(branch.changes.updatedFromMain).toBe(true);
  });

  it("a conflict the run resolves counts as its own change", async () => {
    // Main changes the file the PR changed, so merging it conflicts.
    const seed = join(root, "seed");
    await commit(seed, { "src/shared.ts": "shared from main\n" }, "Main changes shared");
    await git(seed, "push", "--quiet", "origin", "main");
    await git(clone, "fetch", "--quiet", "origin");
    await git(clone, "merge", "--quiet", "--no-edit", "origin/main").catch(() => undefined);
    await writeFile(join(clone, "src/shared.ts"), "shared from both\n");
    await git(clone, "commit", "--quiet", "-am", "Merge main, resolving the conflict");

    const branch = await rebuild(prHead);

    expect(paths([...branch.changes.net, ...branch.changes.commits])).toContain("src/shared.ts");
    expect(paths(branch.changes.net)).not.toContain("src/cart.ts");
  });

  it("still refuses a trust-root change the run makes itself, alongside the rebase", async () => {
    await git(clone, "rebase", "--quiet", "origin/main");
    await commit(clone, { "AGENTS.md": "weaker rules\n" }, "Sneak");

    const branch = await rebuild(prHead);

    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "refuse", paths: ["AGENTS.md"] });
  });

  it("refuses to push over a PR branch that moved since the run started", async () => {
    await git(clone, "rebase", "--quiet", "origin/main");
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "Fix");
    const branch = await rebuild(prHead);
    // Someone else pushes to the PR's branch meanwhile.
    const other = join(root, "other");
    await git(root, "clone", "--quiet", "--branch", BRANCH, remote, other);
    const moved = await commit(other, { "src/other.ts": "other\n" }, "Meanwhile");
    await git(other, "push", "--quiet", "origin", BRANCH);

    await expect(branch.push(BRANCH)).rejects.toThrow();
    expect(await git(remote, "rev-parse", `refs/heads/${BRANCH}`)).toBe(moved);
  });
});

describe("A retry that only adds commits", () => {
  it("reads its own commits' changes and fast-forwards the PR's branch", async () => {
    const tip = await commit(clone, { "src/feature.ts": "feature v2\n" }, "Fix");

    const branch = await rebuild(prHead);
    await branch.push(BRANCH);

    expect(paths(branch.changes.net)).toEqual(["src/feature.ts"]);
    expect(branch.changes.updatedFromMain).toBe(false);
    expect(branch.changes.rebase).toBeUndefined();
    expect(await git(remote, "rev-parse", `refs/heads/${BRANCH}`)).toBe(tip);
  });
});

/** The Operator pushes these files to the PR's branch while the run works, as a commit on top of the head it built on. */
async function operatorPushes(files: Record<string, string>): Promise<string> {
  const other = join(root, "operator");
  await git(root, "clone", "--quiet", "--branch", BRANCH, remote, other);
  const moved = await commit(other, files, "The Operator's change");
  await git(other, "push", "--quiet", "origin", BRANCH);
  return moved;
}

describe("A retry whose branch moved while it ran (ADR-0006)", () => {
  it("is rebased onto the new head: its own commits land on top of the Operator's, and only they count as its changes", async () => {
    const moved = await operatorPushes({ "src/other.ts": "the Operator's\n" });
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "Fix one");
    await commit(clone, { "src/cart.ts": "cart fixed\n" }, "Fix two");

    const branch = await rebuild(prHead);
    await branch.push(BRANCH);

    expect(branch.changes.rebase).toEqual({ onto: moved, conflicted: false });
    expect(paths(branch.changes.net)).toEqual(["src/cart.ts", "src/feature.ts"]);
    expect(paths(branch.changes.commits)).toEqual(["src/cart.ts", "src/feature.ts"]);
    const pushed = await git(remote, "rev-parse", `refs/heads/${BRANCH}`);
    expect(await git(remote, "log", "--format=%s", `${moved}..${pushed}`)).toBe("Fix two\nFix one");
    expect(await git(remote, "rev-parse", `${pushed}~2`)).toBe(moved);
    expect(await git(remote, "show", `${pushed}:src/other.ts`)).toBe("the Operator's");
    expect(await git(remote, "show", `${pushed}:src/feature.ts`)).toBe("feature v2");
    expect(await git(remote, "log", "-1", "--format=%an <%ae>", pushed)).toBe("Test <test@example.com>");
  });

  it("that conflicts with the new head has nothing to push, and says so", async () => {
    const moved = await operatorPushes({ "src/feature.ts": "the Operator's feature\n" });
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "Fix");

    const branch = await rebuild(prHead);

    expect(branch.changes.rebase).toEqual({ onto: moved, conflicted: true });
    await expect(branch.push(BRANCH)).rejects.toThrow();
    expect(await git(remote, "rev-parse", `refs/heads/${BRANCH}`)).toBe(moved);
  });

  it("isn't refused for a trust-root file the Operator's commit touched", async () => {
    await operatorPushes({ "AGENTS.md": "the Operator's rules\n" });
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "Fix");

    const branch = await rebuild(prHead);

    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "allow" });
  });

  it("resumed on a head the Operator pushed before it started, isn't refused for their trust-root change either", async () => {
    const operatorHead = await operatorPushes({ "AGENTS.md": "the Operator's rules\n" });
    await git(clone, "fetch", "--quiet", "origin");
    await git(clone, "checkout", "--quiet", "-B", BRANCH, `origin/${BRANCH}`);
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "Fix");

    const branch = await rebuild(operatorHead);

    expect(branch.changes.rebase).toBeUndefined();
    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "allow" });
  });

  it("is still refused for a trust-root file its own commit touches", async () => {
    await operatorPushes({ "src/other.ts": "the Operator's\n" });
    await commit(clone, { ".github/workflows/ci.yml": "weaker ci\n" }, "Sneak");

    const branch = await rebuild(prHead);

    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({
      kind: "refuse",
      paths: [".github/workflows/ci.yml"],
    });
  });

  it("carries a merge of main it made across, judging only its own changes", async () => {
    const moved = await operatorPushes({ "src/other.ts": "the Operator's\n" });
    await git(clone, "merge", "--quiet", "--no-edit", "origin/main");
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "Fix");

    const branch = await rebuild(prHead);
    await branch.push(BRANCH);

    expect(branch.changes.rebase).toEqual({ onto: moved, conflicted: false });
    expect(paths(branch.changes.net)).toEqual(["src/feature.ts"]);
    expect(branch.changes.updatedFromMain).toBe(true);
    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "allow" });
    const pushed = await git(remote, "rev-parse", `refs/heads/${BRANCH}`);
    expect(await git(remote, "show", `${pushed}:AGENTS.md`)).toBe("rules");
    expect(await git(remote, "show", `${pushed}:src/other.ts`)).toBe("the Operator's");
  });

  it("that rewrote the branch's history, by rebasing onto main, counts as a conflict", async () => {
    const moved = await operatorPushes({ "src/other.ts": "the Operator's\n" });
    await git(clone, "rebase", "--quiet", "origin/main");
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "Fix");

    const branch = await rebuild(prHead);

    expect(branch.changes.rebase).toEqual({ onto: moved, conflicted: true });
  });
});

describe("The head a push leaves the agent branch at, which fills in a preview URL's {sha}", () => {
  it("is a first run's own tip", async () => {
    const start = await git(clone, "rev-parse", "HEAD~1");
    const tip = await commit(clone, { "src/feature.ts": "feature v2\n" }, "Build it");
    const bundle = join(root, "first-run.bundle");
    await git(clone, "bundle", "create", "--quiet", bundle, `refs/heads/${BRANCH}`, `^${start}`);

    const branch = await rebuildAgentBranch({ name: BRANCH, base: { ref: "main", sha: start }, head: tip }, bundle, {
      serverUrl: `file://${root}`,
      repo: { owner: "acme", name: "shop" },
      token: "unused",
    });
    await branch.push(BRANCH);

    expect(branch.head).toBe(tip);
    expect(await git(remote, "rev-parse", `refs/heads/${BRANCH}`)).toBe(tip);
  });

  it("is a retry's own tip when it only adds commits", async () => {
    const tip = await commit(clone, { "src/feature.ts": "feature v2\n" }, "Fix");

    const branch = await rebuild(prHead);
    await branch.push(BRANCH);

    expect(branch.head).toBe(tip);
  });

  it("is where a retry's commits were rebased onto a branch that moved, not the tip the run built", async () => {
    await operatorPushes({ "src/other.ts": "the Operator's\n" });
    const built = await commit(clone, { "src/feature.ts": "feature v2\n" }, "Fix");

    const branch = await rebuild(prHead);
    await branch.push(BRANCH);

    expect(branch.head).toBe(await git(remote, "rev-parse", `refs/heads/${BRANCH}`));
    expect(branch.head).not.toBe(built);
  });

  it("is none when a moved branch conflicts, as there is nothing to push", async () => {
    await operatorPushes({ "src/feature.ts": "the Operator's feature\n" });
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "Fix");

    expect((await rebuild(prHead)).head).toBeNull();
  });
});

// A Design session's prototype turn (#155) builds on the issue's prototype branch, which the Kit
// never merges, never opens a PR from, never deletes, and only ever fast-forwards.
describe("A prototype turn's branch", () => {
  const PROTOTYPE = "prototype/7";
  const remoteGit = { serverUrl: "", repo: { owner: "acme", name: "shop" }, token: "unused" };

  /** Rebuilds the clone's prototype branch from a bundle of what the turn made on top of `base`, as the push job does. */
  async function rebuildPrototype(base: { ref: string; sha: string }) {
    const head = await git(clone, "rev-parse", "HEAD");
    const bundle = join(root, "prototype.bundle");
    await git(clone, "bundle", "create", "--quiet", bundle, `refs/heads/${PROTOTYPE}`, `^${base.sha}`);
    return rebuildAgentBranch({ name: PROTOTYPE, base, head }, bundle, { ...remoteGit, serverUrl: `file://${root}` });
  }

  /** A first round's turn: prototype/7 cut from main as it is now, with the variants committed on it. */
  async function firstRound(): Promise<{ main: string; tip: string }> {
    await git(clone, "fetch", "--quiet", "origin");
    const main = await git(clone, "rev-parse", "origin/main");
    await git(clone, "checkout", "--quiet", "-B", PROTOTYPE, main);
    const tip = await commit(clone, { "src/pages/book/A.tsx": "variant A\n", "src/pages/book/B.tsx": "variant B\n" }, "Variants");
    return { main, tip };
  }

  /** Someone pushes prototype/7 as `files` on top of main, as an earlier round's push job would. */
  async function pushedRound(files: Record<string, string>): Promise<string> {
    const other = join(root, "earlier");
    await git(root, "clone", "--quiet", "--branch", "main", remote, other);
    await git(other, "checkout", "--quiet", "-b", PROTOTYPE);
    const head = await commit(other, files, "An earlier round");
    await git(other, "push", "--quiet", "origin", PROTOTYPE);
    return head;
  }

  it("cut from the default branch on a first round, reads every change since the head it started on, and its push creates the branch", async () => {
    const { main, tip } = await firstRound();

    const branch = await rebuildPrototype({ ref: "main", sha: main });
    await branch.push(PROTOTYPE);

    expect(paths(branch.changes.net)).toEqual(["src/pages/book/A.tsx", "src/pages/book/B.tsx"]);
    expect(paths(branch.changes.commits)).toEqual(["src/pages/book/A.tsx", "src/pages/book/B.tsx"]);
    expect(branch.head).toBe(tip);
    expect(await git(remote, "rev-parse", `refs/heads/${PROTOTYPE}`)).toBe(tip);
  });

  it("on a later round, built on the branch an earlier round pushed, reads only its own commits, and its push fast-forwards the branch", async () => {
    const earlier = await pushedRound({ "src/pages/book/A.tsx": "variant A\n" });
    await git(clone, "fetch", "--quiet", "origin");
    await git(clone, "checkout", "--quiet", "-B", PROTOTYPE, `origin/${PROTOTYPE}`);
    const tip = await commit(clone, { "src/pages/book/C.tsx": "variant C\n" }, "Another variant");

    const branch = await rebuildPrototype({ ref: PROTOTYPE, sha: earlier });
    await branch.push(PROTOTYPE);

    expect(paths(branch.changes.net)).toEqual(["src/pages/book/C.tsx"]);
    expect(paths(branch.changes.commits)).toEqual(["src/pages/book/C.tsx"]);
    expect(await git(remote, "rev-parse", `refs/heads/${PROTOTYPE}`)).toBe(tip);
    expect(await git(remote, "rev-parse", `${tip}~1`)).toBe(earlier);
  });

  it("still counts a Trust-root change a later commit of the turn undid", async () => {
    const { main } = await firstRound();
    await commit(clone, { "AGENTS.md": "weaker rules\n" }, "Sneak");
    await git(clone, "rm", "--quiet", "AGENTS.md");
    await git(clone, "commit", "--quiet", "-m", "Undo");

    const branch = await rebuildPrototype({ ref: "main", sha: main });

    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "refuse", paths: ["AGENTS.md"] });
  });

  it("refuses to push over the branch when it moved since the turn started, rather than rebase onto it or replace it", async () => {
    const earlier = await pushedRound({ "src/pages/book/A.tsx": "variant A\n" });
    await git(clone, "fetch", "--quiet", "origin");
    await git(clone, "checkout", "--quiet", "-B", PROTOTYPE, `origin/${PROTOTYPE}`);
    await commit(clone, { "src/pages/book/C.tsx": "variant C\n" }, "Another variant");
    const other = join(root, "meanwhile");
    await git(root, "clone", "--quiet", "--branch", PROTOTYPE, remote, other);
    const moved = await commit(other, { "src/pages/book/D.tsx": "meanwhile\n" }, "Meanwhile");
    await git(other, "push", "--quiet", "origin", PROTOTYPE);
    const branch = await rebuildPrototype({ ref: PROTOTYPE, sha: earlier });

    await expect(branch.push(PROTOTYPE)).rejects.toThrow();
    expect(branch.changes.rebase).toBeUndefined();
    expect(await git(remote, "rev-parse", `refs/heads/${PROTOTYPE}`)).toBe(moved);
  });

  it("refuses, on a first round, to replace a prototype branch that was pushed while the turn worked", async () => {
    const { main } = await firstRound();
    const branch = await rebuildPrototype({ ref: "main", sha: main });
    const meanwhile = await pushedRound({ "src/pages/book/Z.tsx": "meanwhile\n" });

    await expect(branch.push(PROTOTYPE)).rejects.toThrow();
    expect(await git(remote, "rev-parse", `refs/heads/${PROTOTYPE}`)).toBe(meanwhile);
  });

  it("refuses a bundle that doesn't start from the head the turn said it started on", async () => {
    const { main } = await firstRound();
    const head = await git(clone, "rev-parse", "HEAD");
    const bundle = join(root, "prototype.bundle");
    await git(clone, "bundle", "create", "--quiet", bundle, `refs/heads/${PROTOTYPE}`, `^${main}`);

    // The PR's head, which the turn's commits don't start from.
    await expect(
      rebuildAgentBranch({ name: PROTOTYPE, base: { ref: "main", sha: prHead }, head }, bundle, { ...remoteGit, serverUrl: `file://${root}` }),
    ).rejects.toThrow();
  });

  it("pushes no branch but the issue's prototype branch, never the default branch", async () => {
    const { main } = await firstRound();
    const branch = await rebuildPrototype({ ref: "main", sha: main });

    await expect(branch.push("main")).rejects.toThrow(/bundle holds prototype\/7/);
    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(main);
  });
});
