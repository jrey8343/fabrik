import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, kitConfig, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
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

  it("leaves a new sub-issue alone, because a skill made it under its parent", () => {
    const issue = anIssue({ number: 7, parent: 3 });

    const plan = planFor({ kind: "issue-opened", issue: 7 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason: "#7 is a sub-issue of #3, so a skill made it",
    });
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

  it("in a Comment or Approve review gets a 👀 on each of its inline comments, and nothing else", () => {
    const plan = planFor(
      commented({ on: { kind: "review", review: 900 } }),
      snapshotOfPullRequest(aPullRequest({ draft: false })),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "react", pullRequest: 50, on: { kind: "review", review: 900 }, content: "eyes" }],
    });
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
