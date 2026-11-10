import { describe, expect, it } from "vitest";
import {
  anIssue,
  aTicket,
  auditBody,
  AUDITED_SHA,
  dispatchSnapshotOf,
  kitConfig,
  notificationsOf,
  RETRO_WINDOW_END,
  retroBody,
  snapshotOf,
} from "../__fixtures__/snapshots.ts";
import { implementRunFailedIn } from "../github/threads.ts";
import { planFor } from "./rules.ts";
import type { Action, AgentRole, IssueSnapshot, KitIssueSnapshot, LoopEvent, Plan } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const TWO_SUBSCRIPTIONS = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
const RESETS_AT = "2026-11-09T04:00:00.000Z";

function killed(
  role: AgentRole,
  { issue = 7, subscription = "Claude token" }: { issue?: number; subscription?: string } = {},
): LoopEvent {
  return {
    kind: "agent-run-failed",
    role,
    issue,
    runUrl: RUN,
    jobResult: "failure",
    secretsStep: "success",
    report: { failure: "usage-credits", detail: "stopped for spending usage credits: isUsingOverage was true" },
    subscription,
  };
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${plan.kind}: ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** The issue a plan opened, as the adapter would later read it back once GitHub gave it this number. */
function kitIssueOpenedBy(plan: Plan, number: number): KitIssueSnapshot {
  const opened = actionsOf(plan).find((action) => action.kind === "open-issue");
  if (opened === undefined) throw new Error(`expected the plan to open an issue: ${JSON.stringify(plan)}`);
  return { number, labels: opened.labels, body: opened.body, comments: [] };
}

/** The usage-credits issue a kill on `subscription` opens. */
function usageCreditsIssue(number: number, subscription: string): KitIssueSnapshot {
  return kitIssueOpenedBy(
    planFor(killed("triage", { subscription }), snapshotOf(anIssue({ number: 7 })), TWO_SUBSCRIPTIONS),
    number,
  );
}

describe("A run killed for spending usage credits, with rotation on", () => {
  it("opens a ready-for-human issue to turn usage credits off on its Subscription, assigned to the Operator as its one notification", () => {
    const plan = planFor(killed("implement"), snapshotOf(anIssue({ number: 7 })), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan)).toContainEqual({
      kind: "open-issue",
      title: "Turn off usage credits on the `Claude token` Subscription",
      body: expect.stringContaining("- [ ] Turn usage credits off on the Claude account whose token is the `Claude token` item"),
      labels: ["ready-for-human", "fabrik:usage-credits"],
      assignees: ["operator"],
    });
    expect(notificationsOf(plan)).toEqual(['assign new "Turn off usage credits on the `Claude token` Subscription"']);
  });

  it("names the Subscription in the issue's marker, and says to close the issue once credits are off", () => {
    const issue = usageCreditsIssue(60, "Claude token 2");

    expect(issue.body).toContain("<!-- fabrik:subscription Claude token 2 -->");
    expect(issue.body).toContain("- [ ] Close this issue");
  });

  it("a second kill on the same Subscription comments quietly on its open issue, and opens none", () => {
    const open = usageCreditsIssue(60, "Claude token");

    const plan = planFor(
      killed("triage", { issue: 8 }),
      snapshotOf(anIssue({ number: 8 }), { kitIssues: [open] }),
      TWO_SUBSCRIPTIONS,
    );

    expect(notificationsOf(plan)).toEqual([]);
    expect(actionsOf(plan).filter((action) => action.kind === "open-issue")).toEqual([]);
    expect(actionsOf(plan)).toContainEqual({
      kind: "comment",
      issue: 60,
      body: `The Triage run on #8 was killed for spending usage credits too. [The run](${RUN})`,
    });
  });

  it("a kill on another Subscription opens that one's own issue", () => {
    const open = usageCreditsIssue(60, "Claude token");

    const plan = planFor(
      killed("triage", { issue: 8, subscription: "Claude token 2" }),
      snapshotOf(anIssue({ number: 8 }), { kitIssues: [open] }),
      TWO_SUBSCRIPTIONS,
    );

    expect(actionsOf(plan)).toContainEqual(
      expect.objectContaining({ kind: "open-issue", title: "Turn off usage credits on the `Claude token 2` Subscription" }),
    );
  });
});

