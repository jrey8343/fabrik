import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
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

  it("names a dead token when one Subscription is used up by its weekly limit and another by its open rotation issue", () => {
    const config = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
    const rotation: KitIssueSnapshot = {
      number: 41,
      labels: ["ready-for-human", "fabrik:token-rotation"],
      body: "<!-- fabrik:notified -->\n<!-- fabrik:subscription Claude token 2 -->",
      comments: [],
    };
    const kitIssues = [firstUsedUp, rotation];
    const plan = planFor(triage, snapshotOf(ticket, { kitIssues }), config);

    expect(kitJobSummary(plan, config, kitIssues)).toBe(
      "### Fabrik Kit job\n\n" +
        "The Triage run on #7 was held until 2026-11-09 04:00 UTC: every listed Subscription is used up. " +
        "`Claude token` has hit its weekly limit, and `Claude token 2` has a dead token, with an open token-rotation issue. " +
        "Its `needs-triage` label came off.\n",
    );
  });

  describe("on an Implement run", () => {
    const dispatched = { kind: "label-added", issue: 7, label: "agent:implement" } as const;
    const readyTicket = anIssue({ number: 7, labels: ["ready-for-agent", "agent:implement"] });
    const ui = { paths: ["src/**/*.astro"], serve: "npm run preview", url: "http://127.0.0.1:4321", beforeUrl: null, defaultRoutes: ["/"] };

    it("notes quietly that Visual evidence is off until Kit config has a ui block, which /fabrik-visual-evidence adds", () => {
      const config = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
      const plan = planFor(dispatched, snapshotOf(readyTicket), config);

      expect(kitJobSummary(plan, config, [])).toBe(
        "### Fabrik Kit job\n\n" +
          "The Implement run on #7 was given the Subscription **Claude token**.\n\n" +
          "Visual evidence is off until Kit config has a `ui` block: `/fabrik-visual-evidence` turns it on.\n",
      );
    });

    it("says nothing of Visual evidence once Kit config has a ui block", () => {
      const config = kitConfig({ subscriptions: ["Claude token", "Claude token 2"], ui });
      const plan = planFor(dispatched, snapshotOf(readyTicket), config);

      expect(kitJobSummary(plan, config, [])).toBe("### Fabrik Kit job\n\nThe Implement run on #7 was given the Subscription **Claude token**.\n");
    });
  });

  it("says nothing of Visual evidence on a run that isn't an Implement run", () => {
    const config = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
    const plan = planFor(triage, snapshotOf(ticket), config);

    expect(kitJobSummary(plan, config, [])).not.toContain("Visual evidence");
  });

  it("says nothing when the plan starts no run", () => {
    const config = kitConfig();
    const plan = planFor({ kind: "label-added", issue: 7, label: "docs" }, snapshotOf(ticket), config);

    expect(kitJobSummary(plan, config, [])).toBeNull();
  });
});
