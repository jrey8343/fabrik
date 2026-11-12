// The capture step's program, run as loop.yml's Implement job runs it, from a
// Product checkout of the agent's branch with the default branch fetched. In a
// repo without a ui block it must leave the repo exactly as it was before
// Visual evidence (#239). It reads the ui block from the default branch, never
// from the branch's own files. A capture that reaches the server drives
// Playwright, which the Pilot exercises; one that stops before it is tested here.
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { anIssue, snapshotOf } from "../__fixtures__/snapshots.ts";
import { tempDir } from "../__fixtures__/skillsArchive.ts";
import { AGENT_RESULT_FILE } from "../agent/result.ts";
import { KIT_CONFIG_PATH, resolveKitConfig } from "../kit/config.ts";
import { kitJobSummary } from "../kit/kitJob.ts";
import { planFor } from "../loop/rules.ts";
import { CAPTURE_RESULT_FILE, EVIDENCE_DIR, EVIDENCE_PAGE_FILE, PROTOTYPE_EVIDENCE_PAGE_FILE } from "./capture.ts";
import { parseCaptureResult } from "./uiEvidence.ts";

const run = promisify(execFile);
const KIT = resolve(import.meta.dirname, "..", "..");
const CAPTURE_MAIN = join(KIT, "src/evidence/capture-main.ts");
const STARTER = join(KIT, "templates/fabrik-config.json");

const TICKET = "Add a waitlist to full days on `/book`.";

/** The starter Kit config, which has no ui block, with this one. */
async function withUi(): Promise<string> {
  const starter = JSON.parse(await readFile(STARTER, "utf8")) as Record<string, unknown>;
  const ui = { paths: ["src/pages/**"], serve: "npm run preview", url: "http://127.0.0.1:4321", before_url: null, default_routes: [] };
  return `${JSON.stringify({ ...starter, ui }, null, 2)}\n`;
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "user.name=Fabrik test", "-c", "user.email=test@example.com", ...args], { cwd: dir });
  return stdout.trim();
}

/**
 * The Implement job as capture finds it once the agent has ended: a Product
 * checkout of the branch the Implementer left, which changed a page, cut from
 * a default branch whose Kit config was the starter, with that default
 * branch fetched as origin/main once its Kit config became `defaultConfig`.
 * The branch's own Kit config is `branchConfig`, the starter unless given. The
 * Ticket is `ticket`, and the Implementer named `routes`. The agent's runner
 * also holds an Evidence page the agent left where capture writes.
 */
async function anImplementJob({
  defaultConfig,
  branchConfig,
  ticket = TICKET,
  routes = ["/book"],
}: { defaultConfig?: string; branchConfig?: string; ticket?: string; routes?: string[] } = {}) {
  const starter = await readFile(STARTER, "utf8");
  const product = await tempDir("product");
  await git(product, "init", "-q", "-b", "main");
  await mkdir(join(product, ".fabrik"));
  await mkdir(join(product, "src/pages"), { recursive: true });
  await writeFile(join(product, KIT_CONFIG_PATH), starter);
  await writeFile(join(product, "src/pages/book.astro"), "<h1>Book</h1>\n");
  await git(product, "add", "-A");
  await git(product, "commit", "-q", "-m", "The starter");
  await git(product, "switch", "-q", "-c", "fabrik/ticket-7");
  await writeFile(join(product, "src/pages/book.astro"), "<h1>Book</h1>\n<p>Join the waitlist</p>\n");
  if (branchConfig !== undefined) await writeFile(join(product, KIT_CONFIG_PATH), branchConfig);
  await git(product, "commit", "-q", "-am", "A waitlist");
  const head = await git(product, "rev-parse", "HEAD");
  // The default branch moves on after the branch was cut, as when the ui block lands there.
  await git(product, "switch", "-q", "main");
  if (defaultConfig !== undefined) {
    await writeFile(join(product, KIT_CONFIG_PATH), defaultConfig);
    await git(product, "commit", "-q", "-am", "The Kit config moves on");
  }
  await git(product, "update-ref", "refs/remotes/origin/main", "HEAD");
  await git(product, "switch", "-q", "fabrik/ticket-7");

  const out = await tempDir("fabrik-out");
  const result = {
    role: "implement",
    issue: 7,
    output: JSON.stringify({ title: "Waitlist", summary: "Adds a waitlist to full days.", routes }),
    branch: { name: "fabrik/ticket-7", base: { ref: "main", sha: "a".repeat(40) }, head },
  };
  await writeFile(join(out, AGENT_RESULT_FILE), JSON.stringify(result));
  await writeFile(join(out, EVIDENCE_PAGE_FILE), "<!doctype html><title>Planted by the agent</title>");
  const runner = await tempDir("runner");
  const files = {
    issue: join(runner, "issue.json"),
    outputs: join(runner, "github-output"),
    summary: join(runner, "step-summary"),
  };
  await writeFile(files.issue, JSON.stringify({ number: 7, body: ticket }));
  await writeFile(files.outputs, "");
  await writeFile(files.summary, "");
  return { product, out, files, head };
}

