// A Kept-branch start (#536): a Ticket marked fabrik:kept-branch carries on the
// agent branch of the PR the Kit closed unmerged, instead of starting from main.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, aTicket, dispatchSnapshotOf, HEAD_SHA, kitConfig, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { anEvidence, CAPTURED, UI } from "../__fixtures__/uiEvidence.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan } from "./types.ts";

const KEPT_HEAD = "f".repeat(40);
const dispatched = { kind: "label-added", issue: 7, label: "agent:implement" } as const;
const marked = (overrides: Parameters<typeof anIssue>[0] = {}) =>
  anIssue({ number: 7, labels: ["enhancement", "ready-for-agent", "agent:implement", "fabrik:kept-branch"], ...overrides });

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

describe("Starting a Kept-branch start", () => {
  it("a marked Ticket whose Kept branch is there starts its run on that branch, naming the PR it came from", () => {
    const ticket = marked({ keptBranch: { head: KEPT_HEAD, pullRequest: 230 } });

    const run = actionsOf(planFor(dispatched, snapshotOf(ticket), kitConfig())).find((action) => action.kind === "start-agent-run");

    expect(run).toMatchObject({ role: "implement", issue: 7, keptBranch: { pullRequest: 230 }, model: "claude-sonnet-5-5" });
    expect(run).not.toHaveProperty("pullRequest");
  });

  it("a marked Ticket whose Kept branch is gone starts no run: it goes to ready-for-human with one comment and one assignment", () => {
    const plan = planFor(dispatched, snapshotOf(marked({ keptBranch: null })), kitConfig());

    const actions = actionsOf(plan);
    expect(actions.filter((action) => action.kind !== "comment")).toEqual([
      { kind: "remove-label", issue: 7, label: "agent:implement" },
      { kind: "remove-label", issue: 7, label: "ready-for-agent" },
      { kind: "add-labels", issue: 7, labels: ["ready-for-human"] },
      { kind: "assign", issue: 7, assignee: "operator" },
      { kind: "check-dispatch" },
    ]);
    const comments = actions.flatMap((action) => (action.kind === "comment" ? [action.body] : []));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("`fabrik/ticket-7`");
    expect(comments[0]).toContain("is gone");
    expect(comments[0]).toContain("Take `fabrik:kept-branch` off");
    expect(comments[0]).not.toContain("@");
  });

  it("an unmarked Ticket starts from main as before, whatever branch is left on the remote", () => {
    const ticket = anIssue({ number: 7, labels: ["ready-for-agent", "agent:implement"], keptBranch: null });

    const run = actionsOf(planFor(dispatched, snapshotOf(ticket), kitConfig())).find((action) => action.kind === "start-agent-run");

    expect(run).not.toHaveProperty("keptBranch");
  });
});

describe("Dispatch and a Kept-branch start", () => {
  it("never adds agent:implement to a marked Ticket whose Kept branch is gone: it stops it, and starts the next Ticket instead", () => {
    const gone = aTicket({ number: 12, labels: ["enhancement", "ready-for-agent", "fabrik:kept-branch"], keptBranch: null });
    const next = aTicket({ number: 13 });

    const actions = actionsOf(planFor({ kind: "dispatch-check" }, dispatchSnapshotOf([gone, next]), kitConfig({ maxInFlight: 1 })));

    expect(actions.filter((action) => action.kind !== "comment")).toEqual([
      { kind: "remove-label", issue: 12, label: "ready-for-agent" },
      { kind: "add-labels", issue: 12, labels: ["ready-for-human"] },
      { kind: "assign", issue: 12, assignee: "operator" },
      { kind: "add-labels", issue: 13, labels: ["agent:implement"] },
    ]);
    expect(actions.filter((action) => action.kind === "comment")).toHaveLength(1);
  });

  it("stops it even when nothing else can be dispatched", () => {
    const gone = aTicket({ number: 12, labels: ["ready-for-agent", "fabrik:kept-branch"], keptBranch: null });

    const actions = actionsOf(planFor({ kind: "dispatch-check" }, dispatchSnapshotOf([gone]), kitConfig({ maxInFlight: 0 })));

    expect(actions.map((action) => action.kind)).toEqual(["comment", "remove-label", "add-labels", "assign"]);
  });

  it("dispatches a marked Ticket whose Kept branch is there as any other", () => {
    const there = aTicket({ number: 12, labels: ["ready-for-agent", "fabrik:kept-branch"], keptBranch: { head: KEPT_HEAD, pullRequest: 230 } });

    expect(planFor({ kind: "dispatch-check" }, dispatchSnapshotOf([there]), kitConfig())).toEqual({
      kind: "act",
      actions: [{ kind: "add-labels", issue: 12, labels: ["agent:implement"] }],
    });
  });
});

