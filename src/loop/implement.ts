// Implementation rules: when an Implementer starts on a Ticket, and how the
// branch it built lands as one draft PR, or doesn't.
import { evidenceSection, isUi, withoutEvidence } from "../evidence/uiEvidence.ts";
import { checkTrustRoot } from "../guard/trust-root.ts";
import { consideredSection } from "./considered.ts";
import { parseImplementOutput } from "./implementOutput.ts";
import { DISPATCH_LABEL, NEEDS_DESIGN, READY_FOR_AGENT, READY_FOR_HUMAN } from "./labels.ts";
import { whyNotReviewable } from "./agentPullRequest.ts";
import { withoutMentions } from "./mentions.ts";
import { conflictRunEnded, owedConflictRun, requestChangesRunEnded } from "./conflicts.ts";
import {
  CONFLICT_RUN_MARKER,
  EMPTY_DIFF_MARKER,
  REQUEST_CHANGES_RUN_MARKER,
  requestChangesRunStartedMarker,
  RETRY_PUSH_MARKER,
  UNMARKED_RETRY_PUSH,
} from "./markers.ts";
import { owedRequestChangesRun } from "./mergeGate.ts";
import { MAX_RETRIES, owedRetry, type RunInFlight, runInFlight, runName, stepsUp } from "./retry.ts";
import { operatorChangesRequests, reviewLinks } from "./undelivered.ts";
import { verdictActions } from "./review.ts";
import type {
  Action,
  IssueContext,
  IssueSnapshot,
  KitConfig,
  LoopEvent,
  Plan,
  PullRequestSnapshot,
  Snapshot,
} from "./types.ts";

type ImplementRunFinished = Extract<LoopEvent, { kind: "implement-run-finished" }>;

const CHECK_DISPATCH: Action = { kind: "check-dispatch" };

/**
 * agent:implement starts the Implementer. The label comes off as the run starts,
 * so the open draft PR, not the label, shows the Ticket is in progress. On a
 * Ticket whose agent PR is open, it resumes that PR's Implement run instead,
 * so re-adding it recovers any of them after an Infrastructure failure: the
 * Operator's Request-changes run, which the Kit's note or an Execution flaw
 * that gave way to it started (#341) and which ranks first, or the
 * conflict-only run the Kit started when main moved under the PR (#304), or
 * the retry an Execution flaw is owed. It never starts a second branch beside
 * an open PR. The label always comes off, so it never claims work that isn't
 * running.
 */
export function startImplementer(
  issueNumber: number,
  { issue }: IssueContext,
  pullRequest: PullRequestSnapshot | null,
  config: KitConfig,
): Plan {
  const removeLabel: Action = { kind: "remove-label", issue: issueNumber, label: DISPATCH_LABEL };
  const open = issue.openPullRequests[0];
  if (open !== undefined && issue.open && issue.labels.includes(READY_FOR_AGENT)) {
    const resumed: Action[] | null =
      pullRequest === null || pullRequest.number !== open || pullRequest.ticket !== issueNumber
        ? null
        : (owedRequestChangesRun(pullRequest, config) ?? listed(owedConflictRun(pullRequest, config) ?? owedRetry(pullRequest, config)));
    return { kind: "act", actions: [removeLabel, ...(resumed ?? [])] };
  }
  if (whyNotBuildable(issueNumber, issue) !== null) return { kind: "act", actions: [removeLabel] };
  const { implement, stepUp } = config.roles;
  // The second retry Steps up; the first run and the first retry use the Implementer's model.
  const steppedUp = stepsUp(issue.emptyDiffs);
  const { model, effort } = steppedUp ? stepUp : implement;
  // Each empty diff so far was an Execution flaw, so this run is the Retry after the last one.
  const retry = issue.emptyDiffs === 0 ? {} : { retry: issue.emptyDiffs, stepUp: steppedUp };
  return {
    kind: "act",
    actions: [
      removeLabel,
      {
        kind: "start-agent-run",
        role: "implement",
        issue: issueNumber,
        model,
        effort,
        timeoutMinutes: implement.timeoutMinutes,
        ...retry,
      },
    ],
  };
}

