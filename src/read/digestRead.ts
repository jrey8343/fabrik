// The Digest read (#655, ADR-0022): a pull request's Digest as data, or that
// none is readable, so a reader of the Kit never reads a Digest's hidden
// lines or its Markdown itself, and the Kit can change how the data rides
// with no change to a reader. The Digest's contract
// (src/loop/digestContract.ts) reads the comment back; this module says
// which comment speaks for a pull request's head.
import type { ReadClient } from "../github/client.ts";
import { readDigestHead } from "../github/digestHead.ts";
import type { CommentFacts, OpenPullRequestFacts } from "../kit/weeklySummary.ts";
import { type DigestData, digestMarkIn, type NoDigestHow, noDigestIn, readDigestComment } from "../loop/digestContract.ts";
import { type DigestHead, type DigestPlace, fingerprintOf, HUNK_HEADER, linesAt, linesOf } from "../loop/digestPlaces.ts";

/** What a row says of its open agent pull request's Digest. It is always about the pull request's current head: a Digest for an earlier head is never given. */
export type DigestRead =
  /**
   * The Digest of the pull request's head: the head it is written as of,
   * the head it was first written at when it was carried forward, when its
   * comment was posted and where, its top as data, and its folds, the
   * comment's Markdown from the folds line down, which a reader renders.
   */
  | { readonly is: "readable"; readonly head: string; readonly carriedFrom: string | null; readonly at: string; readonly url: string; readonly data: DigestData; readonly folds: string }
  /**
   * A Digest of the head no reader can draw, and why: `edited`, GitHub
   * records an edit of its body after it was posted, and the Kit never
   * edits a Digest, so the edit is a person's; `unknown-version`, its data
   * is at a version this release does not know; `malformed`, its data line
   * does not parse, is not the shape its version names, or is not there.
   * `markdown` is the comment as GitHub would render it, its hidden lines
   * left out, for a reader to show as it is: nothing is ever worked out
   * from it.
   */
  | { readonly is: "unreadable"; readonly why: "edited" | "unknown-version" | "malformed"; readonly url: string; readonly markdown: string }
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
  const unreadable = (why: "edited" | "unknown-version" | "malformed"): DigestRead => ({ is: "unreadable", why, url: comment.url, markdown: renderedOf(comment.body) });
  // An edit comes first: once a person has changed the comment, its data line is no longer Kit code's word.
  if (comment.bodyEditedAt !== undefined) return unreadable("edited");
  const read = readDigestComment(comment.body);
  if (!read.ok) return unreadable(read.why === "unknown-version" ? "unknown-version" : "malformed");
  return { is: "readable", head: read.head, carriedFrom: read.carriedFrom, at: comment.at, url: comment.url, data: read.data, folds: read.folds };
}

/**
 * A comment as GitHub would render it: its text with every hidden line left
 * out, a hidden line being one that is a single HTML comment and nothing
 * else, as each of the Kit's is.
 */
function renderedOf(body: string): string {
  return body
    .split("\n")
    .filter((line) => {
      const text = line.trim();
      return !(text.startsWith("<!--") && text.indexOf("-->") === text.length - "-->".length);
    })
    .join("\n");
}

/** A readable Digest, as a row carries it. */
type ReadableDigest = Extract<DigestRead, { readonly is: "readable" }>;

/** One place of a Digest's, with the lines it points at, as a reader shows them. */
export interface PlaceShown {
  /** Which item it is a place of, by the item's position in the Digest's data, from 0. */
  readonly item: number;
  /** Which of that item's places, by its position among them, from 0. */
  readonly place: number;
  /** The file's path from the repo's root, and its first and last line at the Digest's head, both included. */
  readonly path: string;
  readonly start: number;
  readonly end: number;
  /** What it is shown as: code, or words an End user reads. */
  readonly as: "code" | "words";
  /** Whether the place can take a pinned comment, as the Digest's data says. */
  readonly inDiff: boolean;
  /**
   * What `text` is. `hunk`: the place's lines as the pull request's diff
   * has them, each opening with its marker, a space for a line left as it
   * was, `+` for one added and `-` for one removed, the removed lines being
   * those that sit between the place's first line and its last or directly
   * above its first. `lines`: the place's lines as the head has them.
   */
  readonly show: "hunk" | "lines";
  /** The lines, joined by newlines. A place's text is the repo's own. */
  readonly text: string;
}

