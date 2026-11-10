import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { PENRITH_59_REPO, PENRITH_59_REQUEST, PENRITH_59_TICKET_PRACTITIONERS, penrith59 } from "../__fixtures__/requestedChanges.ts";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import { verdictMarker } from "../loop/markers.ts";
import {
  bundleAgentBranch,
  conflictContext,
  failedRunCommits,
  implementContext,
  implementInput,
  requestChangesContext,
  retryContext,
} from "./implement.ts";
import { readPullRequest } from "./inputs.ts";
import { AGENT_BUNDLE_FILE, type BuiltBranch } from "./result.ts";

async function fileOf(value: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "fabrik-implement-")), "file.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

const VERDICT = [
  verdictMarker({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "a".repeat(40) }),
  "- The empty cart throws.",
].join("\n");

const pullRequest = {
  number: 50,
  title: "Handle the empty cart",
  body: "Shows the empty state.\n\nNeeds the Operator: format:check fails.\n\nCloses #7",
  comments: [{ body: VERDICT, author: { __typename: "Bot" } }],
};

describe("A run on an existing PR is shown the PR's current description, to rewrite", () => {
  it("a retry sees the body, without the Closes line the Kit adds itself", async () => {
    const { parts } = await retryContext(await fileOf(pullRequest));

    const text = parts.join("\n");
    expect(text).toContain("## The pull request's current description");
    expect(text).toContain("Needs the Operator: format:check fails.");
    expect(text).not.toContain("Closes #7");
  });

  it("a run on a UI PR sees it without the evidence section, which the Kit writes itself, so it never copies the old one forward", async () => {
    const body = [
      "Shows the empty state.",
      "",
      "<!-- fabrik:ui-evidence-start -->",
      "## UI evidence",
      "",
      "[Open the gallery](<https://github.com/acme/shop/actions/runs/8000/artifacts/8001>) of 2 screenshots.",
      `<!-- fabrik:ui-evidence {"run":8000,"artifact":8002} -->`,
      "",
      "Closes #7",
    ].join("\n");

    const { parts } = await retryContext(await fileOf({ ...pullRequest, body }));

    const description = parts.slice(parts.indexOf("## The pull request's current description"), parts.indexOf("## The findings to fix"));
    expect(description.at(-1)).toBe("Shows the empty state.");
    expect(parts.join("\n")).not.toContain("fabrik:ui-evidence");
    expect(parts.join("\n")).not.toContain("UI evidence");
  });

  it("a Request-changes run a pass gave way to (#427) has no findings to fix: the pass is no flaw", async () => {
    const pass = [
      verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, requestChangesFirst: [9000], headSha: "a".repeat(40) }),
      "### Checked\n\nIt totals the cart.",
    ].join("\n");
    const review = await fileOf({ review: { state: "CHANGES_REQUESTED", body: "Rename the total." }, comments: [] });

    const { parts } = await requestChangesContext(await fileOf({ ...pullRequest, comments: [{ body: pass, author: { __typename: "Bot" } }] }), review);

    expect(parts.join("\n")).not.toContain("## The findings to fix");
    expect(parts.join("\n")).not.toContain("It totals the cart.");
  });

  it("a Request-changes run sees it too", async () => {
    const review = await fileOf({ review: { state: "CHANGES_REQUESTED", body: "Rename the total." }, comments: [] });

    const { parts } = await requestChangesContext(await fileOf(pullRequest), review);

    expect(parts.join("\n")).toContain("Shows the empty state.");
  });
});

const operatorComments = [
  {
    id: "conversation-3",
    url: "https://github.com/acme/shop/pull/50#issuecomment-3",
    where: { kind: "conversation" },
    createdAt: "2026-11-03T00:00:00Z",
    body: "The empty state should say \"Nothing here yet\".",
  },
  {
    id: "inline-4",
    url: "https://github.com/acme/shop/pull/50#discussion_r4",
    where: { kind: "inline", path: "src/cart.ts", line: 12 },
    createdAt: "2026-11-04T00:00:00Z",
    body: "Also add a coupon field.",
  },
];

