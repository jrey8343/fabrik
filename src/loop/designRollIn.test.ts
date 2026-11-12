import { describe, expect, it } from "vitest";
import { aNamedPullRequest, anIssue, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { landedNothingContext } from "../agent/design.ts";
import { countLandedNothing, currentDesignSessionIn, designSessionOf, designTurnFailedIn, pendingPrototypeIn, unansweredPrototypesIn } from "../github/threads.ts";
import { DESIGN_TURN_FAILED_MARKER, EMPTY_DIFF_MARKER, rollInIn, sessionFinishedIn } from "./markers.ts";
import { planFor } from "./rules.ts";
import type { LoopEvent, NamedPullRequestSnapshot, Plan } from "./types.ts";

const rollIn = {
  kind: "roll-in",
  pullRequest: 42,
  summary: "Show the cart's total beside its heading, so a shopper sees it without scrolling.\n\nThe total stays where it is at the foot of the page.",
  acceptanceCriteria: ["The cart page shows the total beside its heading.", "The total updates when a line is removed."],
};

function finished(output: unknown, more: Partial<Extract<LoopEvent, { kind: "agent-run-finished" }>> = {}): LoopEvent {
  return { kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output), ...more };
}

/** The open agent pull request #42, built from the Ticket #30: one a Roll-in can be settled onto. */
const openAgentPullRequest = (overrides: Partial<NamedPullRequestSnapshot> = {}) =>
  aNamedPullRequest({ number: 42, open: true, merged: false, headRef: "fabrik/ticket-30", ...overrides });

const inSession = (overrides: Parameters<typeof anIssue>[0] = {}) => anIssue({ number: 7, labels: ["enhancement", "needs-design"], ...overrides });

/** The snapshot of a turn on #7 that named these pull requests: by default the open agent pull request #42. */
const naming = (issue = inSession(), namedPullRequests: readonly NamedPullRequestSnapshot[] | null = [openAgentPullRequest()]) =>
  snapshotOf(issue, { namedPullRequests });

const land = (output: unknown = rollIn, snapshot = naming()): Plan => planFor(finished(output), snapshot, kitConfig());

describe("A Design session finishes by settling a Roll-in", () => {
  it("posts the closing comment, swaps needs-design for wontfix, closes the issue as not planned and checks the Design queue", () => {
    expect(land()).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 7,
          body: [
            "<!-- fabrik:roll-in 42 -->",
            '<!-- fabrik:roll-in-data {"v":1,"summary":"Show the cart\'s total beside its heading, so a shopper sees it without scrolling.\\n\\nThe total stays where it is at the foot of the page.","acceptanceCriteria":["The cart page shows the total beside its heading.","The total updates when a line is removed."]} -->',
            "**Design session finished.** The Operator settled a Roll-in onto #42, so the Kit closes this issue as not planned.",
            "",
            "### What to build on #42",
            "",
            "Show the cart's total beside its heading, so a shopper sees it without scrolling.",
            "",
            "The total stays where it is at the foot of the page.",
            "",
            "**Acceptance criteria**",
            "",
            "- The cart page shows the total beside its heading.",
            "- The total updates when a line is removed.",
            "",
            "Nothing has been sent to #42. The Operator sends this Roll-in with a Request changes on #42 that carries this text and names this issue, #7.",
          ].join("\n"),
        },
        { kind: "remove-label", issue: 7, label: "needs-design" },
        { kind: "add-labels", issue: 7, labels: ["wontfix"] },
        { kind: "close", issue: 7, reason: "not_planned" },
        { kind: "check-design-queue" },
      ],
    });
  });
});

