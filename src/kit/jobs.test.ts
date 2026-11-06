import { describe, expect, it } from "vitest";
import { aPullRequest, anIssue, kitConfig, RETRO_WINDOW_END, retroBody, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { acceptedBody, baseOf } from "../__fixtures__/replay.ts";
import { UI } from "../__fixtures__/uiEvidence.ts";
import type { EvidenceMarker } from "../evidence/uiEvidence.ts";
import { planFor } from "../loop/rules.ts";
import type { Plan } from "../loop/types.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { kitJobOutputs } from "./jobs.ts";

const config = kitConfig({
  roles: { ...DEFAULT_KIT_CONFIG.roles, retro: { model: "claude-retro", effort: "high", timeoutMinutes: 50 } },
});

describe("The Kit job's routing of a replay Ticket (#156)", () => {
  const replay = anIssue({ number: 140, author: "operator", labels: ["fabrik:replay", "agent:replay"], body: acceptedBody() });
  const started = planFor({ kind: "label-added", issue: 140, label: "agent:replay" }, snapshotOf(replay), kitConfig());

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
