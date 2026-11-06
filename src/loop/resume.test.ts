import { describe, expect, it } from "vitest";
import {
  anAuditIssue,
  anIssue,
  aRetroIssue,
  AUDITED_SHA,
  auditBody,
  HEAD_SHA,
  kitConfig,
  notificationsOf,
  RETRO_WINDOW_END,
  retroBody,
  snapshotOf,
  tickSnapshot,
} from "../__fixtures__/snapshots.ts";
import { auditGate } from "./auditGate.ts";
import { auditMarksIn, retroMarksIn } from "./markers.ts";
import { retroGate } from "./retroGate.ts";
import { planFor } from "./rules.ts";
import type { Action, AgentRole, HeldTargetSnapshot, KitIssueSnapshot, LoopEvent, Plan, Snapshot } from "./types.ts";
import { scheduledTickWith } from "./weeklyGate.ts";

const TWO_SUBSCRIPTIONS = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
const EARLIER = "2026-11-08T10:00:00.000Z";
const LATER = "2026-11-09T04:00:00.000Z";
const tick = (now: string): LoopEvent => ({ kind: "scheduled-tick", now });
/** Past the earlier reset, before the later one. */
const PAST_EARLIER = tick("2026-11-08T11:00:00.000Z");

/** The held marker a weekly-limit issue's comment carries for a held run, as the hold leaves it, with its place if it has one. */
function held(issue: number, role: AgentRole, label: string | null, order?: number): string {
  const run = order === undefined ? { issue, role, label } : { issue, role, label, order };
  return `The run is held.\n\n<!-- fabrik:held ${JSON.stringify(run)} -->`;
}

/** An open weekly-limit issue for `subscription`, with these comments. */
function weeklyLimitIssue(
  number: number,
  subscription: string,
  resetsAt: string,
  comments: readonly string[] = [],
  buzzed = false,
): KitIssueSnapshot {
  return {
    number,
    labels: ["fabrik:weekly-limit"],
    body: [
      `The weekly usage limit of the \`${subscription}\` Subscription is reached.`,
      "",
      ...(buzzed ? ["<!-- fabrik:notified -->"] : []),
      `<!-- fabrik:subscription ${subscription} -->`,
      `<!-- fabrik:resets-at ${resetsAt} -->`,
    ].join("\n"),
    comments,
  };
}

/** An issue a held run is on, as the tick reads it: by default open, with these labels. */
function anIssueHeld(number: number, labels: readonly string[], overrides: Partial<HeldTargetSnapshot> = {}): HeldTargetSnapshot {
  return { number, open: true, labels, draft: null, byApp: false, body: "", ...overrides };
}

