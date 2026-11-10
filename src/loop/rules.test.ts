import { describe, expect, it } from "vitest";
import { aReplayIssue, replaySlice } from "../__fixtures__/replay.ts";
import { anIssue, aPullRequest, kitConfig, snapshotOf, snapshotOfPullRequest, tickSnapshot, withoutNotes } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { LoopEvent } from "./types.ts";

describe("Intake", () => {
  it("adds needs-triage to a plain new issue", () => {
    const issue = anIssue({ number: 7 });

    const plan = planFor({ kind: "issue-opened", issue: 7 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "add-labels", issue: 7, labels: ["needs-triage"] }],
    });
  });

  it.each([
    "needs-triage",
    "needs-info",
    "needs-design",
    "ready-for-agent",
    "ready-for-human",
    "wontfix",
  ])("leaves a new issue that already has the %s state alone, saying why", (state) => {
    const issue = anIssue({ number: 7, labels: ["bug", state] });

    const plan = planFor({ kind: "issue-opened", issue: 7 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason: `#7 already has the state label ${state}`,
    });
  });

  it.each(["wayfinder:map", "wayfinder:ticket"])(
    "leaves a new issue with the %s label alone, because a skill made it",
    (label) => {
      const issue = anIssue({ number: 7, labels: [label] });

      const plan = planFor({ kind: "issue-opened", issue: 7 }, snapshotOf(issue), kitConfig());

      expect(plan).toEqual({
        kind: "nothing",
        reason: `#7 has the label ${label}, so a skill made it`,
      });
    },
  );

  it("does not mistake a label that merely starts with wayfinder for a wayfinder label", () => {
    const issue = anIssue({ number: 7, labels: ["wayfinders"] });

    const plan = planFor({ kind: "issue-opened", issue: 7 }, snapshotOf(issue), kitConfig());

    expect(plan.kind).toBe("act");
  });

  it("adds needs-triage to an issue the Monitor filed, as fabrik:monitor isn't one of the Kit's own labels", () => {
    const issue = anIssue({ number: 7, author: "fabrik-app[bot]", byApp: true, labels: ["fabrik:monitor"] });

    const plan = planFor({ kind: "issue-opened", issue: 7 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "add-labels", issue: 7, labels: ["needs-triage"] }],
    });
  });

  it("leaves the Operator's new fabrik:replay issue alone, because the Kit owns it, so Triage never sorts the experiment", () => {
    const issue = anIssue({ number: 7, author: "operator", labels: ["fabrik:replay"] });

    const plan = planFor({ kind: "issue-opened", issue: 7 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason: "#7 has the label fabrik:replay, so the Kit owns it",
    });
  });

  it("leaves a new label-less sub-issue without needs-triage, saying in one quiet line which label to add (#478)", () => {
    const issue = anIssue({ number: 7, parent: 3 });

    const plan = planFor({ kind: "issue-opened", issue: 7 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 7,
          body: "Fabrik leaves a sub-issue alone, since a skill usually files them with their state. Add `needs-triage` for Triage to look at it, or a state label yourself.",
        },
      ],
    });
  });

  it("leaves a new sub-issue a skill filed with its state alone, with no comment", () => {
    const issue = anIssue({ number: 7, parent: 3, labels: ["enhancement", "ready-for-agent"] });

    const plan = planFor({ kind: "issue-opened", issue: 7 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason: "#7 already has the state label ready-for-agent",
    });
  });
});

