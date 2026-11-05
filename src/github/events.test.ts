import { describe, expect, it } from "vitest";
import { loopEventFrom } from "./events.ts";

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

  it("from a bot says so, for the Loop to ignore", () => {
    const payload = {
      action: "created",
      issue: { number: 50, pull_request: {} },
      comment: { id: 7002, user: user("fabrik[bot]", "Bot"), body: "Verdict: pass" },
    };

    expect(loopEventFrom("issue_comment", payload)).toMatchObject({ kind: "pull-request-commented", commenterIsBot: true });
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
    });
  });
});
