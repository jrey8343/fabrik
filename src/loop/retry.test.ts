import { describe, expect, it } from "vitest";
import {
  anIssue,
  aPullRequest,
  HEAD_SHA,
  kitConfig,
  notificationsOf,
  snapshotOf,
  snapshotOfPullRequest,
  verdictsPostedIn,
} from "../__fixtures__/snapshots.ts";
import { anEvidence, CAPTURED, GALLERY, UI } from "../__fixtures__/uiEvidence.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, Snapshot, VerdictRecord } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

function reviewed(output: string): LoopEvent {
  return { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output, runUrl: RUN, repoUrl: "https://github.com/acme/shop" };
}

function redChecks(): LoopEvent {
  return { kind: "required-checks-finished", pullRequest: 50, headSha: HEAD_SHA, failed: ["build"], runUrl: RUN };
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** An earlier Verdict on an older commit. */
function earlier(verdict: VerdictRecord["verdict"], overrides: Partial<VerdictRecord> = {}): VerdictRecord {
  return { verdict, source: "reviewer", requestChanges: false, headSha: "0".repeat(40), ...overrides };
}

/** What starts a retry: agent:implement on the PR's Ticket, which resumes the PR's Implement run. */
const RETRY_TRIGGER: Action = { kind: "add-labels", issue: 7, labels: ["agent:implement"] };

describe("An Execution flaw starts a retry", () => {
  it.each([
    ["the Reviewer's Execution flaw", reviewed("verdict: execution-flaw\n\nThe empty-cart case throws.")],
    ["red CI", redChecks()],
  ])("%s adds agent:implement to the PR's Ticket, which starts the Implementer again on the PR", (_, event) => {
    const plan = planFor(event, snapshotOfPullRequest(aPullRequest()), kitConfig());

    expect(actionsOf(plan)).toContainEqual(RETRY_TRIGGER);
  });

  it("a pass or a Design flaw starts no retry", () => {
    for (const output of ["verdict: pass", "verdict: design-flaw\n\nWrong approach."]) {
      const plan = planFor(reviewed(output), snapshotOfPullRequest(aPullRequest()), kitConfig());
      expect(actionsOf(plan)).not.toContainEqual(RETRY_TRIGGER);
    }
  });

  // A visual failure the Reviewer saw in the screenshots is an Execution flaw like any other (#153).
  it("an Execution flaw on a UI PR, naming a route and screenshot, starts a retry exactly as one on any PR", () => {
    const flaw = reviewed("verdict: execution-flaw\n\n- `/waitlist` spills off the side at mobile width (`after-mobile-waitlist.png`).");
    const marked = aPullRequest({ uiEvidenceMarker: { run: 9100, artifact: 9202 } });

    expect(planFor(flaw, snapshotOfPullRequest(marked), kitConfig())).toEqual(planFor(flaw, snapshotOfPullRequest(aPullRequest()), kitConfig()));
    expect(actionsOf(planFor(flaw, snapshotOfPullRequest(marked), kitConfig()))).toContainEqual(RETRY_TRIGGER);
  });
});

/** agent:implement added to Ticket #7, whose agent PR is #50. */
const retryLabeled: LoopEvent = { kind: "label-added", issue: 7, label: "agent:implement" };

/** A PR whose latest Verdict, on its head, is an Execution flaw, after these earlier Verdicts. */
function flawedPullRequest(before: readonly VerdictRecord[] = [], latest: Partial<VerdictRecord> = {}) {
  return aPullRequest({ verdicts: [...before, earlier("execution-flaw", { headSha: HEAD_SHA, ...latest })] });
}

/** agent:implement's snapshot: Ticket #7, ready, with its agent PR open, and that PR. */
function resumeSnapshot(pullRequest = flawedPullRequest()): Snapshot {
  return snapshotOf(anIssue({ number: 7, labels: ["enhancement", "ready-for-agent", "agent:implement"], openPullRequests: [50] }), {
    pullRequest,
  });
}

describe("Starting a retry", () => {
  it("the first Execution flaw starts the Implementer on its default model, on the PR, and takes agent:implement off", () => {
    const config = kitConfig();
    const plan = planFor(retryLabeled, resumeSnapshot(), config);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "agent:implement" },
        {
          kind: "start-agent-run",
          role: "implement",
          issue: 7,
          pullRequest: 50,
          model: "claude-sonnet-5-5",
          effort: config.roles.implement.effort,
          timeoutMinutes: 60,
          subscription: "Claude token",
          retry: 1,
          stepUp: false,
          stepUpReason: null,
        },
      ],
    });
  });

  it("still starts while Dispatch is paused by a max_in_flight of 0", () => {
    const plan = planFor(retryLabeled, resumeSnapshot(), kitConfig({ maxInFlight: 0 }));

    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "start-agent-run", pullRequest: 50 }));
  });

  // Its Implement job captures again from its own diff (#153), so the run carries no evidence of its own.
  it("on a UI PR starts exactly the retry it would on any PR", () => {
    const marked = { ...flawedPullRequest(), uiEvidenceMarker: { run: 9100, artifact: 9202 } };

    expect(planFor(retryLabeled, resumeSnapshot(marked), kitConfig())).toEqual(planFor(retryLabeled, resumeSnapshot(), kitConfig()));
  });

  it("the second Execution flaw starts a Step-up, on the Step-up model", () => {
    const config = kitConfig();
    const plan = planFor(retryLabeled, resumeSnapshot(flawedPullRequest([earlier("execution-flaw")])), config);

    expect(actionsOf(plan)[1]).toMatchObject({
      kind: "start-agent-run",
      role: "implement",
      model: "claude-opus-5-5",
      effort: config.roles.stepUp.effort,
    });
  });

  it("a retry on the PR says which Retry it is, and the second that it Steps up", () => {
    const first = planFor(retryLabeled, resumeSnapshot(), kitConfig());
    const second = planFor(retryLabeled, resumeSnapshot(flawedPullRequest([earlier("execution-flaw")])), kitConfig());

    expect(actionsOf(first)[1]).toMatchObject({ kind: "start-agent-run", retry: 1, stepUp: false });
    expect(actionsOf(second)[1]).toMatchObject({ kind: "start-agent-run", retry: 2, stepUp: true });
  });

  it("adding fabrik:step-up between Retries steps up the next one, recorded as marked", () => {
    const marked = snapshotOf(
      anIssue({ number: 7, labels: ["enhancement", "ready-for-agent", "agent:implement", "fabrik:step-up"], openPullRequests: [50] }),
      { pullRequest: flawedPullRequest() },
    );

    expect(actionsOf(planFor(retryLabeled, marked, kitConfig()))[1]).toMatchObject({
      model: "claude-opus-5-5",
      retry: 1,
      stepUp: true,
      stepUpReason: "marked",
    });
  });

  it("with fabrik:step-up taken off before Retry 1, it runs on the Implementer model", () => {
    // resumeSnapshot's Ticket carries no fabrik:step-up, whatever its first run ran on.
    expect(actionsOf(planFor(retryLabeled, resumeSnapshot(), kitConfig()))[1]).toMatchObject({ model: "claude-sonnet-5-5", stepUp: false });
  });

  it("the second Retry on a marked Ticket records marked, not retry", () => {
    const marked = snapshotOf(
      anIssue({ number: 7, labels: ["enhancement", "ready-for-agent", "agent:implement", "fabrik:step-up"], openPullRequests: [50] }),
      { pullRequest: flawedPullRequest([earlier("execution-flaw")]) },
    );

    expect(actionsOf(planFor(retryLabeled, marked, kitConfig()))[1]).toMatchObject({ retry: 2, stepUp: true, stepUpReason: "marked" });
  });

  it("a Step-up uses whatever model Kit config gives the Step-up", () => {
    const base = kitConfig();
    const config = kitConfig({
      roles: { ...base.roles, stepUp: { ...base.roles.stepUp, model: "claude-opus-6", effort: "high" } },
    });
    const pullRequest = flawedPullRequest([earlier("execution-flaw", { source: "ci" })]);
    const plan = planFor(retryLabeled, resumeSnapshot(pullRequest), config);

    expect(actionsOf(plan)[1]).toMatchObject({ model: "claude-opus-6", effort: "high" });
  });

  it("the retry count ignores Verdicts from a Request-changes run", () => {
    const pullRequest = flawedPullRequest([
      earlier("execution-flaw", { requestChanges: true }),
      earlier("execution-flaw", { requestChanges: true }),
    ]);
    const plan = planFor(retryLabeled, resumeSnapshot(pullRequest), kitConfig());

    expect(actionsOf(plan)[1]).toMatchObject({ kind: "start-agent-run", model: "claude-sonnet-5-5" });
  });

  it("an Execution flaw from a Request-changes run still gets a retry, counted from the flaws before it", () => {
    const pullRequest = flawedPullRequest([earlier("execution-flaw")], { requestChanges: true });
    const plan = planFor(retryLabeled, resumeSnapshot(pullRequest), kitConfig());

    expect(actionsOf(plan)[1]).toMatchObject({ kind: "start-agent-run", model: "claude-opus-5-5" });
  });

  it("passes and Design flaws earlier on the PR don't count", () => {
    const pullRequest = flawedPullRequest([earlier("pass"), earlier("design-flaw")]);
    const plan = planFor(retryLabeled, resumeSnapshot(pullRequest), kitConfig());

    expect(actionsOf(plan)[1]).toMatchObject({ kind: "start-agent-run", model: "claude-sonnet-5-5" });
  });

  it("re-adding agent:implement after an Infrastructure failure runs the same retry again, so the failure uses none up", () => {
    // The failed retry pushed nothing, so the PR's head and its Verdicts are as they were.
    const pullRequest = flawedPullRequest();
    const first = planFor(retryLabeled, resumeSnapshot(pullRequest), kitConfig());
    const again = planFor(retryLabeled, resumeSnapshot(pullRequest), kitConfig());

    expect(again).toEqual(first);
    expect(actionsOf(again)[1]).toMatchObject({ model: "claude-sonnet-5-5" });
  });

  it("a third Execution flaw starts no retry", () => {
    const pullRequest = flawedPullRequest([earlier("execution-flaw"), earlier("execution-flaw", { source: "ci" })]);
    const plan = planFor(retryLabeled, resumeSnapshot(pullRequest), kitConfig());

    expect(startedRuns(plan)).toEqual([]);
  });

  it.each([
    ["has no Verdict", aPullRequest()],
    ["has a pass as its latest Verdict", aPullRequest({ verdicts: [earlier("pass", { headSha: HEAD_SHA })] })],
    ["has pushed a fix since its Execution flaw", { ...flawedPullRequest(), headSha: "b".repeat(40), pushedSinceVerdict: true }],
    ["is a person's PR", aPullRequest({ isAgent: false, verdicts: flawedPullRequest().verdicts })],
    ["has left draft", aPullRequest({ draft: false, verdicts: flawedPullRequest().verdicts })],
    ["is closed", aPullRequest({ open: false, verdicts: flawedPullRequest().verdicts })],
  ])("agent:implement on a Ticket whose PR %s starts no Implementer, and comes off", (_, pullRequest) => {
    const plan = planFor(retryLabeled, resumeSnapshot(pullRequest), kitConfig());

    expect(startedRuns(plan)).toEqual([]);
    expect(actionsOf(plan)).toContainEqual({ kind: "remove-label", issue: 7, label: "agent:implement" });
  });
});

