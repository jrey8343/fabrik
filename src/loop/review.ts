// Review rules: when a Review starts on an agent PR, and how its Verdict lands.
// On green, the Reviewer's Verdict line decides. On a head whose Required
// checks are still red after everything the Kit could do, the Reviewer runs
// too, and its Verdict holds the red checks beside its findings (#779), each
// with the Reviewer's judgment: a check it judged caused makes anything short
// of a Design flaw an Execution flaw that counts, and an Unrelated failure
// counts toward nothing (#780). Every Verdict is posted as a PR comment with
// its marker. Routing flaws onward is for later rules.
import { whyNotReviewable } from "./agentPullRequest.ts";
import { backToDesignActions, backToDesignLine } from "./backToDesign.ts";
import { upToDateBeforeMergeGate } from "./conflicts.ts";
import { consideredSection } from "./considered.ts";
import { declineTrigger } from "./declineTrigger.ts";
import { digestOnPass } from "./digest.ts";
import { checkCode } from "../review/failureExcerpt.ts";
import { flakyCheckActions } from "./flakyChecks.ts";
import { type UnrelatedFailure, unrelatedFailureActions } from "./unrelatedFailures.ts";
import { followUpsSection } from "./followUps.ts";
import { type HeldOn, heldOn, heldUntilThen, startsWhen } from "./hold.ts";
import { DISPATCH_LABEL, READY_FOR_HUMAN, REVIEW_LABEL } from "./labels.ts";
import { withoutMentions } from "./mentions.ts";
import { hasVerdictOn, retryAfterFlaw, type VerdictNext, whyAwaitingRun } from "./retry.ts";
import { operatorChangesRequests, reviewLinks } from "./undelivered.ts";
import { verdictMarker } from "./markers.ts";
import { changeLine } from "./changeFingerprint.ts";
import { GITHUB_COMMENT_LIMIT } from "./roundLine.ts";
import { parseVerdict, type RedCheckJudgment, verdictTagsOf } from "./verdict.ts";
import { redChecksLinked } from "./redChecks.ts";
import { issueRef } from "./checkIssue.ts";
import { type Linked, linkedComment, linkedLength } from "./linked.ts";
import type {
  Action,
  CreatedIssue,
  KitConfig,
  LoopEvent,
  Plan,
  PostedComment,
  PullRequestSnapshot,
  RedRequiredChecks,
  ReviewKind,
  Snapshot,
  Verdict,
  VerdictRecord,
  VerdictTags,
} from "./types.ts";

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
        reviewKind: reviewKindOf(pullRequest),
        ...(uiEvidenceMarker === null ? {} : { evidence: uiEvidenceMarker }),
        model,
        effort,
        timeoutMinutes,
      },
    ],
  };
}

/**
 * Which kind of Review starts on the PR now (#747), from its Verdict markers
 * alone: a later Review, judged against the head of its latest Reviewer
 * Verdict, or a Full Review when it has none, or that one has no change line
 * under it to judge the change since against (it predates #643). A PR's
 * Verdicts are its own, so a new PR after Back to design or from a Kept-branch
 * start has none, and its first Review is Full.
 */
