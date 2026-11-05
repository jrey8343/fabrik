// The weekly summary workflow's program (.github/actions/file-weekly-summary):
// reads the Run records from the store's sparse checkout of runs/ (never the
// transcripts), gathers the GitHub facts of every Product repo
// (src/github/facts.ts), builds the week's summary (src/kit/weeklySummary.ts)
// and files it in the store (src/kit/weeklyFiling.ts). It writes one
// step-summary line saying what it did.
//   node src/kit/weekly-main.ts
// Reads two Fabrik App tokens: FABRIK_STORE_TOKEN, with Issues write and
// Contents read on the store alone, and FABRIK_PRODUCTS_TOKEN, read-only on
// the Product repos. FABRIK_STORE_DIR is the store's checkout.
import { appendFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gatherGitHubFacts, productReposOf } from "../github/facts.ts";
import { GitHub, GitHubError } from "../github/client.ts";
import { STORE_CALLER_PATH, timeZoneIn } from "../setup/shims.ts";
import type { RunRecord } from "./runRecord.ts";
import { RUN_STORE } from "./runStore.ts";
import { type SummaryIssue, WEEKLY_SUMMARY_LABEL, type WeeklyFiling, weeklyFilingOf } from "./weeklyFiling.ts";
import { weeklySummary } from "./weeklySummary.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function report(line: string): Promise<void> {
  console.log(line);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") await appendFile(summary, `### Weekly summary\n\n${line}\n`);
}

/** Every Run record under the checkout's runs/, whatever repo or month. */
async function readRunRecords(storeDir: string): Promise<RunRecord[]> {
  const runs = join(storeDir, "runs");
  let paths: string[];
  try {
    paths = (await readdir(runs, { recursive: true })).filter((path) => path.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(join(runs, path), "utf8")) as RunRecord));
  return records.filter((record) => record.schema === 1);
}

const ISSUES = `/repos/${RUN_STORE.owner}/${RUN_STORE.name}`;

/** The Weekly summaries already filed, newest first. */
async function summaryIssues(store: GitHub): Promise<SummaryIssue[]> {
  const issues = (await store.rest(
    "GET",
    `${ISSUES}/issues?labels=${encodeURIComponent(WEEKLY_SUMMARY_LABEL)}&state=all&sort=created&direction=desc&per_page=100`,
  )) as { number: number; title: string; state: string; pull_request?: unknown }[];
  return issues
    .filter((issue) => issue.pull_request === undefined)
    .map((issue) => ({ number: issue.number, title: issue.title, open: issue.state === "open" }));
}

async function file(store: GitHub, filing: WeeklyFiling): Promise<string> {
  switch (filing.kind) {
    case "nothing":
      return "A quiet week: nothing ran and nothing is waiting or stuck, so no summary was filed.";
    case "file": {
      await ensureLabel(store);
      const issue = (await store.rest("POST", `${ISSUES}/issues`, {
        title: filing.title,
        body: filing.body,
        labels: [WEEKLY_SUMMARY_LABEL],
      })) as { number: number };
      await closeAll(store, filing.close);
      return `Filed #${issue.number}${closedNote(filing.close)}.`;
    }
    case "update":
      await store.rest("PATCH", `${ISSUES}/issues/${filing.issue}`, { body: filing.body });
      await closeAll(store, filing.close);
      return `Updated this week's summary, #${filing.issue}, in place${closedNote(filing.close)}.`;
  }
}

async function ensureLabel(store: GitHub): Promise<void> {
  try {
    await store.rest("POST", `${ISSUES}/labels`, { name: WEEKLY_SUMMARY_LABEL, color: "5319e7", description: "The Fabrik Weekly summary" });
  } catch (error) {
    // 422: it's already there.
    if (!(error instanceof GitHubError && error.status === 422)) throw error;
  }
}

async function closeAll(store: GitHub, issues: readonly number[]): Promise<void> {
  for (const issue of issues) {
    await store.rest("PATCH", `${ISSUES}/issues/${issue}`, { state: "closed", state_reason: "completed" });
  }
}

function closedNote(closed: readonly number[]): string {
  return closed.length === 0 ? "" : `, closing ${closed.map((issue) => `#${issue}`).join(", ")}`;
}

async function main(): Promise<string> {
  const apiUrl = process.env["GITHUB_API_URL"];
  const store = new GitHub(required("FABRIK_STORE_TOKEN"), apiUrl);
  const products = new GitHub(required("FABRIK_PRODUCTS_TOKEN"), apiUrl);
  const now = Date.now();

  const caller = await store.fileText(RUN_STORE, STORE_CALLER_PATH, required("GITHUB_SHA"));
  const timeZone = (caller === null ? null : timeZoneIn(caller)) ?? "UTC";
  const records = await readRunRecords(required("FABRIK_STORE_DIR"));
  const repos = await productReposOf(products);
  const facts = await Promise.all(repos.map((repo) => gatherGitHubFacts(products, repo, now)));

  const result = weeklySummary({ records, facts, operator: RUN_STORE.owner, timeZone, now: new Date(now).toISOString() });
  return file(store, weeklyFilingOf(result, await summaryIssues(store)));
}

main()
  .then(report)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
