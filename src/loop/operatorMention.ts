// The Operator's mention (#785, spec #774). The Kit heals an Unrelated failure
// short of setting it aside (ADR-0031): one more re-run at the Merge gate
// (src/loop/gateRerun.ts), Triage routing the check's issue, and bringing the
// PR up to date once that issue closes as completed (src/loop/conflicts.ts).
// Until those moves are spent the Operator hears of the failure as quietly as
// of a Flaky check. Once they are, the hourly Tick @-mentions the Operator on
// the PR, once per PR and check, by its own marker: the PR is at the Merge
// gate, held by an Unrelated failure still red on its head, the re-run there
// is done or skipped for that head, and the check's issue waits on the
// Operator, closed as not planned or a duplicate, or its fix was brought in
// and the check is still red. While the check's issue is ready-for-agent, or
// a PR for it is open, the fix is under way and nothing is posted. The Kit
// never takes a check off the Required list, skips it or merges past it: the
// mention says what's left, which is the Operator's. Pure.
import { fixBroughtTo } from "./conflicts.ts";
import { checkCode, passedHeadAtGate } from "./flakyChecks.ts";
import { gateRerunSpent, stillRed } from "./gateRerun.ts";
import { NEEDS_DESIGN, NEEDS_INFO, NEEDS_TRIAGE, READY_FOR_AGENT, READY_FOR_HUMAN } from "./labels.ts";
import { flakyCheckIssueOf, operatorMentionMarker } from "./markers.ts";
import type { ClosedCheckIssue, KitIssueSnapshot, PassedHeadChecks, Plan, PullRequestSnapshot, Snapshot } from "./types.ts";

/** How long a check's issue may sit in needs-triage before it counts as waiting on the Operator: Triage runs on it within minutes of its filing. */
const TRIAGE_GRACE_MS = 60 * 60_000;

/** The labels on a check's issue that say it waits on the Operator. */
const WAITING_ON_OPERATOR = [NEEDS_DESIGN, READY_FOR_HUMAN, NEEDS_INFO] as const;

/** What the Tick read of the check's issues, and of the PRs open for them. */
interface CheckIssues {
  readonly open: readonly KitIssueSnapshot[];
  readonly closed: readonly ClosedCheckIssue[];
  /** The Tickets an open agent PR is for. */
  readonly inFlight: ReadonlySet<number>;
}

/** One check the mention names: its issue, and why the Kit's moves on it are spent, as a clause. */
interface Spent {
  readonly name: string;
  readonly issue: number;
  readonly why: string;
}

/**
 * Why the Kit's moves on `check` are spent on this PR, or null while one is
 * left: the check's open issue, if any, else its latest closed one, is
 * weighed, and its fix brought in counts whatever a fresh issue says, unless
 * that issue is ready-for-agent or has a PR open.
 */
function spentOn(now: string, pullRequest: PullRequestSnapshot, check: string, issues: CheckIssues): Spent | null {
  const open = issues.open.find((issue) => flakyCheckIssueOf(issue.body) === check);
  if (open !== undefined && (open.labels.includes(READY_FOR_AGENT) || issues.inFlight.has(open.number))) return null;
  const name = checkCode(check);
  const brought = fixBroughtTo(pullRequest, check);
  if (brought !== null) {
    const how =
      brought.outcome === "held-main"
        ? `#${brought.issue} closed as completed while #${pullRequest.number} already held \`main\`'s head, and ${name} is still red on it`
        : `the Kit brought #${pullRequest.number} up to date after #${brought.issue} closed as completed, and ${name} is still red on the new head`;
    const since = open === undefined || open.number === brought.issue ? "" : `; its failure since is on #${open.number}`;
    return { name: check, issue: brought.issue, why: `${how}${since}` };
  }
  if (open !== undefined) {
    const waiting = WAITING_ON_OPERATOR.find((label) => open.labels.includes(label));
    if (waiting !== undefined) return { name: check, issue: open.number, why: `its issue #${open.number} is \`${waiting}\`` };
    const filed = open.createdAt === undefined ? NaN : Date.parse(open.createdAt);
    if (open.labels.includes(NEEDS_TRIAGE) && Date.parse(now) - filed >= TRIAGE_GRACE_MS) {
      return { name: check, issue: open.number, why: `its issue #${open.number} is still \`${NEEDS_TRIAGE}\` more than an hour after it was filed` };
    }
    return null;
  }
  const closed = issues.closed.find((issue) => issue.check === check);
  if (closed?.stateReason === "not-planned") return { name: check, issue: closed.number, why: `its issue #${closed.number} closed as not planned` };
  if (closed?.stateReason === "duplicate") return { name: check, issue: closed.number, why: `its issue #${closed.number} closed as a duplicate` };
  return null;
}

