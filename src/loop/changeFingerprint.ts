// The change fingerprint (#643): what an agent PR itself changes, as hashes
// that stay the same when only the default branch moved under it. It is made
// from the PR's diff against its merge base with the default branch, which the
// push job reads with git (src/github/changeRead.ts), and each Verdict comment
// records it as a hidden line under its marker, since an old head can vanish
// after a rebase. Nothing in the Loop acts on it. Pure, no I/O.
import { createHash } from "node:crypto";
import { isTestPath } from "./changedTests.ts";
import { markerJson } from "./markers.ts";

/** What a pull request's own change comes to, at the head a Verdict judged. */
export interface ChangeFingerprint {
  readonly v: 1;
  /** 12 hex characters over every changed file's path and hash, sorted by path. */
  readonly all: string;
  /** The same, over the files that are not test files by the Kit's naming rule (isTestPath). */
  readonly product: string;
  /** Each changed file's hash by its path; null when more than MAX_FILES changed. */
  readonly files: Readonly<Record<string, string>> | null;
}

/** Past this many changed files a fingerprint names none of them, so its line stays a few thousand characters. */
export const MAX_FILES = 200;

/** How many hex characters a hash keeps. */
const HASH_LENGTH = 12;

/** What a binary file that the change deletes has for its hash, there being no content at the head. */
const DELETED = "deleted";

function hashOf(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex").slice(0, HASH_LENGTH);
}

/**
 * A diff's bytes as a string of one character for each byte, whatever the
 * byte. A file's lines are whatever bytes the file holds, and not every text
 * file is UTF-8: read as UTF-8, each byte that is none becomes the same
 * replacement character, and two edits of one line could no longer be told
 * apart. So a diff is split and matched in this form, where no byte is lost,
 * and each file's lines are hashed as the bytes they are (bytesOf).
 */
function byteStringOf(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let text = "";
  for (let at = 0; at < bytes.length; at += CHUNK) text += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  return text;
}

/** The bytes a string of one character for each byte stands for. */
function bytesOf(byteString: string): Uint8Array {
  const bytes = new Uint8Array(byteString.length);
  for (let at = 0; at < byteString.length; at++) bytes[at] = byteString.charCodeAt(at);
  return bytes;
}

const FILE_HEADER = "diff --git ";
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
/** A file's index line, which names its content after the change by Git's own hash of it. */
const INDEX_LINE = /^index [0-9a-f]+\.\.([0-9a-f]+)/;
/** Git's note under a line that ends its file with no newline. */
const NO_NEWLINE = "\\";

/**
 * Each file a diff changes, with its hash, in the diff's order. The diff is
 * as Git prints it with rename detection off and full index lines, as a
 * string of one character for each of its bytes (byteStringOf).
 *
 * - A file's hash is over the lines the diff adds and removes there, in
 *   order, each with its sign, and Git's note on one that ends the file with
 *   no newline: no hunk header, line number, index line or unchanged line.
 *   It is over their bytes as the file holds them, in whatever encoding.
 * - A hunk is read by the counts its header gives, so a removed line that
 *   itself starts `-- a/` is never taken for a header.
 * - A binary file is Git's hash of its content after the change, from its
 *   index line, or DELETED.
 * - A file with no index line changed only its mode, and is left out.
 */
function changedFilesIn(diff: string): [path: string, hash: string][] {
  const rows = diff.split("\n");
  const files: [string, string][] = [];
  let at = 0;
  while (at < rows.length) {
    const header = rows[at++]!;
    if (!header.startsWith(FILE_HEADER)) continue;
    let content: string | null = null;
    let deleted = false;
    let binary = false;
    for (; at < rows.length && !rows[at]!.startsWith(FILE_HEADER) && !HUNK_HEADER.test(rows[at]!); at++) {
      const row = rows[at]!;
      content = INDEX_LINE.exec(row)?.[1] ?? content;
      deleted ||= row.startsWith("deleted file mode ");
      binary ||= row.startsWith("Binary files ");
    }
    const lines: string[] = [];
    for (let hunk = HUNK_HEADER.exec(rows[at] ?? ""); hunk !== null; hunk = HUNK_HEADER.exec(rows[at] ?? "")) {
      at++;
      let removed = Number(hunk[1] ?? 1);
      let added = Number(hunk[2] ?? 1);
      // Whether the line above is one the diff adds or removes, whose note is then part of the change.
      let signed = false;
      while (at < rows.length && (removed > 0 || added > 0 || rows[at]!.startsWith(NO_NEWLINE))) {
        const row = rows[at++]!;
        if (row.startsWith(NO_NEWLINE)) {
          if (signed) lines.push(row);
          continue;
        }
        signed = row.startsWith("-") || row.startsWith("+");
        if (!row.startsWith("+")) removed--;
        if (!row.startsWith("-")) added--;
        if (signed) lines.push(row);
      }
    }
    if (content === null) continue;
    const hash = !binary ? hashOf(bytesOf(lines.map((line) => `${line}\n`).join(""))) : deleted ? DELETED : content.slice(0, HASH_LENGTH);
    files.push([pathIn(header), hash]);
  }
  return files;
}

/**
 * The path a file's header names. With rename detection off both sides name
 * the same one, so it is either half of the header, whatever spaces it holds;
 * a name Git quoted is read back. The header is one character for each
 * byte, and the path is those bytes read as UTF-8, as GitHub names a file.
 */