function listed(action: Action | null): Action[] | null {
  return action === null ? null : [action];
}

/**
 * The push job's decision on the branch an Implementer built (ADR-0005): a
 * branch that touches a trust root goes to the Operator unpushed, one that
 * changes nothing is an Execution flaw, and any other opens one draft PR.
 */
export function applyImplementation(event: ImplementRunFinished, { issue, operator }: IssueContext, config: KitConfig): Plan {
  const { issue: issueNumber, changes, branch, base } = event;
  const parsed = parseImplementOutput(event.output);
  if (!parsed.ok) {
    return {
      kind: "fail",
      failure: "infrastructure",
      reason: `The Implementer on #${issueNumber} emitted output that breaks its contract: ${parsed.errors.join("; ")}`,
    };
  }
  const stale = whyNotBuildable(issueNumber, issue);
  if (stale !== null) return { kind: "nothing", reason: `${stale}, so the Implementer's branch isn't pushed` };

  // Every commit counts, so a trust-root change can't hide behind a later revert.
  const guard = checkTrustRoot([...changes.net, ...changes.commits]);
  if (guard.kind === "refuse") return refuse(issueNumber, guard.paths, operator);
  // "Did nothing" never passes, however the commits got there.
  if (changes.net.length === 0) return emptyDiff(issueNumber, issue);

  const { title, summary } = parsed.output;
  const evidence = evidenceFor(event, config, false);
  return {
    kind: "act",
    actions: [
      { kind: "push-branch", branch },
      {
        kind: "open-pull-request",
        issue: issueNumber,
        head: branch,
        base,
        title: withoutMentions(title),
        body: pullRequestBody(summary, issueNumber, evidence),
        draft: true,
      },
      ...previewToLink(evidence, config, branch, null),
    ],
  };
}

/**
 * The push job's decision on a retry's branch: built on the agent PR's head,
 * it lands as more commits on that same branch, never a new PR, and the push
 * starts Review again. The guard checks the retry's own commits, the earlier
 * ones having passed it already. One that changes nothing is an Execution flaw
 * on the PR, which starts the next retry if one is left. All of it is silent.
 */
