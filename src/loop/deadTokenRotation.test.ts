import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, AgentRole, IssueSnapshot, KitIssueSnapshot, LoopEvent, Plan } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const TWO_SUBSCRIPTIONS = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
const RESETS_AT = "2026-11-09T04:00:00.000Z";

function refused(
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
    report: { failure: "dead-token", detail: "authentication_failed (401)" },
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

/** The rotation issue a dead token on `subscription` opens. */
function rotationIssue(number: number, subscription: string): KitIssueSnapshot {
  return kitIssueOpenedBy(
    planFor(refused("triage", { subscription }), snapshotOf(anIssue({ number: 7 })), TWO_SUBSCRIPTIONS),
    number,
  );
}

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

const ROLES: readonly (readonly [Exclude<AgentRole, "audit" | "retro">, Partial<IssueSnapshot>, number, string])[] = [
  ["triage", { labels: ["needs-triage"] }, 7, "needs-triage"],
  ["implement", { labels: ["enhancement", "ready-for-agent"] }, 7, "agent:implement"],
  ["review", { labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }, 50, "agent:review"],
  ["design", { labels: ["enhancement", "needs-design"], designRounds: 1 }, 7, "agent:design"],
];

describe("A dead token on one Subscription, with rotation on", () => {
  it.each(ROLES)(
    "a refused %s run is re-run through its trigger label while another Subscription is free, with no Ticket comment",
    (role, issue, labelled, label) => {
      const plan = planFor(refused(role), snapshotOf(anIssue({ number: 7, ...issue })), TWO_SUBSCRIPTIONS);

      expect(actionsOf(plan)).toEqual([
        { kind: "remove-label", issue: labelled, label },
        { kind: "add-labels", issue: labelled, labels: [label] },
        expect.objectContaining({ kind: "open-issue", labels: ["ready-for-human", "fabrik:token-rotation"] }),
      ]);
    },
  );

  it("opens that Subscription's rotation issue, assigned to the Operator as its one notification, naming it in a marker", () => {
    const plan = planFor(refused("triage", { subscription: "Claude token 2" }), snapshotOf(anIssue({ number: 7 })), TWO_SUBSCRIPTIONS);
    const issue = kitIssueOpenedBy(plan, 40);

    expect(notificationsOf(plan)).toEqual(['assign new "Rotate the Claude token of the `Claude token 2` Subscription"']);
    expect(issue.body).toContain("<!-- fabrik:subscription Claude token 2 -->");
    expect(issue.body).toContain("Until this issue is closed the Kit runs no agent on that Subscription");
    expect(issue.body).toContain("- [ ] Run `claude setup-token` and save the new token, with its expiry date, in the `Claude token 2` item");
    expect(issue.body).toContain("- [ ] Close this issue, so that the Kit runs agents on that Subscription again.");
  });

  it("a dead token on another Subscription opens that one's own rotation issue, rather than commenting on the first's", () => {
    const plan = planFor(
      refused("triage", { issue: 8, subscription: "Claude token 2" }),
      snapshotOf(anIssue({ number: 8 }), { kitIssues: [rotationIssue(40, "Claude token")] }),
      TWO_SUBSCRIPTIONS,
    );

    expect(actionsOf(plan).filter((action) => action.kind === "comment" && action.issue === 40)).toEqual([]);
    expect(actionsOf(plan)).toContainEqual(
      expect.objectContaining({ kind: "open-issue", title: "Rotate the Claude token of the `Claude token 2` Subscription" }),
    );
  });

  it("a second dead token on the same Subscription comments quietly on its open issue, and opens none", () => {
    const plan = planFor(
      refused("triage", { issue: 8 }),
      snapshotOf(anIssue({ number: 8 }), { kitIssues: [rotationIssue(40, "Claude token")] }),
      TWO_SUBSCRIPTIONS,
    );

    expect(notificationsOf(plan)).toEqual([]);
    expect(actionsOf(plan).filter((action) => action.kind === "open-issue")).toEqual([]);
    expect(actionsOf(plan)).toContainEqual({
      kind: "comment",
      issue: 40,
      body: `The Triage run on #8 was refused too, on the \`Claude token\` Subscription. [The run](${RUN})`,
    });
  });

  it("the re-run starts on the next free Subscription, because the refused one's rotation issue is now open", () => {
    const plan = planFor(
      { kind: "label-added", issue: 7, label: "needs-triage" },
      snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] }), { kitIssues: [rotationIssue(40, "Claude token")] }),
      TWO_SUBSCRIPTIONS,
    );

    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "start-agent-run", subscription: "Claude token 2" }));
  });

  it("the Subscription is given runs again once the Operator closes its rotation issue", () => {
    const plan = planFor(
      { kind: "label-added", issue: 7, label: "needs-triage" },
      snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] }), { kitIssues: [] }),
      TWO_SUBSCRIPTIONS,
    );

    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "start-agent-run", subscription: "Claude token" }));
  });

  it("reads an open rotation issue that names no Subscription, as one opened before this did, as the first listed one's", () => {
    const old: KitIssueSnapshot = { number: 40, labels: ["ready-for-human", "fabrik:token-rotation"], body: "Rotate it.", comments: [] };

    const plan = planFor(
      { kind: "label-added", issue: 7, label: "needs-triage" },
      snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] }), { kitIssues: [old] }),
      TWO_SUBSCRIPTIONS,
    );

    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "start-agent-run", subscription: "Claude token 2" }));
  });

  it("is held, with no Ticket comment, when no other Subscription is free, the held marker on the weekly-limit issue", () => {
    const plan = planFor(
      refused("implement"),
      snapshotOf(anIssue({ number: 7 }), { kitIssues: [weeklyLimitIssue(41, "Claude token 2")] }),
      TWO_SUBSCRIPTIONS,
    );

    const actions = actionsOf(plan);
    expect(actions.filter((action) => action.kind === "comment" && action.issue === 7)).toEqual([]);
    expect(actions).toContainEqual({ kind: "hold-agent-run", role: "implement", issue: 7, label: "agent:implement", until: RESETS_AT });
    expect(actions).toContainEqual({ kind: "comment", issue: 41, body: expect.stringContaining("fabrik:held") });
    expect(notificationsOf(plan)).toEqual(['assign new "Rotate the Claude token of the `Claude token` Subscription"']);
  });

  it("gets the usual failure comment when no other Subscription is free and no weekly-limit issue is open to hold it on", () => {
    const plan = planFor(
      refused("implement"),
      snapshotOf(anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"] }), {
        kitIssues: [rotationIssue(41, "Claude token 2")],
      }),
      TWO_SUBSCRIPTIONS,
    );

    const actions = actionsOf(plan);
    expect(actions.filter((action) => action.kind === "hold-agent-run" || action.kind === "add-labels")).toEqual([]);
    expect(actions).toContainEqual({
      kind: "comment",
      issue: 7,
      body: expect.stringContaining("Re-add the `agent:implement` label to run it again."),
    });
  });
});
