// The Digest carried forward (ADR-0022): when a pull request comes back to
// the Merge gate at a new head and its own change is the one its last Digest
// described, the Kit posts that Digest again for the new head, saying it was
// carried over because only `main` moved, and no model runs. The fresh pass
// on the new head is what covers a change on `main` that makes an old item
// wrong. Here is when a Digest is carried, which the rules core decides from
// the snapshot alone, and the comment it is carried as, which the push job
// renders once it has read what the new head holds. Pure, no I/O.
import { sameChange } from "./changeFingerprint.ts";
import { DIGEST_FOLDS_MARKER, type DigestCommentRead, type DigestData, type DigestWhere, digestDataMarker, digestMarker, digestTop, readDigestComment } from "./digestContract.ts";
import { type DigestHead, type DigestPlace, fingerprintOf, inOneHunk, linesOf } from "./digestPlaces.ts";
import { GITHUB_COMMENT_LIMIT } from "./roundLine.ts";
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
  const read = digestThatMightCarry(pullRequest);
  if (read === null) return null;
  if (!pullRequest.verdicts.some((verdict) => verdict.headSha === read.head && sameChange(verdict.change, pullRequest.change))) return null;
  const { asks } = pullRequest;
  if (asks === undefined || asks.length !== read.asks.length || asks.some((id, index) => id !== read.asks[index])) return null;
  return read;
}

/**
 * The pull request's last Digest, read back, while a pass might yet carry it
 * forward: it reads back, and a Verdict on its head records a fingerprint to
 * compare the pass's with. Null when no pass could carry it, whatever the
 * pass's own fingerprint and the Kit's list of asks turn out to be: the push
 * job reads that list only for a Digest this returns
 * (src/github/digestCarry.ts).
 */
export function digestThatMightCarry(pullRequest: PullRequestSnapshot): ReadableDigest | null {
  const last = pullRequest.digests.at(-1);
  const read = last === undefined ? null : readDigestComment(last.body);
  if (read === null || !read.ok) return null;
  return pullRequest.verdicts.some((verdict) => verdict.headSha === read.head && verdict.change !== undefined) ? read : null;
}

/**
 * The files a Digest's places name, each once, in the order first named:
 * what the push job reads at the new head before the Digest is carried
 * there. None for a comment that does not read back.
 */
export function placedFilesIn(digest: string): string[] {
  const read = readDigestComment(digest);
  if (!read.ok) return [];
  return [...new Set(read.data.items.flatMap(({ places }) => places.map(({ path }) => path)))];
}

/**
 * A place of a carried Digest at the new head. Its lines may sit elsewhere
 * after the rebase, and the Digest holds no copy of them, only their
 * fingerprint: so a window of the place's length is slid over the file at
 * the new head, and a window whose lines have that fingerprint exactly once
 * is the place, at its new lines. With no such window, more than one, or no
 * such file, there is no telling where the place is: null, and it is dropped
 * while its item is kept. What it is shown as stays as the writer said.
 */
function repointed(place: DigestPlace, head: DigestHead): DigestPlace | null {
  const { path, fingerprint } = place;
  const text = head.files.find((file) => file.path === path)?.text ?? null;
  if (text === null) return null;
  const lines = linesOf(text);
  const length = place.end - place.start + 1;
  let found: number | null = null;
  for (let first = 0; first + length <= lines.length; first++) {
    if (fingerprintOf(lines.slice(first, first + length)) !== fingerprint) continue;
    if (found !== null) return null;
    found = first;
  }
  if (found === null) return null;
  const [start, end] = [found + 1, found + length];
  // Whether it can take a pinned comment is the new diff's to say, so it is worked out afresh.
  return { ...place, start, end, inDiff: inOneHunk({ path, start, end }, head.changed) };
}

/**
 * A Digest's comment as it is carried forward to a new head: `digest` is the
 * last Digest's comment as posted, `where` the pull request and its new
 * head, and `head` what that head holds of the files the Digest's places
 * name (placedFilesIn). Null when it cannot be carried: the comment does not
 * read back, or its carried copy would be too long for GitHub.
 *
 * - Its hidden first line names the new head, the same asks, and the head
 *   the Digest was written at: one carried a second time keeps the first.
 * - Its data line and its top are written again from the Digest's data,
 *   neither parsed from the other, as when it was first written.
 * - Under the top's opening line is one added line, which says the head it
 *   was written at and that only `main` moved since: its words, its counts
 *   and its rounds are as they were then, and that line is what says so.
 * - Its folds are the ones the writer's run left, character for character,
 *   from the folds line down, with the link to that run.
 */
export function carriedDigest(digest: string, where: DigestWhere, head: DigestHead): string | null {
  const read = readDigestComment(digest);
  if (!read.ok) return null;
  const writtenAt = read.carriedFrom ?? read.head;
  const data: DigestData = {
    ...read.data,
    items: read.data.items.map((item) => ({ ...item, places: item.places.map((place) => repointed(place, head)).filter((place) => place !== null) })),
  };
  const [opening = "", ...top] = digestTop(data, where).split("\n");
  const body = [
    digestMarker({ head: where.headSha, asks: read.asks, carriedFrom: writtenAt }),
    digestDataMarker(data),
    opening,
    `Carried over from \`${writtenAt.slice(0, 7)}\` because only \`main\` moved.`,
    ...top,
    "",
    DIGEST_FOLDS_MARKER,
    read.folds,
  ].join("\n");
  // The added line and the head on its first line may take a Digest written at GitHub's limit over it.
  return body.length > GITHUB_COMMENT_LIMIT ? null : body;
}
