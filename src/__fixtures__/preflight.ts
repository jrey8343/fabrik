// Fixtures for the metered-billing preflight: a clean launch on the Operator's
// OAuth token, which each test bends into one refused route.

import type { PreflightInput } from "../preflight/meteredBilling.ts";

/** `claude auth status --json` as observed with only CLAUDE_CODE_OAUTH_TOKEN set. */
export const oauthAuthStatus = {
  loggedIn: true,
  authMethod: "oauth_token",
  apiProvider: "firstParty",
  analyticsDisabled: false,
  projectsDirectory: "/home/runner/.claude/projects",
  configDirectory: "/home/runner/.claude",
};

export const userSettingsPath = "/home/runner/.claude/settings.json";
export const projectSettingsPath = "/home/runner/work/product/.claude/settings.json";

/** A clean launch, with any part replaced. */
export function cleanLaunch(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/runner",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-fixture",
    },
    settingsFiles: [
      {
        path: projectSettingsPath,
        text: JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, env: { CI: "true" } }),
      },
    ],
    args: ["-p", "/implement #12", "--output-format", "stream-json", "--verbose"],
    authStatus: JSON.stringify(oauthAuthStatus),
    ...overrides,
  };
}

/** The clean env with extra variables set. */
export function envWith(extra: Record<string, string>): PreflightInput["env"] {
  return { ...cleanLaunch().env, ...extra };
}

/** A clean launch that also loads one settings file at `path` with these contents. */
export function withSettings(path: string, contents: unknown): PreflightInput {
  return cleanLaunch({
    settingsFiles: [...cleanLaunch().settingsFiles, { path, text: JSON.stringify(contents) }],
  });
}

/** `claude auth status --json` output with some fields replaced. */
export function authStatusWith(fields: Record<string, unknown>): string {
  return JSON.stringify({ ...oauthAuthStatus, ...fields });
}
