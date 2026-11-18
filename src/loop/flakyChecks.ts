// Flaky checks (#462, GLOSSARY.md): a required check that reported both
// failure and success on the same head commit. The Kit finds one when its own
// re-run of the red checks passes (src/review/rerun.ts), or when the checks an
// Execution flaw named have since passed on its head, which the hourly tick
// reads; that Verdict then no longer counts toward the Ticket's Retries, unless
// it is a Reviewer's with an untagged finding beside its checks (#779). The tick also reads the head the Reviewer passed at the Merge gate,
// where a Required check that has both failed and succeeded is reported, with
// nothing counted back (#693). Each way the Operator hears of it twice over, quietly: one line
// on the PR, mentioning nobody, and the check's own Flaky check issue for
// Triage, filed once and commented on each time the check proves flaky again, so the Product's
// suite gets fixed. Pure.
import { type FailureExcerpt, renderFailureExcerpts } from "../review/failureExcerpt.ts";
import { NEEDS_TRIAGE, FLAKY_CHECK_LABEL } from "./labels.ts";
import { flakyCheckIssueMarker, flakyCheckIssueOf, flakyCheckMarker, unrelatedFailureMarker } from "./markers.ts";
import { GITHUB_COMMENT_LIMIT } from "./roundLine.ts";
import type { Action, CreatedIssue, FlakyCheck, FlawHeadChecks, HeadCheckRun, KitIssueSnapshot, PassedHeadChecks, Plan, PullRequestSnapshot, Snapshot, VerdictRecord } from "./types.ts";

/** A check's name as Markdown code: a backtick in it can't end the span. */
export function checkCode(name: string): string {
  return `\`${name.replace(/`/g, "'")}\``;
}

/** Why a red run has no Failure excerpt: the Kit read none, as when the Review's artifact is missing. */
const NO_EXCERPT = "the Kit read no Failure excerpt of this run";

/**
 * An Unrelated failure (#781, GLOSSARY.md): a red check still red on its head
 * after the Kit's re-run, which the Reviewer judged the pull request didn't
 * cause. `red` links its red run, and `reason` is the Reviewer's one-line
 * reason, as a sentence that mentions nobody.
 */
export interface UnrelatedFailure {
  readonly name: string;
  readonly red: string;
  readonly reason: string;
  /** That red run's Failure excerpt, as the Review read it; absent when none was read, which the issue says. */
  readonly excerpt?: FailureExcerpt;
}

/** One red run a check's issue reports (#781): a Flaky check's, or an Unrelated failure's. */
type Reported = { readonly kind: "flaky"; readonly check: FlakyCheck } | { readonly kind: "unrelated"; readonly check: UnrelatedFailure };

/** A new check's issue's title (#781), which names both kinds it holds. One filed before #781 keeps its old one. */
export function checkIssueTitle(name: string): string {
  return `Flaky check or Unrelated failure: ${checkCode(name)}`;
}

/**
 * An issue's body or comment, `text`, then the Failure excerpt of the check's
 * red run (#778), rendered under the module's cap in the room GitHub's limit
 * leaves it. A run with none read says so, keeping the red run's link.
 */
function withExcerpt(text: string, { check }: Reported): string {
  const excerpt = check.excerpt ?? { kind: "unread", check: check.name, link: check.red, why: NO_EXCERPT };
  const heading = "Why the red run failed, its Failure excerpt:";
  const above = `${text}\n\n${heading}\n\n`;
  return `${above}${renderFailureExcerpts([excerpt], { room: GITHUB_COMMENT_LIMIT - above.length }).join("\n\n")}`;
}

/** What a check's issue says of one red run, as its body's opening and as a later comment, with the PR, head and run links. */
function reportOf(pullRequest: number, short: string, reported: Reported): { readonly opening: string; readonly again: string } {
  if (reported.kind === "flaky") {
    const { name, red, green } = reported.check;
    const runs = `#${pullRequest} at ${short}: [red](${red}), [green](${green})`;
    return {
      opening: [
        `The required check ${checkCode(name)} reported both failure and success on the same head commit: a Flaky check. ` +
          "Each time it fails costs a Review a re-run, and one the Kit doesn't catch costs a Ticket a Retry, so it's worth fixing in the suite.",
        "",
        `- ${runs}`,
      ].join("\n"),
      again: `Flaky again on ${runs}.`,
    };
  }
  const { name, red, reason } = reported.check;
  const runs = `#${pullRequest} at ${short}: [red](${red})`;
  const judged = `The Reviewer judged the pull request didn't cause it: ${reason}`;
  return {
    opening: [
      `The required check ${checkCode(name)} was still red after the Kit's re-run, and the Reviewer judged the pull request didn't cause it: an Unrelated failure. ` +
        "It costs the Ticket no Retry, but the Merge gate holds the pull request until the check is green, so it's worth fixing in the suite.",
      "",
      `- ${runs}`,
      `- ${judged}`,
    ].join("\n"),
    again: `Unrelated failure on ${runs}. ${judged}`,
  };
}

