// Flaky checks (#462, GLOSSARY.md): a required check that reported both
// failure and success on the same head commit. The Kit finds one when its own
// re-run of the red checks passes (src/review/rerun.ts), or when the checks a
// ci-sourced Execution flaw named have since passed on its head, which the
// hourly tick reads; that Verdict then no longer counts toward the Ticket's
// Retries. The tick also reads the head the Reviewer passed at the Merge gate,
// where a Required check that has both failed and passed is reported, with
// nothing counted back (#693). Each way the Operator hears of it twice over, quietly: one line
// on the PR, mentioning nobody, and the check's own Flaky check issue for
// Triage, filed once and commented on each time the check proves flaky again, so the Product's
// suite gets fixed. Pure.
import { NEEDS_TRIAGE, FLAKY_CHECK_LABEL } from "./labels.ts";
import { flakyCheckIssueMarker, flakyCheckIssueOf, flakyCheckMarker } from "./markers.ts";
import type { Action, CreatedIssue, FlakyCheck, FlawHeadChecks, HeadCheckRun, KitIssueSnapshot, PassedHeadChecks, Plan, PullRequestSnapshot, Snapshot, VerdictRecord } from "./types.ts";

/** A check's name as Markdown code: a backtick in it can't end the span. */
export function checkCode(name: string): string {
  return `\`${name.replace(/`/g, "'")}\``;
}

/**
 * Each Flaky check's issue: the open one for its check when there is one, by
 * its marker, else one filed earlier in the same plan (`filed`, by check),
 * else one filed now, which goes into `filed`.
 */
