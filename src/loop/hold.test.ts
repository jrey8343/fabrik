import { describe, expect, it } from "vitest";
import {
  aDesignQueueIssue,
  anIssue,
  aPullRequest,
  aResearchDecision,
  aTicket,
  auditBody,
  AUDITED_SHA,
  designQueueSnapshotOf,
  dispatchSnapshotOf,
  kitConfig,
  notificationsOf,
  RETRO_WINDOW_END,
  retroBody,
  snapshotOf,
  snapshotOfPullRequest,
  tickSnapshot,
} from "../__fixtures__/snapshots.ts";
import { agentRunIn } from "../github/apply.ts";
import { UI } from "../__fixtures__/uiEvidence.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { auditGate } from "./auditGate.ts";
import { planFor } from "./rules.ts";
import type { Action, AgentRole, KitIssueSnapshot, LoopEvent, Plan, Snapshot } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const TWO_SUBSCRIPTIONS = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
const EARLIER = "2026-11-08T10:00:00.000Z";
const LATER = "2026-11-09T04:00:00.000Z";

/** An open weekly-limit issue for `subscription`, the one that buzzed the Operator when `buzzed`. */
function weeklyLimitIssue(number: number, subscription: string, resetsAt: string, buzzed: boolean): KitIssueSnapshot {
  return {
    number,
    labels: ["fabrik:weekly-limit"],
    body: [
      `${buzzed ? "@operator " : ""}The weekly usage limit of the \`${subscription}\` Subscription is reached.`,
      "",
      ...(buzzed ? ["<!-- fabrik:notified -->"] : []),
      `<!-- fabrik:subscription ${subscription} -->`,
      `<!-- fabrik:resets-at ${resetsAt} -->`,
    ].join("\n"),
    comments: [],
  };
}

/** Both Subscriptions used up: the second's issue quiet, the first's the one that buzzed. */
const BOTH_USED_UP = [weeklyLimitIssue(40, "Claude token 2", EARLIER, false), weeklyLimitIssue(41, "Claude token", LATER, true)];

