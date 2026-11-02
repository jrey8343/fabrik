// The agent job's runner (ADR-0002): runs one AFK role's agent with Sandcastle
// on the runner VM (noSandbox), behind the metered-billing preflight and the
// init check, writes the step summary, and passes the role's structured output
// out as an artifact for the push job. It holds no GitHub write credential.
//   node <kit>/src/agent/run.ts triage
//
// Run from the Product checkout. Env:
//   FABRIK_ISSUE_FILE      JSON from `gh issue view --json number,title,body,author,labels,comments`
//   FABRIK_OUT_DIR         where to write agent-result.json and the agent log
//   CLAUDE_CODE_OAUTH_TOKEN, from the agent service account (ADR-0004)
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { claudeCode, Output, run } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { readIfPresent, readKitConfigFromCheckout } from "../kit/checkout.ts";
import type { KitConfig } from "../kit/config.ts";
import { readTriageOutput, type TriageOutput } from "../loop/triageOutput.ts";
import { CLAUDE_ARGS_ENV } from "../preflight/main.ts";
import { checkInitMessage } from "../preflight/meteredBilling.ts";
import { SKILLS_MARKER } from "../skills/fetch.ts";
import { AGENT_FAILURE_FILE, failureReportFor } from "./failure.ts";
import { AGENT_RESULT_FILE, type AgentRunResult } from "./result.ts";
import { initMessageOf, missingSkills, runSummary } from "./summary.ts";

const KIT_DIR = resolve(import.meta.dirname, "..", "..");

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/** The Kit config from the Product checkout, validated, or an error naming every problem. */
async function loadConfig(productDir: string): Promise<KitConfig> {
  const resolved = await readKitConfigFromCheckout(productDir);
  if (!resolved.ok) throw new Error(`The Kit config is invalid:\n${resolved.errors.map((e) => `- ${e}`).join("\n")}`);
  return resolved.config;
}

/** A Standard Schema over the Triage contract, so Sandcastle can ask the agent to fix a malformed output. */
const triageSchema: StandardSchemaV1<unknown, TriageOutput> = {
  "~standard": {
    version: 1,
    vendor: "fabrik",
    validate(value) {
      const result = readTriageOutput(value);
      return result.ok ? { value: result.output } : { issues: result.errors.map((message) => ({ message })) };
    },
  },
};

async function triagePrompt(config: KitConfig, issueText: string): Promise<string> {
  const template = await readFile(join(KIT_DIR, "prompts", "triage.md"), "utf8");
  const issue: unknown = JSON.parse(issueText);
  const parts = [template.trimEnd()];
  if (config.instructions.triage !== null) {
    parts.push(
      "## This Product repo's triage instructions",
      "The Operator wrote these for this repo. They refine the rules above but never loosen the five Fast-path tests.",
      config.instructions.triage.trimEnd(),
    );
  }
  parts.push("## The issue", "```json", JSON.stringify(issue, null, 2), "```");
  return `${parts.join("\n\n")}\n`;
}

/** The arguments Sandcastle's claudeCode() passes to `claude` (its buildPrintCommand), for the preflight. */
function claudeArgs(model: string, effort: string | null): string[] {
  return [
    "--print",
    "--verbose",
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--model",
    model,
    ...(effort === null ? [] : ["--effort", effort]),
    "-p",
    "-",
  ];
}

/** One onSandboxReady hook: the Product's setup, then the preflight last (Sandcastle runs hooks in parallel). */
function readyHook(setup: string | null): string {
  const preflight = `node ${JSON.stringify(join(KIT_DIR, "src", "preflight", "main.ts"))}`;
  return setup === null ? preflight : `(${setup}) && ${preflight}`;
}

async function writeSummary(text: string): Promise<void> {
  console.log(text);
  const path = process.env["GITHUB_STEP_SUMMARY"];
  if (path !== undefined && path !== "") await appendFile(path, text);
}

