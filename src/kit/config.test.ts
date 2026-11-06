import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveKitConfig } from "./config.ts";

const root = new URL("../../", import.meta.url);
const template = readFileSync(new URL("templates/fabrik-config.json", root), "utf8");
const readme = readFileSync(new URL("README.md", root), "utf8");

const DEFAULTS = {
  sandbox: { setup: null, build: null, test: null, checks: [], env: {}, secrets: {} },
  roles: {
    triage: { model: "claude-opus-5-5", effort: null, timeoutMinutes: 10 },
    design: { model: "claude-opus-5-5", effort: null, timeoutMinutes: 30 },
    implement: { model: "claude-sonnet-5-5", effort: null, timeoutMinutes: 60 },
    review: { model: "claude-opus-5-5", effort: null, timeoutMinutes: 30 },
    audit: { model: "claude-opus-5-5", effort: null, timeoutMinutes: 45 },
    dispatch: { timeoutMinutes: 10 },
    stepUp: { model: "claude-opus-5-5", effort: null },
  },
  maxInFlight: 2,
  caps: { designSessions: 2, monitorIssues: 5 },
  monitor: { errors: null, redMain: true },
  audit: { day: "sunday" },
  operator: null,
  subscriptions: ["Claude token"],
  instructions: { triage: null, design: null, implement: null, review: null, audit: null },
  skillsSources: [],
  extraSkills: { triage: [], design: [], implement: [], review: [] },
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
    [`{ "caps": { "retro": 1 } }`, "caps.retro is not a Kit config field"],
    [`{ "caps": { "audit": 1 } }`, "caps.audit is not a Kit config field"],
  ])("fails an unknown field, naming it: %s", (text, error) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
  });

  it.each([
    [`{ "max_in_flight": "2" }`, "max_in_flight must be a whole number of at least 0"],
    [`{ "max_in_flight": -1 }`, "max_in_flight must be a whole number of at least 0"],
    [`{ "max_in_flight": 1.5 }`, "max_in_flight must be a whole number of at least 0"],
    [`{ "roles": { "dispatch": { "timeout_minutes": 0 } } }`, "roles.dispatch.timeout_minutes must be a whole number of at least 1"],
    [`{ "roles": { "triage": { "timeout_minutes": 2.5 } } }`, "roles.triage.timeout_minutes must be a whole number of at least 1"],
    [`{ "roles": { "implement": { "model": 5 } } }`, "roles.implement.model must be a string"],
    [`{ "roles": [] }`, "roles must be an object"],
    [`{ "caps": [] }`, "caps must be an object"],
    [`{ "caps": { "design_sessions": -1 } }`, "caps.design_sessions must be a whole number of at least 0"],
    [`{ "caps": { "design_sessions": 1.5 } }`, "caps.design_sessions must be a whole number of at least 0"],
    [`{ "caps": { "design_sessions": "1" } }`, "caps.design_sessions must be a whole number of at least 0"],
    [`{ "caps": { "design_sessions": null } }`, "caps.design_sessions must be a whole number of at least 0"],
    [`{ "caps": { "monitor_issues": -1 } }`, "caps.monitor_issues must be a whole number of at least 0"],
    [`{ "caps": { "monitor_issues": "2" } }`, "caps.monitor_issues must be a whole number of at least 0"],
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
    const result = resolveKitConfig({ config: `{ "max_in_flight": -1, "colour": "red" }` });

    expect(!result.ok && result.errors).toEqual([
      "max_in_flight must be a whole number of at least 0",
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
      audit: null,
    });
  });

  it("carries the Auditor's instructions from .fabrik/audit.md, though the Auditor picks no Extra skills", () => {
    const result = resolveKitConfig({ config: null, instructions: { audit: "Look at the booking module first.\n" } });

    expect(result.ok && result.config.instructions.audit).toBe("Look at the booking module first.\n");
    expect(result.ok && Object.keys(result.config.extraSkills)).toEqual(["triage", "design", "implement", "review"]);
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
        audit: { model: "claude-opus-5-5", effort: null, timeout_minutes: 45 },
        dispatch: { timeout_minutes: 10 },
        step_up: { model: "claude-opus-5-5", effort: null },
      },
      max_in_flight: 2,
      caps: { design_sessions: 2, monitor_issues: 5 },
      monitor: { errors: null, red_main: true },
      audit: { day: "sunday" },
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

  it("accepts a max_in_flight of 0, which pauses Dispatch", () => {
    const result = resolveKitConfig({ config: `{ "max_in_flight": 0 }` });

    expect(result.ok && result.config.maxInFlight).toBe(0);
  });

  it("gives a Product repo whose config never sets caps the Kit defaults: 2 Design sessions and 5 open Monitor error issues", () => {
    const result = resolveKitConfig({ config: `{ "max_in_flight": 1, "operator": "jrey8343" }` });

    expect(result.ok && result.config.caps).toEqual({ designSessions: 2, monitorIssues: 5 });
  });

  it.each([1, 0])("honours lowering caps.design_sessions to %i", (cap) => {
    const result = resolveKitConfig({ config: `{ "caps": { "design_sessions": ${cap} } }` });

    expect(result).toEqual({ ok: true, config: { ...DEFAULTS, caps: { ...DEFAULTS.caps, designSessions: cap } } });
  });

  it("keeps the Kit default when caps.design_sessions is set to it", () => {
    const result = resolveKitConfig({ config: `{ "caps": { "design_sessions": 2 } }` });

    expect(result).toEqual({ ok: true, config: DEFAULTS });
  });

  it.each([3, 99])("refuses raising caps.design_sessions to %i, naming the field, the value and the Kit default", (cap) => {
    const result = resolveKitConfig({ config: `{ "caps": { "design_sessions": ${cap} } }` });

    expect(result).toEqual({
      ok: false,
      errors: [`caps.design_sessions is ${cap}, but a cap can only be lowered: the Kit default is 2`],
    });
  });

  it.each([2, 0])("honours lowering caps.monitor_issues to %i, 0 pausing new error filings", (cap) => {
    const result = resolveKitConfig({ config: `{ "caps": { "monitor_issues": ${cap} } }` });

    expect(result).toEqual({ ok: true, config: { ...DEFAULTS, caps: { ...DEFAULTS.caps, monitorIssues: cap } } });
  });

  it.each([6, 99])("refuses raising caps.monitor_issues to %i, naming the field, the value and the Kit default", (cap) => {
    const result = resolveKitConfig({ config: `{ "caps": { "monitor_issues": ${cap} } }` });

    expect(result).toEqual({
      ok: false,
      errors: [`caps.monitor_issues is ${cap}, but a cap can only be lowered: the Kit default is 5`],
    });
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

describe("The monitor block", () => {
  it("leaves production errors off and red main on when the Kit config has no monitor block", () => {
    const result = resolveKitConfig({ config: `{ "max_in_flight": 1, "operator": "jrey8343" }` });

    expect(result.ok && result.config.monitor).toEqual({ errors: null, redMain: true });
  });

  it("reads the Sentry project, defaulting url to sentry.io and min_events to 3", () => {
    const result = resolveKitConfig({
      config: `{ "monitor": { "errors": { "provider": "sentry", "org": "acme-health", "project": "booking-web" } } }`,
    });

    expect(result).toEqual({
      ok: true,
      config: {
        ...DEFAULTS,
        monitor: {
          errors: { provider: "sentry", org: "acme-health", project: "booking-web", url: "https://sentry.io", minEvents: 3 },
          redMain: true,
        },
      },
    });
  });

  it("honours a Sentry-compatible url, a min_events and turning red main off", () => {
    const result = resolveKitConfig({
      config: JSON.stringify({
        monitor: {
          errors: {
            provider: "sentry",
            org: "acme-health",
            project: "booking-web",
            url: "https://de.sentry.io",
            min_events: 10,
          },
          red_main: false,
        },
      }),
    });

    expect(result.ok && result.config.monitor).toEqual({
      errors: { provider: "sentry", org: "acme-health", project: "booking-web", url: "https://de.sentry.io", minEvents: 10 },
      redMain: false,
    });
  });

  it("lets null leave production errors off, as the template spells it", () => {
    const result = resolveKitConfig({ config: `{ "monitor": { "errors": null, "red_main": true } }` });

    expect(result).toEqual({ ok: true, config: DEFAULTS });
  });

  /** A Kit config whose monitor.errors is a valid Sentry project, with these fields changed. */
  function withErrors(changes: Record<string, unknown>): string {
    return JSON.stringify({
      monitor: { errors: { provider: "sentry", org: "acme-health", project: "booking-web", ...changes } },
    });
  }

  it.each([
    [
      { provider: "glitchtip" },
      `monitor.errors.provider is "glitchtip": the only provider is sentry; point url at a Sentry-compatible host`,
    ],
    [{ provider: "Sentry" }, `monitor.errors.provider is "Sentry": the only provider is sentry; point url at a Sentry-compatible host`],
    [{ provider: 1 }, "monitor.errors.provider must be a string"],
    [{ provider: undefined }, "monitor.errors.provider is missing"],
  ])("refuses a provider other than sentry, naming the field: %j", (changes, error) => {
    expect(resolveKitConfig({ config: withErrors(changes) })).toEqual({ ok: false, errors: [error] });
  });

  it.each([
    [{ org: undefined }, "monitor.errors.org is missing"],
    [{ project: undefined }, "monitor.errors.project is missing"],
    [{ org: null }, "monitor.errors.org must be a string"],
    [{ project: 7 }, "monitor.errors.project must be a string"],
    [{ org: "" }, `monitor.errors.org is "": a Sentry slug is lowercase letters, digits, hyphens and underscores`],
    [
      { project: "https://acme-health.sentry.io/projects/booking-web/" },
      `monitor.errors.project is "https://acme-health.sentry.io/projects/booking-web/": a Sentry slug is lowercase letters, digits, hyphens and underscores`,
    ],
    [{ org: "Acme Health" }, `monitor.errors.org is "Acme Health": a Sentry slug is lowercase letters, digits, hyphens and underscores`],
  ])("refuses a missing or malformed org or project, naming the field: %j", (changes, error) => {
    expect(resolveKitConfig({ config: withErrors(changes) })).toEqual({ ok: false, errors: [error] });
  });

  it.each([0, -3, 2.5, "3", null])("refuses a min_events of %j, naming the field", (minEvents) => {
    expect(resolveKitConfig({ config: withErrors({ min_events: minEvents }) })).toEqual({
      ok: false,
      errors: ["monitor.errors.min_events must be a whole number of at least 1"],
    });
  });

  it.each([
    [{ url: "http://glitchtip.example" }, `monitor.errors.url is "http://glitchtip.example": the Sentry token is sent there, so it must be an https:// URL`],
    [{ url: "sentry.io" }, `monitor.errors.url is "sentry.io": the Sentry token is sent there, so it must be an https:// URL`],
    [{ url: 443 }, "monitor.errors.url must be a string"],
  ])("refuses a url that isn't https, naming the field: %j", (changes, error) => {
    expect(resolveKitConfig({ config: withErrors(changes) })).toEqual({ ok: false, errors: [error] });
  });

  it.each([0, null, "false"])("refuses a red_main of %j, naming the field", (redMain) => {
    expect(resolveKitConfig({ config: JSON.stringify({ monitor: { red_main: redMain } }) })).toEqual({
      ok: false,
      errors: ["monitor.red_main must be true or false"],
    });
  });

  it.each([
    [{ monitor: { red_mian: false } }, "monitor.red_mian is not a Kit config field"],
    [{ monitor: { caps: 5 } }, "monitor.caps is not a Kit config field"],
    [
      { monitor: { errors: { provider: "sentry", org: "acme-health", project: "booking-web", token: "sntrys_x" } } },
      "monitor.errors.token is not a Kit config field",
    ],
    [
      { monitor: { errors: { provider: "sentry", org: "acme-health", project: "booking-web", minEvents: 5 } } },
      "monitor.errors.minEvents is not a Kit config field",
    ],
  ])("fails an unknown field under monitor, naming it: %j", (config, error) => {
    expect(resolveKitConfig({ config: JSON.stringify(config) })).toEqual({ ok: false, errors: [error] });
  });

  it.each([
    [{ monitor: [] }, "monitor must be an object"],
    [{ monitor: true }, "monitor must be an object"],
    [{ monitor: { errors: true } }, "monitor.errors must be an object or null"],
    [{ monitor: { errors: "sentry" } }, "monitor.errors must be an object or null"],
  ])("fails a monitor block that isn't an object, naming it: %j", (config, error) => {
    expect(resolveKitConfig({ config: JSON.stringify(config) })).toEqual({ ok: false, errors: [error] });
  });
});

describe("The Audit's Kit config", () => {
  it("gives a repo that sets nothing a Sunday Audit on the Reviewer's model with a 45-minute timeout", () => {
    const result = resolveKitConfig({ config: `{ "max_in_flight": 1 }` });

    expect(result.ok && result.config.audit).toEqual({ day: "sunday" });
    expect(result.ok && result.config.roles.audit).toEqual({
      model: "claude-opus-5-5",
      effort: null,
      timeoutMinutes: 45,
    });
  });

  it.each(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", null])(
    "reads audit.day %j as written",
    (day) => {
      const result = resolveKitConfig({ config: JSON.stringify({ audit: { day } }) });

      expect(result).toEqual({ ok: true, config: { ...DEFAULTS, audit: { day } } });
    },
  );

  it.each(["Sunday", "sun", "everyday", ""])("refuses %j as audit.day, naming the field and the days it takes", (day) => {
    const result = resolveKitConfig({ config: JSON.stringify({ audit: { day } }) });

    expect(result).toEqual({
      ok: false,
      errors: [
        `audit.day is ${JSON.stringify(day)}: the Audit day must be one of monday, tuesday, wednesday, thursday, friday, saturday, sunday, or null to turn the Audit off`,
      ],
    });
  });

  it.each([
    [`{ "audit": { "day": 0 } }`, "audit.day must be a string"],
    [`{ "audit": { "day": false } }`, "audit.day must be a string"],
    [`{ "audit": "sunday" }`, "audit must be an object"],
    [`{ "audit": null }`, "audit must be an object"],
  ])("fails a mistyped audit field, naming it: %s", (text, error) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
  });

  it.each([
    [`{ "audit": { "days": "monday" } }`, "audit.days is not a Kit config field"],
    [`{ "audit": { "day": "monday", "candidates": 5 } }`, "audit.candidates is not a Kit config field"],
    [`{ "audit": { "focus": "src/billing" } }`, "audit.focus is not a Kit config field"],
  ])("fails an unknown field under audit, naming it: %s", (text, error) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
  });

  it("honours overrides of the Auditor's model, effort and timeout", () => {
    const result = resolveKitConfig({
      config: `{ "roles": { "audit": { "model": "claude-sonnet-5-5", "effort": "high", "timeout_minutes": 20 } } }`,
    });

    expect(result).toEqual({
      ok: true,
      config: {
        ...DEFAULTS,
        roles: { ...DEFAULTS.roles, audit: { model: "claude-sonnet-5-5", effort: "high", timeoutMinutes: 20 } },
      },
    });
  });

  it.each([
    [`{ "roles": { "audit": { "model": "fable" } } }`, `roles.audit.model is "fable": Fable can bill metered usage, so the Kit never runs it in an AFK role`],
    [`{ "roles": { "audit": { "effort": "extreme" } } }`, `roles.audit.effort is "extreme": effort must be one of low, medium, high, xhigh, max`],
    [`{ "roles": { "audit": { "timeout_minutes": 0 } } }`, "roles.audit.timeout_minutes must be a whole number of at least 1"],
    [`{ "roles": { "audit": { "focus": "src/billing" } } }`, "roles.audit.focus is not a Kit config field"],
  ])("fails a bad roles.audit field, naming it: %s", (text, error) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
  });

  it("refuses roles.audit.skills, naming the field, because only triage, design, implement and review take Extra skills", () => {
    const result = resolveKitConfig({
      config: JSON.stringify({ roles: { audit: { skills: ["jrey8343/skills/event-storming"] } } }),
      skillsLock: null,
    });

    expect(result).toEqual({ ok: false, errors: ["roles.audit.skills is not a Kit config field"] });
  });
});