export function reviewKindOf({ verdicts }: Pick<PullRequestSnapshot, "verdicts">): ReviewKind {
  const latest = verdicts.findLast((record) => record.source === "reviewer");
  if (latest?.change === undefined) return { kind: "full" };
  return { kind: "later", lastJudged: { headSha: latest.headSha, change: latest.change } };
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

/**
 * The Reviewer's Verdict. A reply that breaks the contract is an
 * Infrastructure failure, never a pass. A pass starts the Digest writer,
 * and the Merge gate opens when its attempt ends; with the Digest off it
 * takes the PR out of draft and requests the Operator's review itself
 * (src/loop/digest.ts). Unless the PR conflicts with main: then it stays in
 * draft and is brought up to date, and the pass on that head does that
 * (#480).
 */
export function applyReview(event: Reviewed, snapshot: Snapshot, config: KitConfig): Plan {
  return landVerdict(event, snapshot, (pullRequest) => {
    // On a head still red after everything the Kit could do (#779), each red check with the Reviewer's judgment (#780).
    const red = event.redChecks;
    const parsed = parseVerdict(event.output, red?.failed ?? []);
    if (!parsed.ok) {
      return { kind: "fail", failure: "infrastructure", reason: `The Review of #${pullRequest.number} gave no valid Verdict: ${parsed.error}` };
    }
    const findings = withoutMentions(parsed.findings);
    // A run this Verdict starts is held while every Subscription is used up, and its note says so (#341).
    const held = heldOn(snapshot.kitIssues, config);
    // The red checks the Reviewer judged caused count as the PR's own; the Unrelated failures count toward nothing (#780).
    const judged = parsed.redChecks;
    const counting = judged.filter(({ judgment }) => judgment === "caused").map(({ check }) => check);
    const unrelated = judged.filter(({ judgment }) => judgment === "unrelated").map(({ check }) => check);
    const verdict = verdictOnRedHead(parsed.verdict, counting);
    // Each Unrelated failure is said on the PR ahead of the Verdict, with its check's issue, which the Verdict links too (#781).
    // A second Verdict on this head, after a Touch-up that changed only the body (#751), says none again.
    const saidBefore = pullRequest.verdicts.filter(({ headSha }) => headSha === event.headSha).flatMap((record) => record.unrelated ?? []);
    const said = unrelatedFailureActions(pullRequest.number, event.headSha, unrelatedFailuresOf(judged, red, event.runUrl), snapshot.flakyCheckIssues, saidBefore);
    // A pass is what the Reviewer checked, then any Follow-ups; a flaw is its findings.
    const reviewed = parsed.verdict === "pass" && findings !== "" ? `### Checked\n\n${findings}` : findings;
    // Counted as the Review that gave it was started (#749): the snapshot holds the Verdicts before this one. A pass a
    // red check made a flaw has no finding of its own: its findings are the red checks, which are never tagged ones.
    const tags = parsed.verdict === "pass" && verdict === "execution-flaw" ? NO_FINDINGS : verdictTagsOf(parsed, reviewKindOf(pullRequest).kind === "full");
    const actions = verdictActions(event, pullRequest, {
      verdict,
      source: "reviewer",
      findings:
        red === undefined ? reviewed : (room) => withRedChecks(reviewed, red, { verdict, passed: parsed.verdict === "pass", headSha: event.headSha, judged, issues: said.refs }, room),
      // Only a pass carries Follow-ups.
      followUps: verdict === "pass" ? followUpsSection(parsed.followUps, event.repoUrl, pullRequest.number) : [],
      considered: consideredSection(parsed.considered, event.operatorComments),
      ...(event.ranNothing === undefined ? {} : { ranNothing: event.ranNothing }),
      ...(counting.length === 0 ? {} : { checks: counting }),
      unrelated,
      tags,
    }, snapshot.operator, held);
    // Checks that passed when the Kit re-ran them (#462) are said ahead of the Verdict, which stays the one notification.
    actions.unshift(...flakyCheckActions(pullRequest.number, event.headSha, event.flaky ?? [], snapshot.flakyCheckIssues), ...said.actions);
    // A pass that gave way to a Request changes deferred during a Retry (#427) keeps the PR in draft for its run.
    if (verdict !== "pass" || passGivesWay(pullRequest)) return { kind: "act", actions };
    // One on a PR that conflicts with main brings it up to date first, in draft: the Operator's review couldn't land (#480).
    const bringUpToDate = upToDateBeforeMergeGate(pullRequest, snapshot.mergeable, held);
    if (bringUpToDate !== null) return { kind: "act", actions: [...actions, bringUpToDate] };
    // A pass that would open the Merge gate starts the Digest writer in its place, where the Digest is on (ADR-0022).
    return { kind: "act", actions: [...actions, ...digestOnPass(event, pullRequest, snapshot, config)] };
  });
}

/**
 * The red checks the Reviewer judged Unrelated failures (#781), each with its
 * reason as a sentence that mentions nobody, and the Failure excerpt the
 * Review read of it, linking its red run; with none read, the Review's run.
 */
function unrelatedFailuresOf(judged: readonly RedCheckJudgment[], red: RedRequiredChecks | undefined, runUrl: string): UnrelatedFailure[] {
  return judged.flatMap(({ check, judgment, reason }) => {
    if (judgment !== "unrelated") return [];
    const excerpt = red?.excerpts.find((each) => each.check === check);
    return [{ name: check, red: excerpt?.link ?? runUrl, reason: sentence(withoutMentions(reason)), ...(excerpt === undefined ? {} : { excerpt }) }];
  });
}

/** The tags of a Verdict with no finding of its own: none of any kind. */
const NO_FINDINGS: VerdictTags = { small: 0, missedEarlier: 0, counted: 0, smallBody: 0 };

/**
 * What the Reviewer's Verdict line lands as on a head whose Required checks
 * are still red (#779), given the red checks that count as the pull
 * request's own, those it judged caused (#780): a Design flaw as given, and
 * anything else, a pass included, an Execution flaw while any red check
 * counts. With none counting, as when all are Unrelated failures, the line
 * lands as given.
 */
export function verdictOnRedHead(verdict: Verdict, counting: readonly string[]): Verdict {
  return verdict === "design-flaw" || counting.length === 0 ? verdict : "execution-flaw";
}

/**
 * A Reviewer's findings on a red head (#779), then its "Red Required checks"
 * part: each check under its name with the Reviewer's judgment and reason
 * (#780), an Unrelated failure's linking its check's issue (#781), its
 * attempts, its Failure excerpt and its job link, the excerpts
 * fitted to what's left of `room`. An Execution flaw says which checks are
 * Unrelated failures and that the run fixing it leaves them alone; a pass
 * names each and says the Merge gate holds the pull request until it is green.
 */
function withRedChecks(
  findings: string,
  red: RedRequiredChecks,
  {
    verdict,
    passed,
    headSha,
    judged,
    issues,
  }: {
    readonly verdict: Verdict;
    readonly passed: boolean;
    readonly headSha: string;
    readonly judged: readonly RedCheckJudgment[];
    /** Each Unrelated failure's issue (#781), which its note links. */
    readonly issues: ReadonlyMap<string, number | CreatedIssue>;
  },
  room: number,
): Linked {
  const short = headSha.slice(0, 7);
  const caused = judged.filter(({ judgment }) => judgment === "caused");
  const unrelated = judged.filter(({ judgment }) => judgment === "unrelated").map(({ check }) => check);
  const one = unrelated.length === 1;
  const judgedUnrelated =
    unrelated.length === 0
      ? []
      : [`The Reviewer judged ${one ? `${checkCode(unrelated[0]!)} an Unrelated failure` : `each of these an Unrelated failure`}, which doesn't count${one ? "" : `: ${listed(unrelated.map(checkCode))}`}.`];
  const intro = [
    verdict === "design-flaw"
      ? `These Required checks were still red on ${short} after everything the Kit could do.`
      : caused.length > 0
        ? `${passed ? "The Reviewer found no flaw in the code, but these" : "These"} Required checks are still red on ${short} after everything the Kit could do. The Reviewer judged ${listed(caused.map(({ check }) => checkCode(check)))} caused by this pull request, so this Verdict is an Execution flaw that counts.`
        : `These Required checks are still red on ${short} after everything the Kit could do.`,
    ...judgedUnrelated,
    ...(unrelated.length === 0 || verdict === "design-flaw"
      ? []
      : [verdict === "pass" ? `The Merge gate holds this pull request until ${one ? "it is" : "each is"} green on its head.` : `The run that fixes this Verdict leaves ${one ? "it" : "them"} alone.`]),
  ].join(" ");
  const notesOf = (check: string): Linked[] => {
    const given = judged.find((each) => each.check === check);
    if (given === undefined) return [];
    const reason = sentence(withoutMentions(given.reason));
    if (given.judgment === "caused") return [[`Caused by this pull request: ${reason}`]];
    const issue = issues.get(check);
    return [issue === undefined ? [`An Unrelated failure: ${reason}`] : ["An Unrelated failure, reported on ", issueRef(issue), `: ${reason}`]];
  };
  const head = [...(findings === "" ? [] : [findings]), "### Red Required checks", intro, ""].join("\n\n");
  return [head, ...redChecksLinked(red, room - head.length, notesOf)];
}

/** A reason as a sentence: ending in a full stop unless it ends in one already. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Names as prose: `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Lands a Verdict only on the agent draft PR it was given for, at the commit it judged, once, or once more after a body-only Touch-up (#751). */
function landVerdict(
  event: Reviewed,
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
  if (hasVerdictOn(pullRequest, event.headSha)) {
    return { kind: "nothing", reason: `#${pullRequest.number} already has a Verdict on ${event.headSha.slice(0, 7)}` };
  }
  // A Review that started before the run was called for lands nothing either.
  const awaiting = whyAwaitingRun(pullRequest);
  if (awaiting !== null) return { kind: "nothing", reason: awaiting };
  return decide(pullRequest);
}

/** Who a Verdict the Loop posts is from. One from red checks alone, source `ci`, is never posted since #779, and still reads. */
type PostedSource = Exclude<VerdictRecord["source"], "ci">;

const BY: Readonly<Record<PostedSource, string>> = {
  reviewer: "the Reviewer",
  "empty-diff": "a retry that changed nothing",
  "broken-run": "a Broken run",
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
 * it is a fresh event, and ready-for-human off the PR, as the Loop has it
 * again (#436). An Execution flaw then starts its retry, if one is
 * left; a Design flaw, or an Execution flaw with none left, sends the Ticket
 * back to design. A pass's Follow-ups (src/loop/followUps.ts) follow its
 * findings. A Reviewer's Verdict ends with the Operator comments it
 * weighed, as `considered` (src/loop/considered.ts) renders them. Whatever
 * its source, the comment's second line is the fingerprint of the PR's own
 * change (src/loop/changeFingerprint.ts), when the snapshot holds one (#643).
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
    checks,
    unrelated = [],
    ranNothing,
    tags = null,
  }: {
    readonly verdict: Verdict;
    readonly source: PostedSource;
    /**
     * The findings, or, for findings that fit themselves to a room, them given
     * what the comment has left around them (#775), which may link the issues
     * the plan files (#781).
     */
    readonly findings: string | ((room: number) => Linked);
    /** On a Reviewer's Execution flaw, its findings counted by tag (#749). */
    readonly tags?: VerdictTags | null;
    /** On a Reviewer's Verdict on a head still red (#779), the red checks it counts: those it judged caused (#780). */
    readonly checks?: readonly string[];
    /** On a Reviewer's Verdict on a head still red, the red checks it judged Unrelated failures (#780), which count toward nothing. */
    readonly unrelated?: readonly string[];
    /** On a Reviewer's Verdict, the Required checks that ran nothing on its head (#456). */
    readonly ranNothing?: readonly string[];
    readonly followUps?: readonly string[];
    readonly considered?: readonly string[];
  },
  operator: string,
  held: HeldOn | null,
): Action[] {
  const first =
    verdict === "execution-flaw" ? requestChangesFirst(pullRequest, operator, held) : verdict === "pass" ? deferredFirst(pullRequest, held) : null;
  // A Verdict naming red checks counts whatever its findings' tags (#779): it never calls for a Touch-up.
  const next: VerdictNext | null = first ?? nextAfter(verdict, pullRequest, held, (checks?.length ?? 0) > 0 ? null : tags);
  const record: VerdictRecord = {
    verdict,
    source,
    requestChanges: pullRequest.requestChangesRun,
    ...(pullRequest.conflictRun ? { conflictRun: true as const } : {}),
    ...(first === null ? {} : { requestChangesFirst: first.reviews }),
    ...(next?.ticketNotReady === true ? { ticketNotReady: true as const } : {}),
    ...(checks === undefined ? {} : { checks }),
    ...(unrelated.length === 0 ? {} : { unrelated }),
    ...(ranNothing === undefined || ranNothing.length === 0 ? {} : { ranNothing }),
    ...(tags === null ? {} : { tags }),
    ...(next?.touchUp === undefined ? {} : { touchUp: next.touchUp }),
    headSha: event.headSha,
  };
  const by = BY[source];
  const header = [
    `## Verdict: ${HEADINGS[verdict]}`,
    "",
    `From ${by}, on ${event.headSha.slice(0, 7)}${record.requestChanges ? ", after a Request-changes run" : ""}${record.conflictRun === true ? ", after a conflict-only run" : ""}.`,
  ];
  const footer = [...followUps, ...(next === null ? [] : ["", next.line]), "", `[The run](${event.runUrl})`, ...considered];
  // The lines `top`, the header, the findings after a blank line when there are any, and the footer, one to a line.
  const composed = (top: readonly string[], findings: Linked): Linked =>
    findings.length === 0
      ? [[...top, ...header, ...footer].join("\n")]
      : [`${[...top, ...header].join("\n")}\n\n`, ...findings, `\n${footer.join("\n")}`];
  // The fingerprint of the PR's own change (#643), when the push job read one at the head this Verdict is on:
  // the PR's own head, or the head a Retry that changed nothing started at, which the PR may have moved on from.
  const read = pullRequest.headSha === event.headSha ? pullRequest.change : pullRequest.changeAt?.headSha === event.headSha ? pullRequest.changeAt.change : undefined;
  const change = read === undefined ? [] : [changeLine(read)];
  // Findings that fit themselves are given the room the rest of the comment leaves, less the blank line before them.
  const room = GITHUB_COMMENT_LIMIT - linkedLength(composed([verdictMarker(record), ...change], [])) - 2;
  const given = typeof findings === "string" ? (findings === "" ? [] : [findings]) : findings(room);
  const withChange = composed([verdictMarker(record), ...change], given);
  // A Verdict never fails for want of one: a line that would take the comment past GitHub's limit is left out.
  const body = linkedLength(withChange) <= GITHUB_COMMENT_LIMIT ? withChange : composed([verdictMarker(record)], given);
  // ready-for-human, which the Kit put on the PR when a run it started there ended without pushing, comes off too:
  // with a Verdict, the PR is back in the Loop.
  const labelsOff: Action[] = ([REVIEW_LABEL, READY_FOR_HUMAN] as const)
    .filter((label) => pullRequest.labels.includes(label))
    .map((label): Action => ({ kind: "remove-label", issue: pullRequest.number, label }));
  return [
    ...labelsOff,
    linkedComment(pullRequest.number, body, VERDICT_COMMENT.posted),
    ...(next?.actions ?? []),
  ];
}

/** A Verdict that gives way to the Operator's Request changes: the reviews it names in its marker, its line and what starts their run. */
type GaveWay = VerdictNext & { readonly reviews: number[] };

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
  held: HeldOn | null,
): GaveWay | null {
  if (pullRequest.ticket === null) return null;
  // Not to the reviews of a Request-changes run in flight.
  const reviews = operatorChangesRequests(pullRequest, operator)
    .map(({ review }) => review)
    .filter((review) => !pullRequest.requestChangesRunReviews.includes(review));
  if (reviews.length === 0) return null;
  return {
    reviews,
    line: `The Operator's Request changes on #${pullRequest.number} (${reviewLinks(pullRequest, reviews)}) hasn't been built, so it goes first: its Request-changes run ${startsWhen(held)}, on the Step-up model, and fixes these findings too. This Execution flaw uses no retry.${heldUntilThen(held)}`,
    // A fresh agent:implement on the Ticket starts the run this Verdict put in flight. It notifies nobody.
    actions: [{ kind: "add-labels", issue: pullRequest.ticket, labels: [DISPATCH_LABEL] }],
  };
}

/** Whether a pass on this PR gives way to the Operator's Request changes deferred while a Retry was in flight (#427). */
function passGivesWay(pullRequest: PullRequestSnapshot): boolean {
  return deferredFirst(pullRequest, null) !== null;
}

/**
 * What a pass leads to when the Operator requested changes on the draft while
 * the Retry it judges was in flight (#427): the Review was never given those
 * reviews, so the pass settles none of them. Their Request-changes run starts
 * now, as though they had arrived at the Merge gate, and the PR stays in draft
 * for it. Its marker names the reviews, so the run is in flight from it. Null
 * when none is deferred.
 */
function deferredFirst(pullRequest: PullRequestSnapshot, held: HeldOn | null): GaveWay | null {
  if (pullRequest.ticket === null || pullRequest.deferredChangesRequests.length === 0) return null;
  const reviews = [...pullRequest.deferredChangesRequests];
  return {
    reviews,
    line: `The Operator's Request changes on #${pullRequest.number} (${reviewLinks(pullRequest, reviews)}) came in while the Retry worked, so this Review judged #${pullRequest.number} against the Ticket without it. Its Request-changes run ${startsWhen(held)}, on the Step-up model, and uses no retry, and Review runs again on its push.${heldUntilThen(held)}`,
    // A fresh agent:implement on the Ticket starts the run this Verdict put in flight. It notifies nobody.
    actions: [{ kind: "add-labels", issue: pullRequest.ticket, labels: [DISPATCH_LABEL] }],
  };
}

/** What a Verdict leads to beyond its comment: a Touch-up or retry, back to design, or (for a pass) nothing here. */
function nextAfter(verdict: Verdict, pullRequest: PullRequestSnapshot, held: HeldOn | null, tags: VerdictTags | null): VerdictNext | null {
  if (verdict === "pass") return null;
  const retry = verdict === "execution-flaw" ? retryAfterFlaw(pullRequest, held, tags) : null;
  if (retry !== null) return retry;
  const reason = verdict === "design-flaw" ? "design-flaw" : "retries-used-up";
  return { line: backToDesignLine(pullRequest, reason), actions: backToDesignActions(pullRequest, reason, VERDICT_COMMENT) };
}