/** An agent draft PR a held Review is on. */
function aDraftHeld(number: number, overrides: Partial<HeldTargetSnapshot> = {}): HeldTargetSnapshot {
  return { number, open: true, labels: [], draft: true, byApp: true, body: "", ...overrides };
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${plan.kind}: ${JSON.stringify(plan)}`);
  return plan.actions;
}

function labelsAdded(plan: Plan): readonly Action[] {
  return actionsOf(plan).filter((action) => action.kind === "add-labels");
}

describe("The scheduled tick past a reset, with runs held and rotation on", () => {
  const buzzed = (comments: readonly string[]) => weeklyLimitIssue(41, "Claude token", LATER, comments, true);
  const freed = weeklyLimitIssue(40, "Claude token 2", EARLIER);

  it("closes that weekly-limit issue and re-adds each held run's trigger label, oldest first", () => {
    const kitIssues = [
      buzzed([held(7, "triage", "needs-triage"), held(50, "review", "agent:review"), held(8, "implement", "agent:implement")]),
      freed,
    ];
    const heldOn = [anIssueHeld(8, ["enhancement", "ready-for-agent"]), aDraftHeld(50), anIssueHeld(7, ["bug"])];

    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: heldOn }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan)).toContainEqual({ kind: "close", issue: 40, reason: "completed" });
    expect(labelsAdded(plan)).toEqual([
      { kind: "add-labels", issue: 7, labels: ["needs-triage"] },
      { kind: "add-labels", issue: 50, labels: ["agent:review"] },
      { kind: "add-labels", issue: 8, labels: ["agent:implement"] },
    ]);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("resumes the runs held on the issue it closes, too", () => {
    const kitIssues = [weeklyLimitIssue(40, "Claude token 2", EARLIER, [held(7, "triage", "needs-triage")], true)];

    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: [anIssueHeld(7, ["bug"])] }), TWO_SUBSCRIPTIONS);

    expect(labelsAdded(plan)).toEqual([{ kind: "add-labels", issue: 7, labels: ["needs-triage"] }]);
  });

  it("leaves a resumed marker for each run on the weekly-limit issue that stays open, so the next reset doesn't resume it again", () => {
    const kitIssues = [buzzed([held(7, "triage", "needs-triage")]), freed];

    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: [anIssueHeld(7, ["bug"])] }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan)).toContainEqual({
      kind: "comment",
      issue: 41,
      body: expect.stringContaining('<!-- fabrik:resumed {"issue":7,"role":"triage","held":1} -->'),
    });
    const later = planFor(
      tick("2026-11-09T05:00:00.000Z"),
      tickSnapshot({
        kitIssues: [buzzed([held(7, "triage", "needs-triage"), '<!-- fabrik:resumed {"issue":7,"role":"triage","held":1} -->'])],
        held: [anIssueHeld(7, ["bug"])],
      }),
      TWO_SUBSCRIPTIONS,
    );
    expect(labelsAdded(later)).toEqual([]);
  });
});

describe("A held run whose issue or PR has closed, or moved on in the Loop, at the reset", () => {
  const STALE: readonly (readonly [string, AgentRole, string | null, HeldTargetSnapshot, string])[] = [
    ["a closed Ticket", "implement", "agent:implement", anIssueHeld(7, ["ready-for-agent"], { open: false }), "#7 is closed"],
    ["an issue triaged by hand", "triage", "needs-triage", anIssueHeld(7, ["bug", "ready-for-agent"]), "#7 has moved on to ready-for-agent"],
    ["a Ticket out of ready-for-agent", "implement", "agent:implement", anIssueHeld(7, ["needs-design"]), "#7 is no longer ready-for-agent"],
    ["an issue out of its Design session", "design", "agent:design", anIssueHeld(7, ["ready-for-agent"]), "#7 is no longer in needs-design"],
    ["an agent PR out of draft", "review", "agent:review", aDraftHeld(7, { draft: false }), "#7 is no longer a draft"],
    ["a closed agent PR", "review", "agent:review", aDraftHeld(7, { open: false }), "#7 is closed"],
    ["an Audit no longer pending", "audit", null, anIssueHeld(7, ["fabrik:audit"], { byApp: true, body: auditBody(AUDITED_SHA, "failed") }), "#7 is no longer a pending Audit"],
    ["a Retro no longer pending", "retro", null, anIssueHeld(7, ["fabrik:retro"], { byApp: true, body: retroBody(RETRO_WINDOW_END, "failed") }), "#7 is no longer a pending Retro"],
    ["a pending Retro someone else opened", "retro", null, anIssueHeld(7, ["fabrik:retro"], { body: retroBody(RETRO_WINDOW_END, "pending") }), "#7 is no longer a pending Retro"],
  ];

  it.each(STALE)("on %s is dropped, and named in the step summary", (_, role, label, on, why) => {
    const kitIssues = [weeklyLimitIssue(40, "Claude token 2", EARLIER, [held(7, role, label), held(8, "triage", "needs-triage")], true)];

    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: [on, anIssueHeld(8, [])] }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan)).toContainEqual({ kind: "drop-held-run", role, issue: 7, reason: expect.stringContaining(why) });
    expect(actionsOf(plan).filter((action) => action.kind === "start-agent-run")).toEqual([]);
    expect(labelsAdded(plan)).toEqual([{ kind: "add-labels", issue: 8, labels: ["needs-triage"] }]);
  });

  it("is dropped when GitHub no longer has its issue", () => {
    const kitIssues = [weeklyLimitIssue(40, "Claude token 2", EARLIER, [held(7, "triage", "needs-triage")], true)];

    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: [] }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan)).toContainEqual({
      kind: "drop-held-run",
      role: "triage",
      issue: 7,
      reason: "GitHub no longer has #7",
    });
    expect(labelsAdded(plan)).toEqual([]);
  });
});

describe("A run held twice", () => {
  it("keeps its original place: held, resumed, then held again, it is resumed before a run first held after it", () => {
    const buzzed = weeklyLimitIssue(41, "Claude token", LATER, [
      held(7, "triage", "needs-triage"),
      held(9, "implement", "agent:implement"),
      '<!-- fabrik:resumed {"issue":7,"role":"triage","held":1} -->\n<!-- fabrik:resumed {"issue":9,"role":"implement","held":1} -->',
      held(12, "triage", "needs-triage"),
      held(9, "implement", "agent:implement"),
      held(7, "triage", "needs-triage"),
    ], true);
    const kitIssues = [buzzed, weeklyLimitIssue(40, "Claude token 2", EARLIER)];
    const heldOn = [anIssueHeld(7, []), anIssueHeld(9, ["ready-for-agent"]), anIssueHeld(12, [])];

    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: heldOn }), TWO_SUBSCRIPTIONS);

    expect(labelsAdded(plan)).toEqual([
      { kind: "add-labels", issue: 7, labels: ["needs-triage"] },
      { kind: "add-labels", issue: 9, labels: ["agent:implement"] },
      { kind: "add-labels", issue: 12, labels: ["needs-triage"] },
    ]);
  });

  it("keeps its place when held again on another weekly-limit issue", () => {
    const kitIssues = [
      weeklyLimitIssue(40, "Claude token 2", EARLIER, [held(8, "triage", "needs-triage")]),
      weeklyLimitIssue(41, "Claude token", LATER, [held(7, "triage", "needs-triage"), held(8, "triage", "needs-triage")], true),
    ];

    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: [anIssueHeld(7, []), anIssueHeld(8, [])] }), TWO_SUBSCRIPTIONS);

    expect(labelsAdded(plan)).toEqual([
      { kind: "add-labels", issue: 8, labels: ["needs-triage"] },
      { kind: "add-labels", issue: 7, labels: ["needs-triage"] },
    ]);
  });
});

describe("A run held twice, once the issue its first held marker was on has closed", () => {
  const LATEST = "2026-11-10T04:00:00.000Z";

  /** The issue with the comments this plan leaves on it. */
  function commentedOn(issue: KitIssueSnapshot, plan: Plan): KitIssueSnapshot {
    const added = actionsOf(plan).flatMap((action) => (action.kind === "comment" && action.issue === issue.number ? [action.body] : []));
    return { ...issue, comments: [...issue.comments, ...added] };
  }

  function holdOn(kitIssues: KitIssueSnapshot[], issue: number, label: "needs-triage" | "agent:implement"): Plan {
    const labels = label === "needs-triage" ? [label] : ["enhancement", "ready-for-agent", label];
    return planFor(
      { kind: "label-added", issue, label },
      snapshotOf(anIssue({ number: issue, labels }), { kitIssues }),
      TWO_SUBSCRIPTIONS,
    );
  }

  it("keeps its original place, ahead of a run first held while it was running", () => {
    // Both used up: #40 buzzed and resets first, so the held runs' markers are on the issue the tick closes.
    let first = weeklyLimitIssue(40, "Claude token 2", EARLIER, [], true);
    let quiet = weeklyLimitIssue(41, "Claude token", LATER);
    first = commentedOn(first, holdOn([first, quiet], 7, "needs-triage"));
    first = commentedOn(first, holdOn([first, quiet], 9, "agent:implement"));

    const reset = planFor(PAST_EARLIER, tickSnapshot({ kitIssues: [first, quiet], held: [anIssueHeld(7, []), anIssueHeld(9, ["ready-for-agent"])] }), TWO_SUBSCRIPTIONS);
    expect(actionsOf(reset)).toContainEqual({ kind: "close", issue: 40, reason: "completed" });
    quiet = commentedOn(quiet, reset);

    // The reset was wrong: Claude token 2 is used up again, and a new run, #12, is held before #9 and #7 are refused again.
    let again = weeklyLimitIssue(42, "Claude token 2", LATEST, [], true);
    again = commentedOn(again, holdOn([quiet, again], 12, "needs-triage"));
    again = commentedOn(again, holdOn([quiet, again], 9, "agent:implement"));
    again = commentedOn(again, holdOn([quiet, again], 7, "needs-triage"));

    const plan = planFor(
      tick("2026-11-09T05:00:00.000Z"),
      tickSnapshot({ kitIssues: [quiet, again], held: [anIssueHeld(7, []), anIssueHeld(9, ["ready-for-agent"]), anIssueHeld(12, [])] }),
      TWO_SUBSCRIPTIONS,
    );

    expect(actionsOf(plan)).toContainEqual({ kind: "close", issue: 41, reason: "completed" });
    expect(labelsAdded(plan)).toEqual([
      { kind: "add-labels", issue: 7, labels: ["needs-triage"] },
      { kind: "add-labels", issue: 9, labels: ["agent:implement"] },
      { kind: "add-labels", issue: 12, labels: ["needs-triage"] },
    ]);
  });
});

describe("The scheduled tick before any reset", () => {
  it("resumes nothing", () => {
    const kitIssues = [
      weeklyLimitIssue(41, "Claude token", LATER, [held(7, "triage", "needs-triage"), held(98, "audit", null)], true),
      weeklyLimitIssue(40, "Claude token 2", EARLIER),
    ];
    const audit = anIssueHeld(98, ["fabrik:audit"], { byApp: true, body: auditBody(AUDITED_SHA, "pending") });

    const plan = planFor(tick("2026-11-08T09:00:00.000Z"), tickSnapshot({ kitIssues, held: [anIssueHeld(7, []), audit] }), TWO_SUBSCRIPTIONS);

    const resumed = actionsOf(plan).filter((action) =>
      ["add-labels", "start-agent-run", "drop-held-run", "close", "comment"].includes(action.kind),
    );
    expect(resumed).toEqual([]);
  });

  it("with one Subscription listed, closes the V1 issue at its reset and resumes nothing, as V1 does", () => {
    const v1 = {
      number: 41,
      labels: ["fabrik:weekly-limit"],
      body: `@operator The weekly usage limit is reached.\n\n<!-- fabrik:notified -->\n<!-- fabrik:resets-at ${EARLIER} -->`,
      comments: [held(7, "triage", "needs-triage")],
    };

    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues: [v1], held: [anIssueHeld(7, [])] }), kitConfig());

    expect(actionsOf(plan)).toContainEqual({ kind: "close", issue: 41, reason: "completed" });
    expect(labelsAdded(plan)).toEqual([]);
  });
});

describe("The weekly-limit issue that buzzes the Operator, with rotation on", () => {
  it("says in its steps that the Kit resumes held runs itself, with no trigger label to re-add", () => {
    const refused: LoopEvent = {
      kind: "agent-run-failed",
      role: "implement",
      issue: 7,
      runUrl: "https://github.com/acme/shop/actions/runs/42/attempts/1",
      jobResult: "failure",
      secretsStep: "success",
      report: { failure: "weekly-limit", detail: `resets at ${LATER}`, resetsAt: LATER },
      subscription: "Claude token",
    };
    const snapshot = { ...tickSnapshot({ kitIssues: [weeklyLimitIssue(40, "Claude token 2", EARLIER)] }), issue: anIssue({ number: 7 }) };

    const opened = actionsOf(planFor(refused, snapshot, TWO_SUBSCRIPTIONS)).find((action) => action.kind === "open-issue");

    expect(opened).toEqual(
      expect.objectContaining({
        body: expect.stringContaining(
          "- [ ] Nothing to re-add: at the reset the Kit resumes each held run itself, in the order they were held.",
        ),
      }),
    );
    expect(opened).not.toEqual(expect.objectContaining({ body: expect.stringContaining("Re-add the trigger label") }));
  });
});

describe("A held Auditor run, at the reset, with rotation on", () => {
  it("is started again on its pending Audit, on the freed Subscription", () => {
    const kitIssues = [
      weeklyLimitIssue(41, "Claude token", LATER, [held(98, "audit", null)], true),
      weeklyLimitIssue(40, "Claude token 2", EARLIER),
    ];
    const audit = anIssueHeld(98, ["fabrik:audit"], { byApp: true, body: auditBody(AUDITED_SHA, "pending") });

    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: [audit] }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan).filter((action) => action.kind === "start-agent-run")).toEqual([
      expect.objectContaining({ role: "audit", issue: 98, commit: AUDITED_SHA, subscription: "Claude token 2" }),
    ]);
    expect(actionsOf(plan).filter((action) => action.kind === "hold-agent-run")).toEqual([]);
  });
});

describe("A held Retro run, at the reset, with rotation on", () => {
  const retro = anIssueHeld(120, ["fabrik:retro"], { byApp: true, body: retroBody(RETRO_WINDOW_END, "pending") });

  it("is started again on its pending Retro, on roles.retro and the freed Subscription", () => {
    const kitIssues = [
      weeklyLimitIssue(41, "Claude token", LATER, [held(120, "retro", null)], true),
      weeklyLimitIssue(40, "Claude token 2", EARLIER),
    ];
    const config = kitConfig({
      subscriptions: ["Claude token", "Claude token 2"],
      roles: { ...TWO_SUBSCRIPTIONS.roles, retro: { model: "claude-retro", effort: "high", timeoutMinutes: 50 } },
    });

    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: [retro] }), config);

    expect(actionsOf(plan).filter((action) => action.kind === "start-agent-run")).toEqual([
      {
        kind: "start-agent-run",
        role: "retro",
        issue: 120,
        model: "claude-retro",
        effort: "high",
        timeoutMinutes: 50,
        subscription: "Claude token 2",
      },
    ]);
    expect(actionsOf(plan).filter((action) => action.kind === "hold-agent-run")).toEqual([]);
  });

  // A Loop run starts at most one agent run, and neither has a trigger label to start it through a Loop run of its own.
  it("held after an Auditor run, waits for the next reset while the Auditor run starts, keeping its held marker", () => {
    const kitIssues = [
      weeklyLimitIssue(41, "Claude token", LATER, [held(98, "audit", null), held(120, "retro", null)], true),
      weeklyLimitIssue(40, "Claude token 2", EARLIER),
    ];
    const audit = anIssueHeld(98, ["fabrik:audit"], { byApp: true, body: auditBody(AUDITED_SHA, "pending") });

    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: [audit, retro] }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan).filter((action) => action.kind === "start-agent-run")).toEqual([
      expect.objectContaining({ role: "audit", issue: 98 }),
    ]);
    expect(actionsOf(plan).filter((action) => action.kind === "drop-held-run")).toEqual([]);
    const on41 = actionsOf(plan).flatMap((action) => (action.kind === "comment" && action.issue === 41 ? [action.body] : []));
    expect(on41).toEqual([expect.stringContaining('"role":"audit"')]);
    // Its held marker there still holds it, so it isn't held again.
    expect(on41.join("\n")).not.toContain('"role":"retro"');
  });
});

describe("A held Auditor run and a held Retro run, at the same reset, with rotation on", () => {
  const audit = anIssueHeld(98, ["fabrik:audit"], { byApp: true, body: auditBody(AUDITED_SHA, "pending") });
  const retro = anIssueHeld(120, ["fabrik:retro"], { byApp: true, body: retroBody(RETRO_WINDOW_END, "pending") });
  // This week's pending Audit and Retro, as the gates read them.
  const pendingAudit = anAuditIssue({ number: 98, title: "Audit: week of 2026-11-02", open: true, stateReason: null, createdAt: "2026-11-08T00:05:00Z", body: audit.body });
  const pendingRetro = aRetroIssue({ number: 120, title: "Retro: week of 2026-11-02", open: true, stateReason: null, createdAt: "2026-11-07T00:05:00Z", body: retro.body });

  /** The tick's snapshot, with this week's pending Audit and Retro as each gate reads them, edited and closed as `plan` leaves them. */
  function weeklySnapshot(kitIssues: readonly KitIssueSnapshot[], plan: Plan | null = null): Snapshot {
    const after = <Issue extends { number: number; body: string; open: boolean }>(issue: Issue): Issue => {
      const actions = plan === null ? [] : actionsOf(plan);
      const edit = actions.find((action) => action.kind === "edit-issue-body" && action.issue === issue.number);
      const closed = actions.some((action) => action.kind === "close" && action.issue === issue.number);
      return { ...issue, body: edit?.kind === "edit-issue-body" ? edit.body : issue.body, open: issue.open && !closed };
    };
    return tickSnapshot({
      kitIssues,
      held: [audit, retro],
      audit: { head: HEAD_SHA, issues: [after(pendingAudit)] },
      retro: { storeReady: true, agentPullRequestClosed: true, escapeFiled: false, issues: [after(pendingRetro)] },
    });
  }
  type Held = { readonly role: "audit" | "retro"; readonly issue: number };
  const BOTH: readonly (readonly [string, Held, Held])[] = [
    ["the Auditor run held first", { role: "audit", issue: 98 }, { role: "retro", issue: 120 }],
    ["the Retro run held first", { role: "retro", issue: 120 }, { role: "audit", issue: 98 }],
  ];

  function startsIn(plan: Plan): readonly Action[] {
    return actionsOf(plan).filter((action) => action.kind === "start-agent-run");
  }

  /** The issue with the comments this plan leaves on it. */
  function commentedOn(issue: KitIssueSnapshot, plan: Plan): KitIssueSnapshot {
    const added = actionsOf(plan).flatMap((action) => (action.kind === "comment" && action.issue === issue.number ? [action.body] : []));
    return { ...issue, comments: [...issue.comments, ...added] };
  }

  it.each(BOTH)(
    "with %s, both on the weekly-limit issue the tick closes, holds the second again in its place on the one that stays open, for its reset to start it",
    (_, first, second) => {
      // #40 buzzed and resets first, so both held markers are on the issue the tick closes.
      const closing = weeklyLimitIssue(40, "Claude token 2", EARLIER, [held(first.issue, first.role, null, 1), held(second.issue, second.role, null, 2)], true);
      const staying = weeklyLimitIssue(41, "Claude token", LATER);

      const reset = planFor(PAST_EARLIER, weeklySnapshot([closing, staying]), TWO_SUBSCRIPTIONS);

      expect(actionsOf(reset)).toContainEqual({ kind: "close", issue: 40, reason: "completed" });
      expect(startsIn(reset)).toEqual([expect.objectContaining({ role: first.role, issue: first.issue })]);
      expect(actionsOf(reset)).toContainEqual({
        kind: "comment",
        issue: 41,
        body: expect.stringContaining(`<!-- fabrik:held {"issue":${second.issue},"role":"${second.role}","label":null,"order":2} -->`),
      });
      expect(actionsOf(reset).filter((action) => action.kind === "drop-held-run" || action.kind === "edit-issue-body")).toEqual([]);
      expect(actionsOf(reset)).not.toContainEqual(expect.objectContaining({ kind: "close", issue: second.issue }));

      const next = planFor(tick("2026-11-09T05:00:00.000Z"), weeklySnapshot([commentedOn(staying, reset)]), TWO_SUBSCRIPTIONS);

      expect(actionsOf(next)).toContainEqual({ kind: "close", issue: 41, reason: "completed" });
      expect(startsIn(next)).toEqual([expect.objectContaining({ role: second.role, issue: second.issue })]);
    },
  );

  it.each(BOTH)(
    "with %s, and no weekly-limit issue left open, fails the second's pending issue as not planned, for the tick to open the next one",
    (_, first, second) => {
      // Claude token's usage-credits issue keeps it unusable, so #40 is the only weekly-limit issue.
      const only = weeklyLimitIssue(40, "Claude token 2", EARLIER, [held(first.issue, first.role, null, 1), held(second.issue, second.role, null, 2)], true);
      const usageCredits: KitIssueSnapshot = {
        number: 60,
        labels: ["ready-for-human", "fabrik:usage-credits"],
        body: "Usage credits are on for the `Claude token` Subscription.\n\n<!-- fabrik:subscription Claude token -->",
        comments: [],
      };

      const plan = planFor(PAST_EARLIER, weeklySnapshot([only, usageCredits]), TWO_SUBSCRIPTIONS);

      expect(actionsOf(plan)).toContainEqual({ kind: "close", issue: 40, reason: "completed" });
      expect(startsIn(plan)).toEqual([
        expect.objectContaining({ role: first.role, issue: first.issue, subscription: "Claude token 2" }),
      ]);
      expect(actionsOf(plan)).toContainEqual({
        kind: "drop-held-run",
        role: second.role,
        issue: second.issue,
        reason: expect.stringContaining("no weekly-limit issue stays open"),
      });
      expect(actionsOf(plan)).toContainEqual({ kind: "close", issue: second.issue, reason: "not_planned" });
      const edit = actionsOf(plan).find((action) => action.kind === "edit-issue-body" && action.issue === second.issue);
      if (edit?.kind !== "edit-issue-body") throw new Error(`expected #${second.issue}'s body rewritten: ${JSON.stringify(plan)}`);
      // Failed, with its marker kept, as a failed run leaves it, so the gate opens the next one.
      if (second.role === "audit") expect(auditMarksIn(edit.body)).toEqual({ commit: AUDITED_SHA, pending: false, failed: true });
      else expect(retroMarksIn(edit.body)).toEqual({ windowEnd: RETRO_WINDOW_END, pending: false, failed: true });
      expect(edit.body).toContain("held at a weekly limit");
      expect(notificationsOf(plan)).toEqual([]);

      // An hour later, with both gates on, its gate opens the next one, whose opening starts its run.
      const next = scheduledTickWith([auditGate, retroGate], "2026-11-08T12:00:00.000Z", weeklySnapshot([usageCredits], plan), TWO_SUBSCRIPTIONS);
      expect(actionsOf(next).filter((action) => action.kind === "open-issue")).toEqual([
        expect.objectContaining({ labels: [second.role === "audit" ? "fabrik:audit" : "fabrik:retro"] }),
      ]);
    },
  );

  it("starts the Retro run when the held Auditor run before it starts nothing", () => {
    const kitIssues = [
      weeklyLimitIssue(41, "Claude token", LATER, [held(98, "audit", null, 1), held(120, "retro", null, 2)], true),
      weeklyLimitIssue(40, "Claude token 2", EARLIER),
    ];
    // Its body has lost its audit marker, so it names no commit to read.
    const markerless = anIssueHeld(98, ["fabrik:audit"], { byApp: true, body: "The Auditor is reading.\n\n<!-- fabrik:audit-pending -->" });

    const plan = planFor(PAST_EARLIER, { ...weeklySnapshot(kitIssues), held: [markerless, retro] }, TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "drop-held-run", role: "audit", issue: 98 }));
    expect(startsIn(plan)).toEqual([expect.objectContaining({ role: "retro", issue: 120 })]);
  });
});
