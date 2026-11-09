import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, notificationsOf, snapshotOf, tickSnapshot, withoutNotes } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { KitIssueSnapshot, LoopEvent, Plan } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

/** The issue a plan opened, as the adapter would later read it back once GitHub gave it this number. */
function kitIssueOpenedBy(plan: Plan, number: number, comments: readonly string[] = []): KitIssueSnapshot {
  const opened = plan.kind === "act" ? plan.actions.find((action) => action.kind === "open-issue") : undefined;
  if (opened === undefined) throw new Error("expected the plan to open an issue");
  return { number, labels: opened.labels, body: opened.body, comments };
}

function deadToken(issue = 7): Extract<LoopEvent, { kind: "agent-run-failed" }> {
  return {
    kind: "agent-run-failed",
    role: "triage",
    issue,
    runUrl: RUN,
    jobResult: "failure",
    secretsStep: "success",
    report: { failure: "dead-token", detail: "authentication_failed (401)" },
  };
}

describe("The Rotate the Claude token issue", () => {
  it("the first auth failure in a repo opens a ready-for-human issue assigned to the Operator", () => {
    const plan = planFor(deadToken(), snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] })), kitConfig());

    if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${plan.kind}`);
    const opened = plan.actions.filter((action) => action.kind === "open-issue");
    expect(opened).toEqual([
      {
        kind: "open-issue",
        title: "Rotate the Claude token",
        body: expect.stringContaining("claude setup-token"),
        labels: ["ready-for-human", "fabrik:token-rotation"],
        assignees: ["operator"],
      },
    ]);
  });

  it("writes its steps as a task list, so a Pairing session can start on it straight away", () => {
    const issue = kitIssueOpenedBy(planFor(deadToken(), snapshotOf(anIssue({ number: 7 })), kitConfig()), 40);

    expect(issue.body).toContain("\n## Steps\n\n- [ ] Run `claude setup-token`");
    expect(issue.body.match(/^- \[ \] /gm)).toHaveLength(2);
    expect(issue.body).toContain("Run `/fabrik-pair` on this issue to work through these steps with an agent.");
  });

  it("the first auth failure buzzes the Operator once, by the assignment, and the Ticket's comment points at the issue", () => {
    const plan = planFor(deadToken(), snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] })), kitConfig());

    expect(notificationsOf(plan)).toEqual(['assign new "Rotate the Claude token"']);
    expect(plan).toMatchObject({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "needs-triage" },
        {
          kind: "comment",
          issue: 7,
          body: expect.stringMatching(/^The Triage run on #7 failed: the Claude token was refused/),
        },
        { kind: "open-issue" },
      ],
    });
  });

  it("a later auth failure comments on the open rotation issue without a mention, and opens nothing", () => {
    const first = planFor(deadToken(7), snapshotOf(anIssue({ number: 7 })), kitConfig());
    const rotation = kitIssueOpenedBy(first, 40);

    const plan = planFor(deadToken(8), snapshotOf(anIssue({ number: 8 }), { kitIssues: [rotation] }), kitConfig());

    expect(notificationsOf(plan)).toEqual([]);
    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 8, label: "needs-triage" },
        { kind: "comment", issue: 8, body: expect.stringContaining("The Kit is tracking this in #40.") },
        {
          kind: "comment",
          issue: 40,
          body: `The Triage run on #8 was refused too. [The run](${RUN})`,
        },
      ],
    });
  });

  it("the first auth failure @-mentions the Operator on a rotation issue that was already open, and later ones don't", () => {
    // Opened ahead of time, say by the Operator, so nobody has been buzzed yet.
    const ahead: KitIssueSnapshot = {
      number: 40,
      labels: ["fabrik:token-rotation"],
      body: "The token expires on Friday.",
      comments: [],
    };

    const first = planFor(deadToken(7), snapshotOf(anIssue({ number: 7 }), { kitIssues: [ahead] }), kitConfig());

    expect(notificationsOf(first)).toEqual(["mention on #40"]);
    if (first.kind !== "act") throw new Error("expected a plan that acts");
    const mention = first.actions.find((action) => action.kind === "comment" && action.issue === 40);
    expect(mention).toMatchObject({ body: expect.stringMatching(/^@operator The Claude token was refused/) });

    const after = { ...ahead, comments: [mention?.kind === "comment" ? mention.body : ""] };
    const later = planFor(deadToken(8), snapshotOf(anIssue({ number: 8 }), { kitIssues: [after] }), kitConfig());

    expect(notificationsOf(later)).toEqual([]);
  });
});