export function applyRetryImplementation(event: ImplementRunFinished, snapshot: Snapshot, config: KitConfig): Plan {
  const { issue: issueNumber, changes, branch, fixes } = event;
  const { issue, pullRequest, operator } = snapshot;
  if (fixes === undefined) throw new Error("A first Implement run lands through applyImplementation");
  const parsed = parseImplementOutput(event.output, true);
  // A conflict-only run that can't land still ends, or it would stay in flight for good, its PR withheld from every Verdict (#304).
  const conflictEnds = (why: string): Plan | null =>
    fixes.conflict !== undefined && pullRequest !== null && pullRequest.open && pullRequest.number === fixes.pullRequest && pullRequest.conflictRunInFlight === fixes.conflict
      ? { kind: "act", actions: conflictRunEnded(pullRequest.number, fixes.conflict, operator, why, fixes.runUrl, pullRequest.draft) }
      : null;
  if (!parsed.ok) {
    return (
      conflictEnds(`its output broke the Implementer's contract (${parsed.errors.join("; ")}), so the Kit didn't push it`) ?? {
        kind: "fail",
        failure: "infrastructure",
        reason: `The Implementer's retry on #${fixes.pullRequest} emitted output that breaks its contract: ${parsed.errors.join("; ")}`,
      }
    );
  }
  if (issue === null || pullRequest === null) {
    return { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the Ticket or the PR its retry fixes" };
  }
  const stale = whyNotRetriedOnto(issueNumber, issue, fixes, pullRequest);
  if (stale !== null) {
    return conflictEnds(`${stale}, so the Kit didn't push it`) ?? { kind: "nothing", reason: `${stale}, so the retry's branch isn't pushed` };
  }
  if (fixes.conflict !== undefined) return applyConflictRun(event, fixes.conflict, pullRequest, operator, parsed.output, config);
  const requestChanges = fixes.requestChanges === true;
  // A Request-changes run lands only while it's the one in flight (#341): one started twice for the same review,
  // whose run already had its outcome, or left over for a review a later run took over from, pushes nothing over it.
  const inFlight = runInFlight(pullRequest);
  if (requestChanges && inFlight?.kind !== "request-changes") return requestChangesRunDropped(pullRequest, fixes.review, inFlight, operator);
  if (requestChanges && fixes.review !== undefined && !pullRequest.requestChangesRunReviews.includes(fixes.review)) {
    return {
      kind: "nothing",
      reason: `#${pullRequest.number}'s Request-changes run in flight isn't the one for review ${fixes.review}, so the run's branch isn't pushed`,
    };
  }
  // Nor does a Retry while a Request-changes or conflict-only run is in flight, which it would push over.
  if (!requestChanges && inFlight !== null && inFlight.kind !== "retry") {
    return { kind: "nothing", reason: `#${pullRequest.number} has a ${inFlight.kind === "request-changes" ? "Request-changes" : "conflict-only"} run in flight, so the retry's branch isn't pushed` };
  }
  // A Retry lands only while it's the Retry in flight: one the Operator took the PR back from, or left over from an
  // earlier flaw, never lands as a later one's outcome (#341).
  const otherRetry =
    inFlight?.kind !== "retry" ||
    (fixes.retry !== undefined && inFlight.retry !== fixes.retry) ||
    (fixes.retryFlaw !== undefined && inFlight.flaw !== fixes.retryFlaw);
  if (!requestChanges && (fixes.retry !== undefined || fixes.retryFlaw !== undefined) && otherRetry) {
    return {
      kind: "nothing",
      reason: `Retry ${fixes.retry} of ${MAX_RETRIES} on #${pullRequest.number} isn't the run in flight, so the retry's branch isn't pushed`,
    };
  }
  // The push job rebased the run's own commits if the branch moved (ADR-0006). If the branch moves again,
  // the push's lease refuses it, and the run stays in flight as after an Infrastructure failure.
  if (changes.rebase?.conflicted === true) return startAgain(event, fixes, pullRequest, changes.rebase.onto);

  // A Request-changes run its agent job told to merge main in, because the head it started on conflicted with main
  // (#341). One that can't land hands the PR to the Operator, open, as a conflict-only run does (ADR-0011).
  const mainMerge = requestChanges ? changes.mainMerge : undefined;
  const guard = checkTrustRoot([...changes.net, ...changes.commits]);
  if (guard.kind === "refuse") {
    return mainMerge === undefined
      ? refuse(issueNumber, guard.paths, operator, pullRequest.number)
      : {
          kind: "act",
          actions: requestChangesRunEnded(
            pullRequest.number,
            mainMerge.main,
            operator,
            `its changes touch files that steer or judge the agents, which only you change (ADR-0005), so the Kit didn't push it: ${guard.paths.map((path) => `\`${path}\``).join(", ")}`,
            fixes.runUrl,
          ),
        };
  }
  if (mainMerge !== undefined && !mainMerge.resolved) {
    const nothing = changes.net.length === 0 && changes.commits.length === 0;
    return {
      kind: "act",
      actions: requestChangesRunEnded(
        pullRequest.number,
        mainMerge.main,
        operator,
        // A run that committed nothing left the branch as it was, which the Kit doesn't read again: someone else may
        // have brought main in meanwhile.
        nothing ? "it committed nothing" : `\`${branch}\` as it left it still conflicts with \`main\`: it didn't merge \`main\` in`,
        fixes.runUrl,
      ),
    };
  }
  // Merging main in or rebasing onto it, to fix a conflict, is a change even with none of the run's own.
  if (changes.net.length === 0 && changes.updatedFromMain !== true && mainMerge === undefined) {
    return {
      kind: "act",
      actions: verdictActions(
        fixes,
        // Its Verdict is the Request-changes run's, so it uses no retry.
        requestChanges ? { ...pullRequest, requestChangesRun: true } : pullRequest,
        {
          verdict: "execution-flaw",
          source: "empty-diff",
          findings: `The Implementer's ${requestChanges ? "Request-changes run" : "retry"} on \`${branch}\` committed no change, so there was nothing to review.`,
        },
        operator,
      ),
    };
  }
  const evidence = evidenceFor(event, config, pullRequest.uiEvidenceMarker !== null);
  // The body and the note go first: the push starts a Review, which must see the run's outcome (or it posts no
  // Verdict) and the body as it now stands.
  return {
    kind: "act",
    actions: [
      // The body says what the PR as a whole now does, so the next Review, which reads the body, never judges a stale one.
      // Its evidence section is this run's, never an earlier run's, so the evidence matches the PR's new head.
      { kind: "edit-issue-body", issue: pullRequest.number, body: pullRequestBody(parsed.output.summary, issueNumber, evidence) },
      {
        kind: "comment",
        issue: pullRequest.number,
        body: [
          // Marks the push as the run's outcome, so Reviews give Verdicts again, and the next one is marked as from a Request-changes run if it was one.
          requestChanges ? REQUEST_CHANGES_RUN_MARKER : RETRY_PUSH_MARKER,
          requestChanges
            ? `The Implementer pushed the Operator's requested changes to \`${branch}\`${mainMerge === undefined ? "" : `, which no longer conflicts with \`main\` at ${mainMerge.main.slice(0, 7)}`}; Review runs again on it.`
            : `${UNMARKED_RETRY_PUSH}\`${branch}\`; Review runs again on it.`,
          "",
          // Present: the on-a-PR contract above requires it.
          withoutMentions(parsed.output.fix ?? ""),
          ...consideredSection(parsed.output.operatorCommentsConsidered ?? [], fixes.operatorComments),
        ].join("\n"),
      },
      { kind: "push-branch", branch },
      ...previewToLink(evidence, config, branch, pullRequest.number),
    ],
  };
}

