// A later Review's read of the pull request's own change since the head the
// Reviewer last judged (#748), against real repositories on disk, as the
// change fingerprint's read is tested (changeRead.test.ts): a bare "GitHub"
// remote, served over file://, holding an agent PR's branch and a default
// branch that moves on under it.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readChangeFingerprint } from "./changeRead.ts";
import { type ChangeSince, readChangeSince } from "./changeSince.ts";

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
let work: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, env })).stdout.trim();
}

async function commit(files: Record<string, string>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  await git(work, "add", "-A");
  await git(work, "commit", "--quiet", "--allow-empty", "-m", message);
  return git(work, "rev-parse", "HEAD");
}

const REMOTE = () => ({ serverUrl: `file://${root}`, repo: { owner: "acme", name: "shop" }, token: "unused" });

/** Twenty numbered lines, with these ones replaced. */
const lines = (replaced: Readonly<Record<number, string>> = {}) =>
  Array.from({ length: 20 }, (_, at) => `${replaced[at + 1] ?? `line ${at + 1}`}\n`).join("");

/** The head the Reviewer last judged: the PR's first push, cut from main before main moved on. */
let judged: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fabrik-change-since-test-"));
  remote = join(root, "acme", "shop.git");
  await mkdir(remote, { recursive: true });
  await git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  await git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");

  work = join(root, "work");
  await git(root, "clone", "--quiet", remote, work);
  await git(work, "checkout", "--quiet", "-b", "main");
  await commit({ "src/cart.ts": lines(), "src/hours.ts": lines(), "src/shared.ts": lines() }, "Start");
  await git(work, "push", "--quiet", "origin", "main");

  await git(work, "checkout", "--quiet", "-b", BRANCH);
  judged = await commit({ "src/cart.ts": lines({ 18: "the PR's line" }), "src/hours.ts": lines({ 4: "the PR's hours" }) }, "The PR's change");
  await git(work, "push", "--quiet", "origin", BRANCH);

  // Main moves on: in a file the PR never touched, and above the PR's own line in one it did.
  await git(work, "checkout", "--quiet", "main");
  await commit({ "src/shared.ts": lines({ 5: "main's line" }), "src/cart.ts": lines({ 2: "main's line" }) }, "Main moves on");
  await git(work, "push", "--quiet", "origin", "main");
  await git(work, "checkout", "--quiet", BRANCH);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const lastJudged = async () => ({ headSha: judged, change: await readChangeFingerprint(judged, REMOTE()) });

/** The paths a read change names. */
const pathsOf = (change: ChangeSince) => (change.kind === "read" ? change.files.map(({ path }) => path) : change.files);

/** The difference a read change gives for one file. */
const diffOf = (change: ChangeSince, path: string) => (change.kind === "read" ? (change.files.find((file) => file.path === path)?.diff ?? "") : "");

describe("A later Review's change since the last judged head", () => {
  it("is the difference between the PR's own diff then and now, with what main brought in by a rebase left out", async () => {
    await git(work, "rebase", "--quiet", "main");
    const head = await commit({ "src/cart.ts": lines({ 2: "main's line", 18: "the PR's line, fixed" }) }, "Fix the line");
    await git(work, "push", "--quiet", "--force", "origin", BRANCH);

    const change = await readChangeSince(await lastJudged(), head, REMOTE());

    expect(change.kind).toBe("read");
    expect(pathsOf(change)).toEqual(["src/cart.ts"]);
    const diff = diffOf(change, "src/cart.ts");
    expect(diff).toContain("\n-+the PR's line\n");
    expect(diff).toContain("\n++the PR's line, fixed\n");
    expect(diff).not.toContain("main's line");
  });

  it("leaves out what main brought in by a merge, and takes in the Operator's push and a head red checks stopped before Review", async () => {
    await git(work, "merge", "--quiet", "--no-edit", "main");
    // A Retry's push whose Required checks went red, so no Reviewer judged it, then the Operator's own push.
    await commit({ "src/hours.ts": lines({ 4: "the PR's hours, broken" }) }, "A Retry's push the checks stopped");
    const head = await commit({ "src/hours.ts": lines({ 4: "the PR's hours, mended" }), "docs/hours.md": "Open nine to five.\n" }, "The Operator's push");
    await git(work, "push", "--quiet", "origin", BRANCH);

    const change = await readChangeSince(await lastJudged(), head, REMOTE());

    expect(pathsOf(change)).toEqual(["docs/hours.md", "src/hours.ts"]);
    expect(diffOf(change, "src/hours.ts")).toContain("\n-+the PR's hours\n");
    expect(diffOf(change, "src/hours.ts")).toContain("\n++the PR's hours, mended\n");
    expect(diffOf(change, "docs/hours.md")).toContain("++Open nine to five.");
    expect(JSON.stringify(change)).not.toContain("main's line");
  });

  it("is of nothing when the PR's own change is the same, as after a clean rebase onto main", async () => {
    await git(work, "rebase", "--quiet", "main");
    const head = await git(work, "rev-parse", "HEAD");
    await git(work, "push", "--quiet", "--force", "origin", BRANCH);

    expect(await readChangeSince(await lastJudged(), head, REMOTE())).toEqual({ kind: "read", files: [] });
  });

  it("names the own file a push stopped changing as changed, its own change gone", async () => {
    const head = await commit({ "src/hours.ts": lines() }, "Undo the hours");
    await git(work, "push", "--quiet", "origin", BRANCH);

    const change = await readChangeSince(await lastJudged(), head, REMOTE());

    expect(pathsOf(change)).toEqual(["src/hours.ts"]);
    expect(diffOf(change, "src/hours.ts")).toContain("\n--line 4\n");
    expect(diffOf(change, "src/hours.ts")).toContain("\n-+the PR's hours\n");
  });

  describe("when the last judged head can't be fetched, as after a rebase dropped it", () => {
    /** The branch rebased onto main with a fix, force-pushed, and the old head gone from the remote. */
    async function rebasedAndDropped(): Promise<string> {
      await git(work, "rebase", "--quiet", "main");
      const head = await commit({ "src/cart.ts": lines({ 2: "main's line", 18: "the PR's line, fixed" }), "src/new.ts": "new\n" }, "Fix the line");
      await git(work, "push", "--quiet", "--force", "origin", BRANCH);
      await git(remote, "reflog", "expire", "--expire=now", "--all");
      await git(remote, "gc", "--quiet", "--prune=now");
      return head;
    }

    it("names the PR's own files whose hashes differ from the fingerprint the last judged head's Verdict recorded", async () => {
      const since = await lastJudged();
      const head = await rebasedAndDropped();

      expect(await readChangeSince(since, head, REMOTE())).toEqual({ kind: "unread", files: ["src/cart.ts", "src/new.ts"] });
    });

    it("names none when that fingerprint names no files, as past its file limit", async () => {
      const since = await lastJudged();
      const head = await rebasedAndDropped();

      expect(await readChangeSince({ ...since, change: { ...since.change, files: null } }, head, REMOTE())).toEqual({ kind: "unread", files: null });
    });
  });

  it("cannot be read at a current head the remote doesn't have", async () => {
    await expect(readChangeSince(await lastJudged(), "f".repeat(40), REMOTE())).rejects.toThrow();
  });
});