/** One way to start a run of each role, the issue or PR its trigger label lives on, and that label. */
const STARTS: readonly (readonly [
  AgentRole,
  string,
  (kitIssues: KitIssueSnapshot[]) => [LoopEvent, Snapshot],
  number,
  string | null,
])[] = [
  [
    "triage",
    "Triage run",
    (kitIssues) => [
      { kind: "label-added", issue: 7, label: "needs-triage" },
      snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] }), { kitIssues }),
    ],
    7,
    "needs-triage",
  ],
  [
    "design",
    "Design-session turn",
    (kitIssues) => [
      { kind: "issue-comment-created", issue: 7, commenter: "jrey", commenterIsBot: false, body: "yes", comment: 9001 },
      snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"], designRounds: 1 }), {
        operator: "jrey",
        kitIssues,
      }),
    ],
    7,
    "agent:design",
  ],
  [
    "implement",
    "Implement run",
    (kitIssues) => [
      { kind: "label-added", issue: 7, label: "agent:implement" },
      snapshotOf(anIssue({ number: 7, labels: ["enhancement", "ready-for-agent", "agent:implement"] }), { kitIssues }),
    ],
    7,
    "agent:implement",
  ],
  [
    "review",
    "Review run",
    (kitIssues) => [{ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(aPullRequest(), { kitIssues })],
    50,
    "agent:review",
  ],
  [
    "research",
    "Research run",
    (kitIssues) => [
      { kind: "label-added", issue: 12, label: "agent:research" },
      snapshotOf(
        anIssue({
          number: 12,
          labels: ["wayfinder:research", "agent:research"],
          parent: 3,
          parentIssue: { number: 3, open: true, labels: ["wayfinder:map"] },
        }),
        { kitIssues },
      ),
    ],
    12,
    "agent:research",
  ],
];

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${plan.kind}: ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** The held lines a Plan puts on an issue or PR (#471). */
function heldLinesOn(plan: Plan, issue: number): string[] {
  return actionsOf(plan).flatMap((action) =>
    action.kind === "comment" && action.issue === issue && action.body.startsWith("<!-- fabrik:on-hold") ? [action.body] : [],
  );
}

/** The held marker a weekly-limit issue's comment carries for a held run. */
function heldMarker(issue: number, role: AgentRole, label: string | null, order = 1): string {
  return `<!-- fabrik:held ${JSON.stringify({ issue, role, label, order })} -->`;
}

describe("A run due while every Subscription is used up, with rotation on", () => {
  it.each(STARTS)("a %s run is held, not started", (_role, _name, start) => {
    const [event, snapshot] = start(BOTH_USED_UP);

    expect(agentRunIn(planFor(event, snapshot, TWO_SUBSCRIPTIONS))).toBeNull();
  });

  it.each(STARTS)(
    "a %s run's trigger label comes off, the buzzing weekly-limit issue gets the held marker, and its own item one quiet held line, with no @-mention",
    (role, name, start, labelled, label) => {
      const [event, snapshot] = start(BOTH_USED_UP);

      const plan = planFor(event, snapshot, TWO_SUBSCRIPTIONS);

      expect(notificationsOf(plan)).toEqual([]);
      expect(notificationsOf(plan, "jrey")).toEqual([]);
      const actions = actionsOf(plan);
      expect(actions.filter((action) => action.kind === "comment")).toEqual([
        { kind: "comment", issue: 41, body: expect.stringContaining(heldMarker(labelled, role, label)) },
        { kind: "comment", issue: labelled, body: expect.stringContaining(`<!-- fabrik:on-hold {"role":"${role}"} -->`) },
      ]);
      const line = heldLinesOn(plan, labelled)[0] ?? "";
      expect(line).toContain(`The ${name} is held on #41: every Subscription is used up until 2026-11-08 10:00 UTC`);
      expect(line).toContain("The Kit restarts the run by itself then, so there's nothing to do.");
      expect(line).not.toContain("@");
      expect(actions).toContainEqual({
        kind: "comment",
        issue: 41,
        body: expect.stringContaining(`The ${name} on #${labelled} is held until 2026-11-08 10:00 UTC`),
      });
      const removals = actions.filter((action) => action.kind === "remove-label");
      expect(removals).toEqual(label === null ? [] : [{ kind: "remove-label", issue: labelled, label }]);
    },
  );

  it("with no reset known, the held line says so and points at closing the weekly-limit issue once runs work (#440)", () => {
    const unknown = [{ ...weeklyLimitIssue(41, "Claude token", LATER, true), body: "@operator Used up.\n\n<!-- fabrik:notified -->\n<!-- fabrik:subscription Claude token -->" }, { ...weeklyLimitIssue(40, "Claude token 2", EARLIER, false), body: "<!-- fabrik:subscription Claude token 2 -->" }];
    const [event, snapshot] = STARTS[2]![2](unknown);

    expect(heldLinesOn(planFor(event, snapshot, TWO_SUBSCRIPTIONS), 7)).toEqual([
      '<!-- fabrik:on-hold {"role":"implement"} -->\nThe Implement run is held on #41: every Subscription is used up, and the Kit doesn\'t know when the first limit resets, so it waits until a Subscription is free again. Closing #41 once agent runs work again frees one. The Kit restarts the run by itself then, so there\'s nothing to do.',
    ]);
  });

  it("names when it is held until: the earliest reset across the open weekly-limit issues", () => {
    const [event, snapshot] = STARTS[0]![2](BOTH_USED_UP);

    expect(actionsOf(planFor(event, snapshot, TWO_SUBSCRIPTIONS))).toContainEqual({
      kind: "hold-agent-run",
      role: "triage",
      issue: 7,
      label: "needs-triage",
      until: EARLIER,
    });
  });

  it("puts the held marker on the first weekly-limit issue to reset when none has buzzed", () => {
    const quiet = [weeklyLimitIssue(41, "Claude token", LATER, false), weeklyLimitIssue(40, "Claude token 2", EARLIER, false)];
    const [event, snapshot] = STARTS[0]![2](quiet);

    const plan = planFor(event, snapshot, TWO_SUBSCRIPTIONS);
    const comments = actionsOf(plan).filter((action) => action.kind === "comment" && action.issue !== 7);

    expect(comments).toEqual([{ kind: "comment", issue: 40, body: expect.stringContaining(heldMarker(7, "triage", "needs-triage")) }]);
    expect(heldLinesOn(plan, 7)).toEqual([expect.stringContaining("held on #40")]);
  });

  // The scheduled tick can't start an Auditor run at the reset, so an Audit is never held: it fails, and the tick opens the next.
  it("an Auditor run due is never held: its pending Audit fails, closed as not planned, for the tick to try again", () => {
    const audit = anIssue({ number: 98, byApp: true, labels: ["fabrik:audit"], body: auditBody(AUDITED_SHA, "pending") });

    const actions = actionsOf(planFor({ kind: "issue-opened", issue: 98 }, snapshotOf(audit, { kitIssues: BOTH_USED_UP }), TWO_SUBSCRIPTIONS));

    expect(actions).toEqual([
      {
        kind: "edit-issue-body",
        issue: 98,
        body: `The Auditor's run failed: it was due to start while every listed Subscription was used up.\n\n<!-- fabrik:audit ${AUDITED_SHA} -->\n<!-- fabrik:audit-failed -->`,
      },
      { kind: "close", issue: 98, reason: "not_planned" },
    ]);
  });

  // The scheduled tick can't start a Retro run at the reset, so a Retro is never held: it fails, and the tick opens the next.
  it("a Retro run due is never held: its pending Retro fails, closed as not planned, for the tick to try again", () => {
    const retro = anIssue({ number: 120, byApp: true, labels: ["fabrik:retro"], body: retroBody(RETRO_WINDOW_END, "pending") });

    const plan = planFor({ kind: "issue-opened", issue: 120 }, snapshotOf(retro, { kitIssues: BOTH_USED_UP }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan)).toEqual([
      {
        kind: "edit-issue-body",
        issue: 120,
        body: [
          "The Retro's run failed: it was due to start while every listed Subscription was used up.",
          "",
          `<!-- fabrik:retro ${RETRO_WINDOW_END} -->`,
          "<!-- fabrik:retro-failed -->",
        ].join("\n"),
      },
      { kind: "close", issue: 120, reason: "not_planned" },
    ]);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("starts the run as usual while one Subscription is still free", () => {
    const [event, snapshot] = STARTS[0]![2]([weeklyLimitIssue(41, "Claude token", LATER, false)]);

    expect(agentRunIn(planFor(event, snapshot, TWO_SUBSCRIPTIONS))).toEqual(
      expect.objectContaining({ role: "triage", subscription: "Claude token 2" }),
    );
  });

  it("with one Subscription listed, starts the run on it, as V1 does, while its weekly-limit issue is open", () => {
    const [event, snapshot] = STARTS[0]![2]([weeklyLimitIssue(41, "Claude token", LATER, true)]);

    expect(agentRunIn(planFor(event, snapshot, kitConfig()))).toEqual(
      expect.objectContaining({ role: "triage", subscription: "Claude token" }),
    );
  });
});

describe("Jobs with no agent in them, while every Subscription is used up", () => {
  const PLANS: readonly (readonly [string, LoopEvent, Snapshot])[] = [
    ["the Merge gate", { kind: "pull-request-left-draft", pullRequest: 50 }, snapshotOfPullRequest(aPullRequest({ draft: false }))],
    ["a Dispatch check", { kind: "dispatch-check" }, dispatchSnapshotOf([aTicket({ number: 12 })])],
    ["a Design queue check", { kind: "design-queue-check" }, designQueueSnapshotOf([aDesignQueueIssue({ number: 12 })])],
  ];

  it.each(PLANS)("%s carries on, with the Plan it has while a Subscription is free", (_, event, snapshot) => {
    const free = planFor(event, { ...snapshot, kitIssues: [] }, TWO_SUBSCRIPTIONS);

    expect(free.kind).toBe("act");
    expect(planFor(event, { ...snapshot, kitIssues: BOTH_USED_UP }, TWO_SUBSCRIPTIONS)).toEqual(free);
  });
});

// A held run's trigger label is off and no agent job runs, yet it resumes at
// the reset, so it keeps the slot it held under Dispatch's max_in_flight cap
// and the Design session cap: resuming never runs more than the caps allow.
describe("A held run, under Dispatch's max_in_flight cap and the Design session cap", () => {
  const withHeld = (snapshot: Snapshot, ...markers: string[]): Snapshot => ({
    ...snapshot,
    kitIssues: [{ ...BOTH_USED_UP[0]!, comments: markers }, BOTH_USED_UP[1]!],
  });
  const ONE_IN_FLIGHT = kitConfig({ subscriptions: ["Claude token", "Claude token 2"], maxInFlight: 1 });
  const ONE_SESSION = kitConfig({ subscriptions: ["Claude token", "Claude token 2"], caps: { ...DEFAULT_KIT_CONFIG.caps, designSessions: 1 } });

  it("a held Implement run counts as in flight, so Dispatch neither dispatches its Ticket again nor another past the cap", () => {
    const snapshot = withHeld(
      dispatchSnapshotOf([aTicket({ number: 7 }), aTicket({ number: 12 })]),
      heldMarker(7, "implement", "agent:implement"),
    );

    const plan = planFor({ kind: "dispatch-check" }, snapshot, ONE_IN_FLIGHT);

    expect(plan).toEqual({ kind: "nothing", reason: expect.stringContaining("max_in_flight is 1 and 1 are in flight") });
    expect(plan.kind === "nothing" && plan.reason).toContain("1 held");
  });

  it("a held Research run counts as in flight, so Dispatch neither releases its research Decision again nor another past the cap", () => {
    const snapshot = withHeld(
      dispatchSnapshotOf([aTicket({ number: 12 })], { researchDecisions: [aResearchDecision({ number: 7 })] }),
      heldMarker(7, "research", "agent:research"),
    );

    const plan = planFor({ kind: "dispatch-check" }, snapshot, ONE_IN_FLIGHT);

    expect(plan).toEqual({
      kind: "nothing",
      reason:
        "max_in_flight is 1 and 1 are in flight (0 open agent draft PRs, 0 Implement runs in progress, 0 dispatched and waiting, 1 held), so #12 wait",
    });
  });

  it("a held Implement run the tick has resumed frees its slot", () => {
    const snapshot = withHeld(
      dispatchSnapshotOf([aTicket({ number: 12 })]),
      heldMarker(7, "implement", "agent:implement"),
      '<!-- fabrik:resumed {"issue":7,"role":"implement","held":1} -->',
    );

    expect(actionsOf(planFor({ kind: "dispatch-check" }, snapshot, ONE_IN_FLIGHT))).toEqual([
      { kind: "add-labels", issue: 12, labels: ["agent:implement"] },
    ]);
  });

  it("a held first Design-session turn holds its Design session slot, so the queue starts no other", () => {
    const snapshot = withHeld(
      designQueueSnapshotOf([aDesignQueueIssue({ number: 7 }), aDesignQueueIssue({ number: 12 })]),
      heldMarker(7, "design", "agent:design"),
    );

    const plan = planFor({ kind: "design-queue-check" }, snapshot, ONE_SESSION);

    expect(plan).toEqual({ kind: "nothing", reason: "caps.design_sessions is 1 and #7 holds a slot, so #12 waits" });
  });
});

function refused(role: AgentRole, issue: number): Extract<LoopEvent, { kind: "agent-run-failed" }> {
  return {
    kind: "agent-run-failed",
    role,
    issue,
    runUrl: RUN,
    jobResult: "failure",
    secretsStep: "success",
    report: { failure: "weekly-limit", detail: `resets at ${LATER}`, resetsAt: LATER },
    subscription: "Claude token",
  };
}

describe("A run refused on its weekly limit while no other Subscription is free, with rotation on", () => {
  const other = weeklyLimitIssue(40, "Claude token 2", EARLIER, false);

  it("is held in place of the failure comment: its trigger label comes off, and the issue that buzzes the Operator carries the held marker", () => {
    const plan = planFor(refused("implement", 7), snapshotOf(anIssue({ number: 7 }), { kitIssues: [other] }), TWO_SUBSCRIPTIONS);

    const actions = actionsOf(plan);
    expect(notificationsOf(plan)).toEqual([
      'mention in new "The weekly usage limit of the `Claude token` Subscription is reached until 2026-11-09 04:00 UTC"',
    ]);
    // No failure comment: only the quiet held line, linking the weekly-limit issue the Plan opens.
    expect(actions.filter((action) => action.kind === "comment")).toEqual([]);
    expect(actions.filter((action) => action.kind === "comment-linking")).toEqual([
      {
        kind: "comment-linking",
        issue: 7,
        body: [
          '<!-- fabrik:on-hold {"role":"implement"} -->\nThe Implement run is held on ',
          { created: "weekly-limit" },
          ": every Subscription is used up until 2026-11-08 10:00 UTC, when the first weekly limit resets. The Kit restarts the run by itself then, so there's nothing to do.",
        ],
      },
    ]);
    expect(actions).toContainEqual(expect.objectContaining({ kind: "open-issue", key: "weekly-limit" }));
    expect(actions).toContainEqual({ kind: "remove-label", issue: 7, label: "agent:implement" });
    expect(actions).toContainEqual({ kind: "hold-agent-run", role: "implement", issue: 7, label: "agent:implement", until: EARLIER });
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "open-issue", body: expect.stringContaining(heldMarker(7, "implement", "agent:implement")) }),
    );
  });

  it("a refused Review is held through agent:review on its PR", () => {
    const plan = planFor(
      refused("review", 7),
      snapshotOf(anIssue({ number: 7, openPullRequests: [50] }), { kitIssues: [other] }),
      TWO_SUBSCRIPTIONS,
    );

    expect(actionsOf(plan)).toContainEqual({ kind: "remove-label", issue: 50, label: "agent:review" });
    expect(actionsOf(plan)).toContainEqual(
      expect.objectContaining({ kind: "open-issue", body: expect.stringContaining(heldMarker(50, "review", "agent:review")) }),
    );
  });

  it("comments the held marker on the issue that already buzzed, quietly", () => {
    const buzzed = weeklyLimitIssue(41, "Claude token", LATER, true);

    const plan = planFor(refused("triage", 8), snapshotOf(anIssue({ number: 8 }), { kitIssues: [other, buzzed] }), TWO_SUBSCRIPTIONS);

    expect(notificationsOf(plan)).toEqual([]);
    expect(actionsOf(plan)).toContainEqual({
      kind: "comment",
      issue: 41,
      body: expect.stringContaining(heldMarker(8, "triage", "needs-triage")),
    });
    expect(heldLinesOn(plan, 8)).toEqual([expect.stringContaining("The Triage run is held on #41")]);
  });

  it("comments the held marker on the other Subscription's issue when that one buzzed", () => {
    const buzzedOther = weeklyLimitIssue(40, "Claude token 2", EARLIER, true);

    const withOther = planFor(refused("triage", 8), snapshotOf(anIssue({ number: 8 }), { kitIssues: [buzzedOther] }), TWO_SUBSCRIPTIONS);

    expect(notificationsOf(withOther)).toEqual([]);
    expect(actionsOf(withOther)).toContainEqual({
      kind: "comment",
      issue: 40,
      body: expect.stringContaining(heldMarker(8, "triage", "needs-triage")),
    });
  });
});

