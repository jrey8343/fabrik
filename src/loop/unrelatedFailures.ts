// Unrelated failures (#781, GLOSSARY.md): a Required check still red on an
// agent PR's head after the Kit's re-run, which the Reviewer judged the pull
// request didn't cause. The Operator hears of one as of a Flaky check,
// quietly: one line on the PR ahead of the Verdict, mentioning nobody, and the
// check's issue (src/loop/checkIssue.ts), filed or commented on with the
// Reviewer's reason and the red run's Failure excerpt. One that later passes
// on its head is a Flaky check, which the tick's sweep reads off an open
// draft's latest Verdict here (src/loop/flakyChecks.ts). Pure.
import { checkCode, type FailureExcerpt } from "../review/failureExcerpt.ts";
import { type CheckReport, checkIssueActions, issueRef, openCheckIssue } from "./checkIssue.ts";
import { unrelatedFailureMarker } from "./markers.ts";
import type { Action, CreatedIssue, KitIssueSnapshot, PullRequestSnapshot, SweptHead } from "./types.ts";

/**
 * An Unrelated failure: `red` links its red run, and `reason` is the
 * Reviewer's one-line reason, as a sentence that mentions nobody.
 */
export interface UnrelatedFailure {
  readonly name: string;
  readonly red: string;
  readonly reason: string;
  /** That red run's Failure excerpt, as the Review read it; absent when none was read, which the issue says. */
  readonly excerpt?: FailureExcerpt;
}

/** What the check's issue says of an Unrelated failure, with the PR, head and red run's links and the Reviewer's reason. */
function reportOf(pullRequest: number, short: string, { name, red, reason, excerpt }: UnrelatedFailure): CheckReport {
  const runs = `#${pullRequest} at ${short}: [red](${red})`;
  const judged = `The Reviewer judged the pull request didn't cause it: ${reason}`;
  return {
    kind: "unrelated-failure",
    name,
    red,
    ...(excerpt === undefined ? {} : { excerpt }),
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
 * What the Kit does about the red checks the Reviewer judged Unrelated
 * failures on this head: each one's issue, then one line on the PR,
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
      const open = openCheckIssue(issues, name);
      return open === undefined ? [] : [[name, open.number] as const];
    }),
  );
  if (fresh.length === 0) return { actions: [], refs: linked };
  const short = headSha.slice(0, 7);
  const { actions, refs } = checkIssueActions(headSha, fresh.map((check) => reportOf(pullRequest, short, check)), issues);
  const body: (string | CreatedIssue)[] = [unrelatedFailureMarker({ headSha, checks: fresh.map(({ name }) => name) }), "\n"];
  fresh.forEach(({ name }, at) => {
    body.push(`${at === 0 ? "" : " "}${checkCode(name)} is still red on ${short}, and the Reviewer judged this pull request didn't cause it: an Unrelated failure (`);
    body.push(issueRef(refs[at]!), ").");
    linked.set(name, refs[at]!);
  });
  return { actions: [...actions, { kind: "comment-linking", issue: pullRequest, body }], refs: linked };
}

/**
 * The Unrelated failures the latest Verdict on this open agent draft named,
 * on the head it was given on, less any a Flaky check line already names
 * there, for the tick's sweep; none when there are none. A pass at the Merge
 * gate isn't read here: the read of its passed head finds a check that has
 * since succeeded.
 */
export function unrelatedOnDraft(pullRequest: PullRequestSnapshot): SweptHead[] {
  if (!pullRequest.isAgent || !pullRequest.open || !pullRequest.draft) return [];
  const latest = pullRequest.verdicts.at(-1);
  if (latest === undefined) return [];
  const named = new Set(pullRequest.flakyCheckMarks.filter((mark) => mark.headSha === latest.headSha).flatMap((mark) => mark.checks));
  const checks = (latest.unrelated ?? []).filter((name) => !named.has(name));
  return checks.length === 0 ? [] : [{ pullRequest: pullRequest.number, ticket: pullRequest.ticket, headSha: latest.headSha, checks, kind: "unrelated" }];
}