/**
 * The push job's decision on a conflict-only run's branch (#304): a run that
 * brought main in, by rebasing onto it, with no trust-root change of its own,
 * lands as the PR's new head, and its push starts a full Review whose Verdict
 * uses no retry. A conflict resolved inside a Trust-root file is the run's own
 * change, so the guard refuses it. Anything short of a push (a branch that
 * moved while it ran, no change, main not brought in, a refusal) hands the PR
 * to the Operator, open, and the Kit doesn't try again until main moves.
 */
function applyConflictRun(
  event: ImplementRunFinished,
  main: string,
  pullRequest: PullRequestSnapshot,
  operator: string,
  output: { readonly summary: string; readonly fix?: string; readonly operatorCommentsConsidered?: readonly string[] },
  config: KitConfig,
): Plan {
  const { changes, branch, fixes } = event;
  if (fixes === undefined) throw new Error("A conflict-only run lands on the PR it fixes");
  if (pullRequest.conflictRunInFlight !== main) {
    return { kind: "nothing", reason: `#${pullRequest.number} has no conflict-only run in flight for main at ${main.slice(0, 7)}, so the run's branch isn't pushed` };
  }
  const handOff = (why: string): Plan => ({ kind: "act", actions: conflictRunEnded(pullRequest.number, main, operator, why, fixes.runUrl) });
  if (changes.rebase?.conflicted === true) {
    return handOff(`\`${branch}\` moved to ${changes.rebase.onto.slice(0, 7)} while it ran, so the Kit discarded its work`);
  }
  const guard = checkTrustRoot([...changes.net, ...changes.commits]);
  if (guard.kind === "refuse") {
    return handOff(
      `its resolution changes files that steer or judge the agents, which only you change (ADR-0005), so the Kit didn't push it: ${guard.paths.map((path) => `\`${path}\``).join(", ")}`,
    );
  }
  if (changes.net.length === 0 && changes.updatedFromMain !== true) return handOff(`it committed no change to \`${branch}\``);
  if (changes.updatedFromMain !== true) return handOff(`it didn't rebase onto \`main\`, so \`${branch}\` still doesn't hold it`);
  const evidence = evidenceFor(event, config, pullRequest.uiEvidenceMarker !== null);
  // As for a retry, the body and the note go first: the push starts a Review, which must see the run's outcome.
  return {
    kind: "act",
    actions: [
      { kind: "edit-issue-body", issue: pullRequest.number, body: pullRequestBody(output.summary, event.issue, evidence) },
      {
        kind: "comment",
        issue: pullRequest.number,
        body: [
          // Marks the push as the run's outcome, and the next Verdict as from a conflict-only run, which uses no retry.
          CONFLICT_RUN_MARKER,
          `The Implementer rebased \`${branch}\` onto \`main\` at ${main.slice(0, 7)} and resolved its conflicts; Review runs again on it, and its Verdict uses no retry.`,
          "",
          // Present: the on-a-PR contract requires it. It lists each conflicted file and how it was resolved.
          withoutMentions(output.fix ?? ""),
          ...consideredSection(output.operatorCommentsConsidered ?? [], fixes.operatorComments),
        ].join("\n"),
      },
      { kind: "push-branch", branch },
      ...previewToLink(evidence, config, branch, pullRequest.number),
    ],
  };
}

