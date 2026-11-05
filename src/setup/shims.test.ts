import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scheduleIn, timeZoneIn } from "./shims.ts";

const template = readFileSync(new URL("../../templates/fabrik-runs-caller.yml", import.meta.url), "utf8");

describe("The Operator's time zone in the store's caller workflow", () => {
  it("is the one setup wrote into its schedule, which the Weekly summary weeks by", () => {
    expect(timeZoneIn(scheduleIn(template, "Australia/Sydney"))).toBe("Australia/Sydney");
  });

  it("is unknown for a caller whose schedule names none", () => {
    expect(timeZoneIn(template.replace(/^\s+timezone:.*\n/m, ""))).toBeNull();
  });
});
