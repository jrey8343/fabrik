// Review rules: when a Review starts on an agent PR, and how its Verdict lands.
// Red required checks are an Execution flaw and the Reviewer doesn't run; on
// green, the Reviewer's Verdict line decides. Every Verdict is posted as a PR
// comment with its marker. Routing flaws onward is for later rules.
import { whyNotReviewable } from "./agentPullRequest.ts";
import { backToDesignActions, backToDesignLine } from "./backToDesign.ts";
import { consideredSection } from "./considered.ts";
import { declineTrigger } from "./declineTrigger.ts";
import { followUpsSection } from "./followUps.ts";
import { DISPATCH_LABEL, REVIEW_LABEL } from "./labels.ts";
import { withoutMentions } from "./mentions.ts";
import { retryAfterFlaw, whyAwaitingRun } from "./retry.ts";
import { operatorChangesRequests, reviewLinks } from "./undelivered.ts";
import { verdictMarker } from "./markers.ts";
import { parseVerdict } from "./verdict.ts";
import type {
  Action,
  KitConfig,
  LoopEvent,
  Plan,
  PostedComment,
  PullRequestSnapshot,
  Snapshot,
  Verdict,
  VerdictRecord,
} from "./types.ts";

type RedChecks = Extract<LoopEvent, { kind: "required-checks-finished" }>;
type Reviewed = Extract<LoopEvent, { kind: "review-run-finished" }>;

/**
 * A push to an agent draft PR, or agent:review added to it, starts a Review,
 * unless a Retry or Request-changes run is in flight on it: that run's push
 * starts the next one. The Review job waits for the PR's required checks
 * before anything else. A UI PR's Review carries where its marker says the UI
 * evidence is kept, so the Reviewer sees the screenshots; the Verdict is the same.
 */
export function startReview(pullRequest: PullRequestSnapshot, config: KitConfig): Plan {
  const why = whyNotReviewable(pullRequest) ?? whyAwaitingRun(pullRequest);
  if (why !== null) return { kind: "nothing", reason: why };
  const { model, effort, timeoutMinutes } = config.roles.review;
  const { number, uiEvidenceMarker } = pullRequest;
  return {
    kind: "act",
    actions: [
      {
        kind: "start-agent-run",
        role: "review",
        issue: number,
        ...(uiEvidenceMarker === null ? {} : { evidence: uiEvidenceMarker }),
        model,
        effort,
        timeoutMinutes,
      },
    ],
  };
}

/**
 * agent:review added to a PR starts a Review as a push does. When none can
 * start, the label comes off, so the Kit's or the Operator's later re-add
 * fires a fresh event, and one comment says why (#417).
 */
export function startReviewOnLabel(pullRequest: PullRequestSnapshot, config: KitConfig): Plan {
  const plan = startReview(pullRequest, config);
  if (plan.kind !== "nothing") return plan;
  return { kind: "act", actions: declineTrigger(pullRequest.number, REVIEW_LABEL, plan.reason) };
}

/** Red CI is an Execution flaw, recorded as a Verdict from CI so retries can be counted from the PR alone. */
export function applyRedChecks(event: RedChecks, snapshot: Snapshot): Plan {
  return landVerdict(event, snapshot, (pullRequest) => {
    if (event.failed.length === 0) {
      return { kind: "nothing", reason: `#${pullRequest.number}'s required checks passed, so the Reviewer judges it` };
    }
    const findings = [
      "These required checks didn't pass, so the Reviewer didn't run:",
      "",
      ...event.failed.map((name) => `- \`${name.replace(/`/g, "'")}\``),
    ].join("\n");
    return { kind: "act", actions: verdictActions(event, pullRequest, { verdict: "execution-flaw", source: "ci", findings }, snapshot.operator) };
  });
}

/**
 * The Reviewer's Verdict. A reply that breaks the contract is an
 * Infrastructure failure, never a pass. A pass takes the PR out of draft and
 * requests the Operator's review, the event's one notification.
 */
export function applyReview(event: Reviewed, snapshot: Snapshot): Plan {
  return landVerdict(event, snapshot, (pullRequest) => {
    const parsed = parseVerdict(event.output);
    if (!parsed.ok) {
      return { kind: "fail", failure: "infrastructure", reason: `The Review of #${pullRequest.number} gave no valid Verdict: ${parsed.error}` };
    }
    const findings = withoutMentions(parsed.findings);
    const actions = verdictActions(event, pullRequest, {
      verdict: parsed.verdict,
      source: "reviewer",
      // A pass is what the Reviewer checked, then any Follow-ups; a flaw is its findings.
      findings: parsed.verdict === "pass" && findings !== "" ? `### Checked\n\n${findings}` : findings,
      followUps: followUpsSection(parsed.followUps, event.repoUrl, pullRequest.number),
      considered: consideredSection(parsed.considered, event.operatorComments),
    }, snapshot.operator);
    if (parsed.verdict !== "pass") return { kind: "act", actions };
    return {
      kind: "act",
      actions: [
        ...actions,
        { kind: "mark-ready-for-review", pullRequest: pullRequest.number },
        { kind: "request-review", pullRequest: pullRequest.number, reviewer: snapshot.operator },
      ],
    };
  });
}

