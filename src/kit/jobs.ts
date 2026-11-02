// The Kit job's step: validates the Product's Kit config (read as data from a
// sparse checkout, never run) and tells the workflow which job this event
// routes to and the settings its jobs need before they start, such as their
// timeout-minutes. Writes step outputs:
//   route                    "triage", or "push" for events the push job handles alone
//   triage-timeout-minutes   the Triage role's Kit config timeout
//   node src/kit/jobs.ts <product checkout>
import { appendFile, readFile } from "node:fs/promises";
import { agentRoleFor } from "../github/adapter.ts";
import { readKitConfigFromCheckout } from "./checkout.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function main(productDir: string): Promise<void> {
  const resolved = await readKitConfigFromCheckout(productDir);
  if (!resolved.ok) {
    for (const error of resolved.errors) console.log(`::error title=Invalid Kit config::${error}`);
    process.exitCode = 1;
    return;
  }

  const payload = JSON.parse(await readFile(required("GITHUB_EVENT_PATH"), "utf8")) as Record<string, unknown>;
  const route = agentRoleFor(required("GITHUB_EVENT_NAME"), payload) ?? "push";
  const outputs = { route, "triage-timeout-minutes": String(resolved.config.roles.triage.timeoutMinutes) };
  await appendFile(
    required("GITHUB_OUTPUT"),
    Object.entries(outputs)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
  console.log(`Route: ${route}`);
}

const productDir = process.argv[2];
if (productDir === undefined) {
  console.error("Usage: node src/kit/jobs.ts <product checkout>");
  process.exitCode = 2;
} else {
  main(productDir).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
