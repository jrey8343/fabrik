import { describe, expect, it } from "vitest";
import { aPullRequest, anIssue, kitConfig, RETRO_WINDOW_END, retroBody, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { acceptedBody, aReplayIssue, baseOf } from "../__fixtures__/replay.ts";
import { UI } from "../__fixtures__/uiEvidence.ts";
import type { EvidenceMarker } from "../evidence/uiEvidence.ts";
import { planFor } from "../loop/rules.ts";
import type { Label } from "../loop/labels.ts";
import type { Action, AgentRole, Plan } from "../loop/types.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { kitJobOutputs } from "./jobs.ts";

const config = kitConfig({
  roles: { ...DEFAULT_KIT_CONFIG.roles, retro: { model: "claude-retro", effort: "high", timeoutMinutes: 50 } },
});

describe("The Kit job's routing of a replay Ticket (#156)", () => {
  const replay = anIssue({ number: 140, author: "operator", labels: ["fabrik:replay", "agent:replay"], body: acceptedBody() });
  // The claim's snapshot holds every open replay issue, this one among them.
  const issues = { issues: [aReplayIssue({ author: "operator" })], capacity: null, acceptance: null };
  const started = planFor({ kind: "label-added", issue: 140, label: "agent:replay" }, snapshotOf(replay, { replay: issues }), kitConfig());

  it("routes agent:replay on an accepted replay issue to replay, passing out its next Ticket, merged PR and baseSha, each arm's settings and the Subscription", () => {
    expect(kitJobOutputs(started, null, kitConfig())).toMatchObject({
      route: "replay",
      "replay-issue": "140",
      ticket: "12",
      "pull-request": "112",
      "base-sha": baseOf(12),
      "replay-arms": JSON.stringify({
        baseline: { implement: { model: "claude-sonnet-5-5", effort: null }, review: { model: "claude-opus-5-5", effort: null }, candidateSha: null },
        variant: { implement: { model: "claude-sonnet-5-5", effort: null }, review: { model: "claude-opus-5-5", effort: "high" }, candidateSha: null },
      }),
      subscription: "Claude token",
      model: "",
      effort: "",
      branch: "",
      retry: "",
    });
  });

  it("passes out no replay for any other run", () => {
    expect(kitJobOutputs(null, null, kitConfig())).toMatchObject({ "replay-issue": "", "base-sha": "", "replay-arms": "" });
  });
});

describe("The Kit job's main head for a run on an agent PR's branch (#341)", () => {
  it("passes out main's head as it read it, which the push job takes for the main the run may have brought in", () => {
    expect(kitJobOutputs(null, null, kitConfig(), "9".repeat(40))).toMatchObject({ "main-at-start": "9".repeat(40) });
    expect(kitJobOutputs(null, null, kitConfig())).toMatchObject({ "main-at-start": "" });
  });
});

describe("The Kit job's routing", () => {
  // The Retro evidence job, then the Retro job, run on the retro route (#151), both within retro-timeout-minutes.
  it("routes the App's pending Retro to the Retro jobs, within roles.retro's timeout, on its model and effort, with no Ticket, PR or commit", () => {
    const retro = anIssue({ number: 120, byApp: true, labels: ["fabrik:retro"], body: retroBody(RETRO_WINDOW_END, "pending") });

    const outputs = kitJobOutputs(planFor({ kind: "issue-opened", issue: 120 }, snapshotOf(retro), config), null, config);

    expect(outputs).toMatchObject({
      route: "retro",
      "retro-timeout-minutes": "50",
      model: "claude-retro",
      effort: "high",
      "pull-request": "",
      ticket: "",
      branch: "",
      review: "",
      "audit-commit": "",
      retry: "",
      "step-up": "false",
      "request-changes": "false",
    });
  });

  // As for every agent run (#152): the Retro job loads the chosen Subscription's Claude token.
  it("passes out the Subscription a Retro run is given and whether rotation is on, for the Retro job's Claude token", () => {
    const rotating = kitConfig({ ...config, subscriptions: ["Claude token", "Claude token 2"] });
    const retro = anIssue({ number: 120, byApp: true, labels: ["fabrik:retro"], body: retroBody(RETRO_WINDOW_END, "pending") });
    const firstUsedUp = {
      number: 40,
      labels: ["fabrik:weekly-limit"],
      body: "<!-- fabrik:subscription Claude token -->\n<!-- fabrik:resets-at 2026-11-09T04:00:00.000Z -->",
      comments: [],
    };

    const plan = planFor({ kind: "issue-opened", issue: 120 }, snapshotOf(retro, { kitIssues: [firstUsedUp] }), rotating);

    expect(kitJobOutputs(plan, null, rotating)).toMatchObject({ route: "retro", subscription: "Claude token 2", rotation: "true" });
  });

  it("passes out roles.retro's timeout whatever it routes to, as it does every role's", () => {
    const outputs = kitJobOutputs(null, null, kitConfig());

    expect(outputs).toMatchObject({ route: "none", "implement-timeout-minutes": "60", "retro-timeout-minutes": "45" });
  });

  // The Research job runs within it (#154), and names the Decision's branch itself, from the title it starts with.
  it("routes agent:research on a research Decision to the Research job, within roles.research's timeout, on its model and effort, with no Ticket, PR, branch or commit", () => {
    const research = kitConfig({
      roles: { ...DEFAULT_KIT_CONFIG.roles, research: { model: "claude-researcher", effort: "high", timeoutMinutes: 25 } },
    });
    const decision = anIssue({
      number: 42,
      labels: ["wayfinder:research", "agent:research"],
      parent: 12,
      parentIssue: { number: 12, open: true, labels: ["wayfinder:map"] },
    });

    const plan = planFor({ kind: "label-added", issue: 42, label: "agent:research" }, snapshotOf(decision), research);

    expect(kitJobOutputs(plan, null, research)).toMatchObject({
      route: "research",
      "research-timeout-minutes": "25",
      model: "claude-researcher",
      effort: "high",
      subscription: "Claude token",
      "pull-request": "",
      ticket: "",
      branch: "",
      review: "",
      "audit-commit": "",
      retry: "",
      "step-up": "false",
      "request-changes": "false",
    });
  });

  it("passes out roles.research's timeout whatever it routes to: the Researcher's 30 minutes by default", () => {
    expect(kitJobOutputs(null, null, kitConfig())).toMatchObject({ route: "none", "research-timeout-minutes": "30" });
  });

  // A prototype turn is a Design run (#155), so it routes to design; the prototype job, not the design job, runs it on `prototype`.
  it("passes out a prototype turn as one, with its request as one line of JSON for the prototype job's prompt, its brief's newlines escaped", () => {
    const pending = { request: { route: "/book", variants: 3, brief: "- **A**: a form.\n- **B**: a stepper -->\n- **C**: a calendar" }, reply: 9001, comment: 9010, started: false };
    const issue = anIssue({ number: 7, labels: ["needs-design", "agent:design"], designRounds: 1, pendingPrototype: pending });
    const prototypes = kitConfig({ ui: UI });

    const plan = planFor({ kind: "label-added", issue: 7, label: "agent:design" }, snapshotOf(issue), prototypes);

    expect(kitJobOutputs(plan, null, prototypes)).toMatchObject({
      route: "design",
      prototype: "true",
      prototype_request: String.raw`{"route":"/book","variants":3,"brief":"- **A**: a form.\n- **B**: a stepper -->\n- **C**: a calendar","reply":9001}`,
      model: "claude-opus-5-5",
      "implement-timeout-minutes": "60",
      subscription: "Claude token",
    });
  });

  it.each<[string, Plan | null]>([
    [
      "an ordinary Design-session turn",
      planFor({ kind: "label-added", issue: 7, label: "agent:design" }, snapshotOf(anIssue({ number: 7, labels: ["needs-design", "agent:design"] })), kitConfig()),
    ],
    ["a Triage run", planFor({ kind: "label-added", issue: 7, label: "needs-triage" }, snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] })), kitConfig())],
    ["an event the Loop doesn't act on", null],
  ])("passes out %s as no prototype turn, with no request", (_, plan) => {
    expect(kitJobOutputs(plan, null, kitConfig())).toMatchObject({ prototype: "false", prototype_request: "" });
  });

  // The Review job downloads the screenshots, and its Reviewer hears why capture failed when there are none to read (#153).
  it.each<[string, EvidenceMarker | null, Record<string, string>]>([
    ["a UI PR whose capture captured", { run: 9100, artifact: 9202, failure: null }, { "ui-evidence-run": "9100", "ui-evidence-artifact": "9202", "ui-evidence-failure": "" }],
    [
      "a UI PR whose capture failed and kept nothing",
      { run: 9100, artifact: null, failure: "build-failed" },
      { "ui-evidence-run": "9100", "ui-evidence-artifact": "", "ui-evidence-failure": "build-failed" },
    ],
    [
      "a UI PR whose marker is from before markers recorded how capture ended",
      { run: 9100, artifact: null },
      { "ui-evidence-run": "9100", "ui-evidence-artifact": "", "ui-evidence-failure": "" },
    ],
    ["a PR that isn't UI", null, { "ui-evidence-run": "", "ui-evidence-artifact": "", "ui-evidence-failure": "" }],
  ])("passes out for the Review of %s where its UI evidence is kept, and why its capture failed", (_, uiEvidenceMarker, evidence) => {
    const plan = planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(aPullRequest({ uiEvidenceMarker })), kitConfig());

    expect(kitJobOutputs(plan, 7, kitConfig())).toMatchObject({ route: "review", ...evidence });
  });
});

