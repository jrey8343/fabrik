import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, notificationsOf, RETRO_WINDOW_END, retroBody, snapshotOf } from "../__fixtures__/snapshots.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { planFor } from "./rules.ts";
import type { IssueSnapshot, LoopEvent, Plan } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

/** A `fabrik:retro` issue as the Loop sees it: by default the App's pending Retro, open and waiting on its run. */
function aRetro(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return anIssue({ number: 120, byApp: true, labels: ["fabrik:retro"], body: retroBody(RETRO_WINDOW_END, "pending"), ...overrides });
}

type Failure = NonNullable<Extract<LoopEvent, { kind: "agent-run-failed" }>["report"]>["failure"];

const FAILURES: readonly Failure[] = ["crash", "missing-output", "provider-error", "dead-token", "weekly-limit", "metered-billing"];

/** What the agent job reported about failing this way, with a detail that would mention someone if it were posted. */
function report(failure: Failure): Pick<Extract<LoopEvent, { kind: "agent-run-failed" }>, "report"> {
  return {
    report: { failure, detail: "@someone said so", ...(failure === "weekly-limit" ? { resetsAt: "2026-11-09T04:00:00.000Z" } : {}) },
  };
}

function actionsOf(plan: Plan) {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${plan.kind}`);
  return plan.actions;
}

/** The pending Retro's evidence job or agent job failed, as the push job sees it: it crashed, unless the test says otherwise. */
function retroFailed(overrides: Partial<Extract<LoopEvent, { kind: "agent-run-failed" }>> = {}): LoopEvent {
  return {
    kind: "agent-run-failed",
    role: "retro",
    issue: 120,
    runUrl: RUN,
    jobResult: "failure",
    secretsStep: "success",
    report: null,
    ...overrides,
  };
}

describe("The App's pending Retro, when it's opened", () => {
  it("starts a Retro run on roles.retro's model, effort and timeout", () => {
    const config = kitConfig({
      roles: { ...DEFAULT_KIT_CONFIG.roles, retro: { model: "claude-retro", effort: "high", timeoutMinutes: 50 } },
    });

    const plan = planFor({ kind: "issue-opened", issue: 120 }, snapshotOf(aRetro()), config);

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "start-agent-run", role: "retro", issue: 120, model: "claude-retro", effort: "high", timeoutMinutes: 50 }],
    });
  });
});

describe("Any other fabrik:retro issue, when it's opened", () => {
  it.each([
    ["the App's filled Retro", aRetro({ body: retroBody(RETRO_WINDOW_END, "filled") })],
    ["the App's failed Retro, closed", aRetro({ open: false, body: retroBody(RETRO_WINDOW_END, "failed") })],
    ["the App's pending Retro, already closed by the Operator", aRetro({ open: false })],
    ["a person's issue with the label and the pending marker", aRetro({ byApp: false, author: "someone" })],
  ])("starts no run: %s", (_, issue) => {
    const plan = planFor({ kind: "issue-opened", issue: 120 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: expect.stringContaining("fabrik:retro") });
  });

  it("a person's issue quoting the pending marker without the label starts no run, and goes to Triage like any issue", () => {
    const issue = aRetro({ byApp: false, author: "someone", labels: [] });

    const plan = planFor({ kind: "issue-opened", issue: 120 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "add-labels", issue: 120, labels: ["needs-triage"] }] });
  });
});

describe("A failed Retro run on the pending Retro", () => {
  it("rewrites the Retro to one line on how the run failed, keeps its retro marker, marks it failed and closes it as not planned", () => {
    const plan = planFor(retroFailed(), snapshotOf(aRetro()), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "edit-issue-body",
          issue: 120,
          body: [
            `The Retro's run failed: it crashed. [The run](${RUN})`,
            "",
            `<!-- fabrik:retro ${RETRO_WINDOW_END} -->`,
            "<!-- fabrik:retro-failed -->",
          ].join("\n"),
        },
        { kind: "close", issue: 120, reason: "not_planned" },
      ],
    });
  });
});

