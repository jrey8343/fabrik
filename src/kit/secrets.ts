// Test secrets (ADR-0004): declared in Kit config as op:// references, resolved
// by load-secrets-action in output mode in the Implement step's env only, so
// adding one never means editing the caller workflow. Pure, no I/O.
import type { KitConfig } from "./config.ts";

/** The env var the Claude token reaches the agent through. */
export const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/** The OP_ENV_FILE for load-secrets-action: one `NAME=op://…` line per test secret. */
export function secretsTemplate(config: KitConfig): string {
  return Object.entries(config.sandbox.secrets)
    .map(([name, reference]) => `${name}=${reference}\n`)
    .join("");
}

/**
 * The env the Implementer runs with, from the action's outputs (passed on as
 * `toJSON(steps.op.outputs)`): the Claude token, the Sandbox's values and each
 * declared test secret. Anything declared but unresolved fails the run.
 */
export function sandboxEnv(config: KitConfig, resolvedJson: string): Record<string, string> {
  return { [CLAUDE_TOKEN_ENV]: resolvedValue(resolvedJson, CLAUDE_TOKEN_ENV), ...testEnv(config, resolvedJson) };
}

/**
 * The env a Replay arm's gates run the Sandbox's commands with (#156), from
 * the same outputs: the Sandbox's values and each declared test secret, and
 * never the Claude token, since no agent runs there. Anything declared but
 * unresolved fails the run.
 */
export function testEnv(config: KitConfig, resolvedJson: string): Record<string, string> {
  const env: Record<string, string> = { ...config.sandbox.env };
  for (const name of Object.keys(config.sandbox.secrets)) env[name] = resolvedValue(resolvedJson, name);
  return env;
}

/** One value 1Password resolved, or a throw when it didn't. */
function resolvedValue(resolvedJson: string, name: string): string {
  const value = (JSON.parse(resolvedJson) as Record<string, unknown>)[name];
  if (typeof value !== "string" || value === "") throw new Error(`1Password didn't resolve ${name}`);
  return value;
}
