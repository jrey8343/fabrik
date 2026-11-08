import { describe, expect, it } from "vitest";
import { readTriageOutput } from "./triageOutput.ts";

const wontfix = { category: "bug", state: "wontfix", comment: "Already reported.", brief: null };

describe("Triage's duplicateOf", () => {
  it("names the original on a wontfix", () => {
    expect(readTriageOutput({ ...wontfix, duplicateOf: 12 }, 7)).toEqual({
      ok: true,
      output: { ...wontfix, duplicateOf: 12 },
    });
  });

  it.each([[{}], [{ duplicateOf: null }]])("is null when Triage leaves it out or sets it to null", (extra) => {
    expect(readTriageOutput({ ...wontfix, ...extra }, 7)).toEqual({ ok: true, output: { ...wontfix, duplicateOf: null } });
  });

  it.each(["needs-design", "needs-info", "ready-for-human"])("is refused on %s, which closes nothing", (state) => {
    expect(readTriageOutput({ ...wontfix, state, duplicateOf: 12 }, 7)).toEqual({
      ok: false,
      errors: ["only a wontfix names an original in duplicateOf"],
    });
  });

  it.each([0, -3, 1.5, "12"])("is refused when it isn't a positive whole issue number: %j", (duplicateOf) => {
    expect(readTriageOutput({ ...wontfix, duplicateOf }, 7)).toEqual({
      ok: false,
      errors: [`duplicateOf must be a positive issue number, not ${JSON.stringify(duplicateOf)}`],
    });
  });

  it("is refused when it names the issue being triaged", () => {
    expect(readTriageOutput({ ...wontfix, duplicateOf: 7 }, 7)).toEqual({
      ok: false,
      errors: ["duplicateOf can't name #7, the issue being triaged"],
    });
  });
});