describe("The Kit job's routing of a conflict-only run (#304)", () => {
  const MAIN = "9".repeat(40);
  const ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] });
  const pullRequest = aPullRequest({ conflictAttempts: [MAIN], conflictRunInFlight: MAIN });
  const plan = planFor({ kind: "label-added", issue: 7, label: "agent:implement" }, snapshotOf(ticket, { pullRequest }), kitConfig());

  it("routes it to the Implement job on the PR's branch, on the Step-up model, as neither a Retry nor a Request-changes run, with the main head it rebases onto", () => {
    expect(kitJobOutputs(plan, 7, kitConfig())).toMatchObject({
      route: "implement",
      ticket: "7",
      "pull-request": "50",
      branch: "fabrik/ticket-7",
      review: "",
      model: kitConfig().roles.stepUp.model,
      retry: "0",
      "step-up": "true",
      "step-up-reason": "conflict-only",
      "request-changes": "false",
      conflict: MAIN,
    });
  });

  it("passes out a marked Ticket's first run as a Step-up, with marked as its reason", () => {
    const marked = anIssue({ number: 8, labels: ["enhancement", "ready-for-agent", "agent:implement", "fabrik:step-up"] });
    const first = planFor({ kind: "label-added", issue: 8, label: "agent:implement" }, snapshotOf(marked), kitConfig());

    expect(kitJobOutputs(first, 8, kitConfig())).toMatchObject({ route: "implement", retry: "0", "step-up": "true", "step-up-reason": "marked" });
  });

  it("passes out no Step-up reason for a run that doesn't Step up", () => {
    expect(kitJobOutputs(null, null, kitConfig())).toMatchObject({ "step-up": "false", "step-up-reason": "" });
  });

  it("passes out no main head for any other run", () => {
    expect(kitJobOutputs(null, null, kitConfig())).toMatchObject({ conflict: "" });
  });
});

