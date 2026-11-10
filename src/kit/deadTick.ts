// The daily Tick check (#461), from the fabrik-runs store: which Product
// repos' hourly Tick is dead, the Dead-tick issue each one gets, and which open
// ones close because a Tick started again; and for a repo the Fabrik App can no
// longer reach, the issue the store gets instead. A Tick can't be watched from
// the repo where it died, so the check runs on the store's caller. Pure, no
// I/O: src/kit/dead-tick-main.ts reads the facts (src/github/tickFacts.ts) and
// applies the plan.
import { DEAD_TICK_MARKER } from "../loop/kitIssueMarks.ts";
import { tickStartedAgain } from "../loop/kitIssues.ts";
import { DEAD_TICK_LABEL, READY_FOR_HUMAN } from "../loop/labels.ts";
import { readable } from "../loop/readable.ts";
import { CALLER_PATH } from "../setup/shims.ts";
import { KIT_REPO } from "./caller.ts";
import { RUN_STORE_REPO } from "./runStore.ts";

/**
 * How long a Product repo goes with no Tick started before its Tick is dead,
 * and how long `fabrik.yml` must have been on main first: an hour's schedule
 * and a day's worth of GitHub's schedule jitter.
 */
export const DEAD_TICK_HOURS = 25;
const HOUR_MS = 3_600_000;
const WINDOW_MS = DEAD_TICK_HOURS * HOUR_MS;

/** How far back the store's Run records name the repos the check expects to reach. */
export const RECENT_RUN_DAYS = 30;

/** The newest Tick that started its jobs: a `tick / …` check run on a main commit. */
export interface StartedTick {
  /** When its check run started, ISO 8601. */
  readonly at: string;
  /** Its check run's `details_url`, the run's page. */
  readonly url: string;
  /** The release `fabrik.yml` pinned at the commit it ran on, or null when it pinned none. */
  readonly release: string | null;
}

/** An open issue carrying fabrik:dead-tick. */
export interface DeadTickIssue {
  readonly number: number;
  readonly body: string;
  /** Whether the Fabrik App opened it: a marker in anyone else's issue counts for nothing. */
  readonly byApp: boolean;
}

/** What the check read of one Product repo. */
export interface TickFacts {
  /** When `fabrik.yml` came to main: the oldest main commit touching it, or null when none does. */
  readonly callerSince: string | null;
  /** The newest started Tick the walk back through main's commits found, or null when it found none. */
  readonly lastTick: StartedTick | null;
  /** The release `fabrik.yml` on main pins now, or null when it pins none. */
  readonly release: string | null;
  /** The repo's open fabrik:dead-tick issues. */
  readonly issues: readonly DeadTickIssue[];
}

/** One Product repo, by `owner/name`, and what reading it gave. */
export type ProductTickRead =
  | { readonly repo: string; readonly kind: "read"; readonly facts: TickFacts }
  /** GitHub refused the App: it can't reach the repo. */
  | { readonly repo: string; readonly kind: "refused"; readonly error: string }
  /** Any other failure, which says nothing of whether the App reaches it. */
  | { readonly repo: string; readonly kind: "failed"; readonly error: string };

export interface DeadTickInput {
  /** When the check runs, ISO 8601. */
  readonly now: string;
  /** The Operator's GitHub login, whom each issue is assigned to. */
  readonly operator: string;
  /** Every repo the App's installation lists as a Product repo, and what reading it gave. */
  readonly products: readonly ProductTickRead[];
  /** The repos, as `owner/name`, with a Run record in the store from the last RECENT_RUN_DAYS days. */
  readonly recentRepos: readonly string[];
  /** The store's own open fabrik:dead-tick issues, for repos the App couldn't reach. */
  readonly storeIssues: readonly DeadTickIssue[];
}

export interface IssueToFile {
  /** Where it's filed, as `owner/name`: the Product repo, or the store. */
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
}

export interface DeadTickClose {
  readonly repo: string;
  readonly issue: number;
  /** Posted before it's closed as completed. */
  readonly comment: string;
}

