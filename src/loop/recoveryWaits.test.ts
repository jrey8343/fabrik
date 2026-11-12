// The record of the recovery waits and the Stuck bar built from it (#603).
import { describe, expect, it } from "vitest";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import type { KitConfig } from "./types.ts";
import { recoveryWaits } from "./recoveryWaits.ts";

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
