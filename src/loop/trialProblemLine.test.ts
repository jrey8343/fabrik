import { describe, expect, it } from "vitest";
import { fromPullRequestIn, trialProblemIn, trialProblemLine } from "./markers.ts";

describe("the line a Trial problem's body carries (#856)", () => {
  it("names the pull request it was found on where a person reads it, so GitHub cross-references the issue to that pull request", () => {
    expect(trialProblemLine(50)).toBe("From Staging trial of PR #50");
  });

  it("reads back as the pull request the writer wrote it for, from a body that ends with it", () => {
    for (const pullRequest of [1, 50, 1234]) {
      const body = ["The total reads 0 on the cart page.", "", "Seen on staging after adding two items.", "", trialProblemLine(pullRequest)].join("\n");

      expect(trialProblemIn(body)).toBe(pullRequest);
    }
  });

  it("reads back from a line the Operator indented, or one GitHub ended with a carriage return", () => {
    expect(trialProblemIn(`The total is wrong.\r\n\r\n  ${trialProblemLine(50)}\r\n`)).toBe(50);
  });

  it("reads a body without the line as no Trial problem: one that only mentions the pull request, a Follow-up's, or the line quoted as code", () => {
    expect(trialProblemIn("")).toBeNull();
    expect(trialProblemIn("The total is wrong since #50 merged.")).toBeNull();
    expect(trialProblemIn("Work it out once.\n\nFrom PR #50")).toBeNull();
    expect(trialProblemIn(`It said ${trialProblemLine(50)} somewhere in a sentence.`)).toBeNull();
    expect(trialProblemIn(["The Console wrote:", "", "```", trialProblemLine(50), "```"].join("\n"))).toBeNull();
  });

  it("is not a Follow-up's line: an issue that carries it is no Follow-up of that pull request", () => {
    expect(fromPullRequestIn(`The total is wrong.\n\n${trialProblemLine(50)}`)).toBeNull();
  });
});
