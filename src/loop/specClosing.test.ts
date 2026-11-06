import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, SpecSnapshot } from "./types.ts";

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** Ticket #9 under Spec #3 was just closed, by merging #50 through `Closes #9`. */
const closed: LoopEvent = { kind: "issue-closed", issue: 9 };
const ticket = anIssue({ number: 9, open: false, parent: 3, labels: ["enhancement", "ready-for-agent"] });

function spec(overrides: Partial<SpecSnapshot> = {}): SpecSnapshot {
  return {
    number: 3,
    open: true,
    labels: ["enhancement", "ready-for-agent"],
    tickets: [
      { number: 8, open: false, pullRequests: [48] },
      { number: 9, open: false, pullRequests: [50] },
    ],
    ...overrides,
  };
}

describe("Spec closing", () => {
  it("the last Ticket closing closes its Spec as completed, with a comment linking each Ticket's PR, then runs a Dispatch check", () => {
    const actions = actionsOf(planFor(closed, snapshotOf(ticket, { spec: spec() }), kitConfig()));

    expect(actions.map((action) => action.kind)).toEqual(["comment", "close", "check-dispatch", "check-design-queue"]);
    expect(actions[1]).toEqual({ kind: "close", issue: 3, reason: "completed" });
    const body = actions[0]?.kind === "comment" ? actions[0].body : "";
    expect(actions[0]).toMatchObject({ kind: "comment", issue: 3 });
    expect(body).toContain("- #8: #48");
    expect(body).toContain("- #9: #50");
  });

  it("a last Ticket a Design session closed as not planned closes the Spec like any Ticket closed without a merged PR", () => {
    const notPlanned = { ...ticket, labels: ["enhancement", "wontfix"] };
    const tickets = [{ number: 8, open: false, pullRequests: [48] }, { number: 9, open: false, pullRequests: [] }];
    const actions = actionsOf(planFor(closed, snapshotOf(notPlanned, { spec: spec({ tickets }) }), kitConfig()));

    expect(actions[1]).toEqual({ kind: "close", issue: 3, reason: "completed" });
    expect(actions[0]?.kind === "comment" ? actions[0].body : "").toContain("- #9: closed without a merged PR");
  });

  it("an earlier Ticket closing leaves the Spec open, and only runs a Dispatch check", () => {
    const openSibling = spec({
      tickets: [
        { number: 8, open: true, pullRequests: [] },
        { number: 9, open: false, pullRequests: [50] },
      ],
    });

    expect(planFor(closed, snapshotOf(ticket, { spec: openSibling }), kitConfig())).toEqual({
      kind: "act",
      actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }],
    });
  });

  it("a Ticket closed without a merged PR is listed as such", () => {
    const wontfix = spec({ tickets: [{ number: 8, open: false, pullRequests: [] }, { number: 9, open: false, pullRequests: [50] }] });
    const [comment] = actionsOf(planFor(closed, snapshotOf(ticket, { spec: wontfix }), kitConfig()));

    expect(comment?.kind === "comment" ? comment.body : "").toContain("- #8: closed without a merged PR");
  });

  it("stays out of the Operator's pushes: no mention, assignment or review request", () => {
    expect(notificationsOf(planFor(closed, snapshotOf(ticket, { spec: spec() }), kitConfig()))).toEqual([]);
  });

  it("does nothing more to a Spec that's already closed", () => {
    expect(planFor(closed, snapshotOf(ticket, { spec: spec({ open: false }) }), kitConfig())).toEqual({
      kind: "act",
      actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }],
    });
  });

  it("closes a ready-for-human Spec the same way", () => {
    const actions = actionsOf(planFor(closed, snapshotOf(ticket, { spec: spec({ labels: ["ready-for-human"] }) }), kitConfig()));

    expect(actions.map((action) => action.kind)).toEqual(["comment", "close", "check-dispatch", "check-design-queue"]);
  });

  it.each([
    ["a wayfinder Map", ["wayfinder:map"]],
    ["a parent labelled only roadmap", ["roadmap"]],
    ["an unlabelled parent", []],
  ])("leaves %s open with no comment when its last child closes, and only runs a Dispatch check", (_, labels) => {
    expect(planFor(closed, snapshotOf(ticket, { spec: spec({ labels }) }), kitConfig())).toEqual({
      kind: "act",
      actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }],
    });
  });

  it("an issue with no parent Spec only runs a Dispatch check", () => {
    expect(planFor(closed, snapshotOf(anIssue({ ...ticket, parent: null, parentIssue: null })), kitConfig())).toEqual({
      kind: "act",
      actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }],
    });
  });
});