describe("Setting a Kept-branch start from a Design session's agent brief", () => {
  const brief = { summary: "Finish the waitlist on the kept work.", acceptanceCriteria: ["A fully booked day shows Join waitlist"] };
  const finish = (output: unknown, labels: string[]) =>
    planFor(
      { kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) },
      snapshotOf(anIssue({ number: 7, labels }), { operator: "jrey" }),
      kitConfig(),
    );
  const labelMoves = (plan: Plan) => actionsOf(plan).filter((a) => a.kind === "add-labels" || a.kind === "remove-label");

  it("adds fabrik:kept-branch along with ready-for-agent when the brief has keptBranch: true", () => {
    expect(labelMoves(finish({ kind: "brief", comment: "Done.", brief: { ...brief, keptBranch: true } }, ["needs-design"]))).toEqual([
      { kind: "remove-label", issue: 7, label: "needs-design" },
      { kind: "add-labels", issue: 7, labels: ["ready-for-agent", "fabrik:kept-branch"] },
    ]);
  });

  it("sits beside a Stepped-up start when the brief sets both", () => {
    const plan = finish({ kind: "brief", comment: "Done.", brief: { ...brief, keptBranch: true, stepUp: true } }, ["needs-design"]);

    expect(labelMoves(plan)).toContainEqual({ kind: "add-labels", issue: 7, labels: ["ready-for-agent", "fabrik:step-up", "fabrik:kept-branch"] });
  });

  it.each([
    ["false", { keptBranch: false }],
    ["absent", {}],
  ])("leaves the mark off when keptBranch is %s, taking off one the issue has", (_, field) => {
    expect(labelMoves(finish({ kind: "brief", comment: "Done.", brief: { ...brief, ...field } }, ["needs-design", "fabrik:kept-branch"]))).toEqual([
      { kind: "remove-label", issue: 7, label: "needs-design" },
      { kind: "remove-label", issue: 7, label: "fabrik:kept-branch" },
      { kind: "add-labels", issue: 7, labels: ["ready-for-agent"] },
    ]);
  });

  it("refuses a keptBranch that isn't a boolean, naming the field", () => {
    expect(finish({ kind: "brief", comment: "Done.", brief: { ...brief, keptBranch: "yes" } }, ["needs-design"])).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason: "The Design-session turn on #7 emitted output that breaks its contract: a brief needs keptBranch to be true or false, if it has one",
    });
  });

  it("a split never sets it: a sibling Ticket asking for it breaks the contract", () => {
    const split = {
      kind: "split",
      comment: "Split.",
      tickets: [{ key: "a", title: "A", body: "Do A.", blockedBy: [], keptBranch: true }],
    };
    const plan = planFor(
      { kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(split) },
      snapshotOf(anIssue({ number: 7, labels: ["needs-design"], parent: 3 })),
      kitConfig(),
    );

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
    expect(plan.kind === "fail" ? plan.reason : "").toContain("keptBranch");
  });
});

describe("Every Back to design takes the Kept-branch mark off", () => {
  const takenOff = { kind: "remove-label", issue: 7, label: "fabrik:kept-branch" } as const;
  const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
  const markedPullRequest = aPullRequest({ ticketLabels: ["ready-for-agent", "fabrik:kept-branch"] });

  it.each([
    ["a Design flaw", { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: "verdict: design-flaw\n\nWrong approach.", runUrl: RUN, repoUrl: "https://github.com/acme/shop" }],
    ["the Operator's needs-design on the PR", { kind: "pull-request-labeled", pullRequest: 50, label: "needs-design" }],
  ] as const)("%s takes it off before needs-design goes on, so the Design session starts with it off", (_, event) => {
    const actions = actionsOf(planFor(event as LoopEvent, snapshotOfPullRequest(markedPullRequest), kitConfig()));

    expect(actions).toContainEqual(takenOff);
    expect(actions.indexOf(actions.find((a) => a.kind === "remove-label" && a.label === "fabrik:kept-branch")!)).toBeLessThan(actions.length - 1);
    expect(actions.at(-1)).toEqual({ kind: "add-labels", issue: 7, labels: ["needs-design"] });
  });

  it("a third empty diff takes it off too", () => {
    const event: LoopEvent = {
      kind: "implement-run-finished",
      issue: 7,
      output: JSON.stringify({ title: "Waitlist", summary: "Nothing left to build." }),
      branch: "fabrik/ticket-7",
      base: "main",
      changes: { net: [], commits: [] },
      runUrl: RUN,
    };
    const ticket = anIssue({ number: 7, labels: ["ready-for-agent", "fabrik:kept-branch"], emptyDiffs: 2, keptBranch: { head: KEPT_HEAD, pullRequest: 230 } });

    const actions = actionsOf(planFor(event, snapshotOf(ticket), kitConfig()));

    expect(actions).toContainEqual(takenOff);
    expect(actions).toContainEqual({ kind: "add-labels", issue: 7, labels: ["needs-design"] });
  });
});

