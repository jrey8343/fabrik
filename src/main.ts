// Entry point for a Kit push job and the Dispatch job: event + snapshot +
// config -> plan -> applied.
// Run with `node src/main.ts` (Node 24 strips the types).
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readFailureReport } from "./agent/failure.ts";
import { AGENT_BUNDLE_FILE, readAgentRunResult } from "./agent/result.ts";
import { type AgentBranchGit, rebuildAgentBranch } from "./github/branch.ts";
import { agentBranchFor } from "./loop/agentPullRequest.ts";
import {
  agentFailureEventFrom,
  agentRunEventFrom,
  applyPlan,
  gatherSnapshot,
  GitHub,
  loopEventFrom,
  readKitConfigSources,
  type Repo,
  reviewEventFrom,
  wantsDispatchCheck,
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
    case "comment-linking":
      return `- comment on #${action.issue}`;
    case "close-pull-request":
      return `- close #${action.pullRequest} unmerged, keeping its branch`;
    case "assign":
      return `- assign #${action.issue} to ${action.assignee}`;
    case "close":
      return `- close #${action.issue} as ${action.reason.replace("_", " ")}`;
    case "open-issue":
      return `- open the issue "${action.title}"${action.assignees.length > 0 ? `, assigned to ${action.assignees.join(", ")}` : ""}`;
    case "edit-issue-body":
      return `- rewrite the body of #${action.issue}`;
    case "create-issue":
      return [
        `- create "${action.title}" (${action.labels.join(", ")})`,
        action.parent === null
          ? ""
          : `, a sub-issue of ${typeof action.parent === "number" ? `#${action.parent}` : action.parent.created}`,
        action.blockedBy.length === 0 ? "" : `, blocked by ${action.blockedBy.map((b) => b.created).join(", ")}`,
      ].join("");
    case "close-as-superseded":
      return `- close #${action.issue} as superseded`;
    case "start-agent-run":
      return `- a ${action.role} run on #${action.issue}${action.pullRequest === undefined ? "" : `, ${action.requestChanges === undefined ? "retrying" : "with the Operator's requested changes on"} #${action.pullRequest}`} (${action.model}), which the Kit job routes to its agent job`;
    case "check-dispatch":
      return "- run a Dispatch check";
    case "push-branch":
      return `- push ${action.branch}`;
    case "open-pull-request":
      return `- open a draft PR from ${action.head} to ${action.base} that closes #${action.issue}`;
    case "convert-to-draft":
      return `- put #${action.pullRequest} back in draft`;
    case "mark-ready-for-review":
      return `- take #${action.pullRequest} out of draft`;
    case "request-review":
      return `- request ${action.reviewer}'s review on #${action.pullRequest}`;
  }
}

/**
 * The Loop event this run applies: an agent job's result when the push job was
 * handed one (FABRIK_AGENT_RESULT), a Dispatch check in the Dispatch job
 * (FABRIK_DISPATCH_CHECK), otherwise the Actions event itself.
 */
async function loopEvent(
  repo: Repo,
): Promise<{ event: LoopEvent | null; source: string; branch: AgentBranchGit | null }> {
  if (process.env["FABRIK_DISPATCH_CHECK"] === "true") {
    return { event: { kind: "dispatch-check" }, source: "a Dispatch check", branch: null };
  }
  const failedRole = process.env["FABRIK_FAILED_ROLE"];
  if (failedRole !== undefined && failedRole !== "") return { ...(await failedRunEvent(failedRole)), branch: null };
  const reviewed = process.env["FABRIK_REVIEW_PULL_REQUEST"];
  if (reviewed !== undefined && reviewed !== "") return { ...(await finishedReviewEvent(reviewed)), branch: null };
  const resultPath = process.env["FABRIK_AGENT_RESULT"];
  if (resultPath !== undefined && resultPath !== "") return agentResultEvent(resultPath, repo);
  const eventName = required("GITHUB_EVENT_NAME");
  const payload = JSON.parse(await readFile(required("GITHUB_EVENT_PATH"), "utf8")) as Record<string, unknown>;
  return {
    event: loopEventFrom(eventName, payload),
    source: `${eventName}.${String(payload["action"] ?? "")}`,
    branch: null,
  };
}

/**
 * The push job's event: the result an agent job passed out. The agent could
 * have rewritten that artifact, so its issue must be the one this run is for,
 * and an Implement run's branch is rebuilt from its bundle and checked here.
 */
