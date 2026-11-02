import { describe, expect, it } from "vitest";
import { resolveKitConfig } from "./config.ts";

const DEFAULTS = {
  sandbox: { setup: null, build: null, test: null, checks: [], env: {}, secrets: {} },
  roles: {
    triage: { model: "claude-opus-5-5", effort: null, timeoutMinutes: 10 },
    design: { model: "claude-opus-5-5", effort: null, timeoutMinutes: 30 },
    implement: { model: "claude-sonnet-5-5", effort: null, timeoutMinutes: 60 },
    review: { model: "claude-opus-5-5", effort: null, timeoutMinutes: 30 },
    dispatch: { timeoutMinutes: 10 },
    stepUp: { model: "claude-opus-5-5", effort: null },
  },
  maxInFlight: 2,
  operator: null,
  instructions: { triage: null, design: null, implement: null, review: null },
};

describe("Kit config", () => {
  it("resolves a missing config to every v1 default", () => {
    expect(resolveKitConfig({ config: null })).toEqual({ ok: true, config: DEFAULTS });
  });

  it.each(["", "  \n", "{}"])("resolves an empty config file (%j) to every v1 default", (text) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: true, config: DEFAULTS });
  });

  it("honours an override of one role's model and keeps every other default", () => {
    const result = resolveKitConfig({ config: `{ "roles": { "implement": { "model": "claude-opus-5-5" } } }` });

    expect(result).toEqual({
      ok: true,
      config: {
        ...DEFAULTS,
        roles: { ...DEFAULTS.roles, implement: { model: "claude-opus-5-5", effort: null, timeoutMinutes: 60 } },
      },
    });
  });

  it.each([
    ["triage", "triage"],
    ["design", "design"],
    ["implement", "implement"],
    ["review", "review"],
  ] as const)("honours overrides of the %s role's model, effort and timeout", (key, role) => {
    const result = resolveKitConfig({
      config: JSON.stringify({
        roles: { [key]: { model: "claude-haiku-5-5", effort: "high", timeout_minutes: 5 } },
      }),
    });

    expect(result.ok && result.config.roles[role]).toEqual({
      model: "claude-haiku-5-5",
      effort: "high",
      timeoutMinutes: 5,
    });
  });

  it("honours an override of the Step-up model and effort", () => {
    const result = resolveKitConfig({
      config: `{ "roles": { "step_up": { "model": "claude-sonnet-5-5", "effort": "max" } } }`,
    });

    expect(result.ok && result.config.roles.stepUp).toEqual({ model: "claude-sonnet-5-5", effort: "max" });
  });

  it("honours an override of the Dispatch timeout", () => {
    const result = resolveKitConfig({ config: `{ "roles": { "dispatch": { "timeout_minutes": 3 } } }` });

    expect(result.ok && result.config.roles.dispatch).toEqual({ timeoutMinutes: 3 });
  });

  it.each(["triage", "design", "implement", "review", "step_up"])(
    "refuses fable as the %s model, because it can bill metered usage",
    (role) => {
      const result = resolveKitConfig({ config: JSON.stringify({ roles: { [role]: { model: "fable" } } }) });

      expect(result).toEqual({
        ok: false,
        errors: [
          `roles.${role}.model is "fable": Fable can bill metered usage, so the Kit never runs it in an AFK role`,
        ],
      });
    },
  );

  it.each(["Fable", "claude-fable-5", "best"])("refuses %j as a model too, because it is or can resolve to Fable", (model) => {
    const result = resolveKitConfig({ config: JSON.stringify({ roles: { review: { model } } }) });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors[0]).toContain("roles.review.model");
  });

  it.each([
    [`{ "max_in_fligt": 3 }`, "max_in_fligt is not a Kit config field"],
    [`{ "roles": { "implementer": {} } }`, "roles.implementer is not a Kit config field"],
    [`{ "roles": { "review": { "timeout": 5 } } }`, "roles.review.timeout is not a Kit config field"],
    [`{ "roles": { "dispatch": { "model": "claude-opus-5-5" } } }`, "roles.dispatch.model is not a Kit config field"],
  ])("fails an unknown field, naming it: %s", (text, error) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
  });

  it.each([
    [`{ "max_in_flight": "2" }`, "max_in_flight must be a whole number of at least 1"],
    [`{ "max_in_flight": 0 }`, "max_in_flight must be a whole number of at least 1"],
    [`{ "roles": { "triage": { "timeout_minutes": 2.5 } } }`, "roles.triage.timeout_minutes must be a whole number of at least 1"],
    [`{ "roles": { "implement": { "model": 5 } } }`, "roles.implement.model must be a string"],
    [`{ "roles": [] }`, "roles must be an object"],
    [`{ "roles": { "review": { "effort": "extreme" } } }`, `roles.review.effort is "extreme": effort must be one of low, medium, high, xhigh, max`],
    [`[]`, ".fabrik/config.json must be an object"],
  ])("fails a mistyped field, naming it: %s", (text, error) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
  });

  it("fails a config that isn't JSON, naming the file", () => {
    const result = resolveKitConfig({ config: "max_in_flight: 2" });

    expect(!result.ok && result.errors[0]).toMatch(/^\.fabrik\/config\.json is not valid JSON/);
  });

  it("reports every problem at once", () => {
    const result = resolveKitConfig({ config: `{ "max_in_flight": 0, "colour": "red" }` });

    expect(!result.ok && result.errors).toEqual([
      "max_in_flight must be a whole number of at least 1",
      "colour is not a Kit config field",
    ]);
  });

  it("reads the Sandbox commands, gating checks, values and test secrets", () => {
    const result = resolveKitConfig({
      config: JSON.stringify({
        sandbox: {
          setup: "nohup ./stub-stripe >/dev/null 2>&1 &",
          build: "npm run build",
          test: "npm test",
          checks: ["build", "test"],
          env: { NODE_ENV: "test" },
          secrets: { STRIPE_TEST_KEY: "op://Pilot Test/Stripe/test-key" },
        },
      }),
    });

    expect(result.ok && result.config.sandbox).toEqual({
      setup: "nohup ./stub-stripe >/dev/null 2>&1 &",
      build: "npm run build",
      test: "npm test",
      checks: ["build", "test"],
      env: { NODE_ENV: "test" },
      secrets: { STRIPE_TEST_KEY: "op://Pilot Test/Stripe/test-key" },
    });
  });

  it.each([
    [
      { secrets: { STRIPE_TEST_KEY: "sk_test_123" } },
      `sandbox.secrets.STRIPE_TEST_KEY is "sk_test_123": a test secret must be an op:// reference, never the secret itself`,
    ],
    [{ secrets: { "not a name": "op://v/i/f" } }, "sandbox.secrets.not a name is not a valid environment variable name"],
    [
      { secrets: { CLAUDE_CODE_OAUTH_TOKEN: "op://v/i/f" } },
      "sandbox.secrets.CLAUDE_CODE_OAUTH_TOKEN is reserved for the Kit, so the Sandbox can't set it",
    ],
    [
      { env: { ANTHROPIC_BASE_URL: "https://proxy.example" } },
      "sandbox.env.ANTHROPIC_BASE_URL is reserved for the Kit, so the Sandbox can't set it",
    ],
    [
      { secrets: { OP_SERVICE_ACCOUNT_TOKEN: "op://v/i/f" } },
      "sandbox.secrets.OP_SERVICE_ACCOUNT_TOKEN is reserved for the Kit, so the Sandbox can't set it",
    ],
    [{ env: { GITHUB_TOKEN: "x" } }, "sandbox.env.GITHUB_TOKEN is reserved for the Kit, so the Sandbox can't set it"],
    [{ env: { PORT: 3000 } }, "sandbox.env.PORT must be a string"],
    [{ checks: "build" }, "sandbox.checks must be a list of strings"],
    [{ checks: ["build", 7] }, "sandbox.checks must be a list of strings"],
    [{ build: ["npm", "run", "build"] }, "sandbox.build must be a string"],
    [{ tests: "npm test" }, "sandbox.tests is not a Kit config field"],
  ])("fails a bad Sandbox field, naming it: %j", (sandbox, error) => {
    expect(resolveKitConfig({ config: JSON.stringify({ sandbox }) })).toEqual({ ok: false, errors: [error] });
  });

  it("carries the per-phase instruction files that are present, and null for the rest", () => {
    const result = resolveKitConfig({
      config: null,
      instructions: { implement: "Use the repo's money helpers.\n", review: "Check the booking flow.\n" },
    });

    expect(result.ok && result.config.instructions).toEqual({
      triage: null,
      design: null,
      implement: "Use the repo's money helpers.\n",
      review: "Check the booking flow.\n",
    });
  });

  it("treats a blank instruction file as absent", () => {
    const result = resolveKitConfig({ config: null, instructions: { triage: "  \n" } });

    expect(result.ok && result.config.instructions.triage).toBeNull();
  });

  it("accepts a starter config that spells out every default, nulls included", () => {
    const starter = {
      sandbox: { setup: null, build: null, test: null, checks: [], env: {}, secrets: {} },
      roles: {
        triage: { model: "claude-opus-5-5", effort: null, timeout_minutes: 10 },
        design: { model: "claude-opus-5-5", effort: null, timeout_minutes: 30 },
        implement: { model: "claude-sonnet-5-5", effort: null, timeout_minutes: 60 },
        review: { model: "claude-opus-5-5", effort: null, timeout_minutes: 30 },
        dispatch: { timeout_minutes: 10 },
        step_up: { model: "claude-opus-5-5", effort: null },
      },
      max_in_flight: 2,
      operator: null,
    };

    expect(resolveKitConfig({ config: JSON.stringify(starter) })).toEqual({ ok: true, config: DEFAULTS });
  });

  it("lets null reset an effort back to the CLI default", () => {
    const result = resolveKitConfig({ config: `{ "roles": { "step_up": { "effort": null } } }` });

    expect(result.ok && result.config.roles.stepUp.effort).toBeNull();
  });

  it.each([`{ "roles": { "review": { "model": null } } }`, `{ "max_in_flight": null }`])(
    "refuses null where a field has no empty value: %s",
    (text) => {
      expect(resolveKitConfig({ config: text }).ok).toBe(false);
    },
  );

  it("honours an override of max_in_flight", () => {
    const result = resolveKitConfig({ config: `{ "max_in_flight": 4 }` });

    expect(result.ok && result.config.maxInFlight).toBe(4);
  });

  it("names the Operator when the config gives a login, leaving null to mean the repo's owner", () => {
    const result = resolveKitConfig({ config: `{ "operator": "jrey8343" }` });

    expect(result.ok && result.config.operator).toBe("jrey8343");
  });

  it.each([`{ "operator": "@jrey8343" }`, `{ "operator": "two words" }`, `{ "operator": "" }`])(
    "refuses an Operator that isn't a GitHub login: %s",
    (text) => {
      expect(resolveKitConfig({ config: text })).toMatchObject({
        ok: false,
        errors: [expect.stringMatching(/^operator is .*: the Operator must be a GitHub login/)],
      });
    },
  );
});
