// Flaky checks (#462, GLOSSARY.md): a required check that reported both
// failure and success on the same head commit. The Kit finds one when its own
// re-run of the red checks passes (src/review/rerun.ts), or when the checks an
// Execution flaw named have since passed on its head, which the hourly tick
// reads; that Verdict then no longer counts toward the Ticket's Retries, unless
// it is a Reviewer's with an untagged finding beside its checks (#779). The
// tick also reads the head the Reviewer passed at the Merge gate, where a
// Required check that has both failed and succeeded is reported, with nothing
// counted back (#693), and an open draft's Unrelated failures
// (src/loop/unrelatedFailures.ts), one that has since passed on its head being
// a Flaky check. Each way the Operator hears of it twice over, quietly: one
// line on the PR, mentioning nobody, and the check's issue for Triage
// (src/loop/checkIssue.ts), filed once and commented on each time the check
// proves flaky again, so the Product's suite gets fixed. Pure.
import { checkCode, type FailureExcerpt } from "../review/failureExcerpt.ts";
import { type CheckReport, checkIssueActions, issueRef } from "./checkIssue.ts";
import { isRed, runsOf } from "./headChecks.ts";
import { flakyCheckMarker } from "./markers.ts";
import { unrelatedOnDraft } from "./unrelatedFailures.ts";
import type { Action, CreatedIssue, FlakyCheck, FlawHeadChecks, KitIssueSnapshot, PassedHeadChecks, Plan, PullRequestSnapshot, Snapshot, SweptHead, VerdictRecord } from "./types.ts";

/** What a check's issue says of a Flaky check's red run, as its body's opening and as a later comment, with the PR, head and run links. */
function reportOf(pullRequest: number, short: string, { name, red, green, excerpt }: FlakyCheck): CheckReport {
  const runs = `#${pullRequest} at ${short}: [red](${red}), [green](${green})`;
  return {
    kind: "flaky-check",
    name,
    red,
    ...(excerpt === undefined ? {} : { excerpt }),
    opening: [
      `The required check ${checkCode(name)} reported both failure and success on the same head commit: a Flaky check. ` +
        "Each time it fails costs a Review a re-run, and one the Kit doesn't catch costs a Ticket a Retry, so it's worth fixing in the suite.",
      "",
      `- ${runs}`,
    ].join("\n"),
    again: `Flaky again on ${runs}.`,
  };
}

/** Each Flaky check's issue (src/loop/checkIssue.ts), filed or commented on, and each one's issue in order. */
function issueActions(pullRequest: number, headSha: string, flaky: readonly FlakyCheck[], issues: readonly KitIssueSnapshot[], filed: Map<string, CreatedIssue>) {
  const short = headSha.slice(0, 7);
  return checkIssueActions(headSha, flaky.map((check) => reportOf(pullRequest, short, check)), issues, filed);
}

/**
 * What the Kit does about checks its own re-run found flaky on this head: each
 * one's issue, then one line on the PR, mentioning nobody, with its marker.
 * The pass or flaw that follows is the event's one notification.
 */
export function flakyCheckActions(
  pullRequest: number,
  headSha: string,
  flaky: readonly FlakyCheck[],
  issues: readonly KitIssueSnapshot[],
): Action[] {
  return flakyLineActions(pullRequest, headSha, flaky, issues, new Map(), (name, short) => `${name} failed on ${short} and passed when the Kit re-ran it on the same head`);
}

/**
 * Each Flaky check's issue, then one line on the PR, mentioning nobody, with
 * its marker, which says each check in its `wording` and links its issue. Nothing
 * when none is flaky.
 */
function flakyLineActions(
  pullRequest: number,
  headSha: string,
  flaky: readonly FlakyCheck[],
  issues: readonly KitIssueSnapshot[],
  filed: Map<string, CreatedIssue>,
  wording: (name: string, short: string) => string,
): Action[] {
  if (flaky.length === 0) return [];
  const { actions, refs } = issueActions(pullRequest, headSha, flaky, issues, filed);
  const short = headSha.slice(0, 7);
  const body: (string | CreatedIssue)[] = [flakyCheckMarker({ headSha, checks: flaky.map(({ name }) => name) }), "\n"];
  flaky.forEach(({ name }, at) => {
    body.push(`${at === 0 ? "" : " "}${wording(checkCode(name), short)}: a Flaky check (`);
    body.push(issueRef(refs[at]!), ").");
  });
  return [...actions, { kind: "comment-linking", issue: pullRequest, body }];
}

/**
 * What the Kit does once the checks an Execution flaw counted back on green
 * (countsBackOnGreen) named have since passed on the head it was given on (#462): each one's issue, then one
 * line on the PR, mentioning nobody, marking that Verdict counted back, so it
 * no longer counts toward the Ticket's Retries. A Retry already in flight keeps
 * running.
 */