/** An open weekly-limit issue on `subscription`, the one that buzzed the Operator. */
function weeklyLimitIssue(number: number, subscription: string): KitIssueSnapshot {
  return {
    number,
    labels: ["fabrik:weekly-limit"],
    body: [
      `@operator The weekly usage limit of the \`${subscription}\` Subscription is reached.`,
      "",
      "<!-- fabrik:notified -->",
      `<!-- fabrik:subscription ${subscription} -->`,
      `<!-- fabrik:resets-at ${RESETS_AT} -->`,
    ].join("\n"),
    comments: [],
  };
}

describe("A Subscription with an open usage-credits issue, with rotation on", () => {
  const start = (kitIssues: KitIssueSnapshot[]) =>
    planFor(
      { kind: "label-added", issue: 7, label: "needs-triage" },
      snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] }), { kitIssues }),
      TWO_SUBSCRIPTIONS,
    );

  it("is skipped: a run started while the issue is open is given the next listed Subscription", () => {
    const plan = start([usageCreditsIssue(60, "Claude token")]);

    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "start-agent-run", subscription: "Claude token 2" }));
  });

  it("is given runs again once the Operator closes the issue", () => {
    const plan = start([]);

    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "start-agent-run", subscription: "Claude token" }));
  });

  it("counts as unusable, so a run due while the other's weekly limit is reached is held, not started", () => {
    const plan = start([usageCreditsIssue(60, "Claude token"), weeklyLimitIssue(41, "Claude token 2")]);

    expect(actionsOf(plan).filter((action) => action.kind === "start-agent-run")).toEqual([]);
    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "hold-agent-run", role: "triage", issue: 7 }));
  });

  it("counts as unusable when the other's run is refused on its weekly limit: that run is held, and its weekly-limit issue buzzes", () => {
    const refused: LoopEvent = {
      kind: "agent-run-failed",
      role: "triage",
      issue: 7,
      runUrl: RUN,
      jobResult: "failure",
      secretsStep: "success",
      report: { failure: "weekly-limit", detail: `resets at ${RESETS_AT}`, resetsAt: RESETS_AT },
      subscription: "Claude token 2",
    };

    const plan = planFor(refused, snapshotOf(anIssue({ number: 7 }), { kitIssues: [usageCreditsIssue(60, "Claude token")] }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan).filter((action) => action.kind === "add-labels")).toEqual([]);
    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "hold-agent-run", role: "triage", issue: 7 }));
    expect(notificationsOf(plan)).toEqual([
      "mention in new \"The weekly usage limit of the `Claude token 2` Subscription is reached until 2026-11-09 04:00 UTC\"",
    ]);
  });
});

const ROLES: readonly (readonly [Exclude<AgentRole, "audit">, Partial<IssueSnapshot>, number, string])[] = [
  ["triage", { labels: ["needs-triage"] }, 7, "needs-triage"],
  ["implement", { labels: ["enhancement", "ready-for-agent"] }, 7, "agent:implement"],
  ["review", { labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }, 50, "agent:review"],
  ["design", { labels: ["enhancement", "needs-design"], designRounds: 1 }, 7, "agent:design"],
];

/** The held marker a Kit-owned issue carries for a held run. */
function heldMarker(issue: number, role: AgentRole, label: string | null, order = 1): string {
  return `<!-- fabrik:held ${JSON.stringify({ issue, role, label, order })} -->`;
}

const PENDING_AUDIT = anIssue({ number: 98, byApp: true, labels: ["fabrik:audit"], body: auditBody(AUDITED_SHA, "pending") });
const PENDING_RETRO = anIssue({ number: 120, byApp: true, labels: ["fabrik:retro"], body: retroBody(RETRO_WINDOW_END, "pending") });

