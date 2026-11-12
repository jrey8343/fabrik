// The Digest's rules (ADR-0022): what a pass does about a Digest, when
// `agent:digest` starts the Digest writer on a pull request, how its attempt
// lands, and when the Merge gate opens. Pure, no I/O.
import { declineTrigger } from "./declineTrigger.ts";
import { digestCommentOf, noDigestLine, parseDigestReply } from "./digestContract.ts";
import { DIGEST_LABEL } from "./labels.ts";
import { runInFlight, runName } from "./retry.ts";
import type { Action, InfrastructureFailure, KitConfig, LoopEvent, Plan, PullRequestSnapshot, Snapshot } from "./types.ts";

/**
 * `agent:digest` added to a pull request, whoever added it, starts a Digest
 * run at the head its pass was given on: only on an open agent pull request
 * whose latest Verdict is a pass on its current head, with no run in flight
 * on it and the Digest on. Otherwise the label comes off with one line
 * saying why, as a declined `agent:review` does. In draft or at the Merge
 * gate alike: a pass adds the label to its draft, and the Operator may add it
 * to a pull request at the gate, which it never moves (`openGate`).
 */
export function startDigestOnLabel(pullRequest: PullRequestSnapshot, config: KitConfig): Plan {
  const why = whyNoDigest(pullRequest, config);
  if (why !== null) return { kind: "act", actions: declineTrigger(pullRequest.number, DIGEST_LABEL, why) };
  const { model, effort, timeoutMinutes } = config.roles.digest;
  return {
    kind: "act",
    actions: [{ kind: "start-agent-run", role: "digest", issue: pullRequest.number, headSha: pullRequest.headSha, model, effort, timeoutMinutes }],
  };
}

/** Why `agent:digest` starts no Digest run on this pull request, as a clause with no full stop, or null when it starts one. */
function whyNoDigest(pullRequest: PullRequestSnapshot, config: KitConfig): string | null {
  const { number } = pullRequest;
  if (!config.digest.enabled) return "the Digest is off in this repo's Kit config (`digest.enabled`)";
  if (!pullRequest.isAgent) return `#${number} isn't an agent PR`;
  if (pullRequest.ticket === null) return `#${number}'s branch names no Ticket`;
  if (!pullRequest.open) return `#${number} is closed`;
  const run = runInFlight(pullRequest);
  if (run !== null) return `${runName(run)} on #${number} is still in flight`;
  if (!passedAt(pullRequest, pullRequest.headSha)) return `#${number} has no pass on its current head, ${pullRequest.headSha.slice(0, 7)}`;
  return null;
}

type Passed = Extract<LoopEvent, { kind: "review-run-finished" }>;

/**
 * What a pass that would open the Merge gate does in its place, after its
 * Verdict: the first of these that holds.
 * 1. The Digest is off in Kit config: the gate opens as it always has.
 * 2. Otherwise the pass adds `agent:digest`, which starts the Digest writer,
 *    and the pull request stays in draft with no review requested: the gate
 *    opens when that attempt ends (`openGate`).
 * A pass that keeps the pull request in draft, an Execution flaw and a
 * Design flaw never come here.
 *
 * The snapshot here was read before this pass's Verdict was posted, so
 * `gateUnopened`, and `openGate` with it, would answer for the Verdict
 * before it. The pass is being given now, so its gate cannot have opened: a
 * step here that opens it does so with `gateOpening`.
 */
export function digestOnPass(_event: Passed, pullRequest: PullRequestSnapshot, snapshot: Pick<Snapshot, "operator">, config: KitConfig): Action[] {
  if (!config.digest.enabled) return gateOpening(pullRequest, snapshot.operator);
  return [{ kind: "add-labels", issue: pullRequest.number, labels: [DIGEST_LABEL] }];
}

/** Out of draft, then the Operator's review requested: the review request is the event's one notification. */
function gateOpening(pullRequest: PullRequestSnapshot, operator: string): Action[] {
  return [
    { kind: "mark-ready-for-review", pullRequest: pullRequest.number },
    { kind: "request-review", pullRequest: pullRequest.number, reviewer: operator },
  ];
}

type Written = Extract<LoopEvent, { kind: "digest-run-finished" }>;
type FailedRun = Extract<LoopEvent, { kind: "agent-run-failed" }>;