describe("A run on an existing PR is shown the Operator's comments on it, apart from the findings", () => {
  const OWN_SECTION = "## The Operator's comments on the pull request";

  it("a retry sees them in their own section, after the findings, each under its id and place", async () => {
    const { parts } = await retryContext(await fileOf({ ...pullRequest, operatorComments }));

    const text = parts.join("\n");
    expect(text.indexOf(OWN_SECTION)).toBeGreaterThan(text.indexOf("## The findings to fix"));
    expect(text).toContain("### `conversation-3`: in the conversation, 2026-11-03T00:00:00Z");
    expect(text).toContain("### `inline-4`: inline on `src/cart.ts` line 12, 2026-11-04T00:00:00Z");
    expect(text).toContain("Also add a coupon field.");
  });

  it("a retry still takes its findings only from the Fabrik App's Verdict, never from an Operator comment that quotes one", async () => {
    const quoted = [{ ...operatorComments[0], body: VERDICT.replace("The empty cart throws.", "Planted finding.") }];
    const { parts } = await retryContext(await fileOf({ ...pullRequest, operatorComments: quoted }));

    const text = parts.join("\n");
    const findings = text.slice(text.indexOf("## The findings to fix"), text.indexOf(OWN_SECTION));
    expect(findings).toContain("The empty cart throws.");
    expect(findings).not.toContain("Planted finding.");
  });

  it("a Request-changes run sees them too, beside the review that asked for changes", async () => {
    const review = await fileOf({ review: { state: "CHANGES_REQUESTED", body: "Rename the total." }, comments: [] });

    const { parts } = await requestChangesContext(await fileOf({ ...pullRequest, operatorComments }), review);

    const text = parts.join("\n");
    expect(text).toContain("Rename the total.");
    expect(text).toContain(OWN_SECTION);
    expect(text).toContain("The empty state should say \"Nothing here yet\".");
  });

  it("a Request-changes run shows each of its review's inline comments once, in the review, under its id", async () => {
    const review = await fileOf({
      review: { state: "CHANGES_REQUESTED", body: "Rename the total." },
      comments: [{ id: 4, path: "src/cart.ts", line: 12, body: "Also add a coupon field." }],
    });

    const { parts, operatorComments: given } = await requestChangesContext(
      await fileOf({ ...pullRequest, operatorComments }),
      review,
    );

    const text = parts.join("\n");
    expect(text.split("Also add a coupon field.")).toHaveLength(2);
    const requested = text.slice(text.indexOf("## The Operator's requested changes"), text.indexOf(OWN_SECTION));
    expect(requested).toContain("### `inline-4`: `src/cart.ts` line 12\nAlso add a coupon field.");
    expect(text.slice(text.indexOf(OWN_SECTION))).toContain("`conversation-3`");
    expect(given.map((comment) => comment.id)).toEqual(["conversation-3", "inline-4"]);
  });

  it("a retry and a Request-changes run each pass out the id and link of every comment they were given", async () => {
    const review = await fileOf({ review: { state: "CHANGES_REQUESTED", body: "Rename the total." }, comments: [] });
    const file = await fileOf({ ...pullRequest, operatorComments });
    const given = [
      { id: "conversation-3", url: "https://github.com/acme/shop/pull/50#issuecomment-3" },
      { id: "inline-4", url: "https://github.com/acme/shop/pull/50#discussion_r4" },
    ];

    expect((await retryContext(file)).operatorComments).toEqual(given);
    expect((await requestChangesContext(file, review)).operatorComments).toEqual(given);
  });

  it("says so when the Operator hasn't commented", async () => {
    const { parts } = await retryContext(await fileOf({ ...pullRequest, operatorComments: [] }));

    expect(parts.join("\n")).toContain(`${OWN_SECTION}\n(The Operator hasn't commented on it.)`);
  });
});

