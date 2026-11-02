import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { LoopEvent } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

/** A failed agent job, as the failure job sees it: cancelled, unless the test says otherwise. */
function failed(overrides: Partial<Extract<LoopEvent, { kind: "agent-run-failed" }>> = {}): LoopEvent {
  return {
    kind: "agent-run-failed",
    role: "triage",
    issue: 7,
    runUrl: RUN,
    jobResult: "failure",
    secretsStep: "success",
    report: null,
    ...overrides,
  };
}

describe("Failure notices", () => {
  it("a Triage run cancelled by its timeout tells the Operator to re-add needs-triage on the issue", () => {
    const issue = anIssue({ number: 7, labels: ["needs-triage"] });

    const plan = planFor(failed({ jobResult: "cancelled", secretsStep: null }), snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "needs-triage" },
        {
          kind: "comment",
          issue: 7,
          body: [
            "@operator The Triage run on #7 failed: it was cancelled, most likely by its 10-minute timeout.",
            "",
            "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Re-add the `needs-triage` label to run it again.",
            "",
            `[The run](${RUN})`,
          ].join("\n"),
        },
      ],
    });
  });

  const commentOf = (plan: ReturnType<typeof planFor>) => {
    if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${plan.kind}`);
    const comments = plan.actions.filter((action) => action.kind === "comment");
    expect(comments).toHaveLength(1);
    return comments[0]!.body;
  };

  it.each([
    ["timeout", failed({ jobResult: "cancelled", secretsStep: null }), "it was cancelled, most likely by its 10-minute timeout"],
    ["crash", failed({ jobResult: "failure" }), "it crashed"],
    [
      "unreachable 1Password",
      failed({ secretsStep: "failure" }),
      "its secrets couldn't be loaded from 1Password",
    ],
    [
      "missing output",
      failed({ report: { failure: "missing-output", detail: "" } }),
      "the agent gave no valid output",
    ],
    [
      "provider error",
      failed({ report: { failure: "provider-error", detail: "" } }),
      "the model provider returned an error",
    ],
    [
      "dead token",
      failed({ report: { failure: "dead-token", detail: "" } }),
      "the Claude token was refused (`authentication_failed`), so it may need rotating",
    ],
    [
      "weekly limit",
      failed({ report: { failure: "weekly-limit", detail: "" } }),
      "it hit the weekly usage limit",
    ],
    [
      "metered billing",
      failed({ report: { failure: "metered-billing", detail: "" } }),
      "the preflight found a route that would bill metered API usage, so it refused to start the agent",
    ],
  ] as const)(
    "a %s posts one comment that mentions the Operator, says how it failed, names the label and links the run, and retries nothing",
    (_name, event, how) => {
      const issue = anIssue({ number: 7, labels: ["needs-triage"] });

      const plan = planFor(event, snapshotOf(issue), kitConfig());

      // Only these two actions: no agent run starts, so nothing is retried.
      expect(plan).toEqual({
        kind: "act",
        actions: [
          { kind: "remove-label", issue: 7, label: "needs-triage" },
          { kind: "comment", issue: 7, body: expect.any(String) },
        ],
      });
      const body = commentOf(plan);
      expect(body.match(/@\S+/g)).toEqual(["@operator"]);
      expect(body).toContain(`The Triage run on #7 failed: ${how}.`);
      expect(body).toContain("Re-add the `needs-triage` label to run it again.");
      expect(body).toContain(`[The run](${RUN})`);
    },
  );

  it("names the timeout from the role's Kit config", () => {
    const config = kitConfig();
    const longer = { ...config, roles: { ...config.roles, implement: { ...config.roles.implement, timeoutMinutes: 90 } } };

    const plan = planFor(
      failed({ role: "implement", jobResult: "cancelled", secretsStep: null }),
      snapshotOf(anIssue({ number: 7 })),
      longer,
    );

    expect(commentOf(plan)).toContain("most likely by its 90-minute timeout");
  });

  it("blames 1Password before anything else, since the agent never started", () => {
    const plan = planFor(
      failed({ jobResult: "cancelled", secretsStep: "failure" }),
      snapshotOf(anIssue({ number: 7 })),
      kitConfig(),
    );

    expect(commentOf(plan)).toContain("its secrets couldn't be loaded from 1Password");
  });

  it("quotes the agent job's own detail about the failure", () => {
    const plan = planFor(
      failed({ report: { failure: "provider-error", detail: "overloaded (529)" } }),
      snapshotOf(anIssue({ number: 7 })),
      kitConfig(),
    );

    expect(commentOf(plan)).toContain("the model provider returned an error.\n\n> overloaded (529)\n");
  });

  it("an Implement failure on a Ticket with an open PR comments on the PR and names agent:implement on the Ticket", () => {
    const issue = anIssue({ number: 7, labels: ["ready-for-agent", "agent:implement"], openPullRequests: [12] });

    const plan = planFor(failed({ role: "implement" }), snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "agent:implement" },
        { kind: "comment", issue: 12, body: expect.any(String) },
      ],
    });
    expect(commentOf(plan)).toContain("The Implement run on #7 failed: it crashed.");
    expect(commentOf(plan)).toContain("Re-add the `agent:implement` label on #7 to run it again.");
  });

  it("an Implement failure with no PR yet comments on the Ticket", () => {
    const plan = planFor(failed({ role: "implement" }), snapshotOf(anIssue({ number: 7 })), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "agent:implement" },
        { kind: "comment", issue: 7, body: expect.stringContaining("Re-add the `agent:implement` label to run it again.") },
      ],
    });
  });

  it("a Review failure names agent:review on the PR, where the review trigger lives", () => {
    const issue = anIssue({ number: 7, openPullRequests: [12] });

    const plan = planFor(
      failed({ role: "review", report: { failure: "missing-output", detail: "" } }),
      snapshotOf(issue),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 12, label: "agent:review" },
        { kind: "comment", issue: 12, body: expect.any(String) },
      ],
    });
    expect(commentOf(plan)).toContain("The Review run on #7 failed: the Reviewer gave no valid Verdict.");
    expect(commentOf(plan)).toContain("Re-add the `agent:review` label to run it again.");
  });

  it("a Design-session turn failure names needs-design", () => {
    const plan = planFor(failed({ role: "design" }), snapshotOf(anIssue({ number: 7 })), kitConfig());

    expect(commentOf(plan)).toContain("Re-add the `needs-design` label to run it again.");
  });

  it("mentions whoever the Operator is", () => {
    const plan = planFor(failed(), snapshotOf(anIssue({ number: 7 }), { operator: "jrey" }), kitConfig());

    expect(commentOf(plan)).toMatch(/^@jrey The Triage run/);
  });
});
