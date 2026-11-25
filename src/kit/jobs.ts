// The Kit job's step: checks the Product's Kit config and its caller
// workflow's Fabrik pins (read as data from a sparse checkout, never run), and
// its Extra skill picks against each pinned Skills source's manifest, so no
// agent starts on an invalid Kit; on a pull request that changes the caller,
// a bump of its pin say, checks the caller it proposes against the workflows
// at the release it pins and fails naming any job that grants too little
// (#422); asks the Loop rules core what this event calls for; and tells the
// workflow which job it routes to and the settings its jobs need before they
// start, such as their timeout-minutes. Writes step outputs:
//   route                    "triage", "design", "implement", "review", "audit", "retro", "research" or "digest" when the
//                            plan starts that agent run (a Retro run's evidence job, then its Retro job),
//                            "replay" when it starts a replay Ticket's two arms (#156), its claim and then
//                            its replay jobs,
//                            "rerun-checks" when agent:rerun-checks asks one more re-run at the Merge gate (#783),
//                            its claim and then the Re-run red checks job, with no agent and no push job,
//                            "push" when the push job has something to apply,
//                            "none" when the plan is to do nothing
//   triage-timeout-minutes   the Triage role's Kit config timeout
//   design-timeout-minutes   the Design-session turn's Kit config timeout
//   implement-timeout-minutes the Implement role's Kit config timeout, which its agent step stops at
//   implement-job-timeout-minutes the Implement job's: that, plus UI evidence capture's and room for its other steps
//   review-timeout-minutes   the Review role's Kit config timeout
//   audit-timeout-minutes    the Auditor's Kit config timeout
//   retro-timeout-minutes    the Retro's Kit config timeout
//   research-timeout-minutes the Researcher's Kit config timeout
//   digest-timeout-minutes   the Digest writer's Kit config time limit
//   pull-request, ticket     for a Review, a Digest run or a retry, the agent PR and the Ticket its branch was cut for;
//                            for a first Implement run, an empty PR and its Ticket; for a replay, its merged
//                            PR and the Ticket it replays; else empty
//   replay-issue, base-sha   for a replay, the replay issue and the Ticket's baseSha, which both arms start
//                            from; else empty
//   replay-arms              for a replay, each arm's settings as one line of JSON, {baseline, variant}, each
//                            {implement: {model, effort}, review: {model, effort}, candidateSha}; else empty.
//                            Its model names come from the replay issue's body, so a job reads it only
//                            through `env:`, never in a `run:` script
//   allow-fable              for a replay, "true" when this repo's Kit config opts in to Fable (ADR-0034), which
//                            each arm's run holds its model to, as Kit config at baseSha can predate it; else empty
//   replay-kit-sha-unavailable for a replay whose variant's candidate Kit sha this job read and couldn't lay
//                            (src/kit/overlay.ts), why, so neither arm runs and the replay-record job fails
//                            the Ticket once (#449); else empty
//   branch                   for a retry or a Kept-branch start (#536), the agent branch it builds on; else empty
//   kept-branch              "true" for a Kept-branch start (#536), else "false"
//   kept-pull-request        for a Kept-branch start, the PR the Kit closed whose branch it carries on; else empty
//   default-branch           for a Kept-branch start, the default branch its PR opens against; else empty
//   review                   for a Request-changes run, the Operator's review id; else empty
//   conflict                 for a conflict-only run (#304), the default branch head it rebases the PR's
//                            branch onto, a full sha; else empty
//   main-at-start            for an Implement run on an agent PR's branch or a Kept-branch start, the default branch head this job
//                            read before the run started (#341), a full sha; else empty
//   audit-commit             for an Auditor run, the pending Audit's marked commit, which the Audit job
//                            checks out; else empty
//   head-sha                 for a Digest run, the head its pass was given on, a full sha, which the Digest job
//                            checks out and the push job lands the Digest for; for one more re-run at the Merge
//                            gate (#783), the head whose checks it re-runs; else empty
//   rerun-red                for one more re-run at the Merge gate (#783), the checks to re-run as one line of JSON in
//                            the Review checks job's `red` shape, {rerun: [{name, link, run}], outside: []}, which the
//                            Re-run red checks job reads through `env:`, as the names come from the Product's CI; else empty
//   model, effort            the model and effort the plan chose for its agent run (a Step-up, say),
//                            empty when it starts none or leaves effort to the CLI
//   retry                    for an Implement run, its Retry number (0 for a first or Request-changes run); else empty
//   touch-up                 for an Implement run, its Touch-up number (#750; 0 for any other run); else empty
//   retry-flaw               for a Retry or Touch-up on an agent PR, the head its Execution flaw was given on (#341); else empty
//   step-up, request-changes "true" when the run Steps up, or is the Operator's Request-changes run; else "false"
//   step-up-reason           why the run Steps up: retry, marked, request-changes or conflict-only; else empty
//   dispatch-timeout-minutes the Dispatch job's Kit config timeout
//   subscription             the Subscription the plan's agent run is given: the `Fabrik` vault item
//                            its job loads the Claude token from; empty when it starts none
//   rotation                 "true" when two or more Subscriptions are listed, so rotation is on; else "false"
//   ui-evidence-run          for a Review of a UI PR, the Implement run its UI evidence marker names; else empty
//   ui-evidence-artifact     for that Review, the run's artifact of the screenshots and capture result,
//                            which the Review job downloads; empty when it kept none, or for any other run
//   ui-evidence-failure      for that Review, why the run's capture failed, as the marker records it, which
//                            the Reviewer hears when it has no capture result to read; empty when it captured,
//                            when the marker records no outcome, or for any other run
//   ui-shots                 for a Review of a UI PR on a Product repo that uses Evidence shots (#820), what the
//                            Review job collects the head's shots by, as one line of JSON: the check and artifact
//                            Kit config names, the PR's names and sentence that nothing visible changes, and the
//                            head a miss is sent back at. Agent text, so a job reads it through `env:`; else empty
//   full-review             for a Review, "true" on a Full Review (#747), else "false"; empty for any other run
//   last-judged-head         for a later Review (#748), the head the Reviewer last judged; else empty
//   last-judged-change       for that Review, the change fingerprint its Verdict recorded, as one line of JSON,
//                            whose paths are the PR's file names, so a job reads it through `env:`; else empty
//   prototype                "true" when the Design run is a Design session's prototype turn (#155), which
//                            routes to design like any Design run; else "false"
//   prototype_request        for that prototype turn, its request as one line of JSON: route, variants, brief
//                            and reply (the Operator's reply that started the turn which asked for it, or null);
//                            else empty. The only output that holds agent text, the brief, so a job reads it
//                            through `env:`, never in a `run:` script
//   kit-said                 what this job routed, held and declined included, as one line of JSON
//                            (src/kit/kitSaid.ts, #616): the route, the agent run's role, issue, pull request,
//                            kind, Retry number and model, the runs held and a replay's issue and Ticket. It
//                            holds no text a person or an agent wrote. The job's last step takes it for its name
// Its step summary names that Subscription, and notes when rotation is off.
//   node src/kit/jobs.ts <product checkout>
// Env: GH_TOKEN, a read-only token for gathering the snapshot, which for agent:implement also reads the Actions runs (#725),
// and which on a review's hand-off first reads the review its inputs name (src/github/handOff.ts);
// FABRIK_STORE_DIR, in a repo that opted in to Fable, the fable-store action's checkout of the store, whose Fable cap
// readings the plan weighs (ADR-0034), empty when it couldn't check one out, which the step summary then says.
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentRunIn, replayRunIn } from "../github/apply.ts";
import { GitHub, type Repo } from "../github/client.ts";
import { nothingToDoFor, runEventFrom } from "../github/handOff.ts";
import { defaultBranchOf, gatherSnapshot } from "../github/snapshot.ts";
import { agentBranchFor } from "../loop/agentPullRequest.ts";
import { DISPATCH_LABEL } from "../loop/labels.ts";
import { prototypeRequestJson } from "../loop/markers.ts";
import { planFor } from "../loop/rules.ts";
import { type Action, isOfPullRequest, type Plan } from "../loop/types.ts";
import { kitConfigErrors } from "../skills/pinnedManifests.ts";
import { callerWorkflowPath, checkKit } from "./caller.ts";
import { callerChangeErrors } from "./callerPermissions.ts";
import { readIfPresent, readKitConfigFromCheckout } from "./checkout.ts";
import type { KitConfig } from "./config.ts";
import { fableCapReadingsOf } from "./fableCapFacts.ts";
import { configuredModelOf, type FableCapReading } from "../loop/fableCap.ts";
import { readStoreRunRecords } from "./storeCheckout.ts";
import { kitJobSummary, subscriptionOf } from "./kitJob.ts";
import { kitSaidOf, routeOf } from "./kitSaid.ts";
import { readCandidate } from "./overlay.ts";
import { rotationIsOn } from "../loop/subscriptions.ts";
import { implementJobTimeoutMinutes } from "../evidence/capture.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/** The head a pull_request_target run was opened, pushed or reopened at, whose caller workflow it proposes; null for any other event. */
function pullRequestHeadOf(eventName: string, payload: Record<string, unknown>): string | null {
  if (eventName !== "pull_request_target") return null;
  const action = payload["action"];
  if (action !== "opened" && action !== "synchronize" && action !== "reopened") return null;
  const pullRequest = payload["pull_request"] as { head?: { sha?: unknown } } | undefined;
  return typeof pullRequest?.head?.sha === "string" ? pullRequest.head.sha : null;
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
  // A pull request that changes the caller workflow, a Dependabot bump of its pin say (#422): the caller it proposes
  // must grant what the workflows at the release it pins ask for, or GitHub fails every run at startup once it
  // merges, saying nothing. Checked here, with the base branch's Kit, so the PR's check names the gap before the merge.
  const github = new GitHub(required("GH_TOKEN"), process.env["GITHUB_API_URL"]);
  const headSha = pullRequestHeadOf(eventName, payload);
  if (headSha !== null) {
    const callerErrors = await callerChangeErrors(github, repo, { path: callerPath, baseText: callerText, headSha });
    if (callerErrors.length > 0) {
      for (const error of callerErrors) console.log(`::error title=Caller workflow::${error}`);
      const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
      if (summaryPath !== undefined && summaryPath !== "") {
        await appendFile(summaryPath, `### Fabrik Kit job\n\nThis pull request's ${callerPath} can't merge as it is:\n\n${callerErrors.map((error) => `- ${error}`).join("\n")}\n`);
      }
      process.exitCode = 1;
      return;
    }
  }
  // On a review's hand-off the inputs are believed for nothing: this job reads the review they name with its own
  // read-only token before it plans, and plans what that review's own event would have, or nothing (src/github/handOff.ts).
  const { event, handOff } = await runEventFrom(github, repo, config.operator, eventName, payload);
  let plan: Plan | null = null;
  let ticket: number | null = null;
  let summary: string | null = null;
  let mainAtStart: string | null = null;
  let defaultBranch: string | null = null;
  if (event === null) {
    console.log(handOff === null ? `The Loop doesn't act on ${eventName}.${String(payload["action"] ?? "")}` : nothingToDoFor(handOff));
  } else {
    // This job only routes, with no Fabrik App token, so it doesn't know the App's login and takes any bot's
    // issue for the App's, so the App's pending Audit or Retro routes to its run: the push job's plan is the one applied.
    // Another bot's look-alike pending Audit or Retro so costs one run, whose result the push job drops (byAppOf).
    // agent:implement's start check reads the Implement runs still landing on the Ticket (#725) with this job's token,
    // which holds actions: read; no other event's snapshot reads the Actions runs here, so none plans other than before.
    // A caller that grants no actions: read fails the read, and the run starts as before.
    const actions = event.kind === "label-added" && event.label === DISPATCH_LABEL ? github : null;
    // In a repo that opted in to Fable, the store's Fable cap readings, from the fable-store action's checkout (ADR-0034).
    const storeFableCaps = config.allowFable ? await storeFableCapsAt(process.env["FABRIK_STORE_DIR"], config) : { caps: [], unread: false };
    const snapshot = await gatherSnapshot(github, repo, event, config.operator, null, actions, { storeFableCaps: storeFableCaps.caps });
    plan = planFor(event, snapshot, config);
    if (plan.kind === "nothing") console.log(`Nothing to do: ${plan.reason}`);
    summary = kitJobSummary(plan, config, snapshot.kitIssues, { storeUnread: storeFableCaps.unread });
    ticket = snapshot.pullRequest?.ticket ?? null;
    // A run on an agent PR's branch may bring main in: the push job takes main as this job read it, before the
    // run started, for one of the heads it may have brought in (#341), as the agent job can't write this job's outputs.
    // A Kept-branch start (#536) brings main in too, and opens its PR against the default branch, which the push job
    // takes from here, by name, as it can't from the branch the run built on.
    const run = agentRunIn(plan);
    if (run?.role === "implement" && (run.pullRequest !== undefined || run.keptBranch !== undefined)) {
      const main = await defaultBranchOf(github, repo);
      mainAtStart = main?.head ?? null;
      if (run.keptBranch !== undefined) defaultBranch = main?.name ?? null;
    }
  }
  const outputs = { ...kitJobOutputs(plan, ticket, config, mainAtStart, defaultBranch), ...(await candidateOutputs(plan, github)) };
  await appendFile(
    required("GITHUB_OUTPUT"),
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
  console.log(`Route: ${outputs["route"]}`);
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== null && summaryPath !== undefined && summaryPath !== "") await appendFile(summaryPath, summary);
}