describe("The Implementer's context", () => {
  it("never carries the repo's CODING_STANDARDS.md, which only the Reviewer reads", async () => {
    const productDir = await mkdtemp(join(tmpdir(), "fabrik-implement-"));
    await writeFile(join(productDir, "GLOSSARY.md"), "**Waitlist**:\nPatients waiting for a cancelled slot.\n");
    await writeFile(join(productDir, "CODING_STANDARDS.md"), "# Coding standards\n\n- Name a test for the behaviour it checks.\n");

    const text = (await implementContext(productDir, await fileOf(null), kitConfig())).join("\n");

    expect(text).toContain("Patients waiting for a cancelled slot.");
    expect(text).not.toContain("CODING_STANDARDS.md");
    expect(text).not.toContain("Name a test for the behaviour it checks.");
  });
});

describe("A retry on a PR the Operator requested changes on is given the amended Ticket (ADR-0010)", () => {
  it("replays penrith#59: the retry sees the Request changes as an amendment, beside the findings that would undo it", async () => {
    const read = (await readPullRequest(penrith59(), PENRITH_59_REPO, 59, { withComments: true, operator: "operator" })) as { body: string };
    // The Ticket lists eight practitioners; the PR, as the Operator asked, lists seven.
    expect(PENRITH_59_TICKET_PRACTITIONERS).toHaveLength(8);
    expect(read.body).not.toContain("Declan Price");

    const { parts, operatorComments: given } = await retryContext(await fileOf(read));

    const text = parts.join("\n");
    expect(text.indexOf("## The Operator's Request changes, which amend the Ticket")).toBeGreaterThan(text.indexOf("## The findings to fix"));
    expect(text).toContain(`### \`review-70\`: Request changes, 2026-11-01T00:00:00Z\n${PENRITH_59_REQUEST}`);
    expect(given.map((comment) => comment.id)).toEqual(["review-70"]);
  });

  it("carries no amendment section on a PR the Operator never requested changes on", async () => {
    const text = (await retryContext(await fileOf(pullRequest))).parts.join("\n");

    expect(text).not.toContain("which amend the Ticket");
  });
});

describe("A Request-changes run with the Operator's earlier Request changes on its PR (#341)", () => {
  const earlier = {
    id: "review-101",
    url: "https://github.com/acme/shop/pull/50#pullrequestreview-101",
    submittedAt: "2026-11-07T05:14:00Z",
    body: "Make the slots 30 minutes.",
    comments: [],
  };
  const latest = { ...earlier, id: "review-102", url: "https://github.com/acme/shop/pull/50#pullrequestreview-102", submittedAt: "2026-11-07T05:52:00Z", body: "Rebase for merge conflicts please." };
  const context = async () =>
    requestChangesContext(
      await fileOf({ ...pullRequest, operatorComments: [], requestedChanges: [earlier, latest] }),
      await fileOf({ review: { id: 102, state: "CHANGES_REQUESTED", body: latest.body }, comments: [] }),
    );

  it("is told to build any of them the PR doesn't meet yet, and when its own review was submitted", async () => {
    const text = (await context()).parts.join("\n");

    expect(text).toContain("## The Operator's requested changes\nSubmitted 2026-11-07T05:52:00Z.\nRebase for merge conflicts please.");
    expect(text).toContain("### `review-101`: Request changes, 2026-11-07T05:14:00Z\nMake the slots 30 minutes.");
    expect(text).toContain("also build each of these the pull request doesn't meet yet");
  });

  it("never rewrites the PR's history for an earlier one asking how the branch takes in main, such as a rebase: it merges main in if the PR lacks it", async () => {
    const text = (await context()).parts.join("\n");

    expect(text).toContain(
      "One that asks how the branch takes in `main`, such as a rebase, never rewrites the PR's history: if the PR doesn't hold `origin/main` yet, merge it in instead.",
    );
  });

  it("may name them as weighed, as it's shown them under their ids", async () => {
    expect((await context()).operatorComments.map(({ id }) => id)).toEqual(["review-101"]);
  });

  it("isn't told the Operator hasn't commented, right after their Request changes", async () => {
    const text = (await context()).parts.join("\n");

    expect(text).toContain("## The Operator's comments on the pull request\n(The Operator hasn't commented on it beyond the Request changes above.)");
    expect(text).not.toContain("(The Operator hasn't commented on it.)");
  });
});

