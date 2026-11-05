import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { LoopEvent, Snapshot } from "./types.ts";

// The Operator's reply to a round starts a Design-session turn. If they delete
// that reply before the turn posts, the turn posts nothing (#104).
const REPLY = 4242;

const ticket = (key: string) => ({ key, title: `Waitlist: ${key}`, body: `The ${key} slice.`, blockedBy: [] });

const OUTPUTS = {
  round: { kind: "round", intro: "Two decisions left.", questions: [{ question: "Which days?", recommendation: "Weekdays." }] },
  brief: {
    kind: "brief",
    comment: "Decided.",
    brief: { summary: "A waitlist.", acceptanceCriteria: ["A patient can join the waitlist"] },
  },
  spec: {
    kind: "spec",
    comment: "Two slices.",
    spec: { title: "Spec: Waitlist", body: "## Problem Statement\n\nFully booked days lose patients." },
    tickets: [ticket("model"), ticket("page")],
  },
  split: { kind: "split", comment: "Two slices.", tickets: [ticket("model"), ticket("page")] },
  "not-planned": { kind: "not-planned", comment: "Not worth it." },
} as const;

const turnFinished = (output: unknown, startedBy?: number): LoopEvent => ({
  kind: "agent-run-finished",
  role: "design",
  issue: 7,
  output: JSON.stringify(output),
  ...(startedBy === undefined ? {} : { startedBy }),
});

const inSession = (kind: keyof typeof OUTPUTS, startingComment: Snapshot["startingComment"]): Snapshot =>
  snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"], parent: kind === "split" ? 3 : null, designRounds: 1 }), {
    operator: "jrey",
    startingComment,
  });

describe("A Design-session turn whose starting reply was deleted", () => {
  for (const kind of Object.keys(OUTPUTS) as (keyof typeof OUTPUTS)[]) {
    it(`applies nothing when the turn ends with a ${kind}, naming the deleted comment`, () => {
      const plan = planFor(turnFinished(OUTPUTS[kind], REPLY), inSession(kind, { id: REPLY, exists: false }), kitConfig());

      expect(plan.kind).toBe("nothing");
      expect(plan.kind === "nothing" && plan.reason).toContain(`comment ${REPLY}`);
      expect(plan.kind === "nothing" && plan.reason).toContain("deleted");
    });
  }

  it("applies nothing even when the turn's output breaks its contract", () => {
    const plan = planFor(turnFinished({ kind: "nonsense" }, REPLY), inSession("round", { id: REPLY, exists: false }), kitConfig());

    expect(plan.kind).toBe("nothing");
  });
});

describe("A Design-session turn whose starting reply still exists", () => {
  for (const kind of Object.keys(OUTPUTS) as (keyof typeof OUTPUTS)[]) {
    it(`applies a ${kind} exactly as a turn with no starting reply does`, () => {
      const fromReply = planFor(turnFinished(OUTPUTS[kind], REPLY), inSession(kind, { id: REPLY, exists: true }), kitConfig());
      const firstRound = planFor(turnFinished(OUTPUTS[kind]), inSession(kind, null), kitConfig());

      expect(fromReply.kind).toBe("act");
      expect(fromReply).toEqual(firstRound);
    });
  }
});

describe("A Design-session turn started by adding needs-design", () => {
  it("has no reply to check, so its round posts", () => {
    const plan = planFor(turnFinished(OUTPUTS.round), inSession("round", null), kitConfig());

    expect(plan).toMatchObject({ kind: "act", actions: [{ kind: "comment", issue: 7 }] });
  });
});

describe("A Design-session turn whose snapshot didn't check its starting reply", () => {
  it("is an Infrastructure failure, never a drop or a post", () => {
    const missed = planFor(turnFinished(OUTPUTS.round, REPLY), inSession("round", null), kitConfig());
    const other = planFor(turnFinished(OUTPUTS.round, REPLY), inSession("round", { id: 1, exists: true }), kitConfig());

    expect(missed).toMatchObject({ kind: "fail", failure: "infrastructure" });
    expect(other).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });
});
