// The places a Digest's items point at (ADR-0022): a file and a range of
// lines in the Digest's head. The Digest points and never quotes, so nothing
// the Operator judges is retyped by a model: the Digest writer names each
// place, and Kit code checks it against what the head holds.
//
// The Digest's contract (src/loop/digestContract.ts) lands a Digest through
// this module, and the read library and the carry-forward are to read a
// place's lines through it, so it imports no package and no Node built-in a
// Worker can't load. Pure.

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
 * A place as a Digest carries it, or null when it does not resolve in the
 * head, and is dropped.
 */
export function placeAt(named: NamedPlace, head: DigestHead): DigestPlace | null {
  const text = head.files.find(({ path }) => path === named.path)?.text ?? null;
  if (text === null) return null;
  return { ...named, inDiff: false, fingerprint: "" };
}