// The scheduled tick reads a replay issue's request and takes its next step; nothing on the issue itself is a trigger.
describe("A replay issue (#156)", () => {
  const replay = anIssue({ number: 130, author: "operator", labels: ["fabrik:replay"], body: "```replay\nreview.effort: high\n```" });
  /** Sunday: the Audit's day, so the tick opens a pending Audit beside whatever the replay step does. */
  const tick = { kind: "scheduled-tick", now: "2026-11-08T04:00:00.000Z" } as const;
  const open = { number: 140, labels: ["fabrik:replay"], body: "", comments: [] };

  it.each<[string, LoopEvent]>([
    ["the label being added", { kind: "label-added", issue: 130, label: "fabrik:replay" }],
    [
      "the Operator's comment",
      { kind: "issue-comment-created", issue: 130, commenter: "operator", commenterIsBot: false, body: "Go on then.", comment: 901 },
    ],
  ])("plans nothing on %s: no comment, run or label change", (_, event) => {
    const plan = planFor(event, snapshotOf(replay), kitConfig());

    expect(plan.kind).toBe("nothing");
  });

  it("is taken a step on by the scheduled tick, beside the Audit it opens: the Operator's accepted issue's next Ticket starts", () => {
    const plan = withoutNotes(planFor(tick, tickSnapshot({ kitIssues: [open], replay: replaySlice() }), kitConfig()));

    expect(plan).toEqual({
      kind: "act",
      actions: [
        expect.objectContaining({ kind: "open-issue", labels: ["fabrik:audit"] }),
        { kind: "add-labels", issue: 140, labels: ["agent:replay"] },
        { kind: "check-dispatch" },
        { kind: "check-design-queue" },
      ],
    });
  });

  it("changes nothing the scheduled tick plans when it's someone else's, so nobody but the Operator spends a Subscription on one", () => {
    const plan = withoutNotes(planFor(tick, tickSnapshot({ kitIssues: [open], replay: replaySlice([aReplayIssue({ author: "someone-else" })]) }), kitConfig()));

    expect(plan).toEqual(withoutNotes(planFor(tick, tickSnapshot(), kitConfig())));
    expect(plan).toEqual({ kind: "act", actions: expect.arrayContaining([expect.objectContaining({ kind: "open-issue", labels: ["fabrik:audit"] })]) });
  });
});

