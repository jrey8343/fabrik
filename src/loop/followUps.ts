// The Follow-ups a pass names (GLOSSARY.md): work that deserves its own issue
// but lies outside the Ticket's scope. Each is a fault or an idea (#885,
// ADR-0039). A fault the Kit opens as an issue itself when the pull request
// merges (src/loop/followUpIssues.ts), so the Verdict comment says so beside
// it. An idea gets an Open as issue link to the Product repo's new-issue
// form, prefilled, so the Operator can open it and it goes through Intake
// and Triage as normal. An Audit's candidates get the same link
// (src/loop/auditLanding.ts), and so do a Retro's proposals, each on the form
// its target files it through (src/loop/retroLanding.ts). Pure.
import { verdictsIn } from "../github/threads.ts";
import { fromPullRequestLine } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import type { FollowUp, FollowUpKind } from "./verdict.ts";

/** Kept under the URL length GitHub serves a prefilled new-issue form at. */
export const MAX_ISSUE_URL_LENGTH = 8000;

/** GitHub's longest issue title. */
const MAX_TITLE_LENGTH = 256;

/** The heading a pass's Verdict comment lists its Follow-ups under. */
const FOLLOW_UPS_HEADING = "### Follow-ups";

/** The line an idea in a Verdict comment ends with, and the address it links. */
const OPEN_AS_ISSUE_LINK = /^\[Open as issue\]\((.*)\)$/;

/**
 * The line a fault in a Verdict comment ends with, in place of a link
 * (#885): it is how the comment says the Follow-up is a fault, and where the
 * merge reads that back.
 */
export const FAULT_OPENS_AT_MERGE = "The Kit opens this fault as an issue when the pull request merges.";

/** A Follow-up as a posted Verdict comment lists it: its kind, title and body, and an idea's Open as issue link as the comment has it, which a fault has none of. */
export interface ListedFollowUp extends FollowUp {
  readonly url: string | null;
}

/** A Follow-up as it is given to be listed: one given no kind is an idea, as one the Reviewer gave none is. */
export type NamedFollowUp = Omit<FollowUp, "kind"> & { readonly kind?: FollowUpKind };

/**
 * The Follow-ups part of a pass's Verdict comment: each Follow-up's title
 * and body, with @-mentions stripped, then a fault's line saying the Kit
 * opens it when the pull request merges, or an idea's Open as issue link.
 * The ideas come first, then the faults, each in the order named: a reader
 * pinned to a release before a Follow-up had a kind ends each item at its
 * link, so it reads every idea and stops at the first fault, where a fault
 * listed among the ideas would have taken the next idea's link for its own.
 * Nothing when there are none. followUpsIn reads it back.
 */
export function followUpsSection(followUps: readonly NamedFollowUp[], repoUrl: string, pullRequest: number): string[] {
  if (followUps.length === 0) return [];
  const isFault = ({ kind }: NamedFollowUp) => kind === "fault";
  return [
    "",
    FOLLOW_UPS_HEADING,
    ...[...followUps.filter((followUp) => !isFault(followUp)), ...followUps.filter(isFault)].flatMap((followUp) => {
      const title = withoutMentions(followUp.title);
      const body = withoutMentions(followUp.body);
      return [
        "",
        `#### ${title}`,
        ...(body === "" ? [] : ["", body]),
        "",
        followUp.kind === "fault" ? FAULT_OPENS_AT_MERGE : openAsIssueLink(repoUrl, title, body, pullRequest),
      ];
    }),
  ];
}

/** The Open as issue link of a Follow-up pull request #`pullRequest`'s pass named, whose issue ends with the `From PR` line. */
export function openAsIssueLink(repoUrl: string, title: string, body: string, pullRequest: number): string {
  return `[Open as issue](${newIssueUrl(repoUrl, title, body, fromPullRequestLine(pullRequest))})`;
}

/**
 * The Follow-ups a posted Verdict comment lists, as followUpsSection wrote
 * them, in order: each one's title and body. None when it lists none.
 */