// Whether a session's prototype turn has started is marked on its request's comment (#155), so a resumed
// agent:design starts again the turn that was held: the prototype turn until it has started, an ordinary turn after.
describe("A Design session's prototype turn, while every Subscription is used up, with rotation on", () => {
  const request = { route: "/book", variants: 3, brief: "- **A**: a form.\n- **B**: a stepper." };
  const session = (started: boolean, kitIssues: KitIssueSnapshot[]) =>
    snapshotOf(
      anIssue({
        number: 7,
        labels: ["enhancement", "needs-design", "agent:design"],
        designRounds: 1,
        pendingPrototype: { request, reply: null, comment: 9010, started },
      }),
      { operator: "jrey", kitIssues },
    );
  const config = kitConfig({ ...TWO_SUBSCRIPTIONS, ui: UI });

  it("is held when due without marking its request started, so the reset's agent:design starts the prototype turn", () => {
    const plan = planFor({ kind: "label-added", issue: 7, label: "agent:design" }, session(false, BOTH_USED_UP), config);

    expect(agentRunIn(plan)).toBeNull();
    expect(actionsOf(plan)).toContainEqual({ kind: "hold-agent-run", role: "design", issue: 7, label: "agent:design", until: EARLIER });
    expect(actionsOf(plan).filter((action) => action.kind === "mark-prototype-request")).toEqual([]);
  });

  it("refused while none is free, is held with its request marked waiting again, so the reset's agent:design starts the prototype turn", () => {
    const plan = planFor({ ...refused("design", 7), prototype: true }, session(true, [weeklyLimitIssue(40, "Claude token 2", EARLIER, false)]), config);

    expect(actionsOf(plan)).toContainEqual({ kind: "hold-agent-run", role: "design", issue: 7, label: "agent:design", until: EARLIER });
    expect(actionsOf(plan).filter((action) => action.kind === "mark-prototype-request")).toEqual([
      { kind: "mark-prototype-request", issue: 7, comment: 9010, started: false },
    ]);
  });

  it("an ordinary turn of the session refused while none is free leaves the request's mark as it is", () => {
    const plan = planFor(refused("design", 7), session(true, [weeklyLimitIssue(40, "Claude token 2", EARLIER, false)]), config);

    expect(actionsOf(plan)).toContainEqual({ kind: "hold-agent-run", role: "design", issue: 7, label: "agent:design", until: EARLIER });
    expect(actionsOf(plan).filter((action) => action.kind === "mark-prototype-request")).toEqual([]);
  });
});

