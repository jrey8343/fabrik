import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, RETRO_WINDOW_END, retroBody, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "../loop/rules.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { kitJobOutputs } from "./jobs.ts";

const config = kitConfig({
  roles: { ...DEFAULT_KIT_CONFIG.roles, retro: { model: "claude-retro", effort: "high", timeoutMinutes: 50 } },
});

describe("The Kit job's routing", () => {
  // The Retro evidence job, then the Retro job, run on the retro route (#151), both within retro-timeout-minutes.
  it("routes the App's pending Retro to the Retro jobs, within roles.retro's timeout, on its model and effort, with no Ticket, PR or commit", () => {
    const retro = anIssue({ number: 120, byApp: true, labels: ["fabrik:retro"], body: retroBody(RETRO_WINDOW_END, "pending") });

    const outputs = kitJobOutputs(planFor({ kind: "issue-opened", issue: 120 }, snapshotOf(retro), config), null, config);

    expect(outputs).toMatchObject({
      route: "retro",
      "retro-timeout-minutes": "50",
      model: "claude-retro",
      effort: "high",
      "pull-request": "",
      ticket: "",
      branch: "",
      review: "",
      "audit-commit": "",
      retry: "",
      "step-up": "false",
      "request-changes": "false",
    });
  });

  // As for every agent run (#152): the Retro job loads the chosen Subscription's Claude token.
  it("passes out the Subscription a Retro run is given and whether rotation is on, for the Retro job's Claude token", () => {
    const rotating = kitConfig({ ...config, subscriptions: ["Claude token", "Claude token 2"] });
    const retro = anIssue({ number: 120, byApp: true, labels: ["fabrik:retro"], body: retroBody(RETRO_WINDOW_END, "pending") });
    const firstUsedUp = {
      number: 40,
      labels: ["fabrik:weekly-limit"],
      body: "<!-- fabrik:subscription Claude token -->\n<!-- fabrik:resets-at 2026-11-09T04:00:00.000Z -->",
      comments: [],
    };

    const plan = planFor({ kind: "issue-opened", issue: 120 }, snapshotOf(retro, { kitIssues: [firstUsedUp] }), rotating);

    expect(kitJobOutputs(plan, null, rotating)).toMatchObject({ route: "retro", subscription: "Claude token 2", rotation: "true" });
  });

  it("passes out roles.retro's timeout whatever it routes to, as it does every role's", () => {
    const outputs = kitJobOutputs(null, null, kitConfig());

    expect(outputs).toMatchObject({ route: "none", "implement-timeout-minutes": "60", "retro-timeout-minutes": "45" });
  });
});