/** Runs the capture step as loop.yml does, from the Product checkout; only what the step's env names, never the runner's own GitHub files. */
async function capture({ product, out, files }: Awaited<ReturnType<typeof anImplementJob>>): Promise<string> {
  const { stdout } = await run(process.execPath, [CAPTURE_MAIN], {
    cwd: product,
    env: {
      PATH: process.env["PATH"] ?? "",
      FABRIK_OUT_DIR: out,
      FABRIK_ISSUE_FILE: files.issue,
      FABRIK_DEFAULT_BRANCH: "main",
      GITHUB_OUTPUT: files.outputs,
      GITHUB_STEP_SUMMARY: files.summary,
    },
  });
  return stdout;
}

describe("The capture step in a Product repo without a ui block", () => {
  it("captures nothing and gets only the Kit job's quiet step-summary line: no result passed out, so no upload, and no summary of its own", async () => {
    const job = await anImplementJob();

    const stdout = await capture(job);

    // An empty ui-capture-result output: both uploads run only when it isn't (loop.yml).
    expect(await readFile(job.files.outputs, "utf8")).toBe("ui-capture-result=\n");
    expect(await readFile(job.files.summary, "utf8")).toBe("");
    expect(stdout).toBe("");
    // Nothing built, served or screenshotted, and nothing of the agent's left to pass for evidence.
    expect(await readdir(job.out)).toEqual([AGENT_RESULT_FILE]);

    const resolved = resolveKitConfig({ config: await readFile(join(job.product, KIT_CONFIG_PATH), "utf8") });
    if (!resolved.ok) throw new Error(resolved.errors.join("; "));
    const { config } = resolved;
    const ticket = anIssue({ number: 7, body: TICKET, labels: ["ready-for-agent", "agent:implement"] });
    const plan = planFor({ kind: "label-added", issue: 7, label: "agent:implement" }, snapshotOf(ticket), config);
    const kitJob = kitJobSummary(plan, config, []) ?? "";
    expect(kitJob.split("\n").filter((line) => line.includes("Visual evidence"))).toEqual([
      "Visual evidence is off until Kit config has a `ui` block: `/fabrik-visual-evidence` turns it on.",
    ]);
  });
});

// The push job reads the default branch's Kit config to say whether the PR is UI, so capture reads the same one.
describe("The Kit config the capture step reads", () => {
  it("is the default branch's: a branch cut before the ui block landed there is captured, as the push job finds it UI", async () => {
    // No route anywhere, so capture stops before it builds anything: what it records shows it found the branch UI.
    const job = await anImplementJob({ defaultConfig: await withUi(), ticket: "Add a waitlist to full days.", routes: [] });

    await capture(job);

    const failed = { outcome: "failed", reason: "no-routes", headSha: job.head, captures: [] };
    expect(parseCaptureResult(await readFile(join(job.out, EVIDENCE_DIR, CAPTURE_RESULT_FILE), "utf8"))).toEqual({ ok: true, result: failed });
    expect(await readFile(job.files.outputs, "utf8")).toBe(`ui-capture-result=${JSON.stringify(failed)}\n`);
  });

  it("is never the branch's own, which a branch can't use to turn capture on", async () => {
    const job = await anImplementJob({ branchConfig: await withUi(), ticket: "Add a waitlist to full days.", routes: [] });

    await capture(job);

    expect(await readFile(job.files.outputs, "utf8")).toBe("ui-capture-result=\n");
    expect(await readdir(job.out)).toEqual([AGENT_RESULT_FILE]);
  });
});

/**
 * The prototype job as capture finds it once the agent has ended: a Product
 * checkout of the issue's prototype branch, cut from a default branch whose
 * Kit config is `defaultConfig` (the starter's, which has no ui block, unless
 * given), fetched as origin/main, with the agent's result: the round it
 * output, and the head it left the branch at (none when it committed nothing).
 */