/**
 * Each red run's check's issue: the open one for its check when there is one,
 * by its marker, whatever its title, else one filed earlier in the same plan
 * (`filed`, by check), else one filed now, which goes into `filed`. The Kit
 * files nothing else for it: never a Ticket or a Design issue (#781).
 */
function issueActions(
  pullRequest: number,
  headSha: string,
  reports: readonly Reported[],
  issues: readonly KitIssueSnapshot[],
  filed: Map<string, CreatedIssue> = new Map(),
): { actions: Action[]; refs: (number | CreatedIssue)[] } {
  const actions: Action[] = [];
  const refs: (number | CreatedIssue)[] = [];
  const short = headSha.slice(0, 7);
  for (const reported of reports) {
    const { name } = reported.check;
    const { opening, again } = reportOf(pullRequest, short, reported);
    const open = issues.find((issue) => flakyCheckIssueOf(issue.body) === name);
    if (open !== undefined) {
      actions.push({ kind: "comment", issue: open.number, body: withExcerpt(again, reported) });
      refs.push(open.number);
      continue;
    }
    const earlier = filed.get(name);
    if (earlier !== undefined) {
      // Filed earlier in this plan for another PR or head: this red run goes on it as a comment, with its own excerpt.
      actions.push({ kind: "comment-on-created", on: earlier, body: withExcerpt(again, reported) });
      refs.push(earlier);
      continue;
    }
    // By check, not by its place in the list: the count-back sweep and the Merge gate's read may each file one on the same head.
    const key = `${reported.kind === "flaky" ? "flaky-check" : "unrelated-failure"}-${short}-${name}`;
    actions.push({
      kind: "create-issue",
      key,
      title: checkIssueTitle(name),
      body: withExcerpt(
        [
          flakyCheckIssueMarker(name),
          opening,
          "",
          "The Kit comments here each time the check proves flaky again, or the Reviewer judges another of its red runs an Unrelated failure, while this is open.",
        ].join("\n"),
        reported,
      ),
      labels: [NEEDS_TRIAGE, FLAKY_CHECK_LABEL],
      parent: null,
      blockedBy: [],
    });
    refs.push({ created: key });
    filed.set(name, { created: key });
  }
  return { actions, refs };
}

/**
 * What the Kit does about the red checks the Reviewer judged Unrelated
 * failures on this head (#781): each one's issue, then one line on the PR,
 * mentioning nobody, with its marker, saying each is still red and that the
 * Reviewer judged the PR didn't cause it, and linking its issue. The Verdict
 * that follows is the event's one notification, and links each issue too, by
 * `refs`. A check `saidBefore`, which an earlier Verdict on this head named an
 * Unrelated failure, as before a Touch-up that changed only the body (#751),
 * is said once: only its open issue is linked. Nothing when there is none.
 */
export function unrelatedFailureActions(
  pullRequest: number,
  headSha: string,
  unrelated: readonly UnrelatedFailure[],
  issues: readonly KitIssueSnapshot[],
  saidBefore: readonly string[] = [],
): { actions: Action[]; refs: ReadonlyMap<string, number | CreatedIssue> } {
  const fresh = unrelated.filter(({ name }) => !saidBefore.includes(name));
  const linked = new Map<string, number | CreatedIssue>(
    unrelated.flatMap(({ name }) => {
      const open = issues.find((issue) => flakyCheckIssueOf(issue.body) === name);
      return open === undefined ? [] : [[name, open.number] as const];
    }),
  );
  if (fresh.length === 0) return { actions: [], refs: linked };
  const { actions, refs } = issueActions(pullRequest, headSha, fresh.map((check) => ({ kind: "unrelated", check })), issues);
  const short = headSha.slice(0, 7);
  const body: (string | CreatedIssue)[] = [unrelatedFailureMarker({ headSha, checks: fresh.map(({ name }) => name) }), "\n"];
  fresh.forEach(({ name }, at) => {
    body.push(`${at === 0 ? "" : " "}${checkCode(name)} is still red on ${short}, and the Reviewer judged this pull request didn't cause it: an Unrelated failure (`);
    body.push(issueRef(refs[at]!), ").");
    linked.set(name, refs[at]!);
  });
  return { actions: [...actions, { kind: "comment-linking", issue: pullRequest, body }], refs: linked };
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
  const { actions, refs } = issueActions(pullRequest, headSha, flaky.map((check) => ({ kind: "flaky", check })), issues, filed);
  const short = headSha.slice(0, 7);
  const body: (string | CreatedIssue)[] = [flakyCheckMarker({ headSha, checks: flaky.map(({ name }) => name) }), "\n"];
  flaky.forEach(({ name }, at) => {
    body.push(`${at === 0 ? "" : " "}${wording(checkCode(name), short)}: a Flaky check (`);
    body.push(issueRef(refs[at]!), ").");
  });
  return [...actions, { kind: "comment-linking", issue: pullRequest, body }];
}

