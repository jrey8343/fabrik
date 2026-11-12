// What the tests that keep a retired word or name out of the repo scan: every
// file git knows of, less the records, which keep the words of their day.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** The Kit's repo root. */
export const KIT = resolve(import.meta.dirname, "..", "..");

/**
 * The release-notes drafts of released versions, which are records. A draft is
 * added here once its release ships: until then it's scanned like any other file.
 * Named, not read from the latest tag, since CI's shallow checkout has no tags.
 */
export const RELEASED_NOTES: ReadonlySet<string> = new Set(
  [
    "auditor",
    "ideas-and-maps",
    "monitor",
    "product-intent",
    "replay",
    "retro",
    "run-records",
    "scorers",
    "subscription-rotation",
    "ui-prototypes",
    "visual-evidence",
  ].map((name) => `docs/release-notes/${name}.md`),
);

/** The ADRs, the release notes of released versions, and tests, which may name what they check is gone. */
export const isRecord = (path: string): boolean => path.startsWith("docs/adr/") || RELEASED_NOTES.has(path) || path.endsWith(".test.ts");

/** Every file in the repo, tracked or new, as git sees it. */
export function repoFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: KIT, encoding: "utf8" })
    .split("\0")
    .filter((path) => path !== "");
}