/**
 * An agent PR's body: the Implementer's summary, then the evidence section
 * when the run was UI, then the Closes line, so merging the PR closes the
 * Ticket and starts the next Dispatch check. The summary is agent text, so it
 * keeps no evidence section or marker of its own: only the Kit's says where
 * the evidence is kept.
 */
function pullRequestBody(summary: string, issueNumber: number, evidence: string | null): string {
  return [withoutEvidence(withoutMentions(summary)), ...(evidence === null ? [] : [evidence]), `Closes #${issueNumber}`].join("\n\n");
}

/**
 * The evidence section for the run's PR, or null when the run isn't UI. The
 * push job decides that, never the agent job, whose runner the agent could
 * have changed: the run is UI when its changes match `ui.paths`, or when its
 * PR is `marked` UI already, a retry's changes holding only its own commits.
 */
function evidenceFor(event: ImplementRunFinished, config: KitConfig, marked: boolean): string | null {
  const { evidence } = event;
  if (evidence === undefined) return null;
  if (!marked && !isUi(event.changes.net.map(({ path }) => path), config.ui)) return null;
  const { result, headSha, run, artifact, gallery } = evidence;
  return evidenceSection({
    result: result ?? { outcome: "failed", reason: "no-result", headSha, captures: [] },
    run,
    artifact,
    gallery,
    // The push job polls a declared preview once it has pushed, and links it if it answers.
    preview: config.preview === null ? { kind: "none" } : { kind: "pending" },
  });
}

/**
 * The preview deployment to link once the push job has pushed: a UI PR's,
 * when Kit config declares `preview.url`, which its evidence section says is
 * linked once it answers. A PR with no evidence section gets none, and nor
 * does one in a repo that declares no preview, so the push job polls nothing.
 */
function previewToLink(evidence: string | null, config: KitConfig, branch: string, pullRequest: number | null): Action[] {
  if (evidence === null || config.preview === null) return [];
  return [{ kind: "link-preview", pullRequest, template: config.preview.url, branch }];
}

/** Why a retry's branch can't land on this PR now, or null when it can. */
function whyNotRetriedOnto(
  issueNumber: number,
  issue: IssueSnapshot,
  fixes: NonNullable<ImplementRunFinished["fixes"]>,
  pullRequest: PullRequestSnapshot,
): string | null {
  if (pullRequest.number !== fixes.pullRequest) return `The snapshot is of #${pullRequest.number}, not #${fixes.pullRequest}`;
  const why = whyNotReviewable(pullRequest);
  if (why !== null) return why;
  if (pullRequest.ticket !== issueNumber) return `#${pullRequest.number} isn't #${issueNumber}'s PR`;
  if (!issue.open) return `#${issueNumber} is closed`;
  if (!issue.labels.includes(READY_FOR_AGENT)) return `#${issueNumber} isn't ${READY_FOR_AGENT}`;
  return null;
}

