import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { captureIdentityOf, previewUrl, productionPageUrl, REVIEWER_IMAGE_CAP, resolveKitConfig, timeZoneNote, type UiConfig, UI_VIEWPORTS, withRouteOn } from "./config.ts";

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
    retro: { model: "claude-opus-5-5", effort: null, timeoutMinutes: 45 },
    research: { model: "claude-opus-5-5", effort: null, timeoutMinutes: 30 },
    digest: { model: "claude-opus-5-5", effort: null, timeoutMinutes: 10 },
    dispatch: { timeoutMinutes: 10 },
    stepUp: { model: "claude-opus-5-5", effort: null },
  },
  maxInFlight: 2,
  caps: { designSessions: 2, monitorIssues: 5, maps: 1, mergeGate: 3 },
  monitor: { errors: null, redMain: true },
  audit: { day: "sunday" },
  retro: { day: "saturday" },
  digest: { enabled: true },
  operator: null,
  subscriptions: ["Claude token"],
  instructions: { triage: null, design: null, implement: null, review: null, audit: null, retro: null, research: null, digest: null },
  skillsSources: [],
  extraSkills: { triage: [], design: [], implement: [], review: [] },
  ui: null,
  preview: null,
  production: null,
  timeZone: null,
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
    [`{ "caps": { "maps": -1 } }`, "caps.maps must be a whole number of at least 0"],
    [`{ "caps": { "maps": "1" } }`, "caps.maps must be a whole number of at least 0"],
    [`{ "caps": { "maps": null } }`, "caps.maps must be a whole number of at least 0"],
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

  it("reads the Sandbox commands, Required checks, values and test secrets", () => {
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
      retro: null,
      research: null,
      digest: null,
    });
  });

  it("carries the Auditor's instructions from .fabrik/audit.md, though the Auditor picks no Extra skills", () => {
    const result = resolveKitConfig({ config: null, instructions: { audit: "Look at the booking module first.\n" } });

    expect(result.ok && result.config.instructions.audit).toBe("Look at the booking module first.\n");
    expect(result.ok && Object.keys(result.config.extraSkills)).toEqual(["triage", "design", "implement", "review"]);
  });

  it("carries the Retro's instructions from .fabrik/retro.md, though the Retro picks no Extra skills", () => {
    const result = resolveKitConfig({ config: null, instructions: { retro: "Weigh the billing escapes first.\n" } });

    expect(result.ok && result.config.instructions.retro).toBe("Weigh the billing escapes first.\n");
    expect(result.ok && Object.keys(result.config.extraSkills)).toEqual(["triage", "design", "implement", "review"]);
  });

  it("carries the Researcher's instructions from .fabrik/research.md, though the Researcher picks no Extra skills", () => {
    const result = resolveKitConfig({ config: null, instructions: { research: "Prefer the vendor's own docs.\n" } });

    expect(result.ok && result.config.instructions.research).toBe("Prefer the vendor's own docs.\n");
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
        retro: { model: "claude-opus-5-5", effort: null, timeout_minutes: 45 },
        research: { model: "claude-opus-5-5", effort: null, timeout_minutes: 30 },
        digest: { model: "claude-opus-5-5", effort: null, timeout_minutes: 10 },
        dispatch: { timeout_minutes: 10 },
        step_up: { model: "claude-opus-5-5", effort: null },
      },
      max_in_flight: 2,
      caps: { design_sessions: 2, monitor_issues: 5, maps: 1, merge_gate: 3 },
      monitor: { errors: null, red_main: true },
      audit: { day: "sunday" },
      retro: { day: "saturday" },
      digest: { enabled: true },
      operator: null,
      production: null,
    };

    expect(resolveKitConfig({ config: JSON.stringify(starter) })).toEqual({ ok: true, config: DEFAULTS });
  });

  it("reads the Operator's time zone from time_zone", () => {
    const result = resolveKitConfig({ config: `{ "time_zone": "Australia/Sydney" }` });

    expect(result.ok && result.config.timeZone).toBe("Australia/Sydney");
    expect(timeZoneNote(`{ "time_zone": "Australia/Sydney" }`)).toBeNull();
  });

  it.each([`{ "time_zone": null }`, "{}", null])("leaves the time zone unset, with no note, for %j", (text) => {
    const result = resolveKitConfig({ config: text });

    expect(result.ok && result.config.timeZone).toBeNull();
    expect(timeZoneNote(text)).toBeNull();
  });

  it.each([
    [`{ "time_zone": "Mars/Olympus_Mons" }`, `"Mars/Olympus_Mons"`],
    [`{ "time_zone": "sydney time" }`, `"sydney time"`],
    [`{ "time_zone": 10 }`, "10"],
  ])("takes an invalid time_zone, %s, as unset without failing, and the note names it", (text, named) => {
    const result = resolveKitConfig({ config: text });

    expect(result).toEqual({ ok: true, config: DEFAULTS });
    expect(timeZoneNote(text)).toBe(
      `\`time_zone\` in .fabrik/config.json is ${named}, which isn't an IANA time zone, such as Europe/London, so the Kit writes its times in UTC.`,
    );
  });

  it("has no time zone note for a Kit config that isn't JSON, whose errors say so", () => {
    expect(timeZoneNote("{ not json")).toBeNull();
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

  it("gives a Product repo whose config never sets caps the Kit defaults: 2 Design sessions, 5 open Monitor error issues and 1 open Map", () => {
    const result = resolveKitConfig({ config: `{ "max_in_flight": 1, "operator": "jrey8343" }` });

    expect(result.ok && result.config.caps).toEqual({ designSessions: 2, monitorIssues: 5, maps: 1, mergeGate: 3 });
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

  it.each([2, 0])("honours lowering caps.merge_gate to %i, 0 holding Tickets while any agent PR is at or on its way to the Merge gate", (cap) => {
    const result = resolveKitConfig({ config: `{ "caps": { "merge_gate": ${cap} } }` });

    expect(result).toEqual({ ok: true, config: { ...DEFAULTS, caps: { ...DEFAULTS.caps, mergeGate: cap } } });
  });

  it.each([4, 10])("refuses raising caps.merge_gate to %i, naming the field, the value and the Kit default", (cap) => {
    const result = resolveKitConfig({ config: `{ "caps": { "merge_gate": ${cap} } }` });

    expect(result).toEqual({
      ok: false,
      errors: [`caps.merge_gate is ${cap}, but a cap can only be lowered: the Kit default is 3`],
    });
  });

  it.each([-1, "3", null])("refuses caps.merge_gate of %j, which isn't a whole number", (cap) => {
    const result = resolveKitConfig({ config: `{ "caps": { "merge_gate": ${JSON.stringify(cap)} } }` });

    expect(result).toEqual({ ok: false, errors: ["caps.merge_gate must be a whole number of at least 0"] });
  });

  it("honours lowering caps.maps to 0, which stops new Maps", () => {
    const result = resolveKitConfig({ config: `{ "caps": { "maps": 0 } }` });

    expect(result).toEqual({ ok: true, config: { ...DEFAULTS, caps: { ...DEFAULTS.caps, maps: 0 } } });
  });

  it("keeps the Kit default when caps.maps is set to it", () => {
    const result = resolveKitConfig({ config: `{ "caps": { "maps": 1 } }` });

    expect(result).toEqual({ ok: true, config: DEFAULTS });
  });

  it.each([2, 99])("refuses raising caps.maps to %i, naming the field, the value and the Kit default", (cap) => {
    const result = resolveKitConfig({ config: `{ "caps": { "maps": ${cap} } }` });

    expect(result).toEqual({
      ok: false,
      errors: [`caps.maps is ${cap}, but a cap can only be lowered: the Kit default is 1`],
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

describe("The Retro's Kit config", () => {
  it("gives a repo that sets nothing a Saturday Retro on the Reviewer's model with a 45-minute timeout", () => {
    const result = resolveKitConfig({ config: `{ "max_in_flight": 1 }` });

    expect(result.ok && result.config.retro).toEqual({ day: "saturday" });
    expect(result.ok && result.config.roles.retro).toEqual({
      model: "claude-opus-5-5",
      effort: null,
      timeoutMinutes: 45,
    });
  });

  it.each(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", null])(
    "reads retro.day %j as written",
    (day) => {
      const result = resolveKitConfig({ config: JSON.stringify({ retro: { day } }) });

      expect(result).toEqual({ ok: true, config: { ...DEFAULTS, retro: { day } } });
    },
  );

  it.each(["Saturday", "sat", "weekly", ""])("refuses %j as retro.day, naming the field and the days it takes", (day) => {
    const result = resolveKitConfig({ config: JSON.stringify({ retro: { day } }) });

    expect(result).toEqual({
      ok: false,
      errors: [
        `retro.day is ${JSON.stringify(day)}: the Retro day must be one of monday, tuesday, wednesday, thursday, friday, saturday, sunday, or null to turn the Retro off`,
      ],
    });
  });

  it.each([
    [`{ "retro": { "day": 6 } }`, "retro.day must be a string"],
    [`{ "retro": { "day": true } }`, "retro.day must be a string"],
    [`{ "retro": "saturday" }`, "retro must be an object"],
    [`{ "retro": null }`, "retro must be an object"],
  ])("fails a mistyped retro field, naming it: %s", (text, error) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
  });

  it.each([
    [`{ "retro": { "days": "saturday" } }`, "retro.days is not a Kit config field"],
    [`{ "retro": { "day": "saturday", "proposals": 5 } }`, "retro.proposals is not a Kit config field"],
    [`{ "retro": { "window_days": 14 } }`, "retro.window_days is not a Kit config field"],
  ])("fails an unknown field under retro, naming it: %s", (text, error) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
  });

  it("honours overrides of the Retro's model, effort and timeout", () => {
    const result = resolveKitConfig({
      config: `{ "roles": { "retro": { "model": "claude-sonnet-5-5", "effort": "high", "timeout_minutes": 20 } } }`,
    });

    expect(result).toEqual({
      ok: true,
      config: {
        ...DEFAULTS,
        roles: { ...DEFAULTS.roles, retro: { model: "claude-sonnet-5-5", effort: "high", timeoutMinutes: 20 } },
      },
    });
  });

  it.each([
    [`{ "roles": { "retro": { "model": "fable" } } }`, `roles.retro.model is "fable": Fable can bill metered usage, so the Kit never runs it in an AFK role`],
    [`{ "roles": { "retro": { "effort": "extreme" } } }`, `roles.retro.effort is "extreme": effort must be one of low, medium, high, xhigh, max`],
    [`{ "roles": { "retro": { "timeout_minutes": 0 } } }`, "roles.retro.timeout_minutes must be a whole number of at least 1"],
    [`{ "roles": { "retro": { "proposals": 3 } } }`, "roles.retro.proposals is not a Kit config field"],
  ])("fails a bad roles.retro field, naming it: %s", (text, error) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
  });

  it("refuses roles.retro.skills, naming the field, because only triage, design, implement and review take Extra skills", () => {
    const result = resolveKitConfig({
      config: JSON.stringify({ roles: { retro: { skills: ["jrey8343/skills/event-storming"] } } }),
      skillsLock: null,
    });

    expect(result).toEqual({ ok: false, errors: ["roles.retro.skills is not a Kit config field"] });
  });
});

describe("The Researcher's Kit config", () => {
  it("gives a repo that sets nothing a Researcher on Opus 5.5 with no effort and a 30-minute timeout", () => {
    const result = resolveKitConfig({ config: `{ "max_in_flight": 1 }` });

    expect(result.ok && result.config.roles.research).toEqual({
      model: "claude-opus-5-5",
      effort: null,
      timeoutMinutes: 30,
    });
  });

  it("honours overrides of the Researcher's model, effort and timeout", () => {
    const result = resolveKitConfig({
      config: `{ "roles": { "research": { "model": "claude-sonnet-5-5", "effort": "high", "timeout_minutes": 20 } } }`,
    });

    expect(result).toEqual({
      ok: true,
      config: {
        ...DEFAULTS,
        roles: { ...DEFAULTS.roles, research: { model: "claude-sonnet-5-5", effort: "high", timeoutMinutes: 20 } },
      },
    });
  });

  it.each([
    [`{ "roles": { "research": { "model": "fable" } } }`, `roles.research.model is "fable": Fable can bill metered usage, so the Kit never runs it in an AFK role`],
    [`{ "roles": { "research": { "effort": "extreme" } } }`, `roles.research.effort is "extreme": effort must be one of low, medium, high, xhigh, max`],
    [`{ "roles": { "research": { "timeout_minutes": 0 } } }`, "roles.research.timeout_minutes must be a whole number of at least 1"],
    [`{ "roles": { "research": { "sources": ["docs.github.com"] } } }`, "roles.research.sources is not a Kit config field"],
  ])("fails a bad roles.research field, naming it: %s", (text, error) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
  });

  it("refuses roles.research.skills, naming the field, because only triage, design, implement and review take Extra skills", () => {
    const result = resolveKitConfig({
      config: JSON.stringify({ roles: { research: { skills: ["jrey8343/skills/event-storming"] } } }),
      skillsLock: null,
    });

    expect(result).toEqual({ ok: false, errors: ["roles.research.skills is not a Kit config field"] });
  });
});

describe("The Digest's Kit config (ADR-0022)", () => {
  it("is valid with none of its keys: the Digest is on, and the Digest writer runs on the Reviewer's default model and effort for 10 minutes", () => {
    const result = resolveKitConfig({ config: `{ "max_in_flight": 4 }` });

    expect(result.ok && result.config.digest).toEqual({ enabled: true });
    expect(result.ok && result.config.roles.digest).toEqual({ model: "claude-opus-5-5", effort: null, timeoutMinutes: 10 });
  });

  it("defaults roles.digest's model and effort to the repo's own roles.review, and its time limit to 10, never the Reviewer's", () => {
    const result = resolveKitConfig({
      config: `{ "roles": { "review": { "model": "claude-sonnet-5-5", "effort": "high", "timeout_minutes": 45 } } }`,
    });

    expect(result.ok && result.config.roles.digest).toEqual({ model: "claude-sonnet-5-5", effort: "high", timeoutMinutes: 10 });
  });

  it("honours overrides of the Digest writer's model, effort and time limit, whatever roles.review says", () => {
    const result = resolveKitConfig({
      config: JSON.stringify({
        roles: {
          review: { model: "claude-sonnet-5-5", effort: "high" },
          digest: { model: "claude-haiku-5-5", effort: "low", timeout_minutes: 4 },
        },
      }),
    });

    expect(result.ok && result.config.roles.digest).toEqual({ model: "claude-haiku-5-5", effort: "low", timeoutMinutes: 4 });
    expect(result.ok && result.config.roles.review).toEqual({ model: "claude-sonnet-5-5", effort: "high", timeoutMinutes: 30 });
  });

  it("lets a null effort on roles.digest pass none, though roles.review sets one", () => {
    const result = resolveKitConfig({ config: `{ "roles": { "review": { "effort": "high" }, "digest": { "effort": null } } }` });

    expect(result.ok && result.config.roles.digest.effort).toBeNull();
  });

  it.each([true, false])("reads digest.enabled %j as written", (enabled) => {
    const result = resolveKitConfig({ config: JSON.stringify({ digest: { enabled } }) });

    expect(result.ok && result.config.digest).toEqual({ enabled });
  });

  it("carries the Digest writer's own instructions from .fabrik/digest.md", () => {
    const result = resolveKitConfig({ config: null, instructions: { digest: "Name the shop's pages as its shoppers do." } });

    expect(result.ok && result.config.instructions.digest).toBe("Name the shop's pages as its shoppers do.");
  });

  it.each([
    [`{ "roles": { "digest": { "model": "fable" } } }`, `roles.digest.model is "fable": Fable can bill metered usage, so the Kit never runs it in an AFK role`],
    [`{ "roles": { "digest": { "timeout_minutes": 0 } } }`, "roles.digest.timeout_minutes must be a whole number of at least 1"],
    [`{ "roles": { "digest": { "skills": ["jrey8343/skills/event-storming"] } } }`, "roles.digest.skills is not a Kit config field"],
    [`{ "digest": { "enabled": "no" } }`, "digest.enabled must be true or false"],
    [`{ "digest": { "enabled": null } }`, "digest.enabled must be true or false"],
    [`{ "digest": { "on": true } }`, "digest.on is not a Kit config field"],
  ])("fails a bad Digest field, naming it: %s", (text, error) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
  });
});

describe("The Kit config template", () => {
  // Setup writes it as it is, so a Product repo's prettier --check sees it: Prettier breaks any object past 80 columns.
  it("fits every line in Prettier's 80 columns", () => {
    expect(template.split("\n").filter((line) => line.length > 80)).toEqual([]);
  });

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

  it("spells out retro.day and roles.retro at their Kit defaults", () => {
    expect(JSON.parse(template)).toMatchObject({
      retro: { day: "saturday" },
      roles: { retro: { model: "claude-opus-5-5", effort: null, timeout_minutes: 45 } },
    });
  });

  it("spells out roles.research and caps.maps at their Kit defaults: the Researcher on Opus 5.5 for 30 minutes, and one open Map", () => {
    expect(JSON.parse(template)).toMatchObject({
      roles: { research: { model: "claude-opus-5-5", effort: null, timeout_minutes: 30 } },
      caps: { maps: 1 },
    });
  });

  it("names the Digest's switch and the Digest writer's time limit at their Kit defaults, and leaves its model to roles.review", () => {
    const starter = JSON.parse(template) as { roles: { digest: unknown }; digest: unknown };

    expect(starter.digest).toEqual({ enabled: true });
    expect(starter.roles.digest).toEqual({ timeout_minutes: 10 });
  });

  it("spells out subscriptions at its Kit default, the one V1 Subscription", () => {
    expect(JSON.parse(template)).toMatchObject({ subscriptions: ["Claude token"] });
  });

  it("spells out ui and preview at their Kit defaults: Visual evidence off, and no preview linked", () => {
    expect(JSON.parse(template)).toMatchObject({ ui: null, preview: { url: null } });
  });

  it("spells out production at its Kit default, declaring nothing, then time_zone unset, as the last members", () => {
    const starter: unknown = JSON.parse(template);

    expect(starter).toMatchObject({ production: null, time_zone: null });
    expect(Object.keys(starter as object).slice(-2)).toEqual(["production", "time_zone"]);
  });

  it("resolves to every Kit default", () => {
    expect(resolveKitConfig({ config: template })).toEqual({ ok: true, config: DEFAULTS });
  });

  it("is documented in the README's Kit config section: the block, where null is accepted, and what each declaration gets", () => {
    const section = readme.slice(readme.indexOf("## Kit config"), readme.indexOf("### Extra skills"));
    const nulls = /`null` is accepted only where the default is `null` \(([^)]*)\)/.exec(section)?.[1] ?? "";

    expect(nulls).toContain("`production`");
    expect(nulls).toContain("`production.environment`");
    expect(section).toMatch(/^- `production` \(default `null`\)/m);
    expect(section).toMatch(/^ {4}\| No `production` \|/m);
    expect(section).toMatch(/^ {4}\| `production\.url`, no `environment` \|/m);
    expect(section).toMatch(/^ {4}\| `production\.url` and `environment` \|/m);
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

describe("The ui and preview blocks, which Visual evidence reads", () => {
  it("leaves ui and preview off when the Kit config has neither", () => {
    const result = resolveKitConfig({ config: `{ "max_in_flight": 1, "operator": "jrey8343" }` });

    expect(result.ok && result.config.ui).toBeNull();
    expect(result.ok && result.config.preview).toBeNull();
  });

  it("resolves a full ui block and a preview block", () => {
    const result = resolveKitConfig({
      config: JSON.stringify({
        ui: {
          paths: ["src/**/*.astro", "src/components/**", "public/**"],
          serve: "node ./dist/server/entry.mjs",
          url: "http://127.0.0.1:4321",
          before_url: "https://penrithphysio.com.au",
          default_routes: ["/", "/book", "/services"],
        },
        preview: { url: "https://deploy-preview-{pr}--penrith-physio.netlify.app" },
      }),
    });

    expect(result).toEqual({
      ok: true,
      config: {
        ...DEFAULTS,
        ui: {
          paths: ["src/**/*.astro", "src/components/**", "public/**"],
          serve: "node ./dist/server/entry.mjs",
          url: "http://127.0.0.1:4321",
          beforeUrl: "https://penrithphysio.com.au",
          defaultRoutes: ["/", "/book", "/services"],
        },
        preview: { url: "https://deploy-preview-{pr}--penrith-physio.netlify.app" },
      },
    });
  });

  it("resolves a ui block with only paths, serve and url to no Before and no default routes", () => {
    const result = resolveKitConfig({
      config: JSON.stringify({ ui: { paths: ["src/**"], serve: "npm run preview", url: "http://localhost:4321" } }),
    });

    expect(result).toEqual({
      ok: true,
      config: {
        ...DEFAULTS,
        ui: { paths: ["src/**"], serve: "npm run preview", url: "http://localhost:4321", beforeUrl: null, defaultRoutes: [] },
      },
    });
  });

  it("lets null skip Before, as a repo with no public production site spells it", () => {
    const result = resolveKitConfig({
      config: JSON.stringify({
        ui: { paths: ["src/**"], serve: "npm run preview", url: "http://localhost:4321", before_url: null },
      }),
    });

    expect(result.ok && result.config.ui?.beforeUrl).toBeNull();
  });

  it.each([`{ "ui": null }`, `{ "preview": null }`, `{ "preview": {} }`, `{ "preview": { "url": null } }`])(
    "resolves %s to Visual evidence off and no preview link",
    (text) => {
      expect(resolveKitConfig({ config: text })).toEqual({ ok: true, config: DEFAULTS });
    },
  );

  /** A Kit config whose ui block is valid, with these fields changed; undefined leaves a field out. */
  function withUi(changes: Record<string, unknown>): string {
    return JSON.stringify({
      ui: { paths: ["src/**"], serve: "npm run preview", url: "http://localhost:4321", ...changes },
    });
  }

  it.each([
    [{ paths: undefined }, "ui.paths is missing"],
    [{ paths: [] }, "ui.paths is empty: list at least one glob of the files that make a pull request UI"],
    [{ paths: "src/**" }, "ui.paths must be a list of strings"],
    [{ paths: ["src/**", 7] }, "ui.paths must be a list of strings"],
    [{ paths: ["src/**", " "] }, `ui.paths[1] is " ": a glob can't be blank`],
  ])("refuses missing, empty or malformed paths, naming the field: %j", (changes, error) => {
    expect(resolveKitConfig({ config: withUi(changes) })).toEqual({ ok: false, errors: [error] });
  });

  it.each([
    [{ serve: undefined }, "ui.serve is missing"],
    [{ serve: ["npm", "run", "preview"] }, "ui.serve must be a string"],
    [{ serve: "" }, `ui.serve is "": the command that serves the branch can't be blank`],
    [{ url: undefined }, "ui.url is missing"],
    [{ url: 4321 }, "ui.url must be a string"],
    [{ url: "localhost:4321" }, `ui.url is "localhost:4321": a URL must start with http:// or https://`],
    [{ url: "ws://localhost:4321" }, `ui.url is "ws://localhost:4321": a URL must start with http:// or https://`],
    [{ before_url: "penrithphysio.com.au" }, `ui.before_url is "penrithphysio.com.au": a URL must start with http:// or https://`],
    [{ before_url: "ftp://penrithphysio.com.au" }, `ui.before_url is "ftp://penrithphysio.com.au": a URL must start with http:// or https://`],
    [{ before_url: false }, "ui.before_url must be a string"],
  ])("refuses a missing or malformed serve, url or before_url, naming the field: %j", (changes, error) => {
    expect(resolveKitConfig({ config: withUi(changes) })).toEqual({ ok: false, errors: [error] });
  });

  it.each(["http://127.0.0.1:4321", "https://localhost:8443/app"])("takes %s as a ui.url", (url) => {
    const result = resolveKitConfig({ config: withUi({ url }) });

    expect(result.ok && result.config.ui?.url).toBe(url);
  });

  it.each([
    [{ default_routes: "/" }, "ui.default_routes must be a list of strings"],
    [{ default_routes: ["/", 1] }, "ui.default_routes must be a list of strings"],
    [{ default_routes: ["/", "book"] }, `ui.default_routes[1] is "book": a route must be a path starting with one /, such as /book`],
    [{ default_routes: [""] }, `ui.default_routes[0] is "": a route must be a path starting with one /, such as /book`],
    [
      { default_routes: ["https://penrithphysio.com.au/book"] },
      `ui.default_routes[0] is "https://penrithphysio.com.au/book": a route must be a path starting with one /, such as /book`,
    ],
    [{ default_routes: ["//evil.example"] }, `ui.default_routes[0] is "//evil.example": a route must be a path starting with one /, such as /book`],
  ])("refuses a default route that isn't a path starting with /, naming it: %j", (changes, error) => {
    expect(resolveKitConfig({ config: withUi(changes) })).toEqual({ ok: false, errors: [error] });
  });

  /** A ui block that signs in an owner and an operator, as ADR-0012 describes. */
  const SIGN_IN = {
    sign_in: { owner: "pnpm sign-in owner", operator: "pnpm sign-in operator" },
    sign_in_path: "/sign-in",
    signed_in_routes: [
      { route: "/pricing", as: null },
      { route: "/console/**", as: "operator" },
      { route: "/**", as: "owner" },
    ],
  };

  it("resolves sign_in, sign_in_path and signed_in_routes, keeping the rules in order", () => {
    const result = resolveKitConfig({ config: withUi(SIGN_IN) });

    expect(result.ok && result.config.ui).toEqual({
      paths: ["src/**"],
      serve: "npm run preview",
      url: "http://localhost:4321",
      beforeUrl: null,
      defaultRoutes: [],
      signIn: { owner: "pnpm sign-in owner", operator: "pnpm sign-in operator" },
      signInPath: "/sign-in",
      signedInRoutes: [
        { route: "/pricing", as: null },
        { route: "/console/**", as: "operator" },
        { route: "/**", as: "owner" },
      ],
    });
  });

  it.each(["http://localhost:4321", "http://app.localhost:3000", "http://127.0.0.1:4321", "http://[::1]:8080", "https://LOCALHOST"])(
    "signs in against the loopback ui.url %s",
    (url) => {
      expect(resolveKitConfig({ config: withUi({ ...SIGN_IN, url }) }).ok).toBe(true);
    },
  );

  it.each(["https://staging.example.com", "http://10.0.0.5:4321", "http://localhost.example.com", "http://127.0.0.2:4321"])(
    "refuses sign_in when ui.url %s isn't loopback, since a sign-in only ever runs against the Sandbox's own server",
    (url) => {
      expect(resolveKitConfig({ config: withUi({ ...SIGN_IN, url }) })).toEqual({
        ok: false,
        errors: [
          `ui.url is ${JSON.stringify(url)}: a ui with sign_in serves on a loopback address, such as http://localhost:4321, so a sign-in only ever reaches the Sandbox's own server`,
        ],
      });
    },
  );

  it.each([
    [{ sign_in_path: "/sign-in" }, "ui.sign_in_path is set, but ui.sign_in isn't: name a sign-in command for each Capture identity"],
    [
      { signed_in_routes: [{ route: "/**", as: null }] },
      "ui.signed_in_routes is set, but ui.sign_in isn't: name a sign-in command for each Capture identity",
    ],
  ])("refuses sign_in_path or signed_in_routes without sign_in: %j", (changes, error) => {
    expect(resolveKitConfig({ config: withUi(changes) })).toEqual({ ok: false, errors: [error] });
  });

  it.each([
    [{ ...SIGN_IN, sign_in_path: undefined }, "ui.sign_in_path is missing: with ui.sign_in, name the route the app sends a signed-out visitor to"],
    [{ ...SIGN_IN, sign_in_path: "sign-in" }, `ui.sign_in_path is "sign-in": a route must be a path starting with one /, such as /book`],
    [{ ...SIGN_IN, signed_in_routes: undefined }, "ui.signed_in_routes is missing: with ui.sign_in, list which Capture identity views each route"],
    [{ ...SIGN_IN, signed_in_routes: [] }, "ui.signed_in_routes is empty: with ui.sign_in, list which Capture identity views each route"],
    [{ ...SIGN_IN, signed_in_routes: "/**" }, "ui.signed_in_routes must be a list of { route, as } rules"],
    [{ ...SIGN_IN, signed_in_routes: ["/**"] }, "ui.signed_in_routes[0] must be an object"],
    [{ ...SIGN_IN, signed_in_routes: [{ as: "owner" }] }, "ui.signed_in_routes[0].route is missing"],
    [
      { ...SIGN_IN, signed_in_routes: [{ route: "console/**", as: "owner" }] },
      `ui.signed_in_routes[0].route is "console/**": a route must be a path starting with one /, such as /book`,
    ],
    [{ ...SIGN_IN, signed_in_routes: [{ route: "/**" }] }, "ui.signed_in_routes[0].as is missing: name a ui.sign_in identity, or null for a public route"],
    [
      { ...SIGN_IN, signed_in_routes: [{ route: "/**", as: "admin" }] },
      `ui.signed_in_routes[0].as is "admin": it must be null or one of ui.sign_in's identities, owner or operator`,
    ],
    [{ ...SIGN_IN, signed_in_routes: [{ route: "/**", as: "owner", via: "cookie" }] }, "ui.signed_in_routes[0].via is not a Kit config field"],
    [{ ...SIGN_IN, sign_in: {} }, "ui.sign_in is empty: name at least one Capture identity and the command that signs it in"],
    [{ ...SIGN_IN, sign_in: "pnpm sign-in" }, "ui.sign_in must be an object or null"],
    [{ ...SIGN_IN, sign_in: { owner: " ", operator: "pnpm sign-in operator" } }, `ui.sign_in.owner is " ": a sign-in command can't be blank`],
    [{ ...SIGN_IN, sign_in: { owner: 1, operator: "pnpm sign-in operator" } }, "ui.sign_in.owner must be a string"],
    [
      { ...SIGN_IN, sign_in: { "the owner": "pnpm sign-in owner", owner: "x", operator: "y" } },
      "ui.sign_in.the owner is not a Capture identity name: letters, digits, - and _, starting with a letter or digit",
    ],
  ])("refuses a sign-in block that doesn't read, naming the field: %j", (changes, error) => {
    expect(resolveKitConfig({ config: withUi(changes) })).toEqual({ ok: false, errors: [error] });
  });

  it("names every problem in a sign-in block at once", () => {
    const result = resolveKitConfig({
      config: withUi({
        url: "https://staging.example.com",
        sign_in: { owner: "" },
        signed_in_routes: [{ route: "/**", as: "admin" }],
      }),
    });

    expect(!result.ok && result.errors).toEqual([
      `ui.sign_in.owner is "": a sign-in command can't be blank`,
      "ui.sign_in_path is missing: with ui.sign_in, name the route the app sends a signed-out visitor to",
      `ui.signed_in_routes[0].as is "admin": it must be null or one of ui.sign_in's identities, owner`,
      `ui.url is "https://staging.example.com": a ui with sign_in serves on a loopback address, such as http://localhost:4321, so a sign-in only ever reaches the Sandbox's own server`,
    ]);
  });

  it("names every bad default route, not just the first", () => {
    const result = resolveKitConfig({ config: withUi({ default_routes: ["book", "/", "services"] }) });

    expect(!result.ok && result.errors).toEqual([
      `ui.default_routes[0] is "book": a route must be a path starting with one /, such as /book`,
      `ui.default_routes[2] is "services": a route must be a path starting with one /, such as /book`,
    ]);
  });

  it.each([
    "https://deploy-preview-{pr}--penrith-physio.netlify.app",
    "https://{branch_slug}-penrith-physio.workers.dev",
    "https://preview.example.dev/{pr}/{branch_slug}/{sha}",
    "https://staging.penrithphysio.com.au",
  ])("takes %s as a preview.url template", (url) => {
    const result = resolveKitConfig({ config: JSON.stringify({ preview: { url } }) });

    expect(result).toEqual({ ok: true, config: { ...DEFAULTS, preview: { url } } });
  });

  it.each([
    [
      "https://{branch}-penrith-physio.workers.dev",
      `preview.url is "https://{branch}-penrith-physio.workers.dev": {branch} is not a placeholder; a preview URL may use only {pr}, {branch_slug} and {sha}`,
    ],
    [
      "https://pr-{PR}.example.dev/{commit}",
      `preview.url is "https://pr-{PR}.example.dev/{commit}": {PR} and {commit} are not placeholders; a preview URL may use only {pr}, {branch_slug} and {sha}`,
    ],
    [
      "https://pr-{pr.example.dev",
      `preview.url is "https://pr-{pr.example.dev": it has a { or } that isn't part of a placeholder; a preview URL may use only {pr}, {branch_slug} and {sha}`,
    ],
    ["deploy-preview-{pr}.netlify.app", `preview.url is "deploy-preview-{pr}.netlify.app": a URL must start with http:// or https://`],
    ["{pr}", `preview.url is "{pr}": a URL must start with http:// or https://`],
    [42, "preview.url must be a string"],
  ])("refuses a preview.url with an unknown placeholder or that isn't http(s), naming it: %j", (url, error) => {
    expect(resolveKitConfig({ config: JSON.stringify({ preview: { url } }) })).toEqual({ ok: false, errors: [error] });
  });

  it.each([
    [withUi({ viewports: [{ name: "tablet", width: 768, height: 1024 }] }), "ui.viewports is not a Kit config field"],
    [withUi({ video: true }), "ui.video is not a Kit config field"],
    [withUi({ beforeUrl: "https://penrithphysio.com.au" }), "ui.beforeUrl is not a Kit config field"],
    [`{ "preview": { "url": null, "ready_timeout_minutes": 15 } }`, "preview.ready_timeout_minutes is not a Kit config field"],
    [`{ "previews": { "url": "https://pr-{pr}.example.dev" } }`, "previews is not a Kit config field"],
  ])("fails an unknown field under ui or preview, naming it: %s", (text, error) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
  });

  it.each([
    [`{ "ui": ["src/**"] }`, "ui must be an object or null"],
    [`{ "ui": false }`, "ui must be an object or null"],
    [`{ "preview": "https://pr-{pr}.example.dev" }`, "preview must be an object or null"],
  ])("fails a ui or preview block that isn't an object, naming it: %s", (text, error) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
  });

  it("names every problem in the ui and preview blocks at once", () => {
    const result = resolveKitConfig({
      config: JSON.stringify({
        ui: { paths: [], url: "localhost:4321", before_url: "ftp://penrithphysio.com.au", default_routes: ["book"], video: true },
        preview: { url: "https://{branch}.example.dev", bypass_header: "x-vercel-protection-bypass" },
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        "ui.paths is empty: list at least one glob of the files that make a pull request UI",
        "ui.serve is missing",
        `ui.url is "localhost:4321": a URL must start with http:// or https://`,
        `ui.before_url is "ftp://penrithphysio.com.au": a URL must start with http:// or https://`,
        `ui.default_routes[0] is "book": a route must be a path starting with one /, such as /book`,
        `preview.url is "https://{branch}.example.dev": {branch} is not a placeholder; a preview URL may use only {pr}, {branch_slug} and {sha}`,
        "ui.video is not a Kit config field",
        "preview.bypass_header is not a Kit config field",
      ],
    });
  });

  it("names the ui and preview problems alongside the rest of the Kit config's", () => {
    const result = resolveKitConfig({
      config: JSON.stringify({ max_in_flight: -1, ui: { serve: "npm run preview", url: "http://localhost:4321" } }),
    });

    expect(!result.ok && result.errors).toEqual(["max_in_flight must be a whole number of at least 0", "ui.paths is missing"]);
  });
});

describe("The production block, which says where a Product repo's production is", () => {
  it.each([`{}`, `{ "production": null }`])("declares no production for %s, and is valid", (text) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: true, config: DEFAULTS });
  });

  it("resolves an address with no environment to no environment, for a host that reports no Deployments", () => {
    const result = resolveKitConfig({ config: `{ "production": { "url": "https://shop.example" } }` });

    expect(result).toEqual({ ok: true, config: { ...DEFAULTS, production: { url: "https://shop.example", environment: null } } });
  });

  it("lets null say the host reports no Deployments", () => {
    const result = resolveKitConfig({ config: `{ "production": { "url": "http://shop.example:8080/", "environment": null } }` });

    expect(result).toEqual({
      ok: true,
      config: { ...DEFAULTS, production: { url: "http://shop.example:8080/", environment: null } },
    });
  });

  it("resolves an address and an environment to both", () => {
    const result = resolveKitConfig({
      config: `{ "production": { "url": "https://shop.example", "environment": "production" } }`,
    });

    expect(result).toEqual({
      ok: true,
      config: { ...DEFAULTS, production: { url: "https://shop.example", environment: "production" } },
    });
  });

  it.each([
    [{ environment: "production" }, "production.url is missing"],
    [{ url: null }, "production.url must be a string"],
    [{ url: "shop.example" }, `production.url is "shop.example": a URL must start with http:// or https://`],
    [{ url: "ftp://shop.example" }, `production.url is "ftp://shop.example": a URL must start with http:// or https://`],
    [{ url: "https://shop.example", environment: "" }, `production.environment is "": an environment can't be blank`],
    [{ url: "https://shop.example", environment: "  " }, `production.environment is "  ": an environment can't be blank`],
    [
      { url: "https://shop.example", environment: "production\nstaging" },
      `production.environment is "production\\nstaging": an environment is the one line GitHub's Deployments name it`,
    ],
    [{ url: "https://shop.example", environment: 42 }, "production.environment must be a string"],
    [{ url: "https://shop.example", region: "syd1" }, "production.region is not a Kit config field"],
    [{ url: "https://shop.example", before_url: "https://shop.example" }, "production.before_url is not a Kit config field"],
  ])("refuses a production block, naming the field: %j", (block, error) => {
    expect(resolveKitConfig({ config: JSON.stringify({ production: block }) })).toEqual({ ok: false, errors: [error] });
  });

  it.each([
    [`{ "production": "https://shop.example" }`, "production must be an object or null"],
    [`{ "production": ["https://shop.example"] }`, "production must be an object or null"],
  ])("refuses a production block that isn't an object, naming it: %s", (text, error) => {
    expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
  });

  it("declares production in a repo with no ui block, and leaves preview untouched", () => {
    const result = resolveKitConfig({
      config: JSON.stringify({ ui: null, preview: { url: null }, production: { url: "https://shop.example", environment: "production" } }),
    });

    expect(result).toEqual({
      ok: true,
      config: { ...DEFAULTS, ui: null, preview: null, production: { url: "https://shop.example", environment: "production" } },
    });
  });

  it("keeps production declared when ui.before_url is null, and never fills one from the other", () => {
    const result = resolveKitConfig({
      config: JSON.stringify({
        ui: { paths: ["src/**"], serve: "npm run preview", url: "http://localhost:4321", before_url: null },
        production: { url: "https://shop.example", environment: null },
      }),
    });

    expect(result.ok && result.config.ui?.beforeUrl).toBeNull();
    expect(result.ok && result.config.production).toEqual({ url: "https://shop.example", environment: null });
  });

  it("names every problem in the production block at once", () => {
    const result = resolveKitConfig({ config: JSON.stringify({ production: { environment: "", region: "syd1" } }) });

    expect(result).toEqual({
      ok: false,
      errors: [
        "production.url is missing",
        `production.environment is "": an environment can't be blank`,
        "production.region is not a Kit config field",
      ],
    });
  });
});

describe("Visual evidence's Kit constants, which no Kit config can change", () => {
  it("captures at one mobile and one desktop viewport, mobile first", () => {
    expect(UI_VIEWPORTS).toEqual([
      { name: "mobile", width: 390, height: 844 },
      { name: "desktop", width: 1440, height: 900 },
    ]);
  });

  it("gives the Reviewer at most 8 images", () => {
    expect(REVIEWER_IMAGE_CAP).toBe(8);
  });

  it.each(["viewports", "max_images", "reviewer_images"])("refuses ui.%s as an unknown field", (key) => {
    const result = resolveKitConfig({
      config: JSON.stringify({ ui: { paths: ["src/**"], serve: "npm run preview", url: "http://localhost:4321", [key]: 4 } }),
    });

    expect(result).toEqual({ ok: false, errors: [`ui.${key} is not a Kit config field`] });
  });
});

describe("Filling in a preview.url template for a pull request", () => {
  const pullRequest = { number: 51, branch: "fabrik/ticket-7", headSha: "4f2b9c0e1d3a5b7c9e0f2a4b6c8d0e1f3a5b7c9d" };

  it.each([
    ["https://deploy-preview-{pr}--penrith-physio.netlify.app", "https://deploy-preview-51--penrith-physio.netlify.app/"],
    ["https://{branch_slug}.penrith-physio.pages.dev/", "https://fabrik-ticket-7.penrith-physio.pages.dev/"],
    [
      "https://preview.example.dev/{pr}/{branch_slug}/{sha}?from={pr}",
      "https://preview.example.dev/51/fabrik-ticket-7/4f2b9c0e1d3a5b7c9e0f2a4b6c8d0e1f3a5b7c9d?from=51",
    ],
    ["https://staging.penrithphysio.com.au", "https://staging.penrithphysio.com.au/"],
  ])("fills %s in from the PR's number, its branch's slug and its head", (template, url) => {
    expect(previewUrl(template, pullRequest)).toBe(url);
  });

  it.each([
    ["fabrik/ticket-7", "fabrik-ticket-7"],
    ["fabrik/ticket-1234", "fabrik-ticket-1234"],
    ["Feature/Add_Waitlist--Page", "feature-add-waitlist-page"],
    ["/fabrik//ticket-7/", "fabrik-ticket-7"],
  ])("slugs the branch %s as %s: lower case, each run of anything but a letter or digit one -, none at either end", (branch, slug) => {
    expect(previewUrl("https://{branch_slug}.example.dev", { ...pullRequest, branch })).toBe(`https://${slug}.example.dev/`);
  });
});

describe("A captured route's page on a site, as a reader links it (#639)", () => {
  it.each([
    ["a bare base address", "https://shop.example", "/book", "https://shop.example/book"],
    ["a base address with a trailing slash", "https://shop.example/", "/book", "https://shop.example/book"],
    ["a base address with a path", "https://example.dev/shop", "/book", "https://example.dev/shop/book"],
    ["a base address with a path and a trailing slash", "https://example.dev/shop/", "/book", "https://example.dev/shop/book"],
    ["a route with a query", "https://shop.example/", "/book?when=today&who=me", "https://shop.example/book?when=today&who=me"],
    ["a route with a query, on a base with its own", "https://preview.example.dev/shop/?branch=fabrik-ticket-7", "/book?when=today", "https://preview.example.dev/shop/book?branch=fabrik-ticket-7&when=today"],
    ["the root route", "https://shop.example/", "/", "https://shop.example/"],
  ])("puts the route on the path of %s, with no doubled slash", (_what, base, route, page) => {
    expect(withRouteOn(base, route)).toBe(page);
  });

  it.each([
    ["an address on another host", "//evil.example/x"],
    ["a backslashed host", "/\\evil.example/x"],
    ["a full address", "/https://evil.example/x"],
  ])("keeps a route that spells %s on the base's host", (_what, route) => {
    expect(new URL(withRouteOn("https://shop.example", route)).host).toBe("shop.example");
  });

  it("builds a production page from the production block's address, whether or not it names an environment", () => {
    expect(productionPageUrl({ url: "https://shop.example/", environment: "production" }, "/book?when=today")).toBe("https://shop.example/book?when=today");
    expect(productionPageUrl({ url: "https://example.dev/shop", environment: null }, "/")).toBe("https://example.dev/shop/");
  });
});

describe("Which Capture identity views a route", () => {
  const ui: UiConfig = {
    paths: ["src/**"],
    serve: "pnpm start",
    url: "http://localhost:3000",
    beforeUrl: "https://app.example.com",
    defaultRoutes: [],
    signIn: { owner: "pnpm sign-in owner", operator: "pnpm sign-in operator" },
    signInPath: "/sign-in",
    signedInRoutes: [
      { route: "/pricing", as: null },
      { route: "/console/**", as: "operator" },
      { route: "/clinics/*/today", as: "owner" },
      { route: "/**", as: "owner" },
    ],
  };

  it.each([
    ["/pricing", null],
    ["/console", "operator"],
    ["/console/users/7", "operator"],
    ["/clinics/penrith/today", "owner"],
    ["/today", "owner"],
    ["/", "owner"],
  ])("takes the first rule that matches %s: %s", (route, identity) => {
    expect(captureIdentityOf(route, ui)).toBe(identity);
  });

  it("matches the route's path only, so a query or a fragment changes nothing", () => {
    expect(captureIdentityOf("/pricing?variant=a", ui)).toBeNull();
    expect(captureIdentityOf("/console?variant=b#top", ui)).toBe("operator");
  });

  it("reads a route no rule matches as public", () => {
    const rules: UiConfig = { ...ui, signedInRoutes: [{ route: "/console/**", as: "operator" }] };

    expect(captureIdentityOf("/today", rules)).toBeNull();
  });

  it("reads `*` as one segment, so it never reaches across a /", () => {
    const rules: UiConfig = { ...ui, signedInRoutes: [{ route: "/clinics/*", as: "owner" }] };

    expect(captureIdentityOf("/clinics/penrith", rules)).toBe("owner");
    expect(captureIdentityOf("/clinics/penrith/today", rules)).toBeNull();
  });

  it("reads `/**` as matching `/`", () => {
    expect(captureIdentityOf("/", { ...ui, signedInRoutes: [{ route: "/**", as: "operator" }] })).toBe("operator");
  });

  it("matches a pattern's other characters as they are", () => {
    const rules: UiConfig = { ...ui, signedInRoutes: [{ route: "/a.b+(c)", as: "owner" }] };

    expect(captureIdentityOf("/a.b+(c)", rules)).toBe("owner");
    expect(captureIdentityOf("/aXb+(c)", rules)).toBeNull();
  });

  it("views every route signed out when Kit config signs nothing in", () => {
    const { signIn: _signIn, signInPath: _signInPath, signedInRoutes: _rules, ...plain } = ui;

    expect(captureIdentityOf("/today", plain)).toBeNull();
  });
});
