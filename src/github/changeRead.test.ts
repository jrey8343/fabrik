// The push job's read of a PR's change fingerprint (#643), against real
// repositories on disk: a bare "GitHub" remote, served over file://, holding
// an agent PR's branch and a default branch that has moved on since.
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { type ChangeFingerprint, changeFingerprintOf, changeIn, changeLine } from "../loop/changeFingerprint.ts";
import { GITHUB_COMMENT_LIMIT } from "../loop/roundLine.ts";
import { planFor } from "../loop/rules.ts";
import type { LoopEvent, Plan } from "../loop/types.ts";
import { planWithChange, readChangeFingerprint } from "./changeRead.ts";
import { verdictsIn } from "./threads.ts";

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
let work: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, env })).stdout.trim();
}

async function commit(cwd: string, files: Record<string, string | Buffer>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "--quiet", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

const REMOTE = () => ({ serverUrl: `file://${root}`, repo: { owner: "acme", name: "shop" }, token: "unused" });

/** Twenty numbered lines, with these ones replaced. */
const lines = (replaced: Readonly<Record<number, string>> = {}) =>
  Array.from({ length: 20 }, (_, at) => `${replaced[at + 1] ?? `line ${at + 1}`}\n`).join("");

const binary = (...bytes: number[]) => Buffer.from([0, 1, 2, 0, ...bytes]);

/** The PR's head: one commit on the default branch as it was when the branch was cut. */
let prHead: string;
/** The default branch's head, which has moved on since. */
let mainHead: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fabrik-change-test-"));
  const remote = join(root, "acme", "shop.git");
  await mkdir(remote, { recursive: true });
  await git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  await git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");

  work = join(root, "work");
  await git(root, "clone", "--quiet", remote, work);
  await git(work, "checkout", "--quiet", "-b", "main");
  await commit(
    work,
    {
      "src/cart.ts": lines(),
      "src/cart.test.ts": lines(),
      "src/old.ts": "one\ntwo\n",
      "src/shared.ts": lines(),
      "logo.png": binary(1),
      "icon.png": binary(2),
      "run.sh": "echo run\n",
    },
    "Start",
  );
  await git(work, "push", "--quiet", "origin", "main");

  await git(work, "checkout", "--quiet", "-b", BRANCH);
  await git(work, "mv", "src/old.ts", "src/moved.ts");
  await git(work, "rm", "--quiet", "icon.png");
  await chmod(join(work, "run.sh"), 0o755);
  prHead = await commit(
    work,
    { "src/cart.ts": lines({ 18: "the PR's line" }), "src/cart.test.ts": lines({ 3: "the PR's test" }), "logo.png": binary(9, 9) },
    "The PR's change",
  );
  await git(work, "push", "--quiet", "origin", BRANCH);

  await git(work, "checkout", "--quiet", "main");
  // Main moves on: lines above the PR's in the same file, so its own sit at other line numbers after a rebase.
  mainHead = await commit(
    work,
    { "src/cart.ts": `main's new first line\n${lines({ 2: "main's line" })}`, "src/shared.ts": lines({ 5: "main's line" }), "AGENTS.md": "rules\n" },
    "Main moves on",
  );
  await git(work, "push", "--quiet", "origin", "main");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Reading a pull request's change fingerprint with git", () => {
  it("is of the PR's own change, against its merge base, when that is behind the default branch", async () => {
    const fingerprint = await readChangeFingerprint(prHead, REMOTE());

    // Nothing main changed since, and not the file whose only change is its mode.
    expect(Object.keys(fingerprint.files ?? {})).toEqual(["icon.png", "logo.png", "src/cart.test.ts", "src/cart.ts", "src/moved.ts", "src/old.ts"]);
    expect(fingerprint.all).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint.product).toMatch(/^[0-9a-f]{12}$/);
    expect(mainHead).not.toBe(await git(work, "merge-base", mainHead, prHead));
  });

  it("hashes each file's added and removed lines, and nothing of where they sit", async () => {
    const { files } = await readChangeFingerprint(prHead, REMOTE());

    const asDiff = (path: string, removed: string[], added: string[]) =>
      changeFingerprintOf(
        [`diff --git a/${path} b/${path}`, "index 1..2 100644", `@@ -1,${removed.length} +1,${added.length} @@`, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`), ""].join("\n"),
      ).files?.[path];
    expect(files?.["src/cart.ts"]).toBe(asDiff("src/cart.ts", ["line 18"], ["the PR's line"]));
    expect(files?.["src/cart.test.ts"]).toBe(asDiff("src/cart.test.ts", ["line 3"], ["the PR's test"]));
  });

  it("reads a moved file as its lines removed at the old path and added at the new one", async () => {
    const { files } = await readChangeFingerprint(prHead, REMOTE());

    const asDiff = (path: string, rows: string[]) =>
      changeFingerprintOf([`diff --git a/${path} b/${path}`, "index 1..2 100644", "@@ -1,2 +1,2 @@", ...rows, ""].join("\n")).files?.[path];
    expect(files?.["src/old.ts"]).toBe(asDiff("src/old.ts", ["-one", "-two"]));
    expect(files?.["src/moved.ts"]).toBe(asDiff("src/moved.ts", ["+one", "+two"]));
  });

  it("reads a binary file as the hash of its content at the head, and a deleted one as a fixed word", async () => {
    const { files } = await readChangeFingerprint(prHead, REMOTE());

    expect(files?.["logo.png"]).toBe((await git(work, "rev-parse", `${prHead}:logo.png`)).slice(0, 12));
    expect(files?.["icon.png"]).toBe("deleted");
  });

  it("is equal for the same commits rebased onto the moved default branch, with no conflict", async () => {
    const before = await readChangeFingerprint(prHead, REMOTE());
    await git(work, "checkout", "--quiet", BRANCH);
    await git(work, "rebase", "--quiet", "main");
    const rebased = await git(work, "rev-parse", "HEAD");
    await git(work, "push", "--quiet", "--force", "origin", BRANCH);

    const after = await readChangeFingerprint(rebased, REMOTE());

    expect(rebased).not.toBe(prHead);
    expect(await git(work, "merge-base", "main", rebased)).toBe(mainHead);
    expect(after).toEqual(before);
  });

  it("is equal with main merged in, and moves once the PR's own lines change", async () => {
    const before = await readChangeFingerprint(prHead, REMOTE());
    await git(work, "checkout", "--quiet", BRANCH);
    await git(work, "merge", "--quiet", "--no-edit", "main");
    const merged = await git(work, "rev-parse", "HEAD");
    await git(work, "push", "--quiet", "origin", BRANCH);
    const testOnly = await commit(work, { "src/cart.test.ts": lines({ 3: "the PR's test, fixed" }) }, "Fix the test");
    const product = await commit(work, { "src/cart.ts": `main's new first line\n${lines({ 2: "main's line", 18: "the PR's line, fixed" })}` }, "Fix the code");
    await git(work, "push", "--quiet", "origin", BRANCH);

    const afterMerge = await readChangeFingerprint(merged, REMOTE());
    const afterTest = await readChangeFingerprint(testOnly, REMOTE());
    const afterProduct = await readChangeFingerprint(product, REMOTE());

    expect(afterMerge).toEqual(before);
    expect(afterTest.all).not.toBe(before.all);
    expect(afterTest.product).toBe(before.product);
    expect(afterProduct.product).not.toBe(before.product);
  });

  it("is of nothing for a head the default branch already holds", async () => {
    expect(await readChangeFingerprint(mainHead, REMOTE())).toMatchObject({ files: {} });
  });

  it("cannot be read at a head the remote doesn't have", async () => {
    await expect(readChangeFingerprint("d".repeat(40), REMOTE())).rejects.toThrow();
  });

  it("cannot be read at a head that shares no history with the default branch", async () => {
    await git(work, "checkout", "--quiet", "--orphan", "elsewhere");
    const orphan = await commit(work, { "src/cart.ts": "another history\n" }, "Unrelated");
    await git(work, "push", "--quiet", "origin", "elsewhere");

    await expect(readChangeFingerprint(orphan, REMOTE())).rejects.toThrow(/no merge base/);
  });

  it("cannot be read from a remote that isn't there", async () => {
    await expect(readChangeFingerprint(prHead, { ...REMOTE(), repo: { owner: "acme", name: "gone" } })).rejects.toThrow();
  });
});