describe("A Request-changes run on a PR that conflicts with main (#341)", () => {
  const git = async (cwd: string, ...args: string[]) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    return (await promisify(execFile)("git", args, { cwd, env })).stdout.trim();
  };
  const commit = async (cwd: string, path: string, text: string) => {
    await writeFile(join(cwd, path), text);
    await git(cwd, "add", "-A");
    await git(cwd, "commit", "--quiet", "-m", `Change ${path}`);
    return git(cwd, "rev-parse", "HEAD");
  };

  /** A Product checkout at the PR's branch, with `origin/main` fetched; main changes the PR's file when `conflicting`. */
  async function checkout(conflicting: boolean): Promise<{ productDir: string; main: string }> {
    const root = await mkdtemp(join(tmpdir(), "fabrik-implement-git-"));
    const origin = join(root, "origin.git");
    await git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
    const seed = join(root, "seed");
    await git(root, "clone", "--quiet", origin, seed);
    await git(seed, "checkout", "--quiet", "-b", "main");
    await commit(seed, "shared.ts", "v1\n");
    await git(seed, "push", "--quiet", "origin", "main");
    await git(seed, "checkout", "--quiet", "-b", "fabrik/ticket-7");
    await commit(seed, "shared.ts", "from the PR\n");
    await git(seed, "push", "--quiet", "origin", "fabrik/ticket-7");
    await git(seed, "checkout", "--quiet", "main");
    const main = await commit(seed, conflicting ? "shared.ts" : "other.ts", "from main\n");
    await git(seed, "push", "--quiet", "origin", "main");
    const productDir = join(root, "product");
    await git(root, "clone", "--quiet", "--branch", "fabrik/ticket-7", origin, productDir);
    return { productDir, main };
  }

  const input = async (productDir: string, defaultBranch = "main") =>
    implementInput(productDir, 7, kitConfig(), {
      spec: await fileOf(null),
      pullRequest: await fileOf({ ...pullRequest, operatorComments: [] }),
      review: await fileOf({ review: { id: 102, state: "CHANGES_REQUESTED", body: "Rebase for merge conflicts please." }, comments: [] }),
      defaultBranch,
    });

  it("is told to merge main in first, never rebasing, and records the main head it was told to merge", async () => {
    const { productDir, main } = await checkout(true);

    const { parts, mergeMain } = await input(productDir);

    const text = parts.join("\n");
    expect(text).toContain("## Bring main in first");
    expect(text).toContain(`at ${main}`);
    expect(text).toContain("`git merge origin/main`");
    expect(mergeMain).toBe(main);
  });

  it("passes out, for the judge (#450), what its prompt carried about the PR beyond the Ticket: the review and the merge, never the Spec, glossary or ADRs", async () => {
    const { productDir } = await checkout(true);

    const { parts, brief } = await input(productDir);

    expect(brief).toContain("## The Operator's requested changes\n\nRebase for merge conflicts please.");
    expect(brief).toContain("## Bring main in first");
    expect(parts.join("\n\n").endsWith(brief ?? "(no brief)")).toBe(true);
    expect(brief).not.toContain("## GLOSSARY.md");
  });

  it("isn't told to merge when the PR only lags behind main", async () => {
    const { productDir } = await checkout(false);

    const { parts, mergeMain } = await input(productDir);

    expect(parts.join("\n")).not.toContain("## Bring main in first");
    expect(mergeMain).toBeNull();
  });

  it("isn't told to merge a default branch the checkout doesn't have", async () => {
    const { productDir } = await checkout(true);

    const { parts, mergeMain } = await input(productDir, "trunk");

    expect(parts.join("\n")).not.toContain("## Bring main in first");
    expect(mergeMain).toBeNull();
  });
});

