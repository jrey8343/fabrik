// What a row carries beside an agent pull request (#619): the issues that
// could still be rolled in to it, its candidates; the open issues that only
// mention it; and the Follow-ups its pass named. Each is said by the Kit's own
// readers, never guessed: a candidate's `From PR` line by the reader of that
// line, a Follow-up by the reader of a Verdict's Follow-ups. Decided in #530
// and #574. Pure, no I/O: worked out from a gather's facts (./gather.ts).
import { fromPullRequestIn } from "../loop/markers.ts";
import type { Facts } from "./gather.ts";

/** An issue that could still be rolled in to an open agent pull request. */
interface Candidate {
  readonly issue: number;
  readonly title: string;
  /** The open agent pull request its `From PR` line names. */
  readonly pullRequest: number;
}

/**
 * Every candidate in the repo: each open issue the Operator opened whose body
 * has a whole line `From PR #n`, where `n` is an open agent pull request.
 */
function candidatesOf({ github, operator, issueBodies }: Facts): Candidate[] {
  return github.openIssues.flatMap(({ number, title, author }) => {
    if (author !== operator) return [];
    const body = issueBodies.find(({ issue }) => issue === number)?.body;
    const named = body === undefined ? null : fromPullRequestIn(body);
    const pullRequest = github.openPullRequests.find((open) => open.number === named);
    return pullRequest === undefined ? [] : [{ issue: number, title, pullRequest: pullRequest.number }];
  });
}

/** The issues that could still be rolled in to open agent pull request `pullRequest`, in the order of the open issues. */
export function relatedOf(facts: Facts, pullRequest: number): { readonly issue: number; readonly title: string; readonly kind: "candidate" }[] {
  return candidatesOf(facts)
    .filter((candidate) => candidate.pullRequest === pullRequest)
    .map(({ issue, title }) => ({ issue, title, kind: "candidate" }));
}

/** The open agent pull request issue `issue` could be rolled in to, or null. */
export function relatedToOf(facts: Facts, issue: number): number | null {
  return candidatesOf(facts).find((candidate) => candidate.issue === issue)?.pullRequest ?? null;
}
