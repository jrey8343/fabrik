// The glossary's term is Required check; "gating check" is under its Avoid
// line. Nothing in the repo may say the old term again, as words or as part of
// a name. The ADRs, the release notes of released versions and the research
// findings are records, and tests may name the term to check it's gone.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRecord, KIT, repoFiles } from "../__fixtures__/repoScan.ts";

/** The old term as words ("gating checks") or as part of a name ("gatingChecks", "GATING_CHECK"). */
const OLD_TERM = /gating[\s_-]?checks?/i;

/** A name that is just "gating", holding a list of checks: a parameter, field, variable or argument. */
const BARE_NAME = /\bgating\b(?=\??\s*[:=,)])/;

const isExempt = (path: string) => isRecord(path) || path.startsWith("docs/research/");

/** The lines of a file that say the old term, as `path:line: text`. */
function oldTermIn(path: string, text: string): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line, at) => {
    // The glossary names the old term as one to avoid.
    if (path === "GLOSSARY.md" && line.startsWith("_Avoid_:")) return;
    if (OLD_TERM.test(line) || (path.endsWith(".ts") && BARE_NAME.test(line))) found.push(`${path}:${at + 1}: ${line.trim()}`);
  });
  return found;
}

describe("The Kit says Required checks, not gating checks", () => {
  it("finds the old term as words and as part of a name", () => {
    expect(oldTermIn("README.md", "at least one gating check that runs")).toHaveLength(1);
    expect(oldTermIn("README.md", "- Gating checks on the PR: `build`")).toHaveLength(1);
    expect(oldTermIn("src/monitor/core.ts", "  readonly gatingChecks: readonly string[];")).toHaveLength(1);
    expect(oldTermIn("src/x.ts", "const GATING_CHECKS = [];")).toHaveLength(1);
    expect(oldTermIn(".github/workflows/loop.yml", "# read as data for its gating-check list")).toHaveLength(1);
  });

  it("finds a name that is just gating holding the list", () => {
    expect(oldTermIn("src/review/checks.ts", "export function outcome(checks: readonly CheckState[], gating: readonly string[]) {")).toHaveLength(1);
    expect(oldTermIn("src/review/wait.ts", "  const gating = resolved.config.sandbox.checks;")).toHaveLength(1);
    expect(oldTermIn("src/review/wait.ts", "      gating,")).toHaveLength(1);
  });

  it("leaves the bare word gating used as a verb, and the glossary's Avoid line", () => {
    expect(oldTermIn("docs/guide.md", "a rule gating the merge, and navigating the page")).toEqual([]);
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