/** An issue in a comment-linking body: an existing one by its `#number`, a created one as the adapter writes it. */
function issueRef(ref: number | CreatedIssue): string | CreatedIssue {
  return typeof ref === "number" ? `#${ref}` : ref;
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
  const { actions, refs } = issueActions(pullRequest, headSha, flaky.map((check) => ({ kind: "flaky", check })), issues, filed);
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
export function uncountedFlaws(pullRequest: PullRequestSnapshot): Omit<FlawHeadChecks, "checkRuns" | "excerpts">[] {
  const reported = (headSha: string, checks: readonly string[]) =>
    checks.every((name) => pullRequest.flakyCheckMarks.some((mark) => mark.headSha === headSha && mark.checks.includes(name)));
  return pullRequest.verdicts.flatMap((record) => {
    const checks = record.checks ?? [];
    if (record.verdict !== "execution-flaw" || record.flaky === true || checks.length === 0 || reported(record.headSha, checks)) return [];
    const flaw = { pullRequest: pullRequest.number, ticket: pullRequest.ticket, headSha: record.headSha, checks };
    return [countsBackOnGreen(record) ? flaw : { ...flaw, untaggedFinding: true as const }];
  });
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

/** A Flaky check the tick found, with the excerpt it read of that check's red run, when it read one (#778). */
function withRedExcerpt(check: FlakyCheck, excerpts: readonly FailureExcerpt[]): FlakyCheck {
  const excerpt = excerpts.find(({ check: name, link }) => name === check.name && link === check.red);
  return excerpt === undefined ? check : { ...check, excerpt };
}

/**
 * The checks that flipped on this flaw's head, each with a red run and its
 * latest, green, run; null unless every check the Verdict named reads green
 * now and has a red run on that head. Each goes by its latest run, so red,
 * green, red again is still red. The tick reads the excerpt of each red run
 * this gives before its plan (src/github/snapshot.ts).
 */
export function flippedOn({ checks, checkRuns, excerpts }: FlawHeadChecks): FlakyCheck[] | null {
  const flaky: FlakyCheck[] = [];
  for (const name of checks) {
    // A run not yet started is the newest: GitHub queued it after every run that has.
    const started = (run: HeadCheckRun) => (run.startedAt === null ? Infinity : Date.parse(run.startedAt));
    const runs = checkRuns.filter((run) => run.name === name).toSorted((a, b) => started(a) - started(b));
    const latest = runs.at(-1);
    const red = runs.find((run) => run.conclusion !== null && RED.includes(run.conclusion));
    if (latest?.conclusion !== "success" || red === undefined) return null;
    flaky.push(withRedExcerpt({ name, red: red.url, green: latest.url }, excerpts));
  }
  return flaky;
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
    const red = runs.find((run) => run.conclusion !== null && RED.includes(run.conclusion));
    return green === undefined || red === undefined ? [] : [withRedExcerpt({ name, red: red.url, green: green.url }, excerpts)];
  });
}

/**
 * The tick's Flaky check sweep. Every Execution flaw on an open agent PR that
 * names red checks, whose checks all read green now on the head it was given
 * on, is counted back (#462), unless it is a Reviewer's with an untagged
 * finding: then its checks are reported as Flaky checks and it still counts
 * (#779). And each Required check that has both failed and
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
    // A Reviewer's flaw with an untagged finding counts for that (#779): its checks are reported, and the count stands.
    actions.push(
      ...(head.untaggedFinding === true
        ? flakyLineActions(head.pullRequest, head.headSha, flaky, snapshot.flakyCheckIssues, filed, (name, short) =>
            `${name} has since passed on ${short}, where it was red beside the Reviewer's own findings, so that Verdict still counts`,
          )
        : countedBackActions(head.pullRequest, head.ticket, head.headSha, flaky, snapshot.flakyCheckIssues, filed)),
    );
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