/**
 * A Request-changes run that finished with none in flight for it (#341): its
 * branch is never pushed. Mostly that needs no word, as for a second run of a
 * review whose first already landed, or one the Operator took the PR back
 * from. But once the Operator has dismissed the review the Kit noted it for,
 * nothing else would move the PR on. A Request changes of theirs no run has
 * built, as one they submitted on the draft meanwhile, gets its run;
 * otherwise the Kit put the PR in draft for this run, and puts it back at the
 * Merge gate. An Execution flaw that gave way to the review never owes a
 * Retry (src/loop/retry.ts): the PR is the Operator's again.
 */
function requestChangesRunDropped(
  pullRequest: PullRequestSnapshot,
  review: number | undefined,
  inFlight: RunInFlight | null,
  operator: string,
): Plan {
  const nothing: Plan = { kind: "nothing", reason: `#${pullRequest.number} has no Request-changes run in flight, so the run's branch isn't pushed` };
  const dismissed =
    review !== undefined &&
    pullRequest.notedChangesRequests.includes(review) &&
    !pullRequest.unbuiltChangesRequests.some((unbuilt) => unbuilt.review === review);
  if (!dismissed || pullRequest.ticket === null || !pullRequest.open || !pullRequest.draft) return nothing;
  const lead = `Your Request changes on #${pullRequest.number} (${reviewLinks(pullRequest, [review])}) was dismissed while its run worked, so the Kit didn't push the run's work.`;
  const waiting = operatorChangesRequests(pullRequest, operator).map((unbuilt) => unbuilt.review);
  if (waiting.length > 0 && inFlight === null) {
    return {
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: pullRequest.number,
          body: [
            requestChangesRunStartedMarker(waiting),
            `${lead} The Kit is starting the Request-changes run for your Request changes on #${pullRequest.number} (${reviewLinks(pullRequest, waiting)}) instead. It runs on the Step-up model and uses no retry, and Review runs again on its push.`,
          ].join("\n"),
        },
        // A fresh agent:implement on the Ticket starts the run the note put in flight. It notifies nobody.
        { kind: "add-labels", issue: pullRequest.ticket, labels: [DISPATCH_LABEL] },
      ],
    };
  }
  if (inFlight !== null || pullRequest.pushedSinceVerdict) return nothing;
  return {
    kind: "act",
    actions: [
      { kind: "comment", issue: pullRequest.number, body: `${lead} #${pullRequest.number} is back at the Merge gate.` },
      { kind: "mark-ready-for-review", pullRequest: pullRequest.number },
    ],
  };
}

/**
 * A run whose commits couldn't be rebased onto the head its branch moved to:
 * they conflict with it, or the run rewrote the history it built on. The Kit
 * discards them, says so, and starts the same run again on the new head. It
 * posts no Retry outcome, so the run stays in flight and uses no retry;
 * re-adding agent:implement resumes it as after an Infrastructure failure.
 * Restarts aren't capped. Like the rest of a retry, it's silent.
 */
function startAgain(
  { issue: ticket, branch }: ImplementRunFinished,
  fixes: NonNullable<ImplementRunFinished["fixes"]>,
  pullRequest: PullRequestSnapshot,
  onto: string,
): Plan {
  const run = runInFlight(pullRequest);
  if (run === null) {
    return { kind: "nothing", reason: `#${pullRequest.number} has no run in flight to start again, so the run's branch isn't pushed` };
  }
  const head = onto.slice(0, 7);
  const body = [
    `\`${branch}\` moved from ${fixes.headSha.slice(0, 7)} to ${head} while the Implementer worked, and its commits couldn't be rebased onto the new head without a conflict, so the Kit discarded them.`,
    "",
    `${runName(run)} starts again on ${head}, using no retry.`,
  ].join("\n");
  return {
    kind: "act",
    actions: [
      { kind: "comment", issue: pullRequest.number, body },
      // As after an Infrastructure failure, agent:implement resumes the run in flight (startImplementer).
      { kind: "add-labels", issue: ticket, labels: [DISPATCH_LABEL] },
    ],
  };
}