describe("Each way a Retro run fails", () => {
  it.each([
    ["a timeout", retroFailed({ jobResult: "cancelled", secretsStep: null }), "it was cancelled, most likely by its 45-minute timeout"],
    ["unreachable 1Password", retroFailed({ secretsStep: "failure" }), "its secrets couldn't be loaded from 1Password"],
    ["a crash of its evidence job, as when the store went away after the tick, or of its agent job", retroFailed(), "it crashed"],
    ["missing output", retroFailed(report("missing-output")), "the agent gave no valid output"],
    ["a provider error", retroFailed(report("provider-error")), "the model provider returned an error"],
    ["a dead token", retroFailed(report("dead-token")), "the Claude token was refused (`authentication_failed`), so it may need rotating"],
    ["the weekly limit", retroFailed(report("weekly-limit")), "it hit the weekly usage limit"],
    [
      "metered billing",
      retroFailed(report("metered-billing")),
      "the preflight found a route that would bill metered API usage, so it refused to start the agent",
    ],
  ])("after %s, leaves the Retro in its failed form, closed as not planned", (_, event, how) => {
    const plan = planFor(event, snapshotOf(aRetro()), kitConfig());

    const onRetro = actionsOf(plan).filter((action) => "issue" in action && action.issue === 120);
    expect(onRetro).toEqual([
      {
        kind: "edit-issue-body",
        issue: 120,
        body: `The Retro's run failed: ${how}. [The run](${RUN})\n\n<!-- fabrik:retro ${RETRO_WINDOW_END} -->\n<!-- fabrik:retro-failed -->`,
      },
      { kind: "close", issue: 120, reason: "not_planned" },
    ]);
  });
});

describe("A dead token or the weekly limit on a Retro run", () => {
  it("also opens the Rotate the Claude token issue, as for any run", () => {
    const plan = planFor(retroFailed(report("dead-token")), snapshotOf(aRetro()), kitConfig());

    expect(actionsOf(plan).filter((action) => action.kind === "open-issue")).toEqual([
      {
        kind: "open-issue",
        title: "Rotate the Claude token",
        body: expect.stringContaining("The Retro run on #120 was the first to fail"),
        labels: ["ready-for-human", "fabrik:token-rotation"],
        assignees: ["operator"],
      },
    ]);
  });

  it("also opens the weekly-limit issue, saying when the limit resets, as for any run", () => {
    const plan = planFor(retroFailed(report("weekly-limit")), snapshotOf(aRetro()), kitConfig());

    expect(actionsOf(plan).filter((action) => action.kind === "open-issue")).toEqual([
      expect.objectContaining({
        title: "The weekly usage limit is reached until 2026-11-09 04:00 UTC",
        body: expect.stringContaining("@operator The Retro run on #120 hit the weekly usage limit."),
        labels: ["fabrik:weekly-limit"],
      }),
    ]);
  });
});

describe("Whatever a Retro run's failure", () => {
  it.each(FAILURES)("after a %s, posts no comment naming a trigger label, takes no label off, and mentions nobody on the Retro", (failure) => {
    const plan = planFor(retroFailed(report(failure)), snapshotOf(aRetro()), kitConfig());

    const onRetro = actionsOf(plan).filter((action) => "issue" in action && action.issue === 120);
    expect(onRetro.map((action) => action.kind)).toEqual(["edit-issue-body", "close"]);
    expect(JSON.stringify(onRetro)).not.toContain("@");
    // Only a repo-wide failure buzzes the Operator, through the Kit's own issue.
    const repoWide = failure === "dead-token" || failure === "weekly-limit";
    expect(notificationsOf(plan)).toHaveLength(repoWide ? 1 : 0);
  });
});

describe("A failed Retro run on a Retro that's no longer pending", () => {
  it.each([
    ["closed by the Operator while it ran", aRetro({ open: false })],
    ["filled in already", aRetro({ body: retroBody(RETRO_WINDOW_END, "filled") })],
    ["failed already", aRetro({ open: false, body: retroBody(RETRO_WINDOW_END, "failed") })],
    ["a person's issue, not the App's", aRetro({ byApp: false })],
    ["without its fabrik:retro label", aRetro({ labels: [] })],
  ])("changes nothing when it's %s", (_, issue) => {
    for (const failure of FAILURES) {
      expect(planFor(retroFailed(report(failure)), snapshotOf(issue), kitConfig())).toEqual({
        kind: "nothing",
        reason: expect.stringContaining("#120"),
      });
    }
  });
});