// An Auditor run has no trigger label to re-run it through, and the scheduled
// tick can't start one at the reset, so it's never re-run or held: its Audit
// fails, and the tick opens the next one.
describe("An Auditor run refused on its weekly limit, with rotation on", () => {
  const audit = anIssue({ number: 98, byApp: true, labels: ["fabrik:audit"], body: auditBody(AUDITED_SHA, "pending") });
  const failed = [
    {
      kind: "edit-issue-body",
      issue: 98,
      body: `The Auditor's run failed: it hit the weekly usage limit. [The run](${RUN})\n\n<!-- fabrik:audit ${AUDITED_SHA} -->\n<!-- fabrik:audit-failed -->`,
    },
    { kind: "close", issue: 98, reason: "not_planned" },
  ];

  it.each([
    ["while no other Subscription is free", [weeklyLimitIssue(40, "Claude token 2", EARLIER, false)]],
    ["while another Subscription is free", []],
  ])("fails its Audit %s, holding nothing, and its Subscription's weekly-limit issue names the run", (_, kitIssues) => {
    const actions = actionsOf(planFor(refused("audit", 98), snapshotOf(audit, { kitIssues }), TWO_SUBSCRIPTIONS));

    expect(actions.filter((action) => "issue" in action && action.issue === 98)).toEqual(failed);
    expect(actions.filter((action) => action.kind === "hold-agent-run")).toEqual([]);
    expect(JSON.stringify(actions)).not.toContain("fabrik:held");
    expect(actions).toContainEqual(
      expect.objectContaining({
        kind: "open-issue",
        labels: ["fabrik:weekly-limit"],
        body: expect.stringContaining("<!-- fabrik:subscription Claude token -->"),
      }),
    );
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "open-issue", body: expect.stringContaining("The Audit run on #98") }),
    );
  });

  it("an Audit that's no longer pending holds nothing, even while none is free, and its failed run changes nothing", () => {
    const filled = anIssue({ number: 98, byApp: true, labels: ["fabrik:audit"], body: auditBody(AUDITED_SHA, "filled") });
    const other = weeklyLimitIssue(40, "Claude token 2", EARLIER, false);

    const plan = planFor(refused("audit", 98), snapshotOf(filled, { kitIssues: [other] }), TWO_SUBSCRIPTIONS);

    expect(plan.kind === "act" ? plan.actions.filter((action) => action.kind === "hold-agent-run") : []).toEqual([]);
    expect(plan.kind === "act" ? plan.actions.filter((action) => "issue" in action && action.issue === 98) : []).toEqual([]);
  });

  it("with one Subscription listed, fails its Audit as V1 does", () => {
    const actions = actionsOf(planFor(refused("audit", 98), snapshotOf(audit), kitConfig()));

    expect(actions).toContainEqual({ kind: "close", issue: 98, reason: "not_planned" });
  });
});

