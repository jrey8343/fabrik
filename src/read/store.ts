// The store's rows (#620): the factory's own work, beside the Run records, as
// rows. The Standing rule for the store is Spec: Standing's
// (src/kit/standingStore.ts), which reads a few facts of the store's: its
// Weekly summary issues, its open "Weekly summary failed" issues and its open
// `ready-for-human` issues. This module reads those facts from GitHub and
// works the rows out of them by that rule, each with its title and the Fabrik
// App's last word, as a Product repo's row carries them (./rows.ts). No
// history, no Run record and no transcript is read here.
import { pagesOf, type ReadClient } from "../github/client.ts";
import { ACTOR, COMMENTS, LABEL_EVENTS, openIssueOf, PAGE_INFO, type RawIssue } from "../github/facts.ts";
import { leavingOutHeldLines } from "../github/heldLines.ts";
import { loginOf } from "../github/snapshot.ts";
import { checkCallerWorkflow } from "../kit/caller.ts";
import { RUN_STORE, RUN_STORE_REPO } from "../kit/runStore.ts";
import type { Standing } from "../kit/standing.ts";
import { storeStandingsOf, type WeeklySummaryIssueFacts } from "../kit/standingStore.ts";
import { WEEKLY_SUMMARY_FAILED_TITLE, WEEKLY_SUMMARY_LABEL } from "../kit/weeklyMarks.ts";
import type { OpenIssueFacts } from "../kit/weeklySummary.ts";
import { isHeldLine } from "../loop/heldLine.ts";
import { READY_FOR_HUMAN } from "../loop/labels.ts";
import { STORE_CALLER_PATH } from "../setup/shims.ts";
import type { RepoReadStore } from "./gather.ts";
import { bareRowOf, type Row } from "./rows.ts";

/** A comment of the Fabrik App's, as a row's last word gives it. */
export interface StoreCommentFacts {
  readonly body: string;
  /** ISO 8601. */
  readonly at: string;
  readonly url: string;
}

/** A Weekly summary issue in the store, open or closed, with its title and a link to each of the Fabrik App's comments. */
export interface StoreSummaryFacts extends WeeklySummaryIssueFacts {
  readonly title: string;
  /** The Fabrik App's comments on it, oldest first. */
  readonly appComments: readonly StoreCommentFacts[];
}

/** An open "Weekly summary failed" issue: filed by a failed run when there was no summary to comment on. */
export interface StoreFailedSummaryFacts {
  readonly number: number;
  readonly title: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** The Fabrik App's comments on it, oldest first. */
  readonly appComments: readonly StoreCommentFacts[];
}

/**
 * What a gather reads of the store: the facts the store's Standing rule reads,
 * with the titles and the Fabrik App's comments a row shows beside each.
 * Plain data: written as JSON and read back they are equal.
 */
export interface StoreFacts {
  readonly kind: "store";
  /** The Fabrik App's bot login, or null when the reader gave none: any bot's text is then taken for the App's. */
  readonly appLogin: string | null;
  /** Its Weekly summary issues, open or closed, newest first. */
  readonly summaries: readonly StoreSummaryFacts[];
  /** Its open "Weekly summary failed" issues. */
  readonly failedSummaryIssues: readonly StoreFailedSummaryFacts[];
  /** Its open `ready-for-human` issues, such as the Dead-tick issue filed for a Product repo the Fabrik App can no longer reach. */
  readonly readyForHuman: readonly OpenIssueFacts[];
}

/** The store's default branch, which its caller is read at. */
const DEFAULT_BRANCH = "HEAD";

/** How many Weekly summary issues are read, newest first: the newest is the one a failed run comments on, and an open one is to read. */
const SUMMARIES_READ = 10;

/** The store's Weekly summary issues, newest first, each with whether it is open, when its body was last written and its comments. */
const SUMMARIES_QUERY = `
  query ($owner: String!, $name: String!, $label: String!) {
    repository(owner: $owner, name: $name) {
      issues(labels: [$label], first: ${SUMMARIES_READ}, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes {
          number title state createdAt lastEditedAt
          ${COMMENTS}
        }
      }
    }
  }
`;

/** The store's open issues, among them its "Weekly summary failed" and `ready-for-human` issues: each with what the Standing rule reads of an open issue but its sub-issues, which no store Standing reads. */
const OPEN_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: 50, after: $after) {
        ${PAGE_INFO}
        nodes {
          number title state createdAt
          author ${ACTOR}
          labels(first: 50) { nodes { name } }
          ${COMMENTS}
          ${LABEL_EVENTS}
        }
      }
    }
  }
