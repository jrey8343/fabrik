import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildAgentBranch } from "../github/branch.ts";
import { bundleAgentBranch, cutBranch } from "./implement.ts";
import { commitResearch, RESEARCH_SECTIONS, researchContext } from "./research.ts";
import { AGENT_BUNDLE_FILE, type BuiltBranch } from "./result.ts";

const decision = {
  number: 42,
  title: "Which payment provider takes group bookings?",
  body: "## Question\n\nCan one payment cover every seat in a group class?",
  author: { login: "operator" },
  labels: [{ name: "wayfinder:research" }],
  comments: [],
};

const map = {
  number: 12,
  title: "Let patients book group classes",
  body: "## Destination\n\nA Spec for group class booking.\n\n## Notes\n\n## Decisions so far\n\n## Not yet specified\n\n## Out of scope\n",
};

/** The spec.json the agent-inputs step writes: the issue's parent, for a Decision its Map. */
async function mapFileOf(value: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "fabrik-research-")), "spec.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

describe("A Researcher run's context", () => {
  it("sets out the Decision's Map, then the one findings file the Kit names from the Decision's number and title", async () => {
    const { findingsPath, parts } = await researchContext(await mapFileOf(map), decision);

    expect(findingsPath).toBe("docs/research/42-which-payment-provider-takes-group-bookings.md");
    expect(parts).toEqual([
      `## ${RESEARCH_SECTIONS.map}`,
      "```json",
      JSON.stringify(map, null, 2),
      "```",
      `## ${RESEARCH_SECTIONS.findingsFile}`,
      "Write your findings to `docs/research/42-which-payment-provider-takes-group-bookings.md`, from the repo root, and change no other file.",
    ]);
  });

  it.each([
    ["no Map, as for an issue with no parent", null],
    ["a Map with no body", { number: 12, title: "Let patients book group classes" }],
    ["a Map with no number", { title: "Let patients book group classes", body: "## Destination" }],
  ])("refuses %s, so the run fails rather than researches out of context", async (_, broken) => {
    await expect(researchContext(await mapFileOf(broken), decision)).rejects.toThrow(/Map/);
  });

  it("names the Decision's throwaway branch from its number and title, as it names the findings file", async () => {
    const { branch } = await researchContext(await mapFileOf(map), decision);

    expect(branch).toBe("research/42-which-payment-provider-takes-group-bookings");
  });

  it.each([
    ["no number", { ...decision, number: undefined }],
    ["no title", { ...decision, title: undefined }],
  ])("refuses a Decision with %s, which its findings file is named from", async (_, broken) => {
    await expect(researchContext(await mapFileOf(map), broken)).rejects.toThrow(/Decision/);
  });
});

