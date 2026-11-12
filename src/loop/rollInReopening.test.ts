import { describe, expect, it } from "vitest";
import { aNamedPullRequest, anIssue, aPullRequest, kitConfig, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { mentionsSomeone } from "./mentions.ts";
import type { RequestChangesText, RollInComment, RollInIssue } from "./owedRollIn.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, PullRequestSnapshot, RollInsSnapshot } from "./types.ts";

type Closed = Extract<LoopEvent, { kind: "pull-request-closed" }>;

const merged: Closed = { kind: "pull-request-closed", pullRequest: 42, merged: true, closedByBot: false };
const closedByHand: Closed = { ...merged, merged: false };
const closedByTheKit: Closed = { ...merged, merged: false, closedByBot: true };

/** The agent pull request #42, built from the Ticket #30, as it stands once it has merged or closed. */
const pullRequest = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot =>
  aPullRequest({ number: 42, ticket: 30, open: false, draft: false, url: "https://github.com/acme/shop/pull/42", ...overrides });

/** A comment the Fabrik App wrote on #7, unless a test says who did. */
const comment = (body: string, overrides: Partial<RollInComment> = {}): RollInComment => ({
  body,
  byApp: true,
  at: "2026-11-10T09:00:00Z",
  url: "https://github.com/acme/shop/issues/7#issuecomment-1",
  ...overrides,
});

/** The closing comment the Kit posts when a Design session on `issue` settles a Roll-in onto `onto`: its landing's own. */
function settledOnto(onto: number, issue = 7): RollInComment {
  const output = { kind: "roll-in", pullRequest: onto, summary: "Show the cart's total beside its heading.", acceptanceCriteria: ["The cart page shows the total beside its heading."] };
  const landing = planFor(
    { kind: "agent-run-finished", role: "design", issue, output: JSON.stringify(output) },
    snapshotOf(anIssue({ number: issue, labels: ["enhancement", "needs-design"] }), {
      namedPullRequests: [aNamedPullRequest({ number: onto, open: true, merged: false, headRef: "fabrik/ticket-30" })],
    }),
    kitConfig(),
  );
  const closing = actionsOf(landing)[0];
  if (closing?.kind !== "comment") throw new Error(`expected the landing to open with its closing comment, got ${JSON.stringify(landing)}`);
  return comment(closing.body);
}

/** An issue closed as not planned under a Roll-in settled onto #42, by default #7. */
const settled = (overrides: Partial<RollInIssue> = {}): RollInIssue => ({
  number: 7,
  title: "Show the cart's total",
  repo: "acme/shop",
  closedAs: "not_planned",
  comments: [settledOnto(42, overrides.number ?? 7)],
  ...overrides,
});

/** What the Loop read for #42's closing: these issues GitHub cross-references to it, and these Request changes of the Operator's on it. */
const holding = (issues: readonly RollInIssue[] = [settled()], requestChanges: readonly RequestChangesText[] = []): RollInsSnapshot => ({
  repo: "acme/shop",
  requestChanges,
  issues,
});

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

const closing = (event: Closed, rollIns: RollInsSnapshot | null = holding(), closed = pullRequest()): Plan =>
  planFor(event, snapshotOfPullRequest(closed, { rollIns }), kitConfig());

const MERGED_LINE =
  "<!-- fabrik:roll-in-reopened -->\n#42 merged before this Roll-in was sent, so the Kit reopened this issue for Triage: its work can be built on `main` as its own Ticket.";
const CLOSED_LINE =
  "<!-- fabrik:roll-in-reopened -->\n#42 closed unmerged before this Roll-in was sent, so the Kit reopened this issue for Triage. The code the text above names may not be on `main`.";

/** What the Kit does to an issue whose Roll-in was left unsent, in order. */
const reopened = (issue: number, line: string): Action[] => [
  { kind: "reopen", issue },
  { kind: "remove-label", issue, label: "wontfix" },
  { kind: "comment", issue, body: line },
  { kind: "add-labels", issue, labels: ["needs-triage"] },
];

describe("An agent pull request merges with a Roll-in unsent", () => {
  it("reopens the issue, takes wontfix off, says why in one line and adds needs-triage, before the Dispatch check its freed slot asks for", () => {
    expect(closing(merged)).toEqual({ kind: "act", actions: [...reopened(7, MERGED_LINE), { kind: "check-dispatch" }] });
  });

  it("reopens each of two, lowest issue number first", () => {
    const plan = closing(merged, holding([settled({ number: 12 }), settled({ number: 7 })]));

    expect(plan).toEqual({ kind: "act", actions: [...reopened(7, MERGED_LINE), ...reopened(12, MERGED_LINE), { kind: "check-dispatch" }] });
  });
});

describe("An agent pull request closes unmerged with a Roll-in unsent", () => {
  it("reopens the issue when the Kit closed it, as Send it back and Back to design do, saying its code may not be on main", () => {
    expect(closing(closedByTheKit)).toEqual({ kind: "act", actions: [...reopened(7, CLOSED_LINE), { kind: "check-dispatch" }] });
  });

  it("reopens the issue when the Operator closed it by hand, beside stopping its Ticket", () => {
    const plan = closing(closedByHand, holding(), pullRequest({ ticketLabels: ["enhancement", "ready-for-agent"] }));

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 30,
          body: "#42 was closed unmerged by hand, so the Kit won't start another Implement run on this Ticket by itself, and its branch `fabrik/ticket-30` stays. To have an Implementer try again, mark it `ready-for-agent`: the new run starts from `main` and replaces that branch.\n<!-- fabrik:hand-back {\"kind\":\"closed-by-hand\",\"role\":\"implement\"} -->",
        },
        { kind: "remove-label", issue: 30, label: "ready-for-agent" },
        { kind: "add-labels", issue: 30, labels: ["ready-for-human"] },
        { kind: "assign", issue: 30, assignee: "operator" },
        ...reopened(7, CLOSED_LINE),
        { kind: "check-dispatch" },
      ],
    });
  });

  it("reopens the issue when the Operator closed it by hand and its Ticket was stopped already", () => {
    expect(closing(closedByHand)).toEqual({ kind: "act", actions: [...reopened(7, CLOSED_LINE), { kind: "check-dispatch" }] });
  });
});

