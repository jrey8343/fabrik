// The change fingerprint (#643): what an agent PR itself changes, as hashes
// that stay the same when only the default branch moved under it. It is made
// from the PR's diff against its merge base with the default branch, which the
// push job reads with git (src/github/changeRead.ts), and each Verdict comment
// records it as a hidden line under its marker, since an old head can vanish
// after a rebase. Nothing in the Loop acts on it. Pure, no I/O.
import { createHash } from "node:crypto";
import { isTestPath } from "./changedTests.ts";

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

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, HASH_LENGTH);
}

const FILE_HEADER = "diff --git ";
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
/** A file's index line, which names its content after the change by Git's own hash of it. */
const INDEX_LINE = /^index [0-9a-f]+\.\.([0-9a-f]+)/;
/** Git's note under a line that ends its file with no newline. */
const NO_NEWLINE = "\\";

/**
 * Each file a diff changes, with its hash, in the diff's order. The diff is
 * as Git prints it with rename detection off and full index lines.
 *
 * - A file's hash is over the lines the diff adds and removes there, in
 *   order, each with its sign, and Git's note on one that ends the file with
 *   no newline: no hunk header, line number, index line or unchanged line.
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
    const hash = !binary ? hashOf(lines.map((line) => `${line}\n`).join("")) : deleted ? DELETED : content.slice(0, HASH_LENGTH);
    files.push([pathIn(header), hash]);
  }
  return files;
}

/**
 * The path a file's header names. With rename detection off both sides name
 * the same one, so it is either half of the header, whatever spaces it holds;
 * a name Git quoted is read back.
 */
function pathIn(header: string): string {
  const names = header.slice(FILE_HEADER.length);
  const side = names.slice(0, (names.length - 1) / 2);
  return (side.startsWith('"') ? unquoted(side) : side).slice("a/".length);
}

/** The escapes Git writes one character for, in a name it quotes. */
const ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** A name Git quoted, as it is: its escapes read back, an octal one as the byte of UTF-8 it stands for. */
function unquoted(quoted: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (const [plain, octal, escape] of quoted.slice(1, -1).matchAll(/\\([0-3][0-7]{2})|\\(.)|[^\\]+/gsu)) {
    if (octal !== undefined) bytes.push(Number.parseInt(octal, 8));
    else if (escape !== undefined) bytes.push(ESCAPES[escape] ?? escape.charCodeAt(0));
    else bytes.push(...encoder.encode(plain));
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/**
 * The fingerprint of the change this diff makes. The diff is Git's, of the
 * PR's head against its merge base with the default branch, so the same
 * commits on a default branch that moved, their lines at other line numbers,
 * come to the same fingerprint.
 */
export function changeFingerprintOf(diff: string): ChangeFingerprint {
  const files = changedFilesIn(diff).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const over = (entries: readonly (readonly [string, string])[]) => hashOf(entries.map(([path, hash]) => `${path}\0${hash}\n`).join(""));
  return {
    v: 1,
    all: over(files),
    product: over(files.filter(([path]) => !isTestPath(path))),
    files: files.length > MAX_FILES ? null : Object.fromEntries(files),
  };
}