// The Research job's git work around the agent, against real repositories on
// disk: a bare "GitHub" remote served over file://, the job's checkout of its
// default branch, and the push job's rebuild of the bundle, as in
// src/github/branch.test.ts.
describe("A Researcher run's branch", () => {
  const run = promisify(execFile);
  const FINDINGS = "docs/research/42-which-payment-provider-takes-group-bookings.md";
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
  const write = async (cwd: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), text);
    }
  };
  const paths = (changes: readonly { path: string; from?: string }[]) => [...new Set(changes.map((change) => change.path))].sort();

  let root: string;
  let remote: string;
  let checkout: string;
  let outDir: string;
  let mainSha: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fabrik-research-branch-"));
    remote = join(root, "acme", "shop.git");
    await mkdir(remote, { recursive: true });
    await git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
    await git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
    const seed = join(root, "seed");
    await git(root, "clone", "--quiet", remote, seed);
    await git(seed, "checkout", "--quiet", "-b", "main");
    await write(seed, { "src/cart.ts": "cart v1\n", ".gitignore": ".claude/skills/\n" });
    await git(seed, "add", "-A");
    await git(seed, "commit", "--quiet", "-m", "Start");
    await git(seed, "push", "--quiet", "origin", "main");
    mainSha = await git(seed, "rev-parse", "HEAD");
    checkout = join(root, "product");
    await git(root, "clone", "--quiet", remote, checkout);
    outDir = join(root, "fabrik-out");
    await mkdir(outDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** The runner's part: cuts the Decision's branch, lets `agent` stand in for the agent's run, then commits and bundles what it left. */
  async function researchRun(agent: (dir: string) => Promise<void>): Promise<BuiltBranch> {
    const { branch } = await researchContext(await mapFileOf(map), decision);
    const started = await cutBranch(checkout, branch);
    await agent(checkout);
    await commitResearch(checkout, decision.number);
    return bundleAgentBranch(checkout, started, outDir);
  }

  /** The push job's part: rebuilds the branch from the bundle, as for an Implement run. */
  const rebuilt = (built: BuiltBranch) =>
    rebuildAgentBranch(built, join(outDir, AGENT_BUNDLE_FILE), { serverUrl: `file://${root}`, repo: { owner: "acme", name: "shop" }, token: "unused" });

  it("is cut from the default branch and named for the Decision, with what the run wrote committed as the Fabrik Researcher", async () => {
    const built = await researchRun((dir) => write(dir, { [FINDINGS]: "# Which payment provider?\n" }));

    expect(built).toEqual({
      name: "research/42-which-payment-provider-takes-group-bookings",
      base: { ref: "main", sha: mainSha },
      head: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(await git(checkout, "log", "-1", "--format=%an <%ae> / %cn <%ce>", built.head!)).toBe(
      "Fabrik Researcher <fabrik-researcher@users.noreply.github.com> / Fabrik Researcher <fabrik-researcher@users.noreply.github.com>",
    );
  });

  it("reads back in the push job as changing its findings file alone, and pushes as the research branch", async () => {
    const built = await researchRun((dir) => write(dir, { [FINDINGS]: "# Which payment provider?\n" }));

    const branch = await rebuilt(built);
    await branch.push(built.name);

    expect(paths(branch.changes.net)).toEqual([FINDINGS]);
    expect(paths(branch.changes.commits)).toEqual([FINDINGS]);
    expect(await git(remote, "rev-parse", `refs/heads/${built.name}`)).toBe(built.head);
  });

  // The push job refuses such a branch with the research failure notice, so a stray change is never hidden by leaving it out.
  it("carries every other file the run changed or added too, so the push job sees each path it touched", async () => {
    const built = await researchRun((dir) => write(dir, { [FINDINGS]: "# Findings\n", "src/cart.ts": "cart v2\n", "AGENTS.md": "weaker rules\n" }));

    expect(paths((await rebuilt(built)).changes.net)).toEqual(["AGENTS.md", FINDINGS, "src/cart.ts"]);
  });

  it("leaves out what the repo ignores, such as the skills the job fetched", async () => {
    const built = await researchRun((dir) => write(dir, { [FINDINGS]: "# Findings\n", ".claude/skills/research/SKILL.md": "# Research\n" }));

    expect(paths((await rebuilt(built)).changes.net)).toEqual([FINDINGS]);
  });

  it("keeps a commit the run made itself, under the Kit's own", async () => {
    const built = await researchRun(async (dir) => {
      await write(dir, { [FINDINGS]: "# Draft\n" });
      await git(dir, "add", "-A");
      await git(dir, "commit", "--quiet", "-m", "Draft");
      await write(dir, { [FINDINGS]: "# Findings\n" });
    });

    const branch = await rebuilt(built);

    expect(paths(branch.changes.net)).toEqual([FINDINGS]);
    expect(await git(checkout, "rev-list", "--count", `${mainSha}..${built.head!}`)).toBe("2");
  });

  it("has no commit and no bundle when the run wrote nothing, so the push job finds no findings file to land", async () => {
    const built = await researchRun(async () => undefined);

    expect(built.head).toBeNull();
    expect(existsSync(join(outDir, AGENT_BUNDLE_FILE))).toBe(false);
    expect((await rebuilt(built)).changes.net).toEqual([]);
  });
});
