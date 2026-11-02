// Entry point for a Kit push job: event + snapshot + config -> plan -> applied.
// Run with `node src/main.ts` (Node 24 strips the types).
import { appendFile, readFile } from "node:fs/promises";
import { applyPlan, gatherSnapshot, GitHub, loopEventFrom, type Repo } from "./github/adapter.ts";
import { planFor } from "./loop/rules.ts";
import type { KitConfig, Plan } from "./loop/types.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function describe(plan: Plan): string {
  if (plan.kind === "nothing") return `Nothing to do: ${plan.reason}`;
  return plan.actions.map((action) => `- ${action.kind} on #${action.issue}: ${action.labels.join(", ")}`).join("\n");
}

async function report(text: string): Promise<void> {
  console.log(text);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") {
    await appendFile(summary, `### Fabrik Loop\n\n${text}\n`);
  }
}

async function main(): Promise<void> {
  const eventName = required("GITHUB_EVENT_NAME");
  const payload = JSON.parse(await readFile(required("GITHUB_EVENT_PATH"), "utf8")) as Record<string, unknown>;
  const event = loopEventFrom(eventName, payload);
  if (event === null) {
    await report(`Nothing to do: the Loop doesn't act on ${eventName}.${String(payload["action"] ?? "")}`);
    return;
  }

  const [owner, name] = required("GITHUB_REPOSITORY").split("/");
  if (owner === undefined || name === undefined) {
    throw new Error("GITHUB_REPOSITORY is not owner/name");
  }
  const repo: Repo = { owner, name };
  // Only the Fabrik App's token: changes made with GITHUB_TOKEN don't start later workflows.
  const github = new GitHub(required("FABRIK_APP_TOKEN"), process.env["GITHUB_API_URL"]);
  const config: KitConfig = {};

  const snapshot = await gatherSnapshot(github, repo, event);
  const plan = planFor(event, snapshot, config);
  await applyPlan(github, repo, plan);
  await report(describe(plan));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
