// A check's issue (#462, #781): one per Required check in the Product repo,
// found by its marker, labelled needs-triage and fabrik:flaky-check, holding
// the check's Flaky checks and its Unrelated failures alike. Each red run it
// reports carries that run's Failure excerpt (#778): the body the run that
// filed it, each later comment its own. The Kit files nothing else for a
// check: never a Ticket or a Design issue. Pure.
import { checkCode, type FailureExcerpt, renderFailureExcerpts } from "../review/failureExcerpt.ts";
import { FLAKY_CHECK_LABEL, NEEDS_TRIAGE } from "./labels.ts";
import { flakyCheckIssueMarker, flakyCheckIssueOf } from "./markers.ts";
import { GITHUB_COMMENT_LIMIT } from "./roundLine.ts";
import type { Action, CreatedIssue, KitIssueSnapshot } from "./types.ts";

/** Why a red run has no Failure excerpt: the Kit read none, as when the Review's artifact is missing. */
const NO_EXCERPT = "the Kit read no Failure excerpt of this run";

/**
 * One red run a check's issue reports: the check, its red run's link and
 * Failure excerpt, and what the issue says of it, as its body's opening when
 * it files the issue and as a comment on one already open. `kind` keys the
 * issue a plan files, so two kinds on one head file apart.
 */
export interface CheckReport {
  readonly kind: "flaky-check" | "unrelated-failure";
  readonly name: string;
  readonly red: string;
  /** That red run's Failure excerpt; absent when none was read, which the issue says. */
  readonly excerpt?: FailureExcerpt;
  readonly opening: string;
  readonly again: string;
}

/** A new check's issue's title (#781), which names both kinds it holds. One filed before #781 keeps its old one. */
export function checkIssueTitle(name: string): string {
  return `Flaky check or Unrelated failure: ${checkCode(name)}`;
}

/**
 * An issue's body or comment, `text`, then the Failure excerpt of the check's
 * red run (#778), rendered under the module's cap in the room GitHub's limit
 * leaves it. A run with none read says so, keeping the red run's link.
 */
function withExcerpt(text: string, { name, red, excerpt }: CheckReport): string {
  const given = excerpt ?? { kind: "unread", check: name, link: red, why: NO_EXCERPT };
  const heading = "Why the red run failed, its Failure excerpt:";
  const above = `${text}\n\n${heading}\n\n`;
  return `${above}${renderFailureExcerpts([given], { room: GITHUB_COMMENT_LIMIT - above.length }).join("\n\n")}`;
}

/** The open check's issue for `name`, by its marker, whatever its title. */
export function openCheckIssue(issues: readonly KitIssueSnapshot[], name: string): KitIssueSnapshot | undefined {
  return issues.find((issue) => flakyCheckIssueOf(issue.body) === name);
}

/**
 * Each red run's check's issue: the open one for its check when there is one,
 * by its marker, whatever its title, else one filed earlier in the same plan
 * (`filed`, by check), else one filed now, which goes into `filed`. `refs`
 * gives each report's issue, in order.
 */
export function checkIssueActions(
  headSha: string,
  reports: readonly CheckReport[],
  issues: readonly KitIssueSnapshot[],
  filed: Map<string, CreatedIssue> = new Map(),
): { actions: Action[]; refs: (number | CreatedIssue)[] } {
  const actions: Action[] = [];
  const refs: (number | CreatedIssue)[] = [];
  const short = headSha.slice(0, 7);
  for (const report of reports) {
    const { name } = report;
    const open = openCheckIssue(issues, name);
    if (open !== undefined) {
      actions.push({ kind: "comment", issue: open.number, body: withExcerpt(report.again, report) });
      refs.push(open.number);
      continue;
    }
    const earlier = filed.get(name);
    if (earlier !== undefined) {
      // Filed earlier in this plan for another PR or head: this red run goes on it as a comment, with its own excerpt.
      actions.push({ kind: "comment-on-created", on: earlier, body: withExcerpt(report.again, report) });
      refs.push(earlier);
      continue;
    }
    // By check, not by its place in the list: the count-back sweep and the Merge gate's read may each file one on the same head.
    const key = `${report.kind}-${short}-${name}`;
    actions.push({
      kind: "create-issue",
      key,
      title: checkIssueTitle(name),
      body: withExcerpt(
        [
          flakyCheckIssueMarker(name),
          report.opening,
          "",
          "The Kit comments here each time the check proves flaky again, or the Reviewer judges another of its red runs an Unrelated failure, while this is open.",
        ].join("\n"),
        report,
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

/** An issue in a comment-linking body: an existing one by its `#number`, a created one as the adapter writes it. */
export function issueRef(ref: number | CreatedIssue): string | CreatedIssue {
  return typeof ref === "number" ? `#${ref}` : ref;
}