export interface DeadTickPlan {
  readonly open: readonly IssueToFile[];
  readonly close: readonly DeadTickClose[];
  /** The step summary's lines. */
  readonly summary: readonly string[];
}

/** The repos, each once, with a Run record that ended in the last RECENT_RUN_DAYS days. */
export function recentReposOf(records: readonly { readonly repo: string; readonly endedAt: string }[], now: string): string[] {
  const since = Date.parse(now) - RECENT_RUN_DAYS * 24 * HOUR_MS;
  return [...new Set(records.filter((record) => Date.parse(record.endedAt) >= since).map((record) => record.repo))];
}

/** Whether a repo's Tick is dead: no Tick started in the window, with `fabrik.yml` on main for at least as long. */
export function tickIsDead({ callerSince, lastTick }: Pick<TickFacts, "callerSince" | "lastTick">, now: string): boolean {
  const since = Date.parse(now) - WINDOW_MS;
  if (lastTick !== null && Date.parse(lastTick.at) > since) return false;
  return callerSince !== null && Date.parse(callerSince) <= since;
}

export function deadTickPlan(input: DeadTickInput): DeadTickPlan {
  const plans = [
    ...input.products.map((product): DeadTickPlan => {
      switch (product.kind) {
        case "read":
          return productPlan(product.repo, product.facts, input);
        case "refused":
          return NOTHING;
        case "failed":
          return { ...NOTHING, summary: [`${product.repo}: couldn't be read: ${product.error}`] };
      }
    }),
    unreachablePlan(input),
  ];
  return {
    open: plans.flatMap((plan) => plan.open),
    close: plans.flatMap((plan) => plan.close),
    summary: plans.flatMap((plan) => plan.summary),
  };
}

const NOTHING: DeadTickPlan = { open: [], close: [], summary: [] };

/** The marker line ending the store's issue for a repo the App can't reach. */
function unreachableMarker(repo: string): string {
  return `<!-- fabrik:dead-tick-unreachable ${repo} -->`;
}

/**
 * Each repo the App can't reach gets an issue in the store: one the
 * installation lists that refuses its reads, and one with recent Run records
 * the installation no longer lists, which would otherwise drop off silently.
 * Each such issue closes once its repo is read again.
 */
function unreachablePlan({ products, recentRepos, storeIssues, operator }: DeadTickInput): DeadTickPlan {
  const filed = storeIssues.filter((issue) => issue.byApp);
  const filedFor = (repo: string) => filed.find((issue) => issue.body.includes(unreachableMarker(repo)));
  const listed = new Set(products.map((product) => product.repo.toLowerCase()));
  const unreachable = [
    ...products.flatMap((product) => (product.kind === "refused" ? [{ repo: product.repo, why: `GitHub refused its reads: ${product.error}` }] : [])),
    ...[...new Set(recentRepos)]
      .filter((repo) => !listed.has(repo.toLowerCase()))
      .map((repo) => ({ repo, why: "the Fabrik App's installation no longer lists it" })),
  ];
  const open: IssueToFile[] = [];
  const summary: string[] = [];
  for (const { repo, why } of unreachable) {
    const issue = filedFor(repo);
    if (issue !== undefined) {
      summary.push(`${repo}: the Fabrik App can't reach it, and ${RUN_STORE_REPO}#${issue.number} is open for it already.`);
      continue;
    }
    summary.push(`${repo}: the Fabrik App can't reach it, so an issue is opened in ${RUN_STORE_REPO}.`);
    open.push({
      repo: RUN_STORE_REPO,
      title: `The Fabrik App can't reach ${repo}`,
      body: [
        `The daily Tick check couldn't read ${repo}: ${why}. It has Run records in this store from the last ${RECENT_RUN_DAYS} days, or the installation lists it, so it's a Product repo, and until the App reaches it again nothing tells you if its hourly Tick stops.`,
        "",
        "## Steps",
        "",
        `- [ ] Reinstall the Fabrik App on ${repo}, or add the repo back to its installation.`,
        "",
        "The daily check closes this issue itself once it reads the repo again.",
        "",
        unreachableMarker(repo),
      ].join("\n"),
      labels: [DEAD_TICK_LABEL, READY_FOR_HUMAN],
      assignees: [operator],
    });
  }
  const close = products.flatMap((product): DeadTickClose[] => {
    const issue = product.kind === "read" ? filedFor(product.repo) : undefined;
    if (issue === undefined) return [];
    summary.push(`${product.repo}: the Fabrik App reaches it again, so ${RUN_STORE_REPO}#${issue.number} is closed.`);
    return [{ repo: RUN_STORE_REPO, issue: issue.number, comment: `The Fabrik App reaches ${product.repo} again, so the Kit is closing this issue.` }];
  });
  return { open, close, summary };
}