export function countedBackActions(
  pullRequest: number,
  ticket: number | null,
  headSha: string,
  flaky: readonly FlakyCheck[],
  issues: readonly KitIssueSnapshot[],
  filed: Map<string, CreatedIssue> = new Map(),
): Action[] {
  const { actions, refs } = issueActions(pullRequest, headSha, flaky, issues, filed);
  const short = headSha.slice(0, 7);
  const names = flaky.map(({ name }) => checkCode(name)).join(", ");
  const body: (string | CreatedIssue)[] = [
    flakyCheckMarker({ headSha, checks: flaky.map(({ name }) => name), countedBack: true }),
    "\n",
    `${names} ${flaky.length === 1 ? "has" : "have"} since passed on ${short}, where ${flaky.length === 1 ? "its" : "their"} failure gave an Execution flaw: ` +
      `a Flaky check, so that Verdict no longer counts toward ${ticket === null ? "the Ticket" : `#${ticket}`}'s Retries (`,
  ];
  refs.forEach((ref, at) => body.push(...(at === 0 ? [] : [", "]), issueRef(ref)));
  body.push(").");
  return [...actions, { kind: "comment-linking", issue: pullRequest, body }];
}

/**
 * Whether an Execution flaw naming red checks is counted back once they all
 * read green on its head: one from red checks alone (#462), or a Reviewer's
 * on a red head with no untagged finding (#779), which counted only for its
 * checks. A Reviewer's whose tags don't read counts as one with an untagged
 * finding, so it stands.
 */
export function countsBackOnGreen(record: VerdictRecord): boolean {
  if (record.source === "ci") return true;
  return record.verdict === "execution-flaw" && (record.checks?.length ?? 0) > 0 && record.tags?.counted === 0;
}

/**
 * The Execution flaws on this PR the tick's sweep reads the checks of (#779):
 * every one that names its red checks, whatever its source, not yet counted
 * back, nor reported by a Flaky check line naming all its checks on its head.
 * One with an untagged finding is marked so: its checks are reported, and it
 * still counts.
 */
export function uncountedFlaws(pullRequest: PullRequestSnapshot): SweptHead[] {
  const reported = (headSha: string, checks: readonly string[]) =>
    checks.every((name) => pullRequest.flakyCheckMarks.some((mark) => mark.headSha === headSha && mark.checks.includes(name)));
  return pullRequest.verdicts.flatMap((record) => {
    const checks = record.checks ?? [];
    if (record.verdict !== "execution-flaw" || record.flaky === true || checks.length === 0 || reported(record.headSha, checks)) return [];
    return [{ pullRequest: pullRequest.number, ticket: pullRequest.ticket, headSha: record.headSha, checks, kind: countsBackOnGreen(record) ? "counted-back" : "untagged-finding" }];
  });
}

/** Every head of this PR the tick's sweep reads (src/github/snapshot.ts): its uncounted flaws' (#462, #779), and its draft's Unrelated failures' (#781). */
export function sweptHeadsOf(pullRequest: PullRequestSnapshot): SweptHead[] {
  return [...uncountedFlaws(pullRequest), ...unrelatedOnDraft(pullRequest)];
}

/**
 * The head the Reviewer passed, when this is an open agent PR out of draft
 * whose head is still the one its latest pass was given on (#693); null
 * otherwise, as when its head moved after the pass (#692).
 */
export function passedHeadAtGate(pullRequest: PullRequestSnapshot): string | null {
  if (!pullRequest.isAgent || !pullRequest.open || pullRequest.draft) return null;
  const passed = pullRequest.verdicts.findLast((record) => record.verdict === "pass");
  return passed?.headSha === pullRequest.headSha ? passed.headSha : null;
}

/** A Flaky check the tick found, with the excerpt it read of that check's red run, when it read one (#778). */
function withRedExcerpt(check: FlakyCheck, excerpts: readonly FailureExcerpt[]): FlakyCheck {
  const excerpt = excerpts.find(({ check: name, link }) => name === check.name && link === check.red);
  return excerpt === undefined ? check : { ...check, excerpt };
}

/**
 * The checks that flipped on this flaw's head, each with a red run and its
 * latest, green, run; null unless every check the Verdict named reads green
 * now and has a red run on that head. Each goes by its latest run, so red,
 * green, red again is still red. Unrelated failures (#781), which counted
 * toward nothing, flip each on its own: those that read green now, null when
 * none does. The tick reads the excerpt of each red run this gives before its
 * plan (src/github/snapshot.ts).
 */
export function flippedOn({ checks, checkRuns, excerpts, kind }: FlawHeadChecks): FlakyCheck[] | null {
  const flipped = (name: string): FlakyCheck[] => {
    const runs = runsOf(checkRuns, name);
    const latest = runs.at(-1);
    const red = runs.find(isRed);
    return latest?.conclusion !== "success" || red === undefined ? [] : [withRedExcerpt({ name, red: red.url, green: latest.url }, excerpts)];
  };
  const flaky = checks.flatMap(flipped);
  // An Unrelated failure flips on its own; a flaw's checks flip together.
  const enough = kind === "unrelated" ? flaky.length > 0 : flaky.length === checks.length;
  return enough ? flaky : null;
}

