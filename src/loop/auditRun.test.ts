import { describe, expect, it } from "vitest";
import { anIssue, auditBody, AUDITED_SHA, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { planFor } from "./rules.ts";
import type { IssueSnapshot, LoopEvent, Plan } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

/** A `fabrik:audit` issue as the Loop sees it: by default the App's pending Audit, open and waiting on its run. */
function anAudit(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return anIssue({ number: 98, byApp: true, labels: ["fabrik:audit"], body: auditBody(AUDITED_SHA, "pending"), ...overrides });
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

/** The Auditor's agent job on the Audit failed, as the push job sees it: it crashed, unless the test says otherwise. */
function auditFailed(overrides: Partial<Extract<LoopEvent, { kind: "agent-run-failed" }>> = {}): LoopEvent {
  return {
    kind: "agent-run-failed",
    role: "audit",
    issue: 98,
    runUrl: RUN,
    jobResult: "failure",
    secretsStep: "success",
    report: null,
    ...overrides,
  };
}

describe("The App's pending Audit, when it's opened", () => {
  it("starts an Auditor run on roles.audit's model, effort and timeout, reading up to its marked commit", () => {
    const config = kitConfig({
      roles: { ...DEFAULT_KIT_CONFIG.roles, audit: { model: "claude-auditor", effort: "high", timeoutMinutes: 50 } },
    });

    const plan = planFor({ kind: "issue-opened", issue: 98 }, snapshotOf(anAudit()), config);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "start-agent-run",
          role: "audit",
          issue: 98,
          commit: AUDITED_SHA,
          model: "claude-auditor",
          effort: "high",
          timeoutMinutes: 50,
          subscription: "Claude token",
        },
      ],
    });
  });

  it("starts no run when its body has lost its audit marker, so it names no commit to read", () => {
    const issue = anAudit({ body: "The Auditor is reading the default branch.\n\n<!-- fabrik:audit-pending -->" });

    const plan = planFor({ kind: "issue-opened", issue: 98 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: expect.stringContaining("no commit") });
  });
});

describe("Any other fabrik:audit issue, when it's opened", () => {
  it.each([
    ["the App's filled Audit", anAudit({ body: auditBody(AUDITED_SHA, "filled") })],
    ["the App's failed Audit, closed", anAudit({ open: false, body: auditBody(AUDITED_SHA, "failed") })],
    ["the App's pending Audit, already closed by the Operator", anAudit({ open: false })],
    ["a person's issue with the label and the pending marker", anAudit({ byApp: false, author: "someone" })],
  ])("starts no run: %s", (_, issue) => {
    const plan = planFor({ kind: "issue-opened", issue: 98 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: expect.stringContaining("fabrik:audit") });
  });

  it("a person's issue quoting the pending marker without the label starts no run, and goes to Triage like any issue", () => {
    const issue = anAudit({ byApp: false, author: "someone", labels: [] });

    const plan = planFor({ kind: "issue-opened", issue: 98 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "add-labels", issue: 98, labels: ["needs-triage"] }] });
  });
});

describe("A failed Auditor run on the pending Audit", () => {
  it("rewrites the Audit to one line on how the run failed, keeps its audit marker, marks it failed and closes it as not planned", () => {
    const plan = planFor(auditFailed(), snapshotOf(anAudit()), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "edit-issue-body",
          issue: 98,
          body: [
            `The Auditor's run failed: it crashed. [The run](${RUN})`,
            "",
            `<!-- fabrik:audit ${AUDITED_SHA} -->`,
            "<!-- fabrik:audit-failed -->",
          ].join("\n"),
        },
        { kind: "close", issue: 98, reason: "not_planned" },
      ],
    });
  });

  it.each([
    ["a timeout", auditFailed({ jobResult: "cancelled", secretsStep: null }), "it was cancelled, most likely by its 45-minute timeout"],
    ["unreachable 1Password", auditFailed({ secretsStep: "failure" }), "its secrets couldn't be loaded from 1Password"],
    ["a crash", auditFailed(), "it crashed"],
    ["missing output", auditFailed(report("missing-output")), "the agent gave no valid output"],
    ["a provider error", auditFailed(report("provider-error")), "the model provider returned an error"],
    ["a dead token", auditFailed(report("dead-token")), "the Claude token was refused (`authentication_failed`), so it may need rotating"],
    ["the weekly limit", auditFailed(report("weekly-limit")), "it hit the weekly usage limit"],
    [
      "metered billing",
      auditFailed(report("metered-billing")),
      "the preflight found a route that would bill metered API usage, so it refused to start the agent",
    ],
  ])("after %s, leaves the Audit in its failed form, closed as not planned", (_, event, how) => {
    const plan = planFor(event, snapshotOf(anAudit()), kitConfig());

    const onAudit = actionsOf(plan).filter((action) => "issue" in action && action.issue === 98);
    expect(onAudit).toEqual([
      {
        kind: "edit-issue-body",
        issue: 98,
        body: `The Auditor's run failed: ${how}. [The run](${RUN})\n\n<!-- fabrik:audit ${AUDITED_SHA} -->\n<!-- fabrik:audit-failed -->`,
      },
      { kind: "close", issue: 98, reason: "not_planned" },
    ]);
  });
});

