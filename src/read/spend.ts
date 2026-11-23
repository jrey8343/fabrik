// The Spend read (#624): what the factory has used, read straight from the
// fabrik-runs store with the Kit's own reader of a Run record, its new records
// fetched a batch to a query by the files read (./files.ts, #896), and runner
// time summed from the records. Each Subscription's last weekly-limit reading
// is the Replay gate's own rule (subscriptionReadingsOf, src/kit/replayFacts.ts).
// Read only, over the API: no checkout and no filesystem.
import { type ReadClient, whyUnread } from "../github/client.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { newerSchemaOf, readRunRecord, type RunRecord, type UnreadableRunRecords } from "../kit/runRecord.ts";
import { RUN_STORE, RUN_STORE_REPO } from "../kit/runStore.ts";
import { STORE_CALLER_PATH, timeZoneIn } from "../setup/shims.ts";
import { readFiles } from "./files.ts";

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

/**
 * How many Run records one query fetches. A record is a few kilobytes, so
 * fifty of them, with the listing of each month they are filed under that
 * the files read asks beside them, keep an answer well inside what GitHub
 * gives a query, in size and in time, while a hundred new records cost two
 * queries. The batches are asked one after another, never at once.
 */
const RECORDS_A_QUERY = 50;

/**
 * The Run records the store filed under `months` ("YYYY-MM": the month a
 * run ended, by UTC), of every Product repo, that `held` says the reader
 * doesn't hold yet, each parsed by the Kit's reader at the current schema,
 * so a record of an earlier schema reads as it does for the Weekly summary.
 * A Run record never changes, so a held path is never fetched again. With
 * them, the count of those it couldn't read and the newest schema among
 * them, and the store caller's time zone, read by the Kit's reader of it.
 *
 * `held` is asked once of each record's path, in the order the store lists
 * them, before any record is fetched, and every path it says is not held is
 * fetched, so a reader that answers held past a number of new paths stops
 * the read at that number, and knows each path it fetched.
 *
 * It lists the store's git trees, a REST request for each tree, so a month
 * of any size is listed whole, and reads the store's caller by the client's
 * file read. It fetches the new records' files by the files read, a GraphQL
 * query made through the client's own query call for each RECORDS_A_QUERY of
 * them, and none for a read with nothing new; a file GitHub won't give whole
 * in a query is read singly, as the files read reads one. It never reads a
 * transcript, a score file or a Replay's patch. A refusal or a failure, of a
 * listing, the caller or a batch, is returned as unread with why, never
 * thrown, and gives no record of the batches before it. The last argument is
 * when the read is made, as every read takes it; the store is read at its
 * default branch's head, whenever that is.
 */
export async function readSpend(
  client: Pick<ReadClient, "rest" | "graphql" | "fileText">,
  months: readonly string[],
  held: (path: string) => boolean,
  _now: string,
): Promise<SpendRead> {
  try {
    const [paths, caller] = await Promise.all([recordPathsIn(client, months), client.fileText(RUN_STORE, STORE_CALLER_PATH, DEFAULT_BRANCH)]);
    const stored = await fetchedABatchAtATime(client, paths.filter((path) => !held(path)));
    return { kind: "read", ...readRecords(stored), timeZone: (caller === null ? null : timeZoneIn(caller)) ?? "UTC" };
  } catch (error) {
    // A refusal, or a read GitHub failed, of the store's trees, its caller or a batch of records.
    return { kind: "unread", why: whyUnread(error, "A read of the store") };
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

/**
 * Each of `paths` in the store, with its text or null where there is no file,
 * in their order: RECORDS_A_QUERY to a files read, one batch after another.
 * Each batch reads at the default branch's head as it then is, so two batches
 * can read at two commits; a Run record never changes once written
 * (ADR-0009), and one gone since its listing is no file, so which head a
 * batch reads at never changes what it gives.
 */
async function fetchedABatchAtATime(client: Pick<ReadClient, "graphql" | "fileText">, paths: readonly string[]): Promise<(readonly [string, string | null])[]> {
  const fetched: (readonly [string, string | null])[] = [];
  for (let start = 0; start < paths.length; start += RECORDS_A_QUERY) {
    const batch = paths.slice(start, start + RECORDS_A_QUERY);
    const files = await readFiles(client, RUN_STORE_REPO, DEFAULT_BRANCH, batch);
    fetched.push(...batch.map((path) => [path, files[path] ?? null] as const));
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