function issueActions(
  pullRequest: number,
  headSha: string,
  flaky: readonly FlakyCheck[],
  issues: readonly KitIssueSnapshot[],
  filed: Map<string, CreatedIssue> = new Map(),
): { actions: Action[]; refs: (number | CreatedIssue)[] } {
  const actions: Action[] = [];
  const refs: (number | CreatedIssue)[] = [];
  const short = headSha.slice(0, 7);
  for (const [at, check] of flaky.entries()) {
    const runs = `#${pullRequest} at ${short}: [red](${check.red}), [green](${check.green})`;
    const open = issues.find((issue) => flakyCheckIssueOf(issue.body) === check.name);
    if (open !== undefined) {
      actions.push({ kind: "comment", issue: open.number, body: `Flaky again on ${runs}.` });
      refs.push(open.number);
      continue;
    }
    const earlier = filed.get(check.name);
    if (earlier !== undefined) {
      refs.push(earlier);
      continue;
    }
    const key = `flaky-check-${short}-${at}`;
    actions.push({
      kind: "create-issue",
      key,
      title: `Flaky required check: ${check.name}`,
      body: [
        flakyCheckIssueMarker(check.name),
        `The required check ${checkCode(check.name)} reported both failure and success on the same head commit: a Flaky check. ` +
          "Each time it fails costs a Review a re-run, and one the Kit doesn't catch costs a Ticket a Retry, so it's worth fixing in the suite. " +
          "The Kit comments here each time it proves flaky again while this is open.",
        "",
        `- ${runs}`,
      ].join("\n"),
      labels: [NEEDS_TRIAGE, FLAKY_CHECK_LABEL],
      parent: null,
      blockedBy: [],
    });
    refs.push({ created: key });
    filed.set(check.name, { created: key });
  }
  return { actions, refs };
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
 * its marker, which says of each check `said` and links its issue. Nothing
 * when none is flaky.
 */
function flakyLineActions(
  pullRequest: number,
  headSha: string,
  flaky: readonly FlakyCheck[],
  issues: readonly KitIssueSnapshot[],
  filed: Map<string, CreatedIssue>,
  said: (name: string, short: string) => string,
): Action[] {
  if (flaky.length === 0) return [];
  const { actions, refs } = issueActions(pullRequest, headSha, flaky, issues, filed);
  const short = headSha.slice(0, 7);
  const body: (string | CreatedIssue)[] = [flakyCheckMarker({ headSha, checks: flaky.map(({ name }) => name) }), "\n"];
  flaky.forEach(({ name }, at) => {
    body.push(`${at === 0 ? "" : " "}${said(checkCode(name), short)}: a Flaky check (`);
    body.push(issueRef(refs[at]!), ").");
  });
  return [...actions, { kind: "comment-linking", issue: pullRequest, body }];
}

/** An issue in a comment-linking body: an existing one by its `#number`, a created one as the adapter writes it. */
function issueRef(ref: number | CreatedIssue): string | CreatedIssue {
  return typeof ref === "number" ? `#${ref}` : ref;
}

/**
 * What the Kit does once the checks a ci-sourced Execution flaw named have
 * since passed on the head it was given on (#462): each one's issue, then one
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

/** The Verdicts on this PR the tick's sweep reads the checks of: ci-sourced Execution flaws naming their checks, not yet counted back. */
export function uncountedFlaws(pullRequest: PullRequestSnapshot): VerdictRecord[] {
  return pullRequest.verdicts.filter(
    (record) => record.verdict === "execution-flaw" && record.source === "ci" && record.flaky !== true && (record.checks?.length ?? 0) > 0,
  );
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

const RED = ["failure", "timed_out", "cancelled", "action_required", "startup_failure"];

/**
 * The checks that flipped on this flaw's head, each with a red run and its
 * latest, green, run; null unless every check the Verdict named reads green
 * now and has a red run on that head. Each goes by its latest run, so red,
 * green, red again is still red.
 */
function flippedOn({ checks, checkRuns }: FlawHeadChecks): FlakyCheck[] | null {
  const flaky: FlakyCheck[] = [];
  for (const name of checks) {
    // A run not yet started is the newest: GitHub queued it after every run that has.
    const started = (run: HeadCheckRun) => (run.startedAt === null ? Infinity : Date.parse(run.startedAt));
    const runs = checkRuns.filter((run) => run.name === name).toSorted((a, b) => started(a) - started(b));
    const latest = runs.at(-1);
    const red = runs.find((run) => run.conclusion !== null && RED.includes(run.conclusion));
    if (latest?.conclusion !== "success" || red === undefined) return null;
    flaky.push({ name, red: red.url, green: latest.url });
  }
  return flaky;
}

/**
 * The Required checks with both a red run and a `success` run on this passed
 * head, in either order and whatever the latest says (#693), each with a link
 * to one of each; less any a Flaky check line on the PR already names on this
 * head. A check that was only skipped or neutral never passed.
 */
function flakyOnPassedHead({ headSha, required, checkRuns, marks }: PassedHeadChecks): FlakyCheck[] {
  const named = new Set(marks.filter((mark) => mark.headSha === headSha).flatMap((mark) => mark.checks));
  return required.flatMap((name) => {
    if (named.has(name)) return [];
    const runs = checkRuns.filter((run) => run.name === name);
    const green = runs.find((run) => run.conclusion === "success");
    const red = runs.find((run) => run.conclusion !== null && RED.includes(run.conclusion));
    return green === undefined || red === undefined ? [] : [{ name, red: red.url, green: green.url }];
  });
}

/**
 * The tick's Flaky check sweep. Every ci-sourced Execution flaw on an open
 * agent PR whose checks all read green now on the head it was given on is
 * counted back (#462). And each Required check that has both failed and
 * passed on the head the Reviewer passed, at the Merge gate, is reported, as
 * no Retry was spent there to count back (#693). A line marks each, so the
 * sweep never says one twice.
 */
export function flakyCheckGate(_now: string, snapshot: Snapshot): Plan {
  const { flakySweep, passedHeads } = snapshot;
  if (flakySweep === null && passedHeads === null) return { kind: "nothing", reason: "The snapshot holds no Flaky check sweep" };
  // A check flaking on two PRs in one tick files one issue, which both lines link.
  const filed = new Map<string, CreatedIssue>();
  // A check this tick counts back on a head isn't reported again on that head.
  const said = new Set<string>();
  const key = (pullRequest: number, headSha: string, name: string) => `${pullRequest} ${headSha} ${name}`;
  const actions: Action[] = [];
  for (const head of flakySweep === null || flakySweep === "no-permission" ? [] : flakySweep) {
    const flaky = flippedOn(head);
    if (flaky === null) continue;
    actions.push(...countedBackActions(head.pullRequest, head.ticket, head.headSha, flaky, snapshot.flakyCheckIssues, filed));
    for (const { name } of flaky) said.add(key(head.pullRequest, head.headSha, name));
  }
  for (const head of passedHeads === null || typeof passedHeads === "string" ? [] : passedHeads) {
    const flaky = flakyOnPassedHead(head).filter(({ name }) => !said.has(key(head.pullRequest, head.headSha, name)));
    actions.push(
      ...flakyLineActions(head.pullRequest, head.headSha, flaky, snapshot.flakyCheckIssues, filed, (name, short) => `${name} has both failed and passed on ${short}, the head the Reviewer passed`),
    );
  }
  if (actions.length > 0) return { kind: "act", actions };
  if (flakySweep === "no-permission" || passedHeads === "no-permission") {
    return { kind: "nothing", reason: "The Fabrik App can't read check runs without Checks: read, so no Flaky check is found on an agent PR's head" };
  }
  return { kind: "nothing", reason: "No Execution flaw on an open agent PR has had its checks pass since on the same head, and no Required check has both failed and passed on a head at the Merge gate" };
}
