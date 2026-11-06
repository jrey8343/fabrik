import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import { UI } from "../__fixtures__/uiEvidence.ts";
import { rebuildAgentBranch } from "../github/branch.ts";
import { bundleAgentBranch } from "./implement.ts";
import { PROTOTYPE_AUTHOR, PROTOTYPE_SECTIONS, prototypeRole, prototypeTurnContext, setPrototypeEnv, startPrototypeBranch } from "./prototype.ts";
import { AGENT_BUNDLE_FILE, AGENT_RESULT_FILE, readAgentRunResult, type BuiltBranch } from "./result.ts";

/** The Kit job's prototype_request output, as the prototype job's env passes it. */
const REQUEST = JSON.stringify({
  route: "/book",
  variants: 3,
  brief: "A: a calendar first.\nB: a list of open times.\nC: one big next-free-slot button.",
  reply: 4321,
});

const withUi = kitConfig({ ui: UI, sandbox: { ...kitConfig().sandbox, build: "npm run build" } });

describe("A prototype turn's context", () => {
  it("sets out the approved request: the route, the variants by letter, the branch and the brief", () => {
    const { request, parts } = prototypeTurnContext(withUi, 7, REQUEST);

    expect(request).toEqual({
      request: { route: "/book", variants: 3, brief: "A: a calendar first.\nB: a list of open times.\nC: one big next-free-slot button." },
      reply: 4321,
    });
    expect(parts.slice(0, 3)).toEqual([
      `## ${PROTOTYPE_SECTIONS.request}`,
      "The Operator approved a Prototype of `/book` in 3 variants. Build them as the variants A, B and C of that one route, each shown at `/book?variant=` and its letter, on the branch `prototype/7`, which is checked out.",
      "What the variants explore, as the Design session's request gives it:",
    ]);
    expect(parts[3]).toBe("```markdown\nA: a calendar first.\nB: a list of open times.\nC: one big next-free-slot button.\n```");
  });

  it("sets out how the Kit builds, serves and captures the branch once the turn has ended", () => {
    const { parts } = prototypeTurnContext(withUi, 7, REQUEST);

    expect(parts.slice(4)).toEqual([
      `## ${PROTOTYPE_SECTIONS.sandbox}`,
      ["- Build: `npm run build`", "- Serve: `npm run preview`, which answers at `http://127.0.0.1:4321`"].join("\n"),
      "Once you finish, the Kit builds the branch, serves it, and captures each variant at mobile and desktop widths, at `http://127.0.0.1:4321/book?variant=A` and so on, so each variant must render there from its letter alone.",
    ]);
    expect(prototypeTurnContext(kitConfig({ ui: UI }), 7, REQUEST).parts[5]).toBe(
      ["- Build: none configured", "- Serve: `npm run preview`, which answers at `http://127.0.0.1:4321`"].join("\n"),
    );
  });

  it("fences the brief so no run of backticks in it can close the fence", () => {
    const brief = "A: shows ```code``` blocks.";
    const { parts } = prototypeTurnContext(withUi, 7, JSON.stringify({ route: "/book", variants: 2, brief, reply: null }));

    expect(parts[3]).toBe(`\`\`\`\`markdown\n${brief}\n\`\`\`\``);
  });

  it.each([
    ["no request at all", ""],
    ["text that isn't JSON", "the booking page, please"],
    ["a route that isn't a path", JSON.stringify({ route: "book", variants: 3, brief: "Three layouts.", reply: null })],
    ["too many variants", JSON.stringify({ route: "/book", variants: 6, brief: "Six layouts.", reply: null })],
    ["no brief", JSON.stringify({ route: "/book", variants: 3, brief: " ", reply: null })],
  ])("refuses %s, so the run fails rather than builds what nobody approved", (_, text) => {
    expect(() => prototypeTurnContext(withUi, 7, text)).toThrow(/FABRIK_PROTOTYPE_REQUEST/);
  });

  // The Kit job only starts a prototype turn with a ui block, so the default branch's Kit config lost it since.
  it("refuses a repo whose Kit config has no ui block, which the Kit can neither serve nor capture", () => {
    expect(() => prototypeTurnContext(kitConfig({ ui: null }), 7, REQUEST)).toThrow(/ui block/);
  });
});

