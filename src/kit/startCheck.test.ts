import { describe, expect, it } from "vitest";
import { START_CHECK_MINUTES, startCheckName } from "./startCheck.ts";

describe("the Start check", () => {
  it("is named for a .yml workflow file", () => {
    expect(startCheckName("promote.yml")).toBe("Start promote.yml from the Console");
  });

  it("is named for a .yaml workflow file", () => {
    expect(startCheckName("dns-apply.yaml")).toBe("Start dns-apply.yaml from the Console");
  });

  it("holds for 15 minutes", () => {
    expect(START_CHECK_MINUTES).toBe(15);
  });
});
