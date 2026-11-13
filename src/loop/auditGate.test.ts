import { describe, expect, it } from "vitest";
import {
  anAuditIssue,
  anIssue,
  auditBody,
  AUDITED_SHA,
  kitConfig,
  notificationsOf,
  snapshotOf,
  tickSnapshot,
  withoutNotes,
} from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, AuditIssueSnapshot, KitConfig, KitIssueSnapshot, Plan } from "./types.ts";

/** The default branch's head on these ticks. */
const HEAD = "c0ffee5".padEnd(40, "0");

/** Sunday 2026-11-08 04:00 UTC: on the default audit.day, in the week of Monday 2026-11-02. */
const SUNDAY = "2026-11-08T04:00:00.000Z";

/** The scheduled tick's plan, with this default branch head, these `fabrik:audit` issues and these open Kit-owned issues. */
function tick(
  now: string,
  {
    head = HEAD,
    issues = [],
    kitIssues = [],
  }: { head?: string | null; issues?: readonly AuditIssueSnapshot[]; kitIssues?: readonly KitIssueSnapshot[] } = {},
  config: KitConfig = kitConfig(),
): Plan {
  return withoutNotes(planFor({ kind: "scheduled-tick", now }, tickSnapshot({ kitIssues, audit: { head, issues } }), config));
}

/** A tick that opens no Audit and closes or posts nothing: it only asks for the Design queue check every tick ends with. */
const OPENS_NOTHING: Plan = { kind: "act", actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }] };

/** The Kit's open weekly-limit issue, for a limit that resets at `resetsAt`. */
function weeklyLimitIssue(resetsAt: string): KitIssueSnapshot {
  return {
    number: 41,
    labels: ["fabrik:weekly-limit"],
    body: `@operator The Triage run on #7 hit the weekly usage limit.\n\n<!-- fabrik:notified -->\n<!-- fabrik:resets-at ${resetsAt} -->`,
    comments: [],
  };
}

/** The issues a plan opens. */
function opened(plan: Plan): Extract<Action, { kind: "open-issue" }>[] {
  return plan.kind === "act" ? plan.actions.filter((action) => action.kind === "open-issue") : [];
}

