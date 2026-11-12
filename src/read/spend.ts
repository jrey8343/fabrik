// The Spend read (#624): what the factory has used, read straight from the
// fabrik-runs store with the Kit's own reader of a Run record, and runner
// time summed from the records. Each Subscription's last weekly-limit reading
// is the Replay gate's own rule (subscriptionReadingsOf, src/kit/replayFacts.ts).
// Read only, over the API: no checkout and no filesystem.
import { GitHubError, gitHubMessageOf, type ReadClient } from "../github/client.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { newerSchemaOf, readRunRecord, type RunRecord, type UnreadableRunRecords } from "../kit/runRecord.ts";
import { RUN_STORE, RUN_STORE_REPO } from "../kit/runStore.ts";
import { STORE_CALLER_PATH, timeZoneIn } from "../setup/shims.ts";

/** What the Spend read gives, or why it couldn't read the store. */
export type SpendRead =
  | {
      readonly kind: "read";
      /** Each Run record the reader didn't hold, by its path in the store, at the current schema. */
      readonly records: Readonly<Record<string, RunRecord>>;
      /** The records not held that the Kit couldn't read, as the Weekly summary counts them. */
      readonly unreadable: UnreadableRunRecords;
      /** The time zone the store's caller gives the Weekly summary, so a reader's week is its week: UTC when it gives none. */
      readonly timeZone: string;
    }
  | { readonly kind: "unread"; readonly why: string };

/** The store's default branch, which every listing and file read is made at. */
const DEFAULT_BRANCH = "HEAD";

/** How many records are fetched at once, so a first read of a full month stays clear of GitHub's limits on concurrent requests. */
const FETCHES_AT_ONCE = 10;

/**
 * The Run records the store filed under `months` ("YYYY-MM": the month a
 * run ended, by UTC), of every Product repo, that `held` says the reader
 * doesn't hold yet, each parsed by the Kit's reader at the current schema,
 * so a record of an earlier schema reads as it does for the Weekly summary.
 * A Run record never changes, so a held path is never fetched again. With
 * them, the count of those it couldn't read and the newest schema among
 * them, and the store caller's time zone, read by the Kit's reader of it.
 *
 * It lists the store's git trees, so a month of any size is listed whole,
 * and reads each new record's file, never a transcript, a score file or a
 * Replay's patch. A refusal or a failure is returned as unread with why,
 * never thrown. The last argument is when the read is made, as every read
 * takes it; the store is read at its default branch's head, whenever that is.
 */
export async function readSpend(
  client: Pick<ReadClient, "rest" | "fileText">,
  months: readonly string[],
  held: (path: string) => boolean,
  _now: string,
): Promise<SpendRead> {
  try {
    const [paths, caller] = await Promise.all([recordPathsIn(client, months), client.fileText(RUN_STORE, STORE_CALLER_PATH, DEFAULT_BRANCH)]);
    const stored = await fetchedAFewAtATime(
      paths.filter((path) => !held(path)),
      async (path) => [path, await client.fileText(RUN_STORE, path, DEFAULT_BRANCH)] as const,
    );
    return { kind: "read", ...readRecords(stored), timeZone: (caller === null ? null : timeZoneIn(caller)) ?? "UTC" };
  } catch (error) {
    // A refusal, or a read GitHub failed, of the store's trees, its caller or a record.
    return { kind: "unread", why: whyUnread(error) };
  }
}

/** One entry of a git tree, as GitHub lists it. */
interface TreeEntry {
  readonly path: string;
  readonly type: string;
  readonly sha: string;
}

/** The entries directly under the store's tree `sha`, all of them: GitHub lists a tree whole, unlike a directory's contents, which stop at a thousand. */
async function treeOf(client: Pick<ReadClient, "rest">, sha: string, at: string): Promise<TreeEntry[]> {
  const answer = (await client.rest("GET", `/repos/${RUN_STORE_REPO}/git/trees/${encodeURIComponent(sha)}`)) as {
    readonly tree: readonly TreeEntry[];
    readonly truncated: boolean;
  };
  if (answer.truncated) throw new Error(`GitHub cut short its listing of ${at === "" ? "the store" : at} in the store`);
  return [...answer.tree];
}

