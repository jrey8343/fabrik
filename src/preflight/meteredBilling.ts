// The metered-billing preflight: a pure check that fails closed on any route by
// which an agent run could bill metered API usage instead of the Operator's
// Ultra subscription. A refusal is an Infrastructure failure.

/** One settings file the agent will load, as raw text. */
export interface SettingsFile {
  readonly path: string;
  readonly text: string;
}

/** Everything that decides how the agent authenticates, gathered just before launch. */
export interface PreflightInput {
  /** The agent's fully resolved env, including whatever it inherits from the runner. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly settingsFiles: readonly SettingsFile[];
  /** The `claude` launch arguments. */
  readonly args: readonly string[];
  /** The stdout of `claude auth status --json`. */
  readonly authStatus: string;
}

export type PreflightResult =
  | { readonly kind: "pass" }
  | {
      readonly kind: "refuse";
      readonly failure: "infrastructure";
      /** Every refused route found, each naming where it was found. */
      readonly routes: readonly string[];
    };

// Env variables that make `claude` authenticate with something other than the
// Operator's OAuth token, or send its requests somewhere other than Anthropic's
// first-party API on that token.
const METERED_ENV_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  // Set by --bare, which never reads CLAUDE_CODE_OAUTH_TOKEN.
  "CLAUDE_CODE_SIMPLE",
]);

// Any CLAUDE_CODE_USE_* picks a cloud provider. The prefix also matches
// CLAUDE_CODE_USE_POWERSHELL_TOOL, which isn't a provider but never matters on a
// Linux runner, so the whole prefix is refused to keep up with new providers.
const METERED_ENV_PREFIXES = ["CLAUDE_CODE_USE_", "ANTHROPIC_FOUNDRY_", "ANTHROPIC_AWS_"];

function isMeteredEnvName(name: string): boolean {
  return METERED_ENV_NAMES.has(name) || METERED_ENV_PREFIXES.some((p) => name.startsWith(p));
}

/** Names of the variables in `env` that are set, even to "", and open a metered route. */
function meteredEnvNames(env: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined && isMeteredEnvName(name))
    .sort();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

// A settings file's env block applies however `claude` is launched, so it is
// held to the env rule, and refuses every ANTHROPIC_* name as well.
function settingsRoutes({ path, text }: SettingsFile): string[] {
  const settings = parseObject(text);
  if (settings === null) return [`${path} is not a JSON object, so it can't be checked`];

  const routes: string[] = [];
  if ("apiKeyHelper" in settings) routes.push(`${path} sets apiKeyHelper`);
  if (isObject(settings.env)) {
    const env = settings.env;
    const names = Object.keys(env)
      .filter((name) => name.startsWith("ANTHROPIC_") || isMeteredEnvName(name))
      .sort();
    routes.push(...names.map((name) => `${path} sets ${name} in its env block`));
  }
  return routes;
}

function shown(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

// Auth status alone is not enough: it reports ANTHROPIC_AUTH_TOKEN as
// oauth_token and hides an API key beside the OAuth token. The env and settings
// checks are the real gate; this catches whatever they miss.
function authStatusRoutes(text: string): string[] {
  const status = parseObject(text);
  if (status === null) return ["claude auth status output is not a JSON object, so it can't be checked"];

  const routes: string[] = [];
  if (status.loggedIn !== true) routes.push("claude auth status reports not logged in");
  if (status.authMethod !== "oauth_token") {
    routes.push(`claude auth status reports auth method ${shown(status.authMethod)}, not "oauth_token"`);
  }
  if (status.apiProvider !== "firstParty") {
    routes.push(`claude auth status reports API provider ${shown(status.apiProvider)}, not "firstParty"`);
  }
  if ("apiKeySource" in status) {
    routes.push(`claude auth status reports API key source ${shown(status.apiKeySource)}`);
  }
  return routes;
}

export function checkMeteredBilling(input: PreflightInput): PreflightResult {
  const routes = [
    ...meteredEnvNames(input.env).map((name) => `${name} is set in the agent's env`),
    ...input.settingsFiles.flatMap(settingsRoutes),
    ...(input.args.includes("--bare") ? ["--bare is in the launch arguments"] : []),
    ...authStatusRoutes(input.authStatus),
  ];
  return resultOf(routes);
}

/**
 * The backstop once the agent starts: given the stream's parsed `system/init`
 * message, refuses unless it reports an API key source of `none`. `none` also
 * covers bearer tokens and cloud providers, which only the preflight catches.
 */
export function checkInitMessage(message: unknown): PreflightResult {
  if (!isObject(message) || message.type !== "system" || message.subtype !== "init") {
    return resultOf(["the stream's init message is missing or malformed, so it can't be checked"]);
  }
  if (message.apiKeySource === "none") return resultOf([]);
  return resultOf([
    `the stream's init message reports API key source ${shown(message.apiKeySource)}, not "none"`,
  ]);
}

function resultOf(routes: readonly string[]): PreflightResult {
  return routes.length === 0 ? { kind: "pass" } : { kind: "refuse", failure: "infrastructure", routes };
}
