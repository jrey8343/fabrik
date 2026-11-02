import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, notificationsOf, repoSnapshot, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { KitIssueSnapshot, LoopEvent, Plan } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

/** The issue a plan opened, as the adapter would later read it back once GitHub gave it this number. */
function kitIssueOpenedBy(plan: Plan, number: number, comments: readonly string[] = []): KitIssueSnapshot {
  const opened = plan.kind === "act" ? plan.actions.find((action) => action.kind === "open-issue") : undefined;
  if (opened === undefined) throw new Error("expected the plan to open an issue");
  return { number, labels: opened.labels, body: opened.body, comments };
}

function deadToken(issue = 7): LoopEvent {
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
          body: expect.stringMatching(/^The Implement run on #7 failed: it hit the weekly usage limit\./),
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
    const plan = planFor(tick("2026-11-09T04:05:00.000Z"), repoSnapshot({ kitIssues: [openLimitIssue()] }), kitConfig());

    expect(notificationsOf(plan)).toEqual([]);
    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 41,
          body: "The weekly usage limit reset at 2026-11-09 04:00 UTC, so the Kit is closing this issue. Stalled Tickets stay stalled until their trigger label is re-added.",
        },
        { kind: "close", issue: 41, reason: "completed" },
      ],
    });
  });

  it("a scheduled tick before the reset does nothing", () => {
    const plan = planFor(tick("2026-11-09T03:55:00.000Z"), repoSnapshot({ kitIssues: [openLimitIssue()] }), kitConfig());

    expect(plan).toMatchObject({ kind: "nothing" });
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

  it("a scheduled tick with no weekly-limit issue open does nothing", () => {
    expect(planFor(tick("2026-11-09T04:05:00.000Z"), repoSnapshot(), kitConfig())).toMatchObject({ kind: "nothing" });
  });
});
