import { describe, expect, it } from "vitest";
import { aPullRequest, kitConfig, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import type { CommentFacts, OpenIssueFacts, OpenPullRequestFacts, ReviewFacts } from "../kit/weeklySummary.ts";
import { followUpsSection } from "../loop/followUps.ts";
import { planFor } from "../loop/rules.ts";
import type { RollInsSnapshot } from "../loop/types.ts";
import { aComment, anOpenIssue, anOpenPullRequest, aPlainPullRequest, aReview, aRollInComment, aVerdictComment, factsOf, homeFactsOf } from "./builders.ts";
import type { ClosedIssueCommentsFacts, CrossReferenceFacts, Facts } from "./gather.ts";
import { owedRollInsOf } from "./owedRollIn.ts";
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

/** Issue 30's Roll-in as pull request 50's row reports it. */
const OWED = { issue: 30, title: "Cache the prices", kind: "owed", at: SETTLED_AT, url: CLOSING_COMMENT, text: TEXT } as const;

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
    expect(pullRequestRow(repoWith())?.related).toEqual([OWED]);
  });

  it("is reported wherever the pull request is on the Loop, a draft with no Verdict yet as at the Merge gate", () => {
    const facts = repoWith();
    const inDraft = { ...facts, github: { ...facts.github, openPullRequests: [{ ...PULL_REQUEST, draft: true, comments: [] }] } };

    expect(pullRequestRow(inDraft)?.related).toEqual([OWED]);
  });

  describe("with no text the library can read is still owed, its text null and its address leading to the comment", () => {
    /** The closing comment with its hidden line of data, its second line, replaced by these lines. */
    const withDataLine = (...lines: string[]): CommentFacts => {
      const [mark = "", , ...rest] = SETTLED.body.split("\n");
      return { ...SETTLED, body: [mark, ...lines, ...rest].join("\n") };
    };

    it.each([
      ["the hidden line is missing", withDataLine()],
      ["the hidden line does not parse", withDataLine('<!-- fabrik:roll-in-data {"v":1,"summary":"Read the prices once -->')],
      ["the hidden line carries a version the library does not know", withDataLine(`<!-- fabrik:roll-in-data ${JSON.stringify({ v: 2, what: TEXT.summary, checks: TEXT.acceptanceCriteria })} -->`)],
      ["the hidden line is no longer the comment's second line", withDataLine("", SETTLED.body.split("\n")[1] ?? "")],
    ])("when %s", (_when, comment) => {
      expect(comment.body).toContain("### What to build on #50");
      expect(pullRequestRow(repoWith({ comments: [comment] }))?.related).toEqual([{ ...OWED, text: null }]);
    });
  });

  it("is told from the Fabrik App's comment by its login, and from any bot's when the reader gave the gather none", () => {
    const anotherBots = { ...SETTLED, author: "helper[bot]" };

    expect(pullRequestRow(repoWith({ comments: [anotherBots] }))?.related).toEqual([]);
    expect(pullRequestRow(repoWith({ comments: [anotherBots], appLogin: null }))?.related).toEqual([OWED]);
  });

  it("is reported once for an issue GitHub cross-references to the pull request twice", () => {
    expect(pullRequestRow(repoWith({ crossReferences: [crossReference(), crossReference()] }))?.related).toEqual([OWED]);
  });

  it("is found whatever the case GitHub gives the repo's name in", () => {
    expect(pullRequestRow(repoWith({ reference: { repo: "Owner/Product" } }))?.related).toEqual([OWED]);
  });

  it("is listed after the pull request's candidates, lowest issue number first", () => {
    const candidate = anOpenIssue({ number: 31, title: "Round the totals", author: "operator", labels: ["needs-triage"] });
    const facts = repoWith({
      issues: [candidate],
      issueBodies: [{ issue: 31, body: "From PR #50" }],
      crossReferences: [crossReference({ issue: 33, title: "Sort the basket" }), crossReference()],
      closedIssueComments: [
        { issue: 33, comments: [aRollInComment(50, "2026-11-12T10:00:00Z", { issue: 33 })] },
        { issue: 30, comments: [SETTLED] },
      ],
    });

    expect(pullRequestRow(facts)?.related.map(({ issue, kind }) => [issue, kind])).toEqual([
      [31, "candidate"],
      [30, "owed"],
      [33, "owed"],
    ]);
  });
});