describe("The Kit job's routing of a Kept-branch start (#536)", () => {
  const MAIN = "9".repeat(40);
  const marked = anIssue({
    number: 7,
    labels: ["enhancement", "ready-for-agent", "agent:implement", "fabrik:kept-branch"],
    keptBranch: { head: "f".repeat(40), pullRequest: 230 },
  });
  const plan = planFor({ kind: "label-added", issue: 7, label: "agent:implement" }, snapshotOf(marked), kitConfig());

  it("routes it to the Implement job on the Kept branch, with no PR, as a first run that carries on, naming the closed PR and main", () => {
    expect(kitJobOutputs(plan, null, kitConfig(), MAIN, "main")).toMatchObject({
      route: "implement",
      ticket: "7",
      "pull-request": "",
      branch: "fabrik/ticket-7",
      retry: "0",
      "kept-branch": "true",
      "kept-pull-request": "230",
      "main-at-start": MAIN,
      "default-branch": "main",
    });
  });

  it("passes out no Kept-branch start for a first run from main", () => {
    const unmarked = anIssue({ number: 8, labels: ["ready-for-agent", "agent:implement"] });
    const first = planFor({ kind: "label-added", issue: 8, label: "agent:implement" }, snapshotOf(unmarked), kitConfig());

    expect(kitJobOutputs(first, null, kitConfig())).toMatchObject({ branch: "", "kept-branch": "false", "kept-pull-request": "", "default-branch": "" });
  });
});

