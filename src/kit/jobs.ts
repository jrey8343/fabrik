// The Kit job's step: validates the Product's Kit config (read as data from a
// sparse checkout, never run), asks the Loop rules core what this event calls
// for, and tells the workflow which job it routes to and the settings its jobs
// need before they start, such as their timeout-minutes. Writes step outputs:
//   route                    "triage" or "design" when the plan starts that agent run,
//                            "push" when the push job has something to apply,
//                            "none" when the plan is to do nothing
//   triage-timeout-minutes   the Triage role's Kit config timeout
//   design-timeout-minutes   the Design-session turn's Kit config timeout
//   node src/kit/jobs.ts <product checkout>
// Env: GH_TOKEN, a read-only token for gathering the snapshot.
import { appendFile, readFile } from "node:fs/promises";
import { agentRunIn, gatherSnapshot, GitHub, loopEventFrom, operatorFor, type Repo } from "../github/adapter.ts";
import { planFor } from "../loop/rules.ts";
import type { Plan } from "../loop/types.ts";
import { readKitConfigFromCheckout } from "./checkout.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

function routeOf(plan: Plan): string {
  const run = agentRunIn(plan);
  if (run !== null) return run.role;
  return plan.kind === "nothing" ? "none" : "push";
}

async function main(productDir: string): Promise<void> {
  const resolved = await readKitConfigFromCheckout(productDir);
  if (!resolved.ok) {
    for (const error of resolved.errors) console.log(`::error title=Invalid Kit config::${error}`);
    process.exitCode = 1;
    return;
  }
  const { config } = resolved;

  const eventName = required("GITHUB_EVENT_NAME");
  const payload = JSON.parse(await readFile(required("GITHUB_EVENT_PATH"), "utf8")) as Record<string, unknown>;
  const event = loopEventFrom(eventName, payload);
  let route = "none";
  if (event === null) {
    console.log(`The Loop doesn't act on ${eventName}.${String(payload["action"] ?? "")}`);
  } else {
    const [owner, name] = required("GITHUB_REPOSITORY").split("/");
    const repo: Repo = { owner: owner ?? "", name: name ?? "" };
    const github = new GitHub(required("GH_TOKEN"), process.env["GITHUB_API_URL"]);
    const plan = planFor(event, await gatherSnapshot(github, repo, event, operatorFor(config, payload)), config);
    if (plan.kind === "nothing") console.log(`Nothing to do: ${plan.reason}`);
    route = routeOf(plan);
  }

  const outputs = {
    route,
    "triage-timeout-minutes": String(config.roles.triage.timeoutMinutes),
    "design-timeout-minutes": String(config.roles.design.timeoutMinutes),
  };
  await appendFile(
    required("GITHUB_OUTPUT"),
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
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
