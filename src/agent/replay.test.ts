import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import { implementInput } from "./implement.ts";
import { OPERATOR_COMMENTS_HEADING, REQUESTED_CHANGES_HEADING } from "./operatorComments.ts";
import { promptFor } from "./prompt.ts";
import { REPLAY_PATCH_FILE, replayImplementInput, replayReviewContext, writeReplayPatch } from "./replay.ts";

const run = promisify(execFile);
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, env })).stdout.trim();

async function write(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

async function fileOf(value: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "fabrik-replay-input-")), "file.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

const ticket = {
  number: 7,
  title: "Show the empty cart",
  body: "## What to build\n\nAn empty cart shows \"Nothing here yet\".\n\n## Acceptance criteria\n\n- [ ] The empty cart shows the empty state",
  author: { login: "operator" },
  labels: [{ name: "ready-for-agent" }],
  comments: [],
};

const spec = { number: 3, title: "Spec: The cart", body: "## Solution\n\nA cart that says when it's empty." };

/**
 * A Product repo at a Ticket's baseSha, with its glossary, an ADR and its
 * Coding standards, and the replay arm's patch on top of it as one local
 * commit, as the replay Review job checks it out.
 */
async function aReplayReviewCheckout(): Promise<{ productDir: string; baseSha: string }> {
  const productDir = await mkdtemp(join(tmpdir(), "fabrik-replay-review-"));
  await git(productDir, "init", "--quiet", "--initial-branch=main");
  await write(productDir, {
    "GLOSSARY.md": "# Shop\n\n**Cart**:\nWhat a shopper means to buy.\n",
    "docs/adr/0001-carts-live-in-the-browser.md": "# Carts live in the browser\n",
    "CODING_STANDARDS.md": "# Coding standards\n\n- Name a test for the behaviour it checks.\n",
    "src/cart.ts": "export const items: string[] = [];\n",
  });
  await git(productDir, "add", "-A");
  await git(productDir, "commit", "--quiet", "-m", "The shop as the Ticket found it");
  const baseSha = await git(productDir, "rev-parse", "HEAD");
  await write(productDir, { "src/cart.ts": "export const items: string[] = [];\nexport const emptyText = \"Nothing here yet\";\n" });
  await git(productDir, "commit", "--quiet", "-am", "The replay arm's patch");
  return { productDir, baseSha };
}

