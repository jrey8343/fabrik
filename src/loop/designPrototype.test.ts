import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";

const turnFinished = (output: unknown) =>
  ({ kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) }) as const;

const inSession = snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"] }), { operator: "jrey" });

const requested = {
  kind: "prototype",
  route: "/book",
  variants: 3,
  brief: "- **A**: one long form.\n- **B**: a stepper.\n- **C**: a calendar first.",
  comment: "Prototyping the booking page as you approved.",
};

describe("A Design turn that asks for a Prototype while Prototypes are off", () => {
  it("fails as a broken contract and posts nothing", () => {
    const plan = planFor(turnFinished(requested), inSession, kitConfig());

    expect(plan).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason: "The Design-session turn on #7 emitted output that breaks its contract: Prototypes are off in this Kit, so a turn can't ask for one",
    });
  });
});