function pathIn(header: string): string {
  const names = header.slice(FILE_HEADER.length);
  const side = names.slice(0, (names.length - 1) / 2);
  return new TextDecoder().decode(side.startsWith('"') ? unquoted(side) : bytesOf(side)).slice("a/".length);
}

/** The escapes Git writes one character for, in a name it quotes. */
const ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** The bytes of a name Git quoted: its escapes read back, an octal one as the byte it stands for. */
function unquoted(quoted: string): Uint8Array {
  const bytes: number[] = [];
  for (const [plain, octal, escape] of quoted.slice(1, -1).matchAll(/\\([0-3][0-7]{2})|\\(.)|[^\\]+/gs)) {
    if (octal !== undefined) bytes.push(Number.parseInt(octal, 8));
    else if (escape !== undefined) bytes.push(ESCAPES[escape] ?? escape.charCodeAt(0));
    else bytes.push(...bytesOf(plain));
  }
  return Uint8Array.from(bytes);
}

/**
 * The fingerprint of the change this diff makes. The diff is Git's, of the
 * PR's head against its merge base with the default branch, so the same
 * commits on a default branch that moved, their lines at other line numbers,
 * come to the same fingerprint. It is given as the bytes Git printed, since
 * a file's lines need not be UTF-8; text stands for its bytes in UTF-8, and
 * comes to the same fingerprint as they do.
 */
export function changeFingerprintOf(diff: Uint8Array | string): ChangeFingerprint {
  const bytes = typeof diff === "string" ? new TextEncoder().encode(diff) : diff;
  const files = changedFilesIn(byteStringOf(bytes)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const over = (entries: readonly (readonly [string, string])[]) => hashOf(entries.map(([path, hash]) => `${path}\0${hash}\n`).join(""));
  return {
    v: 1,
    all: over(files),
    product: over(files.filter(([path]) => !isTestPath(path))),
    files: files.length > MAX_FILES ? null : Object.fromEntries(files),
  };
}

/** A fingerprint a comparison is given: none for a Verdict that records none. */
type Recorded = ChangeFingerprint | null | undefined;

/** Whether the product code differs between two fingerprints, and where. */
export type ProductChange =
  | { readonly kind: "unchanged" }
  /** The product paths that differ, sorted; null when either fingerprint names no files. */
  | { readonly kind: "changed"; readonly files: readonly string[] | null }
  /** Either fingerprint is missing. */
  | { readonly kind: "not-established" };

/**
 * The product code between two fingerprints: unchanged, changed, or not
 * established when either is missing. Changed names each product path whose
 * hash differs or that only one of them has.
 */
export function productChangeBetween(from: Recorded, to: Recorded): ProductChange {
  if (from == null || to == null) return { kind: "not-established" };
  if (from.product === to.product) return { kind: "unchanged" };
  if (from.files === null || to.files === null) return { kind: "changed", files: null };
  const [before, after] = [from.files, to.files];
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return {
    kind: "changed",
    files: paths.filter((path) => !isTestPath(path) && (!Object.hasOwn(before, path) || !Object.hasOwn(after, path) || before[path] !== after[path])).sort(),
  };
}

/** What a Verdict's head changed of the code since the Verdict before it. */
export type VerdictEffect = "product-code" | "tests-only" | "none" | "not-known";

/** One Verdict's effect on the code, against the Verdict before it; not known when either records no fingerprint. */
export function verdictEffect(before: Recorded, verdict: Recorded): VerdictEffect {
  if (before == null || verdict == null) return "not-known";
  if (before.product !== verdict.product) return "product-code";
  return before.all === verdict.all ? "none" : "tests-only";
}

/** Whether two fingerprints are of the same change: `all` is equal. Never with either missing. */
export function sameChange(one: Recorded, other: Recorded): boolean {
  return one != null && other != null && one.all === other.all;
}

/** The hidden line, matched against a whole line with its outer whitespace trimmed. */
const CHANGE_LINE = /^<!-- fabrik:change (.*) -->$/;

/**
 * The hidden line a Verdict comment records its fingerprint on, directly
 * under its marker. A path in it can neither end the comment early nor
 * mention anyone (markerJson).
 */
export function changeLine({ v, all, product, files }: ChangeFingerprint): string {
  return `<!-- fabrik:change ${markerJson({ v, all, product, files })} -->`;
}

/**
 * The fingerprint a comment records, or null when it records none, as every
 * Verdict from before the line does. It is read only from the comment's
 * second line, where the Kit writes it, so a line further down, which may be
 * an agent's words, is never taken for one; and one that doesn't read is none.
 */
export function changeIn(body: string): ChangeFingerprint | null {
  const json = CHANGE_LINE.exec(body.split("\n", 2)[1]?.trim() ?? "")?.[1];
  if (json === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { v, all, product, files } = value as Record<string, unknown>;
  if (v !== 1 || !isHash(all) || !isHash(product) || !isFileHashes(files)) return null;
  return { v, all, product, files };
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{12}$/.test(value);
}

function isFileHashes(value: unknown): value is Record<string, string> | null {
  if (value === null) return true;
  return typeof value === "object" && !Array.isArray(value) && Object.values(value).every((hash) => typeof hash === "string");
}

/**
 * This text with every change line taken out, and each other line as it was:
 * what an agent is given of a Verdict, since the line is up to a few thousand
 * characters of hashes and says nothing to it.
 */
export function withoutChangeLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !CHANGE_LINE.test(line.trim()))
    .join("\n");
}
