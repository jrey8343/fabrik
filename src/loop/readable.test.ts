import { describe, expect, it } from "vitest";
import { isTimeZone, knownTimeZone, readable } from "./readable.ts";

describe("readable", () => {
  it("writes a time in UTC when the Operator has given no zone", () => {
    expect(readable("2026-11-08T21:20:00Z", null)).toBe("2026-11-08 21:20 UTC");
    expect(readable(Date.parse("2026-11-08T21:20:00Z"), null)).toBe("2026-11-08 21:20 UTC");
  });

  it("writes a time on the wall clock in the Operator's zone, naming it (#481)", () => {
    // AEDT, UTC+11: past midnight, so the next day.
    expect(readable("2026-11-08T21:20:00Z", "Australia/Sydney")).toBe("2026-11-09 08:20 Australia/Sydney");
    expect(readable("2026-11-08T13:00:00Z", "Australia/Sydney")).toBe("2026-11-09 00:00 Australia/Sydney");
    expect(readable("2026-07-01T12:00:00Z", "Europe/London")).toBe("2026-07-01 13:00 Europe/London");
  });
});

describe("isTimeZone", () => {
  it("takes an IANA zone the runtime knows, and nothing else", () => {
    expect(["Australia/Sydney", "Europe/London", "UTC", "America/Argentina/Buenos_Aires"].every(isTimeZone)).toBe(true);
    expect(["Mars/Olympus_Mons", "sydney time", "", "+11:00"].some(isTimeZone)).toBe(false);
  });
});

describe("knownTimeZone", () => {
  it("gives a setting's zone when the runtime knows it, else null, for UTC", () => {
    expect(knownTimeZone("Australia/Sydney")).toBe("Australia/Sydney");
    expect([undefined, null, "", "Mars/Olympus_Mons", 10].map(knownTimeZone)).toEqual([null, null, null, null, null]);
  });
});
