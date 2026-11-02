// The metered-billing preflight as a command, for the agent job's last
// onSandboxReady hook (chained after the Product's sandbox.setup, because
// Sandcastle runs hooks in parallel). It runs inside the Sandbox with the
// agent's own env, gathers what the pure check needs, and exits non-zero on
// any refused route, which fails the run before the agent starts.
//   node src/preflight/main.ts
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkMeteredBilling, type SettingsFile } from "./meteredBilling.ts";

/** The `claude` launch arguments, as JSON, set by the agent runner (src/agent/run.ts). */
export const CLAUDE_ARGS_ENV = "FABRIK_CLAUDE_ARGS";

const MANAGED_DIR = "/etc/claude-code";

async function readIfPresent(path: string): Promise<SettingsFile[]> {
  try {
    return [{ path, text: await readFile(path, "utf8") }];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function managedDropIns(): Promise<string[]> {
  const dir = join(MANAGED_DIR, "managed-settings.d");
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".json")).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Every settings file the agent will load on a Linux runner, from the checkout in `cwd`. */
async function settingsFiles(cwd: string): Promise<SettingsFile[]> {
  const configDir = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
  const paths = [
    join(MANAGED_DIR, "managed-settings.json"),
    ...(await managedDropIns()),
    join(configDir, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
  return (await Promise.all(paths.map(readIfPresent))).flat();
}

function launchArgs(): string[] {
  const text = process.env[CLAUDE_ARGS_ENV];
  if (text === undefined) throw new Error(`${CLAUDE_ARGS_ENV} is not set, so the launch arguments can't be checked`);
  const args: unknown = JSON.parse(text);
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error(`${CLAUDE_ARGS_ENV} is not a JSON list of strings`);
  }
  return args;
}

async function main(): Promise<void> {
  const auth = spawnSync("claude", ["auth", "status", "--json"], { encoding: "utf8", env: process.env });
  const result = checkMeteredBilling({
    env: process.env,
    settingsFiles: await settingsFiles(process.cwd()),
    args: launchArgs(),
    authStatus: auth.stdout ?? "",
  });
  if (result.kind === "pass") {
    console.log("Metered-billing preflight passed: the agent will run on the Operator's OAuth token.");
    return;
  }
  console.error("Metered-billing preflight refused the run (Infrastructure failure):");
  for (const route of result.routes) console.error(`::error title=Metered-billing route::${route}`);
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`Metered-billing preflight could not run, so it refuses: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