describe("Applying Triage output", () => {
  const triaged = (output: unknown) =>
    ({ kind: "agent-run-finished", role: "triage", issue: 7, output: JSON.stringify(output) }) as const;

  it("comments, removes needs-triage, and adds exactly one category and one state label", () => {
    const issue = anIssue({ number: 7, labels: ["needs-triage"] });

    const plan = planFor(
      triaged({ category: "bug", state: "needs-design", comment: "Needs a design pass." }),
      snapshotOf(issue),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "comment", issue: 7, body: "Needs a design pass." },
        { kind: "remove-label", issue: 7, label: "needs-triage" },
        { kind: "add-labels", issue: 7, labels: ["bug", "needs-design"] },
      ],
    });
  });

  it("lands a foggy idea like any needs-design issue, its comment carrying the fog line as written and no Map or other label", () => {
    const issue = anIssue({ number: 7, labels: ["needs-triage"] });
    const comment = [
      "> *This was generated by AI during triage.*",
      "",
      "Nobody has settled what a finished import looks like yet.",
      "",
      "This looks too foggy for one Design session.",
    ].join("\n");

    const plan = planFor(triaged({ category: "enhancement", state: "needs-design", comment, brief: null }), snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "comment", issue: 7, body: comment },
        { kind: "remove-label", issue: 7, label: "needs-triage" },
        { kind: "add-labels", issue: 7, labels: ["enhancement", "needs-design"] },
      ],
    });
  });

  it("swaps out a category the author already chose, so the issue keeps exactly one", () => {
    const issue = anIssue({ number: 7, labels: ["needs-triage", "bug", "docs"] });

    const plan = planFor(
      triaged({ category: "enhancement", state: "needs-design", comment: "A feature, not a bug." }),
      snapshotOf(issue),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "comment", issue: 7, body: "A feature, not a bug." },
        { kind: "remove-label", issue: 7, label: "needs-triage" },
        { kind: "remove-label", issue: 7, label: "bug" },
        { kind: "add-labels", issue: 7, labels: ["enhancement", "needs-design"] },
      ],
    });
  });

  it("takes off a state label the Operator added while Triage ran, so Design and Dispatch don't both start", () => {
    const issue = anIssue({ number: 7, labels: ["needs-triage", "needs-design", "bug"] });

    const plan = planFor(
      triaged({ category: "bug", state: "ready-for-agent", comment: "Fast path.", brief: { summary: "Fix it.", acceptanceCriteria: ["It works"] } }),
      snapshotOf(issue),
      kitConfig(),
    );

    expect(plan).toMatchObject({
      kind: "act",
      actions: expect.arrayContaining([{ kind: "remove-label", issue: 7, label: "needs-design" }]),
    });
  });

  // labels.ts: "An issue holds at most one" state label.
  const stateLabels = ["needs-triage", "needs-info", "needs-design", "ready-for-agent", "ready-for-human", "wontfix"];
  const landings = [
    { state: "needs-info" },
    { state: "needs-design" },
    { state: "ready-for-agent", brief: { summary: "Fix it.", acceptanceCriteria: ["It works"] } },
    { state: "ready-for-human" },
    { state: "wontfix" },
  ];
  it.each(
    landings.flatMap((landing) =>
      stateLabels.filter((stale) => stale !== "needs-triage").map((stale) => [landing.state, stale, landing] as const),
    ),
  )("leaves exactly one state label when Triage lands %s on an issue that also has %s", (state, stale, landing) => {
    const issue = anIssue({ number: 7, labels: ["needs-triage", stale, "bug"] });

    const plan = planFor(triaged({ category: "bug", comment: "Sorted.", ...landing }), snapshotOf(issue), kitConfig());

    if (plan.kind !== "act") throw new Error(`expected act, got ${plan.kind}`);
    const after = new Set(issue.labels);
    for (const action of plan.actions) {
      if (action.kind === "remove-label") after.delete(action.label);
      if (action.kind === "add-labels") action.labels.forEach((label) => after.add(label));
    }
    expect([...after].filter((label) => stateLabels.includes(label))).toEqual([state]);
  });

  it.each([
    ["is not JSON", "category: bug"],
    ["is not an object", JSON.stringify(["bug", "needs-design"])],
    ["has no category", JSON.stringify({ state: "needs-design", comment: "Hm." })],
    ["names a category the Loop doesn't use", JSON.stringify({ category: "question", state: "needs-design", comment: "Hm." })],
    ["names no state", JSON.stringify({ category: "bug", comment: "Hm." })],
    ["leaves the issue in needs-triage", JSON.stringify({ category: "bug", state: "needs-triage", comment: "Hm." })],
    ["names a label that isn't a state", JSON.stringify({ category: "bug", state: "urgent", comment: "Hm." })],
    ["has an empty comment", JSON.stringify({ category: "bug", state: "needs-design", comment: "  " })],
  ])("fails the run as an Infrastructure failure, changing nothing, when the output %s", (_, output) => {
    const issue = anIssue({ number: 7, labels: ["needs-triage"] });

    const plan = planFor(
      { kind: "agent-run-finished", role: "triage", issue: 7, output },
      snapshotOf(issue),
      kitConfig(),
    );

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });

  it("writes a Fast-path issue's agent brief and acceptance criteria into the issue, then checks Dispatch", () => {
    const issue = anIssue({ number: 7, labels: ["needs-triage"] });

    const plan = planFor(
      triaged({
        category: "bug",
        state: "ready-for-agent",
        comment: "All six Fast-path tests pass.",
        brief: {
          summary: "The booking form rejects valid Medicare numbers.",
          acceptanceCriteria: ["A 10-digit Medicare number is accepted", "An 9-digit one is refused"],
        },
      }),
      snapshotOf(issue),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 7,
          body: [
            "All six Fast-path tests pass.",
            "",
            "## Agent brief",
            "",
            "The booking form rejects valid Medicare numbers.",
            "",
            "### Acceptance criteria",
            "",
            "- [ ] A 10-digit Medicare number is accepted",
            "- [ ] An 9-digit one is refused",
          ].join("\n"),
        },
        { kind: "remove-label", issue: 7, label: "needs-triage" },
        { kind: "add-labels", issue: 7, labels: ["bug", "ready-for-agent"] },
        { kind: "check-dispatch" },
      ],
    });
  });

  it.each([
    ["no brief", undefined],
    ["a brief with no acceptance criteria", { summary: "Fix it.", acceptanceCriteria: [] }],
  ])("fails the run when the Fast path comes with %s", (_, brief) => {
    const issue = anIssue({ number: 7, labels: ["needs-triage"] });

    const plan = planFor(
      triaged({ category: "bug", state: "ready-for-agent", comment: "Easy.", brief }),
      snapshotOf(issue),
      kitConfig(),
    );

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });

  it("leaves an issue alone if it left needs-triage while Triage ran, saying why", () => {
    const issue = anIssue({ number: 7, labels: ["bug", "ready-for-human"] });

    const plan = planFor(
      triaged({ category: "bug", state: "needs-design", comment: "Needs design." }),
      snapshotOf(issue),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "nothing",
      reason: "#7 no longer has needs-triage, so Triage's output is stale",
    });
  });

  it("closes a wontfix issue as not planned, with Triage's reasoning and no notification", () => {
    const issue = anIssue({ number: 7, labels: ["needs-triage"] });

    const plan = planFor(
      triaged({ category: "enhancement", state: "wontfix", comment: "Already built in src/booking.ts." }),
      snapshotOf(issue),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "comment", issue: 7, body: "Already built in src/booking.ts." },
        { kind: "remove-label", issue: 7, label: "needs-triage" },
        { kind: "add-labels", issue: 7, labels: ["enhancement", "wontfix"] },
        { kind: "close", issue: 7, reason: "not_planned" },
      ],
    });
  });

  it("closes a wontfix that names an original as a duplicate, its comment naming the original", () => {
    const issue = anIssue({ number: 7, labels: ["needs-triage"] });

    const plan = planFor(
      triaged({ category: "bug", state: "wontfix", comment: "The same crash as the one already filed.", duplicateOf: 12 }),
      snapshotOf(issue),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "comment", issue: 7, body: "The same crash as the one already filed.\n\nClosing as a duplicate of #12." },
        { kind: "remove-label", issue: 7, label: "needs-triage" },
        { kind: "add-labels", issue: 7, labels: ["bug", "wontfix"] },
        { kind: "close", issue: 7, reason: "duplicate" },
      ],
    });
  });

  it("refuses a duplicateOf naming the issue being triaged as output that breaks its contract", () => {
    const issue = anIssue({ number: 7, labels: ["needs-triage"] });

    const plan = planFor(triaged({ category: "bug", state: "wontfix", comment: "Dupe.", duplicateOf: 7 }), snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason: "Triage on #7 emitted output that breaks its contract: duplicateOf can't name #7, the issue being triaged",
    });
  });

  it("@-mentions the author of a needs-info issue with Triage's question, as its one notification", () => {
    const issue = anIssue({ number: 7, author: "kate", labels: ["needs-triage"] });

    const plan = planFor(
      triaged({ category: "bug", state: "needs-info", comment: "Which browser were you using?" }),
      snapshotOf(issue),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "comment", issue: 7, body: "@kate\n\nWhich browser were you using?" },
        { kind: "remove-label", issue: 7, label: "needs-triage" },
        { kind: "add-labels", issue: 7, labels: ["bug", "needs-info"] },
      ],
    });
  });

  it("asks the Operator, not the App, on a needs-info issue the Monitor filed (#425)", () => {
    const issue = anIssue({ number: 7, author: "fabrik-app[bot]", byApp: true, labels: ["needs-triage", "fabrik:monitor"] });

    const plan = planFor(
      triaged({ category: "bug", state: "needs-info", comment: "Which release did this start in?" }),
      snapshotOf(issue, { operator: "jrey8343" }),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 7,
          body: "@jrey8343 The Monitor filed this issue, so its question is yours.\n\nWhich release did this start in?",
        },
        { kind: "remove-label", issue: 7, label: "needs-triage" },
        { kind: "add-labels", issue: 7, labels: ["bug", "needs-info"] },
      ],
    });
  });

  it("assigns a ready-for-human issue to the Operator, with Triage's comment saying what to do", () => {
    const issue = anIssue({ number: 7, author: "kate", labels: ["needs-triage"] });

    const plan = planFor(
      triaged({ category: "bug", state: "ready-for-human", comment: "Rotate the Stripe key in the dashboard." }),
      snapshotOf(issue, { operator: "jrey8343" }),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "comment", issue: 7, body: "Rotate the Stripe key in the dashboard." },
        { kind: "remove-label", issue: 7, label: "needs-triage" },
        { kind: "add-labels", issue: 7, labels: ["bug", "ready-for-human"] },
        { kind: "assign", issue: 7, assignee: "jrey8343" },
      ],
    });
  });

  it("does not re-add a category the issue already has", () => {
    const issue = anIssue({ number: 7, labels: ["needs-triage", "bug"] });

    const plan = planFor(
      triaged({ category: "bug", state: "needs-design", comment: "Confirmed." }),
      snapshotOf(issue),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "comment", issue: 7, body: "Confirmed." },
        { kind: "remove-label", issue: 7, label: "needs-triage" },
        { kind: "add-labels", issue: 7, labels: ["needs-design"] },
      ],
    });
  });
});