describe("A prototype turn's role", () => {
  const config = kitConfig({
    roles: {
      ...kitConfig().roles,
      design: { model: "claude-opus-5-5", effort: "high", timeoutMinutes: 30 },
      implement: { model: "claude-sonnet-5", effort: "medium", timeoutMinutes: 60 },
    },
  });

  // It builds and serves the Product, so its time is the Implement role's, as the prototype job's agent step's is.
  it("runs on the Design role's model and effort, within the Implement role's timeout", () => {
    expect(prototypeRole(config.roles)).toEqual({ model: "claude-opus-5-5", effort: "high", timeoutMinutes: 60 });
  });
});

describe("A prototype turn's env", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });

  it("holds the Claude token and the Sandbox's values and test secrets, each once under its own name, and commits as the Fabrik Prototype", () => {
    const config = kitConfig({ sandbox: { ...kitConfig().sandbox, env: { NODE_ENV: "test" }, secrets: { STRIPE_KEY: "op://Sandbox/stripe/key" } } });
    process.env["FABRIK_SECRETS"] = JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: "sk-claude", STRIPE_KEY: "sk_test_1" });

    setPrototypeEnv(config);

    expect(process.env["FABRIK_SECRETS"]).toBeUndefined();
    expect(process.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-claude",
      STRIPE_KEY: "sk_test_1",
      NODE_ENV: "test",
      GIT_AUTHOR_NAME: "Fabrik Prototype",
      GIT_AUTHOR_EMAIL: "fabrik-prototype@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Fabrik Prototype",
      GIT_COMMITTER_EMAIL: "fabrik-prototype@users.noreply.github.com",
    });
    expect(PROTOTYPE_AUTHOR).toEqual({ name: "Fabrik Prototype", email: "fabrik-prototype@users.noreply.github.com" });
  });
});