describe("nothing is owed", () => {
  const nothingOwed = (facts: Facts) => expect(pullRequestRow(facts)?.related).toEqual([]);

  it("once the Operator's Request changes on the pull request names the issue by its number", () => {
    nothingOwed(repoWith({ reviews: [aReview("2026-11-12T10:00:00Z", { body: "Roll in #30: read the prices once per page." })] }));
  });

  it("once the Operator's Request changes on the pull request names the issue by its link", () => {
    nothingOwed(repoWith({ reviews: [aReview("2026-11-12T10:00:00Z", { body: "Roll in https://github.com/owner/product/issues/30: read the prices once per page." })] }));
  });

  it("on an issue that is open again, though its thread still holds the closing comment", () => {
    nothingOwed(repoWith({ reference: { open: true, closedAs: null } }));
  });

  it.each([["completed"], ["duplicate"], [null]] as const)("on an issue closed as %s, not as not planned", (closedAs) => {
    nothingOwed(repoWith({ reference: { closedAs } }));
  });

  it("from a marked comment the Fabrik App did not write, such as the Operator quoting one", () => {
    nothingOwed(repoWith({ comments: [{ ...SETTLED, author: "operator", byBot: false }] }));
  });

  it("once a later Design session on the issue finished another way", () => {
    const notPlanned = aComment("**Design session finished.** The Operator decided against it, so the Kit closes this issue as not planned.", "2026-11-12T11:00:00Z");

    nothingOwed(repoWith({ comments: [SETTLED, notPlanned] }));
  });

  it("from an ordinary not-planned finish, a closing comment with no mark, as an earlier release wrote every one", () => {
    const unmarked = aComment(SETTLED.body.split("\n").slice(2).join("\n"), SETTLED_AT);

    expect(unmarked.body).toMatch(/^\*\*Design session finished\.\*\*/);
    nothingOwed(repoWith({ comments: [unmarked] }));
  });

  it("once the Kit has reopened the issue for Triage, though it was closed as not planned again since", () => {
    const reopened = aComment("<!-- fabrik:roll-in-reopened -->\n#50 merged before this Roll-in was sent, so the Kit reopened this issue for Triage.", "2026-11-12T11:00:00Z");

    nothingOwed(repoWith({ comments: [SETTLED, reopened] }));
  });

  it("on a Plain pull request, whatever a closing comment names", () => {
    const facts = repoWith({ comments: [aRollInComment(70, SETTLED_AT)], reference: { pullRequest: 70 } });
    const withPlain = { ...facts, github: { ...facts.github, plainPullRequests: [aPlainPullRequest({ number: 70, author: "operator", headRef: "fix-prices" })] } };

    expect(pullRequestRow(withPlain, 70)?.related).toEqual([]);
    nothingOwed(withPlain);
  });

  it("on a pull request other than the one the closing comment's mark names, though GitHub cross-references the issue to both", () => {
    const other = anOpenPullRequest({ number: 51, ticket: 8 });
    const facts = repoWith({ pullRequests: [other], crossReferences: [crossReference(), crossReference({ pullRequest: 51 })] });

    expect(pullRequestRow(facts, 51)?.related).toEqual([]);
    expect(pullRequestRow(facts)?.related).toEqual([OWED]);
  });

  it("from an issue in another repo", () => {
    nothingOwed(repoWith({ reference: { repo: "owner/other" } }));
  });

  it("with none of the issue's comments read", () => {
    nothingOwed(repoWith({ closedIssueComments: [] }));
  });
});

describe("a Roll-in is still owed", () => {
  const stillOwed = (facts: Facts) => expect(pullRequestRow(facts)?.related).toEqual([OWED]);

  it("after a Request changes that named the issue was dismissed", () => {
    stillOwed(repoWith({ reviews: [aReview("2026-11-12T10:00:00Z", { state: "dismissed", body: "Roll in #30: read the prices once per page." })] }));
  });

  it("after a Request changes that names it only in a comment pinned to a line, or names another issue whose number starts the same", () => {
    stillOwed(
      repoWith({
        reviews: [
          aReview("2026-11-12T10:00:00Z", { body: "", comments: [{ path: "src/prices.ts", line: 12, body: "Roll #30 in here." }] }),
          aReview("2026-11-12T10:10:00Z", { body: "Roll in #301 and https://github.com/owner/other/issues/30." }),
        ],
      }),
    );
  });

  it("after someone else's Request changes names it, or a review of the Operator's that only comments or approves", () => {
    stillOwed(
      repoWith({
        reviews: [
          aReview("2026-11-12T10:00:00Z", { author: "someone", body: "Roll #30 in." }),
          aReview("2026-11-12T10:10:00Z", { state: "commented", body: "Maybe #30 too?" }),
          aReview("2026-11-12T10:20:00Z", { state: "approved", body: "Leave #30 for later." }),
        ],
      }),
    );
  });
});

