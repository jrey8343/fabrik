import { describe, expect, it } from "vitest";
import {
  aDesignQueueIssue,
  anIssue,
  designQueueSnapshotOf,
  kitConfig,
  notificationsOf,
  HEAD_SHA,
  repoSnapshot,
  snapshotOf,
  tickSnapshot,
} from "../__fixtures__/snapshots.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { planFor } from "./rules.ts";

const check = { kind: "design-queue-check" } as const;

describe("A Design queue check", () => {
  it("starts a Design turn on a waiting issue when a slot is free", () => {
    const plan = planFor(check, designQueueSnapshotOf([aDesignQueueIssue({ number: 12 })]), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "add-labels", issue: 12, labels: ["agent:design"] }],
    });
  });
});

describe("The caps.design_sessions cap", () => {
  const holding = [aDesignQueueIssue({ number: 3, designRounds: 1 }), aDesignQueueIssue({ number: 4, designRounds: 2 })];

  it("holds every waiting issue when the cap is full, naming the cap, the slot holders and who waits", () => {
    const plan = planFor(
      check,
      designQueueSnapshotOf([...holding, aDesignQueueIssue({ number: 5 }), aDesignQueueIssue({ number: 6 })]),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "nothing",
      reason: "caps.design_sessions is 2 and #3 and #4 hold slots, so #5 and #6 wait",
    });
  });

  it("starts only as many as there are free slots", () => {
    const plan = planFor(
      check,
      designQueueSnapshotOf([holding[0]!, aDesignQueueIssue({ number: 5 }), aDesignQueueIssue({ number: 6 })]),
      kitConfig(),
    );

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "add-labels", issue: 5, labels: ["agent:design"] }] });
  });

  it("honours a lowered cap", () => {
    const plan = planFor(
      check,
      designQueueSnapshotOf([holding[0]!, aDesignQueueIssue({ number: 5 })]),
      kitConfig({ caps: { ...DEFAULT_KIT_CONFIG.caps, designSessions: 1 } }),
    );

    expect(plan).toEqual({
      kind: "nothing",
      reason: "caps.design_sessions is 1 and #3 holds a slot, so #5 waits",
    });
  });

  it("starts nothing at a cap of 0, saying so, and leaves sessions holding slots to carry on", () => {
    const plan = planFor(
      check,
      designQueueSnapshotOf([holding[0]!, aDesignQueueIssue({ number: 5 })]),
      kitConfig({ caps: { ...DEFAULT_KIT_CONFIG.caps, designSessions: 0 } }),
    );

    expect(plan).toEqual({
      kind: "nothing",
      reason: "New Design sessions are paused because caps.design_sessions is 0, so #5 waits; #3 holds a slot and carries on",
    });
  });

  it("says so when nothing waits", () => {
    const plan = planFor(check, designQueueSnapshotOf(holding), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "No needs-design issue is waiting for a Design session slot" });
  });
});

describe("Design queue order", () => {
  it("starts waiting issues oldest first, by when they got needs-design", () => {
    const plan = planFor(
      check,
      designQueueSnapshotOf([
        aDesignQueueIssue({ number: 4, neededDesignAt: "2026-11-03T09:00:00Z" }),
        aDesignQueueIssue({ number: 9, neededDesignAt: "2026-11-01T09:00:00Z" }),
        aDesignQueueIssue({ number: 6, neededDesignAt: "2026-11-02T09:00:00Z" }),
      ]),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "add-labels", issue: 9, labels: ["agent:design"] },
        { kind: "add-labels", issue: 6, labels: ["agent:design"] },
      ],
    });
  });

  it("breaks a tie by issue number", () => {
    const at = "2026-11-01T09:00:00Z";
    const plan = planFor(
      check,
      designQueueSnapshotOf([
        aDesignQueueIssue({ number: 8, neededDesignAt: at }),
        aDesignQueueIssue({ number: 3, designRounds: 1 }),
        aDesignQueueIssue({ number: 5, neededDesignAt: at }),
      ]),
      kitConfig(),
    );

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "add-labels", issue: 5, labels: ["agent:design"] }] });
  });

  it("names waiting issues in the order they would start", () => {
    const plan = planFor(
      check,
      designQueueSnapshotOf([
        aDesignQueueIssue({ number: 3, designRounds: 1 }),
        aDesignQueueIssue({ number: 4, designRounds: 1 }),
        aDesignQueueIssue({ number: 7, neededDesignAt: "2026-11-03T09:00:00Z" }),
        aDesignQueueIssue({ number: 8, neededDesignAt: "2026-11-02T09:00:00Z" }),
      ]),
      kitConfig(),
    );

    expect(plan).toEqual({ kind: "nothing", reason: "caps.design_sessions is 2 and #3 and #4 hold slots, so #8 and #7 wait" });
  });
});

