import { describe, expect, it } from "vitest";
import {
  anIssue,
  aPullRequest,
  auditBody,
  AUDITED_SHA,
  kitConfig,
  RETRO_WINDOW_END,
  retroBody,
  snapshotOf,
  snapshotOfPullRequest,
} from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { KitIssueSnapshot, LoopEvent, Plan, Snapshot } from "./types.ts";

const TWO_SUBSCRIPTIONS = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
const THREE_SUBSCRIPTIONS = kitConfig({ subscriptions: ["Claude token", "Claude token 2", "Claude token 3"] });

/** An open weekly-limit issue, naming the Subscription it is for, or none, as a V1 issue does. */
function weeklyLimitIssue(number: number, subscription: string | null): KitIssueSnapshot {
  return {
    number,
    labels: ["fabrik:weekly-limit"],
    body: [
      "The weekly usage limit is reached.",
      "",
      "<!-- fabrik:resets-at 2026-11-09T04:00:00.000Z -->",
      ...(subscription === null ? [] : [`<!-- fabrik:subscription ${subscription} -->`]),
    ].join("\n"),
    comments: [],
  };
}

/** One way to start a run of each role, given the repo's open Kit-owned issues. */
const STARTS: readonly (readonly [string, (kitIssues: KitIssueSnapshot[]) => [LoopEvent, Snapshot]])[] = [
  [
    "Triage",
    (kitIssues) => [
      { kind: "label-added", issue: 7, label: "needs-triage" },
      snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] }), { kitIssues }),
    ],
  ],
  [
    "Design-session turn",
    (kitIssues) => [
      { kind: "issue-comment-created", issue: 7, commenter: "jrey", commenterIsBot: false, body: "yes", comment: 9001 },
      snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"], designRounds: 1 }), {
        operator: "jrey",
        kitIssues,
      }),
    ],
  ],
  [
    "Implement",
    (kitIssues) => [
      { kind: "label-added", issue: 7, label: "agent:implement" },
      snapshotOf(anIssue({ number: 7, labels: ["enhancement", "ready-for-agent", "agent:implement"] }), { kitIssues }),
    ],
  ],
  [
    "Review",
    (kitIssues) => [{ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(aPullRequest(), { kitIssues })],
  ],
  [
    "Auditor",
    (kitIssues) => [
      { kind: "issue-opened", issue: 98 },
      snapshotOf(
        anIssue({ number: 98, byApp: true, labels: ["fabrik:audit"], body: auditBody(AUDITED_SHA, "pending") }),
        { kitIssues },
      ),
    ],
  ],
  [
    "Retro",
    (kitIssues) => [
      { kind: "issue-opened", issue: 120 },
      snapshotOf(
        anIssue({ number: 120, byApp: true, labels: ["fabrik:retro"], body: retroBody(RETRO_WINDOW_END, "pending") }),
        { kitIssues },
      ),
    ],
  ],
];

/** The Subscription each run the Plan starts is given. */
function subscriptionsStartedIn(plan: Plan): (string | undefined)[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${plan.kind}: ${JSON.stringify(plan)}`);
  return plan.actions.flatMap((action) => (action.kind === "start-agent-run" ? [action.subscription] : []));
}

describe("The Subscription a started run is given", () => {
  it.each(STARTS)("a %s run starts on the first listed Subscription when none has an open weekly-limit issue", (_, start) => {
    const [event, snapshot] = start([]);

    expect(subscriptionsStartedIn(planFor(event, snapshot, TWO_SUBSCRIPTIONS))).toEqual(["Claude token"]);
  });

  it.each(STARTS)(
    "a %s run starts on the next listed Subscription while the first one's weekly-limit issue is open",
    (_, start) => {
      const [event, snapshot] = start([weeklyLimitIssue(40, "Claude token")]);

      expect(subscriptionsStartedIn(planFor(event, snapshot, TWO_SUBSCRIPTIONS))).toEqual(["Claude token 2"]);
    },
  );

  it.each(STARTS)(
    "a %s run reads an open V1 weekly-limit issue, which names no Subscription, as the first listed one's",
    (_, start) => {
      const [event, snapshot] = start([weeklyLimitIssue(40, null)]);

      expect(subscriptionsStartedIn(planFor(event, snapshot, TWO_SUBSCRIPTIONS))).toEqual(["Claude token 2"]);
    },
  );

  it("skips every listed Subscription with an open weekly-limit issue, in the listed order", () => {
    const [event, snapshot] = STARTS[2]![1]([weeklyLimitIssue(41, "Claude token 2"), weeklyLimitIssue(40, "Claude token")]);

    expect(subscriptionsStartedIn(planFor(event, snapshot, THREE_SUBSCRIPTIONS))).toEqual(["Claude token 3"]);
  });

  it("starts on the first listed Subscription while only a later one's weekly-limit issue is open", () => {
    const [event, snapshot] = STARTS[2]![1]([weeklyLimitIssue(41, "Claude token 2")]);

    expect(subscriptionsStartedIn(planFor(event, snapshot, TWO_SUBSCRIPTIONS))).toEqual(["Claude token"]);
  });

  it("reads only the Kit-owned issues that make a Subscription unusable, not another one naming a Subscription", () => {
    const replay: KitIssueSnapshot = { ...weeklyLimitIssue(42, "Claude token"), labels: ["fabrik:replay"] };
    const [event, snapshot] = STARTS[0]![1]([replay]);

    expect(subscriptionsStartedIn(planFor(event, snapshot, TWO_SUBSCRIPTIONS))).toEqual(["Claude token"]);
  });

  it.each(STARTS)("with one Subscription listed, a %s run starts on it, even while its weekly-limit issue is open", (_, start) => {
    const [event, snapshot] = start([weeklyLimitIssue(40, null)]);

    expect(subscriptionsStartedIn(planFor(event, snapshot, kitConfig()))).toEqual(["Claude token"]);
  });
});
