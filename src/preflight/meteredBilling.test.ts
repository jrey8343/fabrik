import { describe, expect, it } from "vitest";
import {
  authStatusWith,
  cleanLaunch,
  envWith,
  oauthAuthStatus,
  projectSettingsPath,
  userSettingsPath,
  withSettings,
} from "../__fixtures__/preflight.ts";
import { checkMeteredBilling } from "./meteredBilling.ts";

describe("metered-billing preflight", () => {
  it("passes a clean env, settings, args and OAuth auth status", () => {
    expect(checkMeteredBilling(cleanLaunch())).toEqual({ kind: "pass" });
  });

  describe("refuses a metered route in the env", () => {
    it.each([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_MANTLE",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS",
      "CLAUDE_CODE_USE_SOME_FUTURE_PROVIDER",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "ANTHROPIC_VERTEX_BASE_URL",
      "ANTHROPIC_FOUNDRY_API_KEY",
      "ANTHROPIC_AWS_REGION",
      "ANTHROPIC_PROFILE",
      "AWS_BEARER_TOKEN_BEDROCK",
      "CLAUDE_CODE_SIMPLE",
    ])("refuses %s in the env, naming it", (name) => {
      const result = checkMeteredBilling(cleanLaunch({ env: envWith({ [name]: "x" }) }));

      expect(result).toEqual({
        kind: "refuse",
        failure: "infrastructure",
        routes: [`${name} is set in the agent's env`],
      });
    });

    it("refuses an env variable even when it is set to an empty string", () => {
      const result = checkMeteredBilling(cleanLaunch({ env: envWith({ ANTHROPIC_API_KEY: "" }) }));

      expect(result).toEqual({
        kind: "refuse",
        failure: "infrastructure",
        routes: ["ANTHROPIC_API_KEY is set in the agent's env"],
      });
    });

    it("ignores an env variable that is present but undefined", () => {
      const env = { ...cleanLaunch().env, ANTHROPIC_API_KEY: undefined };

      expect(checkMeteredBilling(cleanLaunch({ env }))).toEqual({ kind: "pass" });
    });

    it("names every route it finds, not just the first", () => {
      const env = envWith({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_VERTEX: "1" });

      expect(checkMeteredBilling(cleanLaunch({ env }))).toEqual({
        kind: "refuse",
        failure: "infrastructure",
        routes: [
          "ANTHROPIC_API_KEY is set in the agent's env",
          "CLAUDE_CODE_USE_VERTEX is set in the agent's env",
        ],
      });
    });

    it("does not refuse a harmless variable that merely shares a word, such as CLAUDE_CODE_OAUTH_TOKEN", () => {
      const env = envWith({ CLAUDE_CODE_OAUTH_TOKEN: "t", MY_ANTHROPIC_API_KEY_NOTE: "n" });

      expect(checkMeteredBilling(cleanLaunch({ env }))).toEqual({ kind: "pass" });
    });
  });

  describe("refuses a metered route in a settings file the agent will load", () => {
    it("refuses an apiKeyHelper, naming the file", () => {
      const result = checkMeteredBilling(
        withSettings(userSettingsPath, { apiKeyHelper: "/bin/generate-key.sh" }),
      );

      expect(result).toEqual({
        kind: "refuse",
        failure: "infrastructure",
        routes: [`${userSettingsPath} sets apiKeyHelper`],
      });
    });

    it.each(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_ANYTHING"])(
      "refuses %s in a settings env block, naming the file",
      (name) => {
        const result = checkMeteredBilling(withSettings(projectSettingsPath, { env: { [name]: "x" } }));

        expect(result).toEqual({
          kind: "refuse",
          failure: "infrastructure",
          routes: [`${projectSettingsPath} sets ${name} in its env block`],
        });
      },
    );

    it("refuses any other metered variable in a settings env block, such as CLAUDE_CODE_USE_BEDROCK", () => {
      const result = checkMeteredBilling(
        withSettings(userSettingsPath, { env: { CLAUDE_CODE_USE_BEDROCK: "1" } }),
      );

      expect(result).toEqual({
        kind: "refuse",
        failure: "infrastructure",
        routes: [`${userSettingsPath} sets CLAUDE_CODE_USE_BEDROCK in its env block`],
      });
    });

    it("refuses a settings file it can't parse, because it can't tell what the file sets", () => {
      const settingsFiles = [{ path: userSettingsPath, text: "{ not json" }];

      expect(checkMeteredBilling(cleanLaunch({ settingsFiles }))).toEqual({
        kind: "refuse",
        failure: "infrastructure",
        routes: [`${userSettingsPath} is not a JSON object, so it can't be checked`],
      });
    });

    it("refuses a settings file whose top level is not an object", () => {
      const settingsFiles = [{ path: userSettingsPath, text: "[]" }];

      expect(checkMeteredBilling(cleanLaunch({ settingsFiles }))).toEqual({
        kind: "refuse",
        failure: "infrastructure",
        routes: [`${userSettingsPath} is not a JSON object, so it can't be checked`],
      });
    });

    it("passes when no settings files will be loaded", () => {
      expect(checkMeteredBilling(cleanLaunch({ settingsFiles: [] }))).toEqual({ kind: "pass" });
    });
  });

  describe("refuses --bare in the launch arguments", () => {
    it("refuses --bare, because it never reads the OAuth token", () => {
      const args = [...cleanLaunch().args, "--bare"];

      expect(checkMeteredBilling(cleanLaunch({ args }))).toEqual({
        kind: "refuse",
        failure: "infrastructure",
        routes: ["--bare is in the launch arguments"],
      });
    });

    it("does not mistake a prompt that mentions --bare for the flag", () => {
      const args = ["-p", "explain what --bare does", "--output-format", "stream-json"];

      expect(checkMeteredBilling(cleanLaunch({ args }))).toEqual({ kind: "pass" });
    });
  });

  describe("refuses an auth method other than the OAuth token", () => {
    it.each([
      ["an API key", { authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY" }],
      ["an apiKeyHelper", { authMethod: "api_key_helper", apiKeySource: "apiKeyHelper" }],
      ["a cloud provider", { authMethod: "third_party", apiProvider: "bedrock" }],
    ])("refuses %s reported by claude auth status", (_route, fields) => {
      const result = checkMeteredBilling(cleanLaunch({ authStatus: authStatusWith(fields) }));

      expect(result).toMatchObject({ kind: "refuse", failure: "infrastructure" });
      expect(result.kind === "refuse" && result.routes[0]).toMatch(/^claude auth status reports /);
    });

    it("names the auth method it found", () => {
      const result = checkMeteredBilling(
        cleanLaunch({ authStatus: authStatusWith({ authMethod: "api_key" }) }),
      );

      expect(result).toEqual({
        kind: "refuse",
        failure: "infrastructure",
        routes: ['claude auth status reports auth method "api_key", not "oauth_token"'],
      });
    });

    it("names a provider other than firstParty", () => {
      const result = checkMeteredBilling(
        cleanLaunch({ authStatus: authStatusWith({ apiProvider: "vertex" }) }),
      );

      expect(result).toEqual({
        kind: "refuse",
        failure: "infrastructure",
        routes: ['claude auth status reports API provider "vertex", not "firstParty"'],
      });
    });

    it("refuses any API key source, even beside the OAuth token", () => {
      const result = checkMeteredBilling(
        cleanLaunch({ authStatus: authStatusWith({ apiKeySource: "ANTHROPIC_API_KEY" }) }),
      );

      expect(result).toEqual({
        kind: "refuse",
        failure: "infrastructure",
        routes: ['claude auth status reports API key source "ANTHROPIC_API_KEY"'],
      });
    });

    it("refuses when not logged in", () => {
      const result = checkMeteredBilling(
        cleanLaunch({ authStatus: authStatusWith({ loggedIn: false }) }),
      );

      expect(result).toEqual({
        kind: "refuse",
        failure: "infrastructure",
        routes: ["claude auth status reports not logged in"],
      });
    });

    it("refuses when the auth method is missing", () => {
      const { authMethod: _omitted, ...rest } = oauthAuthStatus;

      const result = checkMeteredBilling(cleanLaunch({ authStatus: JSON.stringify(rest) }));

      expect(result).toEqual({
        kind: "refuse",
        failure: "infrastructure",
        routes: ['claude auth status reports auth method undefined, not "oauth_token"'],
      });
    });

    it.each(["", "Auth token: CLAUDE_CODE_OAUTH_TOKEN", "null"])(
      "refuses auth status output it can't read as JSON (%j)",
      (authStatus) => {
        expect(checkMeteredBilling(cleanLaunch({ authStatus }))).toEqual({
          kind: "refuse",
          failure: "infrastructure",
          routes: ["claude auth status output is not a JSON object, so it can't be checked"],
        });
      },
    );
  });
});