/**
 * The checks to mention on one PR: each Unrelated failure its latest pass,
 * on its head at the Merge gate, names that is still red there, with one
 * more re-run there done or skipped for that head, the Kit's other moves on
 * it spent, and no mention of it on this PR yet.
 */
function toMention(now: string, pullRequest: PullRequestSnapshot, head: PassedHeadChecks, issues: CheckIssues): Spent[] {
  const headSha = passedHeadAtGate(pullRequest);
  if (headSha === null || head.headSha !== headSha) return [];
  const pass = pullRequest.verdicts.findLast((record) => record.verdict === "pass");
  const mentioned = new Set(pullRequest.operatorMentions.flatMap((mark) => mark.checks.map(({ name }) => name)));
  const green = new Set(pullRequest.flakyCheckMarks.filter((mark) => mark.headSha === headSha).flatMap((mark) => mark.checks));
  return (pass?.unrelated ?? []).flatMap((check) => {
    if (mentioned.has(check) || green.has(check) || !stillRed(head.checkRuns, check) || !gateRerunSpent(pullRequest, headSha, check)) return [];
    const spent = spentOn(now, pullRequest, check, issues);
    return spent === null ? [] : [spent];
  });
}

/** The one comment mentioning the Operator on this PR, for these checks. */
function mentionBody(operator: string, pullRequest: PullRequestSnapshot, headSha: string, spent: readonly Spent[]): string {
  const one = spent.length === 1;
  return [
    operatorMentionMarker({ headSha, checks: spent.map(({ name, issue }) => ({ name, issue })) }),
    `@${operator} #${pullRequest.number} is held at the Merge gate on ${headSha.slice(0, 7)} by ${one ? "an Unrelated failure" : "Unrelated failures"}, which the Reviewer judged it didn't cause, ` +
      `and the Kit has nothing left to try: ${one ? "its" : "their"} one more re-run there is done or skipped, and`,
    ...spent.map(({ name, why }) => `- ${checkCode(name)}: ${why}.`),
    "",
    `What's left is yours${one ? "" : ", for each"}: re-run it, fix it, or merge past it by hand as ADR-0019 describes ` +
      `(switch off "Do not allow bypassing the above settings" in the branch's settings, merge, then run Setup to put it back). ` +
      `The Kit never takes a check off the Required list, skips it or merges past it, and won't mention ${one ? "this check" : "these checks"} on #${pullRequest.number} again.`,
  ].join("\n");
}

/**
 * The Tick's mentions of the Operator (#785): for each open agent PR at the
 * Merge gate, one comment naming every check whose Kit moves are spent, once
 * per PR and check.
 */
export function operatorMentionGate(now: string, snapshot: Snapshot): Plan {
  const { passedHeads, conflicts } = snapshot;
  if (passedHeads === null || typeof passedHeads === "string" || conflicts === null) {
    return { kind: "nothing", reason: "The Tick read no passed head at the Merge gate, so it mentions nobody over an Unrelated failure there" };
  }
  const issues: CheckIssues = {
    open: snapshot.flakyCheckIssues,
    closed: snapshot.closedCheckIssues ?? [],
    inFlight: new Set(conflicts.pullRequests.flatMap(({ pullRequest }) => (pullRequest.open && pullRequest.ticket !== null ? [pullRequest.ticket] : []))),
  };
  const actions = passedHeads.flatMap((head) => {
    const pullRequest = conflicts.pullRequests.find((candidate) => candidate.pullRequest.number === head.pullRequest)?.pullRequest;
    if (pullRequest === undefined) return [];
    const spent = toMention(now, pullRequest, head, issues);
    return spent.length === 0 ? [] : [{ kind: "comment" as const, issue: pullRequest.number, body: mentionBody(snapshot.operator, pullRequest, head.headSha, spent) }];
  });
  return actions.length === 0
    ? { kind: "nothing", reason: "No Unrelated failure holding a PR at the Merge gate has had the Kit's moves on it spent without a mention" }
    : { kind: "act", actions };
}