describe("A conflict-only run (#304)", () => {
  const MAIN = "9".repeat(40);

  it("is told it's a conflict-only run: rebase onto main, resolve the conflicts, change nothing else, and list each conflicted file in its fix", async () => {
    const text = (await conflictContext(await fileOf(pullRequest), MAIN)).parts.join("\n");

    expect(text).toContain("## The pull request you're bringing up to date with main");
    expect(text).toContain("## A conflict-only run");
    expect(text).toContain(MAIN);
    expect(text).toContain("git rebase origin/main");
    expect(text).toMatch(/every conflicted file/);
  });

  it("is given no findings to fix and no new requirements, as neither a Retry nor a Request-changes run", async () => {
    const text = (await conflictContext(await fileOf(pullRequest), MAIN)).parts.join("\n");

    expect(text).not.toContain("## The findings to fix");
    expect(text).not.toContain("- The empty cart throws.");
    expect(text).not.toContain("## The Operator's requested changes");
  });

  it("refuses a main head that isn't a full commit sha", async () => {
    await expect(conflictContext(await fileOf(pullRequest), "main")).rejects.toThrow(/FABRIK_CONFLICT_MAIN/);
  });
});

// #431: a run that committed, then failed its output contract, keeps its commits as a bundle,
// and its failure report says so, and where a re-run starts from.
describe("What a failed run had committed on its branch", () => {
  const run = promisify(execFile);
  const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd })).stdout.trim();
  const commit = async (cwd: string, path: string, message: string) => {
    await writeFile(join(cwd, path), `${message}\n`);
    await git(cwd, "add", "-A");
    await git(cwd, "-c", "user.name=Fabrik", "-c", "user.email=fabrik@example.com", "commit", "--quiet", "-m", message);
  };

  async function startedBranch(): Promise<{ productDir: string; outDir: string; started: BuiltBranch }> {
    const root = await mkdtemp(join(tmpdir(), "fabrik-failed-commits-"));
    const productDir = join(root, "product");
    const outDir = join(root, "fabrik-out");
    await mkdir(productDir);
    await mkdir(outDir);
    await git(productDir, "init", "--quiet", "--initial-branch=main");
    await commit(productDir, "README.md", "Start");
    const sha = await git(productDir, "rev-parse", "HEAD");
    await git(productDir, "checkout", "--quiet", "-b", "agent/7");
    return { productDir, outDir, started: { name: "agent/7", base: { ref: "main", sha }, head: null } };
  }

  it("a missing-output failure after commits leaves a bundle, kept, and names the head the run started from", async () => {
    const { productDir, outDir, started } = await startedBranch();
    await commit(productDir, "feature.ts", "Build the change");
    const head = await git(productDir, "rev-parse", "HEAD");

    const commits = await failedRunCommits(productDir, started, outDir, null);

    expect(commits).toEqual({ base: started.base.sha, continued: false, head, kept: true });
    expect(existsSync(join(outDir, AGENT_BUNDLE_FILE))).toBe(true);
    expect(await git(productDir, "bundle", "list-heads", join(outDir, AGENT_BUNDLE_FILE))).toBe(`${head} refs/heads/agent/7`);
  });

  it("reads a bundle the run already made before its output was checked as kept", async () => {
    const { productDir, outDir, started } = await startedBranch();
    await commit(productDir, "feature.ts", "Build the change");
    const built = await bundleAgentBranch(productDir, started, outDir);

    expect(await failedRunCommits(productDir, started, outDir, built)).toEqual({ base: started.base.sha, continued: false, head: built.head, kept: true });
  });

  it("says a run that committed nothing made no commits, and leaves no bundle", async () => {
    const { productDir, outDir, started } = await startedBranch();

    expect(await failedRunCommits(productDir, started, outDir, null)).toEqual({ base: started.base.sha, continued: false, head: null, kept: false });
    expect(existsSync(join(outDir, AGENT_BUNDLE_FILE))).toBe(false);
  });

  it("says whether the run carried on a branch from its head, as a run on a PR does, rather than cut it", async () => {
    const { productDir, outDir, started } = await startedBranch();
    const onPullRequest: BuiltBranch = { ...started, base: { ref: started.name, sha: started.base.sha } };

    expect(await failedRunCommits(productDir, onPullRequest, outDir, null)).toEqual({ base: started.base.sha, continued: true, head: null, kept: false });
  });

  it("says commits a run made on its branch weren't kept when they can't be bundled", async () => {
    const { productDir, outDir, started } = await startedBranch();
    await commit(productDir, "feature.ts", "Build the change");
    const head = await git(productDir, "rev-parse", "HEAD");
    // The agent left its branch, so bundleAgentBranch refuses it.
    await git(productDir, "checkout", "--quiet", "main");

    expect(await failedRunCommits(productDir, started, outDir, null)).toEqual({ base: started.base.sha, continued: false, head, kept: false });
    expect(existsSync(join(outDir, AGENT_BUNDLE_FILE))).toBe(false);
  });
});

