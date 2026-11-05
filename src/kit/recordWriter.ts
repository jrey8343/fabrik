// Writes a run's transcript and Run record to the store, RUN_STORE (ADR-0009),
// through the Contents API, as the Fabrik App's token scoped to the store. The
// record itself is built by src/kit/runRecord.ts; this only writes it.
import { Buffer } from "node:buffer";
import { type GitHub, GitHubError } from "../github/client.ts";
import type { RunRecordFiles } from "./runRecord.ts";
import { RUN_STORE, RUN_STORE_REPO } from "./runStore.ts";

/** The store's REST API: the record writer reads its visibility and creates files. */
export type StoreApi = Pick<GitHub, "rest">;

/** What writing the record came to. */
export type RecordWrite =
  | { readonly kind: "no-record" }
  | { readonly kind: "public-store" }
  | { readonly kind: "written"; readonly written: readonly string[]; readonly existing: readonly string[] };

/**
 * Writes the transcript, then the record, each as a new file in the store:
 * nothing when no agent run ended (`files` null), or when the store isn't private.
 */
export async function writeRunRecord(
  store: StoreApi,
  files: RunRecordFiles | null,
  transcriptGzip: Uint8Array | null,
  wait: (ms: number) => Promise<void>,
): Promise<RecordWrite> {
  if (files === null) return { kind: "no-record" };
  // Records hold Product repos' issues and transcripts their code: never in a store others can read.
  const repo = (await store.rest("GET", `/repos/${RUN_STORE.owner}/${RUN_STORE.name}`)) as { private?: unknown };
  if (repo.private !== true) return { kind: "public-store" };
  const written: string[] = [];
  const existing: string[] = [];
  const toWrite: [string, Uint8Array][] = [];
  if (files.transcriptPath !== null && transcriptGzip !== null) toWrite.push([files.transcriptPath, transcriptGzip]);
  toWrite.push([files.recordPath, Buffer.from(`${JSON.stringify(files.record, null, 2)}\n`, "utf8")]);
  for (const [path, content] of toWrite) {
    const message = `${files.record.repo} run ${files.record.runId}-${files.record.runAttempt} (${files.record.role})`;
    const created = await createRetryingConflicts(store, path, content, message, wait);
    (created ? written : existing).push(path);
  }
  return { kind: "written", written, existing };
}

/**
 * Creates the file, retrying with backoff when a parallel commit to the store
 * (another run's record) moved its branch first (409).
 */
async function createRetryingConflicts(
  store: StoreApi,
  path: string,
  content: Uint8Array,
  message: string,
  wait: (ms: number) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await createFile(store, path, content, message);
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === CONFLICT) || attempt + 1 >= ATTEMPTS) throw error;
      // Doubling, with jitter under half a step so parallel writers spread out and each wait is still longer.
      const step = BACKOFF_MS * 2 ** attempt;
      await wait(step + Math.floor(Math.random() * (step / 2)));
    }
  }
}

/** How often a write is tried, and the first wait after a conflict. */
const ATTEMPTS = 6;
const BACKOFF_MS = 1000;

/** The Contents API's answer when the store's branch moved under the write. */
const CONFLICT = 409;

/**
 * Creates the file at `path`, or returns false when the store already holds
 * it: without a `sha` the Contents API refuses to replace a file (422), so a
 * refusal is checked by looking for the file, never by reading its message.
 */
async function createFile(store: StoreApi, path: string, content: Uint8Array, message: string): Promise<boolean> {
  const contents = `/repos/${RUN_STORE.owner}/${RUN_STORE.name}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  try {
    await store.rest("PUT", contents, { message, content: Buffer.from(content).toString("base64") });
    return true;
  } catch (error) {
    if (error instanceof GitHubError && error.status === UNPROCESSABLE && (await isThere(store, contents))) return false;
    throw error;
  }
}

/** Whether the store holds a file at this Contents API path. */
async function isThere(store: StoreApi, contents: string): Promise<boolean> {
  try {
    await store.rest("GET", contents);
    return true;
  } catch (error) {
    if (error instanceof GitHubError && error.status === NOT_FOUND) return false;
    throw error;
  }
}

/** The Contents API's answer to creating a file that already exists, among other refusals. */
const UNPROCESSABLE = 422;
const NOT_FOUND = 404;

/** How the record writer ended: a write, or no token for the store because setup hasn't made or reached it. */
export type RecordOutcome = RecordWrite | { readonly kind: "no-store-token" };

/** The record writer's one step-summary line. */
export function recordWriteSummary(outcome: RecordOutcome): string {
  switch (outcome.kind) {
    case "no-store-token":
      return (
        `No Run record written: the Fabrik App couldn't get a token for ${RUN_STORE_REPO}. ` +
        `Run fabrik-setup to create the store, then install the Fabrik App on ${RUN_STORE_REPO}.`
      );
    case "public-store":
      return `No Run record written: ${RUN_STORE_REPO} isn't private, and records never go to a store others can read. Make it private.`;
    case "no-record":
      return "No Run record: no agent run ended in this run.";
    case "written": {
      const written = `Run record written to ${RUN_STORE_REPO}: ${outcome.written.join(", ")}.`;
      return outcome.existing.length === 0 ? written : `${written} Already there, left as it was: ${outcome.existing.join(", ")}.`;
    }
  }
}
