import { describe, expect, it } from "vitest";
import { namesIssue, owedRollIns, type RollInComment, type RollInFacts, type RollInIssue, unsentRollIns } from "./owedRollIn.ts";

const TEXT = { summary: "Show the cart's total beside its heading.", acceptanceCriteria: ["The cart page shows the total beside its heading."] };

/** A comment the Fabrik App wrote, unless a test says who did. */
const comment = (body: string, overrides: Partial<RollInComment> = {}): RollInComment => ({
  body,
  byApp: true,
  at: "2026-11-10T09:00:00Z",
  url: "https://github.com/acme/shop/issues/7#issuecomment-1",
  ...overrides,
});

/** The closing comment of a Design session that settled a Roll-in onto `pullRequest`, as the Kit writes it. */
const settledOnto = (pullRequest: number, overrides: Partial<RollInComment> = {}): RollInComment =>
  comment(
    [
      `<!-- fabrik:roll-in ${pullRequest} -->`,
      `<!-- fabrik:roll-in-data ${JSON.stringify({ v: 1, ...TEXT })} -->`,
      `**Design session finished.** The Operator settled a Roll-in onto #${pullRequest}, so the Kit closes this issue as not planned.`,
      "",
      `### What to build on #${pullRequest}`,
    ].join("\n"),
    overrides,
  );

/** The Kit's note that it reopened the issue for Triage. */
const reopeningNote = comment("<!-- fabrik:roll-in-reopened -->\n#42 merged before this Roll-in was sent.", { at: "2026-11-11T09:00:00Z" });

/** #7, closed as not planned under a Roll-in settled onto #42. */
const settled = (overrides: Partial<RollInIssue> = {}): RollInIssue => ({
  number: 7,
  title: "Show the cart's total",
  repo: "acme/shop",
  closedAs: "not_planned",
  comments: [settledOnto(42)],
  ...overrides,
});

/** What GitHub holds of #42 in acme/shop, an open agent pull request, and the closed issues that name it. */
const facts = (issues: readonly RollInIssue[] = [settled()], pullRequest: Partial<RollInFacts["pullRequest"]> = {}): RollInFacts => ({
  repo: "acme/shop",
  pullRequest: { number: 42, open: true, isAgent: true, requestChanges: [], ...pullRequest },
  issues,
});

const issuesOf = (rollIns: readonly { readonly issue: number }[]) => rollIns.map(({ issue }) => issue);

describe("A Roll-in owed on an open agent pull request", () => {
  it("is each issue closed as not planned whose Design session settled a Roll-in onto it, with the closing comment's time, address and text", () => {
    expect(owedRollIns(facts())).toEqual([
      {
        issue: 7,
        title: "Show the cart's total",
        pullRequest: 42,
        at: "2026-11-10T09:00:00Z",
        url: "https://github.com/acme/shop/issues/7#issuecomment-1",
        text: TEXT,
      },
    ]);
  });

  it("is unsent too, on the same facts", () => {
    expect(unsentRollIns(facts())).toEqual(owedRollIns(facts()));
  });
});

describe("Clause 1: the issue is closed as not planned, in the pull request's repo", () => {
  it.each([
    ["closed as completed", { closedAs: "completed" }],
    ["closed as a duplicate", { closedAs: "duplicate" }],
    ["open", { closedAs: null }],
    ["in another repo", { repo: "acme/blog" }],
  ] as const)("owes nothing for an issue %s, and leaves nothing unsent", (_, overrides) => {
    expect(owedRollIns(facts([settled(overrides)]))).toEqual([]);
    expect(unsentRollIns(facts([settled(overrides)]))).toEqual([]);
  });
});

