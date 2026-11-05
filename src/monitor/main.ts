// The Monitor's program (#148): reads the Product repo's Kit config from the
// default branch and checks it as the Loop does, gathers the Monitor's GitHub
// facts (src/github/monitorFacts.ts) and Sentry's (./sentryApi.ts), plans with
// the Monitor core (./core.ts), files, rewrites and closes what the plan says,
// and writes the step summary. It talks to GitHub and Sentry through their
// APIs alone: it never checks out or runs Product code, makes no model call
// and writes no Run record. The scheduled tick runs it hourly, in its own
// Monitor job (.github/workflows/schedule.yml).
//   node src/monitor/main.ts
// Reads FABRIK_APP_TOKEN, the Fabrik App's token on the Product repo, and
// FABRIK_APP_SLUG, the App's slug, which names the issues it opened. When
// monitor.errors is set, FABRIK_SENTRY_TOKEN is the Sentry token, empty when
// its 1Password item is missing or couldn't be read. A Sentry API error is a
// warning in the step summary, never a failed run, and red main still runs.
// Red main reads check runs through the App's Checks: read; while the App
// lacks it, GitHub refuses them and red main is a quiet dormant note.
import { appendFile } from "node:fs/promises";
import { GitHub, type Repo } from "../github/client.ts";
import { gatherMonitorFacts } from "../github/monitorFacts.ts";
import { readKitConfigSources } from "../github/snapshot.ts";
import { callerWorkflowPath, checkKit } from "../kit/caller.ts";
import { type KitConfig, resolveKitConfig } from "../kit/config.ts";
import { groupsNeedingLatestEvent, type MonitorInput, monitorPlanFor, type SentryRead } from "./core.ts";
import type { MonitorPlan } from "./issues.ts";
import { readSentry, withLatestEvents } from "./sentryApi.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function report(lines: readonly string[]): Promise<void> {
  const text = lines.map((line) => `- ${line}`).join("\n");
  console.log(text);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") await appendFile(summary, `### Monitor\n\n${text}\n`);
}

/**
 * Loads and checks the Product repo's Kit config and caller workflow at the
 * commit this run is for, the default branch's head on the scheduled tick, as
 * the Loop does (src/main.ts). Returns null, having reported why, when either is invalid.
 */
async function loadKit(github: GitHub, repo: Repo): Promise<KitConfig | null> {
  const ref = required("GITHUB_SHA");
  const path = callerWorkflowPath(required("GITHUB_WORKFLOW_REF"), repo);
  const [sources, text] = await Promise.all([readKitConfigSources(github, repo, ref), github.fileText(repo, path, ref)]);
  const check = checkKit(resolveKitConfig(sources), { path, text });
  if (!check.ok) {
    for (const error of check.errors) console.log(`::error title=Invalid Kit config::${error}`);
    await report([`The Kit config is invalid, so the Monitor did nothing: ${check.errors.join("; ")}`]);
    return null;
  }
  return check.config;
}

/** Files each issue the plan opens, rewrites each body it rewrites and closes what it closes, returning a step-summary line for each. */
async function apply(github: GitHub, repo: Repo, plan: MonitorPlan): Promise<string[]> {
  const lines: string[] = [];
  for (const issue of plan.open) {
    // Labels go on with the issue, so the issues.opened run it starts already sees them.
    const filed = (await github.rest("POST", `/repos/${repo.owner}/${repo.name}/issues`, {
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
    })) as { number: number };
    lines.push(`Filed #${filed.number}: ${issue.title}`);
  }
  for (const rewrite of plan.rewrite) {
    // Only the body changes: no comment, and an edit is no event the caller's workflow runs on.
    await github.rest("PATCH", `/repos/${repo.owner}/${repo.name}/issues/${rewrite.issue}`, { body: rewrite.body });
    lines.push(rewrite.summary);
  }
  for (const close of plan.close) {
    // The note goes first, so the close right after it reads as the Monitor's own in the issue's timeline.
    await github.rest("POST", `/repos/${repo.owner}/${repo.name}/issues/${close.issue}/comments`, { body: close.comment });
    await github.rest("PATCH", `/repos/${repo.owner}/${repo.name}/issues/${close.issue}`, { state: "closed", state_reason: "completed" });
    lines.push(`Closed #${close.issue} as completed: the default branch is green again.`);
  }
  return lines;
}

async function main(): Promise<void> {
  const [owner, name] = required("GITHUB_REPOSITORY").split("/");
  if (owner === undefined || name === undefined) throw new Error("GITHUB_REPOSITORY is not owner/name");
  const repo: Repo = { owner, name };
  const github = new GitHub(required("FABRIK_APP_TOKEN"), process.env["GITHUB_API_URL"] || undefined);

  const config = await loadKit(github, repo);
  if (config === null) {
    process.exitCode = 1;
    return;
  }
  const { errors, redMain } = config.monitor;
  const gatingChecks = config.sandbox.checks;
  const sentryToken = process.env["FABRIK_SENTRY_TOKEN"] ?? "";
  const [facts, sentry] = await Promise.all([
    gatherMonitorFacts(github, repo, { appLogin: `${required("FABRIK_APP_SLUG")}[bot]`, redMain, gatingChecks }),
    readSentry(errors, sentryToken),
  ]);
  const inputWith = (read: SentryRead | null): MonitorInput => ({
    monitor: config.monitor,
    sentry: read,
    issues: facts.issues,
    gatingChecks,
    mainChecks: facts.mainChecks,
    cap: config.caps.monitorIssues,
    now: new Date().toISOString(),
  });
  // Which groups are filed and held never depends on their latest events, so a
  // plan with the groups as listed names the ones whose latest event to read.
  const asListed = monitorPlanFor(inputWith(sentry));
  const plan = monitorPlanFor(inputWith(await withLatestEvents(sentry, errors, sentryToken, groupsNeedingLatestEvent(asListed))));
  await report([...(await apply(github, repo, plan)), ...plan.summary]);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