describe("agent:implement on a Ticket with an open agent PR", () => {
  it("starts nothing when the Ticket has left ready-for-agent", () => {
    const snapshot = { ...resumeSnapshot(), issue: anIssue({ number: 7, labels: ["needs-design"], openPullRequests: [50] }) };

    expect(startedRuns(planFor(retryLabeled, snapshot, kitConfig()))).toEqual([]);
  });

  it("never starts a fresh run beside the PR, even when there's nothing to resume", () => {
    const plan = planFor(retryLabeled, resumeSnapshot(aPullRequest({ verdicts: [] })), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "remove-label", issue: 7, label: "agent:implement" }] });
  });
});

function startedRuns(plan: Plan): Action[] {
  return plan.kind === "act" ? plan.actions.filter((action) => action.kind === "start-agent-run") : [];
}

describe("A Verdict when the retries are used up", () => {
  it("a third Execution flaw is posted but starts no retry (it goes back to design: backToDesign.test.ts)", () => {
    const pullRequest = aPullRequest({ pushedSinceVerdict: true, verdicts: [earlier("execution-flaw"), earlier("execution-flaw", { source: "ci" })] });
    const plan = planFor(reviewed("verdict: execution-flaw\n\nStill throws."), snapshotOfPullRequest(pullRequest), kitConfig());

    expect(actionsOf(plan)[0]).toMatchObject({ kind: "comment", issue: 50 });
    expect(actionsOf(plan)).not.toContainEqual(RETRY_TRIGGER);
  });
});