describe("Clause 2: the latest of the Fabrik App's comments that end a Design session is a Roll-in's onto this pull request, with no reopening note after it", () => {
  const notPlanned = comment("**Design session finished.** The Operator decided this is not planned.", { at: "2026-11-12T09:00:00Z" });
  const round = comment("<!-- fabrik:design-round 1 -->\n**Design session, round 1.**", { at: "2026-11-11T09:00:00Z" });

  it.each([
    ["whose Roll-in was settled onto another pull request", [settledOnto(43)]],
    ["whose session finished as not planned, with no Roll-in", [notPlanned]],
    ["whose later session finished another way", [settledOnto(42), round, notPlanned]],
    ["whose only mark is in a comment the Fabrik App did not write", [settledOnto(42, { byApp: false })]],
    ["whose mark is only quoted further down the Fabrik App's comment", [comment(`The Operator asked about this line:\n${settledOnto(42).body}`)]],
    ["that already carries the Kit's reopening note", [settledOnto(42), reopeningNote]],
    ["with no comments", []],
  ])("owes nothing for an issue %s, and leaves nothing unsent", (_, comments) => {
    expect(owedRollIns(facts([settled({ comments })]))).toEqual([]);
    expect(unsentRollIns(facts([settled({ comments })]))).toEqual([]);
  });

  it.each([
    ["an earlier session finished another way", [notPlanned, settledOnto(42)]],
    ["anyone but the Fabrik App wrote a later finished line or a reopening note", [settledOnto(42), { ...notPlanned, byApp: false }, { ...reopeningNote, byApp: false }]],
    ["a reopening note came before it, from an earlier Roll-in", [settledOnto(43), reopeningNote, settledOnto(42)]],
    ["the Fabrik App commented since without ending a session", [settledOnto(42), round]],
  ])("still owes it when %s", (_, comments) => {
    expect(issuesOf(owedRollIns(facts([settled({ comments })])))).toEqual([7]);
    expect(issuesOf(unsentRollIns(facts([settled({ comments })])))).toEqual([7]);
  });

  it("is still owed, with no text, when the hidden line of data is missing or of a version this release does not know", () => {
    const missing = comment("<!-- fabrik:roll-in 42 -->\n**Design session finished.**");
    const newer = comment('<!-- fabrik:roll-in 42 -->\n<!-- fabrik:roll-in-data {"v":2,"summary":"x","acceptanceCriteria":["y"]} -->\n**Design session finished.**');

    expect(owedRollIns(facts([settled({ comments: [missing] })]))).toMatchObject([{ issue: 7, text: null }]);
    expect(owedRollIns(facts([settled({ comments: [newer] })]))).toMatchObject([{ issue: 7, text: null }]);
  });
});

describe("Clause 3: the pull request is an open agent pull request", () => {
  it.each([
    ["has merged or closed", { open: false }],
    ["is a Plain pull request", { isAgent: false }],
  ])("owes nothing on one that %s", (_, pullRequest) => {
    expect(owedRollIns(facts([settled()], pullRequest))).toEqual([]);
  });

  it("leaves the Roll-in unsent on one that has merged or closed: the one clause unsent does not ask for", () => {
    expect(issuesOf(unsentRollIns(facts([settled()], { open: false })))).toEqual([7]);
  });
});

describe("Clause 4: no Request changes of the Operator's on the pull request, not dismissed, names the issue", () => {
  const sent = (body: string, dismissed = false) => facts([settled()], { requestChanges: [{ body, dismissed }] });

  it.each([
    ["by its number after a #", "Roll in #7: show the total beside the heading."],
    ["by its link", "Roll in https://github.com/acme/shop/issues/7 as written there."],
  ])("owes nothing once one names it %s, and leaves nothing unsent", (_, body) => {
    expect(owedRollIns(sent(body))).toEqual([]);
    expect(unsentRollIns(sent(body))).toEqual([]);
  });

  it.each([
    ["was dismissed since", sent("Roll in #7.", true)],
    ["names another issue", sent("Roll in #70, and see https://github.com/acme/shop/issues/71.")],
    ["names the same number in another repo", sent("As https://github.com/acme/blog/issues/7 does.")],
  ])("still owes it when the one that %s is the only one", (_, given) => {
    expect(issuesOf(owedRollIns(given))).toEqual([7]);
    expect(issuesOf(unsentRollIns(given))).toEqual([7]);
  });

  it("owes nothing when any one of several names it", () => {
    const given = facts([settled()], { requestChanges: [{ body: "Tighten the copy.", dismissed: false }, { body: "And roll in #7.", dismissed: false }] });

    expect(owedRollIns(given)).toEqual([]);
  });
});

describe("Several Roll-ins on one pull request", () => {
  it("come lowest issue number first, each read by itself", () => {
    const given = facts(
      [settled({ number: 12 }), settled({ number: 7 }), settled({ number: 9, closedAs: "completed" })],
      { requestChanges: [{ body: "Roll in #12.", dismissed: false }] },
    );

    expect(issuesOf(owedRollIns({ ...given, pullRequest: { ...given.pullRequest, requestChanges: [] } }))).toEqual([7, 12]);
    expect(issuesOf(owedRollIns(given))).toEqual([7]);
  });
});

describe("Whether a text names an issue", () => {
  it.each([
    ["its number after a #", "Roll in #7.", true],
    ["its number at the very start", "#7", true],
    ["its link", "See https://github.com/acme/shop/issues/7.", true],
    ["its link in another case", "See https://GitHub.com/Acme/Shop/issues/7", true],
    ["a longer number that starts the same", "Roll in #70 and https://github.com/acme/shop/issues/70", false],
    ["the number with no #", "Roll in issue 7", false],
    ["the number in another repo, by link or by owner/name#n", "https://github.com/acme/blog/issues/7 and acme/blog#7", false],
    ["a pull request's link with that number", "https://github.com/acme/shop/pull/7", false],
    ["nothing", "", false],
  ])("reads %s", (_, text, names) => {
    expect(namesIssue(text, "acme/shop", 7)).toBe(names);
  });

  it("takes the repo's name as written, not as a pattern", () => {
    expect(namesIssue("https://github.com/acmeXshop/issues/7", "acme.shop", 7)).toBe(false);
  });
});
