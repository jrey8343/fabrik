import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan } from "./types.ts";

const dispatched = (issue = 7) => ({ kind: "label-added", issue, label: "agent:implement" }) as const;

describe("Starting an Implementer", () => {
  it("agent:implement on a ready Ticket starts an Implement run on the Implementer model and takes the label off", () => {
    const ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent", "agent:implement"] });

    const plan = planFor(dispatched(), snapshotOf(ticket), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "agent:implement" },
        {
          kind: "start-agent-run",
          role: "implement",
          issue: 7,
          model: "claude-sonnet-5-5",
          effort: null,
          timeoutMinutes: 60,
          subscription: "Claude token",
        },
      ],
    });
  });

  it.each([
    ["is closed", anIssue({ number: 7, open: false, labels: ["ready-for-agent", "agent:implement"] })],
    ["isn't ready-for-agent", anIssue({ number: 7, labels: ["needs-design", "agent:implement"] })],
    ["already has an open PR", anIssue({ number: 7, labels: ["ready-for-agent", "agent:implement"], openPullRequests: [50] })],
  ])("a Ticket that %s only loses the label, and no Implementer starts", (_why, ticket) => {
    const plan = planFor(dispatched(), snapshotOf(ticket), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "remove-label", issue: 7, label: "agent:implement" }] });
  });
});

/** An Implement run's push job: the Implementer's output and the paths its branch changes. */
function finished(
  overrides: Partial<Extract<LoopEvent, { kind: "implement-run-finished" }>> = {},
): Extract<LoopEvent, { kind: "implement-run-finished" }> {
  return {
    kind: "implement-run-finished",
    issue: 7,
    output: JSON.stringify({ title: "Let patients join a waitlist", summary: "Adds a waitlist to full days." }),
    branch: "fabrik/ticket-7",
    base: "main",
    changes: { net: [{ path: "src/waitlist.ts" }], commits: [{ path: "src/waitlist.ts" }] },
    ...overrides,
  };
}

const readyTicket = () => anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"] });

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

function commentsOf(actions: readonly Action[]): string[] {
  return actions.flatMap((action) => (action.kind === "comment" ? [action.body] : []));
}

describe("The push job's trust-root guard", () => {
  it("a branch that edits AGENTS.md moves the Ticket to ready-for-human, assigns the Operator and lists the path, with no retry", () => {
    const event = finished({
      changes: {
        net: [{ path: "src/waitlist.ts" }, { path: "AGENTS.md" }],
        commits: [{ path: "src/waitlist.ts" }, { path: "AGENTS.md" }],
      },
    });

    const actions = actionsOf(planFor(event, snapshotOf(readyTicket()), kitConfig()));

    expect(actions.filter((action) => action.kind !== "comment")).toEqual([
      { kind: "remove-label", issue: 7, label: "ready-for-agent" },
      { kind: "add-labels", issue: 7, labels: ["ready-for-human"] },
      { kind: "assign", issue: 7, assignee: "operator" },
      { kind: "check-dispatch" },
    ]);
    const [comment, ...more] = commentsOf(actions);
    expect(more).toEqual([]);
    expect(actions).toContainEqual(expect.objectContaining({ kind: "comment", issue: 7 }));
    expect(comment).toContain("`AGENTS.md`");
    expect(comment).not.toContain("src/waitlist.ts");
    // The assignment is ready-for-human's one notification.
    expect(comment).not.toMatch(/@operator/);
  });

  it("a trust-root change made in one commit and undone in a later one is still refused", () => {
    const event = finished({
      changes: {
        net: [{ path: "src/waitlist.ts" }],
        commits: [{ path: "src/waitlist.ts" }, { path: ".github/workflows/ci.yml" }],
      },
    });

    const actions = actionsOf(planFor(event, snapshotOf(readyTicket()), kitConfig()));

    expect(actions).toContainEqual({ kind: "add-labels", issue: 7, labels: ["ready-for-human"] });
    expect(commentsOf(actions)[0]).toContain("`.github/workflows/ci.yml`");
  });
});

