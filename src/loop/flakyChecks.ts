// Flaky checks (#462, GLOSSARY.md): a required check that reported both
// failure and success on the same head commit. The Kit finds one when its own
// re-run of the red checks passes (src/review/rerun.ts), or when the checks a
// ci-sourced Execution flaw named have since passed on its head, which the
// hourly tick reads; that Verdict then no longer counts toward the Ticket's
// Retries. Either way the Operator hears of it twice over, quietly: one line
// on the PR, mentioning nobody, and the check's own Flaky check issue for
// Triage, filed once and commented on at each later flake, so the Product's
// suite gets fixed. Pure.
import { NEEDS_TRIAGE, FLAKY_CHECK_LABEL } from "./labels.ts";
import { flakyCheckIssueMarker, flakyCheckIssueOf, flakyCheckMarker } from "./markers.ts";
import type { Action, CreatedIssue, FlakyCheck, KitIssueSnapshot } from "./types.ts";

/** A check's name as Markdown code: a backtick in it can't end the span. */
export function checkCode(name: string): string {
  return `\`${name.replace(/`/g, "'")}\``;
}

/** Each Flaky check's issue: the open one for its check when there is one, by its marker, else one filed now. */
function issueActions(
  pullRequest: number,
  headSha: string,
  flaky: readonly FlakyCheck[],
  issues: readonly KitIssueSnapshot[],
): { actions: Action[]; refs: (number | CreatedIssue)[] } {
  const actions: Action[] = [];
  const refs: (number | CreatedIssue)[] = [];
  const short = headSha.slice(0, 7);
  for (const [at, check] of flaky.entries()) {
    const runs = `#${pullRequest} at ${short}: [red](${check.red}), [green](${check.green})`;
    const open = issues.find((issue) => flakyCheckIssueOf(issue.body) === check.name);
    if (open !== undefined) {
      actions.push({ kind: "comment", issue: open.number, body: `Flaked again on ${runs}.` });
      refs.push(open.number);
      continue;
    }
    const key = `flaky-check-${at}`;
    actions.push({
      kind: "create-issue",
      key,
      title: `Flaky required check: ${check.name}`,
      body: [
        flakyCheckIssueMarker(check.name),
        `The required check ${checkCode(check.name)} reported both failure and success on the same head commit: a Flaky check. ` +
          "Every flake costs a Review a re-run, and one the Kit doesn't catch costs a Ticket a Retry, so it's worth fixing in the suite. " +
          "The Kit comments here each time it flakes again while this is open.",
        "",
        `- ${runs}`,
      ].join("\n"),
      labels: [NEEDS_TRIAGE, FLAKY_CHECK_LABEL],
      parent: null,
      blockedBy: [],
    });
    refs.push({ created: key });
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
  if (flaky.length === 0) return [];
  const { actions, refs } = issueActions(pullRequest, headSha, flaky, issues);
  const short = headSha.slice(0, 7);
  const body: (string | CreatedIssue)[] = [flakyCheckMarker({ headSha, checks: flaky.map(({ name }) => name) }), "\n"];
  flaky.forEach(({ name }, at) => {
    body.push(`${at === 0 ? "" : " "}${checkCode(name)} failed on ${short} and passed when the Kit re-ran it on the same head: a Flaky check (`);
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
): Action[] {
  const { actions, refs } = issueActions(pullRequest, headSha, flaky, issues);
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
