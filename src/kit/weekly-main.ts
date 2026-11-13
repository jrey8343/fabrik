// The weekly summary workflow's program (.github/actions/file-weekly-summary):
// reads the Run records and score files from the store's sparse checkout of
// runs/ and scores/ (never the transcripts), gathers the GitHub facts of every
// Product repo (src/github/facts.ts), builds the week's summary
// (src/kit/weeklySummary.ts) and files it in the store
// (src/kit/weeklyFiling.ts). It writes one step-summary line saying what it did.
// A Product repo it can't read gets a line in its section; a failed run writes
// the step summary and an `::error` saying why, and comments on the newest
// summary (or files a short issue) mentioning the Operator with the run link.
//   node src/kit/weekly-main.ts
// Reads two Fabrik App tokens: FABRIK_STORE_TOKEN, with Issues write and
// Contents read on the store alone, and FABRIK_PRODUCTS_TOKEN, read-only on
// the Product repos; and for the Loop health line (#460), FABRIK_TICKS_TOKEN,
// with Checks, Contents and Issues read, and FABRIK_ACTIONS_TOKEN, with
// Actions read, each on every installed repo and each unset when its mint
// failed. The Actions token also reads the runs in progress that Held's
// max_in_flight line counts (#476), and the Ticks token, with its Checks read,
// the Required checks on each open Plain pull request's head. FABRIK_STORE_DIR is the store's checkout, and
// FABRIK_APP_SLUG the Fabrik App's slug, which names its label events.
import { appendFile } from "node:fs/promises";
import { gatherEveryRepoFacts, gatherHeadChecks, productReposOf } from "../github/facts.ts";
import { GitHub, GitHubError, type Repo } from "../github/client.ts";
import { readCallerRuns } from "../github/loopHealthFacts.ts";
import { defaultBranchOf, gatherDispatchCandidates, readKitConfigSources, type RunInFlightFact } from "../github/snapshot.ts";
import { readRuns, runsInFlightFactOf } from "../read/runs.ts";
import { readProductTicks } from "../github/tickFacts.ts";
import { STORE_CALLER_PATH, timeZoneIn } from "../setup/shims.ts";
import { DEFAULT_KIT_CONFIG, resolveKitConfig } from "./config.ts";
import { passedMoveOf } from "./standingOperator.ts";
import { type RepoHealthFacts, tickHealthOf } from "./loopHealth.ts";
import { RUN_STORE } from "./runStore.ts";
import { readStoreRunRecords, readStoreScoreFiles } from "./storeCheckout.ts";
import { type SummaryIssue, WEEKLY_SUMMARY_LABEL, type WeeklyFailureFiling, weeklyFailureOf, type WeeklyFiling, weeklyFilingOf } from "./weeklyFiling.ts";
import { type GitHubFacts, type RepoKitFacts, type UnreadRepo, weeklySummary } from "./weeklySummary.ts";

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

/** This Actions run's attempt, in the store, which a failure's comment links to. */
function thisRunUrl(): string {
  return `${required("GITHUB_SERVER_URL")}/${required("GITHUB_REPOSITORY")}/actions/runs/${required("GITHUB_RUN_ID")}/attempts/${required("GITHUB_RUN_ATTEMPT")}`;
}

function storeOf(): GitHub {
  return new GitHub(required("FABRIK_STORE_TOKEN"), process.env["GITHUB_API_URL"]);
}

async function fileFailure(store: GitHub, filing: WeeklyFailureFiling): Promise<void> {
  switch (filing.kind) {
    case "comment":
      await store.rest("POST", `${STORE_API}/issues/${filing.issue}/comments`, { body: filing.body });
      return;
    case "file":
      await store.rest("POST", `${STORE_API}/issues`, { title: filing.title, body: filing.body });
      return;
  }
}

/**
 * Says why the run failed in the step summary and an `::error`, then tells
 * the Operator with the store token, so a failed run is never taken for a
 * quiet week. A failure to tell them is a warning: the run is red either way.
 */
