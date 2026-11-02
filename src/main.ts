// Entry point for a Kit push job: event + snapshot + config -> plan -> applied.
// Run with `node src/main.ts` (Node 24 strips the types).
import { appendFile, readFile } from "node:fs/promises";
import { readAgentRunResult } from "./agent/result.ts";
import {
  agentRunEventFrom,
  applyPlan,
  gatherSnapshot,
  GitHub,
  loopEventFrom,
  operatorFor,
  readKitConfigSources,
  type Repo,
} from "./github/adapter.ts";
import { checkCallerWorkflow } from "./kit/caller.ts";
import { resolveKitConfig } from "./kit/config.ts";
import { planFor } from "./loop/rules.ts";
import type { Action, KitConfig, LoopEvent, Plan } from "./loop/types.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function describe(plan: Plan): string {
  switch (plan.kind) {
    case "nothing":
      return `Nothing to do: ${plan.reason}`;
    case "fail":
      return `The run failed (${plan.failure} failure): ${plan.reason}`;
    case "act":
      return plan.actions.map(describeAction).join("\n");
  }
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case "add-labels":
      return `- add labels on #${action.issue}: ${action.labels.join(", ") || "(none new)"}`;
    case "remove-label":
      return `- remove label on #${action.issue}: ${action.label}`;
    case "comment":
      return `- comment on #${action.issue}`;
    case "edit-issue-body":
      return `- rewrite the body of #${action.issue}`;
    case "start-agent-run":
      return `- a ${action.role} run on #${action.issue}, which the Kit job routes to its agent job`;
  }
}

/**
 * The Loop event this run applies: an agent job's result when the push job was
 * handed one (FABRIK_AGENT_RESULT), otherwise the Actions event itself.
 */
async function loopEvent(
  eventName: string,
  payload: Record<string, unknown>,
): Promise<{ event: LoopEvent | null; source: string }> {
  const resultPath = process.env["FABRIK_AGENT_RESULT"];
  if (resultPath !== undefined && resultPath !== "") {
    const result = readAgentRunResult(await readFile(resultPath, "utf8"));
    return { event: agentRunEventFrom(result), source: `the ${result.role} run on #${result.issue}` };
  }
  return { event: loopEventFrom(eventName, payload), source: `${eventName}.${String(payload["action"] ?? "")}` };
}

async function report(text: string): Promise<void> {
  console.log(text);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") {
    await appendFile(summary, `### Fabrik Loop\n\n${text}\n`);
  }
}

/** The caller workflow's path in the Product repo, from `owner/repo/<path>@<ref>`. */
function callerWorkflowPath(repo: Repo): string {
  const workflowRef = required("GITHUB_WORKFLOW_REF");
  const prefix = `${repo.owner}/${repo.name}/`;
  const at = workflowRef.lastIndexOf("@");
  if (!workflowRef.startsWith(prefix) || at < prefix.length) {
    throw new Error(`GITHUB_WORKFLOW_REF is not ${prefix}<path>@<ref>: ${workflowRef}`);
  }
  return workflowRef.slice(prefix.length, at);
}

/**
 * Loads and validates the Product repo's Kit config and caller workflow at the
 * commit this run is for. Returns null, having reported why, when either is invalid.
 */
async function loadKit(github: GitHub, repo: Repo): Promise<KitConfig | null> {
  const ref = required("GITHUB_SHA");
  const callerPath = callerWorkflowPath(repo);
  const [sources, caller] = await Promise.all([
    readKitConfigSources(github, repo, ref),
    github.fileText(repo, callerPath, ref),
  ]);
  const errors: string[] = [];
  const resolved = resolveKitConfig(sources);
  if (!resolved.ok) errors.push(...resolved.errors);
  if (caller === null) {
    errors.push(`${callerPath} was not found at ${ref}`);
  } else {
    const pins = checkCallerWorkflow(caller);
    if (!pins.ok) errors.push(`${callerPath}: ${pins.error}`);
  }

  if (errors.length > 0 || !resolved.ok) {
    for (const error of errors) console.log(`::error title=Invalid Kit config::${error}`);
    await report(`The Kit config is invalid, so the Loop did nothing:\n\n${errors.map((e) => `- ${e}`).join("\n")}`);
    return null;
  }
  return resolved.config;
}

async function main(): Promise<void> {
  const [owner, name] = required("GITHUB_REPOSITORY").split("/");
  if (owner === undefined || name === undefined) {
    throw new Error("GITHUB_REPOSITORY is not owner/name");
  }
  const repo: Repo = { owner, name };
  // Only the Fabrik App's token: changes made with GITHUB_TOKEN don't start later workflows.
  const github = new GitHub(required("FABRIK_APP_TOKEN"), process.env["GITHUB_API_URL"]);

  // Every run validates the Kit config first, so an invalid one fails visibly.
  const config = await loadKit(github, repo);
  if (config === null) {
    process.exitCode = 1;
    return;
  }

  const eventName = required("GITHUB_EVENT_NAME");
  const payload = JSON.parse(await readFile(required("GITHUB_EVENT_PATH"), "utf8")) as Record<string, unknown>;
  const { event, source } = await loopEvent(eventName, payload);
  if (event === null) {
    await report(`Nothing to do: the Loop doesn't act on ${source}`);
    return;
  }

  const snapshot = await gatherSnapshot(github, repo, event, operatorFor(config, payload));
  const plan = planFor(event, snapshot, config);
  await applyPlan(github, repo, plan);
  await report(describe(plan));
  if (plan.kind === "fail") {
    console.log(`::error title=Infrastructure failure::${plan.reason}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
