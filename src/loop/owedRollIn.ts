// The owed rule (#663): from what GitHub holds of a pull request and the
// closed issues that name it, which Roll-ins are owed on it, and which were
// left unsent when it merged or closed. The Loop and the read library both
// call it, so they cannot disagree. Pure, and importing only the Kit's
// markers: the read library's entry reaches it, so no npm package, no file
// and no network.
import { rollInIn, rollInReopenedIn, type RollInText, sessionFinishedIn } from "./markers.ts";

/** A comment on an issue, as the owed rule reads it. */
export interface RollInComment {
  readonly body: string;
  /** Whether the Fabrik App wrote it: only its comments carry a mark that counts. */
  readonly byApp: boolean;
  /** When it was posted. */
  readonly at: string;
  /** Its address. */
  readonly url: string;
}

/** An issue GitHub cross-references to the pull request, with its comments. */
export interface RollInIssue {
  readonly number: number;
  readonly title: string;
  /** The repo it is in, `owner/name`. */
  readonly repo: string;
  /** How it was closed, as GitHub names the reason; null while it is open, or closed with no reason given. */
  readonly closedAs: "completed" | "not_planned" | "duplicate" | null;
  /** Its comments, oldest first. */
  readonly comments: readonly RollInComment[];
}

/** One of the Operator's Request changes on the pull request: the review's own text, never a comment pinned to a line. */
export interface RequestChangesText {
  readonly body: string;
  /** Whether it has been dismissed since: it no longer says what it asked. */
  readonly dismissed: boolean;
}

/** What the owed rule reads: a pull request and the issues GitHub cross-references to it. */
export interface RollInFacts {
  /** The repo the pull request is in, `owner/name`. */
  readonly repo: string;
  readonly pullRequest: {
    readonly number: number;
    readonly open: boolean;
    readonly isAgent: boolean;
    /** The Operator's Request changes on it, nobody else's. */
    readonly requestChanges: readonly RequestChangesText[];
  };
  readonly issues: readonly RollInIssue[];
}

/** A Roll-in a Design session settled onto a pull request, read from its issue's closing comment. */
export interface SettledRollIn {
  readonly issue: number;
  readonly title: string;
  /** The pull request it was settled onto. */
  readonly pullRequest: number;
  /** When it was settled: the closing comment's time. */
  readonly at: string;
  /** The closing comment. */
  readonly url: string;
  /** What to build, or null when the comment's hidden line holds none this release can read. */
  readonly text: RollInText | null;
}

/**
 * Each Roll-in owed on the pull request, lowest issue number first. An
 * issue's Roll-in is owed on pull request `n` while all of these hold:
 *
 * 1. The issue is closed as not planned, in the same repo as `n`.
 * 2. Of the Fabrik App's comments on it that end a Design session, the
 *    latest is a Roll-in's closing comment whose mark names `n`, and no
 *    reopening note of the Kit's follows it.
 * 3. `n` is an open agent pull request.
 * 4. No Request changes of the Operator's on `n`, not dismissed, names the
 *    issue (namesIssue).
 */
export function owedRollIns(facts: RollInFacts): SettledRollIn[] {
  return facts.pullRequest.open && facts.pullRequest.isAgent ? unsentRollIns(facts) : [];
}

/**
 * Each Roll-in left unsent on a pull request that has just merged or closed,
 * lowest issue number first: clauses 1, 2 and 4 of the owed rule
 * (owedRollIns), which is every clause but the one such a pull request can
 * no longer meet. Whether the pull request is an agent pull request, and
 * that it has closed, is its caller's to know.
 */
export function unsentRollIns({ repo, pullRequest, issues }: RollInFacts): SettledRollIn[] {
  const asked = pullRequest.requestChanges.filter(({ dismissed }) => !dismissed);
  return issues
    .flatMap((issue): SettledRollIn[] => {
      if (issue.closedAs !== "not_planned" || issue.repo !== repo) return [];
      const settled = standingRollInOf(issue.comments);
      if (settled === null || settled.pullRequest !== pullRequest.number) return [];
      if (asked.some(({ body }) => namesIssue(body, repo, issue.number))) return [];
      const { closing, text } = settled;
      return [{ issue: issue.number, title: issue.title, pullRequest: pullRequest.number, at: closing.at, url: closing.url, text }];
    })
    .sort((a, b) => a.issue - b.issue);
}

/**
 * Whether `text` names issue `issue` of `repo`, `owner/name`: by its number
 * after a `#`, or by its link. The one test for a Request changes naming an
 * issue: a candidate related issue (src/read/related.ts) and an owed Roll-in
 * are both told by it.
 */
export function namesIssue(text: string, repo: string, issue: number): boolean {
  const byNumber = new RegExp(`(?<![\\w/])#${issue}(?!\\d)`);
  const byLink = new RegExp(`https://github\\.com/${escaped(repo)}/issues/${issue}(?!\\d)`, "i");
  return byNumber.test(text) || byLink.test(text);
}

/** `text` with every character a regular expression gives a meaning to escaped. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The Roll-in that still stands on an issue with these comments, oldest
 * first: of the Fabrik App's comments that end a Design session, the latest,
 * when it is a Roll-in's closing comment and no reopening note of the Kit's
 * follows it. Null when the session last finished another way, the Kit has
 * reopened the issue for Triage since, or no session finished at all.
 */
function standingRollInOf(comments: readonly RollInComment[]): { closing: RollInComment; pullRequest: number; text: RollInText | null } | null {
  const last = comments.findLastIndex(({ byApp, body }) => byApp && sessionFinishedIn(body));
  const closing = comments[last];
  const rollIn = closing === undefined ? null : rollInIn(closing.body);
  if (closing === undefined || rollIn === null) return null;
  if (comments.slice(last + 1).some(({ byApp, body }) => byApp && rollInReopenedIn(body))) return null;
  return { closing, ...rollIn };
}
