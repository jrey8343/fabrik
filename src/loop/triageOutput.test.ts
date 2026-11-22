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

// A Spin-off exists because the Operator asked for it (#883), so Triage sets it aside only as a duplicate of a named issue.
describe("Triage's wontfix on a Spin-off", () => {
  it("is refused with no duplicateOf", () => {
    expect(readTriageOutput(wontfix, 7, true)).toEqual({
      ok: false,
      errors: ["a wontfix on a Spin-off needs duplicateOf: the Operator asked for this issue, so Triage sets it aside only as a duplicate of a named issue"],
    });
    expect(readTriageOutput({ ...wontfix, duplicateOf: null }, 7, true)).toMatchObject({ ok: false });
  });

  it("is accepted when it names the original", () => {
    expect(readTriageOutput({ ...wontfix, duplicateOf: 12 }, 7, true)).toEqual({ ok: true, output: { ...wontfix, duplicateOf: 12 } });
  });

  it("names a bad duplicateOf once, as on any issue", () => {
    expect(readTriageOutput({ ...wontfix, duplicateOf: 7 }, 7, true)).toEqual({
      ok: false,
      errors: ["duplicateOf can't name #7, the issue being triaged"],
    });
  });

  it.each(["needs-design", "needs-info", "ready-for-human"])("leaves %s on a Spin-off as on any issue", (state) => {
    expect(readTriageOutput({ ...wontfix, state }, 7, true)).toMatchObject({ ok: true, output: { state } });
  });

  it("leaves a wontfix on any other issue needing no duplicateOf", () => {
    expect(readTriageOutput(wontfix, 7)).toMatchObject({ ok: true, output: { duplicateOf: null } });
  });
});
