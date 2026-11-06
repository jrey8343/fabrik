import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, notificationsOf, snapshotOf, tickSnapshot } from "../__fixtures__/snapshots.ts";
import { UI } from "../__fixtures__/uiEvidence.ts";
import { planFor } from "./rules.ts";
import type { AgentRole, IssueSnapshot, KitIssueSnapshot, LoopEvent, Plan } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const TWO_SUBSCRIPTIONS = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
const RESETS_AT = "2026-11-09T04:00:00.000Z";
const EARLIER = "2026-11-08T10:00:00.000Z";

function refused(
  role: Exclude<AgentRole, "audit">,
  { issue = 7, subscription = "Claude token", resetsAt = RESETS_AT }: { issue?: number; subscription?: string; resetsAt?: string } = {},
): LoopEvent {
  return {
    kind: "agent-run-failed",
    role,
    issue,
    runUrl: RUN,
    jobResult: "failure",
    secretsStep: "success",
    report: { failure: "weekly-limit", detail: `resets at ${resetsAt}`, resetsAt },
    subscription,
  };
}

/** The issue a plan opened, as the adapter would later read it back once GitHub gave it this number. */
function kitIssueOpenedBy(plan: Plan, number: number, comments: readonly string[] = []): KitIssueSnapshot {
  const opened = plan.kind === "act" ? plan.actions.find((action) => action.kind === "open-issue") : undefined;
  if (opened === undefined) throw new Error(`expected the plan to open an issue: ${JSON.stringify(plan)}`);
  return { number, labels: opened.labels, body: opened.body, comments };
}

/** The weekly-limit issue a refusal on `subscription` opens while the other Subscription is free. */
function quietIssue(number: number, subscription: string, resetsAt = RESETS_AT): KitIssueSnapshot {
  return kitIssueOpenedBy(
    planFor(refused("triage", { subscription, resetsAt }), snapshotOf(anIssue({ number: 7 })), TWO_SUBSCRIPTIONS),
    number,
  );
}

