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
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
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
    "Triage",
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
    "Implement",
    (kitIssues) => [
      { kind: "label-added", issue: 7, label: "agent:implement" },
      snapshotOf(anIssue({ number: 7, labels: ["enhancement", "ready-for-agent", "agent:implement"] }), { kitIssues }),
    ],
    7,
    "agent:implement",
  ],
  [
    "review",
    "Review",
    (kitIssues) => [{ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(aPullRequest(), { kitIssues })],
    50,
    "agent:review",
  ],
  [
    "audit",
    "Audit",
    (kitIssues) => [
      { kind: "issue-opened", issue: 98 },
      snapshotOf(anIssue({ number: 98, byApp: true, labels: ["fabrik:audit"], body: auditBody(AUDITED_SHA, "pending") }), {
        kitIssues,
      }),
    ],
    98,
    null,
  ],
  [
    "research",
    "Research",
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
    "a %s run's trigger label comes off, and the buzzing weekly-limit issue gets the held marker, with no Ticket comment and no @-mention",
    (role, name, start, labelled, label) => {
      const [event, snapshot] = start(BOTH_USED_UP);

      const plan = planFor(event, snapshot, TWO_SUBSCRIPTIONS);

      expect(notificationsOf(plan)).toEqual([]);
      expect(notificationsOf(plan, "jrey")).toEqual([]);
      const actions = actionsOf(plan);
      expect(actions.filter((action) => action.kind === "comment")).toEqual([
        { kind: "comment", issue: 41, body: expect.stringContaining(heldMarker(labelled, role, label)) },
      ]);
      expect(actions).toContainEqual({
        kind: "comment",
        issue: 41,
        body: expect.stringContaining(`The ${name} run on #${labelled} is held until 2026-11-08 10:00 UTC`),
      });
      const removals = actions.filter((action) => action.kind === "remove-label");
      expect(removals).toEqual(label === null ? [] : [{ kind: "remove-label", issue: labelled, label }]);
    },
  );

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

    const comments = actionsOf(planFor(event, snapshot, TWO_SUBSCRIPTIONS)).filter((action) => action.kind === "comment");

    expect(comments).toEqual([{ kind: "comment", issue: 40, body: expect.stringContaining(heldMarker(7, "triage", "needs-triage")) }]);
  });

  it("a held Auditor run leaves its pending Audit as it is", () => {
    const [event, snapshot] = STARTS[4]![2](BOTH_USED_UP);

    const actions = actionsOf(planFor(event, snapshot, TWO_SUBSCRIPTIONS));

    expect(actions.filter((action) => "issue" in action && action.issue === 98 && action.kind !== "hold-agent-run")).toEqual([]);
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

    const plan = planFor({ kind: "dispatch-check" }, snapshot, ONE_IN_FLIGHT, { researchDispatch: true });

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

function refused(role: AgentRole, issue: number): LoopEvent {
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
    expect(actions.filter((action) => action.kind === "comment")).toEqual([]);
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
    expect(actionsOf(plan).filter((action) => action.kind === "comment" && action.issue === 8)).toEqual([]);
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

describe("An Auditor run refused on its weekly limit, with rotation on", () => {
  const audit = anIssue({ number: 98, byApp: true, labels: ["fabrik:audit"], body: auditBody(AUDITED_SHA, "pending") });

  it("is held while none is free, leaving its Audit pending, not failed", () => {
    const other = weeklyLimitIssue(40, "Claude token 2", EARLIER, false);

    const actions = actionsOf(planFor(refused("audit", 98), snapshotOf(audit, { kitIssues: [other] }), TWO_SUBSCRIPTIONS));

    expect(actions.filter((action) => "issue" in action && action.issue === 98 && action.kind !== "hold-agent-run")).toEqual([]);
    expect(actions).toContainEqual({ kind: "hold-agent-run", role: "audit", issue: 98, label: null, until: EARLIER });
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "open-issue", body: expect.stringContaining(heldMarker(98, "audit", null)) }),
    );
  });

  it("is held, not failed, even while another Subscription is free, on its Subscription's quiet issue", () => {
    const actions = actionsOf(planFor(refused("audit", 98), snapshotOf(audit), TWO_SUBSCRIPTIONS));

    expect(actions.filter((action) => "issue" in action && action.issue === 98 && action.kind !== "hold-agent-run")).toEqual([]);
    expect(actions).toContainEqual({ kind: "hold-agent-run", role: "audit", issue: 98, label: null, until: LATER });
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "open-issue", body: expect.stringContaining(heldMarker(98, "audit", null)) }),
    );
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

describe("The Audit due while a Subscription's weekly-limit issue is open, with rotation on", () => {
  const SUNDAY = "2026-11-08T04:00:00.000Z";
  const HEAD = "c0ffee5".padEnd(40, "0");
  const opened = (kitIssues: KitIssueSnapshot[], config = TWO_SUBSCRIPTIONS) =>
    actionsOf(
      planFor({ kind: "scheduled-tick", now: SUNDAY }, tickSnapshot({ kitIssues, audit: { head: HEAD, issues: [] } }), config),
    ).filter((action) => action.kind === "open-issue");

  it("opens while another Subscription is free, so its Auditor run starts there", () => {
    expect(opened([weeklyLimitIssue(41, "Claude token", LATER, false)])).toHaveLength(1);
  });

  it("opens while every Subscription is used up, so its Auditor run is held on the pending Audit", () => {
    expect(opened(BOTH_USED_UP)).toHaveLength(1);
  });

  it("with one Subscription listed, waits for the reset, as V1 does", () => {
    expect(opened([weeklyLimitIssue(41, "Claude token", LATER, true)], kitConfig())).toEqual([]);
  });
});
