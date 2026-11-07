import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { anEvidence, CAPTURED, CAPTURED_SHA, GALLERY, UI } from "../__fixtures__/uiEvidence.ts";
import type { CaptureResult } from "../evidence/uiEvidence.ts";
import { planFor } from "./rules.ts";
import type { Action, ImplementEvidence, LoopEvent, Plan } from "./types.ts";

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

describe("A Stepped-up start", () => {
  const runOf = (labels: readonly string[], emptyDiffs = 0) =>
    actionsOf(planFor(dispatched(), snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent", "agent:implement", ...labels], emptyDiffs })), kitConfig())).find(
      (action) => action.kind === "start-agent-run",
    );

  it("a Ticket labelled fabrik:step-up gets its first Implement run on the Step-up model, recorded as marked", () => {
    const config = kitConfig();

    expect(runOf(["fabrik:step-up"])).toMatchObject({
      model: "claude-opus-5-5",
      effort: config.roles.stepUp.effort,
      stepUp: true,
      stepUpReason: "marked",
    });
    expect(runOf(["fabrik:step-up"])).not.toHaveProperty("retry");
  });

  it("an unmarked Ticket's first run and first Retry are on the Implementer model, and its second Retry Steps up for the retry", () => {
    expect(runOf([], 0)).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(runOf([], 0)).not.toHaveProperty("stepUp");
    expect(runOf([], 1)).toMatchObject({ model: "claude-sonnet-5-5", retry: 1, stepUp: false, stepUpReason: null });
    expect(runOf([], 2)).toMatchObject({ model: "claude-opus-5-5", retry: 2, stepUp: true, stepUpReason: "retry" });
  });

  it("a marked Ticket's Retries 1 and 2 both run on the Step-up model, recorded as marked", () => {
    expect(runOf(["fabrik:step-up"], 1)).toMatchObject({ model: "claude-opus-5-5", retry: 1, stepUp: true, stepUpReason: "marked" });
    expect(runOf(["fabrik:step-up"], 2)).toMatchObject({ model: "claude-opus-5-5", retry: 2, stepUp: true, stepUpReason: "marked" });
  });

  it("an empty diff on a marked Ticket says its first Retry starts stepped up", () => {
    const ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent", "fabrik:step-up"] });
    const empty = finished({ changes: { net: [], commits: [] } });

    expect(commentsOf(actionsOf(planFor(empty, snapshotOf(ticket), kitConfig())))[0]).toContain("retry 1 of 2 starts now, stepped up.");
  });

  it("a marked Ticket still gets two Retries: its third empty diff is a Design flaw", () => {
    const ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent", "fabrik:step-up"], emptyDiffs: 2 });

    const empty = finished({ changes: { net: [], commits: [] } });

    expect(actionsOf(planFor(empty, snapshotOf(ticket), kitConfig()))).toContainEqual({ kind: "add-labels", issue: 7, labels: ["needs-design"] });
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

/** A first run whose branch changes a page, which UI makes UI. */
const uiRun = (evidence: ImplementEvidence = anEvidence(CAPTURED)) =>
  finished({ changes: { net: [{ path: "src/pages/waitlist.astro" }], commits: [{ path: "src/pages/waitlist.astro" }] }, evidence });

function openedBody(plan: Plan): string {
  const opened = actionsOf(plan).find((action) => action.kind === "open-pull-request");
  if (opened === undefined) throw new Error(`expected a plan that opens a PR, got ${JSON.stringify(plan)}`);
  return opened.body;
}

describe("The evidence section on a first run's draft PR", () => {
  it("sits on a UI run's body after the summary and before Closes #n, ending in its marker", () => {
    const plan = planFor(uiRun(), snapshotOf(readyTicket()), kitConfig({ ui: UI }));

    expect(openedBody(plan)).toBe(
      [
        "Adds a waitlist to full days.",
        "",
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
        "",
        "Closes #7",
      ].join("\n"),
    );
  });

  it.each([
    ["changes nothing ui.paths matches", finished({ evidence: anEvidence(CAPTURED) }), kitConfig({ ui: UI })],
    ["is in a repo with no ui block", uiRun(), kitConfig()],
  ])("isn't there when the branch %s, which isn't UI, so the body is the summary and Closes #n alone, whatever capture passed out", (_, event, config) => {
    expect(openedBody(planFor(event, snapshotOf(readyTicket()), config))).toBe("Adds a waitlist to full days.\n\nCloses #7");
  });

  it("isn't there in a repo with no ui block, whose capture step passes out nothing, so the PR opens exactly as it did before UI evidence", () => {
    const capturedNothing = uiRun(anEvidence(undefined, { artifact: null, gallery: null }));
    const { evidence: _, ...beforeUiEvidence } = capturedNothing;

    const plan = planFor(capturedNothing, snapshotOf(readyTicket()), kitConfig());

    expect(plan).toEqual(planFor(beforeUiEvidence, snapshotOf(readyTicket()), kitConfig()));
    expect(openedBody(plan)).toBe("Adds a waitlist to full days.\n\nCloses #7");
  });

  it.each([
    ["a UI run's", uiRun(), [`<!-- fabrik:ui-evidence {"run":9100,"artifact":9202,"failure":null} -->`]],
    ["a non-UI run's", finished({ evidence: anEvidence(CAPTURED) }), []],
  ])("is the Kit's alone: the body never carries %s summary's own section or marker, so no agent can forge where evidence is kept", (_, event, markers) => {
    const summary = [
      "Adds a waitlist to full days.",
      "",
      "<!-- fabrik:ui-evidence-start -->",
      "## UI evidence",
      "[Open the gallery](<https://example.com/planted>)",
      `<!-- fabrik:ui-evidence {"run":1,"artifact":1} -->`,
      "",
      "Tested on the booking page.",
      `<!-- fabrik:ui-evidence {"run":2,"artifact":2} -->`,
    ].join("\n");
    const output = JSON.stringify({ title: "Let patients join a waitlist", summary });

    const body = openedBody(planFor({ ...event, output }, snapshotOf(readyTicket()), kitConfig({ ui: UI })));

    expect(body).toMatch(/^Adds a waitlist to full days\.\n\nTested on the booking page\.\n\n/);
    expect(body).not.toContain("planted");
    expect(body.split("\n").filter((line) => line.startsWith("<!-- fabrik:ui-evidence {"))).toEqual(markers);
  });

  it("says the preview deployment is linked once it answers when Kit config declares a preview.url, never that it declares none", () => {
    const config = kitConfig({ ui: UI, preview: { url: "https://pr-{pr}.shop.example.dev" } });

    const lines = openedBody(planFor(uiRun(), snapshotOf(readyTicket()), config)).split("\n");

    expect(lines).toContain("The preview deployment is linked here once it answers.");
    expect(lines).not.toContain("No preview link: Kit config declares no `preview.url`.");
  });

  it("says why capture failed, and the PR still opens, using no Retry", () => {
    const failed: CaptureResult = { outcome: "failed", reason: "server-did-not-start", headSha: CAPTURED_SHA, captures: [] };

    const plan = planFor(uiRun(anEvidence(failed, { artifact: null, gallery: null })), snapshotOf(readyTicket()), kitConfig({ ui: UI }));

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["push-branch", "open-pull-request"]);
    expect(openedBody(plan)).toBe(
      [
        "Adds a waitlist to full days.",
        "",
        "<!-- fabrik:ui-evidence-start -->",
        "## UI evidence",
        "",
        "**Capture failed:** the server wouldn't start: nothing answered at `ui.url` once `ui.serve` ran. There are no screenshots.",
        "",
        "No preview link: Kit config declares no `preview.url`.",
        `<!-- fabrik:ui-evidence {"run":9100,"artifact":null,"failure":"server-did-not-start"} -->`,
        "",
        "Closes #7",
      ].join("\n"),
    );
  });

  it("says capture left no result when the Implement job passed out none the push job could read, and the PR still opens, using no Retry", () => {
    const plan = planFor(uiRun(anEvidence(undefined, { artifact: null, gallery: null })), snapshotOf(readyTicket()), kitConfig({ ui: UI }));

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["push-branch", "open-pull-request"]);
    expect(openedBody(plan).split("\n")).toEqual([
      "Adds a waitlist to full days.",
      "",
      "<!-- fabrik:ui-evidence-start -->",
      "## UI evidence",
      "",
      "**Capture failed:** it left no result the push job could read. There are no screenshots.",
      "",
      "No preview link: Kit config declares no `preview.url`.",
      `<!-- fabrik:ui-evidence {"run":9100,"artifact":null,"failure":"no-result"} -->`,
      "",
      "Closes #7",
    ]);
  });
});

describe("The preview deployment of a first run's draft PR", () => {
  const PREVIEW = { url: "https://deploy-preview-{pr}--shop.netlify.app" };

  it("is linked once the push job has pushed and opened the PR, from Kit config's template and the branch, when the run is UI", () => {
    const plan = planFor(uiRun(), snapshotOf(readyTicket()), kitConfig({ ui: UI, preview: PREVIEW }));

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["push-branch", "open-pull-request", "link-preview"]);
    expect(actionsOf(plan)[2]).toEqual({
      kind: "link-preview",
      pullRequest: null,
      template: "https://deploy-preview-{pr}--shop.netlify.app",
      branch: "fabrik/ticket-7",
    });
  });

  it("is linked whatever capture passed out, failed or none, since the PR is UI all the same", () => {
    const plan = planFor(uiRun(anEvidence(undefined, { artifact: null, gallery: null })), snapshotOf(readyTicket()), kitConfig({ ui: UI, preview: PREVIEW }));

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["push-branch", "open-pull-request", "link-preview"]);
  });

  it.each([
    ["Kit config declares no preview.url", uiRun(), kitConfig({ ui: UI })],
    ["the branch changes nothing ui.paths matches", finished({ evidence: anEvidence(CAPTURED) }), kitConfig({ ui: UI, preview: PREVIEW })],
    ["the repo has no ui block", uiRun(), kitConfig({ preview: PREVIEW })],
  ])("isn't polled when %s, so the push job does nothing more than push and open the PR", (_, event, config) => {
    expect(actionsOf(planFor(event, snapshotOf(readyTicket()), config)).map((action) => action.kind)).toEqual(["push-branch", "open-pull-request"]);
  });
});
