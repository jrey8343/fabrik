// Setup was the /fabrik-setup skill until the bootstrap command replaced it
// (ADR-0013). Nothing in the repo may still send the Operator to the skill, or
// have them copy one. The ADRs and the release notes of released versions are
// records, and tests may name the skill to check it's gone.
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WIZARD_PATH } from "./wizard.ts";

const KIT = resolve(import.meta.dirname, "..", "..");

/** What sends the Operator to the skill, or has them copy one. */
const TO_THE_SKILL = [
  /(^|[\s`"'(])\/fabrik-setup\b/, // the slash command
  /\bthe setup skill\b/i,
  /\brun(s|ning)? (the )?`?fabrik-setup\b/i,
  /skills\/fabrik-setup\/(SKILL\.md|wizard\.sh)/,
  /\bcp\b[^\n]*\.claude\/skills/,
  /\bcopy (the|a|it|this) (\S+ )?skill\b/i,
];

/**
 * The release-notes drafts of released versions, which are records. A draft is
 * added here once its release ships: until then it's scanned like any other file.
 * Named, not read from the latest tag, since CI's shallow checkout has no tags.
 */
const RELEASED_NOTES = new Set(
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

const isRecord = (path: string) => path.startsWith("docs/adr/") || RELEASED_NOTES.has(path) || path.endsWith(".test.ts");

/** Every file in the repo, tracked or new, as git sees it. */
function repoFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: KIT, encoding: "utf8" })
    .split("\0")
    .filter((path) => path !== "");
}

describe("Setup is the bootstrap command, not a skill", () => {
  it("leaves no fabrik-setup skill among Fabrik's own skills", async () => {
    expect(await readdir(join(KIT, "skills"))).not.toContain("fabrik-setup");
  });

  it("keeps the wizard beside the setup program", () => {
    expect(WIZARD_PATH).toBe(join(KIT, "src", "setup", "wizard.sh"));
  });

  it("has nothing in the repo telling the Operator to run /fabrik-setup or copy a skill", async () => {
    const found: string[] = [];
    for (const path of repoFiles().filter((file) => !isRecord(file))) {
      const text = await readFile(join(KIT, path), "utf8").catch(() => "");
      text.split("\n").forEach((line, at) => {
        // The glossary names the old skill as a term to avoid.
        if (path === "GLOSSARY.md" && line.startsWith("_Avoid_:")) return;
        if (TO_THE_SKILL.some((pattern) => pattern.test(line))) found.push(`${path}:${at + 1}: ${line.trim()}`);
      });
    }

    expect(found).toEqual([]);
  });
});