describe("A dead token or the weekly limit on an Auditor run", () => {
  it("also opens the Rotate the Claude token issue, as for any run", () => {
    const plan = planFor(auditFailed(report("dead-token")), snapshotOf(anAudit()), kitConfig());

    expect(actionsOf(plan).filter((action) => action.kind === "open-issue")).toEqual([
      {
        kind: "open-issue",
        title: "Rotate the Claude token",
        body: expect.stringContaining("The Audit run on #98 was the first to fail"),
        labels: ["ready-for-human", "fabrik:token-rotation"],
        assignees: ["operator"],
      },
    ]);
  });

  it("also opens the weekly-limit issue, saying when the limit resets, as for any run", () => {
    const plan = planFor(auditFailed(report("weekly-limit")), snapshotOf(anAudit()), kitConfig());

    expect(actionsOf(plan).filter((action) => action.kind === "open-issue")).toEqual([
      expect.objectContaining({
        title: "The weekly usage limit is reached until 2026-11-09 04:00 UTC",
        body: expect.stringContaining("@operator The Audit run on #98 hit the weekly usage limit."),
        labels: ["fabrik:weekly-limit"],
      }),
    ]);
  });

  it("comments on the Kit's open issue about it instead, quietly once the Operator has heard", () => {
    const rotation = {
      number: 40,
      labels: ["ready-for-human", "fabrik:token-rotation"],
      body: "The Claude token was refused.\n\n<!-- fabrik:notified -->",
      comments: [],
    };

    const plan = planFor(auditFailed(report("dead-token")), snapshotOf(anAudit(), { kitIssues: [rotation] }), kitConfig());

    expect(actionsOf(plan)).toContainEqual({ kind: "comment", issue: 40, body: `The Audit run on #98 was refused too. [The run](${RUN})` });
    expect(notificationsOf(plan)).toEqual([]);
  });
});

describe("Whatever an Auditor run's failure", () => {
  it.each(FAILURES)("after a %s, posts no comment naming a trigger label, takes no label off, and mentions nobody on the Audit", (failure) => {
    const plan = planFor(auditFailed(report(failure)), snapshotOf(anAudit()), kitConfig());

    const onAudit = actionsOf(plan).filter((action) => "issue" in action && action.issue === 98);
    expect(onAudit.map((action) => action.kind)).toEqual(["edit-issue-body", "close"]);
    expect(JSON.stringify(onAudit)).not.toContain("@");
    // Only a repo-wide failure buzzes the Operator, through the Kit's own issue.
    const repoWide = failure === "dead-token" || failure === "weekly-limit";
    expect(notificationsOf(plan)).toHaveLength(repoWide ? 1 : 0);
  });
});

describe("A failed Auditor run on an Audit that's no longer pending", () => {
  it.each([
    ["closed by the Operator while it ran", anAudit({ open: false })],
    ["filled in already", anAudit({ body: auditBody(AUDITED_SHA, "filled") })],
    ["failed already", anAudit({ open: false, body: auditBody(AUDITED_SHA, "failed") })],
    ["a person's issue, not the App's", anAudit({ byApp: false })],
    ["without its fabrik:audit label", anAudit({ labels: [] })],
  ])("changes nothing when it's %s", (_, issue) => {
    for (const failure of FAILURES) {
      expect(planFor(auditFailed(report(failure)), snapshotOf(issue), kitConfig())).toEqual({
        kind: "nothing",
        reason: expect.stringContaining("#98"),
      });
    }
  });
});
