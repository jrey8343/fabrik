// The Digest read (#655, ADR-0022): a pull request's Digest as data, or that
// none is readable, so a reader of the Kit never reads a Digest's hidden
// lines or its Markdown itself, and the Kit can change how the data rides
// with no change to a reader. The Digest's contract
// (src/loop/digestContract.ts) reads the comment back; this module says
// which comment speaks for a pull request's head.
import type { CommentFacts, OpenPullRequestFacts } from "../kit/weeklySummary.ts";
import { type DigestData, digestMarkIn, type NoDigestHow, noDigestIn, readDigestComment } from "../loop/digestContract.ts";

/** What a row says of its open agent pull request's Digest. It is always about the pull request's current head: a Digest for an earlier head is never given. */
export type DigestRead =
  /**
   * The Digest of the pull request's head: the head it is written as of,
   * the head it was first written at when it was carried forward, when its
   * comment was posted and where, its top as data, and its folds, the
   * comment's Markdown from the folds line down, which a reader renders.
   */
  | { readonly is: "readable"; readonly head: string; readonly carriedFrom: string | null; readonly at: string; readonly url: string; readonly data: DigestData; readonly folds: string }
  /** No Digest could be written for the head, and how the attempt ended, from the Kit's no-Digest line: `failed`, `timed-out`, `refused`, `no-subscription` or `never-started`. */
  | { readonly is: "not-written"; readonly how: string; readonly url: string }
  /** A head nothing names: a draft still in the Loop, a pull request with the Digest off, one from before the release. */
  | { readonly is: "none" };

/** What speaks for a head: a Digest's comment, or the Kit's no-Digest line. */
type Spoken = { readonly comment: CommentFacts; readonly how: NoDigestHow | null };

/**
 * What an open agent pull request's row says of its Digest, from the
 * comments a gather already read of it: the newest Digest comment of the
 * Fabrik App's whose head is the pull request's, or the Kit's no-Digest
 * line for that head, whichever is newer. Only the Fabrik App's comments
 * are read, its bot login `appLogin`, or any bot's when that is null.
 */
export function digestReadOf({ headSha, comments }: Pick<OpenPullRequestFacts, "headSha" | "comments">, appLogin: string | null): DigestRead {
  const byApp = ({ author, byBot }: CommentFacts) => (appLogin === null ? byBot : author === appLogin);
  const spoken = comments
    .filter(byApp)
    .flatMap((comment): Spoken[] => {
      if (digestMarkIn(comment.body)?.head === headSha) return [{ comment, how: null }];
      const line = noDigestIn(comment.body);
      return line?.head === headSha ? [{ comment, how: line.how }] : [];
    })
    // The comments are oldest first, so of two posted in one second the later in the thread is the newer.
    .reduce<Spoken | null>((newest, one) => (newest === null || Date.parse(one.comment.at) >= Date.parse(newest.comment.at) ? one : newest), null);
  if (spoken === null) return { is: "none" };
  const { comment, how } = spoken;
  if (how !== null) return { is: "not-written", how, url: comment.url };
  const read = readDigestComment(comment.body);
  if (!read.ok) return { is: "none" };
  return { is: "readable", head: read.head, carriedFrom: read.carriedFrom, at: comment.at, url: comment.url, data: read.data, folds: read.folds };
}