const MISSING_PULL_REQUEST: Plan = { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the pull request" };

/**
 * How a finished Digest run lands, in the push job. Whichever way, the label
 * comes off, so adding it again is a fresh event:
 * - dropped, when the pull request is closed, its head has moved, a run is
 *   now in flight on it, or its latest Verdict is no longer that pass:
 *   nothing is posted and the gate stays closed;
 * - refused, when the reply breaks its shape or Kit code refuses the Digest
 *   it would render: the no-Digest line is posted, with Kit code's reason,
 *   then the gate opens;
 * - otherwise the Digest is posted, once, and never edited, the older
 *   Digests on the thread are collapsed as outdated (`collapseOlder`), then
 *   the gate opens.
 * The Loop waits for the attempt, never for its success, and nothing in it
 * moves because of what a Digest says.
 */
export function landDigest(event: Written, { pullRequest, operator }: Pick<Snapshot, "pullRequest" | "operator">): Plan {
  if (pullRequest === null) return MISSING_PULL_REQUEST;
  const dropped = whyDropped(pullRequest, event.headSha);
  if (dropped !== null) return drop(pullRequest, dropped);
  const reply = parseDigestReply(event.output);
  const comment = reply.ok ? digestCommentOf(reply.output, event.given) : { ok: false as const, refused: reply.errors.join("; ") };
  if (!comment.ok) {
    return attemptEnded(pullRequest, noDigestLine({ head: event.headSha, how: "refused", reason: comment.refused, runUrl: event.runUrl }), operator);
  }
  return attemptEnded(pullRequest, comment.body, operator, collapseOlder(pullRequest));
}

/**
 * Collapses each Digest already on the pull request's thread as outdated,
 * once the Digest that follows them is posted and before the gate opens, so
 * the thread shows one account: one action for each not collapsed yet. Only
 * Digests: `digests` holds no no-Digest line, no Verdict and no other
 * comment. Nothing is ever un-collapsed.
 */
export function collapseOlder(pullRequest: PullRequestSnapshot): Action[] {
  return pullRequest.digests
    .filter((digest) => !digest.minimized)
    .map((digest) => ({ kind: "minimize-comment", pullRequest: pullRequest.number, node: digest.node, classifier: "OUTDATED" }));
}

/**
 * A Digest run that failed or ran past its time limit, in the push job:
 * the no-Digest line says how, on the pull request, and then the gate opens
 * as it does after a Digest. No failure notice follows, the line mentions
 * nobody, nothing is handed to the Operator and nothing counts against the
 * Ticket's Retries. A reply the agent job's own check refused reads as
 * refused here too. One for a pull request that has moved on is dropped, as
 * a finished one is.
 */
export function noDigestAfter(run: FailedRun, failure: InfrastructureFailure, pullRequest: PullRequestSnapshot | null, operator: string): Plan {
  if (pullRequest === null || run.digest === undefined || run.digest.pullRequest !== pullRequest.number) return MISSING_PULL_REQUEST;
  const head = run.digest.headSha;
  const dropped = whyDropped(pullRequest, head);
  if (dropped !== null) return drop(pullRequest, dropped);
  const { runUrl } = run;
  if (failure === "timeout") return attemptEnded(pullRequest, noDigestLine({ head, how: "timed-out", runUrl }), operator);
  if (failure === "missing-output") return attemptEnded(pullRequest, noDigestLine({ head, how: "refused", reason: REFUSED_IN_AGENT_JOB, runUrl }), operator);
  return attemptEnded(pullRequest, noDigestLine({ head, how: "failed", runUrl }), operator);
}

/** Kit code's reason on a reply the agent job's check refused: its own words, never the agent's. */
const REFUSED_IN_AGENT_JOB = "it broke the reply's shape in the agent job";

/** What an attempt that ends with something to say comes to: its one comment, what follows a Digest's posting, then the gate opens. */
function attemptEnded(pullRequest: PullRequestSnapshot, body: string, operator: string, afterPosting: readonly Action[] = []): Plan {
  return { kind: "act", actions: [{ kind: "comment", issue: pullRequest.number, body }, ...afterPosting, ...openGate(pullRequest, operator)] };
}

/**
 * The gate opens, after anything posted: `agent:digest` off, the pull
 * request out of draft, the Operator's review requested, in that order. The
 * last two only when the gate has not opened for this pass
 * (`gateUnopened`): on a pull request already at the Merge gate, or one the
 * Operator put back in draft, the label comes off and nothing else moves.
 */
export function openGate(pullRequest: PullRequestSnapshot, operator: string): Action[] {
  return [labelOff(pullRequest), ...(gateUnopened(pullRequest) ? gateOpening(pullRequest, operator) : [])];
}

/**
 * Whether the Merge gate has yet to open for the pass on the pull request's
 * head: a draft whose latest Verdict is that pass, and which has not left
 * draft since it.
 */
export function gateUnopened(pullRequest: PullRequestSnapshot): boolean {
  return pullRequest.draft && passedAt(pullRequest, pullRequest.headSha) && !pullRequest.leftDraftSinceVerdict;
}

/**
 * A dropped attempt: nothing is posted, the label comes off, the gate stays
 * closed and the step summary says why. A head that moved gets a Review of
 * its own, whose pass brings the next Digest; a run in flight lands first; a
 * closed pull request has no gate.
 */
function drop(pullRequest: PullRequestSnapshot, why: string): Plan {
  return { kind: "act", actions: [labelOff(pullRequest)], notes: [`The Digest of #${pullRequest.number} was dropped: ${why}`] };
}

function labelOff(pullRequest: PullRequestSnapshot): Action {
  return { kind: "remove-label", issue: pullRequest.number, label: DIGEST_LABEL };
}

/**
 * Why a Digest written as of `headSha` is not the pull request's to have any
 * more, or null while it is: the pull request closed, its head moved, a run
 * is now in flight on it, or its latest Verdict is no longer that pass.
 */
function whyDropped(pullRequest: PullRequestSnapshot, headSha: string): string | null {
  const { number } = pullRequest;
  const short = headSha.slice(0, 7);
  if (!pullRequest.open) return `#${number} is closed`;
  if (pullRequest.headSha !== headSha) return `#${number} has moved on from ${short}`;
  const run = runInFlight(pullRequest);
  if (run !== null) return `${runName(run)} on #${number} is in flight`;
  if (!passedAt(pullRequest, headSha)) return `#${number}'s latest Verdict is no longer the pass on ${short}`;
  return null;
}

/** Whether the pull request's latest Verdict is a pass given on `headSha`. */
function passedAt(pullRequest: PullRequestSnapshot, headSha: string): boolean {
  const latest = pullRequest.verdicts.at(-1);
  return latest !== undefined && latest.verdict === "pass" && latest.headSha === headSha;
}