/** The retry's push job: the PR it fixed, at the head it built on, and what its new commits change. */
function retried(
  overrides: Partial<Extract<LoopEvent, { kind: "implement-run-finished" }>> = {},
): Extract<LoopEvent, { kind: "implement-run-finished" }> {
  return {
    kind: "implement-run-finished",
    issue: 7,
    output: JSON.stringify({
      title: "Handle the empty cart",
      summary: "Shows the empty state for an empty cart, @someone, and tests both cases.",
      fix: "Guards the empty-cart case the Reviewer flagged, @someone.",
    }),
    branch: "fabrik/ticket-7",
    base: "fabrik/ticket-7",
    changes: { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }] },
    fixes: { pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN },
    ...overrides,
  };
}

/** The retry push job's snapshot: the Ticket and the PR it fixes. */
function retrySnapshot(pullRequest = flawedPullRequest(), ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] })): Snapshot {
  return { ...snapshotOfPullRequest(pullRequest, { operator: "jrey" }), issue: ticket };
}

describe("A retry's branch", () => {
  it("is pushed onto the same branch, opens no new PR, and leaves a silent note with the Implementer's fix", () => {
    const plan = planFor(retried(), retrySnapshot(), kitConfig());

    const actions = actionsOf(plan);
    expect(actions.at(-1)).toEqual({ kind: "push-branch", branch: "fabrik/ticket-7" });
    expect(actions.map((action) => action.kind)).toEqual(["edit-issue-body", "comment", "push-branch"]);
    expect(actions[1]).toMatchObject({ kind: "comment", issue: 50 });
    expect(actions[1]).toHaveProperty("body", expect.stringContaining("Guards the empty-cart case the Reviewer flagged"));
    expect(actions[1]).not.toHaveProperty("body", expect.stringContaining("Shows the empty state"));
    expect(notificationsOf(plan, "jrey")).toEqual([]);
    expect(actions[1]).not.toHaveProperty("body", expect.stringContaining("@someone"));
  });

  it("replaces the PR body with the refreshed summary, so the next Review reads the PR as it now stands", () => {
    const actions = actionsOf(planFor(retried(), retrySnapshot(), kitConfig()));

    expect(actions).toContainEqual({
      kind: "edit-issue-body",
      issue: 50,
      body: "Shows the empty state for an empty cart, @\u200bsomeone, and tests both cases.\n\nCloses #7",
    });
  });

  it.each([
    ["names the routes its change shows on", ["/cart"]],
    ["names routes that aren't paths", ["cart"]],
  ])("lands as any retry does when its output %s", (_, routes) => {
    const output = JSON.stringify({ title: "Handle the empty cart", summary: "Shows the empty state.", fix: "Guards the empty cart.", routes });

    const actions = actionsOf(planFor(retried({ output }), retrySnapshot(), kitConfig()));

    expect(actions.map((action) => action.kind)).toEqual(["edit-issue-body", "comment", "push-branch"]);
    expect(actions[0]).toEqual({ kind: "edit-issue-body", issue: 50, body: "Shows the empty state.\n\nCloses #7" });
    expect(actions[1]).toHaveProperty("body", expect.stringMatching(/\n\nGuards the empty cart\.$/));
  });

  it.each([
    ["no fix", { title: "Handle the empty cart", summary: "Shows the empty state." }],
    ["an empty fix", { title: "Handle the empty cart", summary: "Shows the empty state.", fix: "  " }],
  ])("output with %s breaks the contract on a retry: an Infrastructure failure that pushes nothing", (_, output) => {
    const plan = planFor(retried({ output: JSON.stringify(output) }), retrySnapshot(), kitConfig());

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });

  it.each([
    ["the PR has left draft", aPullRequest({ draft: false }), {}],
    ["the PR is closed", aPullRequest({ open: false }), {}],
    ["the PR is for another Ticket", aPullRequest({ ticket: 8 }), {}],
  ])("isn't pushed when %s", (_, pullRequest, prOverrides) => {
    const plan = planFor(retried(), retrySnapshot({ ...pullRequest, ...prOverrides }), kitConfig());

    expect(plan.kind).toBe("nothing");
  });

  it("isn't pushed when the Ticket has left ready-for-agent", () => {
    const plan = planFor(retried(), retrySnapshot(flawedPullRequest(), anIssue({ number: 7, labels: ["needs-design"] })), kitConfig());

    expect(plan.kind).toBe("nothing");
  });

  it("that touches a trust root goes to the Operator unpushed, as a first run's would", () => {
    const plan = planFor(
      retried({ changes: { net: [{ path: "AGENTS.md" }], commits: [{ path: "AGENTS.md" }] } }),
      retrySnapshot(),
      kitConfig(),
    );

    const actions = actionsOf(plan);
    expect(actions.map((action) => action.kind)).not.toContain("push-branch");
    expect(actions).toContainEqual({ kind: "assign", issue: 7, assignee: "jrey" });
  });

  it("that touches a trust root closes the PR, keeping its branch, so it no longer holds a slot", () => {
    const plan = planFor(
      retried({ changes: { net: [{ path: ".github/workflows/ci.yml" }], commits: [{ path: ".github/workflows/ci.yml" }] } }),
      retrySnapshot(),
      kitConfig(),
    );

    const actions = actionsOf(plan);
    expect(actions).toContainEqual({ kind: "close-pull-request", pullRequest: 50 });
    expect(actions).toContainEqual({ kind: "check-dispatch" });
    expect(notificationsOf(plan, "jrey")).toEqual(["assign #7"]);
  });

  it("that changes nothing is an Execution flaw on the PR, and starts the next retry", () => {
    const plan = planFor(retried({ changes: { net: [], commits: [] } }), retrySnapshot(), kitConfig());

    const actions = actionsOf(plan);
    expect(actions.map((action) => action.kind)).not.toContain("push-branch");
    expect(actions.map((action) => action.kind)).not.toContain("edit-issue-body");
    const comments = actions.flatMap((action) => (action.kind === "comment" ? [action.body] : []));
    expect(verdictsPostedIn(comments)).toEqual([
      { verdict: "execution-flaw", source: "empty-diff", requestChanges: false, headSha: HEAD_SHA },
    ]);
    expect(actions).toContainEqual(RETRY_TRIGGER);
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it("that changes nothing on the second retry starts no third", () => {
    const plan = planFor(
      retried({ changes: { net: [], commits: [] } }),
      retrySnapshot(flawedPullRequest([earlier("execution-flaw")])),
      kitConfig(),
    );

    expect(actionsOf(plan)).not.toContainEqual(RETRY_TRIGGER);
  });

  it("output that breaks the Implementer's contract is an Infrastructure failure and pushes nothing", () => {
    const plan = planFor(retried({ output: "{}" }), retrySnapshot(), kitConfig());

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });
});

/** The evidence section an earlier run, 8000, put on the PR's body, its marker from before markers recorded how capture ended. */
const OLD_SECTION = [
  "<!-- fabrik:ui-evidence-start -->",
  "## UI evidence",
  "",
  "[Open the gallery](<https://github.com/acme/shop/actions/runs/8000/artifacts/8001>) of 2 screenshots: this branch at `0000000`, at mobile and desktop widths.",
  `<!-- fabrik:ui-evidence {"run":8000,"artifact":8002} -->`,
].join("\n");

/** This retry's evidence section: run 9100's capture of /waitlist. */
const NEW_SECTION = [
  "<!-- fabrik:ui-evidence-start -->",
  "## UI evidence",
  "",
  `[Open the gallery](<${GALLERY}>) of 2 screenshots: this branch at \`4f2b9c0\`, at mobile and desktop widths.`,
  "",
  "No preview link: Kit config declares no `preview.url`.",
  "",
  "Captured routes:",
  "",
  "- `/waitlist`, named by the Implementer",
  `<!-- fabrik:ui-evidence {"run":9100,"artifact":9202,"failure":null} -->`,
].join("\n");

describe("The evidence section on a retry's PR", () => {
  /** A retry whose summary copies the old section forward, which only the Kit may write. */
  const copyingForward = (overrides: Partial<Extract<LoopEvent, { kind: "implement-run-finished" }>> = {}) =>
    retried({
      output: JSON.stringify({ title: "Handle the empty cart", summary: `Shows the empty state.\n\n${OLD_SECTION}`, fix: "Guards the empty cart." }),
      evidence: anEvidence(CAPTURED),
      ...overrides,
    });
  const markedUi = () => aPullRequest({ verdicts: flawedPullRequest().verdicts, uiEvidenceMarker: { run: 8000, artifact: 8002 } });

  it("replaces the old one on a PR marked UI, though the retry's own changes match no ui.paths, so the old one is gone", () => {
    const actions = actionsOf(planFor(copyingForward(), retrySnapshot(markedUi()), kitConfig({ ui: UI })));

    expect(actions.map((action) => action.kind)).toEqual(["edit-issue-body", "comment", "push-branch"]);
    expect(actions[0]).toEqual({ kind: "edit-issue-body", issue: 50, body: `Shows the empty state.\n\n${NEW_SECTION}\n\nCloses #7` });
  });

  it("is new on a PR the retry's own changes make UI", () => {
    const event = copyingForward({ changes: { net: [{ path: "src/components/Cart.astro" }], commits: [{ path: "src/components/Cart.astro" }] } });

    const actions = actionsOf(planFor(event, retrySnapshot(), kitConfig({ ui: UI })));

    expect(actions[0]).toEqual({ kind: "edit-issue-body", issue: 50, body: `Shows the empty state.\n\n${NEW_SECTION}\n\nCloses #7` });
  });

  it("isn't on a PR that isn't UI, nor is the one the summary copied", () => {
    const actions = actionsOf(planFor(copyingForward(), retrySnapshot(), kitConfig({ ui: UI })));

    expect(actions[0]).toEqual({ kind: "edit-issue-body", issue: 50, body: "Shows the empty state.\n\nCloses #7" });
  });
});

describe("The preview deployment of a retry's PR", () => {
  const PREVIEW = { url: "https://{branch_slug}.shop.pages.dev" };
  const uiRetry = (overrides: Partial<Extract<LoopEvent, { kind: "implement-run-finished" }>> = {}) =>
    retried({ evidence: anEvidence(CAPTURED), ...overrides });
  const markedUi = () => aPullRequest({ verdicts: flawedPullRequest().verdicts, uiEvidenceMarker: { run: 8000, artifact: 8002 } });

  it.each([
    ["a retry", uiRetry()],
    ["a Request-changes run", uiRetry({ fixes: { pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN, requestChanges: true } })],
  ])("is linked on %s's UI PR once the push job has pushed, from Kit config's template and the PR's branch", (_, event) => {
    const actions = actionsOf(planFor(event, retrySnapshot(markedUi()), kitConfig({ ui: UI, preview: PREVIEW })));

    expect(actions.map((action) => action.kind)).toEqual(["edit-issue-body", "comment", "push-branch", "link-preview"]);
    expect(actions[3]).toEqual({ kind: "link-preview", pullRequest: 50, template: "https://{branch_slug}.shop.pages.dev", branch: "fabrik/ticket-7" });
  });

  it.each([
    ["Kit config declares no preview.url", retrySnapshot(markedUi()), kitConfig({ ui: UI })],
    ["the PR isn't UI", retrySnapshot(), kitConfig({ ui: UI, preview: PREVIEW })],
  ])("isn't polled when %s", (_, snapshot, config) => {
    expect(actionsOf(planFor(uiRetry(), snapshot, config)).map((action) => action.kind)).toEqual(["edit-issue-body", "comment", "push-branch"]);
  });
});

describe("A retry whose branch moved while it ran (ADR-0006)", () => {
  const MOVED = "b".repeat(40);
  /** The PR, now at MOVED: the Operator pushed while the retry, built on HEAD_SHA, ran. */
  const movedSnapshot = (pullRequest = flawedPullRequest()) => retrySnapshot({ ...pullRequest, headSha: MOVED });
  const rebased = (conflicted: boolean, onto = MOVED) =>
    retried({
      changes: conflicted
        ? { net: [], commits: [], rebase: { onto, conflicted } }
        : { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }], rebase: { onto, conflicted } },
    });

  it("is pushed rebased onto the new head, with its note and refreshed body as usual", () => {
    const actions = actionsOf(planFor(rebased(false), movedSnapshot(), kitConfig()));

    expect(actions.map((action) => action.kind)).toEqual(["edit-issue-body", "comment", "push-branch"]);
    expect(actions[1]).toHaveProperty("body", expect.stringMatching(/^<!-- fabrik:retry-push -->\n/));
  });

  it("that conflicts pushes nothing, says its work was discarded, and starts the same retry again, using no retry", () => {
    const plan = planFor(rebased(true), movedSnapshot(), kitConfig());

    const actions = actionsOf(plan);
    expect(actions.map((action) => action.kind)).toEqual(["comment", "add-labels"]);
    expect(actions[0]).toMatchObject({ kind: "comment", issue: 50 });
    const body = (actions[0] as Extract<Action, { kind: "comment" }>).body;
    expect(body).toContain("discarded");
    expect(body).toContain("Retry 1 of 2 starts again on bbbbbbb");
    expect(verdictsPostedIn([body])).toEqual([]);
    expect(body).not.toMatch(/^<!--/);
    expect(actions[1]).toEqual(RETRY_TRIGGER);
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it("is pushed onto the head the push job rebased it onto, even when the snapshot's head lags behind it: the push's lease guards a real move", () => {
    const actions = actionsOf(planFor(rebased(false, "c".repeat(40)), movedSnapshot(), kitConfig()));

    expect(actions.map((action) => action.kind)).toEqual(["edit-issue-body", "comment", "push-branch"]);
  });

  it("a Request-changes run that conflicts starts again from the same review", () => {
    const pullRequest = aPullRequest({
      verdicts: [earlier("pass", { headSha: HEAD_SHA })],
      changesRequested: { review: 9, reviewer: "jrey", reviewerIsBot: false, commitSha: HEAD_SHA },
    });
    const event = { ...rebased(true), fixes: { pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN, requestChanges: true } };

    const actions = actionsOf(planFor(event, movedSnapshot(pullRequest), kitConfig()));

    expect(actions.map((action) => action.kind)).toEqual(["comment", "add-labels"]);
    expect(actions[0]).toHaveProperty("body", expect.stringContaining("The Operator's Request-changes run starts again on bbbbbbb"));
  });

  it("that changed nothing is still an empty diff, not a restart", () => {
    const plan = planFor(retried({ changes: { net: [], commits: [] } }), movedSnapshot(), kitConfig());

    const comments = actionsOf(plan).flatMap((action) => (action.kind === "comment" ? [action.body] : []));
    expect(verdictsPostedIn(comments)).toEqual([expect.objectContaining({ source: "empty-diff" })]);
  });
});

describe("A retry's fix comment and the Operator comments it weighed", () => {
  const given = [
    { id: "conversation-3", url: "https://github.com/acme/shop/pull/50#issuecomment-3" },
    { id: "review-5", url: "https://github.com/acme/shop/pull/50#pullrequestreview-5" },
  ];

  function weighing(operatorCommentsConsidered: unknown, operatorComments: typeof given | undefined) {
    return retried({
      output: JSON.stringify({
        title: "Handle the empty cart",
        summary: "Shows the empty state for an empty cart.",
        fix: "Guards the empty-cart case, keeping the copy the Operator settled.",
        operatorCommentsConsidered,
      }),
      fixes: { pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN, ...(operatorComments === undefined ? {} : { operatorComments }) },
    });
  }

  function fixCommentOf(plan: Plan): string {
    const [body] = actionsOf(plan).flatMap((action) => (action.kind === "comment" ? [action.body] : []));
    return body ?? "";
  }

  it("ends with an Operator comments considered section, one link per comment it was given", () => {
    const body = fixCommentOf(planFor(weighing(["review-5", "conversation-3"], given), retrySnapshot(), kitConfig()));

    expect(body).toMatch(
      /keeping the copy the Operator settled\.\n\n### Operator comments considered\n\n- \[`conversation-3`\]\(https:\/\/github\.com\/acme\/shop\/pull\/50#issuecomment-3\)\n- \[`review-5`\]\(https:\/\/github\.com\/acme\/shop\/pull\/50#pullrequestreview-5\)$/,
    );
  });

  it("never links an id it wasn't given, and still lands", () => {
    const plan = planFor(weighing(["conversation-3", "inline-77"], given), retrySnapshot(), kitConfig());

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["edit-issue-body", "comment", "push-branch"]);
    expect(fixCommentOf(plan)).toContain("- [`conversation-3`]");
    expect(fixCommentOf(plan)).not.toContain("inline-77");
    expect(fixCommentOf(plan)).not.toContain("review-5");
  });

  it.each([
    ["names none", undefined, given],
    ["names an empty list", [], given],
    ["names only ids it wasn't given", ["inline-77"], given],
    ["names a comment but was given none", ["conversation-3"], undefined],
  ])("leaves the section out when the run %s", (_, named, operatorComments) => {
    const body = fixCommentOf(planFor(weighing(named, operatorComments), retrySnapshot(), kitConfig()));

    expect(body).not.toContain("Operator comments considered");
    expect(body).toMatch(/keeping the copy the Operator settled\.$/);
  });

  it.each([
    ["a bare id", "conversation-3"],
    ["a list with a non-id in it", ["conversation-3", 5]],
    ["an object", { id: "conversation-3" }],
  ])("ignores a considered field that is %s: the fix still lands, weighing none", (_, named) => {
    const plan = planFor(weighing(named, given), retrySnapshot(), kitConfig());

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["edit-issue-body", "comment", "push-branch"]);
    expect(fixCommentOf(plan)).not.toContain("Operator comments considered");
  });
});