describe("Re-designs first", () => {
  it("starts a re-design before an older new issue", () => {
    const plan = planFor(
      check,
      designQueueSnapshotOf([
        aDesignQueueIssue({ number: 3, designRounds: 1 }),
        aDesignQueueIssue({ number: 4, neededDesignAt: "2026-11-01T09:00:00Z" }),
        aDesignQueueIssue({ number: 9, neededDesignAt: "2026-11-03T09:00:00Z", redesign: true }),
      ]),
      kitConfig(),
    );

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "add-labels", issue: 9, labels: ["agent:design"] }] });
  });

  it("starts re-designs oldest first among themselves, the issue number breaking ties, and then the rest oldest first", () => {
    const at = "2026-11-02T09:00:00Z";
    const plan = planFor(
      check,
      designQueueSnapshotOf([
        aDesignQueueIssue({ number: 2, neededDesignAt: "2026-10-01T09:00:00Z" }),
        aDesignQueueIssue({ number: 8, neededDesignAt: at, redesign: true }),
        aDesignQueueIssue({ number: 11, neededDesignAt: "2026-11-01T09:00:00Z", redesign: true }),
        aDesignQueueIssue({ number: 5, neededDesignAt: at, redesign: true }),
        aDesignQueueIssue({ number: 1, neededDesignAt: "2026-10-02T09:00:00Z" }),
      ]),
      kitConfig({ caps: { ...DEFAULT_KIT_CONFIG.caps, designSessions: 0 } }),
    );

    expect(plan).toEqual({
      kind: "nothing",
      reason: "New Design sessions are paused because caps.design_sessions is 0, so #11, #5, #8, #2 and #1 wait",
    });
  });

  it("holds a re-design silently when the cap is full: no comment, label or mention", () => {
    const plan = planFor(
      check,
      designQueueSnapshotOf([
        aDesignQueueIssue({ number: 3, designRounds: 1 }),
        aDesignQueueIssue({ number: 4, designRounds: 1 }),
        aDesignQueueIssue({ number: 9, redesign: true }),
      ]),
      kitConfig(),
    );

    expect(plan).toEqual({ kind: "nothing", reason: "caps.design_sessions is 2 and #3 and #4 hold slots, so #9 waits" });
    expect(notificationsOf(plan)).toEqual([]);
  });
});

describe("Which sessions hold a slot", () => {
  it.each([
    ["has had a round posted", { designRounds: 1 }, {}],
    ["has a Design turn in progress", {}, { designTurnsInProgress: [3] }],
    ["has had a Design turn fail", { turnFailed: true }, {}],
    ["has agent:design, so its first turn is about to start", { labels: ["needs-design", "agent:design"] }, {}],
  ])("counts an issue that %s as holding a slot", (_, issue, inProgress) => {
    const plan = planFor(
      check,
      designQueueSnapshotOf([aDesignQueueIssue({ number: 3, ...issue }), aDesignQueueIssue({ number: 5 })], inProgress),
      kitConfig({ caps: { ...DEFAULT_KIT_CONFIG.caps, designSessions: 1 } }),
    );

    expect(plan).toEqual({ kind: "nothing", reason: "caps.design_sessions is 1 and #3 holds a slot, so #5 waits" });
  });

  it("counts a turn in progress on an issue that already has a round only once", () => {
    const plan = planFor(
      check,
      designQueueSnapshotOf(
        [aDesignQueueIssue({ number: 3, designRounds: 1 }), aDesignQueueIssue({ number: 5 })],
        { designTurnsInProgress: [3] },
      ),
      kitConfig(),
    );

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "add-labels", issue: 5, labels: ["agent:design"] }] });
  });
});

