import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan } from "./types.ts";

const split = {
  kind: "split",
  comment: "The cart total and the checkout change ship separately.",
  tickets: [
    { key: "checkout", title: "Checkout reads the cart total", body: "## What to build\n\nRead it.", blockedBy: ["total"] },
    { key: "total", title: "The cart keeps a total", body: "## What to build\n\nKeep it.", blockedBy: [] },
  ],
};

function finished(output: unknown): LoopEvent {
  return { kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) };
}

/** Ticket #7 under the Spec #3, back in a Design session. */
const ticket = anIssue({ number: 7, parent: 3, labels: ["enhancement", "needs-design"] });

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

describe("A Design session splits a Ticket into sibling Tickets", () => {
  it("creates each Ticket under the original Spec, blockers first, and closes the Ticket as superseded", () => {
    const plan = planFor(finished(split), snapshotOf(ticket), kitConfig());

    expect(actionsOf(plan)).toEqual([
      {
        kind: "create-issue",
        key: "ticket:total",
        title: "The cart keeps a total",
        body: "## What to build\n\nKeep it.",
        labels: ["enhancement", "ready-for-agent"],
        parent: 3,
        blockedBy: [],
      },
      {
        kind: "create-issue",
        key: "ticket:checkout",
        title: "Checkout reads the cart total",
        body: "## What to build\n\nRead it.",
        labels: ["enhancement", "ready-for-agent"],
        parent: 3,
        blockedBy: [{ created: "ticket:total" }],
      },
      { kind: "remove-label", issue: 7, label: "needs-design" },
      {
        kind: "close-as-superseded",
        issue: 7,
        comment: [
          "**Design session finished.** This Ticket is split into ",
          { created: "ticket:total" },
          ", ",
          { created: "ticket:checkout" },
          ", sibling Tickets under the Spec #3.\n\nThe cart total and the checkout change ship separately.",
        ],
      },
      { kind: "check-dispatch" },
      { kind: "check-design-queue" },
    ]);
  });

  it("notifies nobody", () => {
    const noisy = { ...split, comment: "Thanks @jrey.", tickets: [{ ...split.tickets[1], body: "Ask @jrey." }] };
    const plan = planFor(finished(noisy), snapshotOf(ticket, { operator: "jrey" }), kitConfig());

    expect(notificationsOf(plan, "jrey")).toEqual([]);
    const created = actionsOf(plan).find((action) => action.kind === "create-issue");
    expect(created?.kind === "create-issue" ? created.body : "").not.toMatch(/(?<!\w)@jrey/);
  });

  it("an issue with no Spec above it can't split into siblings: the turn fails, changing nothing", () => {
    const plan = planFor(finished(split), snapshotOf(anIssue({ ...ticket, parent: null, parentIssue: null })), kitConfig());

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });

  it("a Ticket under a Spec never gets a Spec of its own: the turn fails, changing nothing", () => {
    const spec = {
      kind: "spec",
      comment: "Big.",
      spec: { title: "Spec: cart", body: "## Problem Statement\n\nBig." },
      tickets: [{ key: "a", title: "A", body: "A.", blockedBy: [] }],
    };
    const plan = planFor(finished(spec), snapshotOf(ticket), kitConfig());

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });

  it.each([
    ["has no tickets", { ...split, tickets: [] }],
    ["has no comment", { ...split, comment: "" }],
    ["has blockers that loop", { ...split, tickets: [{ ...split.tickets[0], blockedBy: ["total"] }, { ...split.tickets[1], blockedBy: ["checkout"] }] }],
  ])("fails the turn as an Infrastructure failure when the split %s", (_, output) => {
    const plan = planFor(finished(output), snapshotOf(ticket), kitConfig());

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });
});

describe("Sibling Tickets take the split Ticket's place among its blockers", () => {
  // "total" and "badge" start first; "checkout" and "badge" finish last.
  const wide = { ...split, tickets: [...split.tickets, { key: "badge", title: "Badge", body: "Show it.", blockedBy: [] }] };
  const blocked = { ...ticket, openBlockers: [10], openBlocking: [20] };

  it("gives the Tickets nothing else blocks the open blockers, and the open issues it blocked an edge to the Tickets that finish last, before it closes", () => {
    const actions = actionsOf(planFor(finished(wide), snapshotOf(blocked), kitConfig()));

    expect(
      actions.flatMap((action) => (action.kind === "create-issue" ? [[action.key, action.blockedBy]] : [])),
    ).toEqual([
      ["ticket:total", [10]],
      ["ticket:checkout", [{ created: "ticket:total" }]],
      ["ticket:badge", [10]],
    ]);
    expect(actions.filter((action) => action.kind === "add-blocked-by")).toEqual([
      { kind: "add-blocked-by", issue: 20, blocker: { created: "ticket:checkout" } },
      { kind: "add-blocked-by", issue: 20, blocker: { created: "ticket:badge" } },
    ]);
    const closing = actions.findIndex((action) => action.kind === "close-as-superseded");
    expect(actions.findLastIndex((action) => action.kind === "add-blocked-by")).toBeLessThan(closing);
  });

  it("lists the moved edges in the closing comment", () => {
    const actions = actionsOf(planFor(finished(wide), snapshotOf(blocked), kitConfig()));

    const close = actions.find((action) => action.kind === "close-as-superseded");
    const text = close?.kind === "close-as-superseded"
      ? close.comment.map((part) => (typeof part === "string" ? part : `<${part.created}>`)).join("")
      : "";
    expect(text).toMatch(
      /ship separately\.\n\nBlocked-by edges moved to the new Tickets:\n- <ticket:total>, <ticket:badge> are now blocked by #10\.\n- #20 is now blocked by <ticket:checkout>, <ticket:badge>\.$/,
    );
  });
});

describe("A rewritten or split Ticket starts again on the default model", () => {
  it("agent:implement on a Ticket whose stepped-up PR went back to design starts the Implementer's own model", () => {
    const config = kitConfig();
    // The closed PR's Step-up stays on that PR: the Ticket links no open PR now.
    const rewritten = anIssue({ number: 7, parent: 3, labels: ["enhancement", "ready-for-agent", "agent:implement"] });
    const plan = planFor({ kind: "label-added", issue: 7, label: "agent:implement" }, snapshotOf(rewritten), config);

    expect(actionsOf(plan)).toContainEqual(
      expect.objectContaining({ kind: "start-agent-run", role: "implement", model: config.roles.implement.model }),
    );
    expect(config.roles.implement.model).not.toBe(config.roles.stepUp.model);
  });
});