function actionsOf(plan: Plan) {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${plan.kind}: ${JSON.stringify(plan)}`);
  return plan.actions;
}

const ROLES: readonly (readonly [Exclude<AgentRole, "audit">, Partial<IssueSnapshot>, number, string])[] = [
  ["triage", { labels: ["needs-triage"] }, 7, "needs-triage"],
  ["implement", { labels: ["enhancement", "ready-for-agent"] }, 7, "agent:implement"],
  ["review", { labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }, 50, "agent:review"],
  ["design", { labels: ["enhancement", "needs-design"], designRounds: 1 }, 7, "agent:design"],
];

describe("A run refused on its Subscription's weekly limit, with rotation on", () => {
  it.each(ROLES)(
    "a %s run is re-run through its trigger label while another Subscription is free, with no Ticket comment and no @-mention",
    (role, issue, labelled, label) => {
      const plan = planFor(refused(role), snapshotOf(anIssue({ number: 7, ...issue })), TWO_SUBSCRIPTIONS);

      expect(notificationsOf(plan)).toEqual([]);
      expect(actionsOf(plan)).toEqual([
        { kind: "remove-label", issue: labelled, label },
        { kind: "add-labels", issue: labelled, labels: [label] },
        expect.objectContaining({ kind: "open-issue" }),
      ]);
    },
  );

  it("opens the refused Subscription's weekly-limit issue silently, naming the Subscription in its title, body and marker", () => {
    const plan = planFor(refused("implement"), snapshotOf(anIssue({ number: 7 })), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan)[2]).toEqual({
      kind: "open-issue",
      title: "The weekly usage limit of the `Claude token` Subscription is reached until 2026-11-09 04:00 UTC",
      body: expect.stringMatching(/^The Implement run on #7 hit the weekly usage limit of the `Claude token` Subscription\./),
      labels: ["fabrik:weekly-limit"],
      assignees: [],
    });
    const issue = kitIssueOpenedBy(plan, 41);
    expect(issue.body).toContain("<!-- fabrik:subscription Claude token -->");
    expect(issue.body).toContain(`<!-- fabrik:resets-at ${RESETS_AT} -->`);
  });

  it("the re-run starts on the next free Subscription, because the refused one's issue is now open", () => {
    const limit = quietIssue(41, "Claude token");

    const plan = planFor(
      { kind: "label-added", issue: 7, label: "needs-triage" },
      snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] }), { kitIssues: [limit] }),
      TWO_SUBSCRIPTIONS,
    );

    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "start-agent-run", subscription: "Claude token 2" }));
  });

  it("agent:design re-added after a refused Design-session turn starts that turn again", () => {
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design", "agent:design"], designRounds: 2 });

    const plan = planFor(
      { kind: "label-added", issue: 7, label: "agent:design" },
      snapshotOf(issue, { kitIssues: [quietIssue(41, "Claude token")] }),
      TWO_SUBSCRIPTIONS,
    );

    expect(actionsOf(plan)).toEqual([
      { kind: "remove-label", issue: 7, label: "agent:design" },
      expect.objectContaining({ kind: "start-agent-run", role: "design", issue: 7, subscription: "Claude token 2" }),
    ]);
  });

  // The turn to start is read from the thread (#155): the refusal posts nothing on the issue, so its request stays pending.
  it("agent:design re-added after a refused prototype turn starts the prototype turn again, on the next free Subscription", () => {
    const pending = { request: { route: "/book", variants: 3, brief: "- **A**: a form.\n- **B**: a stepper.\n- **C**: a calendar." }, reply: 9001 };
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design"], designRounds: 2, pendingPrototype: pending });
    const config = kitConfig({ ...TWO_SUBSCRIPTIONS, ui: UI });

    const refusal = planFor(refused("design"), snapshotOf(issue), config);
    const restart = planFor(
      { kind: "label-added", issue: 7, label: "agent:design" },
      snapshotOf({ ...issue, labels: [...issue.labels, "agent:design"] }, { kitIssues: [kitIssueOpenedBy(refusal, 41)] }),
      config,
    );

    expect(actionsOf(refusal).filter((action) => action.kind === "comment" && action.issue === 7)).toEqual([]);
    expect(actionsOf(restart)).toEqual([
      { kind: "remove-label", issue: 7, label: "agent:design" },
      expect.objectContaining({ kind: "start-agent-run", role: "design", issue: 7, prototype: pending, timeoutMinutes: 60, subscription: "Claude token 2" }),
    ]);
  });

  it("a second refusal on a Subscription whose issue is open comments quietly there, and re-runs while another is free", () => {
    const limit = quietIssue(41, "Claude token");

    const plan = planFor(refused("implement", { issue: 8 }), snapshotOf(anIssue({ number: 8 }), { kitIssues: [limit] }), TWO_SUBSCRIPTIONS);

    expect(notificationsOf(plan)).toEqual([]);
    expect(actionsOf(plan)).toEqual([
      { kind: "remove-label", issue: 8, label: "agent:implement" },
      { kind: "add-labels", issue: 8, labels: ["agent:implement"] },
      { kind: "comment", issue: 41, body: `The Implement run on #8 was refused on the limit too. [The run](${RUN})` },
    ]);
  });

  it("a refusal reporting a later reset than its Subscription's open issue closes it and opens a new window", () => {
    const next = "2026-11-16T04:00:00.000Z";

    const plan = planFor(
      refused("implement", { issue: 8, resetsAt: next }),
      snapshotOf(anIssue({ number: 8 }), { kitIssues: [quietIssue(41, "Claude token")] }),
      TWO_SUBSCRIPTIONS,
    );

    expect(notificationsOf(plan)).toEqual([]);
    expect(actionsOf(plan).slice(2)).toEqual([
      { kind: "close", issue: 41, reason: "completed" },
      expect.objectContaining({
        kind: "open-issue",
        title: "The weekly usage limit of the `Claude token` Subscription is reached until 2026-11-16 04:00 UTC",
      }),
    ]);
  });

  it("leaves the other Subscription's open weekly-limit issue alone", () => {
    const other = quietIssue(40, "Claude token 2", EARLIER);
    const mine = quietIssue(41, "Claude token");

    const plan = planFor(refused("implement", { issue: 8 }), snapshotOf(anIssue({ number: 8 }), { kitIssues: [other, mine] }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan).filter((action) => "issue" in action && action.issue === 40)).toEqual([]);
  });
});

