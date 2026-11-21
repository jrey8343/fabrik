// The Unrelated failures the Kit is healing on an agent pull request at the
// Merge gate (#795, ADR-0031; src/kit/standing.ts). The Reviewer's pass names
// them, and the Kit then has moves of its own: one more re-run at the gate,
// Triage routing the Check's issue, and bringing the pull request up to date
// once that issue's fix lands. Until it mentions the Operator a failing one
// is the Kit's, so its Standing is too. The rule decides nothing for the
// Loop: it reads what the Loop left on the pull request, through each
// marker's own reader, and the Check's issue as the Operator's mention reads
// it (src/loop/operatorMention.ts). The mention is the one sign that the
// Kit's moves are spent; "spent" is never worked out here a second time.
import { fixUnderWay, openCheckIssue } from "../loop/checkIssue.ts";
import { gateRerunAsked, gateRerunSpent } from "../loop/gateRerun.ts";
import { FLAKY_CHECK_LABEL, READY_FOR_AGENT } from "../loop/labels.ts";
import { gateRerunMarksIn, operatorMentionMarksIn } from "../loop/markers.ts";
import { verdictsOn } from "./retroEvidence.ts";
import type { HealingCheck, StandingFacts } from "./standing.ts";
import { barOf, clockOf, stuckAtOf } from "./standingClock.ts";
import type { PassedPullRequestMove } from "./standingOperator.ts";
import type { MergeGatePass } from "./standingPlain.ts";
import type { OpenIssueFacts, OpenPullRequestFacts } from "./weeklySummary.ts";

/**
 * The pass that opened this agent pull request's Merge gate, as its move
 * dates it (passedMoveOf), with what it keeps of its Unrelated failures.
 * A head moved since the pass heals nothing, as the Kit re-runs nothing
 * there, so it keeps none. On the head it passed, each check its latest
 * Verdict names an Unrelated failure is `mentioned` once any of the Fabrik
 * App's Operator-mention markers on the pull request names it, on any head,
 * and is healing until then.
 */
export function passAtTheGateOf(pullRequest: OpenPullRequestFacts, { since: passedAt, passedHead }: Pick<PassedPullRequestMove, "since" | "passedHead">, facts: StandingFacts): MergeGatePass {
  const unrelated = passedHead === pullRequest.headSha ? (verdictsOn(pullRequest.comments).at(-1)?.record.unrelated ?? []) : [];
  if (unrelated.length === 0) return { passedAt, passedHead, healing: [], mentioned: [] };
  const lines = pullRequest.comments.filter(({ author }) => author === facts.appLogin);
  const mentions = new Set(operatorMentionMarksIn(lines.map(({ body }) => body)).flatMap(({ checks }) => checks.map(({ name }) => name)));
  const gateReruns = gateRerunMarksIn(lines.map(({ body, at }) => ({ id: "", body, createdAt: at })));
  const rerunOf = (check: string): HealingCheck["rerun"] =>
    gateRerunSpent({ gateReruns }, passedHead, check) ? "done" : gateRerunAsked({ gateReruns }, passedHead, check) ? "asked" : "to-come";
  const clock = clockOf(passedAt, pullRequest.ticket, [pullRequest], facts);
  const bar = barOf(facts);
  // The Check's issues as the Loop's snapshot holds them (gatherKitIssues): labelled so, and read only where the Fabrik App opened them.
  const checkIssues = facts.github.openIssues.filter(({ labels, author }) => labels.includes(FLAKY_CHECK_LABEL) && author === facts.appLogin);
  const inFlight = new Set(facts.github.openPullRequests.flatMap(({ ticket }) => (ticket === null ? [] : [ticket])));
  return {
    passedAt,
    passedHead,
    mentioned: unrelated.filter((check) => mentions.has(check)),
    healing: unrelated
      .filter((check) => !mentions.has(check))
      .map((check) => {
        const issue = openCheckIssue(checkIssues, check);
        const stuckAt = fixUnderWay(issue, inFlight) ? null : stuckAtOf(latestOf([clock, ...fixStoppedAt(check, issue, facts)]), bar);
        return { check, rerun: rerunOf(check), issue: issue?.number ?? null, stuckAt };
      }),
  };
}

/**
 * When the fix of `check` stopped being under way, where the facts date it:
 * its open Check's issue last losing `ready-for-agent`, and a Check's issue
 * of its closing, as when the fix lands. The clock restarts there, so the
 * pull request never reads Stuck at that moment, before the Kit has had its
 * bar to bring it up to date or mention the Operator. No fact dates an agent
 * pull request for the fix closing unmerged: where that alone ended the fix,
 * its issue open and no longer `ready-for-agent`, the clock is not restarted.
 */
function fixStoppedAt(check: string, issue: OpenIssueFacts | undefined, { github }: StandingFacts): string[] {
  return [
    ...(issue?.labelEvents ?? []).filter(({ label, action }) => label === READY_FOR_AGENT && action === "unlabeled").map(({ at }) => at),
    ...(github.closedCheckIssues ?? []).filter((closed) => closed.check === check).map(({ closedAt }) => closedAt),
  ];
}

/** The latest of these times, ISO 8601, of which there is at least one. */
function latestOf(times: readonly [string, ...string[]]): string {
  return times.reduce((latest, at) => (Date.parse(at) > Date.parse(latest) ? at : latest));
}
