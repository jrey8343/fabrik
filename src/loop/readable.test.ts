import { describe, expect, it } from "vitest";
import { readable } from "./readable.ts";

describe("readable", () => {
  it("writes a time in UTC unless told the Operator's zone", () => {
    expect(readable("2026-11-08T21:20:00Z")).toBe("2026-11-08 21:20 UTC");
    expect(readable(Date.parse("2026-11-08T21:20:00Z"))).toBe("2026-11-08 21:20 UTC");
  });

  it("writes a time on the wall clock in the Operator's zone, naming it (#481)", () => {
    // AEDT, UTC+11: past midnight, so the next day.
    expect(readable("2026-11-08T21:20:00Z", "Australia/Sydney")).toBe("2026-11-09 08:20 Australia/Sydney");
    expect(readable("2026-11-08T13:00:00Z", "Australia/Sydney")).toBe("2026-11-09 00:00 Australia/Sydney");
    expect(readable("2026-07-01T12:00:00Z", "Europe/London")).toBe("2026-07-01 13:00 Europe/London");
  });
});
