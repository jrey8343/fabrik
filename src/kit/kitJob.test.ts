import { describe, expect, it } from "vitest";
import { anIssue, auditBody, AUDITED_SHA, kitConfig, RETRO_WINDOW_END, retroBody, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "../loop/rules.ts";
import type { KitIssueSnapshot } from "../loop/types.ts";
import { kitJobSummary } from "./kitJob.ts";

const triage = { kind: "label-added", issue: 7, label: "needs-triage" } as const;
const ticket = anIssue({ number: 7, labels: ["needs-triage"] });
const firstUsedUp: KitIssueSnapshot = {
  number: 40,
  labels: ["fabrik:weekly-limit"],
  body: "<!-- fabrik:resets-at 2026-11-09T04:00:00.000Z -->\n<!-- fabrik:subscription Claude token -->",
  comments: [],
};

describe("The Kit job's step summary", () => {
  it("names the Subscription a started run was given", () => {
    const config = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
    const kitIssues = [firstUsedUp];
    const plan = planFor(triage, snapshotOf(ticket, { kitIssues }), config);

    expect(kitJobSummary(plan, config, kitIssues)).toBe(
      "### Fabrik Kit job\n\nThe Triage run on #7 was given the Subscription **Claude token 2**.\n",
    );
  });

  it("with one Subscription listed, names it and notes quietly that rotation is off until a second is listed", () => {
    const config = kitConfig();
    const plan = planFor(triage, snapshotOf(ticket), config);

    expect(kitJobSummary(plan, config, [])).toBe(
      "### Fabrik Kit job\n\n" +
        "The Triage run on #7 was given the Subscription **Claude token**.\n\n" +
        "Subscription rotation is off until a second Subscription is listed in Kit config's `subscriptions`.\n",
    );
  });

  it("says a run due while every Subscription is used up was held, and until when", () => {
    const config = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
    const secondUsedUp: KitIssueSnapshot = {
      number: 41,
      labels: ["fabrik:weekly-limit"],
      body: "<!-- fabrik:resets-at 2026-11-08T10:00:00.000Z -->\n<!-- fabrik:subscription Claude token 2 -->",
      comments: [],
    };
    const kitIssues = [firstUsedUp, secondUsedUp];
    const plan = planFor(triage, snapshotOf(ticket, { kitIssues }), config);

    expect(kitJobSummary(plan, config, kitIssues)).toBe(
      "### Fabrik Kit job\n\n" +
        "The Triage run on #7 was held until 2026-11-08 10:00 UTC: every listed Subscription has hit its weekly limit. " +
        "Its `needs-triage` label came off.\n",
    );
  });

  it("says a held Auditor run's Audit stays pending", () => {
    const config = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
    const v1Issue: KitIssueSnapshot = { ...firstUsedUp, number: 41, body: "<!-- fabrik:notified -->" };
    const audit = anIssue({ number: 98, byApp: true, labels: ["fabrik:audit"], body: auditBody(AUDITED_SHA, "pending") });
    const secondUsedUp: KitIssueSnapshot = { ...firstUsedUp, number: 42, body: "<!-- fabrik:subscription Claude token 2 -->" };
    const kitIssues = [v1Issue, secondUsedUp];
    const plan = planFor({ kind: "issue-opened", issue: 98 }, snapshotOf(audit, { kitIssues }), config);

    expect(kitJobSummary(plan, config, kitIssues)).toBe(
      "### Fabrik Kit job\n\n" +
        "The Audit run on #98 was held until a Subscription's weekly limit resets, which isn't known: every listed Subscription has hit its weekly limit. " +
        "Its Audit stays pending.\n",
    );
  });

  it("says a held Retro run's Retro stays pending", () => {
    const config = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
    const v1Issue: KitIssueSnapshot = { ...firstUsedUp, number: 41, body: "<!-- fabrik:notified -->" };
    const retro = anIssue({ number: 120, byApp: true, labels: ["fabrik:retro"], body: retroBody(RETRO_WINDOW_END, "pending") });
    const secondUsedUp: KitIssueSnapshot = { ...firstUsedUp, number: 42, body: "<!-- fabrik:subscription Claude token 2 -->" };
    const kitIssues = [v1Issue, secondUsedUp];
    const plan = planFor({ kind: "issue-opened", issue: 120 }, snapshotOf(retro, { kitIssues }), config);

    expect(kitJobSummary(plan, config, kitIssues)).toBe(
      "### Fabrik Kit job\n\n" +
        "The Retro run on #120 was held until a Subscription's weekly limit resets, which isn't known: every listed Subscription has hit its weekly limit. " +
        "Its Retro stays pending.\n",
    );
  });

  it("names both reasons when one Subscription is used up by its weekly limit and another by a usage-credits kill", () => {
    const config = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
    const usageCredits: KitIssueSnapshot = {
      number: 41,
      labels: ["ready-for-human", "fabrik:usage-credits"],
      body: "<!-- fabrik:notified -->\n<!-- fabrik:subscription Claude token 2 -->",
      comments: [],
    };
    const kitIssues = [firstUsedUp, usageCredits];
    const plan = planFor(triage, snapshotOf(ticket, { kitIssues }), config);

    expect(kitJobSummary(plan, config, kitIssues)).toBe(
      "### Fabrik Kit job\n\n" +
        "The Triage run on #7 was held until 2026-11-09 04:00 UTC: every listed Subscription is used up. " +
        "`Claude token` has hit its weekly limit, and `Claude token 2` has an open usage-credits issue. " +
        "Its `needs-triage` label came off.\n",
    );
  });

  it("says nothing when the plan starts no run", () => {
    const config = kitConfig();
    const plan = planFor({ kind: "label-added", issue: 7, label: "docs" }, snapshotOf(ticket), config);

    expect(kitJobSummary(plan, config, [])).toBeNull();
  });
});
