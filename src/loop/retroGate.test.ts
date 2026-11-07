import { describe, expect, it } from "vitest";
import {
  anAuditIssue,
  anIssue,
  aRetroIssue,
  AUDITED_SHA,
  kitConfig,
  notificationsOf,
  retroBody,
  RETRO_WINDOW_END,
  snapshotOf,
  tickSnapshot,
} from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, AuditSnapshot, KitConfig, KitIssueSnapshot, Plan, RetroIssueSnapshot } from "./types.ts";

/** Saturday 2026-11-07 04:00 UTC: on the default retro.day, in the week of Monday 2026-11-02. */
const SATURDAY = "2026-11-07T04:00:00.000Z";

/**
 * An audit slice whose default branch hasn't moved since last week's Audit,
 * so the audit gate the tick also runs opens nothing, whatever the day.
 */
const AUDITED: AuditSnapshot = { head: AUDITED_SHA, issues: [anAuditIssue()] };

/**
 * The scheduled tick's plan, with these `fabrik:retro` issues and these open
 * Kit-owned issues, in a repo whose store is ready and where, by default, an
 * agent PR merged or closed since the last Retro's window end.
 */
function tick(
  now: string,
  {
    storeReady = true,
    issues = [],
    agentPullRequestClosed = true,
    escapeFiled = false,
    kitIssues = [],
  }: {
    storeReady?: boolean;
    issues?: readonly RetroIssueSnapshot[];
    agentPullRequestClosed?: boolean;
    escapeFiled?: boolean;
    kitIssues?: readonly KitIssueSnapshot[];
  } = {},
  config: KitConfig = kitConfig(),
): Plan {
  const retro = { storeReady, issues, agentPullRequestClosed, escapeFiled };
  return planFor({ kind: "scheduled-tick", now }, tickSnapshot({ kitIssues, audit: AUDITED, retro }), config);
}

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