describe("A Roll-in onto a pull request that can't take one", () => {
  it.each([
    [
      "a merged pull request",
      [openAgentPullRequest({ open: false, merged: true })],
      "a Roll-in can't be settled onto #42, which has merged: only an open agent pull request can take one",
    ],
    [
      "a closed pull request",
      [openAgentPullRequest({ open: false })],
      "a Roll-in can't be settled onto #42, which is closed: only an open agent pull request can take one",
    ],
    [
      "a Plain pull request",
      [openAgentPullRequest({ headRef: "feature/cart", isAgent: false })],
      "a Roll-in can't be settled onto #42, which is a Plain pull request: only an open agent pull request can take one",
    ],
    [
      "a person's pull request from an agent branch, which is a Plain one",
      [openAgentPullRequest({ isAgent: false })],
      "a Roll-in can't be settled onto #42, which is a Plain pull request: only an open agent pull request can take one",
    ],
    ["a pull request that does not exist", [], "a Roll-in can't be settled onto #42, which is no pull request in this repo"],
    [
      "another pull request than the one read",
      [openAgentPullRequest({ number: 43 })],
      "a Roll-in can't be settled onto #42, which is no pull request in this repo",
    ],
    [
      "the issue's own pull request",
      [openAgentPullRequest({ headRef: "fabrik/ticket-7" })],
      "a Roll-in can't be settled onto #42, which is #7's own pull request, built from it as its Ticket",
    ],
  ])("fails the run and changes nothing when it names %s, saying which pull request and why", (_, named, why) => {
    expect(land(rollIn, naming(inSession(), named))).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason: `The Design-session turn on #7 emitted output that breaks its contract: ${why}`,
    });
  });

  it("fails the run when the snapshot never read the pull request", () => {
    expect(land(rollIn, naming(inSession(), null))).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason: "The snapshot is missing the pull request the Roll-in names",
    });
  });

  it("takes any open agent pull request, whichever Ticket it was built from, in draft or not", () => {
    const plan = land(rollIn, naming(inSession({ body: "Filed from review.\n\nFrom PR #50" }), [openAgentPullRequest({ headRef: "fabrik/ticket-70" })]));

    expect(plan.kind).toBe("act");
  });
});