describe("The Kit config template", () => {
  it("spells out caps.design_sessions at its Kit default", () => {
    expect(JSON.parse(template)).toMatchObject({ caps: { design_sessions: 2 } });
  });

  it("spells out caps.monitor_issues and the monitor block at their Kit defaults: production errors off, red main on", () => {
    expect(JSON.parse(template)).toMatchObject({ caps: { monitor_issues: 5 }, monitor: { errors: null, red_main: true } });
  });

  it("spells out audit.day and roles.audit at their Kit defaults", () => {
    expect(JSON.parse(template)).toMatchObject({
      audit: { day: "sunday" },
      roles: { audit: { model: "claude-opus-5-5", effort: null, timeout_minutes: 45 } },
    });
  });

  it("spells out subscriptions at its Kit default, the one V1 Subscription", () => {
    expect(JSON.parse(template)).toMatchObject({ subscriptions: ["Claude token"] });
  });

  it("resolves to every Kit default", () => {
    expect(resolveKitConfig({ config: template })).toEqual({ ok: true, config: DEFAULTS });
  });

  it("is the defaults block the README's Kit config section shows", () => {
    const section = readme.slice(readme.indexOf("## Kit config"));
    const block = /```json\n([\s\S]*?)```/.exec(section)?.[1];

    expect(block).toBe(template);
  });
});

