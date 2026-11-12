// The record of the recovery waits and the Stuck bar built from it (#603).
import { describe, expect, it } from "vitest";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import type { KitConfig } from "./types.ts";
import { recoveryWaits, stuckBarMinutes } from "./recoveryWaits.ts";

/** A Kit config with one role's timeout changed. */
function withTimeout(role: "implement" | "review", timeoutMinutes: number): KitConfig {
  const config = kitConfig();
  return kitConfig({ roles: { ...config.roles, [role]: { ...config.roles[role], timeoutMinutes } } });
}

describe("the record of recovery waits", () => {
  it("on default timeouts waits 30 for the stuck-trigger sweep, the Implement job's 90 for an unstarted Retry and an undelivered Request changes, and 60 for an unreviewed draft", () => {
    expect(recoveryWaits(kitConfig())).toEqual({
      stuckTrigger: 30,
      unstartedRetry: 90,
      undeliveredRequestChanges: 90,
      unreviewedDraft: 60,
    });
  });

  it("follows the Implement role's timeout for the two checks that wait out the Implement job, and the Review role's for the unreviewed draft", () => {
    expect(recoveryWaits(withTimeout("implement", 120))).toEqual({
      stuckTrigger: 30,
      unstartedRetry: 150,
      undeliveredRequestChanges: 150,
      unreviewedDraft: 60,
    });
    expect(recoveryWaits(withTimeout("review", 120))).toEqual({
      stuckTrigger: 30,
      unstartedRetry: 90,
      undeliveredRequestChanges: 90,
      unreviewedDraft: 240,
    });
  });
});

describe("the Stuck bar", () => {
  it("is 210 minutes on default timeouts: the slowest recovery's 90 plus two hourly Ticks", () => {
    expect(stuckBarMinutes(kitConfig())).toBe(210);
  });

  it("is 270 minutes with the Implement role's timeout at 120, and 360 with the Review role's at 120", () => {
    expect(stuckBarMinutes(withTimeout("implement", 120))).toBe(270);
    expect(stuckBarMinutes(withTimeout("review", 120))).toBe(360);
  });

  it.each([
    ["default timeouts", kitConfig()],
    ["a 120-minute Implement timeout", withTimeout("implement", 120)],
    ["a 120-minute Review timeout", withTimeout("review", 120)],
    ["a 5-minute Implement timeout", withTimeout("implement", 5)],
  ])("on %s, is at least every recovery's wait plus two hourly Ticks, so a recovery added to the record is counted", (_, config) => {
    const bar = stuckBarMinutes(config);
    for (const [recovery, wait] of Object.entries(recoveryWaits(config))) {
      expect(bar, recovery).toBeGreaterThanOrEqual(wait + 120);
    }
  });
});
