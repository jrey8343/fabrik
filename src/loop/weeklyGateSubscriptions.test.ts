// The Audit and the Retro are held back only while no Subscription is free,
// and a week they wait for one is noted on the Carrier, once per kind (#442).
import { describe, expect, it } from "vitest";
import { anAuditIssue, aRetroIssue, auditBody, AUDITED_SHA, kitConfig, retroBody, RETRO_WINDOW_END, tickSnapshot } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, AuditSnapshot, KitConfig, KitIssueSnapshot, Plan, RetroSnapshot } from "./types.ts";

/** Sunday 2026-11-08 04:00 UTC: on the default audit.day, in the week of Monday 2026-11-02. */
const SUNDAY = "2026-11-08T04:00:00.000Z";
/** Saturday 2026-11-07 04:00 UTC: on the default retro.day, in the same week. */
const SATURDAY = "2026-11-07T04:00:00.000Z";
const HEAD = "c0ffee5".padEnd(40, "0");
const ONE = kitConfig();
const TWO = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });

/** A default branch moved since the last Audit. */
const MOVED: AuditSnapshot = { head: HEAD, issues: [] };
/** A default branch that hasn't moved since last week's Audit. */
const UNMOVED: AuditSnapshot = { head: AUDITED_SHA, issues: [anAuditIssue()] };
/** A ready store with something new since the last Retro. */
const NEW_WORK: RetroSnapshot = { storeReady: true, issues: [], agentPullRequestClosed: true, escapeFiled: false };
/** A Retro that has nothing new to read. */
const NOTHING_NEW: RetroSnapshot = { ...NEW_WORK, agentPullRequestClosed: false };

function weeklyLimit(number: number, subscription: string): KitIssueSnapshot {
  return {
    number,
    labels: ["fabrik:weekly-limit"],
    body: `The weekly usage limit of the \`${subscription}\` Subscription is reached.\n\n<!-- fabrik:subscription ${subscription} -->\n<!-- fabrik:resets-at 2026-11-09T04:00:00.000Z -->`,
    comments: [],
  };
}

function usageCredits(number: number, subscription: string): KitIssueSnapshot {
  return {
    number,
    labels: ["fabrik:usage-credits"],
    body: `Turn usage credits off.\n\n<!-- fabrik:subscription ${subscription} -->`,
    comments: [],
  };
}

function tokenRotation(number: number, subscription: string): KitIssueSnapshot {
  return {
    number,
    labels: ["fabrik:token-rotation"],
    body: `The token is dead.\n\n<!-- fabrik:subscription ${subscription} -->`,
    comments: [],
  };
}

function tick(
  now: string,
  kitIssues: readonly KitIssueSnapshot[],
  config: KitConfig,
  { audit = UNMOVED, retro = NOTHING_NEW }: { audit?: AuditSnapshot; retro?: RetroSnapshot } = {},
): Plan {
  return planFor({ kind: "scheduled-tick", now }, tickSnapshot({ kitIssues, audit, retro }), config);
}

function actions(plan: Plan): Action[] {
  return plan.kind === "act" ? [...plan.actions] : [];
}

function openedLabels(plan: Plan): string[][] {
  return actions(plan).flatMap((action) => (action.kind === "open-issue" ? [[...action.labels]] : []));
}

function comments(plan: Plan): Extract<Action, { kind: "comment" }>[] {
  return actions(plan).filter((action) => action.kind === "comment");
}

describe("With another Subscription free", () => {
  it("the audit gate opens the pending Audit while the first Subscription's weekly-limit issue is open", () => {
    expect(openedLabels(tick(SUNDAY, [weeklyLimit(41, "Claude token")], TWO, { audit: MOVED }))).toEqual([["fabrik:audit"]]);
  });

  it("the retro gate opens the pending Retro while the first Subscription's weekly-limit issue is open", () => {
    expect(openedLabels(tick(SATURDAY, [weeklyLimit(41, "Claude token")], TWO, { retro: NEW_WORK }))).toEqual([["fabrik:retro"]]);
  });
});

