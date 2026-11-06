// Entry point for the Kit's push job, its claim job and the Dispatch job:
// event + snapshot + config -> plan -> applied.
// Run with `node src/main.ts` (Node 24 strips the types).
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AGENT_FAILURE_FILE, readFailureReport } from "./agent/failure.ts";
import { AGENT_BUNDLE_FILE, AGENT_RESULT_FILE, readAgentRunResult } from "./agent/result.ts";
import { type AgentBranchGit, rebuildAgentBranch } from "./github/branch.ts";
import { agentBranchFor } from "./loop/agentPullRequest.ts";
import { applyPlan, wantsDesignQueueCheck, wantsDispatchCheck } from "./github/apply.ts";
import { GitHub, type Repo } from "./github/client.ts";
import { agentFailureEventFrom, agentRunEventFrom, auditEventFrom, loopEventFrom, retroEventFrom, reviewEventFrom } from "./github/events.ts";
import { gatherSnapshot, readKitConfigSources } from "./github/snapshot.ts";
import { callerWorkflowPath, checkKit } from "./kit/caller.ts";
import { resolveKitConfig } from "./kit/config.ts";
import { type Needs, pushJobInput, type PushJobInput } from "./kit/pushJob.ts";
import { readEvidenceBundle, RETRO_EVIDENCE_FILE } from "./kit/retroEvidence.ts";
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
      // Notes, such as what a Retro's landing dropped, change nothing on GitHub, so they follow the actions, set apart.
      return [...plan.actions.map(describeAction), ...(plan.notes === undefined ? [] : ["", ...plan.notes.map((note) => `- ${note}`)])].join("\n");
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
        action.assignees === undefined || action.assignees.length === 0 ? "" : `, assigned to ${action.assignees.join(", ")}`,
        action.parent === null
          ? ""
          : `, a sub-issue of ${typeof action.parent === "number" ? `#${action.parent}` : action.parent.created}`,
        action.blockedBy.length === 0
          ? ""
          : `, blocked by ${action.blockedBy.map((b) => (typeof b === "number" ? `#${b}` : b.created)).join(", ")}`,
      ].join("");
    case "add-blocked-by":
      return `- make #${action.issue} blocked by ${action.blocker.created}`;
    case "close-as-superseded":
      return `- close #${action.issue} as superseded`;
    case "start-agent-run":
      return `- a ${action.role} run on #${action.issue}${action.pullRequest === undefined ? "" : `, ${action.requestChanges === undefined ? "retrying" : "with the Operator's requested changes on"} #${action.pullRequest}`} (${action.model}), which the Kit job routes to its agent job`;
    case "hold-agent-run":
      return `- hold the ${action.role} run on #${action.issue}${action.until === null ? "" : ` until ${action.until}`}, starting no agent job`;
    case "drop-held-run":
      return `- drop the held ${action.role} run on #${action.issue} rather than resume it: ${action.reason}`;
    case "check-dispatch":
      return "- run a Dispatch check";
    case "check-design-queue":
      return "- run a Design queue check";
    case "link-preview":
      return `- link the preview deployment of ${action.pullRequest === null ? "the PR it opens" : `#${action.pullRequest}`} once it answers, or say it never answered`;
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
    case "react":
      return action.on.kind === "conversation"
        ? `- react ${action.content} to comment ${action.on.comment} on #${action.pullRequest}`
        : `- react ${action.content} to each inline comment of review ${action.on.review} on #${action.pullRequest}`;
  }
}

type EventSource = { event: LoopEvent | null; source: string; branch: AgentBranchGit | null };

/**
 * The Loop event this run applies: in the push job (FABRIK_NEEDS), what the
 * jobs before it left (src/kit/pushJob.ts); a Dispatch check in the Dispatch
 * job (FABRIK_DISPATCH_CHECK); a Design queue check in the Design queue job
 * (FABRIK_DESIGN_QUEUE_CHECK); otherwise the Actions event itself.
 */
