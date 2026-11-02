import { describe, expect, it } from "vitest";
import { agentBranchFor, isAgentPullRequest } from "./agentPullRequest.ts";

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

  it.each(["dependabot/npm_and_yarn/vitest-5.0.6", "fabrik-ticket-12", "feature/fabrik/ticket-12"])(
    "is not a bot's PR from %s",
    (headRef) => {
      expect(isAgentPullRequest({ headRef, authorIsBot: true })).toBe(false);
    },
  );
});
