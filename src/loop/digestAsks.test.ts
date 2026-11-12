import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aDigestFacts, aDigestGiven, aDigestReply, aRequestChanges } from "../__fixtures__/digests.ts";
import { aPullRequest, HEAD_SHA, kitConfig, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import {
  DIGEST_FOLDS_MARKER,
  type DigestAnswer,
  type DigestGiven,
  type DigestItem,
  type DigestReply,
  digestCommentOf,
  digestItemsOf,
  digestMarkIn,
  MAX_ITEMS,
  MAX_SUGGESTED_REQUEST_WORDS,
  MAX_TOP_WORDS,
  noDigestLine,
  readDigestReply,
} from "./digestContract.ts";
import { type DigestAsk, type DigestThread, digestFactsOf } from "./digestFacts.ts";
import { RETRY_PUSH_MARKER, verdictMarker } from "./markers.ts";
import { planFor } from "./rules.ts";

const sha = (letter: string) => letter.repeat(40);
/** A time on the thread's day, by its minute, so a fixture reads in order. */
const at = (minute: number) => `2026-11-02T10:${String(minute).padStart(2, "0")}:00Z`;

const aPass = (minute: number, headSha: string) => ({
  at: at(minute),
  body: `${verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha })}\n## Verdict: Pass`,
});

function aThread(overrides: Partial<DigestThread> = {}): DigestThread {
  return { openedAt: at(0), kitComments: [], requestChanges: [], landedNothing: 0, ...overrides };
}

const LINE = (comment: number, path: string, line: number | null = 12) => ({ comment, url: `https://github.com/acme/shop/pull/50#discussion_r${comment}`, path, line });

describe("The asks Kit code lists from a pull request's thread", () => {
  // Two Request changes of the Operator's, the second with two line comments.
  const TWO = [
    aRequestChanges(8, at(20), { body: "Call it a basket." }),
    aRequestChanges(11, at(30), { body: "Two places still say cart.", lineComments: [LINE(12, "src/cart.ts"), LINE(13, "src/checkout.ts", null)] }),
  ];

  it("are every Request changes of the Operator's and every line comment in each, oldest first, a review before its line comments", () => {
    expect(digestFactsOf(aThread({ requestChanges: TWO })).asks).toEqual([
      { id: "review-8", what: "request-changes", url: "https://github.com/acme/shop/pull/50#pullrequestreview-8" },
      { id: "review-11", what: "request-changes", url: "https://github.com/acme/shop/pull/50#pullrequestreview-11" },
      { id: "inline-12", what: "line-comment", url: "https://github.com/acme/shop/pull/50#discussion_r12", path: "src/cart.ts", line: 12 },
      { id: "inline-13", what: "line-comment", url: "https://github.com/acme/shop/pull/50#discussion_r13", path: "src/checkout.ts", line: null },
    ]);
  });

  it("have ids made from GitHub's own ids, so they are the same when the list is built again at a later head", () => {
    const first = digestFactsOf(aThread({ kitComments: [aPass(40, sha("a"))], requestChanges: TWO }));
    const later = digestFactsOf(
      aThread({
        kitComments: [aPass(40, sha("a")), { at: at(50), body: `${RETRY_PUSH_MARKER}\nThe Implementer pushed a fix.` }, aPass(55, sha("b"))],
        requestChanges: TWO,
      }),
    );

    expect(first.asks.map(({ id }) => id)).toEqual(["review-8", "review-11", "inline-12", "inline-13"]);
    expect(later.asks.map(({ id }) => id)).toEqual(first.asks.map(({ id }) => id));
  });

  it("leave out a dismissed Request changes and one deferred during a Retry, each with its line comments, as the Reviewer is given neither", () => {
    const requestChanges = [
      aRequestChanges(8, at(20), { body: "Call it a basket." }),
      aRequestChanges(9, at(22), { body: "Drop the banner.", dismissed: true, lineComments: [LINE(14, "src/banner.ts")] }),
      aRequestChanges(10, at(24), { body: "Add a coupon field.", deferred: true, lineComments: [LINE(15, "src/coupon.ts")] }),
    ];

    expect(digestFactsOf(aThread({ requestChanges })).asks.map(({ id }) => id)).toEqual(["review-8"]);
  });

  it("list a review whose own text is empty by its line comments alone", () => {
    const requestChanges = [
      aRequestChanges(8, at(20), { body: "  \n", lineComments: [LINE(12, "src/cart.ts")] }),
      aRequestChanges(9, at(22), { body: "" }),
    ];

    expect(digestFactsOf(aThread({ requestChanges })).asks.map(({ id }) => id)).toEqual(["inline-12"]);
  });

  it("are none on a pull request the Operator never requested changes on", () => {
    expect(digestFactsOf(aThread()).asks).toEqual([]);
  });
});

/** The writer's answer to an ask of Kit code's, by its id. */
function anAnswer(id: string, answer: DigestAnswer["answer"] = "in-head", rest: Partial<DigestAnswer> = {}): DigestAnswer {
  return { id, answer, where: "src/basket/save.ts", checkedBy: "reading", ...rest };
}

/** The writer's answer to a criterion of the Ticket's, which it adds under an id of its own. */
function aCriterion(number: number, answer: DigestAnswer["answer"] = "in-head", rest: Partial<DigestAnswer> = {}): DigestAnswer {
  return { id: `c${number}`, criterion: `Criterion ${number} of the Ticket.`, answer, where: "src/basket/save.test.ts", checkedBy: "test", ...rest };
}

/** An item under Needs your eyes. */
function anItem(kind: DigestItem["kind"], rest: Partial<DigestItem> = {}): DigestItem {
  return { kind, claim: "The banner still says cart.", sentence: "It reads cart at this head, which is yours to weigh.", asks: [], suggestedRequest: null, ...rest };
}

describe("The Digest writer's reply, with its answers and its items", () => {
  const REPLY = aDigestReply({
    asks: [anAnswer("review-8", "not-in-head", { checkedBy: "search" }), aCriterion(1), aCriterion(2, "could-not-tell", { checkedBy: "end-to-end-test" })],
    items: [
      anItem("asked-not-here", { asks: ["review-8", "c2"], suggestedRequest: "Say basket on the banner." }),
      anItem("yours-to-judge"),
      anItem("not-proven", { suggestedRequest: "Add a screenshot of the banner." }),
    ],
  });

  it("reads back as the writer gave it, with every ask's answer and every item", () => {
    expect(readDigestReply(JSON.parse(JSON.stringify(REPLY)))).toEqual({ ok: true, output: REPLY });
  });

  it("reads a reply with no item, for a pull request nothing in which needs the Operator's eyes", () => {
    expect(readDigestReply(aDigestReply({ items: [] }))).toMatchObject({ ok: true, output: { items: [] } });
  });

  it.each([
    ["asks is missing", { asks: undefined }, "asks must be a list of answers"],
    ["an ask is no object", { asks: ["review-8"] }, "asks[0] must be an object"],
    ["an ask has no id", { asks: [{ ...anAnswer("review-8"), id: " " }] }, "asks[0].id must be non-empty text"],
    ["an answer is unknown", { asks: [aCriterion(1), { ...anAnswer("review-8"), answer: "mostly" }] }, 'asks[1].answer must be one of in-head, not-in-head, could-not-tell, not "mostly"'],
    ["how it was checked is unknown", { asks: [{ ...anAnswer("review-8"), checkedBy: "a hunch" }] }, 'asks[0].checkedBy must be one of test, end-to-end-test, reading, search, required-checks, not "a hunch"'],
    ["where the writer looked is missing", { asks: [{ ...anAnswer("review-8"), where: undefined }] }, "asks[0].where must be non-empty text"],
    ["a criterion's own line is missing", { asks: [{ ...aCriterion(1), criterion: undefined }] }, "asks[0].criterion must be non-empty text, the criterion in one line"],
    ["an id is used twice", { asks: [aCriterion(1), anAnswer("review-8"), aCriterion(1), anAnswer("review-8")] }, "asks uses an id twice: `c1`, `review-8`"],
    ["items is missing", { items: undefined }, "items must be a list of at most 4 items"],
    ["there are more than four items", { items: [1, 2, 3, 4, 5].map(() => anItem("yours-to-judge")) }, "items must be a list of at most 4 items, not 5"],
    ["an item is no object", { items: [null] }, "items[0] must be an object"],
    ["a kind is unknown", { items: [{ ...anItem("not-proven"), kind: "worth-reading" }] }, 'items[0].kind must be one of asked-not-here, yours-to-judge, not-proven, not "worth-reading"'],
    ["an item has no claim", { items: [{ ...anItem("not-proven"), claim: "" }] }, "items[0].claim must be non-empty text"],
    ["an item has no sentence", { items: [{ ...anItem("not-proven"), sentence: 7 }] }, "items[0].sentence must be non-empty text"],
    ["an item's asks is no list of ids", { items: [{ ...anItem("not-proven"), asks: "review-8" }] }, "items[0].asks must be a list of ask ids"],
    ["a suggested request is neither text nor null", { items: [{ ...anItem("not-proven"), suggestedRequest: ["Add a screenshot."] }] }, "items[0].suggestedRequest must be text or null"],
    ["a suggested request is missing", { items: [{ ...anItem("not-proven"), suggestedRequest: undefined }] }, "items[0].suggestedRequest must be text or null"],
  ])("is refused when %s, naming it", (_what, broken, error) => {
    expect(readDigestReply({ ...REPLY, ...broken })).toEqual({ ok: false, errors: [error] });
  });

  it("keeps a criterion's own line on a criterion only: under an id that is not one of the writer's it is left out", () => {
    const read = readDigestReply({ ...REPLY, asks: [{ ...anAnswer("review-8"), criterion: "Say basket." }, aCriterion(1)] });

    expect(read).toMatchObject({ ok: true, output: { asks: [anAnswer("review-8"), aCriterion(1)] } });
    expect(read.ok && "criterion" in (read.output.asks[0] ?? {})).toBe(false);
  });

  it("reads a blank suggested request as none", () => {
    expect(readDigestReply({ ...REPLY, items: [{ ...anItem("not-proven"), suggestedRequest: "  " }] })).toMatchObject({ ok: true, output: { items: [{ suggestedRequest: null }] } });
  });
});

const REVIEW = (id: number) => `https://github.com/acme/shop/pull/50#pullrequestreview-${id}`;
const DISCUSSION = (id: number) => `https://github.com/acme/shop/pull/50#discussion_r${id}`;

/** Kit code's four asks: two Request changes of the Operator's, the second with two line comments. */
const FOUR_ASKS: readonly DigestAsk[] = [
  { id: "review-8", what: "request-changes", url: REVIEW(8) },
  { id: "review-11", what: "request-changes", url: REVIEW(11) },
  { id: "inline-12", what: "line-comment", url: DISCUSSION(12), path: "src/cart.ts", line: 12 },
  { id: "inline-13", what: "line-comment", url: DISCUSSION(13), path: "src/checkout.ts", line: null },
];

/** What the push job hands the contract for a pull request with those four asks. */
const GIVEN = aDigestGiven({ facts: aDigestFacts({ asks: FOUR_ASKS }) });

/** The writer's answer to each of the four, every one in the head. */
const FOUR_ANSWERS = FOUR_ASKS.map(({ id }) => anAnswer(id));

function bodyOf(reply: DigestReply, given: DigestGiven = GIVEN): string {
  const comment = digestCommentOf(reply, given);
  if (!comment.ok) throw new Error(`expected a Digest, got the refusal: ${comment.refused}`);
  return comment.body;
}

function refusalOf(reply: DigestReply, given: DigestGiven = GIVEN): string {
  const comment = digestCommentOf(reply, given);
  if (comment.ok) throw new Error("expected a refusal, got a Digest");
  return comment.refused;
}

/** What a Digest's fourth fold holds, between its title and its end. */
const criteriaFoldOf = (body: string) => body.split("<summary>The criteria and how each was checked</summary>\n\n")[1]?.split("\n\n</details>")[0] ?? "";

/** What a Digest says under Needs your eyes, up to its next heading. */
const needsYourEyesOf = (body: string) => body.split("### Needs your eyes\n\n")[1]?.split("\n\n### ")[0] ?? "";

describe("The criteria and how each was checked, a Digest's fourth fold", () => {
  it("is Kit code's table of every ask, the Operator's and then the criteria the writer added, each with its answer, how it was checked and where the writer looked", () => {
    const reply = aDigestReply({
      asks: [
        aCriterion(1),
        anAnswer("inline-13", "in-head", { where: "src/checkout.ts, the heading", checkedBy: "search" }),
        ...FOUR_ANSWERS.slice(0, 3),
        aCriterion(2, "in-head", { checkedBy: "end-to-end-test", where: "e2e/basket.spec.ts" }),
        aCriterion(3, "in-head", { checkedBy: "required-checks", where: "the `test` check" }),
      ],
    });

    expect(criteriaFoldOf(bodyOf(reply)).split("\n")).toEqual([
      "| Asked for | Answer | How it was checked | Where the writer looked |",
      "| --- | --- | --- | --- |",
      `| Your [Request changes](${REVIEW(8)}) | In the head | Reading | src/basket/save.ts |`,
      `| Your [Request changes](${REVIEW(11)}) | In the head | Reading | src/basket/save.ts |`,
      `| Your [line comment](${DISCUSSION(12)}) on \`src/cart.ts\`, line 12 | In the head | Reading | src/basket/save.ts |`,
      `| Your [line comment](${DISCUSSION(13)}) on \`src/checkout.ts\` | In the head | A search | src/checkout.ts, the heading |`,
      "| Criterion: Criterion 1 of the Ticket. | In the head | A test | src/basket/save.test.ts |",
      "| Criterion: Criterion 2 of the Ticket. | In the head | An end-to-end test | e2e/basket.spec.ts |",
      "| Criterion: Criterion 3 of the Ticket. | In the head | Required checks | the `test` check |",
    ]);
  });

  it("comes last of the four folds", () => {
    const [, folds] = bodyOf(aDigestReply({ asks: FOUR_ANSWERS })).split(`\n${DIGEST_FOLDS_MARKER}\n`);

    expect(folds?.match(/<summary>(.*)<\/summary>/g)).toEqual([
      "<summary>Walk me through it</summary>",
      "<summary>Decided without you, and left alone</summary>",
      "<summary>The rounds</summary>",
      "<summary>The criteria and how each was checked</summary>",
    ]);
  });

  it("marks an ask that is not in the head, and one that could not be told", () => {
    const reply = aDigestReply({
      asks: [anAnswer("review-8", "not-in-head"), ...FOUR_ANSWERS.slice(1), aCriterion(1, "could-not-tell")],
      items: [anItem("asked-not-here", { asks: ["review-8", "c1"] })],
    });

    const rows = criteriaFoldOf(bodyOf(reply)).split("\n");

    expect(rows[2]).toBe(`| Your [Request changes](${REVIEW(8)}) | **Not in the head** | Reading | src/basket/save.ts |`);
    expect(rows[6]).toBe("| Criterion: Criterion 1 of the Ticket. | **Could not tell** | A test | src/basket/save.test.ts |");
    expect(rows.filter((row) => row.includes("**"))).toHaveLength(2);
  });

  it("keeps the writer's words to their cells: one line each, with no mention and no cell of their own", () => {
    const reply = aDigestReply({
      asks: [...FOUR_ANSWERS, aCriterion(1, "in-head", { criterion: "A shopper can save\ntheir basket | says @octocat", where: "  src/a.ts |\n src/b.ts, by @acme/core " })],
    });

    const row = criteriaFoldOf(bodyOf(reply)).split("\n").at(-1) ?? "";

    expect(row).toBe("| Criterion: A shopper can save their basket \\| says @​octocat | In the head | A test | src/a.ts \\| src/b.ts, by @​acme/core |");
  });

  it("says so when there is no ask to list: the Operator requested nothing and the writer added no criterion", () => {
    expect(criteriaFoldOf(bodyOf(aDigestReply({ asks: [] }), aDigestGiven()))).toBe("No ask was listed: the Operator requested no changes, and the Digest writer named no criterion.");
  });
});

describe("A Digest whose answers do not match Kit code's asks", () => {
  it("lands when the reply answers every one of Kit code's asks and adds three criteria, with seven rows in the criteria fold", () => {
    const body = bodyOf(aDigestReply({ asks: [...FOUR_ANSWERS, aCriterion(1), aCriterion(2), aCriterion(3)] }));

    expect(criteriaFoldOf(body).split("\n").slice(2)).toHaveLength(7);
  });

  it("is refused when the reply leaves an ask of Kit code's unanswered, naming each one left", () => {
    expect(refusalOf(aDigestReply({ asks: [...FOUR_ANSWERS.slice(0, 3), aCriterion(1)] }))).toBe("the reply left an ask unanswered: `inline-13`");
    expect(refusalOf(aDigestReply({ asks: [anAnswer("review-8"), anAnswer("inline-12")] }))).toBe("the reply left asks unanswered: `review-11`, `inline-13`");
  });

  it("has the no-Digest line say that an ask was left unanswered, and the gate opens all the same", () => {
    const pullRequest = aPullRequest({ labels: ["agent:digest"], verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }] });
    const given = aDigestGiven({ ...GIVEN, headSha: HEAD_SHA });

    const plan = planFor(
      { kind: "digest-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: JSON.stringify(aDigestReply({ asks: FOUR_ANSWERS.slice(1) })), given, runUrl: given.runUrl },
      snapshotOfPullRequest(pullRequest),
      kitConfig(),
    );

    const actions = plan.kind === "act" ? plan.actions : [];
    expect(actions[0]).toEqual({
      kind: "comment",
      issue: 50,
      body: noDigestLine({ head: HEAD_SHA, how: "refused", reason: "the reply left an ask unanswered: `review-8`", runUrl: given.runUrl }),
    });
    expect(actions[0]).toMatchObject({ body: expect.stringContaining("`refused`, Kit code refused the Digest writer's reply (the reply left an ask unanswered: `review-8`).") });
    expect(actions.slice(1).map(({ kind }) => kind)).toEqual(["remove-label", "mark-ready-for-review", "request-review"]);
  });

  it("is refused when the reply answers under an id that is neither one of Kit code's nor a criterion's", () => {
    expect(refusalOf(aDigestReply({ asks: [...FOUR_ANSWERS, anAnswer("review-99"), aCriterion(1), anAnswer("the banner")] }))).toBe(
      "the reply answers under an id that is neither an ask Kit code listed nor a criterion's: `review-99`, `the banner`",
    );
  });

  it("is not refused over a criterion: Kit code holds no list of them, so the writer's are taken as given", () => {
    expect(digestCommentOf(aDigestReply({ asks: [...FOUR_ANSWERS, aCriterion(7)] }), GIVEN)).toMatchObject({ ok: true });
    expect(digestCommentOf(aDigestReply({ asks: FOUR_ANSWERS }), GIVEN)).toMatchObject({ ok: true });
  });
});

