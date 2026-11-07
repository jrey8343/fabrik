import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dependabotUpdate, scheduleIn, timeZoneIn } from "./shims.ts";

const template = readFileSync(new URL("../../templates/fabrik-runs-caller.yml", import.meta.url), "utf8");
const dependabotTemplate = readFileSync(new URL("../../templates/dependabot.yml", import.meta.url), "utf8");

describe("The Operator's time zone in the store's caller workflow", () => {
  it("is the one setup wrote into its schedule, which the Weekly summary weeks by", () => {
    expect(timeZoneIn(scheduleIn(template, "Australia/Sydney"))).toBe("Australia/Sydney");
  });

  it("is unknown for a caller whose schedule names none", () => {
    expect(timeZoneIn(template.replace(/^\s+timezone:.*\n/m, ""))).toBeNull();
  });
});

describe("A Dependabot config that already groups the Fabrik pins", () => {
  // The Product's own entry after the Fabrik one, so the file isn't setup's unchanged template.
  const productEntry = '  - package-ecosystem: npm\n    directory: "/"\n    schedule:\n      interval: weekly\n';
  const withPattern = (pattern: string) =>
    `${dependabotTemplate.replace('- "jrey8343/fabrik*"\n    # A', `- ${pattern}\n    # A`)}${productEntry}`;

  it.each([
    ["double quotes", '"jrey8343/fabrik*"'],
    ["single quotes", "'jrey8343/fabrik*'"],
    ["no quotes", "jrey8343/fabrik*"],
  ])("is left alone with no note when the pattern is in %s", (_style, pattern) => {
    const existing = withPattern(pattern);
    expect(existing).toContain(`patterns:\n          - ${pattern}\n`);

    expect(dependabotUpdate(existing, dependabotTemplate)).toBeNull();
  });

  it("still gets the note when its Fabrik entry has no fabrik group", () => {
    const ungrouped = dependabotTemplate.replace(/^ {4}# Each pinned Fabrik workflow[\s\S]*?- "jrey8343\/fabrik\*"\n/m, "");

    expect(dependabotUpdate(`${ungrouped}${productEntry}`, dependabotTemplate)).toEqual({
      note: expect.stringContaining("doesn't group the Fabrik pins"),
    });
  });
});
