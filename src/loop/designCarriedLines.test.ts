import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Plan } from "./types.ts";

// An Audit candidate the Operator filed ends with its trailer: the Audit it came
// from, and the hidden marker that counts it as an Architectural escape (#150).
const filedCandidate = [
  "## Files",
  "",
  "- src/booking.ts",
  "",
  "## Problem",
  "",
  "Booking and billing share one module.",
  "",
  "From audit #40",
  "<!-- fabrik:escape strong #31 #35 -->",
].join("\n");

const turnFinished = (output: unknown) =>
  ({ kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) }) as const;

const inSession = (body: string) =>
  snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"], body }), { operator: "jrey" });

const operatorBrief = {
  kind: "brief",
  comment: "This is all Operator work.",
  brief: { operator: true, summary: "Split the module by hand.", steps: ["Move billing out"] },
};

const agentBrief = {
  kind: "brief",
  comment: "One PR does it.",
  brief: { summary: "Move billing into its own module.", acceptanceCriteria: ["Booking imports nothing from billing"] },
};

const spec = {
  kind: "spec",
  comment: "Too big for one PR.",
  spec: { title: "Spec: Split booking from billing", body: "## Problem Statement\n\nBooking and billing share one module." },
  tickets: [{ key: "split", title: "Move billing out", body: "## What to build\n\nMove billing into its own module.", blockedBy: [] }],
};

describe("A Design session's rewrite keeps the issue's From audit line and escape marker", () => {
  it("ends the Operator brief with both lines, as the filed issue did", () => {
    const plan = planFor(turnFinished(operatorBrief), inSession(filedCandidate), kitConfig());

    expect(rewrittenBody(plan)).toBe(
      [
        "## Operator brief",
        "",
        "Split the module by hand.",
        "",
        "## Steps",
        "",
        "- [ ] Move billing out",
        "",
        "<sub>Written by the Fabrik Design session in the thread below. The original issue is in this issue's edit history.</sub>",
        "",
        "From audit #40",
        "<!-- fabrik:escape strong #31 #35 -->",
      ].join("\n"),
    );
  });

  it("ends the agent brief with both lines too, since it rewrites the filed issue in place", () => {
    const plan = planFor(turnFinished(agentBrief), inSession(filedCandidate), kitConfig());

    expect(rewrittenBody(plan)).toBe(
      [
        "## Agent brief",
        "",
        "Move billing into its own module.",
        "",
        "## Acceptance criteria",
        "",
        "- [ ] Booking imports nothing from billing",
        "",
        "<sub>Written by the Fabrik Design session in the thread below. The original issue is in this issue's edit history.</sub>",
        "",
        "From audit #40",
        "<!-- fabrik:escape strong #31 #35 -->",
      ].join("\n"),
    );
  });

  it("ends the Spec that supersedes the issue with both lines, so the escape still counts once it's work", () => {
    const plan = planFor(turnFinished(spec), inSession(filedCandidate), kitConfig());

    expect(createdBody(plan, "spec")).toBe(
      [
        "## Problem Statement",
        "",
        "Booking and billing share one module.",
        "",
        "<sub>Written by the Fabrik Design session on #7, which this Spec supersedes.</sub>",
        "",
        "From audit #40",
        "<!-- fabrik:escape strong #31 #35 -->",
      ].join("\n"),
    );
  });

  it("leaves the Spec's Tickets as they were: only the Spec takes the issue's place", () => {
    const plan = planFor(turnFinished(spec), inSession(filedCandidate), kitConfig());

    expect(createdBody(plan, "ticket:split")).toBe("## What to build\n\nMove billing into its own module.");
  });

  it("carries the lines even when the Operator indented them, writing each as the marker alone", () => {
    const plan = planFor(turnFinished(operatorBrief), inSession("Split it.\n\n  From audit #40  \n\t<!-- fabrik:escape moderate #31 -->"), kitConfig());

    expect(rewrittenBody(plan)?.split("\n").slice(-2)).toEqual(["From audit #40", "<!-- fabrik:escape moderate #31 -->"]);
  });

  it("carries no line quoted in a code block, which is data, not a marker line", () => {
    for (const fence of ["```", "~~~", "````text"]) {
      const quoting = ["The log said:", "", fence, "From audit #40", "<!-- fabrik:escape strong #31 -->", fence.replace("text", ""), "", "Split it."].join("\n");

      expect(planFor(turnFinished(spec), inSession(quoting), kitConfig())).toEqual(planFor(turnFinished(spec), inSession("Split it."), kitConfig()));
    }
  });

  it("carries a line indented as far as an indented code block, since only a fence opens a code block here", () => {
    const indented = ["The log said:", "", "    From audit #40", "    <!-- fabrik:escape strong #31 -->", "", "Split it."].join("\n");

    const plan = planFor(turnFinished(operatorBrief), inSession(indented), kitConfig());

    expect(rewrittenBody(plan)?.split("\n").slice(-2)).toEqual(["From audit #40", "<!-- fabrik:escape strong #31 -->"]);
  });

  it("still carries the lines of a filed candidate whose body was cut short inside a code block, since a fence that never closes quotes nothing", () => {
    const cutShort = ["**Solution:** Split it:", "", "```ts", "export function slotsFor(…", "", "From audit #40", "<!-- fabrik:escape strong #31 -->"].join("\n");

    const plan = planFor(turnFinished(operatorBrief), inSession(cutShort), kitConfig());

    expect(rewrittenBody(plan)?.split("\n").slice(-2)).toEqual(["From audit #40", "<!-- fabrik:escape strong #31 -->"]);
  });

  it("notifies nobody through a carried line that @-mentions someone", () => {
    const plan = planFor(turnFinished(spec), inSession("<!-- fabrik:escape strong #31 @someone -->"), kitConfig());

    expect(createdBody(plan, "spec")?.split("\n").at(-1)).toBe("<!-- fabrik:escape strong #31 @\u200bsomeone -->");
  });

  it.each([
    ["an Operator brief", operatorBrief],
    ["an agent brief", agentBrief],
    ["a Spec", spec],
  ])("rewrites an issue with neither line as %s exactly as before, mentioning the Audit in passing or not", (_, output) => {
    const plainIssue = [
      "Booking and billing share one module, as From audit #40 said.",
      "",
      "> From audit #40",
      "<!-- a note to myself -->",
    ].join("\n");

    expect(planFor(turnFinished(output), inSession(plainIssue), kitConfig())).toEqual(
      planFor(turnFinished(output), inSession(""), kitConfig()),
    );
  });
});

/** The body of the issue the plan creates under this key. */
function createdBody(plan: Plan, key: string): string | undefined {
  if (plan.kind !== "act") return undefined;
  const create = plan.actions.find((action) => action.kind === "create-issue" && action.key === key);
  return create?.kind === "create-issue" ? create.body : undefined;
}

/** The body the plan rewrites issue #7 to. */
function rewrittenBody(plan: Plan): string | undefined {
  if (plan.kind !== "act") return undefined;
  const edit = plan.actions.find((action) => action.kind === "edit-issue-body" && action.issue === 7);
  return edit?.kind === "edit-issue-body" ? edit.body : undefined;
}