async function loopEvent(repo: Repo): Promise<EventSource> {
  if (process.env["FABRIK_DISPATCH_CHECK"] === "true") {
    return { event: { kind: "dispatch-check" }, source: "a Dispatch check", branch: null };
  }
  if (process.env["FABRIK_DESIGN_QUEUE_CHECK"] === "true") {
    return { event: { kind: "design-queue-check" }, source: "a Design queue check", branch: null };
  }
  const eventName = required("GITHUB_EVENT_NAME");
  const payload = JSON.parse(await readFile(required("GITHUB_EVENT_PATH"), "utf8")) as Record<string, unknown>;
  const actionsEvent: EventSource = {
    event: loopEventFrom(eventName, payload),
    source: `${eventName}.${String(payload["action"] ?? "")}`,
    branch: null,
  };
  const needsText = process.env["FABRIK_NEEDS"];
  if (needsText === undefined || needsText === "") return actionsEvent;

  const eventIssue = (payload["issue"] as { number?: unknown } | undefined)?.number;
  // The reply that routed this run, read from the Actions event, which no agent can rewrite.
  const eventComment = actionsEvent.event?.kind === "issue-comment-created" ? actionsEvent.event.comment : null;
  const input = pushJobInput(
    JSON.parse(needsText) as Needs,
    typeof eventIssue === "number" ? eventIssue : null,
    eventComment,
  );
  // The agent job's artifacts, whichever it left (a result and bundle, or a failure report), as the push job downloads them.
  const agentDir = process.env["FABRIK_AGENT_DIR"] || join(required("RUNNER_TEMP"), "agent");
  switch (input.kind) {
    case "actions-event":
      return actionsEvent;
    case "nothing":
      return { event: null, source: input.reason, branch: null };
    case "agent-failure":
      return { ...(await failedRunEvent(input, join(agentDir, AGENT_FAILURE_FILE))), branch: null };
    case "review":
      return { ...(await finishedReviewEvent(input, join(agentDir, AGENT_RESULT_FILE))), branch: null };
    case "agent-result":
      return agentResultEvent(input, join(agentDir, AGENT_RESULT_FILE), repo);
  }
}

/**
 * The push job's event: the result an agent job passed out. The agent could
 * have rewritten that artifact, so its issue must be the one this run is for,
 * and an Implement run's branch is rebuilt from its bundle and checked here.
 */
async function agentResultEvent(
  input: Extract<PushJobInput, { kind: "agent-result" }>,
  resultPath: string,
  repo: Repo,
): Promise<EventSource> {
  const result = readAgentRunResult(await readFile(resultPath, "utf8"));
  if (result.role !== input.role) throw new Error(`The agent's result is a ${result.role} result, not ${input.role}`);
  if (result.issue !== input.issue) throw new Error(`The agent's result is for #${result.issue}, not #${input.issue}`);
  const source = `the ${result.role} run on #${result.issue}`;
  if (result.role === "audit") return { event: auditEventFrom(result, thisRunUrl(), thisRepoUrl()), source, branch: null };
  if (result.role === "retro") {
    // What the Retro was given comes from the evidence job's artifact, which the agent can't rewrite, never from its result.
    const evidenceDir = process.env["FABRIK_RETRO_EVIDENCE_DIR"] || join(required("RUNNER_TEMP"), "retro-evidence");
    const bundle = readEvidenceBundle(await readFile(join(evidenceDir, RETRO_EVIDENCE_FILE), "utf8"));
    return { event: retroEventFrom(result, bundle, thisRunUrl(), thisRepoUrl()), source, branch: null };
  }
  if (result.role !== "implement") {
    return { event: agentRunEventFrom(result, null, null, input.startedBy), source, branch: null };
  }

  const built = result.branch;
  if (built === undefined || built.name !== agentBranchFor(result.issue)) {
    throw new Error(`The Implement run on #${result.issue} didn't build ${agentBranchFor(result.issue)}`);
  }
  // A retry's PR, and whether it was a Request-changes run, come from the Kit job's plan, which the agent can't rewrite.
  const retry =
    input.pullRequest === null
      ? null
      : { pullRequest: input.pullRequest, runUrl: thisRunUrl(), requestChanges: input.review !== null };
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
  // The capture result and artifact ids come from the Implement job's outputs; the core decides whether the run is UI.
  const capture = input.capture ?? { result: null, artifact: null, galleryArtifact: null };
  const evidence = { ...capture, run: Number(required("GITHUB_RUN_ID")), repoUrl: thisRepoUrl() };
  return { event: agentRunEventFrom(result, branch.changes, retry, null, evidence), source, branch };
}

/** The routed agent job failed or was cancelled. Its failure report is missing when its timeout cancelled it. */
async function failedRunEvent(
  input: Extract<PushJobInput, { kind: "agent-failure" }>,
  reportPath: string,
): Promise<{ event: LoopEvent; source: string }> {
  const reportText = await readFile(reportPath, "utf8").catch(() => null);
  const event = agentFailureEventFrom({
    role: input.role,
    issue: input.issue,
    runUrl: thisRunUrl(),
    jobResult: input.jobResult,
    secretsStep: input.secretsStep,
    report: reportText === null ? null : readFailureReport(reportText),
    ...(input.subscription === undefined ? {} : { subscription: input.subscription }),
  });
  return { event, source: `the failed ${input.role} run on #${input.issue}` };
}