function productPlan(repo: string, facts: TickFacts, { now, operator }: DeadTickInput): DeadTickPlan {
  const filed = facts.issues.filter((issue) => issue.byApp && issue.body.includes(DEAD_TICK_MARKER));
  if (!tickIsDead(facts, now)) {
    const { lastTick } = facts;
    if (lastTick === null) {
      const why = facts.callerSince === null ? `no commit on main brings \`${CALLER_PATH}\`` : `\`${CALLER_PATH}\` came to main only at ${readable(facts.callerSince)}`;
      return { ...NOTHING, summary: [`${repo}: no Tick has started yet, but ${why}.`] };
    }
    return {
      open: [],
      close: filed.map((issue) => ({ repo, issue: issue.number, comment: tickStartedAgain(lastTick.at, lastTick.release) })),
      summary: [`${repo}: the last Tick started at ${readable(lastTick.at)}.`, ...filed.map((issue) => `${repo}: closed #${issue.number}, as a Tick has started again.`)],
    };
  }
  if (filed.length > 0) return { open: [], close: [], summary: [`${repo}: the Tick is dead, and #${filed[0]?.number} is open for it already.`] };
  return { open: [deadTickIssue(repo, facts, operator)], close: [], summary: [`${repo}: the Tick is dead, so a Dead-tick issue is opened.`] };
}

function deadTickIssue(repo: string, { callerSince, lastTick, release }: TickFacts, operator: string): IssueToFile {
  const since = lastTick?.at ?? callerSince ?? "";
  const bumped = lastTick !== null && lastTick.release !== null && release !== null && lastTick.release !== release;
  const last =
    lastTick === null
      ? `No Tick has started its jobs on \`main\` since \`${CALLER_PATH}\` came to it at ${readable(since)}.`
      : `The last Tick started at ${readable(lastTick.at)} ([its run](${lastTick.url}))${lastTick.release === null ? "" : `, on Fabrik ${lastTick.release}`}.`;
  const notes = release === null ? "the release notes of the release it pins" : `[${release}'s release notes](https://github.com/${KIT_REPO}/releases/tag/${release})`;
  return {
    repo,
    title: `The hourly Tick hasn't run since ${readable(since)}`,
    body: [
      ...(bumped ? [`The Tick stopped after the bump from ${lastTick.release} to ${release}.`, ""] : []),
      `No hourly Tick has started in this repo for more than ${DEAD_TICK_HOURS} hours, so nothing time-based runs here: no Dispatch check, Monitor, Audit or Retro, and no weekly-limit issue closes. ${last}`,
      "",
      "## Steps",
      "",
      `- [ ] Open [the Actions tab for \`${CALLER_PATH}\`](https://github.com/${repo}/actions/workflows/${CALLER_PATH.slice(CALLER_PATH.lastIndexOf("/") + 1)}) and read the newest run's error.`,
      "- [ ] Check that the workflow is enabled: GitHub disables a scheduled workflow after 60 days without activity in the repo.",
      `- [ ] Compare the caller's job permissions with ${notes}, or re-run Setup.`,
      "",
      "The Tick closes this issue itself on its first run once it starts again. Closing it while the Tick is still dead has the next daily check open a fresh one.",
      "",
      DEAD_TICK_MARKER,
    ].join("\n"),
    labels: [DEAD_TICK_LABEL, READY_FOR_HUMAN],
    assignees: [operator],
  };
}
