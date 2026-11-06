// The capture step's program, run as loop.yml's Implement job runs it, in a
// Product repo without a ui block: now Visual evidence is on, the step runs on
// every Implement run, so it must leave such a repo exactly as it was before
// (#239). A repo with a ui block drives Playwright, which the Pilot exercises.
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
import { GALLERY_FILE } from "./capture.ts";

const run = promisify(execFile);
const KIT = resolve(import.meta.dirname, "..", "..");
const CAPTURE_MAIN = join(KIT, "src/evidence/capture-main.ts");
const STARTER = join(KIT, "templates/fabrik-config.json");

const TICKET = "Add a waitlist to full days on `/book`.";

/**
 * The Implement job as capture finds it once the agent has ended: a Product
 * checkout whose Kit config is the starter, which has no ui block, and an
 * Implementer that changed a page and named its route. The agent's runner
 * also holds a gallery the agent left where capture writes.
 */
async function anImplementJob() {
  const product = await tempDir("product");
  await mkdir(join(product, ".fabrik"));
  await writeFile(join(product, KIT_CONFIG_PATH), await readFile(STARTER, "utf8"));
  const out = await tempDir("fabrik-out");
  const result = {
    role: "implement",
    issue: 7,
    output: JSON.stringify({ title: "Waitlist", summary: "Adds a waitlist to full days.", routes: ["/book"] }),
    branch: { name: "fabrik/ticket-7", base: { ref: "main", sha: "a".repeat(40) }, head: "c".repeat(40) },
  };
  await writeFile(join(out, AGENT_RESULT_FILE), JSON.stringify(result));
  await writeFile(join(out, GALLERY_FILE), "<!doctype html><title>Planted by the agent</title>");
  const runner = await tempDir("runner");
  const files = {
    issue: join(runner, "issue.json"),
    outputs: join(runner, "github-output"),
    summary: join(runner, "step-summary"),
  };
  await writeFile(files.issue, JSON.stringify({ number: 7, body: TICKET }));
  await writeFile(files.outputs, "");
  await writeFile(files.summary, "");
  return { product, out, files };
}

describe("The capture step in a Product repo without a ui block", () => {
  it("captures nothing and gets only the Kit job's quiet step-summary line: no result passed out, so no upload, and no summary of its own", async () => {
    const { product, out, files } = await anImplementJob();

    // As loop.yml runs it, from the Product checkout; only what the step's env names, never the runner's own GitHub files.
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

    // An empty ui-evidence output: both uploads run only when it isn't (loop.yml).
    expect(await readFile(files.outputs, "utf8")).toBe("ui-evidence=\n");
    expect(await readFile(files.summary, "utf8")).toBe("");
    expect(stdout).toBe("");
    // Nothing built, served or screenshotted, and nothing of the agent's left to pass for evidence.
    expect(await readdir(out)).toEqual([AGENT_RESULT_FILE]);

    const resolved = resolveKitConfig({ config: await readFile(join(product, KIT_CONFIG_PATH), "utf8") });
    if (!resolved.ok) throw new Error(resolved.errors.join("; "));
    const { config } = resolved;
    const ticket = anIssue({ number: 7, body: TICKET, labels: ["ready-for-agent", "agent:implement"] });
    const plan = planFor({ kind: "label-added", issue: 7, label: "agent:implement" }, snapshotOf(ticket), config);
    const kitJob = kitJobSummary(plan, config, []) ?? "";
    expect(kitJob.split("\n").filter((line) => line.includes("Visual evidence"))).toEqual([
      "Visual evidence is off until Kit config has a `ui` block: `/fabrik-setup` turns it on.",
    ]);
  });
});