describe("With no Subscription free", () => {
  it.each([
    ["two weekly-limit issues, rotation on", [weeklyLimit(40, "Claude token 2"), weeklyLimit(41, "Claude token")], TWO, 40],
    ["a weekly-limit and a token-rotation issue, rotation on", [weeklyLimit(41, "Claude token"), tokenRotation(42, "Claude token 2")], TWO, 41],
    ["a usage-credits and a token-rotation issue, rotation on", [usageCredits(40, "Claude token"), tokenRotation(41, "Claude token 2")], TWO, 41],
    ["a weekly-limit issue, rotation off", [weeklyLimit(41, "Claude token")], ONE, 41],
    ["only a token-rotation issue, rotation off", [tokenRotation(41, "Claude token")], ONE, 41],
    ["only a usage-credits issue, rotation off", [usageCredits(41, "Claude token")], ONE, 41],
  ])("with %s, opens no Audit and notes the waiting week quietly on the Carrier", (_, kitIssues, config, carrier) => {
    const plan = tick(SUNDAY, kitIssues, config, { audit: MOVED });

    expect(openedLabels(plan)).toEqual([]);
    expect(comments(plan)).toEqual([
      {
        kind: "comment",
        issue: carrier,
        body: "This week's Audit waits for a free Subscription.\n\n<!-- fabrik:weekly-run-waiting audit 2026-11-02 -->",
      },
    ]);
  });

  it("opens no Retro and notes the waiting week quietly on the Carrier", () => {
    const plan = tick(SATURDAY, [tokenRotation(41, "Claude token")], ONE, { retro: NEW_WORK });

    expect(openedLabels(plan)).toEqual([]);
    expect(comments(plan)).toEqual([
      {
        kind: "comment",
        issue: 41,
        body: "This week's Retro waits for a free Subscription.\n\n<!-- fabrik:weekly-run-waiting retro 2026-11-02 -->",
      },
    ]);
  });

  it("notes the Audit's and the Retro's waiting weeks apart, on the tick both are due", () => {
    const plan = tick(SUNDAY, [weeklyLimit(41, "Claude token")], ONE, { audit: MOVED, retro: NEW_WORK });

    expect(comments(plan).map(({ body }) => body.split("\n").at(-1))).toEqual([
      "<!-- fabrik:weekly-run-waiting audit 2026-11-02 -->",
      "<!-- fabrik:weekly-run-waiting retro 2026-11-02 -->",
    ]);
  });

  it("notes the waiting week once, not on every tick", () => {
    const noted = {
      ...weeklyLimit(41, "Claude token"),
      comments: ["This week's Audit waits for a free Subscription.\n\n<!-- fabrik:weekly-run-waiting audit 2026-11-02 -->"],
    };
    const plan = tick(SUNDAY, [noted], ONE, { audit: MOVED });

    expect(openedLabels(plan)).toEqual([]);
    expect(comments(plan)).toEqual([]);
  });

  it("notes a new week's wait though last week's is on the Carrier", () => {
    const noted = {
      ...weeklyLimit(41, "Claude token"),
      comments: ["This week's Audit waits for a free Subscription.\n\n<!-- fabrik:weekly-run-waiting audit 2026-10-26 -->"],
    };

    expect(comments(tick(SUNDAY, [noted], ONE, { audit: MOVED }))).toHaveLength(1);
  });

  it("names the wait in the step summary's notes", () => {
    const plan = tick(SUNDAY, [weeklyLimit(41, "Claude token")], ONE, { audit: MOVED });

    expect(plan.kind === "act" ? plan.notes : []).toContain("No Subscription is free, so the Audit waits for one");
  });
});

describe("No waiting marker is written while another reason holds the gate back", () => {
  const usedUp = [weeklyLimit(41, "Claude token")];
  const thisWeeksAudit = (body: string, open: boolean) =>
    anAuditIssue({ number: 95, open, stateReason: open ? null : "completed", createdAt: "2026-11-08T00:05:00Z", body });
  const failedAudit = (number: number, createdAt: string) =>
    anAuditIssue({ number, stateReason: "not_planned", createdAt, body: auditBody(AUDITED_SHA, "failed") });
  const thisWeeksRetro = (body: string, open: boolean) =>
    aRetroIssue({ number: 85, open, stateReason: open ? null : "completed", createdAt: "2026-11-07T00:05:00Z", body });
  const failedRetro = (number: number, createdAt: string) =>
    aRetroIssue({ number, stateReason: "not_planned", createdAt, body: retroBody(RETRO_WINDOW_END, "failed") });

  it.each<[string, string, AuditSnapshot]>([
    ["not yet due", "2026-11-07T23:00:00.000Z", MOVED],
    ["this week's Audit done", SUNDAY, { head: HEAD, issues: [thisWeeksAudit(auditBody(AUDITED_SHA), false)] }],
    ["an Audit still open", SUNDAY, { head: HEAD, issues: [thisWeeksAudit(auditBody(AUDITED_SHA, "pending"), true)] }],
    [
      "two failed this week",
      SUNDAY,
      { head: HEAD, issues: [failedAudit(96, "2026-11-08T00:05:00Z"), failedAudit(97, "2026-11-08T01:05:00Z")] },
    ],
    ["the default branch unmoved", SUNDAY, UNMOVED],
  ])("for the Audit, with %s", (_, now, audit) => {
    expect(comments(tick(now, usedUp, ONE, { audit }))).toEqual([]);
  });

  it.each<[string, string, RetroSnapshot]>([
    ["not yet due", "2026-11-06T23:00:00.000Z", NEW_WORK],
    ["this week's Retro done", SATURDAY, { ...NEW_WORK, issues: [thisWeeksRetro(retroBody(RETRO_WINDOW_END), false)] }],
    ["a Retro still open", SATURDAY, { ...NEW_WORK, issues: [thisWeeksRetro(retroBody(RETRO_WINDOW_END, "pending"), true)] }],
    [
      "two failed this week",
      SATURDAY,
      { ...NEW_WORK, issues: [failedRetro(86, "2026-11-07T00:05:00Z"), failedRetro(87, "2026-11-07T01:05:00Z")] },
    ],
    ["the store not ready", SATURDAY, { ...NEW_WORK, storeReady: false }],
    ["nothing new", SATURDAY, NOTHING_NEW],
  ])("for the Retro, with %s", (_, now, retro) => {
    expect(comments(tick(now, usedUp, ONE, { retro }))).toEqual([]);
  });
});