describe("A reply on a needs-info issue", () => {
  const commented = (commenter: string, commenterIsBot: boolean) =>
    ({ kind: "issue-comment-created", issue: 7, commenter, commenterIsBot, body: "yes", comment: 9001 }) as const;

  it("sends the issue back to needs-triage when a person replies", () => {
    const issue = anIssue({ number: 7, author: "kate", labels: ["bug", "needs-info"] });

    const plan = planFor(commented("kate", false), snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "needs-info" },
        { kind: "add-labels", issue: 7, labels: ["needs-triage"] },
      ],
    });
  });

  it("sends the issue back to needs-triage when someone other than its author replies", () => {
    const issue = anIssue({ number: 7, author: "kate", labels: ["needs-info"] });

    const plan = planFor(commented("sam", false), snapshotOf(issue), kitConfig());

    expect(plan.kind).toBe("act");
  });

  it.each(["fabrik-app[bot]", "dependabot[bot]"])(
    "does nothing when the bot %s replies, so the Loop can't loop on itself",
    (bot) => {
      const issue = anIssue({ number: 7, author: "kate", labels: ["bug", "needs-info"] });

      const plan = planFor(commented(bot, true), snapshotOf(issue), kitConfig());

      expect(plan).toEqual({
        kind: "nothing",
        reason: `${bot} is a bot, so its comment on #7 doesn't restart Triage`,
      });
    },
  );

  it.each([["ready-for-human"], ["ready-for-agent"], ["needs-triage"]])(
    "does not restart Triage for a reply on an issue in %s",
    (state) => {
      const issue = anIssue({ number: 7, author: "kate", labels: ["bug", state] });

      const plan = planFor(commented("kate", false), snapshotOf(issue), kitConfig());

      expect(plan).toEqual({ kind: "nothing", reason: "#7 isn't in needs-info" });
    },
  );
});