// The closing step's line (#616): what the Kit routed, held and declined included, read from Actions while the run is in flight.
describe("The Kit job's line of what it routed (#616)", () => {
  /** The line the Kit job passes out, parsed, once checked to be one line whose route is the route output. */
  function said(plan: Plan | null, ticket: number | null = null): unknown {
    const outputs = kitJobOutputs(plan, ticket, kitConfig());
    const line = outputs["kit-said"] ?? "";

    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line) as { route: string };
    expect(parsed.route).toBe(outputs["route"]);
    return parsed;
  }

  it("says a first Implement run's Ticket, no pull request, kind first, no Retry and its model", () => {
    const ticket = anIssue({ number: 8, labels: ["ready-for-agent", "agent:implement"] });
    const plan = planFor({ kind: "label-added", issue: 8, label: "agent:implement" }, snapshotOf(ticket), kitConfig());

    expect(said(plan)).toEqual({
      fabrik: 1,
      route: "implement",
      run: { role: "implement", issue: 8, pullRequest: null, kind: "first", retry: 0, model: "claude-sonnet-5-5" },
      held: [],
      replay: null,
    });
  });

  /** A plan that starts one agent run with these settings, as the rules core builds one. */
  function starting(run: Partial<Extract<Action, { kind: "start-agent-run" }>>): Plan {
    return {
      kind: "act",
      actions: [{ kind: "start-agent-run", role: "implement", issue: 7, model: "claude-sonnet-5-5", effort: null, timeoutMinutes: 60, subscription: "Claude token", ...run }],
    };
  }

  it.each<[string, Plan, number | null, unknown]>([
    [
      "a Retry on the Ticket's agent pull request, with its Retry number",
      starting({ pullRequest: 50, retry: 2, retryFlaw: "a".repeat(40), stepUp: true, stepUpReason: "retry", model: "claude-opus-5-5" }),
      7,
      { role: "implement", issue: 7, pullRequest: 50, kind: "retry", retry: 2, model: "claude-opus-5-5" },
    ],
    [
      "the Operator's Request-changes run, which is no Retry",
      starting({ pullRequest: 50, requestChanges: { review: 900 }, stepUp: true, stepUpReason: "request-changes", model: "claude-opus-5-5" }),
      7,
      { role: "implement", issue: 7, pullRequest: 50, kind: "request-changes", retry: 0, model: "claude-opus-5-5" },
    ],
    [
      "an Auditor run, on its Audit, with no kind",
      starting({ role: "audit", issue: 98, commit: "b".repeat(40), model: "claude-auditor" }),
      null,
      { role: "audit", issue: 98, pullRequest: null, kind: null, retry: 0, model: "claude-auditor" },
    ],
  ])("says %s", (_, plan, ticket, run) => {
    expect(said(plan, ticket)).toEqual({ fabrik: 1, route: (run as { role: string }).role, run, held: [], replay: null });
  });

  it("says a conflict-only run's Ticket and pull request, as no Retry", () => {
    const ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] });
    const pullRequest = aPullRequest({ conflictAttempts: ["9".repeat(40)], conflictRunInFlight: "9".repeat(40) });
    const plan = planFor({ kind: "label-added", issue: 7, label: "agent:implement" }, snapshotOf(ticket, { pullRequest }), kitConfig());

    expect(said(plan, 7)).toMatchObject({
      route: "implement",
      run: { role: "implement", issue: 7, pullRequest: 50, kind: "conflict-only", retry: 0, model: kitConfig().roles.stepUp.model },
    });
  });

  it("says a Kept-branch start as a first run with no pull request, never the one the Kit closed", () => {
    const marked = anIssue({
      number: 7,
      labels: ["enhancement", "ready-for-agent", "agent:implement", "fabrik:kept-branch"],
      keptBranch: { head: "f".repeat(40), pullRequest: 230 },
    });
    const plan = planFor({ kind: "label-added", issue: 7, label: "agent:implement" }, snapshotOf(marked), kitConfig());

    expect(said(plan)).toMatchObject({ route: "implement", run: { role: "implement", issue: 7, pullRequest: null, kind: "first", retry: 0 } });
  });

  it("says a Review's Ticket and the agent pull request it reviews", () => {
    const plan = planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(aPullRequest({ uiEvidenceMarker: null })), kitConfig());

    expect(said(plan, 7)).toEqual({
      fabrik: 1,
      route: "review",
      run: { role: "review", issue: 7, pullRequest: 50, kind: null, retry: 0, model: kitConfig().roles.review.model },
      held: [],
      replay: null,
    });
  });

  it.each<[string, Plan, unknown]>([
    [
      "a Design-session turn",
      planFor({ kind: "label-added", issue: 7, label: "agent:design" }, snapshotOf(anIssue({ number: 7, labels: ["needs-design", "agent:design"] })), kitConfig()),
      { role: "design", issue: 7, pullRequest: null, kind: null, retry: 0, model: kitConfig().roles.design.model },
    ],
    [
      "a Triage run",
      planFor({ kind: "label-added", issue: 7, label: "needs-triage" }, snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] })), kitConfig()),
      { role: "triage", issue: 7, pullRequest: null, kind: null, retry: 0, model: kitConfig().roles.triage.model },
    ],
    [
      "a Retro run",
      planFor({ kind: "issue-opened", issue: 120 }, snapshotOf(anIssue({ number: 120, byApp: true, labels: ["fabrik:retro"], body: retroBody(RETRO_WINDOW_END, "pending") })), kitConfig()),
      { role: "retro", issue: 120, pullRequest: null, kind: null, retry: 0, model: kitConfig().roles.retro.model },
    ],
    [
      "a Research run",
      planFor(
        { kind: "label-added", issue: 42, label: "agent:research" },
        snapshotOf(anIssue({ number: 42, labels: ["wayfinder:research", "agent:research"], parent: 12, parentIssue: { number: 12, open: true, labels: ["wayfinder:map"] } })),
        kitConfig(),
      ),
      { role: "research", issue: 42, pullRequest: null, kind: null, retry: 0, model: kitConfig().roles.research.model },
    ],
  ])("says %s on its issue, with no pull request and no kind", (_, plan, run) => {
    expect(said(plan)).toEqual({ fabrik: 1, route: (run as { role: string }).role, run, held: [], replay: null });
  });

  it("says a prototype turn as one, with no word of its brief", () => {
    const brief = "- **A**: a form.\n- **B**: a stepper -->\n- **C**: a calendar";
    const pending = { request: { route: "/book", variants: 3, brief }, reply: 9001, comment: 9010, started: false };
    const issue = anIssue({ number: 7, labels: ["needs-design", "agent:design"], designRounds: 1, pendingPrototype: pending });
    const prototypes = kitConfig({ ui: UI });
    const plan = planFor({ kind: "label-added", issue: 7, label: "agent:design" }, snapshotOf(issue), prototypes);
    const line = kitJobOutputs(plan, null, prototypes)["kit-said"] ?? "";

    expect(JSON.parse(line)).toEqual({
      fabrik: 1,
      route: "design",
      run: { role: "design", issue: 7, pullRequest: null, kind: "prototype", retry: 0, model: "claude-opus-5-5" },
      held: [],
      replay: null,
    });
    for (const word of ["form", "stepper", "calendar", "/book"]) expect(line).not.toContain(word);
  });

  /** A hold of a role's run on an issue, as the rules core builds one while every Subscription is used up. */
  function holding(role: AgentRole, issue: number, label: Label): Action {
    return { kind: "hold-agent-run", role, issue, label, until: "2026-11-09T04:00:00.000Z" };
  }

  it("says a held run's role and number under held, with no run, and none of when its hold ends", () => {
    const plan: Plan = {
      kind: "act",
      actions: [{ kind: "remove-label", issue: 50, label: "agent:review" }, holding("review", 50, "agent:review")],
    };
    const line = kitJobOutputs(plan, 7, kitConfig())["kit-said"] ?? "";

    expect(said(plan, 7)).toEqual({ fabrik: 1, route: "push", run: null, held: [{ role: "review", issue: 50 }], replay: null });
    expect(line).not.toContain("2026");
  });

  it("says both a run the plan holds and one it starts", () => {
    const plan: Plan = {
      kind: "act",
      actions: [
        holding("implement", 7, "agent:implement"),
        { kind: "start-agent-run", role: "triage", issue: 9, model: "claude-sonnet-5-5", effort: null, timeoutMinutes: 15, subscription: "Claude token 2" },
      ],
    };

    expect(said(plan)).toEqual({
      fabrik: 1,
      route: "triage",
      run: { role: "triage", issue: 9, pullRequest: null, kind: null, retry: 0, model: "claude-sonnet-5-5" },
      held: [{ role: "implement", issue: 7 }],
      replay: null,
    });
  });

  it.each<[string, Plan | null]>([
    ["a plan that does nothing", { kind: "nothing", reason: "#7 is closed" }],
    ["an event the Loop doesn't act on", null],
  ])("says %s as declined: route none, no run and nothing held, with no reason", (_, plan) => {
    expect(said(plan)).toEqual({ fabrik: 1, route: "none", run: null, held: [], replay: null });
    expect(kitJobOutputs(plan, null, kitConfig())["kit-said"]).not.toContain("closed");
  });

  it("says a replay's issue and the Ticket it replays, and none of its Arms' model names", () => {
    const replay = anIssue({ number: 140, author: "operator", labels: ["fabrik:replay", "agent:replay"], body: acceptedBody() });
    const issues = { issues: [aReplayIssue({ author: "operator" })], capacity: null, acceptance: null };
    const plan = planFor({ kind: "label-added", issue: 140, label: "agent:replay" }, snapshotOf(replay, { replay: issues }), kitConfig());
    const line = kitJobOutputs(plan, null, kitConfig())["kit-said"] ?? "";

    expect(said(plan)).toEqual({ fabrik: 1, route: "replay", run: null, held: [], replay: { issue: 140, ticket: 12 } });
    expect(line).not.toContain("claude");
  });
});
