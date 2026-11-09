// The push job's git work, against real repositories on disk: a bare "GitHub"
// remote, served over file://, and the Implementer's clone.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkTrustRoot } from "../guard/trust-root.ts";
import { rebaseBranchOntoMain, rebuildAgentBranch } from "./branch.ts";

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

const REMOTE = () => ({ serverUrl: `file://${root}`, repo: { owner: "acme", name: "shop" }, token: "unused" });

/**
 * Rebuilds the clone's agent branch in the push job's way, from a bundle of
 * what it made on top of `baseSha`; `mergeMain` is the main head a
 * Request-changes run was told to merge in (#341).
 */
/** A run on its own branch: a Request-changes run whenever it names a main to merge, unless told otherwise. */
async function rebuild(baseSha: string, mergeMain: string | null = null, started: string | null = null, requestChanges = mergeMain !== null) {
  const head = await git(clone, "rev-parse", "HEAD");
  const bundle = join(root, "agent-branch.bundle");
  await git(clone, "bundle", "create", "--quiet", bundle, `refs/heads/${BRANCH}`, `^${baseSha}`);
  return rebuildAgentBranch({ name: BRANCH, base: { ref: BRANCH, sha: baseSha }, head }, bundle, REMOTE(), { requestChanges, mergeMain, started });
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

describe("A Request-changes run told to merge main in, because its PR conflicted with it (#341)", () => {
  /** Main changes the file the PR changed, so the PR conflicts with it; the clone sees the new main. */
  async function mainConflicts(files: Record<string, string> = {}): Promise<string> {
    const seed = join(root, "seed");
    const main = await commit(seed, { "src/shared.ts": "shared from main\n", ...files }, "Main changes shared");
    await git(seed, "push", "--quiet", "origin", "main");
    await git(clone, "fetch", "--quiet", "origin");
    return main;
  }

  /** The run merges main in, resolving the conflict in src/shared.ts by hand. */
  async function mergesMain(): Promise<void> {
    await git(clone, "merge", "--quiet", "--no-edit", "origin/main").catch(() => undefined);
    await writeFile(join(clone, "src/shared.ts"), "shared from both\n");
    await git(clone, "commit", "--quiet", "-am", "Merge main, resolving the conflict");
  }

  it("that merged it in resolved the conflict", async () => {
    const main = await mainConflicts();
    await mergesMain();
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "The requested change");

    const branch = await rebuild(prHead, main, main);

    expect(branch.changes.mainMerge).toEqual({ main, resolved: true });
  });

  it("that merged it in resolved the conflict even once main moves on before its push", async () => {
    const main = await mainConflicts();
    await mergesMain();
    const seed = join(root, "seed");
    await commit(seed, { "src/shared.ts": "shared from main, again\n" }, "Main moves on again");
    await git(seed, "push", "--quiet", "origin", "main");

    const branch = await rebuild(prHead, main, main);

    expect(branch.changes.mainMerge).toEqual({ main, resolved: true });
  });

  it("that cleared the conflict another way, as the review asked, resolved it", async () => {
    const main = await mainConflicts();
    await commit(clone, { "src/shared.ts": "shared v1\n" }, "Drop the PR's change to shared, as asked");

    const branch = await rebuild(prHead, main, main);

    expect(branch.changes.mainMerge).toEqual({ main, resolved: true });
  });

  it("that left the conflict in place didn't resolve it", async () => {
    const main = await mainConflicts();
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "The requested change, without main");

    const branch = await rebuild(prHead, main, main);

    expect(branch.changes.mainMerge).toEqual({ main, resolved: false });
  });

  it("that committed nothing didn't resolve it", async () => {
    const main = await mainConflicts();

    const branch = await rebuildAgentBranch({ name: BRANCH, base: { ref: BRANCH, sha: prHead }, head: null }, join(root, "none.bundle"), REMOTE(), {
      requestChanges: true,
      mergeMain: main,
      started: main,
    });

    expect(branch.changes.mainMerge).toEqual({ main, resolved: false });
    expect(branch.head).toBeNull();
  });

  it("that committed nothing is judged against the main it was told to merge when main moved on after the Kit job read it", async () => {
    // The Kit job read main before it moved, and the PR didn't conflict then; the run was told to merge main as it is now.
    const started = await git(remote, "rev-parse", "refs/heads/main");
    const main = await mainConflicts();

    const branch = await rebuildAgentBranch({ name: BRANCH, base: { ref: BRANCH, sha: prHead }, head: null }, join(root, "none.bundle"), REMOTE(), {
      requestChanges: true,
      mergeMain: main,
      started,
    });

    expect(branch.changes.mainMerge).toEqual({ main, resolved: false });
  });

  it("is judged against main as the run started, even when its result names no main to merge, if its PR conflicted with it", async () => {
    const main = await mainConflicts();
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "The requested change, without main");

    const branch = await rebuild(prHead, null, main, true);

    expect(branch.changes.mainMerge).toEqual({ main, resolved: false });
  });

  it("is judged on the PR's head as the push job reads it, never on the head the run's result says it started on", async () => {
    const main = await mainConflicts();
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "The requested change, without main");

    // The result names the fork point on main as the head it started on, which merges cleanly with main.
    const fork = await git(clone, "merge-base", prHead, main);
    const branch = await rebuild(fork, null, main, true);

    expect(branch.changes.mainMerge).toEqual({ main, resolved: false });
  });

  it("is judged against main as it is now when its result names none, if main moved after the Kit job read it and the PR conflicts with that", async () => {
    const started = await git(remote, "rev-parse", "refs/heads/main");
    const main = await mainConflicts();
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "The requested change, without main");

    const branch = await rebuild(prHead, null, started, true);

    expect(branch.changes.mainMerge).toEqual({ main, resolved: false });
  });

  it("that committed nothing is still judged when its result names no main, if its PR conflicted with main as it started", async () => {
    const main = await mainConflicts();

    const branch = await rebuildAgentBranch({ name: BRANCH, base: { ref: BRANCH, sha: prHead }, head: null }, join(root, "none.bundle"), REMOTE(), {
      requestChanges: true,
      mergeMain: null,
      started: main,
    });

    expect(branch.changes.mainMerge).toEqual({ main, resolved: false });
  });

  it("whose PR shares no history with main as it started, after main was rewritten, is handed over rather than failing the push job", async () => {
    const seed = join(root, "seed");
    await git(seed, "checkout", "--quiet", "--orphan", "rewritten");
    const rewritten = await commit(seed, { "src/shared.ts": "rewritten\n" }, "Main, rewritten");
    await git(seed, "push", "--quiet", "origin", "rewritten");
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "The requested change");

    const branch = await rebuild(prHead, null, rewritten, true);

    expect(branch.changes.mainMerge).toEqual({ main: rewritten, resolved: false });
  });

  /**
   * Main is force-pushed to a new root, which shares no history with the PR, carrying its own workflow; the run
   * merges it in, taking main's side wherever the two differ, then `edit`s the merge before committing it.
   */
  async function mergesRewrittenMain(edit: (clone: string) => Promise<void> = async () => {}): Promise<string> {
    const seed = join(root, "seed");
    await git(seed, "checkout", "--quiet", "--orphan", "rewritten");
    await writeFile(join(seed, "AGENTS.md"), "rules\n");
    await writeFile(join(seed, ".github/workflows/ci.yml"), "ci, rewritten\n");
    const rewritten = await commit(seed, { "src/shared.ts": "rewritten\n" }, "Main, rewritten");
    await git(seed, "push", "--quiet", "--force", "origin", "rewritten:main");
    await git(clone, "fetch", "--quiet", "origin");
    await git(clone, "merge", "--quiet", "--no-commit", "--allow-unrelated-histories", "-X", "theirs", "origin/main");
    await edit(clone);
    await git(clone, "add", "-A");
    await git(clone, "commit", "--quiet", "--no-edit");
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "The requested change");
    return rewritten;
  }

  it("that merged a main whose history was rewritten is judged, never failing the push job, and counts every path unlike main as its own", async () => {
    const rewritten = await mergesRewrittenMain();

    const branch = await rebuild(prHead, rewritten, rewritten);

    expect(branch.changes.mainMerge).toEqual({ main: rewritten, resolved: true });
    expect(paths(branch.changes.net)).toContain("src/feature.ts");
    // The workflow it took from main, unchanged, isn't the run's own change (#390).
    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "allow" });
  });

  it("that merged a main whose history was rewritten still counts as its own a trust-root file it edited to match neither side", async () => {
    const rewritten = await mergesRewrittenMain((cwd) => writeFile(join(cwd, ".github/workflows/ci.yml"), "ci, weakened\n"));

    const branch = await rebuild(prHead, rewritten, rewritten);

    expect(paths(branch.changes.commits)).toContain(".github/workflows/ci.yml");
    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "refuse", paths: [".github/workflows/ci.yml"] });
  });

  it("whose result names a main that's neither main as it started nor as it is now is judged against main as it is now", async () => {
    const told = await mainConflicts();
    await mergesMain();
    const seed = join(root, "seed");
    const between = await commit(seed, { "src/shared.ts": "shared from main, again\n" }, "Main moves on");
    await git(seed, "push", "--quiet", "origin", "main");
    const now = await commit(seed, { "src/shared.ts": "shared from main, a third time\n" }, "Main moves on again");
    await git(seed, "push", "--quiet", "origin", "main");

    const branch = await rebuild(prHead, between, told);

    expect(branch.changes.mainMerge).toEqual({ main: now, resolved: false });
  });

  it("is the only run judged against a main head: any other has no mainMerge", async () => {
    await mainConflicts();
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "Fix");

    const branch = await rebuild(prHead);

    expect(branch.changes.mainMerge).toBeUndefined();
  });

  it("doesn't count as its own a trust-root file git merged cleanly, though the Operator had changed it on the PR", async () => {
    const seed = join(root, "seed");
    await commit(seed, { "AGENTS.md": "a\nb\nc\nd\ne\n" }, "Main's rules");
    await git(seed, "push", "--quiet", "origin", "main");
    // The Operator brought main in on the PR and changed the rules' first line.
    const operator = join(root, "operator");
    await git(root, "clone", "--quiet", "--branch", BRANCH, remote, operator);
    await git(operator, "merge", "--quiet", "--no-edit", "origin/main");
    const head = await commit(operator, { "AGENTS.md": "A\nb\nc\nd\ne\n" }, "The Operator's rule");
    await git(operator, "push", "--quiet", "origin", BRANCH);
    // Main then changes the rules' last line, and the file the PR changed.
    const main = await mainConflicts({ "AGENTS.md": "a\nb\nc\nd\nE\n" });
    await git(clone, "checkout", "--quiet", "-B", BRANCH, `origin/${BRANCH}`);
    await mergesMain();

    const branch = await rebuild(head, main, main);

    expect(paths(branch.changes.net)).toEqual(["src/shared.ts"]);
    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "allow" });
    expect(branch.changes.mainMerge).toEqual({ main, resolved: true });
  });

  it("still counts as its own a conflict it resolved inside a trust-root file", async () => {
    const seed = join(root, "seed");
    await commit(seed, { "AGENTS.md": "a\n" }, "Main's rules");
    await git(seed, "push", "--quiet", "origin", "main");
    const operator = join(root, "operator");
    await git(root, "clone", "--quiet", "--branch", BRANCH, remote, operator);
    await git(operator, "merge", "--quiet", "--no-edit", "origin/main");
    const head = await commit(operator, { "AGENTS.md": "a from the Operator\n" }, "The Operator's rule");
    await git(operator, "push", "--quiet", "origin", BRANCH);
    const main = await mainConflicts({ "AGENTS.md": "a from main\n" });
    await git(clone, "checkout", "--quiet", "-B", BRANCH, `origin/${BRANCH}`);
    await git(clone, "merge", "--quiet", "--no-edit", "origin/main").catch(() => undefined);
    await writeFile(join(clone, "src/shared.ts"), "shared from both\n");
    await writeFile(join(clone, "AGENTS.md"), "a from both\n");
    await git(clone, "commit", "--quiet", "-am", "Merge main, resolving both");

    const branch = await rebuild(head, main, main);

    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "refuse", paths: ["AGENTS.md"] });
  });

  /** The Operator brought main's rules in on the PR and changed their first line; the PR's head is then that. */
  async function operatorChangesRules(): Promise<string> {
    const seed = join(root, "seed");
    await commit(seed, { "AGENTS.md": "a\nb\nc\nd\ne\n" }, "Main's rules");
    await git(seed, "push", "--quiet", "origin", "main");
    const operator = join(root, "operator");
    await git(root, "clone", "--quiet", "--branch", BRANCH, remote, operator);
    await git(operator, "merge", "--quiet", "--no-edit", "origin/main");
    const head = await commit(operator, { "AGENTS.md": "A\nb\nc\nd\ne\n" }, "The Operator's rule");
    await git(operator, "push", "--quiet", "origin", BRANCH);
    return head;
  }

  it("judges what it built against main's history, never against a commit only the run's result names", async () => {
    // A side branch weakened the rules, then put them back, and main merged it: its first commit was never main's head.
    const seed = join(root, "seed");
    await git(seed, "checkout", "--quiet", "-b", "side");
    const weaker = await commit(seed, { "AGENTS.md": "weaker\n" }, "Weaker rules");
    await commit(seed, { "AGENTS.md": "strict\n" }, "Strict again");
    await git(seed, "checkout", "--quiet", "main");
    await git(seed, "merge", "--quiet", "--no-ff", "--no-edit", "side");
    await git(seed, "push", "--quiet", "origin", "main");
    await git(clone, "fetch", "--quiet", "origin");
    await git(clone, "merge", "--quiet", "--no-edit", weaker);
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "The requested change");

    const branch = await rebuild(prHead, weaker);

    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "refuse", paths: ["AGENTS.md"] });
  });

  it("doesn't count as its own a trust-root file git merged cleanly from a main newer than the one it was told to merge", async () => {
    const head = await operatorChangesRules();
    const told = await mainConflicts();
    const seed = join(root, "seed");
    await commit(seed, { "AGENTS.md": "a\nb\nc\nd\nE\n" }, "Main changes the rules' last line");
    await git(seed, "push", "--quiet", "origin", "main");
    await git(clone, "fetch", "--quiet", "origin");
    await git(clone, "checkout", "--quiet", "-B", BRANCH, `origin/${BRANCH}`);
    await mergesMain();

    const branch = await rebuild(head, told, told);

    expect(paths(branch.changes.net)).toEqual(["src/shared.ts"]);
    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "allow" });
    expect(branch.changes.mainMerge).toEqual({ main: told, resolved: true });
  });

  it("doesn't count as its own a trust-root file git merged cleanly when it merged main unasked, and main moved on before its push", async () => {
    const head = await operatorChangesRules();
    const seed = join(root, "seed");
    const started = await commit(seed, { "AGENTS.md": "a\nb\nc\nd\nE\n" }, "Main changes the rules' last line");
    await git(seed, "push", "--quiet", "origin", "main");
    await git(clone, "fetch", "--quiet", "origin");
    await git(clone, "checkout", "--quiet", "-B", BRANCH, `origin/${BRANCH}`);
    await git(clone, "merge", "--quiet", "--no-edit", "origin/main");
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "The requested change");
    await commit(seed, { "src/other.ts": "other\n" }, "Main moves on");
    await git(seed, "push", "--quiet", "origin", "main");

    const branch = await rebuild(head, null, started);

    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "allow" });
  });

  it("never takes as main's a commit main's head never was, though main's history holds it", async () => {
    // Two commits pushed to main at once: the first weakens the rules, the second puts them back. Main was never at the first.
    const seed = join(root, "seed");
    const weaker = await commit(seed, { "AGENTS.md": "weaker\n" }, "Weaker rules");
    const strict = await commit(seed, { "AGENTS.md": "strict\n" }, "Strict again");
    await git(seed, "push", "--quiet", "origin", "main");
    await git(clone, "fetch", "--quiet", "origin");
    await git(clone, "merge", "--quiet", "--no-edit", weaker);
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "The requested change");

    const branch = await rebuild(prHead, null, strict);

    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "refuse", paths: ["AGENTS.md"] });
  });

  it("judges the conflict against main itself when its result names some other commit", async () => {
    const main = await mainConflicts();
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "The requested change, without main");

    // The main the PR was cut from: one of main's heads, which the branch holds, so it would read as resolved.
    const base = await git(clone, "merge-base", prHead, main);
    const branch = await rebuild(prHead, base, main);

    expect(branch.changes.mainMerge).toEqual({ main, resolved: false });
  });

  it("merges as the PR's own .gitattributes say, so a file both changed that git unions doesn't keep the conflict", async () => {
    const seed = join(root, "seed");
    await commit(seed, { ".gitattributes": "CHANGELOG.md merge=union\n", "CHANGELOG.md": "start\n" }, "A union changelog");
    await git(seed, "push", "--quiet", "origin", "main");
    const operator = join(root, "operator");
    await git(root, "clone", "--quiet", "--branch", BRANCH, remote, operator);
    await git(operator, "merge", "--quiet", "--no-edit", "origin/main");
    const head = await commit(operator, { "CHANGELOG.md": "start\nthe PR\n" }, "The PR's changelog line");
    await git(operator, "push", "--quiet", "origin", BRANCH);
    const main = await mainConflicts({ "CHANGELOG.md": "start\nmain\n" });
    await git(clone, "checkout", "--quiet", "-B", BRANCH, `origin/${BRANCH}`);
    await commit(clone, { "src/shared.ts": "shared v1\n" }, "Drop the PR's change to shared, as asked");

    const branch = await rebuild(head, main, main);

    expect(branch.changes.mainMerge).toEqual({ main, resolved: true });
  });
});