describe("Starting Triage", () => {
  it("starts a Triage run when needs-triage is added to an open issue", () => {
    const issue = anIssue({ number: 7, labels: ["needs-triage"] });

    const plan = planFor({ kind: "label-added", issue: 7, label: "needs-triage" }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "start-agent-run",
          role: "triage",
          issue: 7,
          model: "claude-opus-5-5",
          effort: null,
          timeoutMinutes: 10,
          subscription: "Claude token",
        },
      ],
    });
  });

  it("does not triage a closed issue, saying why", () => {
    const issue = anIssue({ number: 7, labels: ["needs-triage"], open: false });

    const plan = planFor({ kind: "label-added", issue: 7, label: "needs-triage" }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "#7 is closed" });
  });
});

describe("An Operator comment on an agent PR", () => {
  const commented = (
    overrides: Partial<Extract<LoopEvent, { kind: "pull-request-commented" }>> = {},
  ): LoopEvent => ({
    kind: "pull-request-commented",
    pullRequest: 50,
    commenter: "operator",
    commenterIsBot: false,
    on: { kind: "conversation", comment: 7001 },
    ...overrides,
  });

  it("in the conversation gets a 👀 reaction, and nothing else: no run, no label, no state change", () => {
    const plan = planFor(commented(), snapshotOfPullRequest(aPullRequest()), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "react", pullRequest: 50, on: { kind: "conversation", comment: 7001 }, content: "eyes" }],
    });
  });

  it.each([
    ["a body and no inline comments", true, false],
    ["inline comments and no body", false, true],
    ["a body and inline comments", true, true],
  ])("in a Comment or Approve review with %s gets a 👀, and nothing else", (_, body, inlineComments) => {
    const on = { kind: "review", review: 900, node: "PRR_kwDO900", hasBody: body } as const;
    const plan = planFor(
      commented({ on }),
      snapshotOfPullRequest(aPullRequest({ draft: false }), { reviewHasInlineComments: inlineComments }),
      kitConfig(),
    );

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "react", pullRequest: 50, on, content: "eyes" }] });
  });

  it("in a review with no body and no inline comments, such as a bare Approve, plans nothing, saying why", () => {
    const plan = planFor(
      commented({ on: { kind: "review", review: 900, node: "PRR_kwDO900", hasBody: false } }),
      snapshotOfPullRequest(aPullRequest({ draft: false }), { reviewHasInlineComments: false }),
      kitConfig(),
    );

    expect(plan).toEqual({ kind: "nothing", reason: "review 900 on #50 is empty, so it has nothing to weigh" });
  });

  it("from a bot plans nothing", () => {
    const plan = planFor(
      commented({ commenter: "fabrik[bot]", commenterIsBot: true }),
      snapshotOfPullRequest(aPullRequest()),
      kitConfig(),
    );

    expect(plan.kind).toBe("nothing");
  });

  it("from another human plans nothing, so commenting can't steer an agent", () => {
    const plan = planFor(commented({ commenter: "passer-by" }), snapshotOfPullRequest(aPullRequest()), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "passer-by isn't the Operator, so their comment on #50 is not read" });
  });

  it("on a PR that isn't an agent PR plans nothing", () => {
    const plan = planFor(commented(), snapshotOfPullRequest(aPullRequest({ isAgent: false, ticket: null })), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "#50 isn't an agent PR" });
  });
});