/** Lands a Verdict only on the agent draft PR it was given for, at the commit it judged, once. */
function landVerdict(
  event: RedChecks | Reviewed,
  { pullRequest }: Snapshot,
  decide: (pullRequest: PullRequestSnapshot) => Plan,
): Plan {
  if (pullRequest === null) {
    return { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the pull request" };
  }
  const why = whyNotReviewable(pullRequest);
  if (why !== null) return { kind: "nothing", reason: `${why}, so the Verdict is stale` };
  if (pullRequest.headSha !== event.headSha) {
    return { kind: "nothing", reason: `#${pullRequest.number} has moved on from ${event.headSha.slice(0, 7)}, so the Verdict is stale` };
  }
  if (pullRequest.verdicts.some((record) => record.headSha === event.headSha)) {
    return { kind: "nothing", reason: `#${pullRequest.number} already has a Verdict on ${event.headSha.slice(0, 7)}` };
  }
  // A Review that started before the run was called for lands nothing either.
  const awaiting = whyAwaitingRun(pullRequest);
  if (awaiting !== null) return { kind: "nothing", reason: awaiting };
  return decide(pullRequest);
}

const BY: Readonly<Record<VerdictRecord["source"], string>> = {
  ci: "red required checks",
  reviewer: "the Reviewer",
  "empty-diff": "a retry that changed nothing",
};

const HEADINGS: Readonly<Record<Verdict, string>> = {
  pass: "Pass",
  "execution-flaw": "Execution flaw",
  "design-flaw": "Design flaw",
};

/** Names the Verdict comment, so the note on a Ticket sent back to design can link it. */
const VERDICT_COMMENT: PostedComment = { posted: "verdict" };

/** A Request-changes run's answers as its outcome comment carries them: the marker line, and the lines people read (#369). */
export interface AnswerLines {
  readonly marker: string;
  readonly lines: readonly string[];
}

/**
 * The Verdict comment (it mentions nobody), and agent:review off so re-adding
 * it is a fresh event. An Execution flaw then starts its retry, if one is
 * left; a Design flaw, or an Execution flaw with none left, sends the Ticket
 * back to design. A pass's Follow-ups (src/loop/followUps.ts) follow its
 * findings. A Reviewer's Verdict ends with the Operator comments it
 * weighed, as `considered` (src/loop/considered.ts) renders them.
 */
export function verdictActions(
  event: { readonly headSha: string; readonly runUrl: string },
  pullRequest: PullRequestSnapshot,
  {
    verdict,
    source,
    findings,
    followUps = [],
    considered = [],
  }: {
    readonly verdict: Verdict;
    readonly source: VerdictRecord["source"];
    readonly findings: string;
    readonly followUps?: readonly string[];
    readonly considered?: readonly string[];
  },
  operator: string,
): Action[] {
  const first = verdict === "execution-flaw" ? requestChangesFirst(pullRequest, operator) : null;
  const record: VerdictRecord = {
    verdict,
    source,
    requestChanges: pullRequest.requestChangesRun,
    ...(pullRequest.conflictRun ? { conflictRun: true as const } : {}),
    ...(first === null ? {} : { requestChangesFirst: first.reviews }),
    headSha: event.headSha,
  };
  const by = BY[source];
  const next = first ?? nextAfter(verdict, pullRequest);
  const body = [
    verdictMarker(record),
    `## Verdict: ${HEADINGS[verdict]}`,
    "",
    `From ${by}, on ${event.headSha.slice(0, 7)}${record.requestChanges ? ", after a Request-changes run" : ""}${record.conflictRun === true ? ", after a conflict-only run" : ""}.`,
    ...(findings === "" ? [] : ["", findings]),
    ...followUps,
    ...(next === null ? [] : ["", next.line]),
    "",
    `[The run](${event.runUrl})`,
    ...considered,
  ].join("\n");
  const reviewLabelOff: Action[] = pullRequest.labels.includes(REVIEW_LABEL)
    ? [{ kind: "remove-label", issue: pullRequest.number, label: REVIEW_LABEL }]
    : [];
  return [
    ...reviewLabelOff,
    { kind: "comment", issue: pullRequest.number, body, key: VERDICT_COMMENT.posted },
    ...(next?.actions ?? []),
  ];
}

/**
 * What an Execution flaw leads to when the Operator has a Request changes on
 * the PR that no run has built (#341), most often one GitHub never delivered:
 * it gives way, calling for no Retry and using none, and starts their
 * Request-changes run in its place, which reads these findings with the
 * reviews. Its marker names the reviews, so the run is in flight from it.
 * Null when the flaw is a Request-changes run's own, or there's no such review.
 */
function requestChangesFirst(
  pullRequest: PullRequestSnapshot,
  operator: string,
): { readonly reviews: number[]; readonly line: string; readonly actions: Action[] } | null {
  if (pullRequest.ticket === null) return null;
  // Not to the reviews of a Request-changes run in flight.
  const reviews = operatorChangesRequests(pullRequest, operator)
    .map(({ review }) => review)
    .filter((review) => !pullRequest.requestChangesRunReviews.includes(review));
  if (reviews.length === 0) return null;
  return {
    reviews,
    line: `The Operator's Request changes on #${pullRequest.number} (${reviewLinks(pullRequest, reviews)}) hasn't been built, so it goes first: its Request-changes run starts now, on the Step-up model, and fixes these findings too. This Execution flaw uses no retry.`,
    // A fresh agent:implement on the Ticket starts the run this Verdict put in flight. It notifies nobody.
    actions: [{ kind: "add-labels", issue: pullRequest.ticket, labels: [DISPATCH_LABEL] }],
  };
}

/** What a Verdict leads to beyond its comment: a retry, back to design, or (for a pass) nothing here. */
function nextAfter(verdict: Verdict, pullRequest: PullRequestSnapshot): { line: string; actions: Action[] } | null {
  if (verdict === "pass") return null;
  const retry = verdict === "execution-flaw" ? retryAfterFlaw(pullRequest) : null;
  if (retry !== null) return retry;
  const reason = verdict === "design-flaw" ? "design-flaw" : "retries-used-up";
  return { line: backToDesignLine(pullRequest, reason), actions: backToDesignActions(pullRequest, reason, VERDICT_COMMENT) };
}
