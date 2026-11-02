// Entry point for a Kit push job: event + snapshot + config -> plan -> applied.
// Run with `node src/main.ts` (Node 24 strips the types).
import { appendFile, readFile } from "node:fs/promises";
import { readFailureReport } from "./agent/failure.ts";
import { readAgentRunResult } from "./agent/result.ts";
import {
  agentFailureEventFrom,
  agentRunEventFrom,
  applyPlan,
  gatherSnapshot,
  GitHub,
  loopEventFrom,
  readKitConfigSources,
  type Repo,
} from "./github/adapter.ts";
import { checkCallerWorkflow } from "./kit/caller.ts";
import { resolveKitConfig } from "./kit/config.ts";
import { planFor } from "./loop/rules.ts";
import { AGENT_ROLES, type Action, type AgentRole, type KitConfig, type LoopEvent, type Plan } from "./loop/types.ts";

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
    case "assign":
      return `- assign #${action.issue} to ${action.assignee}`;
    case "close":
      return `- close #${action.issue} as ${action.reason.replace("_", " ")}`;
  }
}

/**
 * The Loop event this run applies: an agent job's result when the push job was
 * handed one (FABRIK_AGENT_RESULT), otherwise the Actions event itself.
 */
async function loopEvent(): Promise<{ event: LoopEvent | null; source: string }> {
  const failedRole = process.env["FABRIK_FAILED_ROLE"];
  if (failedRole !== undefined && failedRole !== "") return failedRunEvent(failedRole);
  const resultPath = process.env["FABRIK_AGENT_RESULT"];
  if (resultPath !== undefined && resultPath !== "") {
    const result = readAgentRunResult(await readFile(resultPath, "utf8"));
    return { event: agentRunEventFrom(result), source: `the ${result.role} run on #${result.issue}` };
  }
  const eventName = required("GITHUB_EVENT_NAME");
  const payload = JSON.parse(await readFile(required("GITHUB_EVENT_PATH"), "utf8")) as Record<string, unknown>;
  return { event: loopEventFrom(eventName, payload), source: `${eventName}.${String(payload["action"] ?? "")}` };
}

/**
 * The failure job's event: the agent job named by FABRIK_FAILED_ROLE failed or
 * was cancelled. FABRIK_AGENT_FAILURE is the report it left, which is missing
 * when its timeout cancelled it.
 */
async function failedRunEvent(role: string): Promise<{ event: LoopEvent; source: string }> {
  if (!AGENT_ROLES.includes(role as AgentRole)) throw new Error(`FABRIK_FAILED_ROLE is not an agent role: ${role}`);
  const issue = Number(required("FABRIK_FAILED_ISSUE"));
  if (!Number.isInteger(issue) || issue < 1) throw new Error("FABRIK_FAILED_ISSUE is not an issue number");
  const reportText = await readFile(required("FABRIK_AGENT_FAILURE"), "utf8").catch(() => null);
  const runUrl = [
    required("GITHUB_SERVER_URL"),
    required("GITHUB_REPOSITORY"),
    "actions/runs",
    required("GITHUB_RUN_ID"),
    "attempts",
    required("GITHUB_RUN_ATTEMPT"),
  ].join("/");
  const event = agentFailureEventFrom({
    role: role as AgentRole,
    issue,
    runUrl,
    jobResult: required("FABRIK_AGENT_JOB_RESULT"),
    secretsStep: process.env["FABRIK_SECRETS_STEP"] ?? "",
    report: reportText === null ? null : readFailureReport(reportText),
  });
  return { event, source: `the failed ${role} run on #${issue}` };
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

  const { event, source } = await loopEvent();
  if (event === null) {
    await report(`Nothing to do: the Loop doesn't act on ${source}`);
    return;
  }

  const snapshot = await gatherSnapshot(github, repo, event);
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