/**
 * The Required checks with both a red run and a `success` run on this passed
 * head, in either order and whatever the latest says (#693), each with a link
 * to one of each; less any a Flaky check line on the PR already names on this
 * head. A check that was only skipped or neutral never succeeded.
 */
export function flakyOnPassedHead({ headSha, required, checkRuns, marks, excerpts }: PassedHeadChecks): FlakyCheck[] {
  const named = new Set(marks.filter((mark) => mark.headSha === headSha).flatMap((mark) => mark.checks));
  return required.flatMap((name) => {
    if (named.has(name)) return [];
    const runs = checkRuns.filter((run) => run.name === name);
    const green = runs.find((run) => run.conclusion === "success");
    const red = runs.find(isRed);
    return green === undefined || red === undefined ? [] : [withRedExcerpt({ name, red: red.url, green: green.url }, excerpts)];
  });
}

/**
 * What a later green on a swept head says: a flaw counted only for its
 * checks is counted back; a Reviewer's flaw with an untagged finding counts
 * for that (#779), so its checks are reported and the count stands; an
 * Unrelated failure counted toward nothing (#781), so it is reported, and
 * there's nothing to count back.
 */
function sweptActions(head: FlawHeadChecks, flaky: readonly FlakyCheck[], issues: readonly KitIssueSnapshot[], filed: Map<string, CreatedIssue>): Action[] {
  const line = (wording: (name: string, short: string) => string) => flakyLineActions(head.pullRequest, head.headSha, flaky, issues, filed, wording);
  switch (head.kind) {
    case "counted-back":
      return countedBackActions(head.pullRequest, head.ticket, head.headSha, flaky, issues, filed);
    case "untagged-finding":
      return line((name, short) => `${name} has since passed on ${short}, where it was red beside the Reviewer's own findings, so that Verdict still counts`);
    case "unrelated":
      return line((name, short) => `${name} has since passed on ${short}, where the Reviewer judged it an Unrelated failure`);
  }
}

/**
 * The tick's Flaky check sweep. Every Execution flaw on an open agent PR that
 * names red checks, whose checks all read green now on the head it was given
 * on, is counted back (#462), unless it is a Reviewer's with an untagged
 * finding: then its checks are reported as Flaky checks and it still counts
 * (#779). Each Unrelated failure the latest Verdict on an open draft named
 * that reads green now on its head is reported too, with nothing counted back
 * (#781). And each Required check that has both failed and
 * succeeded on the head the Reviewer passed, at the Merge gate, is reported, as
 * no Retry was spent there to count back (#693). A line marks each, so the
 * sweep never says one twice.
 */
export function flakyCheckGate(_now: string, snapshot: Snapshot): Plan {
  const { flakySweep, passedHeads } = snapshot;
  if (flakySweep === null && passedHeads === null) return { kind: "nothing", reason: "The snapshot holds no Flaky check sweep" };
  // A check flaking on two PRs in one tick files one issue, which both lines link.
  const filed = new Map<string, CreatedIssue>();
  // A check this tick counts back on a head isn't reported again on that head.
  const countedBack = new Set<string>();
  const key = (pullRequest: number, headSha: string, name: string) => `${pullRequest} ${headSha} ${name}`;
  const actions: Action[] = [];
  for (const head of flakySweep === null || flakySweep === "no-permission" ? [] : flakySweep) {
    const flaky = flippedOn(head);
    if (flaky === null) continue;
    actions.push(...sweptActions(head, flaky, snapshot.flakyCheckIssues, filed));
    for (const { name } of flaky) countedBack.add(key(head.pullRequest, head.headSha, name));
  }
  for (const head of passedHeads === null || typeof passedHeads === "string" ? [] : passedHeads) {
    const flaky = flakyOnPassedHead(head).filter(({ name }) => !countedBack.has(key(head.pullRequest, head.headSha, name)));
    actions.push(
      ...flakyLineActions(head.pullRequest, head.headSha, flaky, snapshot.flakyCheckIssues, filed, (name, short) => `${name} has both failed and succeeded on ${short}, the head the Reviewer passed`),
    );
  }
  if (actions.length > 0) return { kind: "act", actions };
  if (flakySweep === "no-permission" || passedHeads === "no-permission") {
    return { kind: "nothing", reason: "The Fabrik App can't read check runs without Checks: read, so no Flaky check is found on an agent PR's head" };
  }
  return { kind: "nothing", reason: "No Execution flaw on an open agent PR has had its checks pass since on the same head, and no Required check has both failed and succeeded on a head at the Merge gate" };
}