/** The Product repo's web address, which a pass's Follow-ups and an Audit's candidates open issues on, and a Retro's evidence links to. */
function thisRepoUrl(): string {
  return `${required("GITHUB_SERVER_URL")}/${required("GITHUB_REPOSITORY")}`;
}

/** This Actions run's attempt, which failure and Verdict comments link to. */
function thisRunUrl(): string {
  return [
    thisRepoUrl(),
    "actions/runs",
    required("GITHUB_RUN_ID"),
    "attempts",
    required("GITHUB_RUN_ATTEMPT"),
  ].join("/");
}

/** A Review's checks, from its checks job, and the Reviewer's result when green checks let it run. */
async function finishedReviewEvent(
  input: Extract<PushJobInput, { kind: "review" }>,
  resultPath: string,
): Promise<{ event: LoopEvent; source: string }> {
  const result = input.withResult ? readAgentRunResult(await readFile(resultPath, "utf8")) : null;
  const event = reviewEventFrom({
    pullRequest: input.pullRequest,
    headSha: input.headSha,
    runUrl: thisRunUrl(),
    repoUrl: thisRepoUrl(),
    failedChecks: input.failedChecks,
    result,
  });
  return {
    event,
    source: result === null ? `the red required checks on #${input.pullRequest}` : `the Review of #${input.pullRequest}`,
  };
}

async function report(text: string): Promise<void> {
  console.log(text);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") {
    await appendFile(summary, `### Fabrik Loop\n\n${text}\n`);
  }
}

/**
 * Loads and checks the Product repo's Kit config and caller workflow at the
 * commit this run is for. Returns null, having reported why, when either is invalid.
 */
async function loadKit(github: GitHub, repo: Repo): Promise<KitConfig | null> {
  const ref = required("GITHUB_SHA");
  const path = callerWorkflowPath(required("GITHUB_WORKFLOW_REF"), repo);
  const [sources, text] = await Promise.all([readKitConfigSources(github, repo, ref), github.fileText(repo, path, ref)]);
  const check = checkKit(resolveKitConfig(sources), { path, text });
  if (!check.ok) {
    for (const error of check.errors) console.log(`::error title=Invalid Kit config::${error}`);
    await report(`The Kit config is invalid, so the Loop did nothing:\n\n${check.errors.map((e) => `- ${e}`).join("\n")}`);
    return null;
  }
  return check.config;
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

  // Only the Dispatch job and loop.yml's Design queue job set it: their GITHUB_TOKEN, scoped to actions: read.
  // The scheduled tick's Design queue job has none, so its snapshot reads turns in progress from the issues.
  const actionsToken = process.env["FABRIK_ACTIONS_TOKEN"];
  const actions =
    actionsToken === undefined || actionsToken === "" ? null : new GitHub(actionsToken, process.env["GITHUB_API_URL"]);
  // The Fabrik App's bot login, so only the App's own issues count as its: a Design session keeps only their
  // Monitor marker, and only the App's Audits are read for their markers.
  const appLogin = `${required("FABRIK_APP_SLUG")}[bot]`;
  // Only the scheduled tick's run-loop step sets it, once it has found the Fabrik App on fabrik-runs: a token
  // that reads only the store's metadata, so the retro gate weighs whether the store is private.
  const storeToken = process.env["FABRIK_STORE_METADATA_TOKEN"];
  const store = storeToken === undefined || storeToken === "" ? null : new GitHub(storeToken, process.env["GITHUB_API_URL"]);
  const snapshot = await gatherSnapshot(github, repo, event, config.operator, appLogin, actions, store);
  const plan = planFor(event, snapshot, config);
  const { preview } = await applyPlan(github, repo, plan, branch);
  // The Dispatch job runs the check on a fresh snapshot, once this plan's labels have landed.
  if (wantsDispatchCheck(plan)) await appendFile(required("GITHUB_OUTPUT"), "dispatch=true\n");
  // The Design queue job runs the check likewise, once this plan has landed.
  if (wantsDesignQueueCheck(plan)) await appendFile(required("GITHUB_OUTPUT"), "design-queue=true\n");
  // The push job's preview step polls it and links it, once this plan has pushed (src/kit/previewLink.ts).
  if (preview !== null) {
    await appendFile(required("GITHUB_OUTPUT"), `preview-url=${preview.url}\npreview-pull-request=${preview.pullRequest}\n`);
  }
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