// A Retro run has no trigger label to re-run it through, and the scheduled
// tick can't start one at the reset, so it's never re-run or held: its Retro
// fails, and the tick opens the next one.
describe("A Retro run refused on its weekly limit, with rotation on", () => {
  const retro = anIssue({ number: 120, byApp: true, labels: ["fabrik:retro"], body: retroBody(RETRO_WINDOW_END, "pending") });
  const failed = [
    {
      kind: "edit-issue-body",
      issue: 120,
      body: `The Retro's run failed: it hit the weekly usage limit. [The run](${RUN})\n\n<!-- fabrik:retro ${RETRO_WINDOW_END} -->\n<!-- fabrik:retro-failed -->`,
    },
    { kind: "close", issue: 120, reason: "not_planned" },
  ];

  it.each([
    ["while no other Subscription is free", [weeklyLimitIssue(40, "Claude token 2", EARLIER, false)]],
    ["while another Subscription is free", []],
  ])("fails its Retro %s, holding nothing, and its Subscription's weekly-limit issue names the run", (_, kitIssues) => {
    const actions = actionsOf(planFor(refused("retro", 120), snapshotOf(retro, { kitIssues }), TWO_SUBSCRIPTIONS));

    expect(actions.filter((action) => "issue" in action && action.issue === 120)).toEqual(failed);
    expect(actions.filter((action) => action.kind === "hold-agent-run")).toEqual([]);
    expect(JSON.stringify(actions)).not.toContain("fabrik:held");
    expect(actions).toContainEqual(
      expect.objectContaining({
        kind: "open-issue",
        labels: ["fabrik:weekly-limit"],
        body: expect.stringContaining("<!-- fabrik:subscription Claude token -->"),
      }),
    );
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "open-issue", body: expect.stringContaining("The Retro run on #120") }),
    );
  });

  it("a Retro that's no longer pending holds nothing, even while none is free, and its failed run changes nothing", () => {
    const filled = anIssue({ number: 120, byApp: true, labels: ["fabrik:retro"], body: retroBody(RETRO_WINDOW_END, "filled") });
    const other = weeklyLimitIssue(40, "Claude token 2", EARLIER, false);

    const plan = planFor(refused("retro", 120), snapshotOf(filled, { kitIssues: [other] }), TWO_SUBSCRIPTIONS);

    expect(plan.kind === "act" ? plan.actions.filter((action) => action.kind === "hold-agent-run") : []).toEqual([]);
    expect(plan.kind === "act" ? plan.actions.filter((action) => "issue" in action && action.issue === 120) : []).toEqual([]);
  });

  it("with one Subscription listed, fails its Retro as V1 does", () => {
    const actions = actionsOf(planFor(refused("retro", 120), snapshotOf(retro), kitConfig()));

    expect(actions).toContainEqual({ kind: "close", issue: 120, reason: "not_planned" });
  });
});