async function reportFailure(error: unknown): Promise<void> {
  process.exitCode = 1;
  const store = (() => {
    try {
      return { github: storeOf(), runUrl: thisRunUrl() };
    } catch {
      return null;
    }
  })();
  const existing = store === null ? [] : await summaryIssues(store.github).catch(() => []);
  const failure = weeklyFailureOf(error, existing, store?.runUrl ?? "", RUN_STORE.owner);
  console.log(`::error title=Weekly summary failed::${annotation(failure.error)}`);
  await report(failure.summary);
  if (store === null) {
    console.log("::warning title=Failure not filed::The store token or the run's environment isn't set, so the Operator wasn't told.");
    return;
  }
  try {
    await fileFailure(store.github, failure.filing);
  } catch (filingError) {
    console.log(`::warning title=Failure not filed::${annotation(filingError instanceof Error ? filingError.message : String(filingError))}`);
  }
}

/** `text` as a workflow command's message, its newlines kept. */
function annotation(text: string): string {
  return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/** How far back the run counts read: the summary's week, ending at the last Monday in any time zone, and a day to spare. */
const RUNS_READ_DAYS = 9;

/** An optional token's client, or null when its mint failed. */
function optionalGitHub(name: string, apiUrl: string | undefined): GitHub | null {
  const token = process.env[name];
  return token === undefined || token === "" ? null : new GitHub(token, apiUrl);
}

/**
 * Each Product repo's Loop, for its health line: its last started Tick and
 * its caller's runs in the week. A token whose mint failed costs only its part
 * of each line, which says so; the summary files either way.
 */
async function readLoopHealth(repos: readonly Repo[], appLogin: string, now: number): Promise<RepoHealthFacts[]> {
  const apiUrl = process.env["GITHUB_API_URL"];
  const ticks = optionalGitHub("FABRIK_TICKS_TOKEN", apiUrl);
  const actions = optionalGitHub("FABRIK_ACTIONS_TOKEN", apiUrl);
  const since = new Date(now - RUNS_READ_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const health: RepoHealthFacts[] = [];
  for (const repo of repos) {
    health.push({
      repo: `${repo.owner}/${repo.name}`,
      tick:
        ticks === null
          ? { kind: "unread", why: "the Fabrik App's token for reading Ticks couldn't be minted; the run's log says why" }
          : tickHealthOf(await readProductTicks(ticks, repo, appLogin)),
      runs: actions === null ? { kind: "no-permission" } : await readCallerRuns(actions, repo, since),
    });
  }
  return health;
}

/**
 * One Product repo's Kit config at its default branch's head, read and
 * resolved as the Loop reads it, and, when it's valid, what a Dispatch check
 * weighs there (#476), with the runs in flight, read once whatever the Kit
 * config (#606), and the Required checks it lists on each of `heads`: the
 * open Plain pull requests' and the agent pull requests' at the Merge gate (#564). Null for a repo with no default branch yet. The runs are
 * unread when the Actions token wasn't minted or GitHub wouldn't list them;
 * the checks are unread when the Ticks token, the one holding Checks read,
 * wasn't minted.
 */
async function readRepoKit(products: GitHub, actions: GitHub | null, repo: Repo, appLogin: string, checks: GitHub | null, heads: readonly string[]): Promise<RepoKitFacts | null> {
  const branch = await defaultBranchOf(products, repo);
  if (branch === null) return null;
  const config = resolveKitConfig(await readKitConfigSources(products, repo, branch.head));
  const name = `${repo.owner}/${repo.name}`;
  if (!config.ok) return { repo: name, branch: branch.name, config, dispatch: null, runsInFlight: await readRunsOf(actions, repo), headChecks: {} };
  const [candidates, runsInFlight, headChecks] = await Promise.all([
    gatherDispatchCandidates(products, repo, appLogin),
    readRunsOf(actions, repo),
    checks === null ? {} : gatherHeadChecks(checks, repo, heads, config.config.sandbox.checks),
  ]);
  return { repo: name, branch: branch.name, config, dispatch: { candidates }, runsInFlight, headChecks };
}

/**
 * The runs in flight, from the read library's one read of the repo's Actions
 * (#617), or unread when they can't be read: the Operator may not have
 * accepted the App's Actions: read yet, and then Held and the Standings say
 * the runs are unread.
 */
async function readRunsOf(actions: GitHub | null, repo: Repo): Promise<readonly RunInFlightFact[] | "unread"> {
  if (actions === null) return "unread";
  return runsInFlightFactOf(await readRuns(actions, `${repo.owner}/${repo.name}`, new Date().toISOString()));
}

/**
 * Each read repo's Kit and Dispatch facts. A repo whose Kit can't be read
 * leaves its facts for the unread, so its section says so, as one whose
 * GitHub facts couldn't be read does.
 */
async function readRepoKits(
  products: GitHub,
  repos: readonly Repo[],
  gathered: { readonly facts: readonly GitHubFacts[]; readonly unread: readonly UnreadRepo[] },
  appLogin: string,
): Promise<{ facts: GitHubFacts[]; unread: UnreadRepo[]; kits: RepoKitFacts[] }> {
  const actions = optionalGitHub("FABRIK_ACTIONS_TOKEN", process.env["GITHUB_API_URL"]);
  const checks = optionalGitHub("FABRIK_TICKS_TOKEN", process.env["GITHUB_API_URL"]);
  const facts: GitHubFacts[] = [];
  const unread = [...gathered.unread];
  const kits: RepoKitFacts[] = [];
  for (const repoFacts of gathered.facts) {
    const repo = repos.find(({ owner, name }) => `${owner}/${name}` === repoFacts.repo);
    try {
      const kit = repo === undefined ? null : await readRepoKit(products, actions, repo, appLogin, checks, headsToCheckOf(repoFacts));
      if (kit !== null) kits.push(kit);
      facts.push(repoFacts);
    } catch (error) {
      unread.push({ repo: repoFacts.repo, why: error instanceof Error ? error.message : String(error) });
    }
  }
  return { facts, unread, kits };
}

/**
 * The heads whose Required checks the Standings read: each open Plain pull
 * request's, and each agent pull request's at the Merge gate (#564), by the
 * rule's own reading of the gate (passedMoveOf), so a red check there names
 * its check. A handed-back agent pull request, and one with a Request changes
 * since its pass, read none, as the rule reads none for them.
 */
function headsToCheckOf({ plainPullRequests, openPullRequests }: GitHubFacts): string[] {
  const atTheGate = openPullRequests.filter((pullRequest) => passedMoveOf(pullRequest, RUN_STORE.owner)?.kind === "merge-gate");
  return [...plainPullRequests, ...atTheGate].map(({ headSha }) => headSha);
}

async function main(): Promise<string> {
  const store = storeOf();
  const apiUrl = process.env["GITHUB_API_URL"];
  const products = new GitHub(required("FABRIK_PRODUCTS_TOKEN"), apiUrl);
  const now = Date.now();

  const caller = await store.fileText(RUN_STORE, STORE_CALLER_PATH, required("GITHUB_SHA"));
  const timeZone = (caller === null ? null : timeZoneIn(caller)) ?? "UTC";
  const storeDir = required("FABRIK_STORE_DIR");
  // The summary has no Product's Kit config, so a schema 1 record is read as
  // being on the one V1 Subscription, the first a Kit config lists by default.
  const { records, unreadable } = await readStoreRunRecords(storeDir, DEFAULT_KIT_CONFIG.subscriptions);
  // No scores/ until scoring has run.
  const scoreFiles = Object.values(await readStoreScoreFiles(storeDir));
  const repos = await productReposOf(products);
  const appLogin = `${required("FABRIK_APP_SLUG")}[bot]`;
  // One repo's API error costs the summary only that repo's facts, which its section names.
  const { facts, unread, kits } = await readRepoKits(products, repos, await gatherEveryRepoFacts(products, repos, now, RUN_STORE.owner), appLogin);

  const result = weeklySummary({
    records: Object.values(records),
    unreadableRecords: unreadable,
    scoreFiles,
    facts,
    unread,
    health: await readLoopHealth(repos, appLogin, now),
    kits,
    operator: RUN_STORE.owner,
    appLogin,
    timeZone,
    now: new Date(now).toISOString(),
  });
  return file(store, weeklyFilingOf(result, await summaryIssues(store)));
}

main().then(report).catch(reportFailure);
