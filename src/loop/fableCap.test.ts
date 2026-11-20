import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, kitConfig, notificationsOf, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { planFor } from "./rules.ts";
import type { AgentRole, IssueSnapshot, KitConfig, LoopEvent, Plan, Snapshot } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const FABLE = "claude-fable-5-2";
const RESETS_AT = "2026-11-27T04:00:00.000Z";
/** When the adapter read the readings: before RESETS_AT. */
const READ_AT = "2026-11-20T04:00:00.000Z";

/** The Fable cap readings as the adapter read them at READ_AT, in force or not. */
function readAt(readings: readonly { subscription: string; until: string }[]): NonNullable<Snapshot["fableCaps"]> {
  return { readings, now: READ_AT };
}

/** A Product repo that opted in to Fable (ADR-0034), with Fable for Triage, Design, Implement and Review, on these Subscriptions. */
function fableConfig(subscriptions: readonly string[]): KitConfig {
  const { roles } = DEFAULT_KIT_CONFIG;
  return kitConfig({
    allowFable: true,
    subscriptions,
    roles: {
      ...roles,
      triage: { ...roles.triage, model: FABLE, effort: "medium" },
      design: { ...roles.design, model: FABLE, effort: "high" },
      implement: { ...roles.implement, model: FABLE, effort: "high" },
      review: { ...roles.review, model: FABLE, effort: "high" },
    },
  });
}
const TWO_SUBSCRIPTIONS = fableConfig(["Claude token", "Claude token 2"]);
const ONE_SUBSCRIPTION = fableConfig(["Claude token"]);

/** A run refused on its Subscription's Fable cap, as the push job sees it. */
function capped(
  role: AgentRole,
  { subscription = "Claude token", resetsAt = RESETS_AT }: { subscription?: string; resetsAt?: string | null } = {},
): LoopEvent {
  return {
    kind: "agent-run-failed",
    role,
    issue: 7,
    runUrl: RUN,
    jobResult: "failure",
    secretsStep: "success",
    report: {
      failure: "fable-cap",
      detail: "seven_day_fable",
      ...(resetsAt === null ? {} : { resetsAt }),
      refusal: { rateLimitType: "seven_day_fable", resetsAt: resetsAt === null ? null : Date.parse(resetsAt) / 1000 },
    },
    subscription,
  };
}