describe("A trigger label on the wrong object (#479)", () => {
  it("takes agent:review off a Ticket and points to its PR", () => {
    const ticket = anIssue({ number: 7, labels: ["agent:review"], openPullRequests: [50] });

    const plan = planFor({ kind: "label-added", issue: 7, label: "agent:review" }, snapshotOf(ticket), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "agent:review" },
        { kind: "comment", issue: 7, body: "`agent:review` goes on the PR, not the Ticket: add it to #50." },
      ],
    });
  });

  it("takes agent:review off an issue with no open PR and says it has none", () => {
    const issue = anIssue({ number: 7, labels: ["agent:review"] });

    const plan = planFor({ kind: "label-added", issue: 7, label: "agent:review" }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "agent:review" },
        { kind: "comment", issue: 7, body: "`agent:review` goes on an agent PR, not an issue, and #7 has no open PR." },
      ],
    });
  });

  it("takes agent:implement off an agent PR and points to its Ticket", () => {
    const plan = planFor(
      { kind: "pull-request-labeled", pullRequest: 50, label: "agent:implement" },
      snapshotOfPullRequest(aPullRequest({ labels: ["agent:implement"] })),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 50, label: "agent:implement" },
        { kind: "comment", issue: 50, body: "`agent:implement` goes on the Ticket, not the PR: add it to #7." },
      ],
    });
  });

  it("takes agent:implement off a PR with no Ticket and says it has none", () => {
    const plan = planFor(
      { kind: "pull-request-labeled", pullRequest: 50, label: "agent:implement" },
      snapshotOfPullRequest(aPullRequest({ isAgent: false, ticket: null })),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 50, label: "agent:implement" },
        { kind: "comment", issue: 50, body: "`agent:implement` goes on a Ticket, not a PR, and #50 isn't on one." },
      ],
    });
  });

  it("takes needs-triage off a PR and says it goes on an issue", () => {
    const plan = planFor(
      { kind: "pull-request-labeled", pullRequest: 50, label: "needs-triage" },
      snapshotOfPullRequest(aPullRequest()),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 50, label: "needs-triage" },
        { kind: "comment", issue: 50, body: "`needs-triage` goes on an issue, not a PR: add it to the issue you want triaged." },
      ],
    });
  });
});
