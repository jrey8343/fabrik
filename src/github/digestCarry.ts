// The push job's reads for a Digest carried forward (ADR-0022): the Kit's
// list of asks on the pull request now, which the rules core weighs against
// the list the last Digest answered before it carries one
// (src/loop/digestCarry.ts), and what the new head holds of the files that
// Digest's places name, read as the carry is applied (src/github/apply.ts).
import { digestFactsOf } from "../loop/digestFacts.ts";
import { digestThatMightCarry } from "../loop/digestCarry.ts";
import type { KitConfig, LoopEvent, Snapshot } from "../loop/types.ts";
import type { DigestHeadReader } from "./apply.ts";
import type { ReadClient, Repo } from "./client.ts";
import { readDigestThread } from "./digestGiven.ts";
import { readDigestHead } from "./digestHead.ts";

/** A snapshot, and why the Kit's list of asks could not be read into it; null when it was read, or was not needed. */
export interface SnapshotWithAsks {
  readonly snapshot: Snapshot;
  readonly unread: string | null;
}

/**
 * The snapshot with the Kit's list of asks on its pull request
 * (`pullRequest.asks`), where a pass might carry the last Digest forward: on
 * a Reviewer's Verdict, with the Digest on, for a pull request whose last
 * Digest reads back and has a Verdict with a fingerprint on its head. Any
 * other snapshot is handed back as it is, with nothing asked of GitHub.
 *
 * The asks are read as a Digest's own are (readDigestThread, digestFactsOf),
 * so the two lists are made the same way: the Operator's Request changes a
 * Review is given, neither dismissed nor deferred during a Retry, and each
 * line comment in them, by Kit code's ids.
 *
 * A Verdict never fails for want of them: when the read fails, the snapshot
 * is handed back without them, so nothing is carried and the pass starts the
 * Digest writer, and `unread` says why for the step summary.
 */
export async function snapshotWithAsks(github: Pick<ReadClient, "rest" | "graphql">, repo: Repo, event: LoopEvent, snapshot: Snapshot, config: KitConfig): Promise<SnapshotWithAsks> {
  const { pullRequest } = snapshot;
  if (event.kind !== "review-run-finished" || !config.digest.enabled || pullRequest === null || digestThatMightCarry(pullRequest) === null) {
    return { snapshot, unread: null };
  }
  try {
    const thread = await readDigestThread(github, repo, pullRequest.number, snapshot.operator, pullRequest.deferredChangesRequests);
    const asks = digestFactsOf(thread).asks.map(({ id }) => id);
    return { snapshot: { ...snapshot, pullRequest: { ...pullRequest, asks } }, unread: null };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { snapshot, unread: `The last Digest of #${pullRequest.number} could not be carried forward: the Operator's asks on it could not be read (${why}).` };
  }
}

/** Reads what a head holds for a Digest carried forward to it, as `github` (readDigestHead). */
export function digestHeadReader(github: Pick<ReadClient, "rest" | "fileText">, repo: Repo): DigestHeadReader {
  return { read: (pullRequest, headSha, paths) => readDigestHead(github, repo, pullRequest, headSha, paths) };
}
