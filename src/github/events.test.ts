import { describe, expect, it } from "vitest";
import { readAgentRunResult } from "../agent/result.ts";
import { agentFailureEventFrom, agentRunEventFrom, auditEventFrom, loopEventFrom } from "./events.ts";

describe("A push", () => {
  const push = (overrides: Record<string, unknown> = {}) => ({
    ref: "refs/heads/main",
    repository: { default_branch: "main" },
    commits: [{ added: [], modified: [".fabrik/config.json"], removed: [] }],
    ...overrides,
  });

  it("to the default branch that changes the Kit config is a Kit config change", () => {
    expect(loopEventFrom("push", push())).toEqual({ kind: "kit-config-changed" });
  });

  it.each([
    ["adds", { added: [".fabrik/config.json"], modified: [], removed: [] }],
    ["removes, restoring the defaults,", { added: [], modified: [], removed: [".fabrik/config.json"] }],
  ])("that %s the Kit config is a Kit config change too", (_, commit) => {
    expect(loopEventFrom("push", push({ commits: [commit] }))).toEqual({ kind: "kit-config-changed" });
  });

  it("to another branch isn't one, since only the default branch's Kit config is read", () => {
    expect(loopEventFrom("push", push({ ref: "refs/heads/tweak-config" }))).toBeNull();
  });

  it("that leaves the Kit config alone isn't one", () => {
    const commits = [{ added: [], modified: [".fabrik/implement.md"], removed: [] }];

    expect(loopEventFrom("push", push({ commits }))).toBeNull();
  });
});

describe("A comment on a pull request", () => {
  const user = (login: string, type = "User") => ({ login, type });

  it("in its conversation is a pull-request comment, naming the comment the reaction goes on", () => {
    const payload = {
      action: "created",
      issue: { number: 50, pull_request: { url: "https://api.github.com/repos/acme/shop/pulls/50" } },
      comment: { id: 7001, user: user("operator"), body: "The parking copy is right." },
    };

    expect(loopEventFrom("issue_comment", payload)).toEqual({
      kind: "pull-request-commented",
      pullRequest: 50,
      commenter: "operator",
      commenterIsBot: false,
      on: { kind: "conversation", comment: 7001 },
    });
  });

  it("from a bot, such as the Fabrik App's own Verdict, is no event", () => {
    const payload = {
      action: "created",
      issue: { number: 50, pull_request: {} },
      comment: { id: 7002, user: user("fabrik[bot]", "Bot"), body: "Verdict: pass" },
    };

    expect(loopEventFrom("issue_comment", payload)).toBeNull();
  });

  it("in a review a bot submitted is no event", () => {
    const payload = {
      action: "submitted",
      pull_request: { number: 50 },
      review: { id: 901, state: "commented", user: user("fabrik[bot]", "Bot"), body: "Noted." },
    };

    expect(loopEventFrom("pull_request_review", payload)).toBeNull();
  });

  it.each(["commented", "approved", "COMMENTED", "APPROVED"])(
    "in a submitted %s review is a pull-request comment, naming the review whose inline comments get the reaction",
    (state) => {
      const payload = {
        action: "submitted",
        pull_request: { number: 50 },
        review: { id: 900, state, user: user("operator"), body: "Looks good." },
      };

      expect(loopEventFrom("pull_request_review", payload)).toEqual({
        kind: "pull-request-commented",
        pullRequest: 50,
        commenter: "operator",
        commenterIsBot: false,
        on: { kind: "review", review: 900 },
      });
    },
  );

  it("in a review that requests changes is still Request changes", () => {
    const payload = {
      action: "submitted",
      pull_request: { number: 50 },
      review: { id: 900, state: "changes_requested", user: user("operator") },
    };

    expect(loopEventFrom("pull_request_review", payload)).toEqual({
      kind: "pull-request-changes-requested",
      pullRequest: 50,
      review: 900,
      reviewer: "operator",
      reviewerIsBot: false,
    });
  });
});