describe("A replay arm's Review context", () => {
  it("carries the Ticket, its Spec and the diff from baseSha, with no PR number, no Request changes and no Operator comments", async () => {
    const { productDir, baseSha } = await aReplayReviewCheckout();

    const parts = await replayReviewContext(productDir, await fileOf(spec), baseSha);
    const prompt = promptFor({
      template: "# The Kit's review prompt\n",
      role: "review",
      note: "",
      config: kitConfig(),
      issue: ticket,
      heading: "The Ticket",
      extra: parts,
    });

    expect(prompt).toContain("## The Ticket");
    expect(prompt).toContain("An empty cart shows \\\"Nothing here yet\\\".");
    expect(prompt).toContain("## The parent Spec");
    expect(prompt).toContain("A cart that says when it's empty.");
    expect(prompt).toContain('+export const emptyText = "Nothing here yet";');
    expect(prompt).toContain(`git diff ${baseSha} HEAD`);
    expect(prompt).not.toContain("## The pull request");
    expect(prompt).not.toContain(OPERATOR_COMMENTS_HEADING);
    expect(prompt).not.toContain(REQUESTED_CHANGES_HEADING);
    expect(prompt).toContain("what this prompt says of a PR's description, of the Operator's Request changes and of the Operator's comments doesn't apply");
    expect(prompt).not.toMatch(/"number": (?!7\b|3\b)\d+/);
  });

  it("carries the repo's glossary, ADRs and Coding standards at baseSha, as a live Review's does", async () => {
    const { productDir, baseSha } = await aReplayReviewCheckout();

    const text = (await replayReviewContext(productDir, await fileOf(spec), baseSha)).join("\n");

    expect(text).toContain("## GLOSSARY.md\n# Shop");
    expect(text).toContain("## docs/adr/0001-carts-live-in-the-browser.md\n# Carts live in the browser");
    expect(text).toContain("## CODING_STANDARDS.md\n# Coding standards");
  });

  it("says the change is empty when the arm committed nothing", async () => {
    const { productDir, baseSha } = await aReplayReviewCheckout();
    await git(productDir, "reset", "--quiet", "--hard", baseSha);

    const text = (await replayReviewContext(productDir, await fileOf(null), baseSha)).join("\n");

    expect(text).toContain("The change is empty: the Implementer committed nothing.");
    expect(text).not.toContain("```diff");
  });

  it("cuts a long diff short, saying how to read all of it", async () => {
    const { productDir, baseSha } = await aReplayReviewCheckout();
    await write(productDir, { "src/long.ts": `${"// a long line of the arm's change\n".repeat(3000)}` });
    await git(productDir, "add", "-A");
    await git(productDir, "commit", "--quiet", "-m", "A long change");

    const text = (await replayReviewContext(productDir, await fileOf(null), baseSha)).join("\n");

    expect(text).toMatch(new RegExp(`\\[Diff cut short at 60000 of \\d+ characters; \`git diff ${baseSha} HEAD\` shows all of it\\.\\]`));
    expect(text.length).toBeLessThan(70_000);
  });

  it("refuses a checkout whose HEAD isn't built on baseSha, so the Reviewer never judges some other change", async () => {
    const { productDir } = await aReplayReviewCheckout();
    await git(productDir, "checkout", "--quiet", "--orphan", "elsewhere");
    await git(productDir, "commit", "--quiet", "-m", "Unrelated history");
    const unrelated = await git(productDir, "rev-parse", "HEAD");
    await git(productDir, "checkout", "--quiet", "main");

    await expect(replayReviewContext(productDir, await fileOf(null), unrelated)).rejects.toThrow(unrelated);
  });
});