describe("A Digest whose items do not match its answers", () => {
  /** The first Request changes is not in the head; the other three asks are. */
  const ONE_MISSING = [anAnswer("review-8", "not-in-head"), ...FOUR_ANSWERS.slice(1)];

  it("is refused when an ask answered not in the head is named by no asked-for-and-not-here item", () => {
    const uncovered = "no asked-for-and-not-here item names an ask answered not in the head or could not tell: `review-8`";

    expect(refusalOf(aDigestReply({ asks: ONE_MISSING, items: [] }))).toBe(uncovered);
    expect(refusalOf(aDigestReply({ asks: ONE_MISSING, items: [anItem("yours-to-judge"), anItem("not-proven")] }))).toBe(uncovered);
  });

  it("lands when an asked-for-and-not-here item names that ask, and the item is first", () => {
    const body = bodyOf(
      aDigestReply({
        asks: ONE_MISSING,
        items: [anItem("yours-to-judge", { claim: "The price is new." }), anItem("asked-not-here", { claim: "The banner still says cart.", asks: ["review-8"] })],
      }),
    );

    expect(needsYourEyesOf(body).split("\n").map((line) => line.slice(0, line.indexOf("**", 4) + 2))).toEqual(["- **The banner still says cart.**", "- **The price is new.**"]);
  });

  it("is refused the same over an ask that could not be told, and over a criterion that is unmet", () => {
    const asks = [...FOUR_ANSWERS.slice(0, 3), anAnswer("inline-13", "could-not-tell"), aCriterion(1), aCriterion(2, "not-in-head")];

    expect(refusalOf(aDigestReply({ asks, items: [anItem("asked-not-here", { asks: ["c2"] })] }))).toBe(
      "no asked-for-and-not-here item names an ask answered not in the head or could not tell: `inline-13`",
    );
    expect(refusalOf(aDigestReply({ asks, items: [] }))).toBe("no asked-for-and-not-here item names asks answered not in the head or could not tell: `inline-13`, `c2`");
    expect(digestCommentOf(aDigestReply({ asks, items: [anItem("asked-not-here", { asks: ["c2", "inline-13"] })] }), GIVEN)).toMatchObject({ ok: true });
  });

  it("is refused when an asked-for-and-not-here item names an ask answered in the head", () => {
    const items = [anItem("asked-not-here", { asks: ["review-8", "review-11"] })];

    expect(refusalOf(aDigestReply({ asks: ONE_MISSING, items }))).toBe("item 1, asked for and not here, names an ask answered in the head: `review-11`");
  });

  it("is refused when a yours-to-judge item, or a not-proven one, names any ask", () => {
    const covering = anItem("asked-not-here", { asks: ["review-8"] });

    expect(refusalOf(aDigestReply({ asks: ONE_MISSING, items: [covering, anItem("yours-to-judge", { asks: ["review-8"] })] }))).toBe("item 2, yours to judge, names an ask: `review-8`");
    expect(refusalOf(aDigestReply({ asks: ONE_MISSING, items: [anItem("not-proven", { asks: ["review-11"] }), covering] }))).toBe("item 1, not proven, names an ask: `review-11`");
  });

  it("is refused when an asked-for-and-not-here item names no ask", () => {
    expect(refusalOf(aDigestReply({ asks: FOUR_ANSWERS, items: [anItem("not-proven"), anItem("asked-not-here")] }))).toBe("item 2, asked for and not here, names no ask");
  });

  it("is refused when an item names an ask the reply does not answer", () => {
    const items = [anItem("asked-not-here", { asks: ["review-8", "review-99"] })];

    expect(refusalOf(aDigestReply({ asks: ONE_MISSING, items }))).toBe("item 1, asked for and not here, names an ask the reply does not answer: `review-99`");
  });

  it("says every reason at once", () => {
    const reply = aDigestReply({ asks: ONE_MISSING.slice(0, 3), items: [anItem("yours-to-judge", { asks: ["review-11"] })], followUps: ["f9"] });

    expect(refusalOf(reply).split("; ")).toEqual([
      "the reply left an ask unanswered: `inline-13`",
      "no asked-for-and-not-here item names an ask answered not in the head or could not tell: `review-8`",
      "item 1, yours to judge, names an ask: `review-11`",
      "the reply names a Follow-up Kit code did not list: `f9`",
    ]);
  });
});

