import { describe, expect, it } from "vitest";
import type { OpenIssueFacts, OpenPullRequestFacts, ReviewFacts } from "../kit/weeklySummary.ts";
import { aComment, aLabelAdded, aReview, anOpenIssue, anOpenPullRequest, aPlainPullRequest, aVerdictComment, factsOf, homeFactsOf } from "./builders.ts";
import type { CrossReferenceFacts, Facts, IssueBodyFacts } from "./gather.ts";
import { neverRelatedKindOf } from "./related.ts";
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

describe("never a candidate", () => {
  const filedWith = (overrides: Partial<OpenIssueFacts>, rest: Parameters<typeof repoWith>[0] = {}) =>
    repoWith({ issues: [{ ...FILED, ...overrides }], bodies: [{ issue: overrides.number ?? 30, body: FROM_PR_50 }], ...rest });

  it.each([
    ["an Audit", ["fabrik:audit"]],
    ["a Retro", ["fabrik:retro"]],
    ["a Monitor issue", ["fabrik:monitor"]],
    ["a Replay", ["fabrik:replay"]],
    ["a Kit-owned issue", ["fabrik:weekly-limit"]],
    ["a Flaky check issue", ["fabrik:flaky-check"]],
    ["a Map", ["wayfinder:map"]],
    ["a Decision", ["wayfinder:research"]],
  ])("%s, though the Operator filed it From PR #50", (_kind, labels) => {
    expect(pullRequestRow(filedWith({ labels }))?.related).toEqual([]);
  });

  it("a Spec, though the Operator filed it From PR #50", () => {
    expect(pullRequestRow(filedWith({ labels: ["ready-for-agent"], subIssues: [31, 32] }))?.related).toEqual([]);
  });

  it("the pull request's own Ticket", () => {
    const facts = homeFactsOf({ github: factsOf({ openIssues: [TICKET], openPullRequests: [PULL_REQUEST] }), issueBodies: [{ issue: 7, body: FROM_PR_50 }] });

    expect(pullRequestRow(facts)?.related).toEqual([]);
    expect(rowsIn(facts).every(({ relatedTo }) => relatedTo === null)).toBe(true);
  });

  it("an issue with an open agent pull request of its own", () => {
    const facts = filedWith({ labels: ["ready-for-agent"] }, { pullRequests: [anOpenPullRequest({ number: 51, ticket: 30 })] });

    expect(pullRequestRow(facts)?.related).toEqual([]);
    expect(rowsIn(facts).every(({ relatedTo }) => relatedTo === null)).toBe(true);
  });

  it("an issue a Plain pull request closes", () => {
    const facts = filedWith({});
    const withPlain = { ...facts, github: { ...facts.github, plainPullRequests: [aPlainPullRequest({ number: 70, author: "operator", headRef: "fix-prices", closes: [30] })] } };

    expect(pullRequestRow(withPlain)?.related).toEqual([]);
  });

  it("but a ready-for-agent Ticket waiting for Dispatch can be one", () => {
    const facts = filedWith({ labels: ["ready-for-agent"], labelEvents: [aLabelAdded("ready-for-agent", "2026-11-08T13:00:00Z")] });

    expect(pullRequestRow(facts)?.related).toEqual([{ issue: 30, title: "Cache the prices", kind: "candidate" }]);
    expect(rowsIn(facts).find(({ standing }) => standing.issue === 30)?.relatedTo).toBe(50);
  });
});

describe("a candidate stops being one", () => {
  /** Issue 30 filed From PR #50, with these reviews on pull request 50. */
  const reviewed = (...reviews: ReviewFacts[]): Facts =>
    homeFactsOf({ github: factsOf({ openIssues: [TICKET, FILED], openPullRequests: [{ ...PULL_REQUEST, reviews }] }), issueBodies: [{ issue: 30, body: FROM_PR_50 }] });
  const stillRelated = (facts: Facts) => {
    expect(pullRequestRow(facts)?.related).toEqual([{ issue: 30, title: "Cache the prices", kind: "candidate" }]);
    expect(issueRow(facts)?.relatedTo).toBe(50);
  };
  const noLonger = (facts: Facts) => {
    expect(pullRequestRow(facts)?.related).toEqual([]);
    expect(issueRow(facts)?.relatedTo).toBeNull();
  };

  it("once the Operator's Request changes on the pull request names it by its number", () => {
    noLonger(reviewed(aReview("2026-11-08T15:00:00Z", { body: "Roll #30 in to this one, please." })));
  });

  it("once the Operator's Request changes on the pull request names it by its link", () => {
    noLonger(reviewed(aReview("2026-11-08T15:00:00Z", { body: "Roll in https://github.com/owner/product/issues/30 as well." })));
  });

  it("but not for a Request changes that names another issue whose number starts the same, or one in another repo", () => {
    stillRelated(reviewed(aReview("2026-11-08T15:00:00Z", { body: "Roll in #301, https://github.com/owner/product/issues/302 and https://github.com/owner/other/issues/30." })));
  });

  it("but not for a dismissed one", () => {
    stillRelated(reviewed(aReview("2026-11-08T15:00:00Z", { state: "dismissed", body: "Roll #30 in to this one, please." })));
  });

  it("but not for one that names it only in a comment pinned to a line", () => {
    stillRelated(reviewed(aReview("2026-11-08T15:00:00Z", { body: "", comments: [{ path: "src/prices.ts", line: 12, body: "Roll #30 in here." }] })));
  });

  it("but not for someone else's, nor a review of the Operator's that only comments or approves", () => {
    stillRelated(
      reviewed(
        aReview("2026-11-08T15:00:00Z", { author: "someone", body: "Roll #30 in." }),
        aReview("2026-11-08T15:10:00Z", { state: "commented", body: "Maybe #30 too?" }),
        aReview("2026-11-08T15:20:00Z", { state: "approved", body: "Leave #30 for later." }),
      ),
    );
  });
});