describe("The push job's plan, with the change fingerprint on its Verdict", () => {
  const CHANGE: ChangeFingerprint = { v: 1, all: "0123456789ab", product: "ba9876543210", files: { "src/cart.ts": "aaaaaaaaaaaa" } };
  const config = kitConfig();
  const reviewed = (output: string): LoopEvent => ({
    kind: "review-run-finished",
    pullRequest: 50,
    headSha: HEAD_SHA,
    output,
    runUrl: "https://github.com/acme/shop/actions/runs/42/attempts/1",
    repoUrl: "https://github.com/acme/shop",
  });
  /** A read that gives `CHANGE`, or fails with `failure`, and remembers the heads it was asked for. */
  const reader = (failure: Error | null = null) => {
    const heads: string[] = [];
    const read = async (headSha: string) => {
      heads.push(headSha);
      if (failure !== null) throw failure;
      return CHANGE;
    };
    return { heads, read };
  };
  const verdictCommentsOf = (plan: Plan) =>
    (plan.kind === "act" ? plan.actions : []).flatMap((action) => (action.kind === "comment" && verdictsIn([action.body]).length > 0 ? [action.body] : []));

  it("reads the fingerprint at the PR's head once the plan posts a Verdict, and the Verdict carries it", async () => {
    const snapshot = snapshotOfPullRequest(aPullRequest());
    const { heads, read } = reader();

    const { plan, unread } = await planWithChange(snapshot, (given) => planFor(reviewed("verdict: pass"), given, config), read);

    expect(heads).toEqual([HEAD_SHA]);
    expect(verdictCommentsOf(plan).map(changeIn)).toEqual([CHANGE]);
    expect(unread).toBeNull();
    // But for that line, the plan is the one the snapshot gives without it.
    const bare = planFor(reviewed("verdict: pass"), snapshot, config);
    expect(JSON.parse(JSON.stringify(plan).replace(`${JSON.stringify(changeLine(CHANGE)).slice(1, -1)}\\n`, ""))).toEqual(bare);
  });

  it("fetches nothing for a plan that posts no Verdict", async () => {
    const { heads, read } = reader();
    const started = await planWithChange(snapshotOfPullRequest(aPullRequest()), (given) => planFor({ kind: "pull-request-pushed", pullRequest: 50 }, given, config), read);
    const stale = await planWithChange(
      snapshotOfPullRequest(aPullRequest({ headSha: "b".repeat(40) })),
      (given) => planFor(reviewed("verdict: pass"), given, config),
      read,
    );

    expect(heads).toEqual([]);
    expect(started).toMatchObject({ plan: { kind: "act" }, unread: null });
    expect(stale).toMatchObject({ plan: { kind: "nothing" }, unread: null });
  });

  it("still posts the Verdict when the fingerprint can't be read, without the line, and says so", async () => {
    const snapshot = snapshotOfPullRequest(aPullRequest());
    const { read } = reader(new Error("aaaaaaa has no merge base with the default branch"));

    const { plan, unread } = await planWithChange(snapshot, (given) => planFor(reviewed("verdict: pass"), given, config), read);

    expect(plan).toEqual(planFor(reviewed("verdict: pass"), snapshot, config));
    expect(verdictCommentsOf(plan)).toHaveLength(1);
    expect(verdictCommentsOf(plan)[0]).not.toContain("fabrik:change");
    expect(unread).toBe(
      "The Verdict on #50 was posted without a change fingerprint: the fingerprint could not be read at aaaaaaa (aaaaaaa has no merge base with the default branch).",
    );
  });

  it("reads none for a Verdict on a head the PR has moved on from, and says so", async () => {
    const flaw = { verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "b".repeat(40) } as const;
    const snapshot = snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"], openPullRequests: [50] }), {
      pullRequest: aPullRequest({ headSha: "b".repeat(40), ticketLabels: ["ready-for-agent"], verdicts: [flaw] }),
    });
    const changedNothing: LoopEvent = {
      kind: "implement-run-finished",
      issue: 7,
      output: JSON.stringify({ title: "Handle the empty cart", summary: "Nothing to change.", fix: "Nothing." }),
      branch: "fabrik/ticket-7",
      base: "fabrik/ticket-7",
      changes: { net: [], commits: [] },
      fixes: { pullRequest: 50, headSha: HEAD_SHA, runUrl: "https://github.com/acme/shop/actions/runs/42/attempts/1" },
      runUrl: "https://github.com/acme/shop/actions/runs/42/attempts/1",
    };
    const { heads, read } = reader();

    const { plan, unread } = await planWithChange(snapshot, (given) => planFor(changedNothing, given, config), read);

    expect(heads).toEqual([]);
    expect(verdictCommentsOf(plan)).toHaveLength(1);
    expect(verdictCommentsOf(plan)[0]).not.toContain("fabrik:change");
    expect(unread).toBe("The Verdict on #50 was posted without a change fingerprint: it is on aaaaaaa, which the pull request has moved on from.");
  });

  it("says so when the Verdict's comment had no room for the line", async () => {
    const snapshot = snapshotOfPullRequest(aPullRequest());
    const event = reviewed(`verdict: execution-flaw\n\n${"x".repeat(GITHUB_COMMENT_LIMIT - 400)}`);

    const { plan, unread } = await planWithChange(snapshot, (given) => planFor(event, given, config), reader().read);

    expect(plan).toEqual(planFor(event, snapshot, config));
    expect(verdictCommentsOf(plan)).toHaveLength(1);
    expect(unread).toBe("The Verdict on #50 was posted without a change fingerprint: the comment had no room for its line.");
  });
});