/**
 * The Fable cap readings in the store's checkout at `dir` (fableCapReadingsOf),
 * a schema 1 record as on the first listed Subscription, or none, unread, when
 * there's no checkout, as when the Fabrik App isn't on the store, or it can't
 * be read: every Subscription then counts as having Fable left (ADR-0034).
 */
async function storeFableCapsAt(dir: string | undefined, config: KitConfig): Promise<{ caps: readonly FableCapReading[]; unread: boolean }> {
  if (dir === undefined || dir === "") return { caps: [], unread: true };
  try {
    return { caps: fableCapReadingsOf(Object.values((await readStoreRunRecords(dir, config.subscriptions)).records)), unread: false };
  } catch (error) {
    console.log(`::warning title=Fable cap readings unread::${error instanceof Error ? error.message : String(error)}`);
    return { caps: [], unread: true };
  }
}

/**
 * The Kit job's step outputs, as the header lists them: where `plan` routes
 * (null for an event the Loop doesn't act on), every role's timeout, and what
 * the routed agent job needs before it starts. `ticket` is the Ticket the
 * snapshot's PR was cut for, if it has one.
 */
export function kitJobOutputs(
  plan: Plan | null,
  ticket: number | null,
  config: KitConfig,
  mainAtStart: string | null = null,
  defaultBranch: string | null = null,
): Readonly<Record<string, string>> {
  const run = plan === null ? null : agentRunIn(plan);
  const replay = plan === null ? null : replayRunIn(plan);
  // A Review's subject is the PR itself, as a Digest run's is; a retry is an Implement run on the Ticket that fixes its PR.
  const onPullRequest = isOfPullRequest(run?.role);
  const pullRequest = run !== null && onPullRequest ? run.issue : (run?.pullRequest ?? null);
  const builds = run?.role === "implement" ? run.issue : ticket;
  // The closing step's line: what this job routed, held and declined included, as one line of JSON (#616).
  const said = JSON.stringify(kitSaidOf(plan, ticket));
  // One more re-run at the Merge gate (#783) starts no agent: the Re-run red checks job re-runs the checks the Kit's line asked.
  const rerun = plan?.kind === "act" ? plan.actions.find((action): action is Extract<Action, { kind: "rerun-checks" }> => action.kind === "rerun-checks") : undefined;
  if (replay !== null) return { ...kitJobOutputs(null, null, config), ...replayOutputs(replay, config), "kit-said": said };
  return {
    route: routeOf(plan),
    "triage-timeout-minutes": String(config.roles.triage.timeoutMinutes),
    "design-timeout-minutes": String(config.roles.design.timeoutMinutes),
    "implement-timeout-minutes": String(config.roles.implement.timeoutMinutes),
    "implement-job-timeout-minutes": String(implementJobTimeoutMinutes(config.roles.implement.timeoutMinutes)),
    "review-timeout-minutes": String(config.roles.review.timeoutMinutes),
    "audit-timeout-minutes": String(config.roles.audit.timeoutMinutes),
    // Both of a Retro run's jobs, its evidence job and its Retro job, run within it.
    "retro-timeout-minutes": String(config.roles.retro.timeoutMinutes),
    "research-timeout-minutes": String(config.roles.research.timeoutMinutes),
    "digest-timeout-minutes": String(config.roles.digest.timeoutMinutes),
    "pull-request": rerun !== undefined ? String(rerun.pullRequest) : pullRequest === null ? "" : String(pullRequest),
    ticket: (onPullRequest || run?.role === "implement") && builds !== null ? String(builds) : "",
    // A retry, and a Kept-branch start (#536), check out the Ticket's agent branch; any other first Implement run cuts it
    // from the default branch.
    branch: run?.role === "implement" && (run.pullRequest !== undefined || run.keptBranch !== undefined) ? agentBranchFor(run.issue) : "",
    // A Kept-branch start (#536): the agent job carries on the branch on this, never on the checkout, and the push job
    // lands it as a first run that carried on, naming the closed PR, against the default branch.
    "kept-branch": String(run?.role === "implement" && run.keptBranch !== undefined),
    "kept-pull-request": String(run?.keptBranch?.pullRequest ?? ""),
    "default-branch": run?.keptBranch === undefined ? "" : (defaultBranch ?? ""),
    // A Request-changes run's input: the Operator's review on the PR.
    review: run?.requestChanges === undefined ? "" : String(run.requestChanges.review),
    // A conflict-only run's main head, which its prompt names and its push job's event carries.
    conflict: run?.conflict?.main ?? "",
    // For a run on an agent PR's branch: main's head as this job read it, before the run started (#341).
    "main-at-start": mainAtStart ?? "",
    // An Auditor run reads the Product repo up to the commit its pending Audit marks.
    "audit-commit": run?.role === "audit" ? (run.commit ?? "") : "",
    // A Digest run reads the PR at the head its pass was given on, and its Digest lands only while that is still the PR's head.
    "head-sha": run?.role === "digest" ? (run.headSha ?? "") : (rerun?.headSha ?? ""),
    // Only ever names and links the Kit's own line recorded, read only through `env:`.
    "rerun-red": rerun === undefined ? "" : JSON.stringify({ rerun: rerun.checks.map(({ name, link, run: id }) => ({ name, link, run: id })), outside: [] }),
    model: run?.model ?? "",
    effort: run?.effort ?? "",
    // For its Run record (ADR-0034): the model Kit config named, which a Fable fallback runs Opus in place of, and why.
    "configured-model": run === null ? "" : configuredModelOf(run),
    fallback: run?.fallback ?? "",
    // Which run it is, for its Run record: nothing reads these before the push job writes one.
    retry: run?.role === "implement" ? String(run.retry ?? 0) : "",
    // A Touch-up (#750) is no Retry: its own number, which its push note and its Run record carry.
    "touch-up": run?.role === "implement" ? String(run.touchUp ?? 0) : "",
    // A Retry on an agent PR: the head of the Execution flaw it fixes, so its push lands only for that flaw (#341).
    "retry-flaw": run?.role === "implement" ? (run.retryFlaw ?? "") : "",
    "step-up": String(run?.stepUp === true),
    // Only ever one of the Kit's own Step-up reasons, never agent text.
    "step-up-reason": run?.stepUp === true ? (run.stepUpReason ?? "") : "",
    "request-changes": String(run?.requestChanges !== undefined),
    "dispatch-timeout-minutes": String(config.roles.dispatch.timeoutMinutes),
    // Only ever a vault item name from the Kit config checked above, never a secret.
    subscription: run === null ? "" : subscriptionOf(run),
    // For the judge, which reads no Kit config: whether its stream watch kills it on overage.
    rotation: String(rotationIsOn(config)),
    // Only ever the whole-number ids the PR's marker reads as (src/evidence/uiEvidence.ts), never agent text.
    "ui-evidence-run": String(run?.evidence?.run ?? ""),
    "ui-evidence-artifact": String(run?.evidence?.artifact ?? ""),
    // Only ever one of the CAPTURE_FAILURES the marker reads as.
    "ui-evidence-failure": run?.evidence?.failure ?? "",
    // On a Product repo that uses Evidence shots (#820): the check and artifact Kit config names, the PR's names and its
    // sentence that nothing visible changes, and the head a miss is sent back at, as one line of JSON. The names and the
    // sentence are agent text, so a job reads it through `env:` only.
    "ui-shots": run?.shots === undefined ? "" : JSON.stringify(run.shots),
    // For a Review (#747): "true" for a Full Review, whose Reviewer is given the Full Review section, else "false".
    "full-review": run?.role === "review" && run.reviewKind !== undefined ? String(run.reviewKind.kind === "full") : "",
    // For a later Review (#748): the head the Reviewer last judged, and the fingerprint its Verdict recorded, as one line
    // of JSON, which the Review job works out the change since from. The fingerprint's paths are the PR's file names, so
    // a job reads it through `env:` only.
    "last-judged-head": run?.reviewKind?.kind === "later" ? run.reviewKind.lastJudged.headSha : "",
    "last-judged-change": run?.reviewKind?.kind === "later" ? JSON.stringify(run.reviewKind.lastJudged.change) : "",
    // Whether the Design run is the session's prototype turn, which the prototype job runs in the design job's place.
    prototype: String(run?.prototype !== undefined),
    // The one output that holds agent text: the request's brief, written by the Design agent. One line of JSON,
    // whose newlines JSON.stringify escapes, as GITHUB_OUTPUT's key=value lines need; read only through `env:`.
    prototype_request: run?.prototype === undefined ? "" : prototypeRequestJson(run.prototype),
    "replay-issue": "",
    "base-sha": "",
    "replay-arms": "",
    "allow-fable": "",
    "replay-kit-sha-unavailable": "",
    "kit-said": said,
  };
}