describe("Landing a Kept-branch start", () => {
  const RUN = "https://github.com/acme/clinic/actions/runs/1/attempts/1";
  const keptRun = (overrides: Partial<Extract<LoopEvent, { kind: "implement-run-finished" }>> = {}): LoopEvent => ({
    kind: "implement-run-finished",
    issue: 7,
    output: JSON.stringify({ title: "Let patients join a waitlist", summary: "Finishes the waitlist." }),
    branch: "fabrik/ticket-7",
    base: "main",
    // Only the run's own: neither the kept commits nor main's.
    changes: { net: [{ path: "src/waitlist.ts" }], commits: [{ path: "src/waitlist.ts" }], pushedHead: "e".repeat(40) },
    runUrl: RUN,
    keptBranch: { pullRequest: 230 },
    ...overrides,
  });
  const ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent", "fabrik:kept-branch"], keptBranch: { head: KEPT_HEAD, pullRequest: 230 } });
  const opened = (plan: Plan) => actionsOf(plan).find((action) => action.kind === "open-pull-request");

  it("pushes the branch and opens one new draft PR against main whose body names the closed PR", () => {
    const actions = actionsOf(planFor(keptRun(), snapshotOf(ticket), kitConfig()));

    expect(actions).toEqual([
      { kind: "push-branch", branch: "fabrik/ticket-7" },
      {
        kind: "open-pull-request",
        issue: 7,
        head: "fabrik/ticket-7",
        base: "main",
        title: "Let patients join a waitlist",
        body: "Finishes the waitlist.\n\nCarries on from #230.\n\nCloses #7",
        draft: true,
      },
    ]);
  });

  it("names no closed PR when none was found, and still opens one", () => {
    expect(opened(planFor(keptRun({ keptBranch: { pullRequest: null } }), snapshotOf(ticket), kitConfig()))).toMatchObject({
      body: "Finishes the waitlist.\n\nCloses #7",
    });
  });

  it("lists the whole PR's changed existing tests, not only the run's own", () => {
    const changes = { net: [{ path: "src/waitlist.ts" }], commits: [{ path: "src/waitlist.ts" }], changedTests: [], wholeBranch: { net: [{ path: "src/waitlist.ts" }, { path: "src/booking.test.ts" }], changedTests: ["src/booking.test.ts"] } };

    const body = (opened(planFor(keptRun({ changes }), snapshotOf(ticket), kitConfig())) as { body: string }).body;

    expect(body).toContain("`src/booking.test.ts`");
  });

  it("is a UI PR when the whole branch touches ui.paths, though the run's own commits don't", () => {
    const changes = { net: [{ path: "src/waitlist.ts" }], commits: [{ path: "src/waitlist.ts" }], wholeBranch: { net: [{ path: "src/pages/waitlist.astro" }, { path: "src/waitlist.ts" }], changedTests: [] } };

    const body = (opened(planFor(keptRun({ changes, evidence: anEvidence(CAPTURED) }), snapshotOf(ticket), kitConfig({ ui: UI }))) as { body: string }).body;

    expect(body).toContain("## UI evidence");
  });

  it.each([
    ["commits nothing of its own", { net: [], commits: [] }],
    ["only merges main in", { net: [], commits: [], updatedFromMain: true }],
  ])("one that %s is an empty diff, and its Retry carries on the Kept branch too", (_, changes) => {
    const actions = actionsOf(planFor(keptRun({ changes }), snapshotOf(ticket), kitConfig()));

    expect(actions.map((action) => action.kind)).not.toContain("push-branch");
    expect(actions).toContainEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });

    const retry = actionsOf(planFor(dispatched, snapshotOf({ ...ticket, labels: [...ticket.labels, "agent:implement"], emptyDiffs: 1 }), kitConfig())).find(
      (action) => action.kind === "start-agent-run",
    );
    expect(retry).toMatchObject({ retry: 1, keptBranch: { pullRequest: 230 } });
  });

  it("judges only the run's own changes with the trust-root guard", () => {
    const actions = actionsOf(planFor(keptRun({ changes: { net: [{ path: "AGENTS.md" }], commits: [{ path: "AGENTS.md" }] } }), snapshotOf(ticket), kitConfig()));

    expect(actions).toContainEqual({ kind: "add-labels", issue: 7, labels: ["ready-for-human"] });
  });

  it("starts again on the moved head when the Kept branch moved under it and its commits conflict, using no retry", () => {
    const changes = { net: [], commits: [], rebase: { onto: "9".repeat(40), conflicted: true } };

    const actions = actionsOf(planFor(keptRun({ changes }), snapshotOf(ticket), kitConfig()));

    expect(actions.map((action) => action.kind)).toEqual(["comment", "add-labels"]);
    expect(actions[1]).toEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
    expect((actions[0] as { body: string }).body).not.toContain("<!-- fabrik:empty-diff");
  });
});