// The prototype job's git work around the agent, against real repositories on
// disk: a bare "GitHub" remote served over file://, the job's checkout of its
// default branch, with the issue's prototype branch checked out when an
// earlier round pushed it (loop.yml), and the push job's rebuild of the
// bundle, as in src/agent/research.test.ts.
describe("A prototype turn's branch", () => {
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
  const write = async (cwd: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), text);
    }
  };
  const commit = async (cwd: string, files: Record<string, string>, message: string) => {
    await write(cwd, files);
    await git(cwd, "add", "-A");
    await git(cwd, "commit", "--quiet", "-m", message);
  };
  const paths = (changes: readonly { path: string; from?: string }[]) => [...new Set(changes.map((change) => change.path))].sort();

  let root: string;
  let remote: string;
  let checkout: string;
  let outDir: string;
  let mainSha: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fabrik-prototype-branch-"));
    remote = join(root, "acme", "shop.git");
    await mkdir(remote, { recursive: true });
    await git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
    await git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
    const seed = join(root, "seed");
    await git(root, "clone", "--quiet", remote, seed);
    await git(seed, "checkout", "--quiet", "-b", "main");
    await commit(seed, { "src/pages/book.astro": "<h1>Book</h1>\n" }, "Start");
    await git(seed, "push", "--quiet", "origin", "main");
    mainSha = await git(seed, "rev-parse", "HEAD");
    checkout = join(root, "product");
    outDir = join(root, "fabrik-out");
    await mkdir(outDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** The job's checkout: the default branch, then the issue's prototype branch when the remote has it, as loop.yml's step does. */
  async function jobCheckout(): Promise<void> {
    await git(root, "clone", "--quiet", remote, checkout);
    const branch = "prototype/7";
    const known = await git(checkout, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`).catch(() => "");
    if (known !== "") await git(checkout, "checkout", "--quiet", "-B", branch, `refs/remotes/origin/${branch}`);
  }

  /** The runner's part: starts the issue's prototype branch, lets `agent` stand in for the agent's run, then bundles what it committed. */
  async function prototypeRun(agent: (dir: string) => Promise<void>): Promise<BuiltBranch> {
    await jobCheckout();
    const started = await startPrototypeBranch(checkout, 7);
    await agent(checkout);
    return bundleAgentBranch(checkout, started, outDir);
  }

  /** The push job's part: rebuilds the branch from the bundle, as for an Implement run. */
  const rebuilt = (built: BuiltBranch) =>
    rebuildAgentBranch(built, join(outDir, AGENT_BUNDLE_FILE), { serverUrl: `file://${root}`, repo: { owner: "acme", name: "shop" }, token: "unused" });

  it("is cut from the default branch for a first round, named for the issue, and reads back in the push job with the variants it committed", async () => {
    const built = await prototypeRun((dir) => commit(dir, { "src/pages/book.prototype.astro": "<!-- PROTOTYPE -->\n" }, "Three variants"));

    expect(built).toEqual({ name: "prototype/7", base: { ref: "main", sha: mainSha }, head: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const branch = await rebuilt(built);
    await branch.push(built.name);
    expect(paths(branch.changes.net)).toEqual(["src/pages/book.prototype.astro"]);
    expect(await git(remote, "rev-parse", "refs/heads/prototype/7")).toBe(built.head);
  });

  it("carries on a later round from the head an earlier round pushed, so the bundle holds only its own commits and the push is a fast-forward", async () => {
    const earlier = join(root, "earlier");
    await git(root, "clone", "--quiet", remote, earlier);
    await git(earlier, "checkout", "--quiet", "-b", "prototype/7");
    await commit(earlier, { "src/pages/book.prototype.astro": "<!-- PROTOTYPE round 1 -->\n" }, "Round 1");
    await git(earlier, "push", "--quiet", "origin", "prototype/7");
    const pushed = await git(earlier, "rev-parse", "HEAD");

    const built = await prototypeRun((dir) => commit(dir, { "src/pages/book.prototype.astro": "<!-- PROTOTYPE round 2 -->\n" }, "Round 2"));

    expect(built).toEqual({ name: "prototype/7", base: { ref: "prototype/7", sha: pushed }, head: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(await git(checkout, "rev-list", "--count", `${pushed}..${built.head!}`)).toBe("1");
    const branch = await rebuilt(built);
    await branch.push(built.name);
    expect(await git(remote, "rev-parse", "refs/heads/prototype/7")).toBe(built.head);
    expect(await git(remote, "merge-base", "--is-ancestor", pushed, built.head!).then(() => true)).toBe(true);
  });

  it("has no commit and no bundle when the turn built nothing", async () => {
    const built = await prototypeRun(async () => undefined);

    expect(built).toEqual({ name: "prototype/7", base: { ref: "main", sha: mainSha }, head: null });
    expect(existsSync(join(outDir, AGENT_BUNDLE_FILE))).toBe(false);
  });
});

describe("A prototype turn's result", () => {
  const branch = { name: "prototype/7", base: { ref: "main", sha: "a".repeat(40) }, head: "b".repeat(40) };
  const output = JSON.stringify({ kind: "prototype-round", intro: "Three takes.", variants: [], recommendation: "B." });

  // The push job reads the branch back from the bundle, and capture reads the head it was built at.
  it("is a design run's, which carries the branch its variants were committed on", () => {
    expect(readAgentRunResult(JSON.stringify({ role: "design", issue: 7, output, branch }))).toEqual({ role: "design", issue: 7, output, branch });
  });

  it("leaves an ordinary Design-session turn's result without a branch, as it was", () => {
    expect(readAgentRunResult(JSON.stringify({ role: "design", issue: 7, output: "{}" }))).toEqual({ role: "design", issue: 7, output: "{}" });
  });

  it("refuses a design result whose branch doesn't read", () => {
    expect(() => readAgentRunResult(JSON.stringify({ role: "design", issue: 7, output, branch: { name: "prototype/7" } }))).toThrow(
      new RegExp(`${AGENT_RESULT_FILE} has no valid branch`),
    );
  });
});
