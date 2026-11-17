// A later Review's read of the pull request's own change since the head the
// Reviewer last judged (#748), with git, as the push job reads the change
// fingerprint (src/github/changeRead.ts): both heads are taken against their
// merge bases with the default branch, so what it brought in by a merge or a
// rebase is no part of it.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChangeFingerprint, changeFingerprintOf, fileHashesOf, filesChangedBetween } from "../loop/changeFingerprint.ts";
import { emptyRepository, type Git, MAIN_REF, type Remote } from "./branch.ts";
import { DIFF } from "./changeRead.ts";

/** One of the pull request's own files whose own change differs since the last judged head. */
export interface FileChangeSince {
  readonly path: string;
  /**
   * The difference between the file's own diff at the last judged head and
   * now, as a diff of the two: each line's first character says whether that
   * line of its own diff left it (`-`), joined it (`+`) or stayed (a space).
   */
  readonly diff: string;
}

/** The pull request's own change since the last judged head. */
export type ChangeSince =
  /** Read at both heads: each own file whose own change differs, in path order; none when nothing changed. */
  | { readonly kind: "read"; readonly files: readonly FileChangeSince[] }
  /**
   * The last judged head couldn't be fetched, as when a rebase dropped it:
   * the own files whose hashes differ between the fingerprint its Verdict
   * recorded and the current one, or null when either names no files.
   */
  | { readonly kind: "unread"; readonly files: readonly string[] | null };

/** The head the Reviewer last judged, and the fingerprint its Verdict recorded there. */
export interface LastJudged {
  readonly headSha: string;
  readonly change: ChangeFingerprint;
}

/**
 * The pull request's own change at `headSha` since the last judged head.
 * Both heads and the default branch are fetched into an empty repository, as
 * for the fingerprint, and each head is diffed against its own merge base
 * with the default branch as it is now: the PR's own diff then and now. A
 * file is named when its own change differs between them, by the
 * fingerprint's per-file hash, so a line of `main`'s that only moved the PR's
 * lines names nothing. The Operator's pushes, and heads red checks stopped
 * before Review, are inside it, as is anything else pushed since the last
 * judged head.
 *
 * When the last judged head can't be fetched, or shares no history with the
 * default branch, it gives the own files whose hashes differ between the
 * fingerprint its Verdict recorded and the current one. Rejects when the
 * current head can't be read.
 */
export async function readChangeSince(lastJudged: LastJudged, headSha: string, remote: Remote): Promise<ChangeSince> {
  const { git, url } = await emptyRepository(remote);
  await git("fetch", "--quiet", "--no-tags", url, `+HEAD:${MAIN_REF}`);
  await git("fetch", "--quiet", "--no-tags", url, headSha);
  const now = await ownChangeAt(git, headSha);
  const then = await git("fetch", "--quiet", "--no-tags", url, lastJudged.headSha)
    .then(() => ownChangeAt(git, lastJudged.headSha))
    .catch(() => null);
  if (then === null) return { kind: "unread", files: filesChangedBetween(lastJudged.change.files, changeFingerprintOf(now.diff).files) };
  const paths = filesChangedBetween(fileHashesOf(then.diff), fileHashesOf(now.diff)) ?? [];
  const scratch = await mkdtemp(join(tmpdir(), "fabrik-change-since-"));
  try {
    const files: FileChangeSince[] = [];
    for (const path of paths) {
      const [before, after] = await Promise.all([ownDiffOf(git, then, path), ownDiffOf(git, now, path)]);
      files.push({ path, diff: (await interdiff(git, scratch, before, after)) || BINARY_CHANGE });
    }
    return { kind: "read", files };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** What a file gives whose own change differs by its hash but not in its readable diff: a binary file. */
const BINARY_CHANGE = "A binary file: its content at the head differs from the last judged head's.";

/** A head's own change: the head, its merge base with the default branch, and the fingerprint's diff between them. */
interface OwnChange {
  readonly head: string;
  readonly base: string;
  readonly diff: Uint8Array;
}

async function ownChangeAt(git: Git, head: string): Promise<OwnChange> {
  const base = await git("merge-base", MAIN_REF, head).then(
    (out) => out.trim(),
    () => {
      throw new Error(`${head.slice(0, 7)} has no merge base with the default branch`);
    },
  );
  return { head, base, diff: await git.bytes(...DIFF, base, head) };
}

/** A hunk header as Git prints it, whose line numbers move whenever the default branch moves under the PR. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * One file's own diff, to read: with context, without its `diff --git` and
 * `index` lines, and each hunk header without its line numbers, so the same
 * change at other line numbers reads the same.
 */
async function ownDiffOf(git: Git, { base, head }: OwnChange, path: string): Promise<string> {
  const diff = await git("-c", "core.quotePath=false", "--literal-pathspecs", "diff", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", base, head, "--", path);
  return diff
    .split("\n")
    .filter((line) => !line.startsWith("diff --git ") && !line.startsWith("index "))
    .map((line) => line.replace(HUNK_HEADER, "@@"))
    .join("\n");
}

/** The diff of one text against another, from its first hunk on, each hunk header without its line numbers. */
async function interdiff(git: Git, scratch: string, before: string, after: string): Promise<string> {
  const blob = async (name: string, text: string) => {
    await writeFile(join(scratch, name), text);
    return (await git("hash-object", "-w", join(scratch, name))).trim();
  };
  const diff = await git("diff", "--no-color", "--no-ext-diff", await blob("before", before), await blob("after", after));
  const lines = diff.split("\n");
  const first = lines.findIndex((line) => line.startsWith("@@"));
  return first === -1
    ? ""
    : lines
        .slice(first)
        .map((line) => line.replace(HUNK_HEADER, "@@"))
        .join("\n")
        .trimEnd();
}
