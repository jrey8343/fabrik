// The Follow-ups a pass names (GLOSSARY.md): work that deserves its own issue
// but lies outside the Ticket's scope. The Kit never files one. Each gets an
// Open as issue link to the Product repo's new-issue form, prefilled, so the
// Operator can open it and it goes through Intake and Triage as normal. Pure.
import { withoutMentions } from "./mentions.ts";
import type { FollowUp } from "./verdict.ts";

/** Kept under the URL length GitHub serves a prefilled new-issue form at. */
export const MAX_ISSUE_URL_LENGTH = 8000;

/**
 * The Follow-ups part of a pass's Verdict comment: each Follow-up's title,
 * body and Open as issue link, with @-mentions stripped. Nothing when there
 * are none.
 */
export function followUpsSection(followUps: readonly FollowUp[], repoUrl: string, pullRequest: number): string[] {
  if (followUps.length === 0) return [];
  return [
    "",
    "### Follow-ups",
    ...followUps.flatMap((followUp) => {
      const title = withoutMentions(followUp.title);
      const body = withoutMentions(followUp.body);
      return [
        "",
        `#### ${title}`,
        ...(body === "" ? [] : ["", body]),
        "",
        `[Open as issue](${newIssueUrl(repoUrl, title, body, pullRequest)})`,
      ];
    }),
  ];
}

/**
 * The Product repo's new-issue form, prefilled. The body ends with the PR the
 * Follow-up came from, and is cut short if the URL would be too long.
 */
function newIssueUrl(repoUrl: string, title: string, body: string, pullRequest: number): string {
  const from = `From PR #${pullRequest}`;
  const url = (text: string) =>
    `${repoUrl}/issues/new?${new URLSearchParams({ title, body: text === "" ? from : `${text}\n\n${from}` })}`;
  if (url(body).length <= MAX_ISSUE_URL_LENGTH) return url(body);
  // The longest cut of the body, by code point, that fits with its ellipsis.
  const chars = Array.from(body);
  let [fits, tooLong] = [0, chars.length];
  while (tooLong - fits > 1) {
    const middle = Math.floor((fits + tooLong) / 2);
    if (url(`${chars.slice(0, middle).join("")}…`).length <= MAX_ISSUE_URL_LENGTH) fits = middle;
    else tooLong = middle;
  }
  return url(`${chars.slice(0, fits).join("").trimEnd()}…`);
}
