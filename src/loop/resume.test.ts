import { describe, expect, it } from "vitest";
import {
  anIssue,
  AUDITED_SHA,
  auditBody,
  kitConfig,
  notificationsOf,
  RETRO_WINDOW_END,
  retroBody,
  snapshotOf,
  tickSnapshot,
} from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, AgentRole, HeldTargetSnapshot, KitIssueSnapshot, LoopEvent, Plan } from "./types.ts";

const TWO_SUBSCRIPTIONS = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
const EARLIER = "2026-11-08T10:00:00.000Z";
const LATER = "2026-11-09T04:00:00.000Z";
const tick = (now: string): LoopEvent => ({ kind: "scheduled-tick", now });
/** Past the earlier reset, before the later one. */
const PAST_EARLIER = tick("2026-11-08T11:00:00.000Z");

/** The held marker a weekly-limit issue's comment carries for a held run, as the hold leaves it. */
function held(issue: number, role: AgentRole, label: string | null): string {
  return `The run is held.\n\n<!-- fabrik:held ${JSON.stringify({ issue, role, label })} -->`;
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
    const resumed = actionsOf(plan).find((action) => action.kind === "comment" && action.issue === 41);
    expect(resumed).toEqual(expect.objectContaining({ body: expect.stringContaining('"role":"audit"') }));
    expect(resumed).not.toEqual(expect.objectContaining({ body: expect.stringContaining('"role":"retro"') }));
  });
});
