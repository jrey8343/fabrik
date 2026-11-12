// The Digest carried forward (ADR-0022): when a pull request comes back to
// the Merge gate at a new head and its own change is the one its last Digest
// described, the Kit posts that Digest again for the new head, saying it was
// carried over because only `main` moved, and no model runs. The fresh pass
// on the new head is what covers a change on `main` that makes an old item
// wrong. Here is when a Digest is carried, from the snapshot alone. Pure, no
// I/O.
import { sameChange } from "./changeFingerprint.ts";
import { type DigestCommentRead, readDigestComment } from "./digestContract.ts";
import type { PullRequestSnapshot } from "./types.ts";

/** A Digest's comment, read back. */
export type ReadableDigest = Extract<DigestCommentRead, { ok: true }>;

/**
 * The pull request's last Digest, read back, when a pass on its head now
 * carries it forward, or null when the pass carries nothing. The last Digest
 * is the newest Digest comment on the thread, whatever head it names. It is
 * carried when all of these hold:
 * - it reads back, its data line included (readDigestComment);
 * - the pass has a fingerprint of the pull request's own change
 *   (`pullRequest.change`), a Verdict on that Digest's head records one, and
 *   their `all` is equal: the change is identical, line for line;
 * - the Kit's list of asks (`pullRequest.asks`) is the list that Digest
 *   answered, id for id. A Request changes since it is more than `main`
 *   moving, even when the pull request's lines came out the same.
 * Anything not read counts against it: a pass with no fingerprint, a Verdict
 * from before fingerprints were recorded and a list of asks that was not
 * read each carry nothing.
 */
export function digestToCarry(pullRequest: PullRequestSnapshot): ReadableDigest | null {
  const last = pullRequest.digests.at(-1);
  const read = last === undefined ? null : readDigestComment(last.body);
  if (read === null || !read.ok) return null;
  if (!pullRequest.verdicts.some((verdict) => verdict.headSha === read.head && sameChange(verdict.change, pullRequest.change))) return null;
  const { asks } = pullRequest;
  if (asks === undefined || asks.length !== read.asks.length || asks.some((id, index) => id !== read.asks[index])) return null;
  return read;
}
