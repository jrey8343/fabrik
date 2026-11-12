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
