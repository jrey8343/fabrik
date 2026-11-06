// The weekly summary workflow's program (.github/actions/file-weekly-summary):
// reads the Run records and score files from the store's sparse checkout of
// runs/ and scores/ (never the transcripts), gathers the GitHub facts of every
// Product repo (src/github/facts.ts), builds the week's summary
// (src/kit/weeklySummary.ts) and files it in the store
// (src/kit/weeklyFiling.ts). It writes one step-summary line saying what it did.
//   node src/kit/weekly-main.ts
// Reads two Fabrik App tokens: FABRIK_STORE_TOKEN, with Issues write and
// Contents read on the store alone, and FABRIK_PRODUCTS_TOKEN, read-only on
// the Product repos. FABRIK_STORE_DIR is the store's checkout, and
// FABRIK_APP_SLUG the Fabrik App's slug, which names its label events.
import { appendFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gatherGitHubFacts, productReposOf } from "../github/facts.ts";
import { GitHub, GitHubError } from "../github/client.ts";
import { STORE_CALLER_PATH, timeZoneIn } from "../setup/shims.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { readRunRecord, type RunRecord } from "./runRecord.ts";
import { RUN_STORE } from "./runStore.ts";
import type { ScoreFile } from "./scorer.ts";
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

/** Every file under one of the checkout's directories, whatever repo or month, parsed: none when the directory isn't there. */
async function readStoreFiles(storeDir: string, directory: "runs" | "scores"): Promise<unknown[]> {
  const root = join(storeDir, directory);
  let paths: string[];
  try {
    paths = (await readdir(root, { recursive: true })).filter((path) => path.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(paths.map(async (path): Promise<unknown> => JSON.parse(await readFile(join(root, path), "utf8"))));
}

/**
 * Every Run record in the store, at the current schema. The summary has no
 * Product's Kit config, so a schema 1 record is read as being on the one V1
 * Subscription, the first a Kit config lists by default.
 */
async function readRunRecords(storeDir: string): Promise<RunRecord[]> {
  return (await readStoreFiles(storeDir, "runs")).flatMap((file) => readRunRecord(file, DEFAULT_KIT_CONFIG.subscriptions) ?? []);
}

/** Every schema 1 score file in the store. */
async function readScoreFiles(storeDir: string): Promise<ScoreFile[]> {
  return (await readStoreFiles(storeDir, "scores")).filter(
    (file): file is ScoreFile => typeof file === "object" && file !== null && (file as { schema?: unknown }).schema === 1,
  );
}

/** The store repo's REST path, for its issues and labels. */
const STORE_API = `/repos/${RUN_STORE.owner}/${RUN_STORE.name}`;

/** The Weekly summaries already filed, newest first. */
async function summaryIssues(store: GitHub): Promise<SummaryIssue[]> {
  const issues = (await store.rest(
    "GET",
    `${STORE_API}/issues?labels=${encodeURIComponent(WEEKLY_SUMMARY_LABEL)}&state=all&sort=created&direction=desc&per_page=100`,
  )) as { number: number; title: string; state: string; pull_request?: unknown }[];
  return issues
    .filter((issue) => issue.pull_request === undefined)
    .map((issue) => ({ number: issue.number, title: issue.title, open: issue.state === "open" }));
}

async function file(store: GitHub, filing: WeeklyFiling): Promise<string> {
  switch (filing.kind) {
    case "nothing":
      return "A quiet week: nothing ran and nothing is waiting, stuck or held, so no summary was filed.";
    case "file": {
      await ensureLabel(store);
      const issue = (await store.rest("POST", `${STORE_API}/issues`, {
        title: filing.title,
        body: filing.body,
        labels: [WEEKLY_SUMMARY_LABEL],
      })) as { number: number };
      await closeAll(store, filing.close);
      return `Filed #${issue.number}${closedNote(filing.close)}.`;
    }
    case "update":
      await store.rest("PATCH", `${STORE_API}/issues/${filing.issue}`, { body: filing.body });
      await closeAll(store, filing.close);
      return `Updated this week's summary, #${filing.issue}, in place${closedNote(filing.close)}.`;
  }
}

async function ensureLabel(store: GitHub): Promise<void> {
  try {
    await store.rest("POST", `${STORE_API}/labels`, { name: WEEKLY_SUMMARY_LABEL, color: "5319e7", description: "The Fabrik Weekly summary" });
  } catch (error) {
    // 422: it's already there.
    if (!(error instanceof GitHubError && error.status === 422)) throw error;
  }
}

async function closeAll(store: GitHub, issues: readonly number[]): Promise<void> {
  for (const issue of issues) {
    await store.rest("PATCH", `${STORE_API}/issues/${issue}`, { state: "closed", state_reason: "completed" });
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
  const storeDir = required("FABRIK_STORE_DIR");
  const records = await readRunRecords(storeDir);
  // No scores/ until scoring has run.
  const scoreFiles = await readScoreFiles(storeDir);
  const repos = await productReposOf(products);
  const facts = await Promise.all(repos.map((repo) => gatherGitHubFacts(products, repo, now, RUN_STORE.owner)));

  const result = weeklySummary({
    records,
    scoreFiles,
    facts,
    operator: RUN_STORE.owner,
    appLogin: `${required("FABRIK_APP_SLUG")}[bot]`,
    timeZone,
    now: new Date(now).toISOString(),
  });
  return file(store, weeklyFilingOf(result, await summaryIssues(store)));
}

main()
  .then(report)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