describe("an issue the Operator reopened", () => {
  it("that carries the From PR line is a candidate, not owed, and names the pull request in its own row's relatedTo", () => {
    const reopened = anOpenIssue({ number: 30, title: "Cache the prices", author: "operator", labels: ["needs-triage"], comments: [SETTLED] });
    const facts = repoWith({
      issues: [reopened],
      issueBodies: [{ issue: 30, body: "The prices are read on every request.\n\nFrom PR #50" }],
      reference: { open: true, closedAs: null },
    });

    expect(pullRequestRow(facts)?.related).toEqual([{ issue: 30, title: "Cache the prices", kind: "candidate" }]);
    expect(rowsIn(facts).find(({ standing }) => standing.issue === 30 && standing.pullRequest === null)?.relatedTo).toBe(50);
  });
});

describe("every owed Roll-in of a repo, from its rows", () => {
  /** A repo with a candidate and a mention on pull request 50, one Roll-in owed on it and two on pull request 51, one with no readable text. */
  const facts = repoWith({
    issues: [anOpenIssue({ number: 31, title: "Round the totals", author: "operator", labels: ["needs-triage"] })],
    issueBodies: [{ issue: 31, body: "From PR #50" }],
    pullRequests: [anOpenPullRequest({ number: 51, ticket: 8 })],
    crossReferences: [
      crossReference(),
      crossReference({ issue: 40, title: "The cart is slow", open: true, closedAs: null }),
      crossReference({ pullRequest: 51, issue: 34, title: "Sort the basket" }),
      crossReference({ pullRequest: 51, issue: 33, title: "Show the saving" }),
    ],
    closedIssueComments: [
      { issue: 30, comments: [SETTLED] },
      { issue: 33, comments: [aRollInComment(51, "2026-11-12T10:00:00Z", { issue: 33, text: TEXT })] },
      { issue: 34, comments: [aComment("<!-- fabrik:roll-in 51 -->\n**Design session finished.**", "2026-11-12T11:00:00Z", { url: "https://github.com/owner/product/issues/34#issuecomment-1" })] },
    ],
  });

  it("is each with its issue and its pull request, so a reader holding either number finds the other, and nothing else", () => {
    expect(pullRequestRow(facts)).toMatchObject({ related: [{ issue: 31, kind: "candidate" }, OWED], mentions: [{ issue: 40 }] });
    expect(owedRollInsOf(rowsIn(facts))).toEqual([
      { issue: 30, pullRequest: 50, title: "Cache the prices", at: SETTLED_AT, url: CLOSING_COMMENT, text: TEXT },
      { issue: 33, pullRequest: 51, title: "Show the saving", at: "2026-11-12T10:00:00Z", url: "https://github.com/owner/product/issues/33#issuecomment-1", text: TEXT },
      { issue: 34, pullRequest: 51, title: "Sort the basket", at: "2026-11-12T11:00:00Z", url: "https://github.com/owner/product/issues/34#issuecomment-1", text: null },
    ]);
  });

  it("is none in a repo where no Roll-in is owed, and none from no rows", () => {
    expect(owedRollInsOf(rowsIn(repoWith({ reviews: [aReview("2026-11-12T10:00:00Z", { body: "Roll in #30." })] })))).toEqual([]);
    expect(owedRollInsOf([])).toEqual([]);
  });

  it("survives a JSON round trip, as the rows it is read from do", () => {
    const rows = rowsIn(facts);
    const owed = owedRollInsOf(rows);

    expect(JSON.parse(JSON.stringify(rows))).toStrictEqual(rows);
    expect(JSON.parse(JSON.stringify(owed))).toStrictEqual(owed);
    expect(owedRollInsOf(JSON.parse(JSON.stringify(rows)) as Row[])).toEqual(owed);
  });
});

