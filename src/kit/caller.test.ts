import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkCallerWorkflow } from "./caller.ts";

function callerWith(...uses: string[]): string {
  return [
    "name: Fabrik",
    "on:",
    "  issues:",
    "    types: [opened]",
    "jobs:",
    ...uses.flatMap((ref, i) => [`  job${i}:`, `    uses: ${ref}`]),
    "",
  ].join("\n");
}

describe("Caller workflow release check", () => {
  it("passes a caller whose uses: lines all pin the same exact release", () => {
    const text = callerWith(
      "jrey8343/fabrik/.github/workflows/loop.yml@v1.2.3",
      "jrey8343/fabrik/.github/workflows/review.yml@v1.2.3",
    );

    expect(checkCallerWorkflow(text)).toEqual({ ok: true, release: "v1.2.3" });
  });

  it("rejects a caller whose release refs disagree, naming each ref", () => {
    const text = callerWith(
      "jrey8343/fabrik/.github/workflows/loop.yml@v1.2.3",
      "jrey8343/fabrik/.github/workflows/review.yml@v1.3.0",
    );

    expect(checkCallerWorkflow(text)).toEqual({
      ok: false,
      error: "The caller workflow pins more than one Fabrik release (v1.2.3, v1.3.0); every uses: line must pin the same one",
    });
  });

  it.each(["main", "v1", "v1.2", "3d3c42e5aac5ba805825da76410c181273ba90b1"])(
    "rejects a ref that isn't an exact release: %s",
    (ref) => {
      const text = callerWith(`jrey8343/fabrik/.github/workflows/loop.yml@${ref}`);

      expect(checkCallerWorkflow(text)).toEqual({
        ok: false,
        error: `The caller workflow pins Fabrik at ${ref}, which isn't an exact release tag such as v1.2.3`,
      });
    },
  );

  it("rejects a caller that doesn't use Fabrik at all", () => {
    expect(checkCallerWorkflow(callerWith("someone/else/.github/workflows/x.yml@v1.0.0"))).toEqual({
      ok: false,
      error: "The caller workflow has no uses: line that pins a Fabrik release",
    });
  });

  it("reads quoted refs and ignores other actions and comments", () => {
    const text = [
      "# uses: jrey8343/fabrik/.github/workflows/loop.yml@v0.0.1",
      "jobs:",
      "  loop:",
      `    uses: "jrey8343/fabrik/.github/workflows/loop.yml@v2.0.0-pre.1" # pinned by Dependabot`,
      "  other:",
      "    steps:",
      "      - uses: actions/checkout@v7",
      "      - uses: 'jrey8343/fabrik/actions/fetch-skills@v2.0.0-pre.1'",
    ].join("\n");

    expect(checkCallerWorkflow(text)).toEqual({ ok: true, release: "v2.0.0-pre.1" });
  });

  it("passes the caller template the Kit ships", () => {
    const template = readFileSync(new URL("../../templates/fabrik.yml", import.meta.url), "utf8");

    expect(checkCallerWorkflow(template).ok).toBe(true);
  });
});