describe("The retro gate opens a pending Retro", () => {
  it("on a repo's first Retro, reading the 7 days before the tick, quietly and with no state label", () => {
    const plan = tick(SATURDAY);

    expect(opened(plan)).toEqual([
      {
        kind: "open-issue",
        title: "Retro: week of 2026-11-02",
        body: [
          "The Retro is reading the factory's runs since 2026-10-31 04:00 UTC, and this issue fills in when it's done.",
          "",
          "<!-- fabrik:retro 2026-11-07T04:00:00.000Z -->",
          "<!-- fabrik:retro-pending -->",
        ].join("\n"),
        labels: ["fabrik:retro"],
        assignees: [],
      },
    ]);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("reading from where the last Retro's window ended, so nothing falls between two Retros", () => {
    expect(opened(tick(SATURDAY, { issues: [aRetroIssue()] }))).toEqual([
      expect.objectContaining({ body: expect.stringMatching(/^The Retro is reading the factory's runs since 2026-10-31 06:00 UTC,/) }),
    ]);
  });

  it("when only an escape was filed since the last Retro, with no agent PR merged or closed", () => {
    expect(opened(tick(SATURDAY, { issues: [aRetroIssue()], agentPullRequestClosed: false, escapeFiled: true }))).toHaveLength(1);
  });

  it("on the next tick after this week's Retro failed, as a retry reading the same window", () => {
    const failed = aRetroIssue({
      number: 85,
      createdAt: "2026-11-07T00:00:04Z",
      stateReason: "not_planned",
      body: retroBody("2026-11-07T00:00:00.000Z", "failed"),
    });

    const plan = tick("2026-11-07T01:00:00.000Z", { issues: [aRetroIssue(), failed] });

    expect(opened(plan)).toEqual([
      expect.objectContaining({
        title: "Retro: week of 2026-11-02",
        body: expect.stringMatching(/^The Retro is reading the factory's runs since 2026-10-31 06:00 UTC,(.|\n)*<!-- fabrik:retro 2026-11-07T01:00:00.000Z -->/),
      }),
    ]);
  });

  it("reading from the Retro before a failed one: a failed Retro is never the last Retro", () => {
    const failedLastWeek = aRetroIssue({
      number: 81,
      createdAt: "2026-10-31T07:00:04Z",
      stateReason: "not_planned",
      body: retroBody("2026-10-31T07:00:00.000Z", "failed"),
    });

    expect(opened(tick(SATURDAY, { issues: [aRetroIssue(), failedLastWeek] }))).toEqual([
      expect.objectContaining({ body: expect.stringContaining("since 2026-10-31 06:00 UTC,") }),
    ]);
  });

  it("reading from the newest Retro's window end, however the issues come", () => {
    const older = aRetroIssue({ number: 70, createdAt: "2026-10-24T04:00:04Z", body: retroBody("2026-10-24T04:00:00.000Z") });

    for (const issues of [[aRetroIssue(), older], [older, aRetroIssue()]]) {
      expect(opened(tick(SATURDAY, { issues }))).toEqual([expect.objectContaining({ body: expect.stringContaining("since 2026-10-31 06:00 UTC,") })]);
    }
  });

  it("reading from when the last Retro was opened, when its body has lost its retro marker", () => {
    const unmarked = aRetroIssue({ createdAt: "2026-10-31T06:00:04Z", body: "The Retro read the factory's runs." });

    expect(opened(tick(SATURDAY, { issues: [unmarked] }))).toEqual([
      expect.objectContaining({ body: expect.stringContaining("since 2026-10-31 06:00 UTC,") }),
    ]);
  });

  it("ignoring a fabrik:retro issue a person opened, which neither stops the tick's Retro nor stands in for the last one", () => {
    const person = aRetroIssue({
      number: 87,
      byApp: false,
      open: true,
      stateReason: null,
      createdAt: "2026-11-07T00:00:04Z",
      body: retroBody("2026-11-07T00:00:00.000Z", "pending"),
    });

    expect(opened(tick(SATURDAY, { issues: [aRetroIssue(), person] }))).toEqual([
      expect.objectContaining({ body: expect.stringContaining("since 2026-10-31 06:00 UTC,") }),
    ]);
  });
});

/** A tick that opens no Retro and closes or posts nothing: it only asks for the Design queue check every tick ends with. */
const OPENS_NOTHING: Plan = { kind: "act", actions: [{ kind: "check-design-queue" }] };

describe("The retro gate opens nothing", () => {
  it("when retro.day is null, which turns the Retro off", () => {
    expect(tick(SATURDAY, {}, kitConfig({ retro: { day: null } }))).toEqual(OPENS_NOTHING);
  });

  it("before 00:00 UTC on retro.day this week", () => {
    expect(tick("2026-11-06T23:59:00.000Z")).toEqual(OPENS_NOTHING);
  });

  it("when a Retro already ran this week, even one the Operator has closed and with more merged since", () => {
    const thisWeek = aRetroIssue({ number: 85, createdAt: "2026-11-07T00:00:04Z", body: retroBody("2026-11-07T00:00:00.000Z") });

    expect(tick(SATURDAY, { issues: [aRetroIssue(), thisWeek] })).toEqual(OPENS_NOTHING);
  });

  it.each([
    ["still pending on its run", retroBody(RETRO_WINDOW_END, "pending")],
    ["filled and not yet closed by the Operator", retroBody(RETRO_WINDOW_END, "filled")],
  ])("when last week's Retro is open, %s", (_, body) => {
    expect(tick(SATURDAY, { issues: [aRetroIssue({ open: true, stateReason: null, body })] })).toEqual(OPENS_NOTHING);
  });

  it("while the weekly-limit issue is open, since the Retro's run would stall on the limit", () => {
    expect(tick(SATURDAY, { kitIssues: [weeklyLimitIssue("2026-11-09T04:00:00.000Z")] })).toEqual(OPENS_NOTHING);
  });

  it("when two Retros have already failed this week, until next week", () => {
    const failed = (number: number, createdAt: string) =>
      aRetroIssue({ number, createdAt, stateReason: "not_planned", body: retroBody(createdAt, "failed") });

    const plan = tick("2026-11-07T05:05:00.000Z", {
      issues: [aRetroIssue(), failed(85, "2026-11-07T00:00:04Z"), failed(86, "2026-11-07T01:00:04Z")],
    });

    expect(plan).toEqual(OPENS_NOTHING);
  });

  it("while the fabrik-runs store isn't ready, so the Retro never runs blind, and says nothing about it", () => {
    expect(tick(SATURDAY, { storeReady: false })).toEqual(OPENS_NOTHING);
  });

  it("when nothing is new since the last Retro's window end: no agent PR merged or closed, and no escape filed", () => {
    const plan = tick(SATURDAY, { issues: [aRetroIssue()], agentPullRequestClosed: false, escapeFiled: false });

    expect(plan).toEqual(OPENS_NOTHING);
  });
});

describe("The retro gate's week, Monday to Monday in UTC", () => {
  it.each([
    ["monday", "2026-11-02T00:00:00.000Z"],
    ["wednesday", "2026-11-04T09:00:00.000Z"],
    ["sunday", "2026-11-08T00:00:00.000Z"],
  ] as const)("opens on %s from that day's 00:00 UTC", (day, now) => {
    expect(opened(tick(now, {}, kitConfig({ retro: { day } })))).toHaveLength(1);
  });

  it("waits for 00:00 UTC, whatever offset the tick's time is written in", () => {
    // 2026-11-06 22:30 UTC, a Friday, though it's Saturday in UTC+11.
    expect(tick("2026-11-07T09:30:00+11:00")).toEqual(OPENS_NOTHING);
  });

  it("starts the week at Monday 00:00 UTC: a Retro opened late on Sunday was last week's", () => {
    const lateSunday = aRetroIssue({ number: 85, createdAt: "2026-11-08T23:50:04Z", body: retroBody("2026-11-08T23:50:00.000Z") });

    const plan = tick("2026-11-09T00:30:00.000Z", { issues: [lateSunday] }, kitConfig({ retro: { day: "monday" } }));

    expect(opened(plan)).toEqual([expect.objectContaining({ title: "Retro: week of 2026-11-09" })]);
  });

  it("counts a Retro opened at Monday 00:00 UTC as this week's", () => {
    const monday = aRetroIssue({ number: 85, createdAt: "2026-11-02T00:00:00Z", body: retroBody("2026-11-02T00:00:00.000Z") });

    expect(tick(SATURDAY, { issues: [monday] })).toEqual(OPENS_NOTHING);
  });

  it("still opens later in the week, when the day's ticks opened nothing", () => {
    expect(opened(tick("2026-11-06T15:00:00.000Z", {}, kitConfig({ retro: { day: "wednesday" } })))).toHaveLength(1);
  });
});

describe("The pending Retro's window marker", () => {
  it("carries the tick's time, to the millisecond, as the end of the window it reads", () => {
    const [retro] = opened(tick("2026-11-07T13:37:12.345Z"));

    expect(retro?.body.split("\n")).toContain("<!-- fabrik:retro 2026-11-07T13:37:12.345Z -->");
  });

  it("carries it in UTC, whatever offset the tick's time is written in", () => {
    const [retro] = opened(tick("2026-11-08T00:37:12.345+11:00"));

    expect(retro).toEqual(expect.objectContaining({ title: "Retro: week of 2026-11-02" }));
    expect(retro?.body.split("\n")).toContain("<!-- fabrik:retro 2026-11-07T13:37:12.345Z -->");
  });

  it("is where the next week's Retro reads from", () => {
    const [retro] = opened(tick("2026-11-07T13:37:12.345Z"));
    const opener = aRetroIssue({ number: 88, createdAt: "2026-11-07T13:37:15Z", body: retro?.body ?? "" });

    expect(opened(tick("2026-11-14T04:00:00.000Z", { issues: [opener] }))).toEqual([
      expect.objectContaining({ body: expect.stringContaining("since 2026-11-07 13:37 UTC,") }),
    ]);
  });
});

describe("The tick's other rules", () => {
  it("still close the weekly-limit issue after its reset, alongside opening the Retro the limit held back", () => {
    const plan = tick(SATURDAY, { kitIssues: [weeklyLimitIssue("2026-11-07T03:00:00.000Z")] });

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "comment", issue: 41, body: expect.stringMatching(/^The weekly usage limit reset at 2026-11-07 03:00 UTC/) },
        { kind: "close", issue: 41, reason: "completed" },
        expect.objectContaining({ kind: "open-issue", title: "Retro: week of 2026-11-02", labels: ["fabrik:retro"], assignees: [] }),
        { kind: "check-design-queue" },
      ],
    });
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("still close the weekly-limit issue when no Retro is due", () => {
    const plan = tick("2026-11-06T04:00:00.000Z", { kitIssues: [weeklyLimitIssue("2026-11-06T03:00:00.000Z")] });

    expect(plan).toEqual({
      kind: "act",
      actions: [
        expect.objectContaining({ kind: "comment", issue: 41 }),
        { kind: "close", issue: 41, reason: "completed" },
        { kind: "check-design-queue" },
      ],
    });
  });

  it("still open the week's Audit when it's due on the same tick, before the Retro", () => {
    const snapshot = tickSnapshot({
      audit: { head: "c".repeat(40), issues: [] },
      retro: { storeReady: true, issues: [], agentPullRequestClosed: true, escapeFiled: false },
    });

    const plan = planFor({ kind: "scheduled-tick", now: SATURDAY }, snapshot, kitConfig({ audit: { day: "saturday" } }));

    expect(opened(plan).map((issue) => issue.labels)).toEqual([["fabrik:audit"], ["fabrik:retro"]]);
    expect(plan).toMatchObject({ kind: "act", actions: [{ kind: "open-issue" }, { kind: "open-issue" }, { kind: "check-design-queue" }] });
    expect(notificationsOf(plan)).toEqual([]);
  });
});

// Like the Audit's (src/loop/hold.test.ts): with rotation on too, any open
// weekly-limit issue holds the Retro back, so that it never competes with
// Tickets for what's left of the weekly usage limits (US 7).
describe("The Retro due while a Subscription's weekly-limit issue is open, with rotation on", () => {
  const TWO_SUBSCRIPTIONS = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });

  /** An open weekly-limit issue for `subscription`, resetting at `resetsAt`. */
  const limitOf = (number: number, subscription: string, resetsAt = "2026-11-09T04:00:00.000Z"): KitIssueSnapshot => ({
    number,
    labels: ["fabrik:weekly-limit"],
    body: `The weekly usage limit of the \`${subscription}\` Subscription is reached.\n\n<!-- fabrik:subscription ${subscription} -->\n<!-- fabrik:resets-at ${resetsAt} -->`,
    comments: [],
  });

  it("opens nothing while another Subscription is free, waiting for the reset", () => {
    expect(tick(SATURDAY, { kitIssues: [limitOf(41, "Claude token")] }, TWO_SUBSCRIPTIONS)).toEqual(OPENS_NOTHING);
  });

  it("opens nothing while every Subscription is used up", () => {
    const kitIssues = [limitOf(40, "Claude token 2"), limitOf(41, "Claude token")];

    expect(tick(SATURDAY, { kitIssues }, TWO_SUBSCRIPTIONS)).toEqual(OPENS_NOTHING);
  });

  it("opens nothing on the tick that closes one weekly-limit issue at its reset while another stays open", () => {
    const kitIssues = [limitOf(40, "Claude token 2", "2026-11-07T03:00:00.000Z"), limitOf(41, "Claude token")];

    expect(opened(tick(SATURDAY, { kitIssues }, TWO_SUBSCRIPTIONS))).toEqual([]);
  });

  it("opens on the tick that closes the last weekly-limit issue at its reset", () => {
    const kitIssues = [limitOf(40, "Claude token 2", "2026-11-07T03:00:00.000Z")];

    expect(opened(tick(SATURDAY, { kitIssues }, TWO_SUBSCRIPTIONS))).toEqual([
      expect.objectContaining({ labels: ["fabrik:retro"] }),
    ]);
  });

  it("with one Subscription listed, waits for the reset, as V1 does", () => {
    expect(tick(SATURDAY, { kitIssues: [limitOf(41, "Claude token")] })).toEqual(OPENS_NOTHING);
  });
});

describe("A tick's snapshot without the retro slice", () => {
  it("fails rather than guess, and changes nothing", () => {
    const plan = planFor({ kind: "scheduled-tick", now: SATURDAY }, tickSnapshot({ audit: AUDITED, retro: null }), kitConfig());

    expect(plan).toEqual({ kind: "fail", failure: "infrastructure", reason: expect.stringContaining("retro") });
  });

  it("opens nothing and fails nothing while the Retro is off", () => {
    const snapshot = tickSnapshot({ audit: AUDITED, retro: null });

    expect(planFor({ kind: "scheduled-tick", now: SATURDAY }, snapshot, kitConfig({ retro: { day: null } }))).toEqual(OPENS_NOTHING);
  });
});

describe("The pending Retro's issue", () => {
  it("starts the Retro run once the App has opened it, rather than going through Intake to Triage", () => {
    const pending = opened(tick(SATURDAY))[0];
    const issue = anIssue({ number: 98, author: "fabrik-app[bot]", byApp: true, labels: pending?.labels ?? [], body: pending?.body ?? "" });

    const plan = planFor({ kind: "issue-opened", issue: 98 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [expect.objectContaining({ kind: "start-agent-run", role: "retro", issue: 98 })] });
  });

  it("leaves a fabrik:retro issue a person opened to them: Intake gives it nothing either", () => {
    const issue = anIssue({ number: 99, author: "jrey8343", labels: ["fabrik:retro"], body: "What the Retro should look at next" });

    const plan = planFor({ kind: "issue-opened", issue: 99 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: expect.stringContaining("fabrik:retro") });
  });
});

describe("The scheduled-tick rule", () => {
  it("opens the pending Retro on retro day, with the store ready and something new, alongside closing the weekly-limit issue, then asks for a Design queue check", () => {
    const snapshot = tickSnapshot({
      kitIssues: [weeklyLimitIssue("2026-11-07T03:00:00.000Z")],
      retro: { storeReady: true, issues: [aRetroIssue()], agentPullRequestClosed: true, escapeFiled: false },
    });

    const plan = planFor({ kind: "scheduled-tick", now: SATURDAY }, snapshot, kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        expect.objectContaining({ kind: "comment", issue: 41 }),
        { kind: "close", issue: 41, reason: "completed" },
        expect.objectContaining({ kind: "open-issue", title: "Retro: week of 2026-11-02", labels: ["fabrik:retro"], assignees: [] }),
        { kind: "check-design-queue" },
      ],
    });
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("opens no Retro with retro.day null, and does only what it did before the Retro", () => {
    const snapshot = tickSnapshot({ retro: { storeReady: true, issues: [], agentPullRequestClosed: true, escapeFiled: true } });

    const plan = planFor({ kind: "scheduled-tick", now: SATURDAY }, snapshot, kitConfig({ retro: { day: null } }));

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "check-design-queue" }] });
  });
});
