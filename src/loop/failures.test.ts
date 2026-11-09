import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { FailedRunCommits, LoopEvent } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

/** A failed agent job, as the push job sees it: cancelled, unless the test says otherwise. */
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
  it("a Triage run cancelled by its timeout tells the Operator to re-add needs-triage on this issue", () => {
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
            "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Re-add `needs-triage` on this issue to run it again.",
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
    // A dead token and the weekly limit notify through a Kit-owned issue instead (kitIssues.test.ts).
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
      expect(body).toContain("Re-add `needs-triage` on this issue to run it again.");
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
    const issue = anIssue({ number: 7, labels: ["ready-for-agent"], openPullRequests: [12] });

    const plan = planFor(failed({ role: "implement" }), snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "agent:implement" },
        { kind: "comment", issue: 12, body: expect.any(String) },
      ],
    });
    expect(commentOf(plan)).toContain("The Implement run on #7 failed: it crashed.");
    expect(commentOf(plan)).toContain("Re-add `agent:implement` on the Ticket (#7) to run it again.");
  });

  it("an Implement failure with no PR yet comments on the Ticket", () => {
    const plan = planFor(failed({ role: "implement" }), snapshotOf(anIssue({ number: 7 })), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "agent:implement" },
        { kind: "comment", issue: 7, body: expect.stringContaining("Re-add `agent:implement` on this Ticket to run it again.") },
      ],
    });
  });

  // Dispatch reads it back and leaves the Ticket alone until agent:implement is re-added, so no check re-runs it (#418).
  it("an Implement failure with no PR yet marks its notice on the Ticket as the run's failure", () => {
    const plan = planFor(failed({ role: "implement" }), snapshotOf(anIssue({ number: 7 })), kitConfig());

    expect(commentOf(plan)).toMatch(/^<!-- fabrik:implement-run-failed -->\n@operator The Implement run on #7 failed: /);
  });

  it("an Implement failure on a Ticket with an open PR marks its notice on the PR, so the conflict check never restarts the run (#424)", () => {
    const issue = anIssue({ number: 7, labels: ["ready-for-agent"], openPullRequests: [12] });

    const plan = planFor(failed({ role: "implement" }), snapshotOf(issue), kitConfig());

    expect(plan).toMatchObject({ kind: "act", actions: expect.arrayContaining([expect.objectContaining({ kind: "comment", issue: 12 })]) });
    expect(commentOf(plan)).toMatch(/^<!-- fabrik:implement-run-failed -->/);
  });

  // #431: its commits are never pushed, so the notice says what the run had made, and where a re-run starts.
  describe("an Implement run that failed after it had committed", () => {
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const noticeAfter = (commits: FailedRunCommits) =>
      planFor(
        failed({ role: "implement", report: { failure: "missing-output", detail: "reviewMissPoints is required", commits } }),
        snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"], openPullRequests: [12] })),
        kitConfig(),
      );

    it("says its commits are kept as a bundle on the run but weren't pushed, so a re-run starts from the old head without them", () => {
      expect(commentOf(noticeAfter({ base, continued: true, head, kept: true }))).toContain(
        [
          "> reviewMissPoints is required",
          "",
          "It had made commits before it failed. They weren't pushed, so running it again starts from `aaaaaaa` without them; they're kept for 7 days as `agent-branch.bundle` in the run's `fabrik-agent-failure` artifact.",
          "",
          "This is an Infrastructure failure,",
        ].join("\n"),
      );
    });

    it("says commits it couldn't keep are lost, and a re-run starts from the old head", () => {
      expect(commentOf(noticeAfter({ base, continued: true, head, kept: false }))).toContain(
        "It had made commits before it failed, and they weren't kept, so running it again starts from `aaaaaaa` without them.",
      );
    });

    it("says a run that made no commits lost none", () => {
      expect(commentOf(noticeAfter({ base, continued: true, head: null, kept: false }))).toContain(
        "It made no commits, so running it again starts from `aaaaaaa`, as this run did.",
      );
    });

    // A first run cuts its branch from the default branch, whose head may have moved by the re-run.
    it("names no commit for a re-run of a run that cut its branch, only the default branch", () => {
      expect(commentOf(noticeAfter({ base, continued: false, head, kept: true }))).toContain(
        "They weren't pushed, so running it again starts from the default branch without them;",
      );
      expect(commentOf(noticeAfter({ base, continued: false, head: null, kept: false }))).toContain(
        "It made no commits, so running it again starts from the default branch, as this run did.",
      );
    });

    it("says nothing of commits when the report doesn't say", () => {
      const plan = planFor(failed({ role: "implement", report: { failure: "missing-output", detail: "" } }), snapshotOf(anIssue({ number: 7 })), kitConfig());

      expect(commentOf(plan)).not.toMatch(/commits/);
    });
  });

  it("a Review failure's notice on the PR carries no failure marker", () => {
    const issue = anIssue({ number: 7, openPullRequests: [12] });

    const plan = planFor(failed({ role: "review", report: { failure: "missing-output", detail: "" } }), snapshotOf(issue), kitConfig());

    expect(commentOf(plan)).not.toContain("-failed -->");
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
    expect(commentOf(plan)).toContain("Re-add `agent:review` on this PR to run it again.");
  });

  it("a Design-session turn failure keeps needs-design, so the issue stays in its session, and says a reply runs it again", () => {
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design"] });
    const plan = planFor(failed({ role: "design" }), snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "comment", issue: 7, body: expect.any(String) }] });
    expect(commentOf(plan)).toContain("Reply on this issue to run the turn again.");
  });

  it("after a Design-session turn failure, the Operator's reply starts the turn again", () => {
    // The failure notice marks the turn failed, so the session keeps its slot.
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design"], turnFailed: true });
    const reply: LoopEvent = { kind: "issue-comment-created", issue: 7, commenter: "operator", commenterIsBot: false, body: "Try again", comment: 9001 };

    expect(planFor(reply, snapshotOf(issue), kitConfig())).toMatchObject({
      kind: "act",
      actions: [{ kind: "start-agent-run", role: "design", issue: 7 }],
    });
  });

  // #328: a turn on a sent-back Ticket whose job couldn't read the closed PR.
  describe("when the Kit's input step couldn't read the agent's inputs", () => {
    const refused = { failure: "unread-inputs", detail: "GET /repos/acme/shop/pulls/84: 403 Resource not accessible by integration", refused: true } as const;
    const failedRead = { failure: "unread-inputs", detail: "GET /repos/acme/shop/pulls/84: 502 Bad Gateway" } as const;
    const designIssue = anIssue({ number: 7, labels: ["enhancement", "needs-design"] });

    it("a Design-session turn GitHub refused names the input step, the request and GitHub's answer, and says the Kit needs fixing before a reply helps", () => {
      const plan = planFor(failed({ role: "design", report: refused }), snapshotOf(designIssue), kitConfig());

      // Still an Infrastructure failure: one comment, nothing started, needs-design kept.
      expect(plan).toEqual({ kind: "act", actions: [{ kind: "comment", issue: 7, body: expect.any(String) }] });
      expect(commentOf(plan)).toBe(
        [
          "<!-- fabrik:design-turn-failed -->",
          "@operator The Design-session turn run on #7 failed: GitHub refused a request in the Kit's input step, so the agent never started.",
          "",
          "> GET /repos/acme/shop/pulls/84: 403 Resource not accessible by integration",
          "",
          "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. GitHub refuses this request every time, so running it again won't help: the Kit needs fixing first. Once that fix is in, reply on this issue to run the turn again.",
          "",
          `[The run](${RUN})`,
        ].join("\n"),
      );
    });

    it("a prototype turn GitHub refused says the same of its own resumption", () => {
      const plan = planFor(failed({ role: "design", prototype: true, report: refused }), snapshotOf(designIssue), kitConfig());

      expect(commentOf(plan)).toContain("The prototype turn on #7 failed: GitHub refused a request in the Kit's input step");
      expect(commentOf(plan)).toContain("the Kit needs fixing first. Once that fix is in, reply on this issue to carry the session on:");
    });

    it("any other role's refused read names its label as the way back once the Kit is fixed", () => {
      const plan = planFor(failed({ report: refused }), snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] })), kitConfig());

      expect(commentOf(plan)).toContain("The Triage run on #7 failed: GitHub refused a request in the Kit's input step, so the agent never started.");
      expect(commentOf(plan)).toContain("Once that fix is in, re-add `needs-triage` on this issue to run it again.");
    });

    it("a read GitHub failed (a 5xx or no answer) names the error and offers a reply as the retry", () => {
      const plan = planFor(failed({ role: "design", report: failedRead }), snapshotOf(designIssue), kitConfig());
      const body = commentOf(plan);

      expect(body).toContain("failed: a GitHub request failed in the Kit's input step, so the agent never started.");
      expect(body).toContain("> GET /repos/acme/shop/pulls/84: 502 Bad Gateway");
      expect(body).toContain("doesn't count against the Ticket's retries. Reply on this issue to run the turn again.");
      expect(body).not.toContain("needs fixing");
    });

    it("an input step that left no report still reads as a crash", () => {
      const body = commentOf(planFor(failed({ role: "design", report: null }), snapshotOf(designIssue), kitConfig()));

      expect(body).toContain("failed: it crashed.");
      expect(body).toContain("Reply on this issue to run the turn again.");
    });
  });

  it("mentions whoever the Operator is", () => {
    const plan = planFor(failed(), snapshotOf(anIssue({ number: 7 }), { operator: "jrey" }), kitConfig());

    expect(commentOf(plan)).toMatch(/^@jrey The Triage run/);
  });
});