describe("An empty diff", () => {
  const empty = finished({ changes: { net: [], commits: [] } });

  it("is an Execution flaw, never a pass: nothing is pushed, and the Implementer runs again", () => {
    const actions = actionsOf(planFor(empty, snapshotOf(readyTicket()), kitConfig()));

    expect(actions.filter((action) => action.kind !== "comment")).toEqual([
      { kind: "add-labels", issue: 7, labels: ["agent:implement"] },
    ]);
    const [comment, ...more] = commentsOf(actions);
    expect(more).toEqual([]);
    expect(comment).toContain("Execution flaw");
    // Retries stay silent.
    expect(comment).not.toMatch(/@operator/);
  });

  it("counts as an empty diff when later commits undo everything earlier ones changed", () => {
    const undone = finished({ changes: { net: [], commits: [{ path: "src/waitlist.ts" }] } });

    const actions = actionsOf(planFor(undone, snapshotOf(readyTicket()), kitConfig()));

    expect(actions).toContainEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
    expect(actions.some((action) => action.kind === "push-branch")).toBe(false);
  });

  it("is still a trust-root refusal when an undone commit touched a trust root", () => {
    const undone = finished({ changes: { net: [], commits: [{ path: "CLAUDE.md" }] } });

    const actions = actionsOf(planFor(undone, snapshotOf(readyTicket()), kitConfig()));

    expect(actions).toContainEqual({ kind: "add-labels", issue: 7, labels: ["ready-for-human"] });
  });

  it("is marked so later runs can count it", () => {
    const [comment] = commentsOf(actionsOf(planFor(empty, snapshotOf(readyTicket()), kitConfig())));

    expect(comment).toMatch(/^<!-- fabrik:empty-diff -->\n/);
  });

  it("a third one is a Design flaw: the Ticket goes back to needs-design instead of retrying", () => {
    const ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], emptyDiffs: 2 });

    const actions = actionsOf(planFor(empty, snapshotOf(ticket), kitConfig()));

    expect(actions.filter((action) => action.kind !== "comment")).toEqual([
      { kind: "remove-label", issue: 7, label: "ready-for-agent" },
      { kind: "add-labels", issue: 7, labels: ["needs-design"] },
      { kind: "check-dispatch" },
    ]);
    // The Design session's round 1 is this event's one notification.
    expect(commentsOf(actions)[0]).not.toMatch(/@operator/);
  });

  it("the second retry is a Step-up", () => {
    const after = (emptyDiffs: number) =>
      anIssue({ number: 7, labels: ["ready-for-agent", "agent:implement"], emptyDiffs });
    const modelOf = (plan: Plan) => actionsOf(plan).find((action) => action.kind === "start-agent-run");

    expect(modelOf(planFor(dispatched(), snapshotOf(after(1)), kitConfig()))).toMatchObject({
      model: "claude-sonnet-5-5",
    });
    expect(modelOf(planFor(dispatched(), snapshotOf(after(2)), kitConfig()))).toMatchObject({
      model: "claude-opus-5-5",
      timeoutMinutes: 60,
    });
  });

  it("each retry after an empty diff says which Retry it is, and the second that it Steps up", () => {
    const after = (emptyDiffs: number) =>
      anIssue({ number: 7, labels: ["ready-for-agent", "agent:implement"], emptyDiffs });
    const runOf = (emptyDiffs: number) =>
      actionsOf(planFor(dispatched(), snapshotOf(after(emptyDiffs)), kitConfig())).find((action) => action.kind === "start-agent-run");

    expect(runOf(0)).not.toHaveProperty("retry");
    expect(runOf(1)).toMatchObject({ retry: 1, stepUp: false });
    expect(runOf(2)).toMatchObject({ retry: 2, stepUp: true });
  });
});

describe("Opening the draft PR", () => {
  it("an allowed branch is pushed and opens one draft PR from main that closes the Ticket", () => {
    const plan = planFor(finished(), snapshotOf(readyTicket()), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "push-branch", branch: "fabrik/ticket-7" },
        {
          kind: "open-pull-request",
          issue: 7,
          head: "fabrik/ticket-7",
          base: "main",
          title: "Let patients join a waitlist",
          body: "Adds a waitlist to full days.\n\nCloses #7",
          draft: true,
        },
      ],
    });
  });

  it.each([
    ["names the routes its change shows on", ["/waitlist"]],
    ["names routes that aren't paths", ["waitlist", 5]],
    ["gives routes that aren't a list", "/waitlist"],
  ])("a run that %s opens the same draft PR as one that names none", (_, routes) => {
    const output = JSON.stringify({ title: "Let patients join a waitlist", summary: "Adds a waitlist to full days.", routes });

    const plan = planFor(finished({ output }), snapshotOf(readyTicket()), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "push-branch", branch: "fabrik/ticket-7" },
        {
          kind: "open-pull-request",
          issue: 7,
          head: "fabrik/ticket-7",
          base: "main",
          title: "Let patients join a waitlist",
          body: "Adds a waitlist to full days.\n\nCloses #7",
          draft: true,
        },
      ],
    });
  });

  it("the PR never @-mentions anyone, so opening it notifies nobody", () => {
    const output = JSON.stringify({ title: "Ask @someone", summary: "Thanks @operator for the idea." });

    const actions = actionsOf(planFor(finished({ output }), snapshotOf(readyTicket()), kitConfig()));

    const pullRequest = actions.find((action) => action.kind === "open-pull-request")!;
    expect(pullRequest.body).not.toMatch(/(^|\s)@operator\b/);
    expect(pullRequest.title).not.toMatch(/(^|\s)@someone\b/);
  });

  it("a first run's output needs no fix, and one it carries anyway doesn't reach the PR", () => {
    const event = finished({
      output: JSON.stringify({ title: "Let patients join a waitlist", summary: "Adds a waitlist to full days.", fix: "Nothing to fix." }),
    });

    const actions = actionsOf(planFor(event, snapshotOf(readyTicket()), kitConfig()));

    expect(actions).toContainEqual(expect.objectContaining({ kind: "open-pull-request", body: "Adds a waitlist to full days.\n\nCloses #7" }));
  });

  it("output that breaks the Implementer's contract is an Infrastructure failure and pushes nothing", () => {
    const plan = planFor(finished({ output: '{"title": ""}' }), snapshotOf(readyTicket()), kitConfig());

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });

  it.each([
    ["was closed meanwhile", anIssue({ number: 7, open: false, labels: ["ready-for-agent"] })],
    ["was taken out of ready-for-agent meanwhile", anIssue({ number: 7, labels: ["needs-design"] })],
    ["got another open PR meanwhile", anIssue({ number: 7, labels: ["ready-for-agent"], openPullRequests: [51] })],
  ])("a Ticket that %s gets nothing pushed", (_why, ticket) => {
    expect(planFor(finished(), snapshotOf(ticket), kitConfig())).toMatchObject({ kind: "nothing" });
  });
});