describe("What settling a Roll-in touches", () => {
  it("notifies nobody", () => {
    const plan = land(rollIn, snapshotOf(inSession({ openBlocking: [8] }), { operator: "jrey", namedPullRequests: [openAgentPullRequest()] }));

    expect(plan.kind).toBe("act");
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it("acts on nothing but the issue: no comment, label, review or anything else on the pull request", () => {
    const plan = land();
    if (plan.kind !== "act") throw new Error("expected a plan that acts");

    // Every action names the issue it acts on; the one that names none is the Design queue check, and none starts a run or a Dispatch check.
    expect(plan.actions.map((action) => ("issue" in action ? action.issue : action.kind))).toEqual([7, 7, 7, 7, "check-design-queue"]);
    expect(JSON.stringify(plan.actions.filter((action) => action.kind !== "comment"))).not.toContain("42");
    expect(plan.actions.filter((action) => "pullRequest" in action)).toEqual([]);
  });
});

/** The closing comment a turn ending in `output` posts on #7. */
function closingComment(output: unknown = rollIn, snapshot = naming()): string {
  const plan = land(output, snapshot);
  const comment = plan.kind === "act" ? plan.actions.find((action) => action.kind === "comment") : undefined;
  if (comment?.kind !== "comment") throw new Error(`expected a closing comment, got ${JSON.stringify(plan)}`);
  return comment.body;
}

describe("Reading a Roll-in back from its closing comment", () => {
  it("gives the pull request its mark names and the text, as the turn gave them", () => {
    expect(rollInIn(closingComment())).toEqual({
      pullRequest: 42,
      text: { summary: rollIn.summary, acceptanceCriteria: rollIn.acceptanceCriteria },
    });
  });

  // What could end the hidden line's HTML comment early, break it over two lines or mention someone, in the summary and in a criterion.
  const awkward = [
    "Render `<Total>` when `lines.length > 0`, --> never before.",
    "",
    "Keep the import from `@acme/cart`, and the comment <!-- total --> above it. Then a line separator.",
  ].join("\n");

  it("gives the same text back when it holds <, >, -->, a newline and an @ straight after a backtick", () => {
    const output = { ...rollIn, summary: awkward, acceptanceCriteria: [awkward, "The total shows."] };

    expect(rollInIn(closingComment(output))).toEqual({ pullRequest: 42, text: { summary: awkward, acceptanceCriteria: [awkward, "The total shows."] } });
  });

  it("keeps each hidden line one line that only its own end closes, whatever the text holds", () => {
    const [mark = "", data = "", third = ""] = closingComment({ ...rollIn, summary: awkward, acceptanceCriteria: [awkward] }).split("\n");

    expect(mark).toBe("<!-- fabrik:roll-in 42 -->");
    expect(data).toMatch(/^<!-- fabrik:roll-in-data \{"v":1,"summary":".*","acceptanceCriteria":\[".*"\]\} -->$/);
    expect(data.indexOf("-->")).toBe(data.length - "-->".length);
    expect(data).not.toContain("@");
    expect(third.startsWith("**Design session finished.** ")).toBe(true);
  });

  it("reads a comment whose lines GitHub gave back ending in CRLF", () => {
    expect(rollInIn(closingComment().replaceAll("\n", "\r\n"))).toEqual({
      pullRequest: 42,
      text: { summary: rollIn.summary, acceptanceCriteria: rollIn.acceptanceCriteria },
    });
  });

  const withSecondLine = (line: string | null) => {
    const [mark = "", , ...rest] = closingComment().split("\n");
    return [mark, ...(line === null ? [] : [line]), ...rest].join("\n");
  };

  it.each([
    ["removed", null],
    ["edited so it does not parse", '<!-- fabrik:roll-in-data {"v":1,"summary":"Show the total.","acceptanceCriteria":["The total shows."] -->'],
    ["of version 2", '<!-- fabrik:roll-in-data {"v":2,"summary":"Show the total.","acceptanceCriteria":["The total shows."]} -->'],
    ["with no version", '<!-- fabrik:roll-in-data {"summary":"Show the total.","acceptanceCriteria":["The total shows."]} -->'],
    ["whose summary is no text", '<!-- fabrik:roll-in-data {"v":1,"summary":7,"acceptanceCriteria":["The total shows."]} -->'],
    ["whose criteria are no list of text", '<!-- fabrik:roll-in-data {"v":1,"summary":"Show the total.","acceptanceCriteria":"The total shows."} -->'],
    ["that is no JSON object", '<!-- fabrik:roll-in-data ["Show the total."] -->'],
    ["cut short", '<!-- fabrik:roll-in-data {"v":1,"summary":"Show the total.","acceptanceCriteria":["The total shows."]}'],
    ["replaced by another marker", "<!-- fabrik:round-line {} -->"],
  ])("still gives the pull request, and no text, with the data line %s", (_, line) => {
    expect(rollInIn(withSecondLine(line))).toEqual({ pullRequest: 42, text: null });
  });

  it("reads a data line under the mark only: one further down is not the text", () => {
    const [mark = "", data = "", ...rest] = closingComment().split("\n");

    expect(rollInIn([mark, ...rest, data].join("\n"))).toEqual({ pullRequest: 42, text: null });
  });

  it("leaves out keys of the data line it doesn't know", () => {
    const line = '<!-- fabrik:roll-in-data {"v":1,"summary":"Show the total.","acceptanceCriteria":["The total shows."],"sent":true} -->';

    expect(rollInIn(withSecondLine(line))).toEqual({ pullRequest: 42, text: { summary: "Show the total.", acceptanceCriteria: ["The total shows."] } });
  });

  it.each([
    ["quotes the mark on its second line", `As the Kit wrote:\n${closingComment()}`],
    ["quotes the mark as a quotation", closingComment().replace(/^/gm, "> ")],
    ["quotes the mark after a space", ` ${closingComment()}`],
    ["quotes the mark in a code span", "`<!-- fabrik:roll-in 42 -->`\n**Design session finished.**"],
    ["names no pull request in its mark", "<!-- fabrik:roll-in -->\n**Design session finished.**"],
    ["names pull request zero", "<!-- fabrik:roll-in 0 -->\n**Design session finished.**"],
    ["opens with the data line and no mark", closingComment().split("\n").slice(1).join("\n")],
    ["has more than the mark on its first line", "<!-- fabrik:roll-in 42 --> and more\n**Design session finished.**"],
    ["is an ordinary not-planned finish", "**Design session finished.** This issue won't be built, so the Kit closes it as not planned.\n\nNobody asked for it."],
    ["is empty", ""],
  ])("is not a Roll-in's when it %s", (_, body) => {
    expect(rollInIn(body)).toBeNull();
  });

  it("reads a mark that is the whole comment", () => {
    expect(rollInIn("<!-- fabrik:roll-in 42 -->")).toEqual({ pullRequest: 42, text: null });
  });
});

// The comment opens with a hidden line, not the Kit's "Design session finished." line, and ends the session all the same.
describe("A Roll-in's closing comment ends its Design session, wherever the Kit looks for a session's finish", () => {
  const kit = (body: string) => ({ body, byApp: true });
  const person = (body: string) => ({ body, byApp: false });
  const round = (n: number) => kit(`<!-- fabrik:design-round ${n} -->\n@jrey **Design session, round ${n}.**`);
  const emptyDiff = kit(`${EMPTY_DIFF_MARKER}\nThe Implementer changed nothing.`);
  const failedTurn = kit(`${DESIGN_TURN_FAILED_MARKER}\nThe Design-session turn failed.`);
  const settled = kit(closingComment());

  it("is one, and so is any comment the Kit's finished line opens", () => {
    expect(sessionFinishedIn(settled.body)).toBe(true);
    expect(sessionFinishedIn("**Design session finished.** This issue is now its agent brief, ready for an Implementer.")).toBe(true);
  });

  it.each([
    ["a round", round(1).body],
    ["a comment that quotes a Roll-in's closing comment", `As the Kit wrote:\n\n${settled.body}`],
    ["a comment that quotes the finished line further down", "Was it this?\n\n**Design session finished.**"],
  ])("isn't one for %s", (_, body) => {
    expect(sessionFinishedIn(body)).toBe(false);
  });

  it("a later session on the issue, reopened, counts its Rounds from 1", () => {
    const earlier = [round(1), person("Yes, roll it in."), round(2), person("Onto #42."), settled];

    expect(designSessionOf(earlier)).toEqual({ designRounds: 0, sentBack: null });
    expect(designSessionOf([...earlier, round(1)])).toEqual({ designRounds: 1, sentBack: null });
  });

  it("a later session's comments start after it", () => {
    const later = [person("Reopened: #42 merged without it."), round(1)];

    expect(currentDesignSessionIn([round(1), person("Yes."), settled, ...later])).toEqual(later);
  });

  it("the earlier session's failed turn, landed-nothing runs and unanswered prototype request end with it", () => {
    const request = kit('<!-- fabrik:prototype-request {"route":"/cart","variants":2,"brief":"Two takes.","reply":null} -->\n**Prototype requested.**');

    expect(designTurnFailedIn([round(1), failedTurn, settled])).toBe(false);
    expect(countLandedNothing([emptyDiff, emptyDiff, settled])).toBe(0);
    expect(unansweredPrototypesIn([round(1), request, settled])).toEqual([]);
    expect(pendingPrototypeIn([round(1), request, settled].map((comment, i) => ({ ...comment, id: i + 1 })))).toBeNull();
  });

  it("ends nothing when anyone but the Fabrik App wrote it", () => {
    const quoted = person(settled.body);

    expect(designSessionOf([round(1), round(2), quoted])).toEqual({ designRounds: 2, sentBack: null });
    expect(currentDesignSessionIn([round(1), quoted, round(2)])).toHaveLength(3);
  });

  it("a later turn's prompt leaves out the runs that landed nothing before it", () => {
    const comment = (body: string, byBot = true) => ({ body, byBot });
    const before = { number: 7, comments: [comment(emptyDiff.body), comment(settled.body)] };
    const after = { number: 7, comments: [comment(emptyDiff.body), comment(settled.body, false), comment(emptyDiff.body)] };

    expect(landedNothingContext(before)).toEqual([]);
    // A person's copy of the comment ends nothing, so both runs are still told.
    expect(landedNothingContext(after).join("\n")).toContain("2 Implement runs on this Ticket since its last Design session landed nothing");
  });
});
