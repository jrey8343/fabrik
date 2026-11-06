import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, RETRO_WINDOW_END, retroBody, snapshotOf } from "../__fixtures__/snapshots.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { planFor } from "./rules.ts";
import type { IssueSnapshot } from "./types.ts";

/** A `fabrik:retro` issue as the Loop sees it: by default the App's pending Retro, open and waiting on its run. */
function aRetro(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return anIssue({ number: 120, byApp: true, labels: ["fabrik:retro"], body: retroBody(RETRO_WINDOW_END, "pending"), ...overrides });
}

describe("The App's pending Retro, when it's opened", () => {
  it("starts a Retro run on roles.retro's model, effort and timeout", () => {
    const config = kitConfig({
      roles: { ...DEFAULT_KIT_CONFIG.roles, retro: { model: "claude-retro", effort: "high", timeoutMinutes: 50 } },
    });

    const plan = planFor({ kind: "issue-opened", issue: 120 }, snapshotOf(aRetro()), config);

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "start-agent-run", role: "retro", issue: 120, model: "claude-retro", effort: "high", timeoutMinutes: 50 }],
    });
  });
});

describe("Any other fabrik:retro issue, when it's opened", () => {
  it.each([
    ["the App's filled Retro", aRetro({ body: retroBody(RETRO_WINDOW_END, "filled") })],
    ["the App's failed Retro, closed", aRetro({ open: false, body: retroBody(RETRO_WINDOW_END, "failed") })],
    ["the App's pending Retro, already closed by the Operator", aRetro({ open: false })],
    ["a person's issue with the label and the pending marker", aRetro({ byApp: false, author: "someone" })],
  ])("starts no run: %s", (_, issue) => {
    const plan = planFor({ kind: "issue-opened", issue: 120 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: expect.stringContaining("fabrik:retro") });
  });

  it("a person's issue quoting the pending marker without the label starts no run, and goes to Triage like any issue", () => {
    const issue = aRetro({ byApp: false, author: "someone", labels: [] });

    const plan = planFor({ kind: "issue-opened", issue: 120 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "add-labels", issue: 120, labels: ["needs-triage"] }] });
  });
});
