// The places a Digest's items point at (ADR-0022): a file and a range of
// lines in the Digest's head. The Digest points and never quotes, so nothing
// the Operator judges is retyped by a model: the Digest writer names each
// place, and Kit code checks it against what the head holds.
//
// The Digest's contract (src/loop/digestContract.ts) lands a Digest through
// this module, and the read library and the carry-forward are to read a
// place's lines through it, so it imports no package and no Node built-in a
// Worker can't load. Pure.
import { createHash } from "node:crypto";

/** What a place is shown as: code, or words an End user reads. */
export const PLACE_KINDS = ["code", "words"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

/** The most places one item names; a reply with more on an item is refused. */
export const MAX_PLACES = 3;

/** The most lines a place holds; a longer one is cut to its first 40. */
export const MAX_PLACE_LINES = 40;

/** A place as the Digest writer names it: a file in the head and a range of its lines, both ends included, the first line of a file being 1. */
export interface NamedPlace {
  /** The file's path from the repo's root, as the head has it. */
  readonly path: string;
  /** Its first line. */
  readonly start: number;
  /** Its last line. */
  readonly end: number;
  readonly as: PlaceKind;
}

/**
 * A place as a Digest carries it, once Kit code has checked it against the
 * head: it resolves there and holds at most 40 lines.
 */
export interface DigestPlace extends NamedPlace {
  /** Whether the place can take a pinned comment (see inOneHunk). */
  readonly inDiff: boolean;
  /** The fingerprint of its lines at the head (see fingerprintOf). */
  readonly fingerprint: string;
}

/**
 * What the head holds, as far as a Digest's places ask: the text of each
 * file a place names, and the pull request's files with their patches.
 */
export interface DigestHead {
  /** Each file a place names, with its text at the head: null when the head has no such file, or none that reads as text. */
  readonly files: readonly { readonly path: string; readonly text: string | null }[];
  /** The pull request's files, as GitHub's API gives them: each one's path at the head and its patch, null when GitHub gives none. */
  readonly changed: readonly { readonly path: string; readonly patch: string | null }[];
}

/**
 * Whether `path` could be a file's path in a repo, from its root: parts
 * joined by `/`, none of them empty, `.` or `..`. A place's path is the
 * Digest writer's word, and no other is ever read or linked.
 */
export function isRepoPath(path: string): boolean {
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * A file's lines: its text split at each line break, a break after the last
 * line starting no line of its own. A file with no text has none, and one
 * that is not text, told as Git tells it by a NUL character, has none a
 * place could point at.
 */
export function linesOf(text: string): string[] {
  if (text === "" || text.includes("\u0000")) return [];
  const lines = text.split(/\r?\n/);
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

/**
 * The lines `start` to `end` of a file, both included, the first line being
 * 1, or null when the file has no such range: its first line is before the
 * file's first or after its last, or its last line is past the file's end.
 */
export function linesAt(lines: readonly string[], { start, end }: Pick<NamedPlace, "start" | "end">): string[] | null {
  if (start < 1 || start > end || end > lines.length) return null;
  return lines.slice(start - 1, end);
}

/**
 * A place's fingerprint: the first 12 hex characters of the SHA-256 of its
 * lines, joined by newlines. A reader that fetches the lines again checks
 * them against it, and a carried Digest finds its lines again by it.
 */
export function fingerprintOf(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex").slice(0, 12);
}

/** A hunk's header in a patch: `@@ -8,7 +8,8 @@`, the head's side after the `+`, a count left out being 1. */
export const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * The hunks of a file's patch, as GitHub's API gives a pull request's files:
 * each one's first and last line on the head's side, its unchanged lines
 * counting. A hunk that leaves no line on the head's side, having only
 * removed some, holds none and is left out. Every line under a header opens
 * with a space, a `+`, a `-` or a backslash, so only a header opens with `@@`.
 */
export function hunksIn(patch: string): { readonly start: number; readonly end: number }[] {
  return patch.split("\n").flatMap((line) => {
    const [, first, count] = HUNK_HEADER.exec(line) ?? [];
    if (first === undefined) return [];
    const start = Number(first);
    const lines = count === undefined ? 1 : Number(count);
    return lines === 0 ? [] : [{ start, end: start + lines - 1 }];
  });
}

/**
 * Whether a place can take a pinned comment, its `inDiff`: every line of it
 * lies in one hunk of its file's diff in the pull request, on the head's
 * side. `changed` is the pull request's files (DigestHead). It is false in
 * a file the pull request does not change, and in one GitHub gives no patch
 * for.
 */
export function inOneHunk({ path, start, end }: Pick<NamedPlace, "path" | "start" | "end">, changed: DigestHead["changed"]): boolean {
  const patch = changed.find((file) => file.path === path)?.patch ?? null;
  return patch !== null && hunksIn(patch).some((hunk) => hunk.start <= start && end <= hunk.end);
}

/**
 * A place as a Digest carries it, or null when it does not resolve in the
 * head, and is dropped: its file is not in the head, its lines run past the
 * end of the file, or its first line is after its last. A wrong line number
 * costs its item that one link and never the Digest.
 *
 * One that resolves is cut to its first 40 lines when it is longer. Whether
 * it can take a pinned comment and its fingerprint are both worked out
 * after the cut, of the lines it then holds.
 */
export function placeAt(named: NamedPlace, head: DigestHead): DigestPlace | null {
  const { path, start, as } = named;
  const text = isRepoPath(path) ? (head.files.find((file) => file.path === path)?.text ?? null) : null;
  const lines = text === null ? null : linesAt(linesOf(text), named);
  if (lines === null) return null;
  const kept = lines.slice(0, MAX_PLACE_LINES);
  const end = start + kept.length - 1;
  return { path, start, end, as, inDiff: inOneHunk({ path, start, end }, head.changed), fingerprint: fingerprintOf(kept) };
}
