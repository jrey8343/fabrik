// Review rules: when a Review starts on an agent PR, and how its Verdict lands.
// Red required checks are an Execution flaw and the Reviewer doesn't run; on
// green, the Reviewer's Verdict line decides. Every Verdict is posted as a PR
// comment with its marker. Routing flaws onward is for later rules.
import { whyNotReviewable } from "./agentPullRequest.ts";
import { backToDesignActions, backToDesignLine } from "./backToDesign.ts";
import { REVIEW_LABEL } from "./labels.ts";
import { withoutMentions } from "./mentions.ts";
import { retryAfterFlaw, whyAwaitingRun } from "./retry.ts";
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
 * before anything else.
 */
export function startReview(pullRequest: PullRequestSnapshot, operator: string, config: KitConfig): Plan {
  const why = whyNotReviewable(pullRequest) ?? whyAwaitingRun(pullRequest, operator);
  if (why !== null) return { kind: "nothing", reason: why };
  const { model, effort, timeoutMinutes } = config.roles.review;
  return {
    kind: "act",
    actions: [{ kind: "start-agent-run", role: "review", issue: pullRequest.number, model, effort, timeoutMinutes }],
  };
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
    return { kind: "act", actions: verdictActions(event, pullRequest, "execution-flaw", "ci", findings) };
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
    const actions = verdictActions(event, pullRequest, parsed.verdict, "reviewer", withoutMentions(parsed.findings));
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
  { pullRequest, operator }: Snapshot,
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
  const awaiting = whyAwaitingRun(pullRequest, operator);
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

/**
 * The Verdict comment (it mentions nobody), and agent:review off so re-adding
 * it is a fresh event. An Execution flaw then starts its retry, if one is
 * left; a Design flaw, or an Execution flaw with none left, sends the Ticket
 * back to design.
 */
export function verdictActions(
  event: { readonly headSha: string; readonly runUrl: string },
  pullRequest: PullRequestSnapshot,
  verdict: Verdict,
  source: VerdictRecord["source"],
  findings: string,
): Action[] {
  const record: VerdictRecord = { verdict, source, requestChanges: pullRequest.requestChangesRun, headSha: event.headSha };
  const by = BY[source];
  const next = nextAfter(verdict, pullRequest);
  const body = [
    verdictMarker(record),
    `## Verdict: ${HEADINGS[verdict]}`,
    "",
    `From ${by}, on ${event.headSha.slice(0, 7)}${record.requestChanges ? ", after a Request-changes run" : ""}.`,
    ...(findings === "" ? [] : ["", findings]),
    ...(next === null ? [] : ["", next.line]),
    "",
    `[The run](${event.runUrl})`,
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

/** What a Verdict leads to beyond its comment: a retry, back to design, or (for a pass) nothing here. */
function nextAfter(verdict: Verdict, pullRequest: PullRequestSnapshot): { line: string; actions: Action[] } | null {
  if (verdict === "pass") return null;
  const retry = verdict === "execution-flaw" ? retryAfterFlaw(pullRequest) : null;
  if (retry !== null) return retry;
  const reason = verdict === "design-flaw" ? "design-flaw" : "retries-used-up";
  return { line: backToDesignLine(pullRequest, reason), actions: backToDesignActions(pullRequest, reason, VERDICT_COMMENT) };
}
