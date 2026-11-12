import { describe, expect, it } from "vitest";
import { aNamedPullRequest, anIssue, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
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