describe("A comment on an issue", () => {
  it("is still an issue comment", () => {
    const payload = {
      action: "created",
      issue: { number: 7 },
      comment: { id: 7003, user: { login: "operator", type: "User" }, body: "Yes, the second option." },
    };

    expect(loopEventFrom("issue_comment", payload)).toEqual({
      kind: "issue-comment-created",
      issue: 7,
      commenter: "operator",
      commenterIsBot: false,
      body: "Yes, the second option.",
      comment: 7003,
    });
  });
});

describe("A finished Design-session turn", () => {
  const result = { role: "design", issue: 7, output: "{}" } as const;

  it("names the Operator's reply that started it", () => {
    expect(agentRunEventFrom(result, null, null, 7003)).toEqual({
      kind: "agent-run-finished",
      role: "design",
      issue: 7,
      output: "{}",
      startedBy: 7003,
    });
  });

  it("names no reply when adding needs-design started it", () => {
    expect(agentRunEventFrom(result)).toEqual({ kind: "agent-run-finished", role: "design", issue: 7, output: "{}" });
  });
});

describe("A finished Audit run", () => {
  const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
  const REPO = "https://github.com/acme/shop";
  const artifact = (window: unknown) =>
    JSON.stringify({ role: "audit", issue: 97, output: '{"candidates":[],"topRecommendation":null}', ...(window === undefined ? {} : { window }) });

  it("carries the Auditor's output, unparsed, with the window its inputs gave it, this run and the Product repo its candidates open issues on", () => {
    const window = { kind: "since-audit", audit: 90, commit: "c".repeat(40) };

    expect(auditEventFrom(readAgentRunResult(artifact(window)), RUN, REPO)).toEqual({
      kind: "audit-run-finished",
      issue: 97,
      output: '{"candidates":[],"topRecommendation":null}',
      window,
      runUrl: RUN,
      repoUrl: "https://github.com/acme/shop",
    });
  });

  it("carries a window of the last 30 days", () => {
    expect(auditEventFrom(readAgentRunResult(artifact({ kind: "last-days", days: 30 })), RUN, REPO)).toMatchObject({
      window: { kind: "last-days", days: 30 },
    });
  });

  it("refuses an Auditor's result with no window", () => {
    expect(() => auditEventFrom(readAgentRunResult(artifact(undefined)), RUN, REPO)).toThrow(/window/);
  });

  it.each([
    ["names no kind", { audit: 90, commit: "c".repeat(40) }],
    ["names no Audit", { kind: "since-audit", commit: "c".repeat(40) }],
    ["names no commit", { kind: "since-audit", audit: 90, commit: "main" }],
    ["counts no days", { kind: "last-days", days: 0 }],
  ])("refuses a result whose window %s", (_, window) => {
    expect(() => readAgentRunResult(artifact(window))).toThrow(/window/);
  });

  it("isn't an agent-run-finished event", () => {
    expect(() => agentRunEventFrom(readAgentRunResult(artifact({ kind: "last-days", days: 30 })))).toThrow(/auditEventFrom/);
  });
});

describe("A failed agent run", () => {
  const job = {
    role: "triage" as const,
    issue: 7,
    runUrl: "https://github.com/acme/shop/actions/runs/42/attempts/1",
    jobResult: "failure",
    secretsStep: "success",
    report: { failure: "weekly-limit" as const, detail: "seven_day", resetsAt: "2026-11-09T04:00:00.000Z" },
  };

  it("carries the Subscription the run used", () => {
    expect(agentFailureEventFrom({ ...job, subscription: "Claude token 2" })).toEqual({
      kind: "agent-run-failed",
      role: "triage",
      issue: 7,
      runUrl: job.runUrl,
      jobResult: "failure",
      secretsStep: "success",
      report: job.report,
      subscription: "Claude token 2",
    });
  });

  it("names no Subscription when the Kit job passed none out", () => {
    expect(agentFailureEventFrom(job)).not.toHaveProperty("subscription");
  });
});