describe("Needs your eyes, a Digest's first section", () => {
  it("says \"Nothing.\" when the reply has no item, and comes first, before What it does", () => {
    const body = bodyOf(aDigestReply({ asks: FOUR_ANSWERS, items: [] }));

    expect(needsYourEyesOf(body)).toBe("Nothing.");
    expect(body.split("\n").slice(1, 6)).toEqual([expect.stringMatching(/^\*\*Digest\*\* of #50/), "", "### Needs your eyes", "", "Nothing."]);
    expect(body.indexOf("### Needs your eyes")).toBeLessThan(body.indexOf("### What it does"));
  });

  it("shows each item as its bold claim and its sentence, and never its suggested request", () => {
    const body = bodyOf(
      aDigestReply({
        asks: FOUR_ANSWERS,
        items: [
          anItem("yours-to-judge", { claim: "The empty basket's wording is new.", sentence: "It now reads \"Nothing saved yet\".\nOnly you can say whether a shopper should read that." }),
          anItem("not-proven", { claim: "No picture of the saved basket.", sentence: "The page changed and nothing shows it.", suggestedRequest: "Add a screenshot of the saved basket." }),
        ],
      }),
    );

    expect(needsYourEyesOf(body).split("\n")).toEqual([
      "- **The empty basket's wording is new.** It now reads \"Nothing saved yet\". Only you can say whether a shopper should read that.",
      "- **No picture of the saved basket.** The page changed and nothing shows it.",
    ]);
    expect(body).not.toContain("Add a screenshot of the saved basket.");
  });

  it("takes every mention out of an item", () => {
    const body = bodyOf(aDigestReply({ asks: FOUR_ANSWERS, items: [anItem("yours-to-judge", { claim: "Ask @octocat.", sentence: "@acme/core chose the price." })] }));

    expect(needsYourEyesOf(body)).toBe("- **Ask @​octocat.** @​acme/core chose the price.");
  });

  it("puts items given out of order in kind order, keeping the writer's order within a kind", () => {
    const reply = aDigestReply({
      asks: [anAnswer("review-8", "not-in-head"), anAnswer("review-11", "could-not-tell"), ...FOUR_ANSWERS.slice(2)],
      items: [
        anItem("not-proven", { claim: "First not proven." }),
        anItem("yours-to-judge", { claim: "Yours to judge." }),
        anItem("asked-not-here", { claim: "First asked for.", asks: ["review-11"] }),
        anItem("asked-not-here", { claim: "Second asked for.", asks: ["review-8"] }),
      ],
    });

    const inOrder = ["First asked for.", "Second asked for.", "Yours to judge.", "First not proven."];
    expect(digestItemsOf(reply).map(({ claim }) => claim)).toEqual(inOrder);
    expect(digestItemsOf(reply).map(({ kind }) => kind)).toEqual(["asked-not-here", "asked-not-here", "yours-to-judge", "not-proven"]);
    expect(needsYourEyesOf(bodyOf(reply)).split("\n")).toEqual(inOrder.map((claim) => `- **${claim}** It reads cart at this head, which is yours to weigh.`));
  });
});

describe("A suggested request", () => {
  const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");
  const ONE_MISSING = [anAnswer("review-8", "not-in-head"), ...FOUR_ANSWERS.slice(1)];

  it("is kept on an item that is asked for and not here and on one that is not proven, at up to 40 words", () => {
    const reply = aDigestReply({
      asks: ONE_MISSING,
      items: [anItem("asked-not-here", { asks: ["review-8"], suggestedRequest: "Say basket on the banner." }), anItem("not-proven", { suggestedRequest: words(40) })],
    });

    expect(digestItemsOf(reply).map(({ suggestedRequest }) => suggestedRequest)).toEqual(["Say basket on the banner.", words(40)]);
  });

  it("is dropped from an item that is yours to judge, and the item kept", () => {
    const reply = aDigestReply({ asks: FOUR_ANSWERS, items: [anItem("yours-to-judge", { claim: "The price is new.", suggestedRequest: "Lower the price." })] });

    expect(digestItemsOf(reply)).toEqual([anItem("yours-to-judge", { claim: "The price is new.", suggestedRequest: null })]);
    expect(needsYourEyesOf(bodyOf(reply))).toBe("- **The price is new.** It reads cart at this head, which is yours to weigh.");
  });

  it("is dropped at 41 words, and the item kept", () => {
    const reply = aDigestReply({ asks: FOUR_ANSWERS, items: [anItem("not-proven", { claim: "No picture.", suggestedRequest: words(41) })] });

    expect(digestItemsOf(reply)).toEqual([anItem("not-proven", { claim: "No picture.", suggestedRequest: null })]);
    expect(digestCommentOf(reply, GIVEN)).toMatchObject({ ok: true });
  });
});

describe("A Digest's hidden first line", () => {
  const HEAD = "a".repeat(40);

  it("carries the ids of Kit code's asks the Digest answered, after its head, and never a criterion's", () => {
    const body = bodyOf(aDigestReply({ asks: [aCriterion(1), ...FOUR_ANSWERS, aCriterion(2)] }));

    expect(body.split("\n")[0]).toBe(`<!-- fabrik:digest {"head":"${HEAD}","asks":["review-8","review-11","inline-12","inline-13"]} -->`);
    expect(digestMarkIn(body)).toEqual({ head: HEAD, asks: ["review-8", "review-11", "inline-12", "inline-13"] });
  });

  it("carries an empty list on a pull request the Operator never requested changes on", () => {
    const body = bodyOf(aDigestReply(), aDigestGiven());

    expect(body.split("\n")[0]).toBe(`<!-- fabrik:digest {"head":"${HEAD}","asks":[]} -->`);
    expect(digestMarkIn(body)).toEqual({ head: HEAD, asks: [] });
  });

  it("reads back as answering no ask when it records none, as a Digest from before the asks were listed does", () => {
    expect(digestMarkIn(`<!-- fabrik:digest {"head":"${HEAD}"} -->\n**Digest** of #50`)).toEqual({ head: HEAD, asks: [] });
    expect(digestMarkIn(`<!-- fabrik:digest {"head":"${HEAD}","asks":"review-8"} -->\n**Digest** of #50`)).toEqual({ head: HEAD, asks: [] });
  });
});

describe("The 180 words of a Digest's top", () => {
  const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");

  /** A reply whose Needs your eyes, What it does and How it got here run to this many words each: two items, each a claim of five words and a sentence of the rest. */
  function sized(needsYourEyes: number, whatItDoes: number, howItGotHere: number, rest: Partial<DigestReply> = {}): DigestReply {
    const first = Math.floor(needsYourEyes / 2);
    return aDigestReply({
      asks: FOUR_ANSWERS,
      items: [first, needsYourEyes - first].map((size) => anItem("yours-to-judge", { claim: words(5), sentence: words(size - 5) })),
      whatItDoes: words(whatItDoes),
      howItGotHere: words(howItGotHere),
      ...rest,
    });
  }

  it("refuse a Digest whose three sections come to 181 between them, saying so", () => {
    expect(refusalOf(sized(90, 46, 45))).toBe("Needs your eyes, What it does and How it got here come to 181 words between them, over the 180 a Digest's top may hold");
  });

  it("land a Digest whose three sections come to 180", () => {
    expect(digestCommentOf(sized(90, 45, 45), GIVEN)).toMatchObject({ ok: true });
  });

  it("land a Needs your eyes of 95 words, over its own 90, inside a total of 170: a section's cap is the prompt's, and only the total refuses", () => {
    expect(digestCommentOf(sized(95, 40, 35), GIVEN)).toMatchObject({ ok: true });
    expect(digestCommentOf(sized(60, 60, 60), GIVEN)).toMatchObject({ ok: true });
  });

  it("count each item's claim and sentence and the two texts, never a suggested request, a fold or Kit code's own headings and links", () => {
    const reply = sized(90, 45, 45, { walkthrough: words(400), decided: words(400), roundsLine: words(60) });
    const withRequests = { ...reply, items: reply.items.map((item) => ({ ...item, kind: "not-proven" as const, suggestedRequest: words(40) })) };

    expect(digestCommentOf(withRequests, GIVEN)).toMatchObject({ ok: true });
  });

  it("count a word as a run of characters between spaces, however the spaces fall", () => {
    const spaced = sized(90, 45, 45, { whatItDoes: `  ${words(44).replaceAll(" ", "  \n ")}  /basket-and-its-saved-copy\n` });

    expect(digestCommentOf(spaced, GIVEN)).toMatchObject({ ok: true });
    expect(refusalOf({ ...spaced, howItGotHere: `${words(45)} more` })).toMatch(/come to 181 words between them/);
  });
});

describe("The README's Digest section, on Needs your eyes", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = readme.split("\n## Digest\n")[1]?.split("\n## ")[0] ?? "";
  const bullets = section.split("\n").filter((line) => line.startsWith("- **"));
  const eyes = bullets.find((line) => line.startsWith("- **Needs your eyes**")) ?? "";

  it("comes straight after Kit code's facts", () => {
    expect(bullets[bullets.findIndex((line) => line.startsWith("- **Kit code's facts**")) + 1]).toBe(eyes);
    expect(eyes).not.toBe("");
  });

  it("says what the asks are, who is left out of them and how each is named and answered", () => {
    for (const said of ["every Request changes of yours", "every line comment in each", "dismissed", "deferred during a Retry", "`review-<id>`", "`inline-<id>`", "the same at every head"]) {
      expect(eyes).toContain(said);
    }
    expect(eyes).toContain("is listed by its line comments alone");
    expect(eyes).toContain("(`c1`, `c2`, …)");
    expect(eyes).toContain("in the head, not in the head, or could not tell");
    expect(eyes).toContain("a test, an end-to-end test, reading, a search, or Required checks");
  });

  it("names the three kinds in the order the contract puts them, the section and the fold as the contract renders them", () => {
    const body = bodyOf(aDigestReply({ asks: FOUR_ANSWERS }));
    const kinds = ["asked for and not here", "yours to judge", "not proven"].map((kind) => eyes.indexOf(kind));

    expect(kinds.every((at) => at >= 0)).toBe(true);
    expect(kinds).toEqual(kinds.toSorted((a, b) => a - b));
    expect(body).toContain("\n### Needs your eyes\n\nNothing.\n");
    expect(eyes).toContain('"Nothing."');
    expect(body).toContain("<summary>The criteria and how each was checked</summary>");
    expect(eyes).toContain("a fourth fold, **The criteria and how each was checked**");
    expect(eyes).toContain("`asks`");
    expect(eyes).toContain("`items`");
  });

  it("gives the limits the contract holds, and what is refused and what is only dropped or put in order", () => {
    expect(MAX_ITEMS).toBe(4);
    expect(eyes).toContain("at most four items");
    expect(eyes).toContain(`more than ${MAX_TOP_WORDS} words between them`);
    expect(eyes).toContain(`at most ${MAX_SUGGESTED_REQUEST_WORDS} words`);
    expect(eyes).toContain("90 words for Needs your eyes and 40 each for the other two");
    expect(eyes).toContain("an ask of Kit code's left unanswered");
    expect(eyes).toContain("which Kit code drops, keeping the item");
    expect(eyes).toContain("which Kit code puts in order");
  });

  it("gives the comment's first line as the contract writes it", () => {
    const firstLine = (bodyOf(aDigestReply({ asks: FOUR_ANSWERS })).split("\n")[0] ?? "").replace(/"[0-9a-f]{40}"/, "…").replace(/\[[^\]]*\]/, "[…]");

    expect(firstLine).toBe('<!-- fabrik:digest {"head":…,"asks":[…]} -->');
    expect(section).toContain(`\`${firstLine}\``);
  });
});