describe("A run refused while no other Subscription is free, with rotation on", () => {
  it("holds the run with no Ticket comment, and the refused Subscription's new issue @-mentions the Operator once, naming the earliest reset", () => {
    const other = quietIssue(40, "Claude token 2", EARLIER);

    const plan = planFor(refused("implement"), snapshotOf(anIssue({ number: 7 }), { kitIssues: [other] }), TWO_SUBSCRIPTIONS);

    expect(notificationsOf(plan)).toEqual([
      'mention in new "The weekly usage limit of the `Claude token` Subscription is reached until 2026-11-09 04:00 UTC"',
    ]);
    expect(actionsOf(plan)).toEqual([
      { kind: "remove-label", issue: 7, label: "agent:implement" },
      { kind: "hold-agent-run", role: "implement", issue: 7, label: "agent:implement", until: EARLIER },
      {
        kind: "open-issue",
        title: "The weekly usage limit of the `Claude token` Subscription is reached until 2026-11-09 04:00 UTC",
        body: expect.stringMatching(
          /^@operator The Implement run on #7 hit the weekly usage limit of the `Claude token` Subscription, and every listed Subscription has now hit its limit\. The first resets at 2026-11-08 10:00 UTC\./,
        ),
        labels: ["fabrik:weekly-limit"],
        assignees: [],
      },
    ]);
  });

  it("@-mentions the Operator on the refused Subscription's open issue when no issue has buzzed yet", () => {
    const other = quietIssue(40, "Claude token 2", EARLIER);
    const mine = quietIssue(41, "Claude token");
    // A run started while both were open is given the first listed Subscription.
    const plan = planFor(refused("implement", { issue: 8 }), snapshotOf(anIssue({ number: 8 }), { kitIssues: [other, mine] }), TWO_SUBSCRIPTIONS);

    expect(notificationsOf(plan)).toEqual(["mention on #41"]);
    expect(actionsOf(plan)).toContainEqual({ kind: "comment", issue: 41, body: expect.stringContaining("2026-11-08 10:00 UTC") });
  });

  it("comments quietly once the Operator was buzzed", () => {
    const other = quietIssue(40, "Claude token 2", EARLIER);
    const buzzed = kitIssueOpenedBy(
      planFor(refused("implement"), snapshotOf(anIssue({ number: 7 }), { kitIssues: [other] }), TWO_SUBSCRIPTIONS),
      41,
    );

    const plan = planFor(refused("implement", { issue: 8 }), snapshotOf(anIssue({ number: 8 }), { kitIssues: [other, buzzed] }), TWO_SUBSCRIPTIONS);

    expect(notificationsOf(plan)).toEqual([]);
    expect(actionsOf(plan)).toContainEqual({
      kind: "comment",
      issue: 41,
      body: [
        `The Implement run on #8 was refused on the limit too. [The run](${RUN})`,
        "",
        "The Implement run on #8 is held until 2026-11-08 10:00 UTC, when the first Subscription's weekly limit resets. The Kit re-adds `agent:implement` on #8 then, to run it again.",
        "",
        '<!-- fabrik:held {"issue":8,"role":"implement","label":"agent:implement","order":2} -->',
      ].join("\n"),
    });
  });
});

describe("The scheduled tick, with rotation on", () => {
  const tick = (now: string): LoopEvent => ({ kind: "scheduled-tick", now });

  it("closes each weekly-limit issue at its own reset, leaving the others open", () => {
    const early = quietIssue(40, "Claude token 2", EARLIER);
    const late = quietIssue(41, "Claude token");

    const plan = planFor(tick("2026-11-08T11:00:00.000Z"), tickSnapshot({ kitIssues: [late, early] }), TWO_SUBSCRIPTIONS);

    expect(notificationsOf(plan)).toEqual([]);
    expect(actionsOf(plan).filter((action) => action.kind === "close")).toEqual([
      { kind: "close", issue: 40, reason: "completed" },
    ]);
    expect(actionsOf(plan)).toContainEqual({
      kind: "comment",
      issue: 40,
      body: "The weekly usage limit of the `Claude token 2` Subscription reset at 2026-11-08 10:00 UTC, so the Kit is closing this issue.",
    });
  });

  it("closes every weekly-limit issue whose reset has passed", () => {
    const early = quietIssue(40, "Claude token 2", EARLIER);
    const late = quietIssue(41, "Claude token");

    const plan = planFor(tick("2026-11-09T05:00:00.000Z"), tickSnapshot({ kitIssues: [late, early] }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan).filter((action) => action.kind === "close")).toEqual([
      { kind: "close", issue: 41, reason: "completed" },
      { kind: "close", issue: 40, reason: "completed" },
    ]);
  });
});

describe("A refused run with one Subscription listed", () => {
  it("is not re-run: the Ticket gets the V1 failure comment, and the V1 issue @-mentions the Operator", () => {
    const plan = planFor(refused("implement"), snapshotOf(anIssue({ number: 7 })), kitConfig());

    expect(notificationsOf(plan)).toEqual(['mention in new "The weekly usage limit is reached until 2026-11-09 04:00 UTC"']);
    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["remove-label", "comment", "open-issue"]);
  });
});
