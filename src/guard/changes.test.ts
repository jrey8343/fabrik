import { describe, expect, it } from "vitest";
import { parseNameStatus } from "./changes.ts";

const z = (...tokens: string[]) => `${tokens.join("\0")}\0`;

describe("Reading the paths an agent branch changes", () => {
  it("reads added, modified and deleted paths", () => {
    expect(parseNameStatus(z("A", "src/new.ts", "M", "src/old.ts", "D", "src/gone.ts"))).toEqual([
      { path: "src/new.ts" },
      { path: "src/old.ts" },
      { path: "src/gone.ts" },
    ]);
  });

  it("keeps where a renamed file came from, so moving a trust root away still counts", () => {
    expect(parseNameStatus(z("R100", "AGENTS.md", "docs/agents.md"))).toEqual([
      { path: "docs/agents.md", from: "AGENTS.md" },
    ]);
  });

  it("reads a copy as a change to its new path only", () => {
    expect(parseNameStatus(z("C075", "src/a.ts", "src/b.ts"))).toEqual([{ path: "src/b.ts" }]);
  });

  it("reads paths with spaces and newlines whole", () => {
    expect(parseNameStatus(z("M", "docs/a file.md", "A", "odd\nname.txt"))).toEqual([
      { path: "docs/a file.md" },
      { path: "odd\nname.txt" },
    ]);
  });

  it("reads several commits' worth, with blank separators between them", () => {
    expect(parseNameStatus(`${z("M", "a.ts")}\0${z("M", "b.ts")}`)).toEqual([{ path: "a.ts" }, { path: "b.ts" }]);
  });

  it("reads nothing as no changes", () => {
    expect(parseNameStatus("")).toEqual([]);
  });

  it("refuses output it can't read rather than guessing", () => {
    expect(() => parseNameStatus(z("M"))).toThrow();
    expect(() => parseNameStatus(z("not-a-status", "a.ts"))).toThrow();
  });
});