`;

/** A Weekly summary issue as SUMMARIES_QUERY reads it. */
type RawSummary = Pick<RawIssue, "number" | "title" | "state" | "createdAt" | "comments"> & { lastEditedAt: string | null };

/** An open issue as OPEN_ISSUES_QUERY reads it. */
type RawStoreIssue = Pick<RawIssue, "number" | "title" | "state" | "createdAt" | "author" | "labels" | "comments" | "timelineItems">;

/**
 * The store read at `now`, ISO 8601, with `client`: the release its caller
 * pins, then the few facts its Standing rule reads, null with why when a
 * query of them fails. `appLogin`, the Fabrik App's bot login, may be left
 * out: any bot's comments are then taken for the App's. Nothing is asked of
 * it that a Product repo's gather asks.
 */
export async function gatherStore(client: ReadClient, _now: string, appLogin: string | null): Promise<RepoReadStore> {
  const caller = await client.fileText(RUN_STORE, STORE_CALLER_PATH, DEFAULT_BRANCH);
  const pins = caller === null ? null : checkCallerWorkflow(caller);
  const store = { repo: RUN_STORE_REPO, product: false, store: true, release: pins?.ok === true ? pins.release : null } as const;
  try {
    return { ...store, facts: await gatherStoreFacts(client, appLogin), unread: null };
  } catch (error) {
    return { ...store, facts: null, unread: error instanceof Error ? error.message : String(error) };
  }
}

/** The store's facts. */
async function gatherStoreFacts(client: ReadClient, appLogin: string | null): Promise<StoreFacts> {
  // A held line is never the last word on the work (#471).
  const github = leavingOutHeldLines(client);
  const [summaries, open] = await Promise.all([
    github.graphql<{ repository: { issues: { nodes: RawSummary[] } } }>(SUMMARIES_QUERY, { owner: RUN_STORE.owner, name: RUN_STORE.name, label: WEEKLY_SUMMARY_LABEL }),
    pagesOf<RawStoreIssue>(github, OPEN_ISSUES_QUERY, RUN_STORE, {}, (data) => data.repository.issues),
  ]);
  const appCommentsOf = (comments: RawIssue["comments"]): StoreCommentFacts[] =>
    comments.nodes
      .filter(({ author }) => author !== null && (appLogin === null ? author.__typename === "Bot" : loginOf(author) === appLogin))
      .map(({ body, createdAt, url }) => ({ body, at: createdAt, url }));
  const stillOpen = open.filter(({ state }) => state === "OPEN");
  return {
    kind: "store",
    appLogin,
    summaries: summaries.repository.issues.nodes.map(({ number, title, state, createdAt, lastEditedAt, comments }) => ({
      number,
      title,
      open: state === "OPEN",
      bodyWrittenAt: lastEditedAt ?? createdAt,
      appComments: appCommentsOf(comments),
    })),
    // Known by its title: the failed run files it with no label.
    failedSummaryIssues: stillOpen
      .filter(({ title }) => title === WEEKLY_SUMMARY_FAILED_TITLE)
      .map(({ number, title, createdAt, comments }) => ({ number, title, createdAt, appComments: appCommentsOf(comments) })),
    readyForHuman: stillOpen
      .filter(({ labels }) => labels.nodes.some(({ name }) => name === READY_FOR_HUMAN))
      .map((issue) => openIssueOf({ ...issue, closedAt: null, blockedBy: { nodes: [] }, subIssues: { nodes: [] } })),
  };
}

/** The store's rows at `now`, ISO 8601: one for each Standing the store's rule gives, in its order. */
export function storeRowsOf(facts: StoreFacts, now: string): Row[] {
  return storeStandingsOf(facts, now).map((standing) => bareRowOf(standing, titleOf(standing, facts), lastWordOf(standing, facts)));
}

/** The title of the Standing's issue. */
function titleOf({ issue }: Standing, { summaries, failedSummaryIssues, readyForHuman }: StoreFacts): string {
  return [...summaries, ...failedSummaryIssues, ...readyForHuman].find(({ number }) => number === issue)?.title ?? "";
}

/** The Fabrik App's latest comment on the Standing's issue, a held line never; any bot's when the App's login is not known. */
function lastWordOf({ issue }: Standing, { appLogin, summaries, failedSummaryIssues, readyForHuman }: StoreFacts): Row["lastWord"] {
  const own = [...summaries, ...failedSummaryIssues].find(({ number }) => number === issue)?.appComments;
  const comments: readonly StoreCommentFacts[] =
    own ??
    (readyForHuman.find(({ number }) => number === issue)?.comments ?? [])
      .filter(({ author, byBot }) => (appLogin === null ? byBot : author === appLogin))
      .map(({ body, at, url }) => ({ body, at, url }));
  const latest = comments
    .filter(({ body }) => !isHeldLine(body))
    .reduce<StoreCommentFacts | null>((newest, comment) => (newest === null || Date.parse(comment.at) >= Date.parse(newest.at) ? comment : newest), null);
  return latest === null ? null : { text: latest.body, at: latest.at, url: latest.url };
}
