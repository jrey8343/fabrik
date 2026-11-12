import { describe, expect, it } from "vitest";
import type { OpenIssueFacts, OpenPullRequestFacts } from "../kit/weeklySummary.ts";
import { aComment, aLabelAdded, anOpenIssue, anOpenPullRequest, aPlainPullRequest, aVerdictComment, factsOf, homeFactsOf } from "./builders.ts";
import type { Facts, IssueBodyFacts } from "./gather.ts";
import { type Row, rowsOf } from "./rows.ts";

const NOW = "2026-11-08T20:00:00Z";
const HEAD = "h".repeat(40);

/** Ticket 7, `ready-for-agent`, with its open agent pull request 50 at the Merge gate. */
const TICKET = anOpenIssue({ number: 7, title: "Build the thing", author: "operator", labels: ["ready-for-agent"] });
const PULL_REQUEST = anOpenPullRequest({ number: 50, ticket: 7, draft: false, comments: [aVerdictComment("pass", HEAD, "2026-11-08T12:00:00Z")] });

/** Issue 30, the Operator's, waiting for Triage, filed from pull request 50's pass unless a test says otherwise. */
const FILED = anOpenIssue({
  number: 30,
  title: "Cache the prices",
  author: "operator",
  labels: ["needs-triage"],
  labelEvents: [aLabelAdded("needs-triage", "2026-11-08T13:00:00Z")],
});
const FROM_PR_50 = "The prices are read on every request.\n\nFrom PR #50";

/** A repo with Ticket 7 and its pull request, and these issues and pull requests besides, the Operator's with these bodies. */
function repoWith({
  issues = [],
  pullRequests = [],
  bodies = [],
  ...rest
}: { issues?: readonly OpenIssueFacts[]; pullRequests?: readonly OpenPullRequestFacts[]; bodies?: readonly IssueBodyFacts[] } & Partial<Omit<Facts, "kind" | "issueBodies">> = {}): Facts {
  return homeFactsOf({
    github: factsOf({ openIssues: [TICKET, ...issues], openPullRequests: [PULL_REQUEST, ...pullRequests] }),
    issueBodies: bodies,
    ...rest,
  });
}

const rowsIn = (facts: Facts): Row[] => rowsOf(facts, "unread", {}, NOW);
/** The row of pull request `number`. */
const pullRequestRow = (facts: Facts, number = 50): Row | undefined => rowsIn(facts).find(({ standing }) => standing.pullRequest === number);
/** The row of issue `number`, which has no pull request of its own. */
const issueRow = (facts: Facts, number = 30): Row | undefined => rowsIn(facts).find(({ standing }) => standing.issue === number && standing.pullRequest === null);

describe("a candidate", () => {
  it("is an open issue the Operator opened whose From PR line names an open agent pull request: under related on the pull request's row, and naming it in its own row's relatedTo", () => {
    const facts = repoWith({ issues: [FILED], bodies: [{ issue: 30, body: FROM_PR_50 }] });

    expect(pullRequestRow(facts)?.related).toEqual([{ issue: 30, title: "Cache the prices", kind: "candidate" }]);
    expect(issueRow(facts)?.relatedTo).toBe(50);
  });

  describe("relates nothing", () => {
    const unrelated = (facts: Facts) => {
      expect(pullRequestRow(facts)?.related).toEqual([]);
      expect(issueRow(facts)?.relatedTo).toBeNull();
    };

    it("with the line in an issue someone else opened", () => {
      unrelated(repoWith({ issues: [{ ...FILED, author: "someone" }], bodies: [{ issue: 30, body: FROM_PR_50 }] }));
    });

    it("with the line only in a comment", () => {
      unrelated(repoWith({ issues: [{ ...FILED, comments: [aComment("From PR #50", "2026-11-08T14:00:00Z", { author: "operator", byBot: false })] }], bodies: [{ issue: 30, body: "The prices are slow." }] }));
    });

    it("with the line quoted as code", () => {
      unrelated(repoWith({ issues: [FILED], bodies: [{ issue: 30, body: "Like this:\n\n```\nFrom PR #50\n```" }] }));
    });

    it("naming a Plain pull request", () => {
      const facts = repoWith({ issues: [FILED], bodies: [{ issue: 30, body: "From PR #70" }] });
      const withPlain = { ...facts, github: { ...facts.github, plainPullRequests: [aPlainPullRequest({ number: 70 })] } };

      unrelated(withPlain);
      expect(pullRequestRow(withPlain, 70)?.related).toEqual([]);
    });

    it("naming a pull request that merged or closed, which is no longer open", () => {
      unrelated(repoWith({ issues: [FILED], bodies: [{ issue: 30, body: "From PR #49" }] }));
    });
  });
});
