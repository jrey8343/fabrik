// The daily Tick check's program (#461, .github/workflows/dead-tick.yml),
// on the fabrik-runs store's caller, since a Tick can't be watched from the
// repo where it died: reads every Product repo's last started Tick
// (src/github/tickFacts.ts) and the repos with recent Run records in the
// store's sparse checkout of runs/, plans what to open and close
// (src/kit/deadTick.ts) and applies it, writing the step summary's lines.
//   node src/kit/dead-tick-main.ts
// Reads one Fabrik App token, FABRIK_TICK_CHECK_TOKEN, on every installed
// repo with Checks read, Contents read and Issues write. FABRIK_STORE_DIR is
// the store's checkout, and FABRIK_APP_SLUG the Fabrik App's slug, which
// tells its own issues from anyone else's.
import { appendFile } from "node:fs/promises";
import { GitHub, GitHubError } from "../github/client.ts";
import { productReposOf } from "../github/facts.ts";
import { readProductTicks } from "../github/tickFacts.ts";
import { DEAD_TICK_LABEL } from "../loop/labels.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type DeadTickIssue, type DeadTickPlan, deadTickPlan, recentReposOf } from "./deadTick.ts";
import { RUN_STORE, RUN_STORE_REPO } from "./runStore.ts";
import { readStoreRunRecords } from "./storeCheckout.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function report(lines: readonly string[]): Promise<void> {
  const text = lines.length === 0 ? "No Product repo to check." : lines.map((line) => `- ${line}`).join("\n");
  console.log(text);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") await appendFile(summary, `### Tick check\n\n${text}\n`);
}

/** The store's open fabrik:dead-tick issues, each for a repo the App couldn't reach. */
async function storeIssues(github: GitHub, appLogin: string): Promise<DeadTickIssue[]> {
  const issues = (await github.rest(
    "GET",
    `/repos/${RUN_STORE_REPO}/issues?labels=${encodeURIComponent(DEAD_TICK_LABEL)}&state=open&per_page=100`,
  )) as { number: number; body: string | null; user: { login: string } | null; pull_request?: unknown }[];
  return issues
    .filter((issue) => issue.pull_request === undefined)
    .map((issue) => ({ number: issue.number, body: issue.body ?? "", byApp: issue.user?.login === appLogin }));
}

async function ensureLabel(github: GitHub, repo: string): Promise<void> {
  try {
    await github.rest("POST", `/repos/${repo}/labels`, {
      name: DEAD_TICK_LABEL,
      color: "b60205",
      description: "Fabrik: the hourly Tick hasn't started for 25 hours, or the Fabrik App can't reach a repo",
    });
  } catch (error) {
    // 422: it's already there.
    if (!(error instanceof GitHubError && error.status === 422)) throw error;
  }
}

async function apply(github: GitHub, plan: DeadTickPlan): Promise<string[]> {
  const done: string[] = [];
  for (const issue of plan.open) {
    await ensureLabel(github, issue.repo);
    const opened = (await github.rest("POST", `/repos/${issue.repo}/issues`, {
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      assignees: issue.assignees,
    })) as { number: number };
    done.push(`Opened ${issue.repo}#${opened.number}: ${issue.title}`);
  }
  for (const { repo, issue, comment } of plan.close) {
    await github.rest("POST", `/repos/${repo}/issues/${issue}/comments`, { body: comment });
    await github.rest("PATCH", `/repos/${repo}/issues/${issue}`, { state: "closed", state_reason: "completed" });
    done.push(`Closed ${repo}#${issue} as completed.`);
  }
  return done;
}

async function main(): Promise<string[]> {
  const github = new GitHub(required("FABRIK_TICK_CHECK_TOKEN"), process.env["GITHUB_API_URL"]);
  const appLogin = `${required("FABRIK_APP_SLUG")}[bot]`;
  const now = new Date().toISOString();
  // The records only name the repos the store has heard from, so any Subscription list reads them.
  const { records } = await readStoreRunRecords(required("FABRIK_STORE_DIR"), DEFAULT_KIT_CONFIG.subscriptions);
  const products = [];
  for (const repo of await productReposOf(github)) products.push(await readProductTicks(github, repo, appLogin));
  const plan = deadTickPlan({
    now,
    operator: RUN_STORE.owner,
    products,
    recentRepos: recentReposOf(Object.values(records), now),
    storeIssues: await storeIssues(github, appLogin),
  });
  return [...plan.summary, ...(await apply(github, plan))];
}

main()
  .then(report)
  .catch(async (error: unknown) => {
    process.exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`::error title=Tick check failed::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
    await report([`The Tick check failed: ${message}`]);
  });