describe("The reopening note", () => {
  const noteOf = (event: Closed): string => {
    const note = actionsOf(closing(event)).find((action) => action.kind === "comment");
    if (note?.kind !== "comment") throw new Error("expected a reopening note");
    return note.body;
  };

  it.each([
    ["a merge", merged],
    ["a close", closedByHand],
  ])("mentions nobody, for %s", (_, event) => {
    expect(mentionsSomeone(noteOf(event))).toBe(false);
  });

  it("makes the reopening happen once: with the note on the issue, the pull request closing again reopens nothing", () => {
    const noted = settled({ comments: [settledOnto(42), comment(noteOf(merged), { at: "2026-11-11T09:00:00Z" })] });

    expect(closing(merged, holding([noted]))).toEqual({ kind: "act", actions: [{ kind: "check-dispatch" }] });
  });

  it("comes after the reopening and before needs-triage, which starts Triage only on an open issue", () => {
    const kinds = actionsOf(closing(merged)).map(({ kind }) => kind);

    expect(kinds.indexOf("reopen")).toBeLessThan(kinds.indexOf("comment"));
    expect(kinds.indexOf("reopen")).toBeLessThan(kinds.indexOf("add-labels"));
    expect(kinds.indexOf("comment")).toBeLessThan(kinds.indexOf("add-labels"));
  });
});

describe("A Roll-in the Operator sent", () => {
  const onlyFreesItsSlot = { kind: "act", actions: [{ kind: "check-dispatch" }] };

  it.each([
    ["by # and its number", "Roll in #7: show the total beside the heading."],
    ["by its link", "Roll in https://github.com/acme/shop/issues/7 as its closing comment says."],
  ])("leaves its issue closed when the Operator's Request changes on that pull request names it %s", (_, body) => {
    expect(closing(merged, holding([settled()], [{ body, dismissed: false }]))).toEqual(onlyFreesItsSlot);
    expect(closing(closedByHand, holding([settled()], [{ body, dismissed: false }]))).toEqual(onlyFreesItsSlot);
  });

  it("is unsent again once that Request changes was dismissed, so the issue is reopened", () => {
    const plan = closing(merged, holding([settled()], [{ body: "Roll in #7.", dismissed: true }]));

    expect(plan).toEqual({ kind: "act", actions: [...reopened(7, MERGED_LINE), { kind: "check-dispatch" }] });
  });

  it("reopens only the issue no Request changes named, of two", () => {
    const plan = closing(merged, holding([settled({ number: 7 }), settled({ number: 12 })], [{ body: "Roll in #12.", dismissed: false }]));

    expect(plan).toEqual({ kind: "act", actions: [...reopened(7, MERGED_LINE), { kind: "check-dispatch" }] });
  });
});

describe("Nothing is reopened", () => {
  const onlyFreesItsSlot = { kind: "act", actions: [{ kind: "check-dispatch" }] };
  const notPlanned = comment("**Design session finished.** The Operator decided this is not planned, so the Kit closes this issue. See #42.", { at: "2026-11-12T09:00:00Z" });

  it.each([
    ["an issue that is open already", settled({ closedAs: null })],
    ["an issue closed as completed", settled({ closedAs: "completed" })],
    ["a Roll-in settled onto a different pull request", settled({ comments: [settledOnto(43)] })],
    ["a comment quoting the mark that the Fabrik App did not write", settled({ comments: [{ ...settledOnto(42), byApp: false }] })],
    ["an issue whose later Design session finished another way", settled({ comments: [settledOnto(42), notPlanned] })],
    ["an issue that already carries the reopening note", settled({ comments: [settledOnto(42), comment(MERGED_LINE, { at: "2026-11-11T09:00:00Z" })] })],
    ["an ordinary not-planned finish, which GitHub cross-references to the pull request", settled({ comments: [notPlanned] })],
  ])("for %s", (_, issue) => {
    expect(closing(merged, holding([issue]))).toEqual(onlyFreesItsSlot);
    expect(closing(closedByHand, holding([issue]))).toEqual(onlyFreesItsSlot);
  });

  it("when GitHub cross-references no closed issue to the pull request, or the snapshot read none", () => {
    expect(closing(merged, holding([]))).toEqual(onlyFreesItsSlot);
    expect(closing(merged, null)).toEqual(onlyFreesItsSlot);
  });

  it("for a Plain pull request: its plan is what it was", () => {
    const plain = pullRequest({ isAgent: false, ticket: null });

    expect(closing(merged, holding(), plain)).toEqual({ kind: "nothing", reason: "#42 isn't an agent PR" });
    expect(closing(closedByHand, holding(), plain)).toEqual({ kind: "nothing", reason: "#42 isn't an agent PR" });
  });
});