describe("The dead-token issue names the Subscription whose vault item needs rotating", () => {
  const TWO_SUBSCRIPTIONS = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
  const onSecond = (issue = 7): LoopEvent => ({ ...deadToken(issue), subscription: "Claude token 2" });

  it("opens the rotation issue for that Subscription, whose step names its vault item", () => {
    const plan = planFor(onSecond(), snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] })), TWO_SUBSCRIPTIONS);
    const issue = kitIssueOpenedBy(plan, 40);

    expect(plan).toMatchObject({ kind: "act", actions: [{}, {}, { kind: "open-issue", title: "Rotate the Claude token of the `Claude token 2` Subscription" }] });
    expect(issue.body).toMatch(/^The Claude token of the `Claude token 2` Subscription was refused \(`authentication_failed`\)/);
    expect(issue.body).toContain("in the `Claude token 2` item in the Fabrik 1Password vault.");
    expect(issue.body).not.toContain("`Claude token` item");
  });

  it("says in the Ticket's failure comment, when no other Subscription is free to re-run it on, which Subscription's token was refused", () => {
    // The first listed Subscription's token is dead too, and no weekly-limit issue is open to hold the run on.
    const firstDead: KitIssueSnapshot = { number: 39, labels: ["fabrik:token-rotation"], body: "Rotate it.", comments: [] };
    const plan = planFor(
      onSecond(),
      snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] }), { kitIssues: [firstDead] }),
      TWO_SUBSCRIPTIONS,
    );

    expect(plan).toMatchObject({
      kind: "act",
      actions: [
        {},
        {
          kind: "comment",
          issue: 7,
          body: expect.stringMatching(
            /^The Triage run on #7 failed: the Claude token of the `Claude token 2` Subscription was refused \(`authentication_failed`\), so its `Claude token 2` vault item may need rotating\./,
          ),
        },
        {},
      ],
    });
  });

  it("names the Subscription on an open rotation issue it @-mentions on, and on a later quiet comment", () => {
    const ahead: KitIssueSnapshot = {
      number: 40,
      labels: ["fabrik:token-rotation"],
      body: "Rotating soon.\n<!-- fabrik:subscription Claude token 2 -->",
      comments: [],
    };

    const first = planFor(onSecond(7), snapshotOf(anIssue({ number: 7 }), { kitIssues: [ahead] }), TWO_SUBSCRIPTIONS);
    const mention = first.kind === "act" ? first.actions.find((action) => action.kind === "comment" && action.issue === 40) : undefined;
    expect(mention).toMatchObject({ body: expect.stringMatching(/^@operator The Claude token of the `Claude token 2` Subscription was refused/) });

    const after = { ...ahead, comments: [mention?.kind === "comment" ? mention.body : ""] };
    const later = planFor(onSecond(8), snapshotOf(anIssue({ number: 8 }), { kitIssues: [after] }), TWO_SUBSCRIPTIONS);
    expect(later).toMatchObject({
      kind: "act",
      actions: [{}, {}, { kind: "comment", issue: 40, body: `The Triage run on #8 was refused too, on the \`Claude token 2\` Subscription. [The run](${RUN})` }],
    });
  });

  it("reads a failed run that names no Subscription as the first listed one's", () => {
    const plan = planFor(deadToken(), snapshotOf(anIssue({ number: 7 })), TWO_SUBSCRIPTIONS);

    expect(kitIssueOpenedBy(plan, 40).body).toContain("in the `Claude token` item in the Fabrik 1Password vault.");
    expect(plan).toMatchObject({ kind: "act", actions: [{}, {}, { title: "Rotate the Claude token of the `Claude token` Subscription" }] });
  });

  it("with one Subscription listed, names its vault item in the step and keeps the V1 wording elsewhere", () => {
    const plan = planFor(
      { ...deadToken(), subscription: "Work token" },
      snapshotOf(anIssue({ number: 7 })),
      kitConfig({ subscriptions: ["Work token"] }),
    );

    expect(plan).toMatchObject({ kind: "act", actions: [{}, {}, { title: "Rotate the Claude token" }] });
    expect(kitIssueOpenedBy(plan, 40).body).toContain("in the `Work token` item in the Fabrik 1Password vault.");
  });
});