describe("The killed run, with rotation on", () => {
  it.each(ROLES)(
    "a killed %s run is re-run through its trigger label while another Subscription is free, with no Ticket comment",
    (role, issue, labelled, label) => {
      const plan = planFor(killed(role), snapshotOf(anIssue({ number: 7, ...issue })), TWO_SUBSCRIPTIONS);

      expect(actionsOf(plan)).toEqual([
        { kind: "remove-label", issue: labelled, label },
        { kind: "add-labels", issue: labelled, labels: [label] },
        expect.objectContaining({ kind: "open-issue", labels: ["ready-for-human", "fabrik:usage-credits"] }),
      ]);
    },
  );

  it("the re-run starts on the next free Subscription, because the killed one's issue is now open", () => {
    const killedPlan = planFor(killed("triage"), snapshotOf(anIssue({ number: 7 })), TWO_SUBSCRIPTIONS);

    const plan = planFor(
      { kind: "label-added", issue: 7, label: "needs-triage" },
      snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] }), { kitIssues: [kitIssueOpenedBy(killedPlan, 60)] }),
      TWO_SUBSCRIPTIONS,
    );

    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "start-agent-run", subscription: "Claude token 2" }));
  });

  it("is held, with no Ticket comment, when no other Subscription is free, the held marker on the weekly-limit issue", () => {
    const plan = planFor(
      killed("implement"),
      snapshotOf(anIssue({ number: 7 }), { kitIssues: [weeklyLimitIssue(41, "Claude token 2")] }),
      TWO_SUBSCRIPTIONS,
    );

    const actions = actionsOf(plan);
    expect(actions.filter((action) => action.kind === "comment" && action.issue === 7)).toEqual([]);
    expect(actions).toContainEqual({ kind: "remove-label", issue: 7, label: "agent:implement" });
    expect(actions).toContainEqual({ kind: "hold-agent-run", role: "implement", issue: 7, label: "agent:implement", until: RESETS_AT });
    expect(actions).toContainEqual({
      kind: "comment",
      issue: 41,
      body: expect.stringContaining(heldMarker(7, "implement", "agent:implement")),
    });
    expect(actions.filter((action) => action.kind === "add-labels")).toEqual([]);
    expect(notificationsOf(plan)).toEqual(['assign new "Turn off usage credits on the `Claude token` Subscription"']);
  });

  it("a killed Auditor run fails its Audit, for the scheduled tick to try again, while another Subscription is free", () => {
    const actions = actionsOf(planFor(killed("audit", { issue: 98 }), snapshotOf(PENDING_AUDIT), TWO_SUBSCRIPTIONS));

    expect(actions).toContainEqual({ kind: "close", issue: 98, reason: "not_planned" });
    expect(actions).toContainEqual(expect.objectContaining({ kind: "open-issue", labels: ["ready-for-human", "fabrik:usage-credits"] }));
  });

  // The scheduled tick can't start an Auditor run at the reset, so an Auditor run is never held.
  it("a killed Auditor run fails its Audit too when no other Subscription is free, holding nothing", () => {
    const actions = actionsOf(
      planFor(
        killed("audit", { issue: 98 }),
        snapshotOf(PENDING_AUDIT, { kitIssues: [weeklyLimitIssue(41, "Claude token 2")] }),
        TWO_SUBSCRIPTIONS,
      ),
    );

    expect(actions).toContainEqual({ kind: "close", issue: 98, reason: "not_planned" });
    expect(actions.filter((action) => action.kind === "hold-agent-run")).toEqual([]);
    expect(JSON.stringify(actions)).not.toContain("fabrik:held");
  });

  it("a killed Retro run fails its Retro, for the scheduled tick to try again, while another Subscription is free", () => {
    const actions = actionsOf(planFor(killed("retro", { issue: 120 }), snapshotOf(PENDING_RETRO), TWO_SUBSCRIPTIONS));

    expect(actions).toContainEqual({ kind: "close", issue: 120, reason: "not_planned" });
    expect(actions).toContainEqual(expect.objectContaining({ kind: "open-issue", labels: ["ready-for-human", "fabrik:usage-credits"] }));
  });

  // The scheduled tick can't start a Retro run at the reset, so a Retro run is never held.
  it("a killed Retro run fails its Retro too when no other Subscription is free, holding nothing", () => {
    const actions = actionsOf(
      planFor(
        killed("retro", { issue: 120 }),
        snapshotOf(PENDING_RETRO, { kitIssues: [weeklyLimitIssue(41, "Claude token 2")] }),
        TWO_SUBSCRIPTIONS,
      ),
    );

    expect(actions).toContainEqual({ kind: "close", issue: 120, reason: "not_planned" });
    expect(actions).toContainEqual({
      kind: "edit-issue-body",
      issue: 120,
      body: expect.stringContaining("The Retro's run failed: its stream showed usage credits being spent on the `Claude token` Subscription"),
    });
    expect(actions).toContainEqual(expect.objectContaining({ kind: "open-issue", labels: ["ready-for-human", "fabrik:usage-credits"] }));
    expect(actions.filter((action) => action.kind === "hold-agent-run")).toEqual([]);
    expect(JSON.stringify(actions)).not.toContain("fabrik:held");
  });
});