describe("the library's owed and the Loop's unsent", () => {
  /** An issue GitHub cross-references to pull request 50, with what tells whether its Roll-in stands. */
  interface Held {
    readonly number: number;
    readonly closedAs: CrossReferenceFacts["closedAs"];
    readonly comments: readonly CommentFacts[];
  }
  const settled = (number: number, onto = 50): CommentFacts => aRollInComment(onto, SETTLED_AT, { issue: number });
  const finishedAnotherWay = aComment("**Design session finished.** The Kit rewrote this issue as an agent brief.", "2026-11-12T11:00:00Z");
  const reopeningNote = aComment("<!-- fabrik:roll-in-reopened -->\n#49 merged before this Roll-in was sent, so the Kit reopened this issue for Triage.", "2026-11-12T11:00:00Z");
  const unreadable = { ...settled(37), body: settled(37).body.split("\n").toSpliced(1, 1).join("\n") };

  /** One of each: three whose Roll-in stands on pull request 50, and one for each way it does not. */
  const HELD: readonly Held[] = [
    { number: 30, closedAs: "not_planned", comments: [settled(30)] },
    { number: 31, closedAs: "not_planned", comments: [settled(31)] },
    { number: 32, closedAs: "completed", comments: [settled(32)] },
    { number: 33, closedAs: "not_planned", comments: [{ ...settled(33), author: "operator", byBot: false }] },
    { number: 34, closedAs: "not_planned", comments: [settled(34), finishedAnotherWay] },
    { number: 35, closedAs: "not_planned", comments: [settled(35, 49)] },
    { number: 36, closedAs: "not_planned", comments: [settled(36), reopeningNote] },
    { number: 37, closedAs: "not_planned", comments: [unreadable] },
    { number: 38, closedAs: "not_planned", comments: [settled(38)] },
    { number: 39, closedAs: null, comments: [settled(39)] },
  ];
  const REVIEWS: readonly ReviewFacts[] = [
    aReview("2026-11-12T12:00:00Z", { id: 901, body: "Roll in #31: read the prices once per page." }),
    aReview("2026-11-12T12:10:00Z", { id: 902, state: "dismissed", body: "Roll in #38." }),
    aReview("2026-11-12T12:20:00Z", { id: 903, author: "someone", body: "Roll in #30 and #37 too." }),
  ];

  /** The issues the library reports as owed on pull request 50, from a gather's facts of the repo. */
  function owedByTheLibrary(): number[] {
    const facts = repoWith({
      reviews: REVIEWS,
      crossReferences: HELD.map(({ number, closedAs }) => crossReference({ issue: number, title: `Issue ${number}`, open: closedAs === null, closedAs })),
      closedIssueComments: HELD.map(({ number, comments }) => ({ issue: number, comments })),
    });
    return owedRollInsOf(rowsIn(facts)).flatMap(({ issue, pullRequest }) => (pullRequest === 50 ? [issue] : []));
  }

  /** The issues the Loop reopens when pull request 50 closes, from its snapshot of the same repo. */
  function reopenedByTheLoop(merged: boolean): number[] {
    const rollIns: RollInsSnapshot = {
      repo: "owner/product",
      requestChanges: REVIEWS.filter(({ author, state }) => author === "operator" && (state === "changes-requested" || state === "dismissed")).map(({ body, state }) => ({ body, dismissed: state === "dismissed" })),
      issues: HELD.map(({ number, closedAs, comments }) => ({
        number,
        title: `Issue ${number}`,
        repo: "owner/product",
        closedAs,
        comments: comments.map(({ body, author, at, url }) => ({ body, byApp: author === "fabrik-app[bot]", at, url })),
      })),
    };
    const closed = aPullRequest({ number: 50, ticket: 7, open: false, draft: false, url: "https://github.com/owner/product/pull/50" });
    const plan = planFor({ kind: "pull-request-closed", pullRequest: 50, merged, closedByBot: false }, snapshotOfPullRequest(closed, { rollIns }), kitConfig());
    return plan.kind === "act" ? plan.actions.flatMap((action) => (action.kind === "reopen" ? [action.issue] : [])) : [];
  }

  it.each([
    ["merge", true],
    ["close unmerged", false],
  ])("are the same issues for the same facts: those the library reports as owed on a pull request are exactly those the Loop would reopen were it to %s now", (_how, merged) => {
    const owed = owedByTheLibrary();

    expect(owed).toEqual([30, 37, 38]);
    expect(reopenedByTheLoop(merged)).toEqual(owed);
  });
});

describe("an owed Roll-in beside what else a row carries", () => {
  it("is never under mentions, though GitHub cross-references its issue to the pull request", () => {
    expect(pullRequestRow(repoWith())).toMatchObject({ related: [OWED], mentions: [] });
  });

  it("names no pull request in any row's relatedTo: its issue is closed and has no row", () => {
    const rows = rowsIn(repoWith());

    expect(rows.every(({ relatedTo }) => relatedTo === null)).toBe(true);
    expect(rows.some(({ standing }) => standing.issue === 30)).toBe(false);
  });

  it("marks a Follow-up filed that has exactly its title, with its issue's number", () => {
    const followUps = [
      { title: "Cache the prices", body: "The prices are read on every request." },
      { title: "Tidy the cart", body: "" },
    ];
    const pass = aVerdictComment("pass", HEAD, "2026-11-12T08:00:00Z");
    const listing = { ...pass, body: [pass.body, ...followUpsSection(followUps, "https://github.com/owner/product", 50)].join("\n") };
    const facts = repoWith({ reference: { title: " Cache the prices " } });
    const withFollowUps = { ...facts, github: { ...facts.github, openPullRequests: [{ ...PULL_REQUEST, comments: [listing] }] } };

    expect(pullRequestRow(withFollowUps)?.followUps.map(({ title, filedAs }) => ({ title, filedAs }))).toEqual([
      { title: "Cache the prices", filedAs: 30 },
      { title: "Tidy the cart", filedAs: null },
    ]);
  });
});