describe("The audit gate opens a pending Audit", () => {
  it("for the default branch's head on a repo's first Audit, quietly and with no state label", () => {
    const plan = tick(SUNDAY);

    expect(opened(plan)).toEqual([
      {
        kind: "open-issue",
        title: "Audit: week of 2026-11-02",
        body: [
          "The Auditor is reading the default branch up to `c0ffee5`, and this issue fills in when it's done.",
          "",
          `<!-- fabrik:audit ${HEAD} -->`,
          "<!-- fabrik:audit-pending -->",
        ].join("\n"),
        labels: ["fabrik:audit"],
        assignees: [],
      },
    ]);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("on the next tick after this week's Audit failed, as a retry", () => {
    const failed = anAuditIssue({
      number: 95,
      createdAt: "2026-11-08T00:05:00Z",
      stateReason: "not_planned",
      body: auditBody(HEAD, "failed"),
    });

    const plan = tick("2026-11-08T01:05:00.000Z", { issues: [anAuditIssue(), failed] });

    expect(opened(plan)).toEqual([
      expect.objectContaining({ title: "Audit: week of 2026-11-02", body: expect.stringContaining(`<!-- fabrik:audit ${HEAD} -->`) }),
    ]);
  });

  it("when only a failed Audit read the head: a failed Audit is never the last Audit", () => {
    const failedLastWeek = anAuditIssue({
      number: 91,
      createdAt: "2026-11-01T01:05:00Z",
      stateReason: "not_planned",
      body: auditBody(HEAD, "failed"),
    });

    const plan = tick(SUNDAY, { issues: [anAuditIssue({ number: 90 }), failedLastWeek] });

    expect(opened(plan)).toHaveLength(1);
  });

  it("comparing the head with the newest Audit's commit, however the issues come", () => {
    const newest = anAuditIssue({ number: 90, createdAt: "2026-11-01T00:05:00Z", body: auditBody(HEAD) });
    const older = anAuditIssue({ number: 80, createdAt: "2026-10-25T00:05:00Z", body: auditBody(AUDITED_SHA) });

    expect(tick(SUNDAY, { issues: [newest, older] })).toEqual(OPENS_NOTHING);
    expect(tick(SUNDAY, { issues: [older, newest] })).toEqual(OPENS_NOTHING);
  });

  it("ignoring a fabrik:audit issue a person opened, which neither stops the tick's Audit nor stands in for one", () => {
    const person = anAuditIssue({
      number: 97,
      byApp: false,
      open: true,
      stateReason: null,
      createdAt: "2026-11-08T00:05:00Z",
      body: auditBody(HEAD, "pending"),
    });

    expect(opened(tick(SUNDAY, { issues: [person] }))).toHaveLength(1);
  });
});

describe("The audit gate opens nothing", () => {
  it("when audit.day is null, which turns the Audit off, so the tick does only what it did before the Auditor", () => {
    expect(tick(SUNDAY, {}, kitConfig({ audit: { day: null } }))).toEqual(OPENS_NOTHING);
  });

  it("before 00:00 UTC on audit.day this week", () => {
    expect(tick("2026-11-07T23:59:00.000Z")).toEqual(OPENS_NOTHING);
  });

  it("when an Audit already ran this week, even one the Operator has closed and with the branch moved on since", () => {
    const thisWeek = anAuditIssue({ number: 95, createdAt: "2026-11-08T00:05:00Z" });

    expect(tick(SUNDAY, { issues: [anAuditIssue(), thisWeek] })).toEqual(OPENS_NOTHING);
  });

  it.each([
    ["still pending on its run", auditBody(AUDITED_SHA, "pending")],
    ["filled and not yet closed by the Operator", auditBody(AUDITED_SHA, "filled")],
  ])("when last week's Audit is open, %s", (_, body) => {
    expect(tick(SUNDAY, { issues: [anAuditIssue({ number: 90, open: true, stateReason: null, body })] })).toEqual(OPENS_NOTHING);
  });

  it("while the one Subscription's weekly-limit issue is open, since the Auditor's run would stall on the limit, noting the wait on it", () => {
    const plan = tick(SUNDAY, { kitIssues: [weeklyLimitIssue("2026-11-09T04:00:00.000Z")] });

    expect(opened(plan)).toEqual([]);
    expect(plan.kind === "act" ? plan.actions.filter((action) => action.kind === "comment") : []).toEqual([
      { kind: "comment", issue: 41, body: "This week's Audit waits for a free Subscription.\n\n<!-- fabrik:weekly-run-waiting audit 2026-11-02 -->" },
    ]);
  });

  it("when two Audits have already failed this week, until next week", () => {
    const failed = (number: number, createdAt: string) =>
      anAuditIssue({ number, createdAt, stateReason: "not_planned", body: auditBody(HEAD, "failed") });

    const plan = tick("2026-11-08T05:05:00.000Z", {
      issues: [anAuditIssue(), failed(95, "2026-11-08T00:05:00Z"), failed(96, "2026-11-08T01:05:00Z")],
    });

    expect(plan).toEqual(OPENS_NOTHING);
  });

  it("when the default branch has no commits yet", () => {
    expect(tick(SUNDAY, { head: null })).toEqual(OPENS_NOTHING);
  });

  it("when the default branch hasn't moved since the last Audit's commit", () => {
    const older = anAuditIssue({ number: 80, createdAt: "2026-10-25T00:05:00Z", body: auditBody("d".repeat(40)) });

    const plan = tick(SUNDAY, { head: AUDITED_SHA, issues: [older, anAuditIssue({ number: 90 })] });

    expect(plan).toEqual(OPENS_NOTHING);
  });
});

describe("The audit gate's week, Monday to Monday in UTC", () => {
  it.each([
    ["monday", "2026-11-02T00:00:00.000Z"],
    ["wednesday", "2026-11-04T09:00:00.000Z"],
    ["sunday", "2026-11-08T00:00:00.000Z"],
  ] as const)("opens on %s from that day's 00:00 UTC", (day, now) => {
    expect(opened(tick(now, {}, kitConfig({ audit: { day } })))).toHaveLength(1);
  });

  it("waits for 00:00 UTC, whatever offset the tick's time is written in", () => {
    // 2026-11-07 22:30 UTC, a Saturday, though it's Sunday in UTC+11.
    expect(tick("2026-11-08T09:30:00+11:00")).toEqual(OPENS_NOTHING);
  });

  it("starts the week at Monday 00:00 UTC: an Audit opened late on Sunday was last week's", () => {
    const lateSunday = anAuditIssue({ number: 95, createdAt: "2026-11-08T23:50:00Z" });

    const plan = tick("2026-11-09T00:30:00.000Z", { issues: [lateSunday] }, kitConfig({ audit: { day: "monday" } }));

    expect(opened(plan)).toEqual([expect.objectContaining({ title: "Audit: week of 2026-11-09" })]);
  });

  it("counts an Audit opened at Monday 00:00 UTC as this week's", () => {
    expect(tick(SUNDAY, { issues: [anAuditIssue({ number: 95, createdAt: "2026-11-02T00:00:00Z" })] })).toEqual(OPENS_NOTHING);
  });

  it("still opens later in the week, when the day's ticks opened nothing", () => {
    expect(opened(tick("2026-11-06T15:00:00.000Z", {}, kitConfig({ audit: { day: "wednesday" } })))).toHaveLength(1);
  });
});

describe("The tick's other rules", () => {
  it("still close the weekly-limit issue after its reset, alongside opening the Audit the limit held back, then ask for a Design queue check", () => {
    const plan = tick(SUNDAY, { kitIssues: [weeklyLimitIssue("2026-11-08T03:00:00.000Z")] });

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "comment", issue: 41, body: expect.stringMatching(/^The weekly usage limit reset at 2026-11-08 03:00 UTC/) },
        { kind: "close", issue: 41, reason: "completed" },
        expect.objectContaining({ kind: "open-issue", title: "Audit: week of 2026-11-02", labels: ["fabrik:audit"], assignees: [] }),
        { kind: "check-dispatch" },
        { kind: "check-design-queue" },
      ],
    });
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("still close the weekly-limit issue when no Audit is due", () => {
    const plan = tick("2026-11-07T04:00:00.000Z", { kitIssues: [weeklyLimitIssue("2026-11-07T03:00:00.000Z")] });

    expect(plan).toEqual({
      kind: "act",
      actions: [expect.objectContaining({ kind: "comment", issue: 41 }), { kind: "close", issue: 41, reason: "completed" }, { kind: "check-dispatch" }, { kind: "check-design-queue" }],
    });
  });
});

