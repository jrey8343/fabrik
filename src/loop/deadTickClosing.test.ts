import { describe, expect, it } from "vitest";
import { kitConfig, tickSnapshot } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, KitIssueSnapshot, LoopEvent } from "./types.ts";

const NOW = "2026-11-11T06:17:00.000Z";
const tick = (release?: string): LoopEvent => ({ kind: "scheduled-tick", now: NOW, ...(release === undefined ? {} : { release }) });

/** An open Dead-tick issue, as the daily check filed it and the Kit reads it back. */
function deadTickIssue(number: number, body = "The hourly Tick hasn't run.\n\n<!-- fabrik:dead-tick -->"): KitIssueSnapshot {
  return { number, labels: ["fabrik:dead-tick", "ready-for-human"], body, comments: [] };
}

function actionsOf(event: LoopEvent, kitIssues: readonly KitIssueSnapshot[]): readonly Action[] {
  const plan = planFor(event, tickSnapshot({ kitIssues }), kitConfig());
  return plan.kind === "act" ? plan.actions : [];
}

describe("The Tick's run once it starts again", () => {
  it("closes the open Dead-tick issue as completed, saying when it started again and on which release", () => {
    const actions = actionsOf(tick("v1.1.0"), [deadTickIssue(12)]);

    expect(actions).toContainEqual({
      kind: "comment",
      issue: 12,
      body: "The hourly Tick started again at 2026-11-11 06:17 UTC, on Fabrik v1.1.0, so the Kit is closing this issue.",
    });
    expect(actions).toContainEqual({ kind: "close", issue: 12, reason: "completed" });
  });

  it("names no release when it doesn't know the one it runs on", () => {
    const actions = actionsOf(tick(), [deadTickIssue(12)]);

    expect(actions).toContainEqual({ kind: "comment", issue: 12, body: "The hourly Tick started again at 2026-11-11 06:17 UTC, so the Kit is closing this issue." });
  });

  it("leaves alone an issue with the label but without the Fabrik App's marker", () => {
    const actions = actionsOf(tick("v1.1.0"), [deadTickIssue(12, "")]);

    expect(actions.filter((action) => "issue" in action && action.issue === 12)).toEqual([]);
  });
});
