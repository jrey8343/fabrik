import { describe, expect, it } from "vitest";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { sandboxEnv, secretsTemplate } from "./secrets.ts";

const withSandbox = (sandbox: Partial<typeof DEFAULT_KIT_CONFIG.sandbox>) =>
  kitConfig({ sandbox: { ...DEFAULT_KIT_CONFIG.sandbox, ...sandbox } });

describe("Test secrets", () => {
  it("lists every test secret's op:// reference for 1Password to resolve, and nothing else", () => {
    const config = withSandbox({
      env: { PORT: "3000" },
      secrets: { STRIPE_TEST_KEY: "op://Fabrik Sandbox/Stripe/test-key", NOOKAL_KEY: "op://Fabrik Sandbox/Nookal/key" },
    });

    expect(secretsTemplate(config)).toBe(
      "STRIPE_TEST_KEY=op://Fabrik Sandbox/Stripe/test-key\nNOOKAL_KEY=op://Fabrik Sandbox/Nookal/key\n",
    );
  });

  it("lists nothing when the Product has no test secrets", () => {
    expect(secretsTemplate(kitConfig())).toBe("");
  });

  it("gives the agent the Claude token, the Sandbox values and each resolved test secret", () => {
    const config = withSandbox({ env: { PORT: "3000" }, secrets: { STRIPE_TEST_KEY: "op://v/Stripe/test-key" } });
    const resolved = JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-1", STRIPE_TEST_KEY: "sk_test_1", EXTRA: "x" });

    expect(sandboxEnv(config, resolved)).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-1",
      PORT: "3000",
      STRIPE_TEST_KEY: "sk_test_1",
    });
  });

  it("fails closed when 1Password didn't resolve a declared test secret", () => {
    const config = withSandbox({ secrets: { STRIPE_TEST_KEY: "op://v/Stripe/test-key" } });

    expect(() => sandboxEnv(config, JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: "t" }))).toThrow(/STRIPE_TEST_KEY/);
  });

  it("fails closed without the Claude token", () => {
    expect(() => sandboxEnv(kitConfig(), "{}")).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });
});