describe("A held issue", () => {
  it("gets no comment, label or mention, and the issue it starts gets only agent:design", () => {
    const issues = [
      aDesignQueueIssue({ number: 3, designRounds: 1 }),
      aDesignQueueIssue({ number: 5, neededDesignAt: "2026-11-01T09:00:00Z" }),
      aDesignQueueIssue({ number: 6, neededDesignAt: "2026-11-02T09:00:00Z" }),
    ];
    const plan = planFor(check, designQueueSnapshotOf(issues), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "add-labels", issue: 5, labels: ["agent:design"] }] });
    expect(notificationsOf(plan)).toEqual([]);
  });
});

describe("A waiting issue's live Design session", () => {
  it("still lands its live outcome: the Operator's own move is never refused", () => {
    const waiting = anIssue({ number: 7, labels: ["enhancement", "needs-design"], designRounds: 0 });
    const outcome = {
      kind: "issue-comment-created",
      issue: 7,
      commenter: "operator",
      commenterIsBot: false,
      body: "<!-- fabrik:live-outcome brief -->\n**Design session finished live.** This issue is now its agent brief.",
      comment: 9001,
    } as const;

    expect(planFor(outcome, snapshotOf(waiting), kitConfig())).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "needs-design" },
        { kind: "add-labels", issue: 7, labels: ["ready-for-agent"] },
        { kind: "check-dispatch" },
        { kind: "check-design-queue" },
      ],
    });
  });
});

describe("agent:design", () => {
  const { model, effort, timeoutMinutes } = kitConfig().roles.design;
  const added = { kind: "label-added", issue: 7, label: "agent:design" } as const;

  it("starts the Design session's first turn, and comes off as it starts", () => {
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design", "agent:design"] });

    expect(planFor(added, snapshotOf(issue), kitConfig())).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "agent:design" },
        { kind: "start-agent-run", role: "design", issue: 7, model, effort, timeoutMinutes, subscription: "Claude token" },
      ],
    });
  });

  it.each([
    ["is closed", { open: false }],
    ["no longer has needs-design", { labels: ["ready-for-agent", "agent:design"] }],
  ])("only comes off an issue that %s", (_, overrides) => {
    const issue = anIssue({ number: 7, labels: ["needs-design", "agent:design"], ...overrides });

    expect(planFor(added, snapshotOf(issue), kitConfig())).toEqual({
      kind: "act",
      actions: [{ kind: "remove-label", issue: 7, label: "agent:design" }],
    });
  });
});

describe("What triggers a Design queue check", () => {
  it("adding needs-design asks for a queue check instead of starting a turn, and adds nothing to the issue", () => {
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design"] });
    const plan = planFor({ kind: "label-added", issue: 7, label: "needs-design" }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "check-design-queue" }] });
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("an issue closing, which may end a Design session by hand", () => {
    const issue = anIssue({ number: 7, open: false, labels: ["enhancement", "needs-design"] });

    const plan = planFor({ kind: "issue-closed", issue: 7 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }] });
  });

  it("a change to the Kit config, since caps.design_sessions may have gone up", () => {
    const plan = planFor({ kind: "kit-config-changed", head: HEAD_SHA }, repoSnapshot({ conflicts: { main: HEAD_SHA, now: "2026-01-01T00:00:00Z", pullRequests: [] } }), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }] });
  });

  it("the hourly scheduled tick, which catches a slot freed by needs-design coming off by hand", () => {
    const plan = planFor({ kind: "scheduled-tick", now: "2026-11-09T04:05:00.000Z" }, tickSnapshot(), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "check-design-queue" }] });
  });
});
