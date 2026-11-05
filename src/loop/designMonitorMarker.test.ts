import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, Plan } from "./types.ts";

// A Monitor issue's body opens with a hidden marker naming what it tracks, and
// the Monitor reads only the Fabrik App's markers (#148). A Design session that
// rewrites the issue keeps that marker line, so the Monitor never files it again.
const MARKER = "<!-- fabrik:monitor sentry:4504 -->";

const monitorIssueBody = [
  MARKER,
  "## Production error",
  "",
  "<!-- fabrik:monitor-stats -->",
  "- Events in the last 24 hours: 12",
  "<!-- /fabrik:monitor-stats -->",
].join("\n");

const monitorIssue = snapshotOf(
  anIssue({ number: 7, labels: ["bug", "needs-design", "fabrik:monitor"], byApp: true, body: monitorIssueBody }),
  { operator: "jrey" },
);

const turnFinished = (output: unknown) =>
  ({ kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) }) as const;

const spec = {
  kind: "spec",
  comment: "Too big for one PR.",
  spec: { title: "Spec: Booking form errors", body: "## Problem Statement\n\nThe booking form throws." },
  tickets: [{ key: "fix", title: "Fix the form", body: "## What to build\n\nThe fix.", blockedBy: [] }],
};

describe("A Design session keeps a Monitor issue's marker", () => {
  it("opens the Spec's body with the marker line of the Monitor issue it supersedes", () => {
    const plan = planFor(turnFinished(spec), monitorIssue, kitConfig());

    expect(createdBody(plan, "spec")).toBe(
      [
        MARKER,
        "## Problem Statement",
        "",
        "The booking form throws.",
        "",
        "<sub>Written by the Fabrik Design session on #7, which this Spec supersedes.</sub>",
      ].join("\n"),
    );
  });

  it("opens the Operator brief the issue is rewritten as with its marker line", () => {
    const operatorBrief = {
      kind: "brief",
      comment: "Only the Operator can rotate the key.",
      brief: { operator: true, summary: "Rotate the leaked booking API key.", steps: ["Rotate the key", "Store it in 1Password"] },
    };

    const plan = planFor(turnFinished(operatorBrief), monitorIssue, kitConfig());

    expect(rewrittenBody(plan)).toBe(
      [
        MARKER,
        "## Operator brief",
        "",
        "Rotate the leaked booking API key.",
        "",
        "## Steps",
        "",
        "- [ ] Rotate the key",
        "- [ ] Store it in 1Password",
        "",
        "<sub>Written by the Fabrik Design session in the thread below. The original issue is in this issue's edit history.</sub>",
      ].join("\n"),
    );
  });

  it("opens the agent brief the issue is rewritten as with its marker line", () => {
    const agentBrief = {
      kind: "brief",
      comment: "One PR fixes it.",
      brief: { summary: "Guard the booking form against an empty slot.", acceptanceCriteria: ["An empty slot shows a message"] },
    };

    const plan = planFor(turnFinished(agentBrief), monitorIssue, kitConfig());

    expect(rewrittenBody(plan)).toBe(
      [
        MARKER,
        "## Agent brief",
        "",
        "Guard the booking form against an empty slot.",
        "",
        "## Acceptance criteria",
        "",
        "- [ ] An empty slot shows a message",
        "",
        "<sub>Written by the Fabrik Design session in the thread below. The original issue is in this issue's edit history.</sub>",
      ].join("\n"),
    );
  });

  it("carries no marker from an issue a person opened, so the Spec the Fabrik App opens can't make a quoted marker count", () => {
    const quoted = anIssue({ number: 7, labels: ["bug", "needs-design"], byApp: false, body: monitorIssueBody });

    const plan = planFor(turnFinished(spec), snapshotOf(quoted), kitConfig());

    expect(createdBody(plan, "spec")).not.toContain("fabrik:monitor");
  });

  it("keeps the marker line of a body edited on GitHub, whose lines end with \\r\\n", () => {
    const edited = anIssue({
      number: 7,
      labels: ["bug", "needs-design"],
      byApp: true,
      body: `Triage notes first.\r\n${MARKER}\r\n## Production error\r\n`,
    });

    const plan = planFor(turnFinished(spec), snapshotOf(edited), kitConfig());

    expect(createdBody(plan, "spec")?.split("\n")[0]).toBe(MARKER);
  });

  it("keeps a red-main issue's marker line the same way", () => {
    const redMain = anIssue({
      number: 7,
      labels: ["bug", "needs-design", "fabrik:monitor"],
      byApp: true,
      body: "<!-- fabrik:monitor red-main -->\n## Red main\n\n`main` is red at `abc1234`.",
    });

    const plan = planFor(turnFinished(spec), snapshotOf(redMain), kitConfig());

    expect(createdBody(plan, "spec")?.split("\n")[0]).toBe("<!-- fabrik:monitor red-main -->");
  });

  it("labels the Spec fabrik:monitor beside its category and state when it keeps a Sentry group's marker, so the Monitor finds the group's open issue", () => {
    const plan = planFor(turnFinished(spec), monitorIssue, kitConfig());

    expect(created(plan).map((action) => [action.key, action.labels])).toEqual([
      ["spec", ["bug", "ready-for-agent", "fabrik:monitor"]],
      ["ticket:fix", ["bug", "ready-for-agent"]],
    ]);
  });

  it("leaves fabrik:monitor off a Spec that keeps red main's marker, so the Monitor never closes a Spec when main goes green", () => {
    const redMain = anIssue({
      number: 7,
      labels: ["bug", "needs-design", "fabrik:monitor"],
      byApp: true,
      body: "<!-- fabrik:monitor red-main -->\n## Red main",
    });

    const plan = planFor(turnFinished(spec), snapshotOf(redMain), kitConfig());

    expect(created(plan).find((action) => action.key === "spec")?.labels).toEqual(["bug", "ready-for-agent"]);
  });

  it.each([
    ["a Spec", spec, (plan: Plan) => createdBody(plan, "spec")],
    [
      "an Operator brief",
      { kind: "brief", comment: "Operator work.", brief: { operator: true, summary: "Rotate the key.", steps: ["Rotate it"] } },
      rewrittenBody,
    ],
    ["an agent brief", { kind: "brief", comment: "One PR.", brief: { summary: "Fix it.", acceptanceCriteria: ["It works"] } }, rewrittenBody],
  ])("opens %s with the marker line and still ends it with the issue's From audit and escape lines (#150)", (_, output, bodyOf) => {
    const alsoFiledFromAnAudit = anIssue({
      number: 7,
      labels: ["bug", "needs-design", "fabrik:monitor"],
      byApp: true,
      body: `${monitorIssueBody}\n\nFrom audit #40\n<!-- fabrik:escape strong #31 -->`,
    });

    const lines = bodyOf(planFor(turnFinished(output), snapshotOf(alsoFiledFromAnAudit), kitConfig()))?.split("\n") ?? [];

    expect(lines[0]).toBe(MARKER);
    expect(lines.slice(-3)).toEqual(["", "From audit #40", "<!-- fabrik:escape strong #31 -->"]);
    expect(lines.filter((line) => line === MARKER)).toHaveLength(1);
  });

  it.each([
    ["a Spec", spec, (plan: Plan) => createdBody(plan, "spec")],
    [
      "an Operator brief",
      { kind: "brief", comment: "Operator work.", brief: { operator: true, summary: "Rotate the key.", steps: ["Rotate it"] } },
      rewrittenBody,
    ],
    ["an agent brief", { kind: "brief", comment: "One PR.", brief: { summary: "Fix it.", acceptanceCriteria: ["It works"] } }, rewrittenBody],
  ])("rewrites an issue whose body has no Monitor marker as %s exactly as before", (_, output, bodyOf) => {
    const unmarked = anIssue({
      number: 7,
      labels: ["bug", "needs-design"],
      byApp: true,
      body: "Quoting `<!-- fabrik:monitor sentry:4504 -->` inline isn't a marker line.\n<!-- fabrik:monitor-stats -->",
    });

    const plan = planFor(turnFinished(output), snapshotOf(unmarked), kitConfig());
    const before = planFor(turnFinished(output), snapshotOf(anIssue({ number: 7, labels: ["bug", "needs-design"] })), kitConfig());

    expect(bodyOf(plan)).toBeDefined();
    expect(bodyOf(plan)).toBe(bodyOf(before));
  });
});

function rewrittenBody(plan: Plan): string | undefined {
  const actions: readonly Action[] = plan.kind === "act" ? plan.actions : [];
  const edit = actions.find((action) => action.kind === "edit-issue-body" && action.issue === 7);
  return edit?.kind === "edit-issue-body" ? edit.body : undefined;
}

function createdBody(plan: Plan, key: string): string | undefined {
  return created(plan).find((action) => action.key === key)?.body;
}

function created(plan: Plan): Extract<Action, { kind: "create-issue" }>[] {
  return plan.kind === "act"
    ? plan.actions.filter((action): action is Extract<Action, { kind: "create-issue" }> => action.kind === "create-issue")
    : [];
}