/**
 * A refusal isn't the Implementer's mistake to fix: the work itself needs a
 * trust-root change, which only the Operator may make. So it uses no retry.
 */
function refuse(issueNumber: number, paths: readonly string[], operator: string, pullRequest: number | null = null): Plan {
  const body = [
    `The Implementer's branch for #${issueNumber} changes files that steer or judge the agents, so the Kit didn't push it (ADR-0005):`,
    "",
    ...paths.map((path) => `- \`${path}\``),
    "",
    pullRequest === null
      ? "Only the Operator changes these. Make the change yourself, or rewrite the Ticket so it doesn't need it and mark it `ready-for-agent` again."
      : `Only the Operator changes these, so the Kit closed #${pullRequest} unmerged, keeping its branch. Make the change yourself, or rewrite the Ticket so it doesn't need it and mark it \`ready-for-agent\` again.`,
  ].join("\n");
  return {
    kind: "act",
    actions: [
      // A retry's PR closes too (its branch stays), or it would hold a max_in_flight slot for good.
      ...(pullRequest === null ? [] : [{ kind: "close-pull-request" as const, pullRequest }]),
      { kind: "comment", issue: issueNumber, body },
      { kind: "remove-label", issue: issueNumber, label: READY_FOR_AGENT },
      { kind: "add-labels", issue: issueNumber, labels: [READY_FOR_HUMAN] },
      // The assignment is ready-for-human's one notification; the comment mentions nobody.
      { kind: "assign", issue: issueNumber, assignee: operator },
      // The run no longer holds a slot.
      CHECK_DISPATCH,
    ],
  };
}


/**
 * An empty diff is an Execution flaw. With no PR to retry on, the retry is a
 * fresh Implement run, kept silent; the third flaw is a Design flaw.
 */
function emptyDiff(issueNumber: number, issue: IssueSnapshot): Plan {
  const flaw = issue.emptyDiffs + 1;
  if (flaw > MAX_RETRIES) {
    return {
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: issueNumber,
          body: [
            EMPTY_DIFF_MARKER,
            `The Implementer's branch for #${issueNumber} changed nothing, for the ${ordinal(flaw)} time. A third Execution flaw counts as a Design flaw, so this Ticket goes back to design.`,
          ].join("\n"),
        },
        { kind: "remove-label", issue: issueNumber, label: READY_FOR_AGENT },
        // Starts a Design session, whose round 1 is this event's one notification.
        { kind: "add-labels", issue: issueNumber, labels: [NEEDS_DESIGN] },
        CHECK_DISPATCH,
      ],
    };
  }
  return {
    kind: "act",
    actions: [
      {
        kind: "comment",
        issue: issueNumber,
        body: [
          EMPTY_DIFF_MARKER,
          `The Implementer's branch for #${issueNumber} changed nothing, so the Kit opened no PR. An empty diff is an Execution flaw: retry ${flaw} of ${MAX_RETRIES} starts now${stepsUp(flaw) ? ", stepped up" : ""}.`,
        ].join("\n"),
      },
      // A fresh label event, as Dispatch would add, starts the retry in this run's own slot.
      { kind: "add-labels", issue: issueNumber, labels: [DISPATCH_LABEL] },
    ],
  };
}

function ordinal(n: number): string {
  return ["zeroth", "first", "second", "third"][n] ?? `${n}th`;
}

/** Why an Implementer can't build this Ticket now, or null when it can. */
function whyNotBuildable(issueNumber: number, issue: IssueSnapshot): string | null {
  if (!issue.open) return `#${issueNumber} is closed`;
  if (!issue.labels.includes(READY_FOR_AGENT)) return `#${issueNumber} isn't ${READY_FOR_AGENT}`;
  const pullRequest = issue.openPullRequests[0];
  if (pullRequest !== undefined) return `#${issueNumber} already has the open PR #${pullRequest}`;
  return null;
}