/**
 * For a replay whose variant loads a candidate Kit sha, why it can't be laid,
 * read as the variant's overlay reads it, before either arm starts, so a
 * variant that can't run spends no baseline (#449); empty for one it can lay,
 * or any other run. One line, as GITHUB_OUTPUT's key=value lines need.
 */
async function candidateOutputs(plan: Plan | null, github: GitHub): Promise<Readonly<Record<string, string>>> {
  const sha = (plan === null ? null : replayRunIn(plan))?.ticket.arms.variant.candidateSha ?? null;
  const read = sha === null ? null : await readCandidate(sha, github);
  if (read === null || read.ok) return {};
  console.log(`::error title=Candidate Kit sha unavailable::${read.reason}`);
  return { "replay-kit-sha-unavailable": read.reason.replace(/\s+/g, " ") };
}

/**
 * The outputs a replay Ticket's jobs read, from the replay issue's plan the
 * Kit wrote and read back (src/kit/replay.ts), never from an agent: the
 * replay issue, the Ticket, its merged PR, its baseSha, each arm's settings
 * and the Subscription both arms run on; and from this repo's Kit config,
 * whether it opts in to Fable, which each arm's run holds its model to.
 */
function replayOutputs({ issue, ticket, subscription }: Extract<Action, { kind: "start-replay" }>, config: Pick<KitConfig, "allowFable">): Readonly<Record<string, string>> {
  if (subscription === undefined) throw new Error(`The replay of #${ticket.ticket} on #${issue} was given no Subscription`);
  return {
    route: "replay",
    "replay-issue": String(issue),
    ticket: String(ticket.ticket),
    "pull-request": String(ticket.pullRequest),
    // A full sha the plan's reader checked.
    "base-sha": ticket.baseSha,
    // One line of JSON, whose model names come from the issue's body, so a job reads it only through `env:`.
    "replay-arms": JSON.stringify(ticket.arms),
    // Each arm runs in a checkout of baseSha, whose Kit config can predate the opt-in, or outlast it (ADR-0034).
    "allow-fable": String(config.allowFable),
    subscription,
  };
}

if (import.meta.main) {
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
}