describe("A run whose range holds an octopus merge (#390)", () => {
  /** Two side branches off the PR's head, each changing a file of its own, octopus-merged into the agent branch. */
  async function octopusMerge(edit: (clone: string) => Promise<void> = async () => {}): Promise<void> {
    await git(clone, "checkout", "--quiet", "-b", "left", prHead);
    await commit(clone, { "src/left.ts": "left\n" }, "Left");
    await git(clone, "checkout", "--quiet", "-b", "right", prHead);
    await commit(clone, { "src/right.ts": "right\n" }, "Right");
    await git(clone, "checkout", "--quiet", BRANCH);
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "The requested change");
    await git(clone, "merge", "--quiet", "--no-commit", "left", "right");
    await edit(clone);
    await git(clone, "add", "-A");
    await git(clone, "commit", "--quiet", "--no-edit");
  }

  it("rebuilds an octopus merge that takes each side unchanged, listing each side's own paths", async () => {
    await octopusMerge();

    const branch = await rebuild(prHead);

    expect(paths(branch.changes.commits)).toEqual(["src/feature.ts", "src/left.ts", "src/right.ts"]);
    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "allow" });
  });

  it("counts as its own a trust-root file an octopus merge edits beyond every side", async () => {
    await octopusMerge((cwd) => writeFile(join(cwd, ".github/workflows/ci.yml"), "ci, weakened\n"));

    const branch = await rebuild(prHead);

    expect(paths(branch.changes.commits)).toContain(".github/workflows/ci.yml");
    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toEqual({ kind: "refuse", paths: [".github/workflows/ci.yml"] });
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

    const branch = await rebuild(prHead);
    expect(branch.head).toBeNull();
    expect(branch.changes.pushedHead).toBeUndefined();
  });

  // The run's push note names it, so a push that fails after the note leaves the run in flight (#420).
  it.each([
    ["only adds commits", false],
    ["was rebased onto a branch that moved", true],
  ])("is the tip a retry's changes name for its push note, when it %s", async (_, moved) => {
    if (moved) await operatorPushes({ "src/other.ts": "the Operator's\n" });
    await commit(clone, { "src/feature.ts": "feature v2\n" }, "Fix");

    const branch = await rebuild(prHead);
    await branch.push(BRANCH);

    expect(branch.changes.pushedHead).toBe(await git(remote, "rev-parse", `refs/heads/${BRANCH}`));
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

  it("reads a branch that moved since the turn started as moved, with nothing to push, rather than rebase onto it or replace it", async () => {
    const earlier = await pushedRound({ "src/pages/book/A.tsx": "variant A\n" });
    await git(clone, "fetch", "--quiet", "origin");
    await git(clone, "checkout", "--quiet", "-B", PROTOTYPE, `origin/${PROTOTYPE}`);
    await commit(clone, { "src/pages/book/C.tsx": "variant C\n" }, "Another variant");
    const other = join(root, "meanwhile");
    await git(root, "clone", "--quiet", "--branch", PROTOTYPE, remote, other);
    const moved = await commit(other, { "src/pages/book/D.tsx": "meanwhile\n" }, "Meanwhile");
    await git(other, "push", "--quiet", "origin", PROTOTYPE);
    const branch = await rebuildPrototype({ ref: PROTOTYPE, sha: earlier });

    expect(branch.changes.moved).toEqual({ from: earlier, to: moved });
    expect(branch.changes.rebase).toBeUndefined();
    expect(branch.head).toBeNull();
    await expect(branch.push(PROTOTYPE)).rejects.toThrow();
    expect(await git(remote, "rev-parse", `refs/heads/${PROTOTYPE}`)).toBe(moved);
  });

  it("reads a branch deleted since the turn started as moved to nowhere, with nothing to push", async () => {
    const earlier = await pushedRound({ "src/pages/book/A.tsx": "variant A\n" });
    await git(clone, "fetch", "--quiet", "origin");
    await git(clone, "checkout", "--quiet", "-B", PROTOTYPE, `origin/${PROTOTYPE}`);
    await commit(clone, { "src/pages/book/C.tsx": "variant C\n" }, "Another variant");
    await git(remote, "update-ref", "-d", `refs/heads/${PROTOTYPE}`);
    const branch = await rebuildPrototype({ ref: PROTOTYPE, sha: earlier });

    expect(branch.changes.moved).toEqual({ from: earlier, to: null });
    expect(branch.head).toBeNull();
    await expect(branch.push(PROTOTYPE)).rejects.toThrow();
  });

  it("reads, on a first round, a prototype branch pushed while the turn worked as moved, with nothing to push", async () => {
    const { main } = await firstRound();
    const meanwhile = await pushedRound({ "src/pages/book/Z.tsx": "meanwhile\n" });
    const branch = await rebuildPrototype({ ref: "main", sha: main });

    expect(branch.changes.moved).toEqual({ from: null, to: meanwhile });
    expect(branch.head).toBeNull();
    await expect(branch.push(PROTOTYPE)).rejects.toThrow();
    expect(await git(remote, "rev-parse", `refs/heads/${PROTOTYPE}`)).toBe(meanwhile);
  });

  it("reads a branch that stayed where the turn started as not moved", async () => {
    const { main } = await firstRound();

    expect((await rebuildPrototype({ ref: "main", sha: main })).changes.moved).toBeUndefined();
  });

  it("refuses, on a first round, to replace a prototype branch pushed after the push job read it, in the moments before its own push", async () => {
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

describe("Rebasing an agent PR's branch onto main, with no agent (#304)", () => {
  const remoteOf = () => ({ serverUrl: `file://${root}`, repo: { owner: "acme", name: "shop" }, token: "unused" });
  const remoteSha = (ref: string) => git(remote, "rev-parse", ref);

  it("replays the PR's commits onto main's head when that's clean, and its push puts the rebased branch on the remote", async () => {
    const main = await remoteSha("main");

    const rebased = await rebaseBranchOntoMain(BRANCH, main, remoteOf());
    expect(rebased.outcome).toBe("rebased");
    await rebased.push();

    const head = await remoteSha(BRANCH);
    expect(head).not.toBe(prHead);
    await git(remote, "merge-base", "--is-ancestor", main, head);
    expect(await git(remote, "show", `${head}:src/feature.ts`)).toBe("feature v1");
    expect(await git(remote, "show", `${head}:src/cart.ts`)).toBe("cart v2");
    // The PR's own commit, replayed: still one commit on top of main, with its message.
    expect(await git(remote, "log", "--format=%s", `${main}..${head}`)).toBe("First run");
  });

  it("pushes nothing when the PR's commits conflict with main", async () => {
    const seed = join(root, "seed");
    await git(seed, "checkout", "--quiet", "main");
    await commit(seed, { "src/shared.ts": "shared from main\n" }, "Main changes the same lines");
    await git(seed, "push", "--quiet", "origin", "main");

    const rebased = await rebaseBranchOntoMain(BRANCH, await remoteSha("main"), remoteOf());

    expect(rebased.outcome).toBe("conflicted");
    await expect(rebased.push()).rejects.toThrow();
    expect(await remoteSha(BRANCH)).toBe(prHead);
  });

  it("finds a branch that already holds main's head up to date", async () => {
    const rebased = await rebaseBranchOntoMain(BRANCH, await git(remote, "rev-parse", `${prHead}~1`), remoteOf());

    expect(rebased.outcome).toBe("up-to-date");
  });

  it("pushes with a lease, so a branch that moved since it was read is never overwritten", async () => {
    const rebased = await rebaseBranchOntoMain(BRANCH, await remoteSha("main"), remoteOf());
    const seed = join(root, "seed");
    await git(seed, "checkout", "--quiet", BRANCH);
    const operatorPush = await commit(seed, { "src/feature.ts": "the Operator's\n" }, "Operator pushes");
    await git(seed, "push", "--quiet", "origin", BRANCH);

    await expect(rebased.push()).rejects.toThrow();
    expect(await remoteSha(BRANCH)).toBe(operatorPush);
  });
});

describe("A conflict-only run that rebases its PR onto main (#304)", () => {
  it("counts a conflict it resolved inside a Trust-root file as its own change, so the guard refuses it", async () => {
    // The Operator's commit on the PR touched a workflow, which main has moved on too.
    const seed = join(root, "seed");
    await git(seed, "checkout", "--quiet", BRANCH);
    const base = await commit(seed, { ".github/workflows/ci.yml": "ci from the Operator\n" }, "Operator tweaks CI");
    await git(seed, "push", "--quiet", "origin", BRANCH);
    await git(clone, "fetch", "--quiet", "origin");
    await git(clone, "checkout", "--quiet", "-B", BRANCH, `origin/${BRANCH}`);

    // The run rebases onto main and resolves the workflow's conflict.
    const noEditor = { ...env, GIT_EDITOR: "true" };
    await run("git", ["rebase", "origin/main"], { cwd: clone, env: noEditor }).catch(() => undefined);
    await writeFile(join(clone, ".github/workflows/ci.yml"), "ci resolved\n");
    await git(clone, "add", "-A");
    await run("git", ["rebase", "--continue"], { cwd: clone, env: noEditor });

    const branch = await rebuild(base);

    expect(branch.changes.updatedFromMain).toBe(true);
    expect(checkTrustRoot([...branch.changes.net, ...branch.changes.commits])).toMatchObject({ kind: "refuse", paths: [".github/workflows/ci.yml"] });
  }, 20_000);
});

describe("The existing tests a run's own commits changed (#463)", () => {
  /** A first run cut from main at its current head, which holds `src/cart.test.ts` and `test/setup.ts`. */
  async function firstRun(build: () => Promise<void>) {
    const other = join(root, "first");
    await git(root, "clone", "--quiet", remote, other);
    await commit(other, { "src/cart.test.ts": "expect(total).toBe(3)\n", "test/setup.ts": "setup\n", "README.md": "readme\n" }, "Tests on main");
    await git(other, "push", "--quiet", "origin", "main");
    const start = await git(other, "rev-parse", "HEAD");
    await git(other, "checkout", "--quiet", "-b", "fabrik/ticket-8");
    clone = other;
    await build();
    const tip = await git(other, "rev-parse", "HEAD");
    const bundle = join(root, "first.bundle");
    await git(other, "bundle", "create", "--quiet", bundle, "refs/heads/fabrik/ticket-8", `^${start}`);
    return rebuildAgentBranch({ name: "fabrik/ticket-8", base: { ref: "main", sha: start }, head: tip }, bundle, REMOTE());
  }

  it("lists a first run's change to a test file main already had, and one it deleted, but not a test it added or a file that isn't a test", async () => {
    const branch = await firstRun(async () => {
      await commit(clone, { "src/cart.test.ts": "expect(total).toBe(4)\n", "src/new.test.ts": "new\n", "README.md": "more\n" }, "Build it");
      await git(clone, "rm", "--quiet", "test/setup.ts");
      await git(clone, "commit", "--quiet", "-m", "Drop setup");
    });

    expect(branch.changes.changedTests).toEqual(["src/cart.test.ts", "test/setup.ts"]);
  });

  it("lists a test a commit changed even when a later commit put it back", async () => {
    const branch = await firstRun(async () => {
      await commit(clone, { "src/cart.test.ts": "expect(total).toBe(4)\n" }, "Loosen");
      await commit(clone, { "src/cart.test.ts": "expect(total).toBe(3)\n", "src/cart.ts": "fixed\n" }, "Put it back");
    });

    expect(branch.changes.changedTests).toEqual(["src/cart.test.ts"]);
  });

  it("lists none for a run that changed no test", async () => {
    const branch = await firstRun(async () => {
      await commit(clone, { "src/cart.ts": "fixed\n" }, "Build it");
    });

    expect(branch.changes.changedTests).toEqual([]);
  });

  it("lists, on a retry, a test the PR's earlier run had added, which was on the head the retry built on", async () => {
    await commit(clone, { "src/feature.test.ts": "expect(feature).toBe(1)\n" }, "First run's test");
    await git(clone, "push", "--quiet", "origin", BRANCH);
    const head = await git(clone, "rev-parse", "HEAD");
    await commit(clone, { "src/feature.test.ts": "expect(feature).toBeDefined()\n", "src/other.test.ts": "new\n" }, "Retry");

    const branch = await rebuild(head);

    expect(branch.changes.changedTests).toEqual(["src/feature.test.ts"]);
  });
});