describe("Why a tick's gate opens nothing", () => {
  it("reaches the step summary's notes even when another part of the tick acts, as the weekly-limit close does here", () => {
    const snapshot = tickSnapshot({ kitIssues: [weeklyLimitIssue("2026-11-08T03:00:00.000Z")], audit: { head: HEAD, issues: [] } });
    const plan = planFor({ kind: "scheduled-tick", now: SUNDAY }, snapshot, kitConfig({ audit: { day: null } }));

    expect(plan.kind === "act" && plan.actions.some((action) => action.kind === "close" && action.issue === 41)).toBe(true);
    expect(plan.kind === "act" ? plan.notes : []).toContain("The Audit is off: audit.day is null");
  });

  it("reaches the step summary's notes when nothing else in the tick acts either", () => {
    const plan = planFor({ kind: "scheduled-tick", now: SUNDAY }, tickSnapshot({ audit: { head: HEAD, issues: [] } }), kitConfig({ audit: { day: null }, retro: { day: null } }));

    expect(plan.kind === "act" ? plan.notes : []).toEqual(expect.arrayContaining(["The Audit is off: audit.day is null", "The Retro is off: retro.day is null"]));
  });
});

describe("A tick's snapshot without the audit slice", () => {
  it("fails rather than guess, and changes nothing", () => {
    const plan = planFor({ kind: "scheduled-tick", now: SUNDAY }, tickSnapshot({ audit: null }), kitConfig());

    expect(plan).toEqual({ kind: "fail", failure: "infrastructure", reason: expect.stringContaining("audit") });
  });
});

describe("The pending Audit's issue", () => {
  it("starts the Auditor's run once the App has opened it, rather than going through Intake to Triage", () => {
    const pending = opened(tick(SUNDAY))[0];
    const issue = anIssue({ number: 98, author: "fabrik-app", byApp: true, labels: pending?.labels ?? [], body: pending?.body ?? "" });

    const plan = planFor({ kind: "issue-opened", issue: 98 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [expect.objectContaining({ kind: "start-agent-run", role: "audit", issue: 98 })] });
  });
});