describe("a mention", () => {
  /** A cross-reference to pull request 50 from issue `issue`. */
  const crossReference = (issue: number, title: string, overrides: Partial<CrossReferenceFacts> = {}): CrossReferenceFacts => ({
    pullRequest: 50,
    issue,
    title,
    open: true,
    repo: "owner/product",
    ...overrides,
  });

  it("is an open issue in the same repo that GitHub cross-references to the pull request, under mentions and not under related", () => {
    const facts = repoWith({ crossReferences: [crossReference(40, "The cart is slow")] });

    expect(pullRequestRow(facts)).toMatchObject({ mentions: [{ issue: 40, title: "The cart is slow" }], related: [] });
  });

  it("is once for an issue that cross-references the pull request twice", () => {
    const facts = repoWith({ crossReferences: [crossReference(40, "The cart is slow"), crossReference(40, "The cart is slow")] });

    expect(pullRequestRow(facts)?.mentions).toEqual([{ issue: 40, title: "The cart is slow" }]);
  });

  it("is never a candidate, which is under related alone", () => {
    const facts = repoWith({ issues: [FILED], bodies: [{ issue: 30, body: FROM_PR_50 }], crossReferences: [crossReference(30, "Cache the prices")] });

    expect(pullRequestRow(facts)).toMatchObject({ related: [{ issue: 30, title: "Cache the prices", kind: "candidate" }], mentions: [] });
  });

  it("is none from a closed issue, an issue in another repo, or a cross-reference to another pull request", () => {
    const facts = repoWith({
      crossReferences: [crossReference(41, "Closed one", { open: false }), crossReference(42, "Elsewhere", { repo: "owner/other" }), crossReference(43, "Another", { pullRequest: 51 })],
    });

    expect(pullRequestRow(facts)?.mentions).toEqual([]);
  });

  it("is none from the pull request's own Ticket, which the Kit's own comments cross-reference to it", () => {
    expect(pullRequestRow(repoWith({ crossReferences: [crossReference(7, "Build the thing")] }))?.mentions).toEqual([]);
  });

  it("is on the pull request's row alone", () => {
    const facts = repoWith({ crossReferences: [crossReference(40, "The cart is slow")] });

    expect(rowsIn(facts).filter(({ mentions }) => mentions.length > 0).map(({ standing }) => standing.pullRequest)).toEqual([50]);
  });
});

describe("the kind of issue never related to a pull request", () => {
  const issue = (labels: readonly string[], author = "operator", subIssues: readonly number[] = []) => ({ labels, author, subIssues });

  it.each([
    [["fabrik:audit"], "audit"],
    [["fabrik:retro"], "retro"],
    [["fabrik:monitor"], "monitor"],
    [["fabrik:replay"], "replay"],
    [["fabrik:weekly-limit"], "kit-owned"],
    [["fabrik:token-rotation"], "kit-owned"],
    [["fabrik:usage-credits"], "kit-owned"],
    [["fabrik:dead-tick"], "kit-owned"],
    [["fabrik:flaky-check"], "kit-owned"],
    [["wayfinder:map"], "map"],
    [["wayfinder:research"], "decision"],
    [["wayfinder:prototype"], "decision"],
    [["wayfinder:grilling"], "decision"],
    [["wayfinder:task"], "decision"],
  ])("is told by its label: %j is %s", (labels, kind) => {
    expect(neverRelatedKindOf(issue(labels), "fabrik-app[bot]")).toBe(kind);
  });

  it("is a Spec's for a ready-for-agent or ready-for-human issue with sub-issues, and a Map's for a Map with Decisions", () => {
    expect(neverRelatedKindOf(issue(["ready-for-agent"], "operator", [31]), "fabrik-app[bot]")).toBe("spec");
    expect(neverRelatedKindOf(issue(["ready-for-human"], "operator", [31]), "fabrik-app[bot]")).toBe("spec");
    expect(neverRelatedKindOf(issue(["wayfinder:map"], "operator", [31]), "fabrik-app[bot]")).toBe("map");
  });

  it("is Kit-owned for any issue the Fabrik App opened, or any bot when its login is not known", () => {
    expect(neverRelatedKindOf(issue([], "fabrik-app[bot]"), "fabrik-app[bot]")).toBe("kit-owned");
    expect(neverRelatedKindOf(issue([], "other-app[bot]"), "fabrik-app[bot]")).toBeNull();
    expect(neverRelatedKindOf(issue([], "other-app[bot]"), null)).toBe("kit-owned");
  });

  it("is none for a Ticket, waiting for Dispatch or not, a Triage issue, and a parent that is no Spec", () => {
    expect(neverRelatedKindOf(issue(["ready-for-agent"]), "fabrik-app[bot]")).toBeNull();
    expect(neverRelatedKindOf(issue(["ready-for-agent", "agent:implement"]), "fabrik-app[bot]")).toBeNull();
    expect(neverRelatedKindOf(issue(["needs-triage"]), "fabrik-app[bot]")).toBeNull();
    expect(neverRelatedKindOf(issue([], "operator", [31]), "fabrik-app[bot]")).toBeNull();
  });
});
