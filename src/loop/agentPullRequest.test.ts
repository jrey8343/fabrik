import { describe, expect, it } from "vitest";
import { agentBranchFor, isAgentPullRequest, ticketOfAgentBranch } from "./agentPullRequest.ts";

describe("An agent PR", () => {
  it("is on the Ticket's agent branch", () => {
    expect(agentBranchFor(12)).toBe("fabrik/ticket-12");
  });

  it("is a PR a bot opened from an agent branch", () => {
    expect(isAgentPullRequest({ headRef: "fabrik/ticket-12", authorIsBot: true })).toBe(true);
  });

  it("is not a PR a person opened, even from an agent branch", () => {
    expect(isAgentPullRequest({ headRef: "fabrik/ticket-12", authorIsBot: false })).toBe(false);
  });

  it.each([
    "dependabot/npm_and_yarn/vitest-5.0.6",
    "fabrik-ticket-12",
    "feature/fabrik/ticket-12",
    // A Product repo's weekly skills bump: only the Operator merges it, and the Loop never reviews, retries or dispatches it.
    "fabrik/skills-bump/jrey8343-skills",
  ])(
    "is not a bot's PR from %s",
    (headRef) => {
      expect(isAgentPullRequest({ headRef, authorIsBot: true })).toBe(false);
    },
  );
});

describe("An agent PR's Ticket", () => {
  it("is read from its agent branch", () => {
    expect(ticketOfAgentBranch("fabrik/ticket-12")).toBe(12);
  });

  it.each(["fabrik/ticket-", "fabrik/ticket-12x", "fabrik/ticket-0", "main"])("isn't read from %s", (headRef) => {
    expect(ticketOfAgentBranch(headRef)).toBeNull();
  });
});