// The glossary's Used up covers usage credits and a dead token as well as the
// weekly limit (#470): with every Subscription used up through any mix of
// them, nothing starts, so nothing is spent.
describe("Every Subscription unusable only through usage-credits issues, with rotation on", () => {
  const BOTH_KILLED = () => [usageCreditsIssue(60, "Claude token"), usageCreditsIssue(61, "Claude token 2")];
  const due = (kitIssues: KitIssueSnapshot[]) =>
    planFor(
      { kind: "label-added", issue: 7, label: "needs-triage" },
      snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] }), { kitIssues }),
      TWO_SUBSCRIPTIONS,
    );

  it("a run due is held, not started: its trigger label off, no Ticket comment, and no @-mention", () => {
    const plan = due(BOTH_KILLED());

    const actions = actionsOf(plan);
    expect(actions.filter((action) => action.kind === "start-agent-run")).toEqual([]);
    expect(actions).toContainEqual({ kind: "remove-label", issue: 7, label: "needs-triage" });
    expect(actions).toContainEqual({ kind: "hold-agent-run", role: "triage", issue: 7, label: "needs-triage", until: null });
    expect(actions.filter((action) => action.kind === "comment" && action.issue === 7)).toEqual([]);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("names it, quietly, on the most recently opened usage-credits issue, saying it resumes once a Subscription is free", () => {
    const actions = actionsOf(due(BOTH_KILLED()));

    const held = actions.find((action) => action.kind === "comment");
    expect(held).toEqual({ kind: "comment", issue: 61, body: expect.stringContaining(heldMarker(7, "triage", "needs-triage")) });
    const body = held?.kind === "comment" ? held.body : "";
    expect(body).toContain("held until a Subscription is free again");
    expect(body).toContain("once this issue, or another issue blocking a Subscription, is closed");
    expect(body).not.toContain("weekly limit");
    expect(body).not.toContain("@");
  });

  it("names it on a usage-credits issue already carrying held markers, rather than the most recently opened", () => {
    const [first, second] = BOTH_KILLED();
    const carrying = { ...first!, comments: [heldMarker(8, "triage", "needs-triage")] };

    const actions = actionsOf(due([carrying, second!]));

    expect(actions).toContainEqual({ kind: "comment", issue: 60, body: expect.stringContaining(heldMarker(7, "triage", "needs-triage", 2)) });
  });

  it("a killed run is held, with no Ticket comment, its marker in the body of the usage-credits issue its kill opens", () => {
    const plan = planFor(
      killed("implement"),
      snapshotOf(anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"] }), {
        kitIssues: [usageCreditsIssue(61, "Claude token 2")],
      }),
      TWO_SUBSCRIPTIONS,
    );

    const actions = actionsOf(plan);
    expect(actions.filter((action) => action.kind === "comment")).toEqual([]);
    expect(actions).toContainEqual({ kind: "remove-label", issue: 7, label: "agent:implement" });
    expect(actions).toContainEqual({ kind: "hold-agent-run", role: "implement", issue: 7, label: "agent:implement", until: null });
    expect(actions).toContainEqual(
      expect.objectContaining({
        kind: "open-issue",
        title: "Turn off usage credits on the `Claude token` Subscription",
        body: expect.stringContaining(heldMarker(7, "implement", "agent:implement")),
      }),
    );
    expect(notificationsOf(plan)).toEqual(['assign new "Turn off usage credits on the `Claude token` Subscription"']);
  });

  it("a killed run whose Subscription's issue is open already is held on the most recently opened one, quietly", () => {
    const plan = planFor(killed("implement"), snapshotOf(anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"] }), { kitIssues: BOTH_KILLED() }), TWO_SUBSCRIPTIONS);

    const actions = actionsOf(plan);
    expect(actions).toContainEqual({ kind: "hold-agent-run", role: "implement", issue: 7, label: "agent:implement", until: null });
    expect(actions).toContainEqual({ kind: "comment", issue: 61, body: expect.stringContaining(heldMarker(7, "implement", "agent:implement")) });
    expect(actions.filter((action) => action.kind === "comment" && action.issue === 7)).toEqual([]);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("a run held on a usage-credits issue stays there once a weekly-limit issue opens, while new holds go on the weekly-limit issue", () => {
    const [first, second] = BOTH_KILLED();
    const carrying = { ...second!, comments: [heldMarker(8, "triage", "needs-triage")] };

    const actions = actionsOf(due([first!, carrying, weeklyLimitIssue(41, "Claude token 2")]));

    expect(actions).toContainEqual({ kind: "comment", issue: 41, body: expect.stringContaining(heldMarker(7, "triage", "needs-triage", 2)) });
    expect(actions.filter((action) => action.kind === "comment" && action.issue === 61)).toEqual([]);
  });
});

describe("Scenario: an Implement run killed for spending while no other Subscription is free (#470, #472)", () => {
  // Claude token 2 is already kept off by its own usage-credits issue, so the kill can't be re-run: the run is held.
  const kill = planFor(
    killed("implement"),
    snapshotOf(anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"] }), { kitIssues: [usageCreditsIssue(61, "Claude token 2")] }),
    TWO_SUBSCRIPTIONS,
  );
  const opened = kitIssueOpenedBy(kill, 62);

  it("the next Dispatch check leaves the Ticket held, so no second run spends again", () => {
    const ticket = aTicket({ number: 7 });

    const plan = planFor({ kind: "dispatch-check" }, { ...dispatchSnapshotOf([ticket]), kitIssues: [usageCreditsIssue(61, "Claude token 2"), opened] }, TWO_SUBSCRIPTIONS);

    expect(plan).toEqual({ kind: "nothing", reason: "No Ticket can be dispatched: #7 is held" });
  });

  it("the Operator closing either usage-credits issue resumes it, giving agent:implement back", () => {
    const closing = { ...opened, comments: [] };
    const plan = planFor(
      { kind: "issue-closed", issue: 61 },
      snapshotOf(anIssue({ number: 61, labels: ["ready-for-human", "fabrik:usage-credits"] }), {
        kitIssues: [closing],
        closedKitIssue: usageCreditsIssue(61, "Claude token 2"),
        held: [{ number: 7, open: true, labels: ["enhancement", "ready-for-agent"], draft: null, byApp: false, body: "" }],
      }),
      TWO_SUBSCRIPTIONS,
    );

    expect(actionsOf(plan)).toContainEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
  });
});

describe("A run killed for spending usage credits, with one Subscription listed", () => {
  it("gets a V1 failure comment that @-mentions the Operator, and no Kit-owned issue", () => {
    const plan = planFor(killed("triage"), snapshotOf(anIssue({ number: 7 })), kitConfig());

    expect(notificationsOf(plan)).toEqual(["mention on #7"]);
    expect(actionsOf(plan).filter((action) => action.kind === "open-issue")).toEqual([]);
  });
});
