import { describe, expect, it } from "vitest";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { BARE_SESSION_ENVIRONMENT, sessionEnvironmentOf } from "./operatorSession.ts";

describe("The Session environment a repo's Operator sessions open in", () => {
  it("is the bare one, operator-sessions, which holds no credential", () => {
    expect(BARE_SESSION_ENVIRONMENT).toBe("operator-sessions");
  });

  it("is the one a Kit config names in console.session_environment", () => {
    const config = { ...DEFAULT_KIT_CONFIG, console: { ...DEFAULT_KIT_CONFIG.console, sessionEnvironment: "shop-sessions" } };

    expect(sessionEnvironmentOf(config)).toBe("shop-sessions");
  });

  it("is the bare one for a Kit config that names none", () => {
    expect(sessionEnvironmentOf(DEFAULT_KIT_CONFIG)).toBe("operator-sessions");
  });

  it("is the bare one for null: a Kit config not read, invalid, or not there", () => {
    expect(sessionEnvironmentOf(null)).toBe("operator-sessions");
  });
});