async function agentResultEvent(
  resultPath: string,
  repo: Repo,
): Promise<{ event: LoopEvent; source: string; branch: AgentBranchGit | null }> {
  const result = readAgentRunResult(await readFile(resultPath, "utf8"));
  const runIssue = Number(required("FABRIK_RUN_ISSUE"));
  if (result.issue !== runIssue) throw new Error(`The agent's result is for #${result.issue}, not #${runIssue}`);
  const source = `the ${result.role} run on #${result.issue}`;
  if (result.role !== "implement") return { event: agentRunEventFrom(result), source, branch: null };

  const built = result.branch;
  if (built === undefined || built.name !== agentBranchFor(result.issue)) {
    throw new Error(`The Implement run on #${result.issue} didn't build ${agentBranchFor(result.issue)}`);
  }
  // A retry's PR comes from the Kit job's plan, which the agent can't rewrite, and it builds on its own branch.
  const retried = process.env["FABRIK_RUN_PULL_REQUEST"] ?? "";
  // So is whether it was a Request-changes run: the Kit job's plan named the Operator's review.
  const requestChanges = (process.env["FABRIK_RUN_REVIEW"] ?? "") !== "";
  const retry = retried === "" ? null : { pullRequest: Number(retried), runUrl: thisRunUrl(), requestChanges };
  if (retry !== null && !(Number.isInteger(retry.pullRequest) && retry.pullRequest > 0)) {
    throw new Error("FABRIK_RUN_PULL_REQUEST is not a PR number");
  }
  if ((retry !== null) !== (built.base.ref === built.name)) {
    throw new Error(
      retry === null
        ? `The Implement run on #${result.issue} built on ${built.name} itself, but it isn't a retry`
        : `The retry on #${retry.pullRequest} didn't build on ${built.name}`,
    );
  }
  const branch = await rebuildAgentBranch(built, join(dirname(resultPath), AGENT_BUNDLE_FILE), {
    serverUrl: required("GITHUB_SERVER_URL"),
    repo,
    token: required("FABRIK_APP_TOKEN"),
  });
  return { event: agentRunEventFrom(result, branch.changes, retry), source, branch };
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
  const event = agentFailureEventFrom({
    role: role as AgentRole,
    issue,
    runUrl: thisRunUrl(),
    jobResult: required("FABRIK_AGENT_JOB_RESULT"),
    secretsStep: process.env["FABRIK_SECRETS_STEP"] ?? "",
    report: reportText === null ? null : readFailureReport(reportText),
  });
  return { event, source: `the failed ${role} run on #${issue}` };
}

/** This Actions run's attempt, which failure and Verdict comments link to. */
function thisRunUrl(): string {
  return [
    required("GITHUB_SERVER_URL"),
    required("GITHUB_REPOSITORY"),
    "actions/runs",
    required("GITHUB_RUN_ID"),
    "attempts",
    required("GITHUB_RUN_ATTEMPT"),
  ].join("/");
}

/**
 * A Review's push job: FABRIK_REVIEW_PULL_REQUEST is the PR, FABRIK_REVIEW_HEAD_SHA
 * and FABRIK_REVIEW_FAILED_CHECKS (a JSON list) come from its checks job, and
 * FABRIK_AGENT_RESULT is the Reviewer's result when green checks let it run.
 */
async function finishedReviewEvent(pullRequestText: string): Promise<{ event: LoopEvent; source: string }> {
  const pullRequest = Number(pullRequestText);
  if (!Number.isInteger(pullRequest) || pullRequest < 1) throw new Error("FABRIK_REVIEW_PULL_REQUEST is not a PR number");
  const failed: unknown = JSON.parse(process.env["FABRIK_REVIEW_FAILED_CHECKS"] || "[]");
  if (!Array.isArray(failed) || !failed.every((name) => typeof name === "string")) {
    throw new Error("FABRIK_REVIEW_FAILED_CHECKS is not a list of check names");
  }
  const resultPath = process.env["FABRIK_AGENT_RESULT"];
  const result =
    resultPath === undefined || resultPath === "" ? null : readAgentRunResult(await readFile(resultPath, "utf8"));
  const event = reviewEventFrom({
    pullRequest,
    headSha: required("FABRIK_REVIEW_HEAD_SHA"),
    runUrl: thisRunUrl(),
    failedChecks: failed as string[],
    result,
  });
  return { event, source: result === null ? `the red required checks on #${pullRequest}` : `the Review of #${pullRequest}` };
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

  const { event, source, branch } = await loopEvent(repo);
  if (event === null) {
    await report(`Nothing to do: the Loop doesn't act on ${source}`);
    return;
  }

  // Only the Dispatch job sets it: its GITHUB_TOKEN, scoped to actions: read.
  const actionsToken = process.env["FABRIK_ACTIONS_TOKEN"];
  const actions =
    actionsToken === undefined || actionsToken === "" ? null : new GitHub(actionsToken, process.env["GITHUB_API_URL"]);
  const snapshot = await gatherSnapshot(github, repo, event, config.operator, actions);
  const plan = planFor(event, snapshot, config);
  await applyPlan(github, repo, plan, branch);
  // The Dispatch job runs the check on a fresh snapshot, once this plan's labels have landed.
  if (wantsDispatchCheck(plan)) await appendFile(required("GITHUB_OUTPUT"), "dispatch=true\n");
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