// Like the Retro's (src/loop/retroGate.test.ts): the Audit is held back only
// while no Subscription is free, rotation on or off (#442).
describe("The Audit due while a Subscription's weekly-limit issue is open, with rotation on", () => {
  const SUNDAY = "2026-11-08T04:00:00.000Z";
  const HEAD = "c0ffee5".padEnd(40, "0");
  const snapshotWith = (kitIssues: KitIssueSnapshot[]) => tickSnapshot({ kitIssues, audit: { head: HEAD, issues: [] } });
  const opened = (kitIssues: KitIssueSnapshot[], config = TWO_SUBSCRIPTIONS) =>
    actionsOf(planFor({ kind: "scheduled-tick", now: SUNDAY }, snapshotWith(kitIssues), config)).filter((action) => action.kind === "open-issue");

  it("opens the pending Audit while another Subscription is free", () => {
    expect(opened([weeklyLimitIssue(41, "Claude token", LATER, false)])).toEqual([expect.objectContaining({ labels: ["fabrik:audit"] })]);
  });

  it("opens nothing while every Subscription is used up", () => {
    expect(opened(BOTH_USED_UP)).toEqual([]);
  });

  it("gives no free Subscription as its reason while every one is used up, noting the wait on the Carrier", () => {
    const plan = auditGate(SUNDAY, snapshotWith(BOTH_USED_UP), TWO_SUBSCRIPTIONS);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 41,
          body: "This week's Audit waits for a free Subscription.\n\n<!-- fabrik:weekly-run-waiting audit 2026-11-02 -->",
        },
      ],
      notes: ["No Subscription is free, so the Audit waits for one"],
    });
  });

  it("opens on the tick that closes the last weekly-limit issue at its reset", () => {
    expect(opened([weeklyLimitIssue(41, "Claude token", "2026-11-08T03:00:00.000Z", false)])).toEqual([
      expect.objectContaining({ labels: ["fabrik:audit"] }),
    ]);
  });

  it("with one Subscription listed, waits for the reset, as V1 does", () => {
    expect(opened([weeklyLimitIssue(41, "Claude token", LATER, true)], kitConfig())).toEqual([]);
  });
});

describe("A Request-changes run held while every Subscription is used up (#341)", () => {
  /** PR #50 for Ticket #7, passed and at the Merge gate, with the Operator's Request changes 777 on it from 05:00. */
  const atMergeGate = () =>
    aPullRequest({
      draft: false,
      verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: "a".repeat(40) }],
      unbuiltChangesRequests: [{ review: 777, reviewer: "operator", reviewerIsBot: false, submittedAt: "2026-11-08T05:00:00.000Z" }],
    });
  const noteIn = (plan: Plan): string =>
    (plan.kind === "act" ? plan.actions : []).flatMap((action) => (action.kind === "comment" && action.issue === 50 ? [action.body] : []))[0] ?? "";

  it("says on the PR, as the delivered review's run is noted, that it starts once the weekly limit resets, naming the issue it's held on", () => {
    const snapshot = { ...snapshotOfPullRequest(atMergeGate()), kitIssues: BOTH_USED_UP };
    const event: LoopEvent = { kind: "pull-request-changes-requested", pullRequest: 50, review: 777, reviewer: "operator", reviewerIsBot: false };

    const note = noteIn(planFor(event, snapshot, TWO_SUBSCRIPTIONS));

    expect(note).toContain("held on #41");
    expect(note).not.toContain("is starting");
  });

  it("says so too in the note for one GitHub never delivered", () => {
    const now = "2026-11-08T06:00:00.000Z";
    const snapshot = tickSnapshot({
      kitIssues: BOTH_USED_UP,
      conflicts: { main: "9".repeat(40), now, implementJobUnderWay: null, pullRequests: [{ pullRequest: atMergeGate(), mergeable: false }] },
    });

    const note = noteIn(planFor({ kind: "scheduled-tick", now }, snapshot, TWO_SUBSCRIPTIONS));

    expect(note).toContain("held on #41");
    expect(note).not.toContain("is starting");
  });
});

