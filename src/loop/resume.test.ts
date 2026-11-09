import { describe, expect, it } from "vitest";
import {
  aTicket,
  anIssue,
  anAuditIssue,
  AUDITED_SHA,
  auditBody,
  dispatchSnapshotOf,
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

  it("gives a held Researcher run's research Decision agent:research back", () => {
    const kitIssues = [buzzed([held(12, "research", "agent:research")]), freed];

    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: [anIssueHeld(12, ["wayfinder:research"])] }), TWO_SUBSCRIPTIONS);

    expect(labelsAdded(plan)).toEqual([{ kind: "add-labels", issue: 12, labels: ["agent:research"] }]);
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

// A Subscription freed some way other than the tick's own close at a reset
// resumes the held runs too, so a newer Ticket never starts ahead of them (#439).
describe("A Subscription freed while runs are held, with rotation on (#439)", () => {
  // A's weekly-limit issue #50 resets in days and holds #7, then #8; B's usage-credits issue was #51.
  const IN_DAYS = "2026-11-14T10:00:00.000Z";
  const limitA = weeklyLimitIssue(50, "Claude token", IN_DAYS, [held(7, "implement", "agent:implement"), held(8, "implement", "agent:implement")], true);
  const usageCreditsB: KitIssueSnapshot = {
    number: 51,
    labels: ["ready-for-human", "fabrik:usage-credits"],
    body: "Turn off usage credits.\n\n<!-- fabrik:notified -->\n<!-- fabrik:subscription Claude token 2 -->",
    comments: [],
  };
  const heldOn = [anIssueHeld(7, ["enhancement", "ready-for-agent"]), anIssueHeld(8, ["enhancement", "ready-for-agent"])];
  const closedUsageCredits: LoopEvent = { kind: "issue-closed", issue: 51 };
  const closedSnapshot = (kitIssues: readonly KitIssueSnapshot[]) =>
    snapshotOf(anIssue({ number: 51, open: false, byApp: true, labels: usageCreditsB.labels, body: usageCreditsB.body }), {
      kitIssues,
      held: heldOn,
    });

  it("closing the usage-credits issue resumes the held runs, oldest first, before the Dispatch check", () => {
    const plan = planFor(closedUsageCredits, closedSnapshot([limitA]), TWO_SUBSCRIPTIONS);

    const actions = actionsOf(plan);
    expect(labelsAdded(plan)).toEqual([
      { kind: "add-labels", issue: 7, labels: ["agent:implement"] },
      { kind: "add-labels", issue: 8, labels: ["agent:implement"] },
    ]);
    expect(actions).toContainEqual({
      kind: "comment",
      issue: 50,
      body: expect.stringContaining('<!-- fabrik:resumed {"issue":8,"role":"implement","held":1} -->'),
    });
    const lastResume = actions.findIndex((action) => action.kind === "comment");
    expect(actions.findIndex((action) => action.kind === "check-dispatch")).toBeGreaterThan(lastResume);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("closing the usage-credits issue resumes nothing while every Subscription is still used up", () => {
    const limitB = weeklyLimitIssue(52, "Claude token 2", IN_DAYS);

    const plan = planFor(closedUsageCredits, closedSnapshot([limitA, limitB]), TWO_SUBSCRIPTIONS);

    expect(labelsAdded(plan)).toEqual([]);
    expect(actionsOf(plan).filter((action) => action.kind === "comment")).toEqual([]);
  });

  it("the scheduled tick resumes them with B free and A not reset, so a newer ready Ticket never jumps them", () => {
    const plan = planFor(tick("2026-11-09T11:00:00.000Z"), tickSnapshot({ kitIssues: [limitA], held: heldOn }), TWO_SUBSCRIPTIONS);

    const actions = actionsOf(plan);
    expect(labelsAdded(plan)).toEqual([
      { kind: "add-labels", issue: 7, labels: ["agent:implement"] },
      { kind: "add-labels", issue: 8, labels: ["agent:implement"] },
    ]);
    expect(actions).not.toContainEqual(expect.objectContaining({ kind: "close", issue: 50 }));
    const markers = actions.findIndex((action) => action.kind === "comment" && action.issue === 50);
    expect(actions.findIndex((action) => action.kind === "check-dispatch")).toBeGreaterThan(markers);

    // The Dispatch check that follows, once the resumes have landed, counts #7 and #8 as in flight.
    const resumed = { ...limitA, comments: [...limitA.comments, ...actions.flatMap((action) => (action.kind === "comment" && action.issue === 50 ? [action.body] : []))] };
    const tickets = [
      aTicket({ number: 7, labels: ["enhancement", "ready-for-agent", "agent:implement"] }),
      aTicket({ number: 8, labels: ["enhancement", "ready-for-agent", "agent:implement"] }),
      aTicket({ number: 10 }),
    ];
    const dispatched = planFor({ kind: "dispatch-check" }, { ...dispatchSnapshotOf(tickets), kitIssues: [resumed] }, { ...TWO_SUBSCRIPTIONS, maxInFlight: 2 });
    expect(dispatched.kind).toBe("nothing");
  });

  it("the scheduled tick says why it dealt with them: a Subscription is free again, not that a limit reset", () => {
    const plan = planFor(tick("2026-11-09T11:00:00.000Z"), tickSnapshot({ kitIssues: [limitA], held: heldOn }), TWO_SUBSCRIPTIONS);

    const markers = actionsOf(plan).find((action) => action.kind === "comment" && action.issue === 50);
    expect(markers).toEqual(expect.objectContaining({ body: expect.stringMatching(/^A Subscription is free again/) }));
  });
});

describe("The reset tick, failing partway through its plan (#438)", () => {
  // Subscription A's weekly-limit issue #40 holds three runs and resets; B's #41 stays open.
  const kitIssues = [
    weeklyLimitIssue(40, "Claude token 2", EARLIER, [held(7, "triage", "needs-triage"), held(12, "review", "agent:review"), held(9, "implement", "agent:implement")], true),
    weeklyLimitIssue(41, "Claude token", LATER),
  ];
  const heldOn = [anIssueHeld(7, ["bug"]), aDraftHeld(12), anIssueHeld(9, ["enhancement", "ready-for-agent"])];
  const NEXT_TICK = tick("2026-11-08T12:00:00.000Z");

  /** The kit issues and held runs' issues and PRs once these actions have landed on GitHub. */
  function landedOn(
    before: { kitIssues: readonly KitIssueSnapshot[]; held: readonly HeldTargetSnapshot[] },
    actions: readonly Action[],
  ): { kitIssues: KitIssueSnapshot[]; held: HeldTargetSnapshot[] } {
    let kit = [...before.kitIssues];
    let held = [...before.held];
    for (const action of actions) {
      if (action.kind === "comment") {
        kit = kit.map((issue) => (issue.number === action.issue ? { ...issue, comments: [...issue.comments, action.body] } : issue));
      } else if (action.kind === "close") {
        kit = kit.filter((issue) => issue.number !== action.issue);
      } else if (action.kind === "add-labels") {
        held = held.map((on) => (on.number === action.issue ? { ...on, labels: [...on.labels, ...action.labels] } : on));
      }
    }
    return { kitIssues: kit, held };
  }

  it("resumes every held run, then leaves the resumed markers, and only then closes the weekly-limit issue", () => {
    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: heldOn }), TWO_SUBSCRIPTIONS);

    const kinds = actionsOf(plan).map((action) => `${action.kind} #${"issue" in action ? action.issue : ""}`);
    expect(kinds.slice(0, 6)).toEqual([
      "add-labels #7",
      "add-labels #12",
      "add-labels #9",
      "comment #40",
      "comment #41",
      "comment #40",
    ]);
    expect(kinds[6]).toBe("close #40");
  });

  it("failing on the second resume, leaves the weekly-limit issue open, so the next tick resumes what's left and every run resumes once", () => {
    const first = actionsOf(planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: heldOn }), TWO_SUBSCRIPTIONS));
    const failed = first.findIndex((action) => action.kind === "add-labels" && action.issue === 12);
    const applied = first.slice(0, failed);
    const after = landedOn({ kitIssues, held: heldOn }, applied);
    expect(after.kitIssues.map((issue) => issue.number)).toEqual([40, 41]);

    const next = actionsOf(planFor(NEXT_TICK, tickSnapshot(after), TWO_SUBSCRIPTIONS));

    const resumed = [...applied, ...next].filter((action) => action.kind === "add-labels");
    expect(resumed).toEqual([
      { kind: "add-labels", issue: 7, labels: ["needs-triage"] },
      { kind: "add-labels", issue: 12, labels: ["agent:review"] },
      { kind: "add-labels", issue: 9, labels: ["agent:implement"] },
    ]);
    // #7 has needs-triage back from the first tick: resumed, not moved on.
    expect(next.filter((action) => action.kind === "drop-held-run")).toEqual([]);
    expect(next).toContainEqual({ kind: "close", issue: 40, reason: "completed" });
  });

  it("failing after the Review resume lands, before the resumed markers, gives the Review its label only once", () => {
    const first = actionsOf(planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: heldOn }), TWO_SUBSCRIPTIONS));
    const failed = first.findIndex((action) => action.kind === "add-labels" && action.issue === 9);
    const applied = first.slice(0, failed);
    const after = landedOn({ kitIssues, held: heldOn }, applied);

    const next = actionsOf(planFor(NEXT_TICK, tickSnapshot(after), TWO_SUBSCRIPTIONS));

    expect([...applied, ...next].filter((action) => action.kind === "add-labels")).toEqual([
      { kind: "add-labels", issue: 7, labels: ["needs-triage"] },
      { kind: "add-labels", issue: 12, labels: ["agent:review"] },
      { kind: "add-labels", issue: 9, labels: ["agent:implement"] },
    ]);
    expect(next.filter((action) => action.kind === "drop-held-run")).toEqual([]);
    expect(next).toContainEqual({
      kind: "comment",
      issue: 41,
      body: expect.stringContaining('<!-- fabrik:resumed {"issue":12,"role":"review","held":0} -->'),
    });
  });

  it("failing on the close, after the resumed markers, resumes nothing again on the next tick and closes the issue then", () => {
    const first = actionsOf(planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: heldOn }), TWO_SUBSCRIPTIONS));
    const failed = first.findIndex((action) => action.kind === "close");
    const after = landedOn({ kitIssues, held: heldOn }, first.slice(0, failed));

    const next = planFor(NEXT_TICK, tickSnapshot(after), TWO_SUBSCRIPTIONS);

    expect(labelsAdded(next)).toEqual([]);
    expect(actionsOf(next).filter((action) => action.kind === "drop-held-run")).toEqual([]);
    expect(actionsOf(next)).toContainEqual({ kind: "close", issue: 40, reason: "completed" });
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
    ["a closed Decision", "research", "agent:research", anIssueHeld(7, ["wayfinder:research"], { open: false }), "#7 is closed"],
    ["a Decision no longer a research one", "research", "agent:research", anIssueHeld(7, ["wayfinder:grilling"]), "#7 is no longer a research Decision"],
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

