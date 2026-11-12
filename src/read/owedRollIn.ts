// Owed Roll-ins (#664): the Roll-ins a Design session settled with the
// Operator that the Operator has not sent yet, each on its open agent pull
// request. Which are owed is the Loop's own rule (src/loop/owedRollIn.ts),
// called with the gather's facts, so the Kit reopening an issue for Triage
// and the library ceasing to report it are one decision. The text is the
// hidden line Kit code wrote beside the closing comment, never its Markdown.
// Decided in #530 and #576. Pure, no I/O.
import type { CommentFacts } from "../kit/weeklySummary.ts";
import type { RollInText } from "../loop/markers.ts";
import { owedRollIns, type RollInIssue, type SettledRollIn } from "../loop/owedRollIn.ts";
import type { Facts } from "./gather.ts";
import type { Row } from "./rows.ts";

/** A Roll-in the Operator settled and has not sent, with the closed issue it is for and the open agent pull request it is owed on. */
export interface OwedRollIn {
  /** The issue, closed as not planned: it has no Standing and no row. */
  readonly issue: number;
  /** The open agent pull request the Roll-in was settled onto. */
  readonly pullRequest: number;
  /** The issue's title. */
  readonly title: string;
  /** When the Roll-in was settled: the closing comment's time. */
  readonly at: string;
  /** The closing comment. */
  readonly url: string;
  /** What to build, as the session gave it, or null when the comment's hidden line holds none this release can read. */
  readonly text: RollInText | null;
}

/**
 * Every owed Roll-in in a repo's rows (./rows.ts), lowest issue number
 * first, each with its issue and its pull request: the issue is closed, so
 * no row is its own and no row's `relatedTo` names it, and a reader holding
 * either number finds the other here. Nothing else under a row's `related`
 * is listed.
 */
export function owedRollInsOf(rows: readonly Row[]): OwedRollIn[] {
  return rows
    .flatMap(({ standing, related }) =>
      related.flatMap((entry): OwedRollIn[] => {
        if (entry.kind !== "owed" || standing.pullRequest === null) return [];
        const { issue, title, at, url, text } = entry;
        return [{ issue, pullRequest: standing.pullRequest, title, at, url, text }];
      }),
    )
    .sort((a, b) => a.issue - b.issue || a.pullRequest - b.pullRequest);
}

/**
 * Each Roll-in owed on pull request `pullRequest`, lowest issue number
 * first: none unless it is an open agent pull request. The issues looked at
 * are those GitHub cross-references to it, each with the comments the gather
 * read of it; the cross-reference only finds the issue, and the mark in the
 * Fabrik App's closing comment, any bot's when its login is not known, is
 * what makes a Roll-in owed.
 */
export function owedOn({ github, operator, appLogin, crossReferences, closedIssueComments }: Facts, pullRequest: number): SettledRollIn[] {
  // The gather keeps open agent pull requests here, and no other.
  const open = github.openPullRequests.find(({ number }) => number === pullRequest);
  const byApp = ({ author, byBot }: CommentFacts) => (appLogin === null ? byBot : author === appLogin);
  const issues = new Map<number, RollInIssue>();
  for (const reference of crossReferences) {
    if (reference.pullRequest !== pullRequest || issues.has(reference.issue)) continue;
    const comments = closedIssueComments.find(({ issue }) => issue === reference.issue)?.comments ?? [];
    issues.set(reference.issue, {
      number: reference.issue,
      title: reference.title,
      // GitHub tells repos apart whatever the case of their names.
      repo: reference.repo.toLowerCase() === github.repo.toLowerCase() ? github.repo : reference.repo,
      closedAs: reference.closedAs,
      comments: comments.map((comment) => ({ body: comment.body, byApp: byApp(comment), at: comment.at, url: comment.url })),
    });
  }
  return owedRollIns({
    repo: github.repo,
    pullRequest: {
      number: pullRequest,
      open: open !== undefined,
      isAgent: open !== undefined,
      // A dismissed review no longer says what it asked, and the rule reads none.
      requestChanges: (open?.reviews ?? []).filter(({ author, state }) => author === operator && state === "changes-requested").map(({ body }) => ({ body, dismissed: false })),
    },
    issues: [...issues.values()],
  });
}
