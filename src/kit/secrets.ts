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
  const resolved = JSON.parse(resolvedJson) as Record<string, unknown>;
  const take = (name: string): string => {
    const value = resolved[name];
    if (typeof value !== "string" || value === "") throw new Error(`1Password didn't resolve ${name}`);
    return value;
  };
  const env: Record<string, string> = { [CLAUDE_TOKEN_ENV]: take(CLAUDE_TOKEN_ENV), ...config.sandbox.env };
  for (const name of Object.keys(config.sandbox.secrets)) env[name] = take(name);
  return env;
}
