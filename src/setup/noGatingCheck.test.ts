// The glossary's term is Required check; "gating check" is under its Avoid
// line. Nothing in the repo may say the old term again, as words or as part of
// a name. The ADRs, the release notes of released versions and the research
// findings are records, and tests may name the term to check it's gone.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRecord, KIT, repoFiles } from "../__fixtures__/repoScan.ts";

/**
 * The old term as words ("gating checks") or as part of a name ("gatingChecks",
 * "GATING_CHECK"), over a line break and through the marks between: spaces,
 * Markdown emphasis, and a comment's leading `*`, `//` or `#` on its next line.
 * A lowercase "gating" at the end of a longer word ("navigating") isn't it.
 */
const OLD_TERM = /(?:(?<![a-z])gating|Gating|GATING)[\s*_#/-]*(?:checks?|Checks?|CHECKS?)/g;

/** A name that is just "gating", holding a list of checks: a parameter, field, variable or argument. */
const BARE_NAME = /\bgating\b(?=\??\s*[:=,)])/;

const isExempt = (path: string) => isRecord(path) || path.startsWith("docs/research/");

/** The lines of a file the old term starts on, as `path:line: text`. */
function oldTermIn(path: string, text: string): string[] {
  const lines = text.split("\n");
  const at = new Set<number>();
  for (const match of text.matchAll(OLD_TERM)) at.add(text.slice(0, match.index).split("\n").length - 1);
  if (path.endsWith(".ts")) lines.forEach((line, index) => BARE_NAME.test(line) && at.add(index));
  return [...at]
    .sort((a, b) => a - b)
    .map((index) => ({ index, line: lines[index] ?? "" }))
    // The glossary names the old term as one to avoid.
    .filter(({ line }) => !(path === "GLOSSARY.md" && line.startsWith("_Avoid_:")))
    .map(({ index, line }) => `${path}:${index + 1}: ${line.trim()}`);
}

describe("The Kit says Required checks, not gating checks", () => {
  it("finds the old term as words and as part of a name", () => {
    expect(oldTermIn("README.md", "at least one gating check that runs")).toHaveLength(1);
    expect(oldTermIn("README.md", "- Gating checks on the PR: `build`")).toHaveLength(1);
    expect(oldTermIn("src/monitor/core.ts", "  readonly gatingChecks: readonly string[];")).toHaveLength(1);
    expect(oldTermIn("src/x.ts", "const GATING_CHECKS = [];")).toHaveLength(1);
    expect(oldTermIn(".github/workflows/loop.yml", "# read as data for its gating-check list")).toHaveLength(1);
  });

  it("finds the old term split over a line break or by more than one mark", () => {
    const wrapped = " * ones). A skipped or cancelled check never counts as a pass, and a gating\n * check that hasn't reported yet is still pending.";
    expect(oldTermIn("src/review/checks.ts", wrapped)).toHaveLength(1);
    expect(oldTermIn("src/x.ts", "// the gating\n// check list")).toHaveLength(1);
    expect(oldTermIn(".github/workflows/loop.yml", "# a gating\n# checks list")).toHaveLength(1);
    expect(oldTermIn("README.md", "a gating\ncheck that runs")).toHaveLength(1);
    expect(oldTermIn("README.md", "at least one gating  check")).toHaveLength(1);
    expect(oldTermIn("README.md", "at least one **gating** check")).toHaveLength(1);
  });

  it("names the line the old term starts on", () => {
    expect(oldTermIn("README.md", "one\ntwo, a gating\ncheck")).toEqual(["README.md:2: two, a gating"]);
  });

  it("finds a name that is just gating holding the list", () => {
    expect(oldTermIn("src/review/checks.ts", "export function outcome(checks: readonly CheckState[], gating: readonly string[]) {")).toHaveLength(1);
    expect(oldTermIn("src/review/wait.ts", "  const gating = resolved.config.sandbox.checks;")).toHaveLength(1);
    expect(oldTermIn("src/review/wait.ts", "      gating,")).toHaveLength(1);
  });

  it("leaves the bare word gating used as a verb, and the glossary's Avoid line", () => {
    expect(oldTermIn("docs/guide.md", "a rule gating the merge, and navigating the page")).toEqual([]);
    expect(oldTermIn("docs/guide.md", "while investigating\nchecks that fail")).toEqual([]);
    expect(oldTermIn("GLOSSARY.md", "_Avoid_: gating check, status check")).toEqual([]);
  });

  it("has nothing in the repo saying gating check, but the records", async () => {
    const found: string[] = [];
    for (const path of repoFiles().filter((file) => !isExempt(file))) {
      found.push(...oldTermIn(path, await readFile(join(KIT, path), "utf8").catch(() => "")));
    }

    expect(found).toEqual([]);
  });
});