async function aPrototypeJob({ defaultConfig, output, committed = true }: { defaultConfig?: string; output: unknown; committed?: boolean }) {
  const product = await tempDir("product");
  await git(product, "init", "-q", "-b", "main");
  await mkdir(join(product, ".fabrik"));
  await mkdir(join(product, "src/pages"), { recursive: true });
  await writeFile(join(product, KIT_CONFIG_PATH), defaultConfig ?? (await readFile(STARTER, "utf8")));
  await writeFile(join(product, "src/pages/book.astro"), "<h1>Book</h1>\n");
  await git(product, "add", "-A");
  await git(product, "commit", "-q", "-m", "The default branch");
  const base = await git(product, "rev-parse", "HEAD");
  await git(product, "update-ref", "refs/remotes/origin/main", "HEAD");
  await git(product, "switch", "-q", "-c", "prototype/7");
  if (committed) {
    await writeFile(join(product, "src/pages/book.prototype.astro"), "<!-- PROTOTYPE -->\n");
    await git(product, "add", "-A");
    await git(product, "commit", "-q", "-m", "Three variants");
  }
  const head = await git(product, "rev-parse", "HEAD");

  const out = await tempDir("fabrik-out");
  const result = {
    role: "design",
    issue: 7,
    output: JSON.stringify(output),
    branch: { name: "prototype/7", base: { ref: "main", sha: base }, head: committed ? head : null },
  };
  await writeFile(join(out, AGENT_RESULT_FILE), JSON.stringify(result));
  await writeFile(join(out, PROTOTYPE_EVIDENCE_PAGE_FILE), "<!doctype html><title>Planted by the agent</title>");
  const runner = await tempDir("runner");
  const files = { outputs: join(runner, "github-output"), summary: join(runner, "step-summary") };
  await writeFile(files.outputs, "");
  await writeFile(files.summary, "");
  return { product, out, files, head };
}

/** Runs the capture step as loop.yml's prototype job does, from the Product checkout, given the Kit job's request through its env. */
async function capturePrototypeTurn({ product, out, files }: Awaited<ReturnType<typeof aPrototypeJob>>): Promise<string> {
  const { stdout } = await run(process.execPath, [CAPTURE_MAIN, "prototype"], {
    cwd: product,
    env: {
      PATH: process.env["PATH"] ?? "",
      FABRIK_OUT_DIR: out,
      FABRIK_DEFAULT_BRANCH: "main",
      FABRIK_PROTOTYPE_REQUEST: JSON.stringify({ route: "/book", variants: 3, brief: "Three layouts.", reply: null }),
      GITHUB_OUTPUT: files.outputs,
      GITHUB_STEP_SUMMARY: files.summary,
    },
  });
  return stdout;
}

const ROUND = {
  kind: "prototype-round",
  intro: "Three takes on the booking page.",
  variants: [
    { summary: "A calendar.", component: "src/components/prototype/BookVariantA.astro" },
    { summary: "A list.", component: "src/components/prototype/BookVariantB.astro" },
    { summary: "One button.", component: "src/components/prototype/BookVariantC.astro" },
  ],
  recommendation: "B.",
};

// A capture that reaches the server drives Playwright, which the Pilot exercises on a real UI issue.
describe("The capture step of a prototype turn", () => {
  it("records no-variants when the turn's output names none it can read, building nothing, and passes the result out", async () => {
    const job = await aPrototypeJob({ defaultConfig: await withUi(), output: { kind: "round", intro: "?", questions: [] } });

    await capturePrototypeTurn(job);

    const failed = { outcome: "failed", reason: "no-variants", headSha: job.head, captures: [] };
    expect(parseCaptureResult(await readFile(join(job.out, EVIDENCE_DIR, CAPTURE_RESULT_FILE), "utf8"))).toEqual({ ok: true, result: failed });
    expect(await readFile(job.files.outputs, "utf8")).toBe(`ui-capture-result=${JSON.stringify(failed)}\n`);
    expect(await readFile(job.files.summary, "utf8")).toBe(
      "### Prototype capture\n\nCapture failed (`no-variants`) after 0 screenshots; its log says where it stopped.\n",
    );
    // No Evidence page: the one the agent left where capture writes is gone.
    expect((await readdir(job.out)).sort()).toEqual([AGENT_RESULT_FILE, EVIDENCE_DIR].sort());
  });

  it("captures nothing when the turn committed nothing, and passes out no result, so no Evidence page is uploaded", async () => {
    const job = await aPrototypeJob({ defaultConfig: await withUi(), output: ROUND, committed: false });

    await capturePrototypeTurn(job);

    expect(await readFile(job.files.outputs, "utf8")).toBe("ui-capture-result=\n");
    expect(await readFile(job.files.summary, "utf8")).toBe("### Prototype capture\n\nNothing was captured: the prototype turn made no commit.\n");
    expect(await readdir(job.out)).toEqual([AGENT_RESULT_FILE]);
  });

  it("captures nothing in a repo whose default branch's Kit config has no ui block", async () => {
    const job = await aPrototypeJob({ output: ROUND });

    expect(await capturePrototypeTurn(job)).toBe("");
    expect(await readFile(job.files.outputs, "utf8")).toBe("ui-capture-result=\n");
    expect(await readdir(job.out)).toEqual([AGENT_RESULT_FILE]);
  });
});