/**
 * The lines each place of a readable Digest points at, for one pull request
 * `pullRequest` of `repo`, `owner/name`: a read of its own, made when a
 * screen opens and never in a gather. It asks GitHub only for the files the
 * places name, each once, at the Digest's head, and for the pull request's
 * files, through `client`; with no place named it asks nothing.
 *
 * Each place's lines are checked against its fingerprint, and a place whose
 * lines at the head no longer match, or whose file is not there, is left
 * out, so that what is shown is what the Digest writer meant; the others
 * keep their positions. Code that is `inDiff` comes back as its diff hunk
 * (see PlaceShown). Code that is not, and words, come back as the plain
 * lines, as does a place whose file GitHub gives no patch for, or whose
 * hunk no longer holds its lines. "unread" when GitHub refuses or fails a
 * request for a reason that says nothing of the file: the read never throws.
 */
export async function readDigestPlaces(
  client: Pick<ReadClient, "rest" | "fileText">,
  repo: string,
  pullRequest: number,
  digest: Pick<ReadableDigest, "head" | "data">,
): Promise<PlaceShown[] | "unread"> {
  const [owner = "", name = ""] = repo.split("/");
  const places = digest.data.items.flatMap((item, itemAt) => item.places.map((place, placeAt) => ({ item: itemAt, place: placeAt, at: place })));
  let head: DigestHead;
  try {
    head = await readDigestHead(client, { owner, name }, pullRequest, digest.head, places.map(({ at }) => at.path));
  } catch {
    // A refusal, or a request GitHub failed or never answered.
    return "unread";
  }
  return places.flatMap(({ item, place, at }): PlaceShown[] => {
    const { path, start, end, as, inDiff, fingerprint } = at;
    const text = head.files.find((file) => file.path === path)?.text ?? null;
    const lines = text === null ? null : linesAt(linesOf(text), at);
    if (lines === null || fingerprintOf(lines) !== fingerprint) return [];
    const patch = head.changed.find((file) => file.path === path)?.patch ?? null;
    const hunk = as === "code" && inDiff && patch !== null ? hunkOf(patch, at, lines) : null;
    return [{ item, place, path, start, end, as, inDiff, show: hunk === null ? "lines" : "hunk", text: (hunk ?? lines).join("\n") }];
  });
}

/**
 * A place's lines as its file's patch has them: the lines of the one hunk
 * that holds the place, from the place's first line to its last, each with
 * the patch's marker, and with them every removed line that sits between
 * them or directly above the first. Null when no hunk of the patch holds
 * the whole place, or the hunk's lines on the head's side are not `lines`,
 * the place's own at the Digest's head: the pull request has moved on since
 * the Digest was written, and its diff is no longer of that head.
 */
function hunkOf(patch: string, { start, end }: Pick<DigestPlace, "start" | "end">, lines: readonly string[]): string[] | null {
  const cut: string[] = [];
  // The head's line the next line of the patch that is not a removed one is; 0 outside the hunk that holds the place.
  let at = 0;
  for (const line of patch.split("\n")) {
    const [header, first, count] = HUNK_HEADER.exec(line) ?? [];
    if (header !== undefined) {
      const from = Number(first);
      const held = count === undefined ? 1 : Number(count);
      at = from <= start && end <= from + held - 1 ? from : 0;
    } else if (at !== 0 && !line.startsWith("\\")) {
      // A removed line sits above the head's line that follows it, so it is taken with that line.
      if (start <= at && at <= end) cut.push(line);
      if (!line.startsWith("-")) at += 1;
    }
  }
  const onHead = cut.filter((line) => !line.startsWith("-")).map((line) => line.slice(1));
  return onHead.length === lines.length && onHead.every((line, index) => line === lines[index]) ? cut : null;
}