describe("A note promising a run while every Subscription is used up says it's held, not starting now (#436)", () => {
  const MOVED = "b".repeat(40);
  const commentsIn = (plan: Plan, issue: number): string =>
    (plan.kind === "act" ? plan.actions : []).flatMap((action) => (action.kind === "comment" && action.issue === issue ? [action.body] : [])).join("\n");
  const flaw: LoopEvent = {
    kind: "review-run-finished",
    pullRequest: 50,
    headSha: "a".repeat(40),
    output: "verdict: execution-flaw\n\nThe empty-cart case throws.",
    runUrl: RUN,
    repoUrl: "https://github.com/acme/shop",
  };
  const heldNote = "Every Subscription is used up, so it's held on #41 until then.";

  it("an Execution flaw's Verdict says its Retry starts once the weekly limit resets, naming the issue it's held on", () => {
    const pullRequest = aPullRequest({ headSha: "a".repeat(40) });
    const note = commentsIn(planFor(flaw, snapshotOfPullRequest(pullRequest, { kitIssues: BOTH_USED_UP }), TWO_SUBSCRIPTIONS), 50);

    expect(note).toContain("Retry 1 of 2 starts once the weekly limit resets: the Implementer fixes these findings on the same branch.");
    expect(note).toContain(heldNote);
    expect(note).not.toContain("starts now");
  });

  // The Verdict is left as it words the hold; the Retry still gets its own held line, on the PR (#471).
  it("an Execution flaw's Retry gets its own held line on the PR, beside a Verdict that reads as before", () => {
    const pullRequest = aPullRequest({ headSha: "a".repeat(40) });
    const verdict = commentsIn(planFor(flaw, snapshotOfPullRequest(pullRequest, { kitIssues: BOTH_USED_UP }), TWO_SUBSCRIPTIONS), 50);
    expect(verdict).toContain(heldNote);
    expect(verdict).not.toContain("fabrik:on-hold");

    // The Verdict re-adds agent:implement, whose Retry is held as it falls due.
    const flawed = aPullRequest({ verdicts: [{ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "a".repeat(40) }], headSha: "a".repeat(40) });
    const ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent", "agent:implement"], openPullRequests: [50] });
    const plan = planFor({ kind: "label-added", issue: 7, label: "agent:implement" }, snapshotOf(ticket, { pullRequest: flawed, kitIssues: BOTH_USED_UP }), TWO_SUBSCRIPTIONS);

    expect(heldLinesOn(plan, 50)).toEqual([
      expect.stringContaining("The Implement run (Retry 1 of 2) is held on #41: every Subscription is used up until 2026-11-08 10:00 UTC"),
    ]);
    expect(heldLinesOn(plan, 7)).toEqual([]);
    expect(commentsIn(plan, 41)).toContain('<!-- fabrik:held {"issue":7,"role":"implement","label":"agent:implement","order":1,"line":50} -->');
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("an Execution flaw that gives way to the Operator's unbuilt Request changes says its run is held too", () => {
    const pullRequest = aPullRequest({
      headSha: "a".repeat(40),
      unbuiltChangesRequests: [{ review: 777, reviewer: "operator", reviewerIsBot: false, submittedAt: "2026-11-08T05:00:00.000Z" }],
    });
    const note = commentsIn(planFor(flaw, snapshotOfPullRequest(pullRequest, { kitIssues: BOTH_USED_UP }), TWO_SUBSCRIPTIONS), 50);

    expect(note).toContain("its Request-changes run starts once the weekly limit resets");
    expect(note).toContain(heldNote);
    expect(note).not.toContain("starts now");
  });

  it("a pass that gives way to the Operator's Request changes deferred while the Retry worked says its run is held too", () => {
    const pass: LoopEvent = { ...flaw, output: "verdict: pass\n\nIt totals the cart." };
    const pullRequest = aPullRequest({
      headSha: "a".repeat(40),
      unbuiltChangesRequests: [{ review: 777, reviewer: "operator", reviewerIsBot: false, submittedAt: "2026-11-08T05:00:00.000Z" }],
      notedChangesRequests: [777],
      deferredChangesRequests: [777],
    });
    const note = commentsIn(planFor(pass, snapshotOfPullRequest(pullRequest, { kitIssues: BOTH_USED_UP }), TWO_SUBSCRIPTIONS), 50);

    expect(note).toContain("Its Request-changes run starts once the weekly limit resets, on the Step-up model");
    expect(note).toContain(heldNote);
    expect(note).not.toContain("starts now");
  });

  it("a Request-changes run whose review was dismissed while it worked says the run it hands to the Operator's other review is held", () => {
    const dropped: LoopEvent = {
      kind: "implement-run-finished",
      issue: 7,
      output: JSON.stringify({ title: "Handle the empty cart", summary: "Shows the empty state.", fix: "Built the banner.", reviewMiss: false, amendsTicket: true }),
      branch: "fabrik/ticket-7",
      base: "fabrik/ticket-7",
      changes: { net: [{ path: "src/cart.ts" }], commits: [] },
      fixes: { pullRequest: 50, headSha: "a".repeat(40), runUrl: RUN, review: 777 },
      runUrl: RUN,
    };
    const pullRequest = aPullRequest({
      headSha: "a".repeat(40),
      notedChangesRequests: [777, 888],
      unbuiltChangesRequests: [{ review: 888, reviewer: "operator", reviewerIsBot: false, submittedAt: "2026-11-08T05:00:00.000Z" }],
    });
    const ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] });
    const snapshot = { ...snapshotOfPullRequest(pullRequest, { kitIssues: BOTH_USED_UP }), issue: ticket };
    const note = commentsIn(planFor(dropped, snapshot, TWO_SUBSCRIPTIONS), 50);

    expect(note).toContain("in flight instead, but every Subscription is used up, so it's held on #41 until the weekly limit resets, and starts then.");
    expect(note).not.toContain("is starting");
  });

  it("an empty diff says its retry starts once the weekly limit resets", () => {
    const empty: LoopEvent = {
      kind: "implement-run-finished",
      issue: 7,
      output: JSON.stringify({ title: "Let patients join a waitlist", summary: "Nothing to do." }),
      branch: "fabrik/ticket-7",
      base: "main",
      changes: { net: [], commits: [] },
      runUrl: RUN,
    };
    const ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"] });
    const note = commentsIn(planFor(empty, snapshotOf(ticket, { kitIssues: BOTH_USED_UP }), TWO_SUBSCRIPTIONS), 7);

    expect(note).toContain("retry 1 of 2 starts once the weekly limit resets.");
    expect(note).toContain(heldNote);
    expect(note).not.toContain("starts now");
  });

  it("a Retry that committed nothing gets a Verdict saying the next Retry starts once the weekly limit resets", () => {
    const empty: LoopEvent = {
      kind: "implement-run-finished",
      issue: 7,
      output: JSON.stringify({ title: "Handle the empty cart", summary: "Nothing to change.", fix: "Nothing to change." }),
      branch: "fabrik/ticket-7",
      base: "fabrik/ticket-7",
      changes: { net: [], commits: [] },
      fixes: { pullRequest: 50, headSha: "a".repeat(40), runUrl: RUN },
      runUrl: RUN,
    };
    const pullRequest = aPullRequest({
      headSha: "a".repeat(40),
      verdicts: [{ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "a".repeat(40) }],
    });
    const ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] });
    const snapshot = { ...snapshotOfPullRequest(pullRequest, { kitIssues: BOTH_USED_UP }), issue: ticket };
    const note = commentsIn(planFor(empty, snapshot, TWO_SUBSCRIPTIONS), 50);

    expect(note).toContain("Retry 2 of 2 starts once the weekly limit resets");
    expect(note).toContain(heldNote);
    expect(note).not.toContain("starts now");
  });

  it("a Retry whose commits conflicted with its moved branch says it starts again once the weekly limit resets", () => {
    const retried: LoopEvent = {
      kind: "implement-run-finished",
      issue: 7,
      output: JSON.stringify({ title: "Handle the empty cart", summary: "Shows the empty state.", fix: "Guards the empty cart." }),
      branch: "fabrik/ticket-7",
      base: "fabrik/ticket-7",
      changes: { net: [], commits: [], rebase: { onto: MOVED, conflicted: true } },
      fixes: { pullRequest: 50, headSha: "a".repeat(40), runUrl: RUN },
      runUrl: RUN,
    };
    const pullRequest = aPullRequest({
      headSha: MOVED,
      verdicts: [{ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "a".repeat(40) }],
    });
    const ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] });
    const snapshot = { ...snapshotOfPullRequest(pullRequest, { kitIssues: BOTH_USED_UP }), issue: ticket };
    const note = commentsIn(planFor(retried, snapshot, TWO_SUBSCRIPTIONS), 50);

    expect(note).toContain("Retry 1 of 2 starts again on bbbbbbb once the weekly limit resets, using no retry.");
    expect(note).toContain(heldNote);
  });

  it("the conflict check's note starting a conflict-only run says it starts once the weekly limit resets", () => {
    const now = "2026-11-08T06:00:00.000Z";
    const atMergeGate = aPullRequest({ draft: false, verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: "a".repeat(40) }] });
    const snapshot = tickSnapshot({
      kitIssues: BOTH_USED_UP,
      conflicts: { main: "9".repeat(40), now, implementJobUnderWay: null, pullRequests: [{ pullRequest: atMergeGate, mergeable: false }] },
    });
    const plan = planFor({ kind: "scheduled-tick", now }, snapshot, TWO_SUBSCRIPTIONS);
    const rebase = (plan.kind === "act" ? plan.actions : []).find((action) => action.kind === "rebase-onto-main");
    const note = rebase?.kind === "rebase-onto-main" ? commentsIn({ kind: "act", actions: [...rebase.conflicted] }, 50) : "";

    expect(note).toContain("A conflict-only Implementer run starts once the weekly limit resets, on the Step-up model:");
    expect(note).toContain(heldNote);
    expect(note).not.toContain("starts now");
  });
});
