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