describe("Each failure event yields at most one notification mechanism", () => {
  const kinds = ["crash", "missing-output", "provider-error", "dead-token", "weekly-limit", "metered-billing"] as const;
  const event = (failure: (typeof kinds)[number]): LoopEvent => ({
    kind: "agent-run-failed",
    role: "implement",
    issue: 7,
    runUrl: RUN,
    jobResult: "failure",
    secretsStep: "success",
    report: { failure, detail: "", ...(failure === "weekly-limit" ? { resetsAt: "2026-11-09T04:00:00.000Z" } : {}) },
  });
  const ticket = anIssue({ number: 7, openPullRequests: [12] });
  const buzzedBefore = (failure: (typeof kinds)[number]): KitIssueSnapshot[] => {
    const first = planFor(event(failure), snapshotOf(ticket), kitConfig());
    return first.kind === "act" && first.actions.some((action) => action.kind === "open-issue")
      ? [kitIssueOpenedBy(first, 40)]
      : [];
  };

  it.each(kinds)("a %s with no Kit-owned issue open buzzes the Operator exactly once", (failure) => {
    expect(notificationsOf(planFor(event(failure), snapshotOf(ticket), kitConfig()))).toHaveLength(1);
  });

  it.each(kinds)("a %s after the Operator was already buzzed about it repo-wide buzzes at most per Ticket", (failure) => {
    const plan = planFor(event(failure), snapshotOf(ticket, { kitIssues: buzzedBefore(failure) }), kitConfig());

    // A repo-wide failure stays quiet; any other still gets its one Ticket @-mention.
    const repoWide = failure === "dead-token" || failure === "weekly-limit";
    expect(notificationsOf(plan)).toHaveLength(repoWide ? 0 : 1);
  });
});

const RESETS_AT = "2026-11-09T04:00:00.000Z";

function weeklyLimit(issue = 7, resetsAt: string | null = RESETS_AT): LoopEvent {
  return {
    kind: "agent-run-failed",
    role: "implement",
    issue,
    runUrl: RUN,
    jobResult: "failure",
    secretsStep: "success",
    report: {
      failure: "weekly-limit",
      detail: resetsAt === null ? "" : `resets at ${resetsAt}`,
      ...(resetsAt === null ? {} : { resetsAt }),
    },
  };
}

