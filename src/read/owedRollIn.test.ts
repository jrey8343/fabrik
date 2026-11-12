import { describe, expect, it } from "vitest";
import type { CommentFacts, OpenIssueFacts, OpenPullRequestFacts, ReviewFacts } from "../kit/weeklySummary.ts";
import { aComment, anOpenIssue, anOpenPullRequest, aRollInComment, aVerdictComment, factsOf, homeFactsOf } from "./builders.ts";
import type { ClosedIssueCommentsFacts, CrossReferenceFacts, Facts } from "./gather.ts";
import { type Row, rowsOf } from "./rows.ts";

const NOW = "2026-11-12T20:00:00Z";
const HEAD = "h".repeat(40);
const SETTLED_AT = "2026-11-12T09:00:00Z";
const CLOSING_COMMENT = "https://github.com/owner/product/issues/30#issuecomment-301";

/** Ticket 7, `ready-for-agent`, with its open agent pull request 50 at the Merge gate. */
const TICKET = anOpenIssue({ number: 7, title: "Build the thing", author: "operator", labels: ["ready-for-agent"] });
const PULL_REQUEST = anOpenPullRequest({ number: 50, ticket: 7, draft: false, comments: [aVerdictComment("pass", HEAD, "2026-11-12T08:00:00Z")] });

/** What the Design session on issue 30 settled with the Operator. */
const TEXT = {
  summary: "Read the prices once per page, in `src/prices.ts`, so a page with forty products asks for them once.",
  acceptanceCriteria: ["A page that shows forty products reads the prices once.", "A price changed between two pages shows on the second."],
};

/** The Fabrik App's closing comment on issue 30: its Design session settled a Roll-in onto pull request 50. */
const SETTLED = aRollInComment(50, SETTLED_AT, { issue: 30, text: TEXT }, { url: CLOSING_COMMENT });

/** GitHub's cross-reference to pull request 50 from issue 30, "Cache the prices", closed as not planned, unless a test says otherwise. */
const crossReference = (overrides: Partial<CrossReferenceFacts> = {}): CrossReferenceFacts => ({
  pullRequest: 50,
  issue: 30,
  title: "Cache the prices",
  open: false,
  closedAs: "not_planned",
  repo: "owner/product",
  ...overrides,
});

/**
 * A repo with Ticket 7 and its pull request 50, to which GitHub
 * cross-references issue 30, closed as not planned, with these comments.
 */
function repoWith({
  comments = [SETTLED],
  reference = {},
  reviews = [],
  issues = [],
  pullRequests = [],
  ...rest
}: {
  comments?: readonly CommentFacts[];
  reference?: Partial<CrossReferenceFacts>;
  reviews?: readonly ReviewFacts[];
  issues?: readonly OpenIssueFacts[];
  pullRequests?: readonly OpenPullRequestFacts[];
} & Partial<Omit<Facts, "kind">> = {}): Facts {
  const closedIssueComments: ClosedIssueCommentsFacts[] = [{ issue: 30, comments }];
  return homeFactsOf({
    github: factsOf({ openIssues: [TICKET, ...issues], openPullRequests: [{ ...PULL_REQUEST, reviews }, ...pullRequests] }),
    crossReferences: [crossReference(reference)],
    closedIssueComments,
    ...rest,
  });
}

const rowsIn = (facts: Facts): Row[] => rowsOf(facts, null, null, null, NOW);
/** The row of pull request `number`. */
const pullRequestRow = (facts: Facts, number = 50): Row | undefined => rowsIn(facts).find(({ standing }) => standing.pullRequest === number);

describe("an owed Roll-in", () => {
  it("is a closed issue whose latest session finish is a Roll-in's closing comment naming an open agent pull request: under related on that pull request's row, with its title, the comment's time and address, and the text as the session gave it", () => {
    expect(pullRequestRow(repoWith())?.related).toEqual([{ issue: 30, title: "Cache the prices", kind: "owed", at: SETTLED_AT, url: CLOSING_COMMENT, text: TEXT }]);
  });
});
