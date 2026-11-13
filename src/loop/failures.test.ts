import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, notificationsOf, snapshotOf, verdictsPostedIn } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { FailedRunCommits, FailureReport, LoopEvent, PullRequestSnapshot } from "./types.ts";

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
            "@operator The Triage run on #7 failed: it was cancelled, by its 10-minute timeout or by hand.",
            "",
            "This is an Infrastructure failure, so the Loop won't retry it. Re-add `needs-triage` on this issue to run it again.",
            "",
            `[The run](${RUN})`,
            '<!-- fabrik:hand-back {"kind":"infrastructure-failure","role":"triage","failure":"timeout"} -->',
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
    ["timeout", failed({ jobResult: "cancelled", secretsStep: null }), "it was cancelled, by its 10-minute timeout or by hand"],
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

    expect(commentOf(plan)).toContain("by its 90-minute timeout or by hand");
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

  // #535 held its Ticket back from Dispatch; since #434 it's a Broken run the Kit re-runs itself, so nothing holds it.
  it("says a first Implement run built on commits its branch didn't start from, naming them, and doesn't hold its Ticket back from Dispatch", () => {
    const older = "c".repeat(40);
    const detail = `agent/7 builds on a commit it didn't start from (\`${older}\`)`;
    const plan = planFor(
      failed({ role: "implement", report: { failure: "unlandable-branch", detail, commits: { base: "a".repeat(40), continued: false, head: "b".repeat(40), kept: true } } }),
      snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"] })),
      kitConfig(),
    );

    const body = commentOf(plan);
    expect(body).toMatch(/^<!-- fabrik:broken-run -->\n/);
    expect(body).toContain("The Implement run on #7 was a Broken run, and the Kit opened no PR: the Implementer built on commits its branch didn't start from, so the push job couldn't rebuild it.");
    expect(body).toContain(`> ${detail}`);
    expect(body).toContain("they're kept for 7 days as `agent-branch.bundle`");
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
          "This is a Broken run",
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

  // #454: the Review checks job gives up short of its timeout, or GitHub fails it mid-wait, and says which.
  describe("when the Review stopped waiting for its required checks", () => {
    const issue = anIssue({ number: 7, openPullRequests: [12] });
    const review = (report: NonNullable<Extract<LoopEvent, { kind: "agent-run-failed" }>["report"]>) =>
      planFor(failed({ role: "review", report }), snapshotOf(issue), kitConfig());

    it("names a Required check that never reported, says where to look, and that re-adding the label won't change it", () => {
      const plan = review({ failure: "unreported-checks", detail: "", checks: ["e2e"] });

      expect(plan).toEqual({
        kind: "act",
        actions: [
          { kind: "remove-label", issue: 12, label: "agent:review" },
          { kind: "comment", issue: 12, body: expect.any(String) },
        ],
      });
      expect(commentOf(plan)).toBe(
        [
          "@operator The Review run on #7 failed: the Required check `e2e` never reported on this PR; fix its workflow's name or `paths:` filter, or take it off the default branch's required list on github.com, and out of `sandbox.checks` too if it's listed there.",
          "",
          "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Re-adding the `agent:review` label won't change this. After fixing the workflow or the Required checks, re-add `agent:review` on this PR to run it again.",
          "",
          `[The run](${RUN})`,
          '<!-- fabrik:hand-back {"kind":"infrastructure-failure","role":"review","failure":"unreported-checks"} -->',
        ].join("\n"),
      );
    });

    it("names every Required check that never reported", () => {
      const body = commentOf(review({ failure: "unreported-checks", detail: "", checks: ["e2e", "smoke"] }));

      expect(body).toContain(
        "failed: the Required checks `e2e` and `smoke` never reported on this PR; fix their workflows' names or `paths:` filters, or take them off the default branch's required list on github.com, and out of `sandbox.checks` too if they're listed there.",
      );
    });

    it("still says where to look when the report lost the names of the checks that never reported", () => {
      const body = commentOf(review({ failure: "unreported-checks", detail: "" }));

      expect(body).toContain(
        "failed: a Required check never reported on this PR; check the workflow names and `paths:` filters of the Required checks, those the default branch requires and those `sandbox.checks` lists.",
      );
    });

    it("names the checks still running when it gave up short of its timeout, and offers the label to wait again", () => {
      const body = commentOf(review({ failure: "timeout", detail: "", checks: ["build", "e2e", "lint"] }));

      expect(body).toContain(
        "The Review run on #7 failed: it stopped waiting for its required checks short of its 30-minute timeout, with `build`, `e2e` and `lint` still running.",
      );
      expect(body).toContain("Re-add `agent:review` on this PR to run it again.");
    });

    it("says it was still waiting when a GitHub request failed, quoting the error, rather than that the Reviewer crashed", () => {
      const body = commentOf(review({ failure: "unread-checks", detail: "gh pr checks failed: HTTP 502: Bad Gateway" }));

      expect(body).toContain("The Review run on #7 failed: it was still waiting for its required checks when a GitHub request failed.");
      expect(body).toContain("> gh pr checks failed: HTTP 502: Bad Gateway");
      expect(body).toContain("Re-add `agent:review` on this PR to run it again.");
    });
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
          "@operator The Design-session turn on #7 failed: GitHub refused a request in the Kit's input step, so the agent never started.",
          "",
          "> GET /repos/acme/shop/pulls/84: 403 Resource not accessible by integration",
          "",
          "This is an Infrastructure failure, so the Loop won't retry it. GitHub refuses this request every time, so running it again won't help: the Kit needs fixing first. Once that fix is in, reply on this issue to run the turn again.",
          "",
          `[The run](${RUN})`,
          '<!-- fabrik:hand-back {"kind":"design-turn-failed","role":"design","failure":"unread-inputs","run":42} -->',
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
      expect(body).toContain("the Loop won't retry it. Reply on this issue to run the turn again.");
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

describe("Failure notices say what fits the run that failed (#436)", () => {
  const bodyOf = (plan: ReturnType<typeof planFor>): string =>
    (plan.kind === "act" ? plan.actions : []).flatMap((action) => (action.kind === "comment" ? [action.body] : [])).join("\n");

  it("an Implement run's notice still says it doesn't count against the Ticket's retries", () => {
    const body = bodyOf(planFor(failed({ role: "implement" }), snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"] })), kitConfig()));

    expect(body).toContain("the Loop won't retry it and it doesn't count against the Ticket's retries. Re-add `agent:implement` on this Ticket to run it again.");
  });

  it("with one Subscription, a run that hit the weekly limit says to re-add its label after the reset", () => {
    const event = failed({
      role: "implement",
      report: { failure: "weekly-limit", detail: "resets at 2026-11-09T04:00:00.000Z", resetsAt: "2026-11-09T04:00:00.000Z" },
    });
    const body = bodyOf(planFor(event, snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"] })), kitConfig()));

    expect(body).toContain("Once the weekly limit resets at 2026-11-09 04:00 UTC, re-add `agent:implement` on this Ticket to run it again.");
  });

  it("says when the weekly limit resets once, in the Operator's time zone, never quoting the run's UTC reset too", () => {
    const event = failed({
      role: "implement",
      report: { failure: "weekly-limit", detail: "resets at 2026-11-09T04:00:00.000Z", resetsAt: "2026-11-09T04:00:00.000Z" },
    });
    const body = bodyOf(planFor(event, snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"] })), kitConfig({ timeZone: "Australia/Sydney" })));

    expect(body).toContain("Once the weekly limit resets at 2026-11-09 15:00 Australia/Sydney, re-add `agent:implement`");
    expect(body).not.toContain("2026-11-09T04:00:00.000Z");
  });

  it("says only once the weekly limit resets when it isn't known when", () => {
    const event = failed({ role: "implement", report: { failure: "weekly-limit", detail: "" } });
    const body = bodyOf(planFor(event, snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"] })), kitConfig()));

    expect(body).toContain("Once the weekly limit resets, re-add `agent:implement` on this Ticket to run it again.");
  });
});

// #434: an Implement run whose work the Kit can't land because of what the agent did.
describe("A Broken run", () => {
  const BROKEN = [
    ["output that breaks its contract", { failure: "missing-output", detail: "reviewMissPoints is required" }, "the Implementer gave no valid output"],
    ["leaving its branch", { failure: "left-branch", detail: "The agent left agent/7 for main" }, "the Implementer left its branch"],
    ["building on commits its branch didn't start from", { failure: "unlandable-branch", detail: "agent/7 builds on a commit it didn't start from" }, "the Implementer built on commits its branch didn't start from"],
  ] as const;
  const commentsOf = (plan: ReturnType<typeof planFor>) =>
    (plan.kind === "act" ? plan.actions : []).flatMap((action) => (action.kind === "comment" ? [action] : []));

  describe("on a Ticket's first run", () => {
    it.each(BROKEN)("by %s is an Execution flaw: a broken-run comment mentioning nobody, and the Retry starts", (_name, report, how) => {
      const ticket = anIssue({ number: 7, labels: ["ready-for-agent"] });

      const plan = planFor(failed({ role: "implement", report }), snapshotOf(ticket), kitConfig());

      expect(plan).toEqual({
        kind: "act",
        actions: [
          { kind: "comment", issue: 7, body: expect.stringMatching(/^<!-- fabrik:broken-run -->\n/) },
          { kind: "add-labels", issue: 7, labels: ["agent:implement"] },
        ],
      });
      const [comment] = commentsOf(plan);
      expect(comment!.body).toContain(`The Implement run on #7 was a Broken run, and the Kit opened no PR: ${how}`);
      expect(comment!.body).toContain("A Broken run is an Execution flaw: retry 1 of 2 starts now.");
      expect(comment!.body).toContain(`> ${report.detail}`);
      expect(comment!.body).not.toContain("doesn't count against the Ticket's retries");
      expect(comment!.body).not.toContain("implement-run-failed");
      expect(notificationsOf(plan)).toEqual([]);
    });

    it("mentions nobody, even when the agent job's detail quotes a handle", () => {
      const plan = planFor(failed({ role: "implement", report: { failure: "missing-output", detail: "fix is required, @someone" } }), snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"] })), kitConfig());

      expect(commentsOf(plan)[0]!.body).not.toMatch(/(^|\s)@someone\b/);
    });

    it("points to the commits it kept, which the Retry doesn't start from", () => {
      const commits = { base: "a".repeat(40), continued: false, head: "b".repeat(40), kept: true };
      const plan = planFor(failed({ role: "implement", report: { failure: "left-branch", detail: "", commits } }), snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"] })), kitConfig());

      expect(commentsOf(plan)[0]!.body).toContain("they're kept for 7 days as `agent-branch.bundle` in the run's `fabrik-agent-failure` artifact.");
    });

    it("shares the pool with empty diffs: after one, a Broken run starts the second Retry, stepped up", () => {
      const plan = planFor(failed({ role: "implement", report: BROKEN[0][1] }), snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"], landedNothing: 1 })), kitConfig());

      expect(commentsOf(plan)[0]!.body).toContain("retry 2 of 2 starts now, stepped up.");
      expect(plan).toMatchObject({ actions: expect.arrayContaining([{ kind: "add-labels", issue: 7, labels: ["agent:implement"] }]) });
    });

    it("after both Retries are used, sends the Ticket back to design", () => {
      const plan = planFor(failed({ role: "implement", report: BROKEN[1][1] }), snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"], landedNothing: 2 })), kitConfig());

      expect(plan).toMatchObject({
        kind: "act",
        actions: expect.arrayContaining([
          { kind: "remove-label", issue: 7, label: "ready-for-agent" },
          { kind: "add-labels", issue: 7, labels: ["needs-design"] },
        ]),
      });
      expect(commentsOf(plan)[0]!.body).toMatch(/^<!-- fabrik:broken-run -->\n.*goes back to design/);
      expect(plan).not.toMatchObject({ actions: expect.arrayContaining([{ kind: "add-labels", issue: 7, labels: ["agent:implement"] }]) });
    });

    it("takes a stale agent:implement off first, so the Retry's label is a fresh event", () => {
      const plan = planFor(failed({ role: "implement", report: BROKEN[0][1] }), snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent", "agent:implement"] })), kitConfig());

      expect(plan).toMatchObject({ actions: [{ kind: "remove-label", issue: 7, label: "agent:implement" }, { kind: "comment" }, { kind: "add-labels", labels: ["agent:implement"] }] });
    });
  });

  describe("on a Retry", () => {
    const flaw = { verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: HEAD_SHA } as const;
    const onRetry = (pullRequest: Partial<PullRequestSnapshot>, report: FailureReport = BROKEN[1][1]) =>
      planFor(
        failed({ role: "implement", report }),
        snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"], openPullRequests: [50] }), {
          pullRequest: aPullRequest({ number: 50, ticket: 7, ticketLabels: ["ready-for-agent"], verdicts: [flaw], ...pullRequest }),
        }),
        kitConfig(),
      );

    it("posts an Execution flaw Verdict from the Broken run on the PR, mentioning nobody, and starts the next Retry", () => {
      const plan = onRetry({});

      const verdicts = verdictsPostedIn(commentsOf(plan).map((comment) => comment.body));
      expect(verdicts).toEqual([{ verdict: "execution-flaw", source: "broken-run", requestChanges: false, headSha: HEAD_SHA }]);
      const [comment] = commentsOf(plan);
      expect(comment!.issue).toBe(50);
      expect(comment!.body).toContain("From a Broken run, on aaaaaaa.");
      expect(comment!.body).toContain("The Implementer's retry on #50 was a Broken run: the Implementer left its branch");
      expect(comment!.body).toContain("> The agent left agent/7 for main");
      expect(comment!.body).toContain("Retry 2 of 2 starts now, stepped up");
      expect(comment!.body).not.toContain("implement-run-failed");
      expect(plan).toMatchObject({ actions: expect.arrayContaining([{ kind: "add-labels", issue: 7, labels: ["agent:implement"] }]) });
      expect(notificationsOf(plan)).toEqual([]);
    });

    it("counts toward the two: on the second Retry, it sends the Ticket back to design", () => {
      const plan = onRetry({ verdicts: [flaw, { ...flaw, source: "broken-run" }] });

      expect(plan).toMatchObject({ actions: expect.arrayContaining([{ kind: "add-labels", issue: 7, labels: ["needs-design"] }]) });
      expect(plan).not.toMatchObject({ actions: expect.arrayContaining([{ kind: "add-labels", issue: 7, labels: ["agent:implement"] }]) });
    });
  });

  describe("on a run that uses no retry", () => {
    it("of a Request-changes run, posts the notice as before, naming it a Broken run, and waits for agent:implement", () => {
      const plan = planFor(
        failed({ role: "implement", report: BROKEN[0][1] }),
        snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"], openPullRequests: [50] }), {
          pullRequest: aPullRequest({ number: 50, ticket: 7, requestChangesRunInFlight: 9001 }),
        }),
        kitConfig(),
      );

      expect(plan).toEqual({
        kind: "act",
        actions: [
          { kind: "remove-label", issue: 7, label: "agent:implement" },
          { kind: "comment", issue: 50, body: expect.stringMatching(/^<!-- fabrik:implement-run-failed -->\n@operator The Implement run on #7 failed: the Implementer gave no valid output\./) },
        ],
      });
      const body = commentsOf(plan)[0]!.body;
      expect(body).toContain("This is a Broken run on a Request-changes run, which uses no retry, so the Loop won't run it again. Re-add `agent:implement` on the Ticket (#7) to run it again.");
      expect(body).not.toContain("Infrastructure failure");
    });

    it("of a conflict-only run, hands the PR to the Operator as before, naming it a Broken run", () => {
      const plan = planFor(
        failed({ role: "implement", report: BROKEN[2][1], conflict: { pullRequest: 50, main: "d".repeat(40) } }),
        snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"], openPullRequests: [50] })),
        kitConfig(),
      );

      const body = commentsOf(plan)[0]!.body;
      expect(body).toContain(`it was a Broken run: the Implementer built on commits its branch didn't start from, so the push job couldn't rebuild it (${BROKEN[2][1].detail})`);
      expect(body).not.toContain("Infrastructure failure");
      expect(plan).not.toMatchObject({ actions: expect.arrayContaining([{ kind: "add-labels", issue: 7, labels: ["agent:implement"] }]) });
    });
  });

  it("is never a Review's missing Verdict, nor a broken prototype turn, which stay Infrastructure failures", () => {
    const review = planFor(failed({ role: "review", report: BROKEN[0][1] }), snapshotOf(anIssue({ number: 7, openPullRequests: [12] })), kitConfig());
    const prototype = planFor(failed({ role: "design", prototype: true, report: BROKEN[1][1] }), snapshotOf(anIssue({ number: 7, labels: ["needs-design"] })), kitConfig());

    expect(commentsOf(review)[0]!.body).toContain("This is an Infrastructure failure");
    expect(commentsOf(prototype)[0]!.body).toContain("This is an Infrastructure failure");
  });

  it("is never a timeout, a real crash or a provider error", () => {
    for (const report of [null, { failure: "crash", detail: "" }, { failure: "provider-error", detail: "" }] as const) {
      const plan = planFor(failed({ role: "implement", report }), snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"] })), kitConfig());
      expect(commentsOf(plan)[0]!.body).toMatch(/^<!-- fabrik:implement-run-failed -->/);
    }
  });
});