/** The subtrees directly under a tree. */
const treesIn = (entries: readonly TreeEntry[]) => entries.filter(({ type }) => type === "tree");

/** Every Run record's path the store files under one of `months`, of any Product repo: `runs/<owner>/<repo>/<month>/<run>.json`. */
async function recordPathsIn(client: Pick<ReadClient, "rest">, months: readonly string[]): Promise<string[]> {
  const runs = treesIn(await treeOf(client, DEFAULT_BRANCH, "")).find(({ path }) => path === "runs");
  if (runs === undefined || months.length === 0) return [];
  const listed = async (entry: TreeEntry, dir: string) => ({ dir: `${dir}/${entry.path}`, entries: await treeOf(client, entry.sha, `${dir}/${entry.path}`) });
  const owners = await Promise.all(treesIn(await treeOf(client, runs.sha, "runs")).map((owner) => listed(owner, "runs")));
  const repos = await Promise.all(owners.flatMap(({ dir, entries }) => treesIn(entries).map((repo) => listed(repo, dir))));
  const monthsListed = await Promise.all(
    repos.flatMap(({ dir, entries }) =>
      treesIn(entries)
        .filter(({ path }) => months.includes(path))
        .map((month) => listed(month, dir)),
    ),
  );
  return monthsListed.flatMap(({ dir, entries }) => entries.filter(({ type, path }) => type === "blob" && path.endsWith(".json")).map(({ path }) => `${dir}/${path}`));
}

/** `fetch` of each of `items`, no more than FETCHES_AT_ONCE at once, in their order. */
async function fetchedAFewAtATime<T, R>(items: readonly T[], fetch: (item: T) => Promise<R>): Promise<R[]> {
  const fetched: R[] = [];
  for (let start = 0; start < items.length; start += FETCHES_AT_ONCE) {
    fetched.push(...(await Promise.all(items.slice(start, start + FETCHES_AT_ONCE).map(fetch))));
  }
  return fetched;
}

/**
 * Each stored file read as a Run record, by its path, as the Weekly summary
 * reads the store's (readStoreRunRecords, src/kit/storeCheckout.ts): a file
 * that isn't a record of a schema the Kit knows, or isn't JSON, is counted
 * unreadable, with the newest schema among them. A file gone since its
 * listing is left out.
 */
function readRecords(stored: readonly (readonly [string, string | null])[]): Pick<Extract<SpendRead, { kind: "read" }>, "records" | "unreadable"> {
  const records: Record<string, RunRecord> = {};
  let count = 0;
  let newestSchema: number | null = null;
  for (const [path, text] of stored) {
    if (text === null) continue;
    const file = parsed(text);
    const record = readRunRecord(file, DEFAULT_KIT_CONFIG.subscriptions);
    if (record !== null) {
      records[path] = record;
      continue;
    }
    count += 1;
    const schema = newerSchemaOf(file);
    if (schema !== null && (newestSchema === null || schema > newestSchema)) newestSchema = schema;
  }
  return { records, unreadable: { count, newestSchema } };
}

/** A file's JSON, or undefined when it isn't JSON. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Why the store couldn't be read, in GitHub's words where GitHub gave them. */
function whyUnread(error: unknown): string {
  if (error instanceof GitHubError) {
    const request = error.request === "" ? "A read of the store" : error.request;
    return error.status === 0 ? `${request} got no answer from GitHub: ${error.message}` : `${request} failed with ${error.status}: ${gitHubMessageOf(error)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** A week's runner time, in whole minutes, with the records that gave no duration. */
export interface RunnerTime {
  readonly minutes: number;
  /** Records with no duration, which add nothing to `minutes`. */
  readonly uncounted: number;
}

/**
 * The runner time of the Run records that ended in a week: each run's
 * duration rounded up to a whole minute, summed, and the count of records
 * with no duration, which add nothing. It counts the agent's own time, not
 * the jobs around it nor jobs that leave no Run record, so it is under the
 * figure GitHub bills.
 */
export function runnerTimeOf(records: readonly RunRecord[]): RunnerTime {
  let minutes = 0;
  let uncounted = 0;
  for (const { durationMs } of records) {
    if (durationMs === null) uncounted += 1;
    else minutes += Math.ceil(durationMs / 60_000);
  }
  return { minutes, uncounted };
}
