// Setup was the /fabrik-setup skill until the bootstrap command replaced it
// (ADR-0013). Nothing in the repo may still send the Operator to the skill, or
// have them copy one. The ADRs and the release notes of released versions are
// records, and tests may name the skill to check it's gone.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRecord, KIT, repoFiles } from "../__fixtures__/repoScan.ts";
import { WIZARD_PATH } from "./wizard.ts";

/** What sends the Operator to the skill, or has them copy one. */
const TO_THE_SKILL = [
  /(^|[\s`"'(])\/fabrik-setup\b/, // the slash command
  /\bthe setup skill\b/i,
  /\brun(s|ning)? (the )?`?fabrik-setup\b/i,
  /skills\/fabrik-setup\/(SKILL\.md|wizard\.sh)/,
  /\bcp\b[^\n]*\.claude\/skills/,
  /\bcopy (the|a|it|this) (\S+ )?skill\b/i,
];

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
