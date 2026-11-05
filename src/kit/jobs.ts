// The Kit job's step: checks the Product's Kit config and its caller
// workflow's Fabrik pins (read as data from a sparse checkout, never run), and
// its Extra skill picks against each pinned Skills source's manifest, so no
// agent starts on an invalid Kit; asks the Loop rules core what this event
// calls for; and tells the workflow which job it routes to and the settings its jobs
// need before they start, such as their timeout-minutes. Writes step outputs:
//   route                    "triage", "design", "implement", "review" or "audit" when the plan starts that agent run,
//                            "push" when the push job has something to apply,
//                            "none" when the plan is to do nothing
//   triage-timeout-minutes   the Triage role's Kit config timeout
//   design-timeout-minutes   the Design-session turn's Kit config timeout
//   implement-timeout-minutes the Implement role's Kit config timeout
//   review-timeout-minutes   the Review role's Kit config timeout
//   audit-timeout-minutes    the Auditor's Kit config timeout
//   pull-request, ticket     for a Review or a retry, the agent PR and the Ticket its branch was cut for;
//                            for a first Implement run, an empty PR and its Ticket; else empty
//   branch                   for a retry, the agent branch it builds on; else empty
//   review                   for a Request-changes run, the Operator's review id; else empty
//   audit-commit             for an Auditor run, the pending Audit's marked commit, which the Audit job
//                            checks out; else empty
//   model, effort            the model and effort the plan chose for its agent run (a Step-up, say),
//                            empty when it starts none or leaves effort to the CLI
//   retry                    for an Implement run, its Retry number (0 for a first or Request-changes run); else empty
//   step-up, request-changes "true" when the run Steps up, or is the Operator's Request-changes run; else "false"
//   dispatch-timeout-minutes the Dispatch job's Kit config timeout
//   node src/kit/jobs.ts <product checkout>
// Env: GH_TOKEN, a read-only token for gathering the snapshot.
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentRunIn } from "../github/apply.ts";
import { GitHub, type Repo } from "../github/client.ts";
import { loopEventFrom } from "../github/events.ts";
import { gatherSnapshot } from "../github/snapshot.ts";
import { agentBranchFor } from "../loop/agentPullRequest.ts";
import { planFor } from "../loop/rules.ts";
import type { Plan } from "../loop/types.ts";
import { kitConfigErrors } from "../skills/pinnedManifests.ts";
import { callerWorkflowPath, checkKit } from "./caller.ts";
import { readIfPresent, readKitConfigFromCheckout } from "./checkout.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

function routeOf(plan: Plan): string {
  const run = agentRunIn(plan);
  if (run !== null) return run.role;
  return plan.kind === "nothing" ? "none" : "push";
}

/** This Kit checkout, which holds the Base skills' lock and the Kit's own skills. */
const KIT_DIR = resolve(import.meta.dirname, "..", "..");

async function main(productDir: string): Promise<void> {
  const [owner, name] = required("GITHUB_REPOSITORY").split("/");
  const repo: Repo = { owner: owner ?? "", name: name ?? "" };
  // The same check as every push job's, first, so no agent starts on an invalid Kit.
  const callerPath = callerWorkflowPath(required("GITHUB_WORKFLOW_REF"), repo);
  const [resolved, callerText] = await Promise.all([
    readKitConfigFromCheckout(productDir),
    readIfPresent(join(productDir, callerPath)),
  ]);
  const check = checkKit(resolved, { path: callerPath, text: callerText });
  // The Extra skill picks against each pinned source's manifest, before routing
  // any agent run; it reads nothing when the Product pins no Skills source.
  const errors = await kitConfigErrors(check, { kitDir: KIT_DIR });
  if (!check.ok || errors.length > 0) {
    for (const error of errors) console.log(`::error title=Invalid Kit config::${error}`);
    process.exitCode = 1;
    return;
  }
  const { config } = check;

  const eventName = required("GITHUB_EVENT_NAME");
  const payload = JSON.parse(await readFile(required("GITHUB_EVENT_PATH"), "utf8")) as Record<string, unknown>;
  const event = loopEventFrom(eventName, payload);
  let route = "none";
  let run: ReturnType<typeof agentRunIn> = null;
  let ticket: number | null = null;
  if (event === null) {
    console.log(`The Loop doesn't act on ${eventName}.${String(payload["action"] ?? "")}`);
  } else {
    const github = new GitHub(required("GH_TOKEN"), process.env["GITHUB_API_URL"]);
    // This job only routes, with no Fabrik App token, so it doesn't know the App's login and takes any bot's
    // issue for the App's, so the App's pending Audit routes to its Auditor run: the push job's plan is the one applied.
    // Another bot's look-alike pending Audit so costs one Auditor run, whose result the push job drops (byAppOf).
    const snapshot = await gatherSnapshot(github, repo, event, config.operator, null);
    const plan = planFor(event, snapshot, config);
    if (plan.kind === "nothing") console.log(`Nothing to do: ${plan.reason}`);
    route = routeOf(plan);
    run = agentRunIn(plan);
    ticket = snapshot.pullRequest?.ticket ?? null;
  }
  // A Review's subject is the PR itself; a retry is an Implement run on the Ticket that fixes its PR.
  const pullRequest = run?.role === "review" ? run.issue : (run?.pullRequest ?? null);
  if (run?.role === "implement") ticket = run.issue;

  const outputs = {
    route,
    "triage-timeout-minutes": String(config.roles.triage.timeoutMinutes),
    "design-timeout-minutes": String(config.roles.design.timeoutMinutes),
    "implement-timeout-minutes": String(config.roles.implement.timeoutMinutes),
    "review-timeout-minutes": String(config.roles.review.timeoutMinutes),
    "audit-timeout-minutes": String(config.roles.audit.timeoutMinutes),
    "pull-request": pullRequest === null ? "" : String(pullRequest),
    ticket: (run?.role === "review" || run?.role === "implement") && ticket !== null ? String(ticket) : "",
    // A retry checks out its PR's branch; a first Implement run cuts it from the default branch.
    branch: run?.role === "implement" && run.pullRequest !== undefined ? agentBranchFor(run.issue) : "",
    // A Request-changes run's input: the Operator's review on the PR.
    review: run?.requestChanges === undefined ? "" : String(run.requestChanges.review),
    // An Auditor run reads the Product repo up to the commit its pending Audit marks.
    "audit-commit": run?.role === "audit" ? (run.commit ?? "") : "",
    model: run?.model ?? "",
    effort: run?.effort ?? "",
    // Which run it is, for its Run record: nothing reads these before the push job writes one.
    retry: run?.role === "implement" ? String(run.retry ?? 0) : "",
    "step-up": String(run?.stepUp === true),
    "request-changes": String(run?.requestChanges !== undefined),
    "dispatch-timeout-minutes": String(config.roles.dispatch.timeoutMinutes),
  };
  await appendFile(
    required("GITHUB_OUTPUT"),
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
  console.log(`Route: ${route}`);
}

const productDir = process.argv[2];
if (productDir === undefined) {
  console.error("Usage: node src/kit/jobs.ts <product checkout>");
  process.exitCode = 2;
} else {
  main(productDir).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