describe("Skills sources and Extra skill picks", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);

  it("resolves no lockfile and no picks to no Skills sources and no Extra skills for every role", () => {
    expect(resolveKitConfig({ config: null, skillsLock: null })).toEqual({ ok: true, config: DEFAULTS });
  });

  /** A config that picks one skill from each of these sources, so no pin goes unused. */
  function pickingFrom(...repositories: string[]): string {
    return JSON.stringify({ roles: { design: { skills: repositories.map((repository, i) => `${repository}/skill-${i}`) } } });
  }

  it.each([
    ["", []],
    ["  \n", []],
    ["[]", []],
  ])("treats an empty lockfile (%j) as no Skills sources", (skillsLock) => {
    expect(resolveKitConfig({ config: null, skillsLock })).toEqual({ ok: true, config: DEFAULTS });
  });

  it("fails a lockfile that isn't JSON, naming the file", () => {
    const result = resolveKitConfig({ config: null, skillsLock: "[{ repository: x }]" });

    expect(!result.ok && result.errors).toEqual([expect.stringMatching(/^\.fabrik\/skills\.lock\.json is not valid JSON: /)]);
  });

  it.each([
    [`{ "repository": "jrey8343/skills", "sha": "${SHA_A}" }`, ".fabrik/skills.lock.json must be a list of { repository, sha } pins"],
    [`["jrey8343/skills"]`, ".fabrik/skills.lock.json[0] must be an object"],
    [
      `[{ "repository": "jrey8343", "sha": "${SHA_A}" }]`,
      `.fabrik/skills.lock.json[0].repository is "jrey8343": a repository must be owner/name`,
    ],
    [`[{ "sha": "${SHA_A}" }]`, ".fabrik/skills.lock.json[0].repository is missing"],
    [
      `[{ "repository": "jrey8343/skills", "sha": "main" }]`,
      `.fabrik/skills.lock.json[0].sha is "main": a pin must be a full 40-character lowercase commit SHA`,
    ],
    [
      `[{ "repository": "jrey8343/skills", "sha": "${SHA_A.toUpperCase()}" }]`,
      `.fabrik/skills.lock.json[0].sha is "${SHA_A.toUpperCase()}": a pin must be a full 40-character lowercase commit SHA`,
    ],
    [`[{ "repository": "jrey8343/skills" }]`, ".fabrik/skills.lock.json[0].sha is missing"],
    [
      `[{ "repository": "jrey8343/skills", "sha": "${SHA_A}", "branch": "main" }]`,
      ".fabrik/skills.lock.json[0].branch is not a Kit config field",
    ],
    [
      `[{ "repository": "jrey8343/skills", "sha": "${SHA_A}" }, { "repository": "JRey8343/Skills", "sha": "${SHA_B}" }]`,
      ".fabrik/skills.lock.json[1] pins JRey8343/Skills, which .fabrik/skills.lock.json[0] already pins",
    ],
  ])("fails a bad lockfile, naming the entry: %s", (skillsLock, error) => {
    expect(resolveKitConfig({ config: pickingFrom("jrey8343/skills"), skillsLock })).toEqual({ ok: false, errors: [error] });
  });

  const LOCK = JSON.stringify([
    { repository: "jrey8343/skills", sha: SHA_A },
    { repository: "mattpocock/extras", sha: SHA_B },
  ]);

  it.each([
    [{ design: { skills: "jrey8343/skills/event-storming" } }, "roles.design.skills must be a list of strings"],
    [
      { design: { skills: ["jrey8343/skills/event-storming", "event-storming"] } },
      `roles.design.skills[1] is "event-storming": a pick must be owner/name/skill`,
    ],
    [
      { design: { skills: ["jrey8343/skills/event-storming", "jrey8343/skills/storming/deep"] } },
      `roles.design.skills[1] is "jrey8343/skills/storming/deep": a pick must be owner/name/skill`,
    ],
    [
      { design: { skills: ["jrey8343/skills/event-storming", "jrey8343/skills/"] } },
      `roles.design.skills[1] is "jrey8343/skills/": a pick must be owner/name/skill`,
    ],
    [
      { design: { skills: ["jrey8343/skills/event-storming", "jrey8343/skills/.."] } },
      `roles.design.skills[1] is "jrey8343/skills/..": a pick must be owner/name/skill`,
    ],
    [
      { design: { skills: ["jrey8343/skills/event-storming", "mattpocock/extras/decider", "someone/else/tdd"] } },
      `roles.design.skills[2] is "someone/else/tdd": someone/else has no pin in .fabrik/skills.lock.json`,
    ],
    [
      { design: { skills: ["jrey8343/skills/event-storming"] } },
      ".fabrik/skills.lock.json[1] pins mattpocock/extras, but no role picks a skill from it",
    ],
    [
      { design: { skills: ["jrey8343/skills/decider"] }, implement: { skills: ["mattpocock/extras/decider"] } },
      `roles.implement.skills[0] is "mattpocock/extras/decider": roles.design.skills[0] already picks a skill named decider from jrey8343/skills`,
    ],
    [
      { design: { skills: ["jrey8343/skills/event-storming", "mattpocock/extras/decider", "jrey8343/skills/event-storming"] } },
      `roles.design.skills[2] is "jrey8343/skills/event-storming": roles.design.skills[0] already picks it`,
    ],
  ])("fails a bad pick, naming it: %j", (roles, error) => {
    expect(resolveKitConfig({ config: JSON.stringify({ roles }), skillsLock: LOCK })).toEqual({ ok: false, errors: [error] });
  });

  it("matches a pick to its pin whatever the case, resolving it to the pin's spelling", () => {
    const result = resolveKitConfig(
      { config: pickingFrom("JRey8343/Skills"), skillsLock: JSON.stringify([{ repository: "jrey8343/skills", sha: SHA_A }]) },
    );

    expect(result.ok && result.config.extraSkills.design).toEqual([{ source: "jrey8343/skills", name: "skill-0" }]);
  });

  it("fails picks with no lockfile, naming the unpinned source", () => {
    const result = resolveKitConfig({ config: pickingFrom("jrey8343/skills"), skillsLock: null });

    expect(result).toEqual({
      ok: false,
      errors: [`roles.design.skills[0] is "jrey8343/skills/skill-0": jrey8343/skills has no pin in .fabrik/skills.lock.json`],
    });
  });

  it.each(["dispatch", "step_up", "implementer"])("refuses skills under roles.%s as an unknown field", (role) => {
    const result = resolveKitConfig(
      { config: JSON.stringify({ roles: { [role]: { skills: ["jrey8343/skills/event-storming"] } } }), skillsLock: null },
    );

    expect(!result.ok && result.errors).toContain(
      role === "implementer" ? "roles.implementer is not a Kit config field" : `roles.${role}.skills is not a Kit config field`,
    );
  });

  it("resolves the pinned sources and each role's picks, giving one pick to several roles", () => {
    const result = resolveKitConfig(
      {
        config: JSON.stringify({
          roles: {
            design: { skills: ["jrey8343/skills/event-storming", "mattpocock/extras/decider"] },
            review: { skills: ["jrey8343/skills/event-storming"] },
          },
        }),
        skillsLock: JSON.stringify([
          { repository: "jrey8343/skills", sha: SHA_A },
          { repository: "mattpocock/extras", sha: SHA_B },
        ]),
      },
    );

    expect(result).toEqual({
      ok: true,
      config: {
        ...DEFAULTS,
        skillsSources: [
          { repository: "jrey8343/skills", sha: SHA_A },
          { repository: "mattpocock/extras", sha: SHA_B },
        ],
        extraSkills: {
          triage: [],
          design: [
            { source: "jrey8343/skills", name: "event-storming" },
            { source: "mattpocock/extras", name: "decider" },
          ],
          implement: [],
          review: [{ source: "jrey8343/skills", name: "event-storming" }],
        },
      },
    });
  });
});