export function followUpsIn(comment: string): FollowUp[] {
  return listedFollowUpsIn(comment).map(({ title, body, kind }) => ({ title, body, kind }));
}

/**
 * The Follow-ups a posted Verdict comment lists, as followUpsIn reads them,
 * each with the Open as issue link the comment gives it: the Digest lists a
 * pass's ideas with the links the Operator already has
 * (src/loop/digestFacts.ts). One the comment ends with its fault's line is a
 * fault, and has no link; every other is an idea, as every Follow-up of a
 * comment posted before they had kinds is.
 */
export function listedFollowUpsIn(comment: string): ListedFollowUp[] {
  const lines = comment.split("\n").map((line) => line.replace(/\r$/, ""));
  const followUps: ListedFollowUp[] = [];
  let at = lines.lastIndexOf(FOLLOW_UPS_HEADING) + 1;
  if (at === 0) return followUps;
  for (;;) {
    while (lines[at] === "") at += 1;
    const title = /^#### (.*)$/.exec(lines[at] ?? "")?.[1];
    const end = lines.findIndex((line, i) => i > at && (line === FAULT_OPENS_AT_MERGE || OPEN_AS_ISSUE_LINK.test(line)));
    if (title === undefined || end === -1) return followUps;
    const url = OPEN_AS_ISSUE_LINK.exec(lines[end] ?? "")?.[1] ?? null;
    followUps.push({ title, body: lines.slice(at + 1, end).join("\n").replace(/^\n+|\n+$/g, ""), kind: url === null ? "fault" : "idea", url });
    at = end + 1;
  }
}

/**
 * Every fault the passes among these comments named (#885), oldest pass
 * first, in the order each named them, a repeat among them: what the merge
 * opens as issues (src/loop/followUpIssues.ts). Read from a pass's Verdict
 * comment alone, so pass it only the Fabrik App's comments: nobody names a
 * fault by quoting one.
 */
export function faultsNamedIn(comments: readonly string[]): Pick<FollowUp, "title" | "body">[] {
  return comments
    .flatMap((comment) => (verdictsIn([comment])[0]?.verdict === "pass" ? followUpsIn(comment) : []))
    .flatMap(({ kind, title, body }) => (kind === "fault" ? [{ title, body }] : []));
}

/**
 * The title of the issue a Follow-up opens as, whoever opens it: its own, or
 * cut to the longest GitHub takes, as its Open as issue link prefills it.
 */
export function issueTitleOf(title: string): string {
  return Array.from(title).length <= MAX_TITLE_LENGTH ? title : cut(title, MAX_TITLE_LENGTH - 1);
}

/**
 * The new-issue form of the repo at `repoUrl`, prefilled: the title, the
 * body, then a blank line and `trailer`, which says where the issue came
 * from, and any `labels`. If the URL would be too long, the body is cut short
 * and the trailer is kept whole.
 */
export function newIssueUrl(repoUrl: string, title: string, body: string, trailer: string, labels: readonly string[] = []): string {
  const titled = issueTitleOf(title);
  const labelled: Record<string, string> = labels.length === 0 ? {} : { labels: labels.join(",") };
  const url = (text: string) =>
    `${repoUrl}/issues/new?${new URLSearchParams({ title: titled, body: text === "" ? trailer : `${text}\n\n${trailer}`, ...labelled })}`;
  if (url(body).length <= MAX_ISSUE_URL_LENGTH) return url(body);
  // The longest cut of the body, by code point, that fits.
  let [fits, tooLong] = [0, Array.from(body).length];
  while (tooLong - fits > 1) {
    const middle = Math.floor((fits + tooLong) / 2);
    if (url(cut(body, middle)).length <= MAX_ISSUE_URL_LENGTH) fits = middle;
    else tooLong = middle;
  }
  return url(cut(body, fits));
}

/** The first `length` code points of a text, with an ellipsis to show it was cut. */
function cut(text: string, length: number): string {
  return `${Array.from(text).slice(0, length).join("").trimEnd()}…`;
}