describe("A Kept-branch start (#536)", () => {
  const git = async (cwd: string, ...args: string[]) => {
    const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    return (await promisify(execFile)("git", args, { cwd, env })).stdout.trim();
  };
  const commit = async (cwd: string, path: string, text: string) => {
    await writeFile(join(cwd, path), text);
    await git(cwd, "add", "-A");
    await git(cwd, "commit", "--quiet", "-m", `Change ${path}`);
    return git(cwd, "rev-parse", "HEAD");
  };

  /** A checkout of the Kept branch fabrik/ticket-7, as the Implement job makes it; main moved on since when `behind`. */
  async function keptCheckout(behind: boolean): Promise<{ productDir: string; kept: string; main: string }> {
    const root = await mkdtemp(join(tmpdir(), "fabrik-kept-git-"));
    const origin = join(root, "origin.git");
    await git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
    const seed = join(root, "seed");
    await git(root, "clone", "--quiet", origin, seed);
    await git(seed, "checkout", "--quiet", "-b", "main");
    let main = await commit(seed, "shared.ts", "v1\n");
    await git(seed, "push", "--quiet", "origin", "main");
    await git(seed, "checkout", "--quiet", "-b", "fabrik/ticket-7");
    const kept = await commit(seed, "feature.ts", "kept work\n");
    await git(seed, "push", "--quiet", "origin", "fabrik/ticket-7");
    if (behind) {
      await git(seed, "checkout", "--quiet", "main");
      main = await commit(seed, "other.ts", "from main\n");
      await git(seed, "push", "--quiet", "origin", "main");
    }
    const productDir = join(root, "product");
    await git(root, "clone", "--quiet", "--branch", "fabrik/ticket-7", origin, productDir);
    return { productDir, kept, main };
  }

  const input = async (productDir: string) =>
    implementInput(productDir, 7, kitConfig(), { spec: await fileOf(null), pullRequest: "", review: "", keptBranch: { pullRequest: 230 }, defaultBranch: "main" });

  it("carries on the checked-out Kept branch as a first run, its base the branch's head, so the bundle holds only the run's own commits", async () => {
    const { productDir, kept } = await keptCheckout(false);

    const { branch, kind, operatorComments } = await input(productDir);

    expect(branch).toEqual({ name: "fabrik/ticket-7", base: { ref: "fabrik/ticket-7", sha: kept }, head: null });
    expect(kind).toBe("first");
    expect(operatorComments).toBeNull();
  });

  it("is told the branch holds the closed PR's kept work, and to merge main in first when the branch doesn't hold its head", async () => {
    const { productDir, main } = await keptCheckout(true);

    const { parts, brief } = await input(productDir);

    const text = parts.join("\n");
    expect(text).toContain("## Carrying on the Kept branch");
    expect(text).toContain("#230");
    expect(text).toContain("`git merge origin/main`");
    expect(text).toContain(main);
    // Kept for the judge, so the Scorer judges it as a run that carried on a branch (#450).
    expect(brief).toContain("## Carrying on the Kept branch");
    expect(brief).not.toContain("## GLOSSARY.md");
  });

  it("isn't told to merge main when the branch already holds its head", async () => {
    const { productDir } = await keptCheckout(false);

    const { parts } = await input(productDir);

    expect(parts.join("\n")).toContain("## Carrying on the Kept branch");
    expect(parts.join("\n")).not.toContain("`git merge origin/main`");
  });
});