describe("Skills sources and Extra skill picks, as shipped", () => {
  const SHA = "a".repeat(40);

  it("resolves a Product repo's pins and picks", () => {
    const result = resolveKitConfig({
      config: JSON.stringify({ roles: { design: { skills: ["jrey8343/skills/event-storming"] } } }),
      skillsLock: JSON.stringify([{ repository: "jrey8343/skills", sha: SHA }]),
    });

    expect(result).toEqual({
      ok: true,
      config: {
        ...DEFAULTS,
        skillsSources: [{ repository: "jrey8343/skills", sha: SHA }],
        extraSkills: { ...DEFAULTS.extraSkills, design: [{ source: "jrey8343/skills", name: "event-storming" }] },
      },
    });
  });

  it("resolves a repo with no lockfile and no picks exactly as before", () => {
    expect(resolveKitConfig({ config: null })).toEqual({ ok: true, config: DEFAULTS });
  });

  it.each(["dispatch", "step_up"])("still refuses a pick under roles.%s as an unknown field", (role) => {
    const result = resolveKitConfig({ config: JSON.stringify({ roles: { [role]: { skills: [] } } }) });

    expect(result).toEqual({ ok: false, errors: [`roles.${role}.skills is not a Kit config field`] });
  });
});

describe("The Kit config's Subscriptions", () => {
  it("resolves a repo that lists none to the one V1 Subscription, Claude token", () => {
    const result = resolveKitConfig({ config: null });

    expect(result.ok && result.config.subscriptions).toEqual(["Claude token"]);
  });

  it("reads a one-Subscription list naming another vault item as written", () => {
    const result = resolveKitConfig({ config: `{ "subscriptions": ["Claude token (work)"] }` });

    expect(result).toEqual({ ok: true, config: { ...DEFAULTS, subscriptions: ["Claude token (work)"] } });
  });

  it.each([
    [`{ "subscriptions": "Claude token" }`, "subscriptions must be a list of Fabrik vault item names"],
    [`{ "subscriptions": null }`, "subscriptions must be a list of Fabrik vault item names"],
    [`{ "subscriptions": { "name": "Claude token" } }`, "subscriptions must be a list of Fabrik vault item names"],
    [`{ "subscriptions": [2] }`, "subscriptions must be a list of Fabrik vault item names"],
    [`{ "subscriptions": [""] }`, "subscriptions must be a list of Fabrik vault item names"],
  ])("refuses a Subscriptions value that isn't a list of vault item names, naming the field: %s", (text, error) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
  });

  it("refuses an empty Subscriptions list, since the Kit needs one to run agents on", () => {
    expect(resolveKitConfig({ config: `{ "subscriptions": [] }` })).toEqual({
      ok: false,
      errors: ["subscriptions is empty: list at least one Subscription"],
    });
  });

  it("refuses a Subscriptions list that names one vault item twice", () => {
    expect(resolveKitConfig({ config: `{ "subscriptions": ["Claude token", "Claude token"] }` })).toEqual({
      ok: false,
      errors: [`subscriptions lists "Claude token" more than once`],
    });
  });

  it.each([
    [["Claude token", "Claude token 2"]],
    [["Claude token 2", "Claude token"]],
    [["Claude token", "Claude token 2", "Claude token 3"]],
  ])("reads %j as written, in the Operator's order", (subscriptions) => {
    expect(resolveKitConfig({ config: JSON.stringify({ subscriptions }) })).toEqual({
      ok: true,
      config: { ...DEFAULTS, subscriptions },
    });
  });

  it("refuses a two-item list with an empty name, naming the field", () => {
    expect(resolveKitConfig({ config: `{ "subscriptions": ["Claude token", ""] }` })).toEqual({
      ok: false,
      errors: ["subscriptions must be a list of Fabrik vault item names"],
    });
  });

  it("refuses a longer list that names one vault item twice", () => {
    expect(
      resolveKitConfig({ config: `{ "subscriptions": ["Claude token", "Claude token 2", "Claude token 2"] }` }),
    ).toEqual({ ok: false, errors: [`subscriptions lists "Claude token 2" more than once`] });
  });
});

describe("A Subscription name, which goes into a job output and an op:// reference", () => {
  it.each([
    ["a newline, which would write another job output", "Claude token\nroute=implement"],
    ["a carriage return", "Claude token\r"],
    ["a tab", "Claude\ttoken"],
    ["a slash, which would change the op:// reference", "Claude token/other"],
  ])("is refused when it holds %s", (_, name) => {
    expect(resolveKitConfig({ config: JSON.stringify({ subscriptions: [name] }) })).toEqual({
      ok: false,
      errors: [`subscriptions names ${JSON.stringify(name)}, but a Fabrik vault item name can't hold a control character or a slash`],
    });
  });
});