// A Retro run is never held (src/loop/failures.ts): the tick can't start one,
// so its Retro fails instead, and the tick opens the next.
describe("A held marker naming a Retro run, at the reset", () => {
  it("is dropped, even on the App's pending Retro, and starts no run", () => {
    const retro = anIssueHeld(120, ["fabrik:retro"], { byApp: true, body: retroBody(RETRO_WINDOW_END, "pending") });
    const kitIssues = [weeklyLimitIssue(40, "Claude token 2", EARLIER, [held(120, "retro", null)], true)];

    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: [retro] }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan)).toContainEqual({
      kind: "drop-held-run",
      role: "retro",
      issue: 120,
      reason: expect.stringContaining("never holds a Retro run"),
    });
    expect(actionsOf(plan).filter((action) => action.kind === "start-agent-run")).toEqual([]);
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

// An Auditor run is no longer held (#268), but a marker from before that can
// still be on a weekly-limit issue, and the tick can't start the run.
describe("A held marker an Auditor run left, at the reset, with rotation on", () => {
  it("fails its pending Audit, closed as not planned with the failed marker, starting nothing", () => {
    const kitIssues = [
      weeklyLimitIssue(41, "Claude token", LATER, [held(98, "audit", null)], true),
      weeklyLimitIssue(40, "Claude token 2", EARLIER),
    ];
    const audit = anIssueHeld(98, ["fabrik:audit"], { byApp: true, body: auditBody(AUDITED_SHA, "pending") });

    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: [audit] }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan).filter((action) => "issue" in action && action.issue === 98)).toEqual([
      {
        kind: "edit-issue-body",
        issue: 98,
        body: `The Auditor's run failed: it was held while every listed Subscription was used up.\n\n<!-- fabrik:audit ${AUDITED_SHA} -->\n<!-- fabrik:audit-failed -->`,
      },
      { kind: "close", issue: 98, reason: "not_planned" },
    ]);
    expect(actionsOf(plan).filter((action) => action.kind === "start-agent-run" || action.kind === "hold-agent-run")).toEqual([]);
  });

  it("counts as dealt with on a weekly-limit issue that stays open, so a later reset fails nothing again", () => {
    const kitIssues = [
      weeklyLimitIssue(41, "Claude token", LATER, [held(98, "audit", null)], true),
      weeklyLimitIssue(40, "Claude token 2", EARLIER),
    ];
    const audit = anIssueHeld(98, ["fabrik:audit"], { byApp: true, body: auditBody(AUDITED_SHA, "pending") });

    const plan = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: [audit] }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan)).toContainEqual({
      kind: "comment",
      issue: 41,
      body: expect.stringContaining('<!-- fabrik:resumed {"issue":98,"role":"audit","held":1} -->'),
    });
  });

  it("leaves the audit gate free to open a fresh Audit on a later tick", () => {
    const kitIssues = [weeklyLimitIssue(41, "Claude token", EARLIER, [held(98, "audit", null)], true)];
    const pending = anIssueHeld(98, ["fabrik:audit"], { byApp: true, body: auditBody(AUDITED_SHA, "pending") });
    const thisWeek = anAuditIssue({ number: 98, open: true, stateReason: null, createdAt: "2026-11-08T04:00:04Z", body: pending.body });
    const head = "c0ffee5".padEnd(40, "0");

    const reset = planFor(PAST_EARLIER, tickSnapshot({ kitIssues, held: [pending], audit: { head, issues: [thisWeek] } }), TWO_SUBSCRIPTIONS);
    const edit = actionsOf(reset).find((action) => action.kind === "edit-issue-body");
    if (edit?.kind !== "edit-issue-body") throw new Error(`expected #98's body rewritten: ${JSON.stringify(reset)}`);
    const failed = { ...thisWeek, open: false, stateReason: "not_planned" as const, body: edit.body };
    const later = planFor(tick("2026-11-08T12:00:00.000Z"), tickSnapshot({ audit: { head, issues: [failed] } }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(reset).filter((action) => action.kind === "open-issue")).toEqual([]);
    expect(actionsOf(later).filter((action) => action.kind === "open-issue")).toEqual([
      expect.objectContaining({ labels: ["fabrik:audit"] }),
    ]);
  });
});