describe("A retry that fails for Infrastructure", () => {
  it("comments on the PR, names agent:implement on the Ticket as the label to re-add, and uses up no retry", () => {
    const plan = planFor(
      {
        kind: "agent-run-failed",
        role: "implement",
        issue: 7,
        runUrl: RUN,
        jobResult: "cancelled",
        secretsStep: "success",
        report: null,
      },
      snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"], openPullRequests: [50] })),
      kitConfig(),
    );

    const actions = actionsOf(plan);
    expect(actions).toContainEqual({ kind: "remove-label", issue: 7, label: "agent:implement" });
    expect(actions).toContainEqual({ kind: "comment", issue: 50, body: expect.any(String) });
    const [body] = actions.flatMap((action) => (action.kind === "comment" ? [action.body] : []));
    expect(body).toContain("Re-add the `agent:implement` label on #7 to run it again");
    expect(verdictsPostedIn([body!])).toEqual([]);
  });
});

describe("Retries stay silent", () => {
  it.each([
    ["the Reviewer's first Execution flaw", [], reviewed("verdict: execution-flaw\n\nThe empty-cart case throws, @someone.")],
    ["red CI", [], redChecks()],
    ["the second Execution flaw, a Step-up", [earlier("execution-flaw")], reviewed("verdict: execution-flaw\n\nStill throws.")],
  ])("%s notifies nobody", (_, before, event) => {
    const pullRequest = aPullRequest({ verdicts: before, pushedSinceVerdict: true });
    const plan = planFor(event, snapshotOfPullRequest(pullRequest, { operator: "jrey" }), kitConfig());

    expect(actionsOf(plan)).toContainEqual(RETRY_TRIGGER);
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it("starting a retry, plain or Step-up, notifies nobody", () => {
    for (const before of [[], [earlier("execution-flaw")]]) {
      const plan = planFor(retryLabeled, resumeSnapshot(flawedPullRequest(before)), kitConfig());
      expect(startedRuns(plan)).toHaveLength(1);
      expect(notificationsOf(plan)).toEqual([]);
    }
  });
});