describe("The weekly-limit issue", () => {
  it("the first run to hit the weekly limit opens an issue saying when it resets, @-mentioning the Operator", () => {
    const plan = planFor(weeklyLimit(), snapshotOf(anIssue({ number: 7 })), kitConfig());

    expect(notificationsOf(plan)).toEqual(['mention in new "The weekly usage limit is reached until 2026-11-09 04:00 UTC"']);
    expect(plan).toMatchObject({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "agent:implement" },
        {
          kind: "comment",
          issue: 7,
          body: expect.stringMatching(/^<!-- fabrik:implement-run-failed -->\nThe Implement run on #7 failed: it hit the weekly usage limit\./),
        },
        {
          kind: "open-issue",
          title: "The weekly usage limit is reached until 2026-11-09 04:00 UTC",
          body: expect.stringMatching(/^@operator The Implement run on #7 hit the weekly usage limit\. It resets at 2026-11-09 04:00 UTC\./),
          labels: ["fabrik:weekly-limit"],
          assignees: [],
        },
      ],
    });
  });

  it.each([
    ["is known", RESETS_AT, "- [ ] Wait for the limit to reset at 2026-11-09 04:00 UTC."],
    ["isn't known", null, "- [ ] Wait until agent runs work again: when the limit resets isn't known."],
  ])("writes the Operator's steps as a task list when the reset time %s", (_, resetsAt, wait) => {
    const issue = kitIssueOpenedBy(planFor(weeklyLimit(7, resetsAt), snapshotOf(anIssue({ number: 7 })), kitConfig()), 41);

    expect(issue.body).toContain(`\n## Steps\n\n${wait}\n- [ ] Re-add the trigger label named in each stalled Ticket's failure comment`);
    expect(issue.body).toContain("Run `/fabrik-pair` on this issue to work through these steps with an agent.");
  });

  it("a later stall in the same window comments quietly on the open issue", () => {
    const first = planFor(weeklyLimit(7), snapshotOf(anIssue({ number: 7 })), kitConfig());
    const limit = kitIssueOpenedBy(first, 41);

    const plan = planFor(weeklyLimit(8), snapshotOf(anIssue({ number: 8 }), { kitIssues: [limit] }), kitConfig());

    expect(notificationsOf(plan)).toEqual([]);
    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 8, label: "agent:implement" },
        { kind: "comment", issue: 8, body: expect.stringContaining("The Kit is tracking this in #41.") },
        { kind: "comment", issue: 41, body: `The Implement run on #8 stalled on the limit too. [The run](${RUN})` },
      ],
    });
  });

  const tick = (now: string): LoopEvent => ({ kind: "scheduled-tick", now });
  const openLimitIssue = (resetsAt: string | null = RESETS_AT) =>
    kitIssueOpenedBy(planFor(weeklyLimit(7, resetsAt), snapshotOf(anIssue({ number: 7 })), kitConfig()), 41);

  it("a scheduled tick after the reset closes the issue, quietly, and restarts no Ticket", () => {
    const plan = planFor(tick("2026-11-09T04:05:00.000Z"), tickSnapshot({ kitIssues: [openLimitIssue()] }), kitConfig());

    expect(notificationsOf(plan)).toEqual([]);
    expect(withoutNotes(plan)).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 41,
          body: "The weekly usage limit reset at 2026-11-09 04:00 UTC, so the Kit is closing this issue. Stalled Tickets stay stalled until their trigger label is re-added.",
        },
        { kind: "close", issue: 41, reason: "completed" },
        { kind: "check-dispatch" },
        { kind: "check-design-queue" },
      ],
    });
  });

  it("a scheduled tick before the reset leaves the issue open, and only asks for its Dispatch and Design queue checks", () => {
    const plan = planFor(tick("2026-11-09T03:55:00.000Z"), tickSnapshot({ kitIssues: [openLimitIssue()] }), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }],
      notes: expect.arrayContaining(["The weekly limit in #41 resets at 2026-11-09 04:00 UTC"]),
    });
  });

  it("a hit in a new window, before the tick has closed the last window's issue, closes it and opens a fresh one", () => {
    const next = "2026-11-16T04:00:00.000Z";

    const plan = planFor(weeklyLimit(8, next), snapshotOf(anIssue({ number: 8 }), { kitIssues: [openLimitIssue()] }), kitConfig());

    expect(notificationsOf(plan)).toEqual(['mention in new "The weekly usage limit is reached until 2026-11-16 04:00 UTC"']);
    if (plan.kind !== "act") throw new Error("expected a plan that acts");
    expect(plan.actions.slice(2)).toEqual([
      { kind: "close", issue: 41, reason: "completed" },
      expect.objectContaining({ kind: "open-issue", title: "The weekly usage limit is reached until 2026-11-16 04:00 UTC" }),
    ]);
  });

  it("Intake leaves the weekly-limit issue alone when the Kit opens it, so Triage never sorts it", () => {
    const limit = openLimitIssue();
    const opened = anIssue({ number: 41, author: "fabrik-app[bot]", labels: limit.labels });

    const plan = planFor({ kind: "issue-opened", issue: 41 }, snapshotOf(opened), kitConfig());

    expect(plan).toMatchObject({ kind: "nothing" });
  });

  it("a scheduled tick with no weekly-limit issue open only asks for its Dispatch and Design queue checks", () => {
    expect(withoutNotes(planFor(tick("2026-11-09T04:05:00.000Z"), tickSnapshot(), kitConfig()))).toEqual({
      kind: "act",
      actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }],
    });
  });
});