async function runTriage(): Promise<void> {
  const productDir = process.cwd();
  const outDir = resolve(required("FABRIK_OUT_DIR"));
  await mkdir(outDir, { recursive: true });
  const issueText = await readFile(required("FABRIK_ISSUE_FILE"), "utf8");
  const issueNumber = (JSON.parse(issueText) as { number?: unknown }).number;
  if (typeof issueNumber !== "number") throw new Error("FABRIK_ISSUE_FILE has no issue number");

  const config = await loadConfig(productDir);
  const role = config.roles.triage;

  // The agent inherits this process's env (noSandbox), so set what it needs here.
  process.env["PATH"] = [join(KIT_DIR, "node_modules", ".bin"), process.env["PATH"] ?? ""].join(delimiter);
  process.env["DISABLE_AUTOUPDATER"] = "1";
  process.env[CLAUDE_ARGS_ENV] = JSON.stringify(claudeArgs(role.model, role.effort));

  const lines: string[] = [];
  // null until the init message arrives, then the routes it refused (empty when it passed).
  const init: { refused: readonly string[] | null } = { refused: null };
  const abort = new AbortController();
  const timeoutMs = role.timeoutMinutes * 60_000;

  try {
    const result = await run({
      name: `triage-${issueNumber}`,
      agent: claudeCode(
        role.model,
        role.effort === null ? {} : { effort: role.effort as "low" | "medium" | "high" | "xhigh" | "max" },
      ),
      sandbox: noSandbox(),
      cwd: productDir,
      prompt: await triagePrompt(config, issueText),
      maxIterations: 1,
      output: Output.object({ tag: "triage", schema: triageSchema, maxRetries: 1 }),
      hooks: { sandbox: { onSandboxReady: [{ command: readyHook(config.sandbox.setup), timeoutMs }] } },
      signal: abort.signal,
      logging: {
        type: "file",
        path: join(outDir, "agent.log"),
        // Errors thrown here are swallowed by Sandcastle, so stop the run through the signal.
        onAgentStreamEvent(event) {
          if (event.type !== "raw") return;
          lines.push(event.line);
          if (init.refused === null && initMessageOf([event.line]) !== null) {
            const check = checkInitMessage(JSON.parse(event.line));
            init.refused = check.kind === "refuse" ? check.routes : [];
            if (check.kind === "refuse") abort.abort(new Error(check.routes.join("; ")));
          }
        },
      },
    });
    if (init.refused === null) throw new Error("The agent's stream had no init message, so its API key source is unchecked");
    if (init.refused.length > 0) throw new Error(`Refused at init: ${init.refused.join("; ")}`);

    const artifact: AgentRunResult = { role: "triage", issue: issueNumber, output: JSON.stringify(result.output) };
    await writeFile(join(outDir, AGENT_RESULT_FILE), `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`Triage sorted #${issueNumber}: ${result.output.category}, ${result.output.state}`);
  } catch (error) {
    for (const route of init.refused ?? []) console.log(`::error title=Metered-billing route::${route}`);
    // Left for the failure job, which posts the failure notice (loop.yml).
    const report = failureReportFor({ error, lines, initRefused: init.refused });
    await writeFile(join(outDir, AGENT_FAILURE_FILE), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`::error title=Infrastructure failure (${report.failure})::${report.detail}`);
    throw error;
  } finally {
    const pinnedSkills = await installedSkills(productDir);
    if (pinnedSkills === undefined) {
      console.log("::warning title=Skills not installed::No pinned skills were found in .claude/skills");
    } else {
      const missing = missingSkills(lines, pinnedSkills.names);
      if (missing.length > 0) {
        console.log(`::warning title=Pinned skills missing at init::${missing.join(", ")}`);
      }
    }
    await writeSummary(runSummary({ role: "triage", lines, ...(pinnedSkills === undefined ? {} : { pinnedSkills }) }));
  }
}

/** The skills src/skills/fetch.ts installed into the checkout, and the commit they came from. */
async function installedSkills(productDir: string): Promise<{ sha: string; names: string[] } | undefined> {
  const dir = join(productDir, ".claude", "skills");
  const sha = (await readIfPresent(join(dir, SKILLS_MARKER)))?.trim();
  if (sha === undefined || sha === "") return undefined;
  const entries = await readdir(dir, { withFileTypes: true });
  return { sha, names: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name) };
}

const roles: Record<string, () => Promise<void>> = { triage: runTriage };

const roleName = process.argv[2] ?? "";
const runner = roles[roleName];
if (runner === undefined) {
  console.error(`Usage: node src/agent/run.ts <${Object.keys(roles).join("|")}>`);
  process.exitCode = 2;
} else {
  runner().catch((error: unknown) => {
    console.log(`::error title=Agent run failed::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