// The Product repo as GitHub holds it, a bare remote, which the Ticket's first
// Implement run cloned when main was at baseSha, and main moved on since.
describe("A replay arm's Implement input", () => {
  async function aRemoteAtBaseSha(): Promise<{ root: string; remote: string; baseSha: string }> {
    const root = await mkdtemp(join(tmpdir(), "fabrik-replay-implement-"));
    const remote = join(root, "shop.git");
    await mkdir(remote);
    await git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
    const seed = join(root, "seed");
    await git(root, "clone", "--quiet", remote, seed);
    await write(seed, {
      "GLOSSARY.md": "# Shop\n\n**Cart**:\nWhat a shopper means to buy.\n",
      "docs/adr/0001-carts-live-in-the-browser.md": "# Carts live in the browser\n",
      "src/cart.ts": "export const items: string[] = [];\n",
    });
    await git(seed, "add", "-A");
    await git(seed, "commit", "--quiet", "-m", "The shop as the Ticket found it");
    await git(seed, "push", "--quiet", "origin", "main");
    return { root, remote, baseSha: await git(seed, "rev-parse", "HEAD") };
  }

  async function mainMovesOn(root: string): Promise<void> {
    const seed = join(root, "seed");
    await write(seed, {
      "GLOSSARY.md": "# Shop\n\n**Basket**:\nWhat the cart came to be called.\n",
      "docs/adr/0002-baskets-live-on-the-server.md": "# Baskets live on the server\n",
    });
    await git(seed, "add", "-A");
    await git(seed, "commit", "--quiet", "-m", "The shop moves on");
    await git(seed, "push", "--quiet", "origin", "main");
  }

  it("matches a first Implement run's for the same Ticket at the same baseSha, though main has moved on since", async () => {
    const { root, remote, baseSha } = await aRemoteAtBaseSha();
    const specFile = await fileOf(spec);
    // The first Implement run, on a fresh clone of main when main was at baseSha.
    const original = join(root, "original");
    await git(root, "clone", "--quiet", remote, original);
    const first = await implementInput(original, 7, kitConfig(), { spec: specFile, pullRequest: "", review: "" });
    // The replay, after main moved on, on a fresh clone checked out at baseSha.
    await mainMovesOn(root);
    const replayed = join(root, "replayed");
    await git(root, "clone", "--quiet", remote, replayed);
    await git(replayed, "checkout", "--quiet", "--detach", baseSha);

    const replay = await replayImplementInput(replayed, 7, kitConfig(), specFile, baseSha);

    expect(replay.parts).toEqual(first.parts);
    expect(replay.parts.join("\n")).toContain("**Cart**:\nWhat a shopper means to buy.");
    expect(replay.parts.join("\n")).not.toContain("Basket");
    expect(replay.branch).toMatchObject({ name: first.branch.name, base: { sha: baseSha }, head: null });
    expect(await git(replayed, "rev-parse", "--abbrev-ref", "HEAD")).toBe("fabrik/ticket-7");
    expect(replay.operatorComments).toBeNull();
    expect(replay.brief).toBeNull();
  });

  it("refuses a checkout that isn't at baseSha, so an arm never builds from some other commit", async () => {
    const { root, remote, baseSha } = await aRemoteAtBaseSha();
    await mainMovesOn(root);
    const checkout = join(root, "main");
    await git(root, "clone", "--quiet", remote, checkout);

    await expect(replayImplementInput(checkout, 7, kitConfig(), await fileOf(spec), baseSha)).rejects.toThrow(baseSha);
  });

  it("passes the arm's commits out as a patch from baseSha, which rebuilds them on a fresh checkout of baseSha", async () => {
    const { root, remote, baseSha } = await aRemoteAtBaseSha();
    const arm = join(root, "arm");
    await git(root, "clone", "--quiet", remote, arm);
    await git(arm, "checkout", "--quiet", "--detach", baseSha);
    const { branch } = await replayImplementInput(arm, 7, kitConfig(), await fileOf(spec), baseSha);
    // The Implementer commits a change, a new file and a binary one, and leaves some work uncommitted.
    await write(arm, { "src/cart.ts": "export const items: string[] = [];\nexport const emptyText = \"Nothing here yet\";\n", "src/empty.ts": "export {};\n" });
    await writeFile(join(arm, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    await git(arm, "add", "-A");
    await git(arm, "commit", "--quiet", "-m", "Show the empty cart");
    const head = await git(arm, "rev-parse", "HEAD");
    await write(arm, { "src/wip.ts": "// not committed\n" });
    const outDir = await mkdtemp(join(tmpdir(), "fabrik-replay-out-"));

    const built = await writeReplayPatch(arm, branch, outDir);

    expect(built).toEqual({ ...branch, head });
    const fresh = join(root, "fresh");
    await git(root, "clone", "--quiet", remote, fresh);
    await git(fresh, "checkout", "--quiet", "--detach", baseSha);
    await git(fresh, "apply", "--index", join(outDir, REPLAY_PATCH_FILE));
    expect(await git(fresh, "write-tree")).toBe(await git(arm, "rev-parse", "HEAD^{tree}"));
  });

  it("passes out an empty patch when the arm committed nothing", async () => {
    const { root, remote, baseSha } = await aRemoteAtBaseSha();
    const arm = join(root, "arm");
    await git(root, "clone", "--quiet", remote, arm);
    await git(arm, "checkout", "--quiet", "--detach", baseSha);
    const { branch } = await replayImplementInput(arm, 7, kitConfig(), await fileOf(spec), baseSha);
    const outDir = await mkdtemp(join(tmpdir(), "fabrik-replay-out-"));

    const built = await writeReplayPatch(arm, branch, outDir);

    expect(built.head).toBeNull();
    expect(await readFile(join(outDir, REPLAY_PATCH_FILE), "utf8")).toBe("");
  });
});
