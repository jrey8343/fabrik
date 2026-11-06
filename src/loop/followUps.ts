// The Follow-ups a pass names (GLOSSARY.md): work that deserves its own issue
// but lies outside the Ticket's scope. The Kit never files one. Each gets an
// Open as issue link to the Product repo's new-issue form, prefilled, so the
// Operator can open it and it goes through Intake and Triage as normal. An
// Audit's candidates get the same link (src/loop/auditLanding.ts), and so do
// a Retro's proposals, each on the form its target files it through
// (src/loop/retroLanding.ts). Pure.
import { fromPullRequestLine } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import type { FollowUp } from "./verdict.ts";

/** Kept under the URL length GitHub serves a prefilled new-issue form at. */
export const MAX_ISSUE_URL_LENGTH = 8000;

/** GitHub's longest issue title. */
const MAX_TITLE_LENGTH = 256;

/** The heading a pass's Verdict comment lists its Follow-ups under. */
const FOLLOW_UPS_HEADING = "### Follow-ups";

/** The line each Follow-up in a Verdict comment ends with. */
const OPEN_AS_ISSUE_LINK = /^\[Open as issue\]\(.*\)$/;

/**
 * The Follow-ups part of a pass's Verdict comment: each Follow-up's title,
 * body and Open as issue link, with @-mentions stripped. Nothing when there
 * are none. followUpsIn reads it back.
 */
export function followUpsSection(followUps: readonly FollowUp[], repoUrl: string, pullRequest: number): string[] {
  if (followUps.length === 0) return [];
  return [
    "",
    FOLLOW_UPS_HEADING,
    ...followUps.flatMap((followUp) => {
      const title = withoutMentions(followUp.title);
      const body = withoutMentions(followUp.body);
      return [
        "",
        `#### ${title}`,
        ...(body === "" ? [] : ["", body]),
        "",
        `[Open as issue](${newIssueUrl(repoUrl, title, body, fromPullRequestLine(pullRequest))})`,
      ];
    }),
  ];
}

/**
 * The Follow-ups a posted Verdict comment lists, as followUpsSection wrote
 * them, in order: each one's title and body. None when it lists none.
 */
export function followUpsIn(comment: string): FollowUp[] {
  const lines = comment.split("\n").map((line) => line.replace(/\r$/, ""));
  const followUps: FollowUp[] = [];
  let at = lines.lastIndexOf(FOLLOW_UPS_HEADING) + 1;
  if (at === 0) return followUps;
  for (;;) {
    while (lines[at] === "") at += 1;
    const title = /^#### (.*)$/.exec(lines[at] ?? "")?.[1];
    const link = lines.findIndex((line, i) => i > at && OPEN_AS_ISSUE_LINK.test(line));
    if (title === undefined || link === -1) return followUps;
    followUps.push({ title, body: lines.slice(at + 1, link).join("\n").replace(/^\n+|\n+$/g, "") });
    at = link + 1;
  }
}

/**
 * The new-issue form of the repo at `repoUrl`, prefilled: the title, the
 * body, then a blank line and `trailer`, which says where the issue came
 * from, and any `labels`. If the URL would be too long, the body is cut short
 * and the trailer is kept whole.
 */
export function newIssueUrl(repoUrl: string, title: string, body: string, trailer: string, labels: readonly string[] = []): string {
  const titled = Array.from(title).length <= MAX_TITLE_LENGTH ? title : cut(title, MAX_TITLE_LENGTH);
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
