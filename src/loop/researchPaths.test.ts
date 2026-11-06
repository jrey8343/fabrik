import { describe, expect, it } from "vitest";
import { findingsPathFor, researchBranchFor, researchOfBranch, researchSlugFor } from "./researchPaths.ts";

const decision = { number: 42, title: "Which payment provider takes group bookings?" };

describe("A research Decision's slug, branch and findings file", () => {
  it("are named by the Decision's number, then its title's slug", () => {
    expect(researchSlugFor(decision)).toBe("42-which-payment-provider-takes-group-bookings");
    expect(researchBranchFor(decision)).toBe("research/42-which-payment-provider-takes-group-bookings");
    expect(findingsPathFor(decision)).toBe("docs/research/42-which-payment-provider-takes-group-bookings.md");
  });

  it("cut a long title short at a word, so neither the branch nor the file name grows with the title", () => {
    const long = { number: 42, title: "How do the biggest booking platforms handle recurring group classes, waitlists and refunds?" };

    expect(researchBranchFor(long)).toBe("research/42-how-do-the-biggest-booking-platforms-handle");
    expect(findingsPathFor(long)).toBe("docs/research/42-how-do-the-biggest-booking-platforms-handle.md");
  });

  it("cut a title of one long word at the limit", () => {
    expect(researchSlugFor({ number: 7, title: "a".repeat(80) })).toBe(`7-${"a".repeat(50)}`);
  });

  it("are named by the number alone when the title has no letter or digit to slug", () => {
    expect(researchBranchFor({ number: 42, title: "予約" })).toBe("research/42");
    expect(findingsPathFor({ number: 42, title: "予約" })).toBe("docs/research/42.md");
  });

  it("are read back from the branch, so the findings file is the one the run was given even if the title changed since", () => {
    expect(researchOfBranch(researchBranchFor(decision))).toEqual({ decision: 42, findingsPath: findingsPathFor(decision) });
    expect(researchOfBranch("research/42")).toEqual({ decision: 42, findingsPath: "docs/research/42.md" });
  });

  it.each([
    ["an agent branch", "fabrik/ticket-42"],
    ["a research branch with no Decision number", "research/which-provider"],
    ["a number with a leading zero", "research/042-which-provider"],
    ["upper case", "research/42-Which-Provider"],
    ["a path in the slug", "research/42-x/../../.fabrik/config"],
    ["a trailing dash", "research/42-which-"],
    ["nothing after the prefix", "research/"],
  ])("are not read from %s, which no Decision's slug makes", (_, branch) => {
    expect(researchOfBranch(branch)).toBeNull();
  });
});