function actionsOf(plan: Plan) {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${plan.kind}: ${JSON.stringify(plan)}`);
  return plan.actions;
}

const ROLES: readonly (readonly [AgentRole, Partial<IssueSnapshot>, number, string])[] = [
  ["triage", { labels: ["needs-triage"] }, 7, "needs-triage"],
  ["implement", { labels: ["enhancement", "ready-for-agent"] }, 7, "agent:implement"],
  ["review", { labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }, 50, "agent:review"],
  ["design", { labels: ["enhancement", "needs-design"], designRounds: 1 }, 7, "agent:design"],
  ["research", { labels: ["research"] }, 7, "agent:research"],
];

describe("A Fable run refused on its Subscription's Fable cap (ADR-0034)", () => {
  it.each(ROLES)(
    "a %s run is re-run once, quietly, through its trigger label, with the cap marked where the label goes",
    (role, issue, labelled, label) => {
      const plan = planFor(capped(role), snapshotOf(anIssue({ number: 7, ...issue })), TWO_SUBSCRIPTIONS);

      expect(notificationsOf(plan)).toEqual([]);
      expect(actionsOf(plan)).toEqual([
        { kind: "remove-label", issue: labelled, label },
        { kind: "mark-fable-cap", issue: labelled, subscription: "Claude token", resetsAt: RESETS_AT },
        { kind: "add-labels", issue: labelled, labels: [label] },
      ]);
    },
  );

  it("is re-run with one Subscription listed too, since the re-run can fall back to Opus", () => {
    const plan = planFor(capped("implement"), snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"] })), ONE_SUBSCRIPTION);

    expect(actionsOf(plan)).toEqual([
      { kind: "remove-label", issue: 7, label: "agent:implement" },
      { kind: "mark-fable-cap", issue: 7, subscription: "Claude token", resetsAt: RESETS_AT },
      { kind: "add-labels", issue: 7, labels: ["agent:implement"] },
    ]);
  });

  it("marks a cap the stream gave no reset for with none", () => {
    const plan = planFor(capped("triage", { resetsAt: null }), snapshotOf(anIssue({ number: 7 })), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan)).toContainEqual({ kind: "mark-fable-cap", issue: 7, subscription: "Claude token", resetsAt: null });
  });

  it("opens no Kit-owned issue, holds no run and posts no comment, while every other Subscription is used up too", () => {
    const limit = { number: 41, labels: ["fabrik:weekly-limit"], body: "<!-- fabrik:subscription Claude token 2 -->", comments: [] };

    const plan = planFor(capped("implement"), snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"] }), { kitIssues: [limit] }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["remove-label", "mark-fable-cap", "add-labels"]);
  });

  it("uses none of the Ticket's retries: an Implement run on a Retry is re-run the same way, with no Verdict", () => {
    const issue = anIssue({ number: 7, labels: ["ready-for-agent"], openPullRequests: [50] });

    const plan = planFor(capped("implement"), snapshotOf(issue, { pullRequest: aPullRequest({ number: 50 }) }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan)).toEqual([
      { kind: "remove-label", issue: 7, label: "agent:implement" },
      { kind: "mark-fable-cap", issue: 7, subscription: "Claude token", resetsAt: RESETS_AT },
      { kind: "add-labels", issue: 7, labels: ["agent:implement"] },
    ]);
  });

  // As a weekly-limit refusal is re-run once, only while another Subscription is free, so its re-run never repeats.
  it("isn't re-run again when refused on a Subscription its issue already marks as capped, which a re-run would only repeat", () => {
    const issue = anIssue({ number: 7, labels: ["ready-for-agent"] });

    const plan = planFor(capped("implement"), snapshotOf(issue, { fableCaps: readAt([{ subscription: "Claude token", until: RESETS_AT }]) }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan).filter((action) => action.kind === "add-labels" || action.kind === "mark-fable-cap")).toEqual([]);
    expect(notificationsOf(plan)).toEqual(["mention on #7"]);
    expect(actionsOf(plan)).toContainEqual({
      kind: "comment",
      issue: 7,
      body: expect.stringContaining("it hit the Fable cap on the `Claude token` Subscription again, though the Kit had marked it reached"),
    });
  });

  it("is re-run on a cap marked on another Subscription, so a re-run refused on the next one moves on again", () => {
    const issue = anIssue({ number: 7, labels: ["ready-for-agent"] });

    const plan = planFor(
      capped("implement", { subscription: "Claude token 2" }),
      snapshotOf(issue, { fableCaps: readAt([{ subscription: "Claude token", until: RESETS_AT }]) }),
      TWO_SUBSCRIPTIONS,
    );

    expect(actionsOf(plan)).toEqual([
      { kind: "remove-label", issue: 7, label: "agent:implement" },
      { kind: "mark-fable-cap", issue: 7, subscription: "Claude token 2", resetsAt: RESETS_AT },
      { kind: "add-labels", issue: 7, labels: ["agent:implement"] },
    ]);
  });

  it("isn't re-run again when refused with the reset its issue already marks, though that reset has passed", () => {
    const issue = anIssue({ number: 7, labels: ["ready-for-agent"] });
    const passed = "2026-11-19T04:00:00.000Z";

    const plan = planFor(
      capped("implement", { resetsAt: passed }),
      snapshotOf(issue, { fableCaps: readAt([{ subscription: "Claude token", until: passed }]) }),
      TWO_SUBSCRIPTIONS,
    );

    expect(actionsOf(plan).filter((action) => action.kind === "add-labels" || action.kind === "mark-fable-cap")).toEqual([]);
    expect(notificationsOf(plan)).toEqual(["mention on #7"]);
  });

  it("is re-run when its issue marks only an earlier cap on that Subscription, long reset", () => {
    const issue = anIssue({ number: 7, labels: ["ready-for-agent"] });

    const plan = planFor(capped("implement"), snapshotOf(issue, { fableCaps: readAt([{ subscription: "Claude token", until: "2026-11-13T04:00:00.000Z" }]) }), TWO_SUBSCRIPTIONS);

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["remove-label", "mark-fable-cap", "add-labels"]);
  });

  it("a Digest run isn't re-run: its no-Digest line says so, mentioning nobody, as for any failed Digest run", () => {
    const event: LoopEvent = { ...capped("digest"), digest: { pullRequest: 50, headSha: "a".repeat(40) } } as LoopEvent;

    const plan = planFor(event, snapshotOf(anIssue({ number: 7, openPullRequests: [50] }), { pullRequest: aPullRequest({ number: 50 }) }), TWO_SUBSCRIPTIONS);

    expect(notificationsOf(plan)).toEqual([]);
    expect(actionsOf(plan).some((action) => action.kind === "add-labels" || action.kind === "mark-fable-cap" || action.kind === "open-issue")).toBe(false);
  });
});

describe("A run due on a role that names Fable, with a Fable cap marked where its trigger label went", () => {
  const until = RESETS_AT;
  const issue = anIssue({ number: 7, labels: ["needs-triage"] });
  const start = (plan: Plan) => actionsOf(plan).find((action) => action.kind === "start-agent-run");

  it("starts on the first listed Subscription with Fable left, on Fable", () => {
    const plan = planFor(
      { kind: "label-added", issue: 7, label: "needs-triage" },
      snapshotOf(issue, { fableCaps: readAt([{ subscription: "Claude token", until }]) }),
      TWO_SUBSCRIPTIONS,
    );

    expect(start(plan)).toEqual(expect.objectContaining({ subscription: "Claude token 2", model: FABLE, effort: "medium" }));
    expect(start(plan)).not.toHaveProperty("fallback");
  });

  it("starts on Opus 5.5 at the role's effort, on the Subscription it would have had, once no Subscription has Fable left", () => {
    const plan = planFor(
      { kind: "label-added", issue: 7, label: "needs-triage" },
      snapshotOf(issue, { fableCaps: readAt([{ subscription: "Claude token", until }, { subscription: "Claude token 2", until }]) }),
      TWO_SUBSCRIPTIONS,
    );

    expect(start(plan)).toEqual(
      expect.objectContaining({ subscription: "Claude token", model: "claude-opus-5-5", effort: "medium", configuredModel: FABLE, fallback: "fable-cap" }),
    );
  });

  it("starts on Opus 5.5 with one Subscription listed, once it has no Fable left", () => {
    const plan = planFor(
      { kind: "label-added", issue: 7, label: "needs-triage" },
      snapshotOf(issue, { fableCaps: readAt([{ subscription: "Claude token", until }]) }),
      ONE_SUBSCRIPTION,
    );

    expect(start(plan)).toEqual(expect.objectContaining({ subscription: "Claude token", model: "claude-opus-5-5", fallback: "fable-cap" }));
  });

  it("passes over a Subscription with Fable left that is used up, as any run does", () => {
    const three = fableConfig(["Claude token", "Claude token 2", "Claude token 3"]);
    const limit = { number: 41, labels: ["fabrik:weekly-limit"], body: "<!-- fabrik:subscription Claude token 2 -->", comments: [] };

    const plan = planFor(
      { kind: "label-added", issue: 7, label: "needs-triage" },
      snapshotOf(issue, { kitIssues: [limit], fableCaps: readAt([{ subscription: "Claude token", until }]) }),
      three,
    );

    expect(start(plan)).toEqual(expect.objectContaining({ subscription: "Claude token 3", model: FABLE }));
  });

  it("a Review started on its PR's label reads the cap marked on the PR", () => {
    const plan = planFor(
      { kind: "pull-request-labeled", pullRequest: 50, label: "agent:review" },
      snapshotOfPullRequest(aPullRequest({ number: 50, labels: ["agent:review"] }), { fableCaps: readAt([{ subscription: "Claude token", until }]) }),
      TWO_SUBSCRIPTIONS,
    );

    expect(start(plan)).toEqual(expect.objectContaining({ role: "review", subscription: "Claude token 2", model: FABLE }));
  });

  it("counts a reading whose time had passed when the adapter read it as Fable left", () => {
    const plan = planFor(
      { kind: "label-added", issue: 7, label: "needs-triage" },
      snapshotOf(issue, { fableCaps: { readings: [{ subscription: "Claude token", until }], now: "2026-11-28T04:00:00.000Z" } }),
      ONE_SUBSCRIPTION,
    );

    expect(start(plan)).toEqual(expect.objectContaining({ subscription: "Claude token", model: FABLE }));
    expect(start(plan)).not.toHaveProperty("fallback");
  });

  it("leaves a role that doesn't name Fable as it was", () => {
    const config = { ...TWO_SUBSCRIPTIONS, roles: { ...TWO_SUBSCRIPTIONS.roles, triage: DEFAULT_KIT_CONFIG.roles.triage } };

    const plan = planFor(
      { kind: "label-added", issue: 7, label: "needs-triage" },
      snapshotOf(issue, { fableCaps: readAt([{ subscription: "Claude token", until }, { subscription: "Claude token 2", until }]) }),
      config,
    );

    expect(start(plan)).toEqual(expect.objectContaining({ subscription: "Claude token", model: DEFAULT_KIT_CONFIG.roles.triage.model }));
    expect(start(plan)).not.toHaveProperty("fallback");
  });

  it("with no cap marked, starts on Fable on the first free Subscription, as before", () => {
    const plan = planFor({ kind: "label-added", issue: 7, label: "needs-triage" }, snapshotOf(issue), TWO_SUBSCRIPTIONS);

    expect(start(plan)).toEqual(expect.objectContaining({ subscription: "Claude token", model: FABLE }));
    expect(start(plan)).not.toHaveProperty("fallback");
  });
});

describe("A Design, Review or Step-up run due while no listed Subscription has Fable left, by the store's newest Run records", () => {
  const until = RESETS_AT;
  const everywhere = [
    { subscription: "Claude token", until },
    { subscription: "Claude token 2", until },
  ];
  // Design, Review and the Step-up on Fable, as the Operator sets them; Implement on its default.
  const { roles } = TWO_SUBSCRIPTIONS;
  const config = { ...TWO_SUBSCRIPTIONS, roles: { ...roles, implement: DEFAULT_KIT_CONFIG.roles.implement, stepUp: { model: FABLE, effort: "xhigh" } } };
  const start = (plan: Plan) => actionsOf(plan).find((action) => action.kind === "start-agent-run");
  const runs: readonly (readonly [string, LoopEvent, (fableCaps: NonNullable<Snapshot["fableCaps"]>) => Snapshot, string])[] = [
    [
      "a Design-session turn",
      { kind: "label-added", issue: 7, label: "agent:design" },
      (fableCaps) => snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design", "agent:design"], designRounds: 1 }), { fableCaps }),
      "high",
    ],
    [
      "a Review",
      { kind: "pull-request-labeled", pullRequest: 50, label: "agent:review" },
      (fableCaps) => snapshotOfPullRequest(aPullRequest({ number: 50, labels: ["agent:review"] }), { fableCaps }),
      "high",
    ],
    [
      "a Stepped-up Implement run",
      { kind: "label-added", issue: 7, label: "agent:implement" },
      (fableCaps) => snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent", "agent:implement", "fabrik:step-up"] }), { fableCaps }),
      "xhigh",
    ],
  ];

  it.each(runs)("%s starts on Opus 5.5 at the role's effort, with no refusal first, recorded as a fable-cap fallback", (_, event, snapshot, effort) => {
    expect(start(planFor(event, snapshot(readAt(everywhere)), config))).toEqual(
      expect.objectContaining({ subscription: "Claude token", model: "claude-opus-5-5", effort, configuredModel: FABLE, fallback: "fable-cap" }),
    );
  });

  it.each(runs)("%s starts on Fable on another Subscription, with a reading on one only", (_, event, snapshot, effort) => {
    expect(start(planFor(event, snapshot(readAt(everywhere.slice(0, 1))), config))).toEqual(
      expect.objectContaining({ subscription: "Claude token 2", model: FABLE, effort }),
    );
  });
});

describe("A repo that hasn't opted in to Fable", () => {
  it("runs exactly as before, whatever Fable cap readings there are", () => {
    const issue = anIssue({ number: 7, labels: ["needs-triage"] });
    const event = { kind: "label-added", issue: 7, label: "needs-triage" } as const;
    const caps = [{ subscription: "Claude token", until: RESETS_AT }];
    const config = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });

    expect(planFor(event, snapshotOf(issue, { fableCaps: readAt(caps) }), config)).toEqual(planFor(event, snapshotOf(issue), config));
  });
});
