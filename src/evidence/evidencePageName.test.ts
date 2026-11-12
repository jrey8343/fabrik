// The glossary calls the single HTML page the Kit uploads beside a pull
// request's UI evidence, or a Prototype's variants, the Evidence page, and keeps
// Gallery for the Console's screen (#629). Nothing the Kit ships may call its
// page by the old word, which the glossary lists under the Evidence page's
// _Avoid_. The glossary, the research notes and the ADRs are records and are
// not scanned; nor is the one fixture that holds bodies and rounds as an earlier
// release wrote them, so that they are still read.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, repoFiles } from "../__fixtures__/repoScan.ts";

/** What the Kit ships: its source, workflows, prompts, skills, starter files, README and drafted release notes. */
const SCANNED = ["src/", ".github/", "prompts/", "skills/", "templates/", "README.md", "docs/release-notes/"];

/** Bodies and rounds as an earlier release wrote them, in the old word, which the Kit must still read. */
const EARLIER_WORDING = "src/__fixtures__/earlierEvidenceWording.ts";

/** The old word, singular or plural, in any case and inside any identifier. Spelled so this file doesn't hold it. */
const OLD_WORD = /gal{2}er(?:y|ies)/gi;

/** The Console's Gallery, capitalised as the glossary has it and standing as a word of its own. */
function namesTheConsolesScreen(line: string, at: number, found: string): boolean {
  const before = line[at - 1] ?? "";
  const after = line[at + found.length] ?? "";
  return found === "Gallery" && !/[\w$]/.test(before) && !/[\w$]/.test(after);
}

/** Each use of the old word in a line that isn't the Console's Gallery. */
function oldWordsIn(line: string): string[] {
  return [...line.matchAll(OLD_WORD)].filter((match) => !namesTheConsolesScreen(line, match.index ?? 0, match[0])).map((match) => match[0]);
}

describe("The Kit calls its page of captures the Evidence page", () => {
  it("finds the old word for the page in prose, in any case, and inside identifiers", () => {
    const old = ["gal", "lery"].join("");
    const Old = `G${old.slice(1)}`;
    expect(oldWordsIn(`Open the ${old} of 2 screenshots.`)).toEqual([old]);
    expect(oldWordsIn(`${Old} of each variant`.toUpperCase())).toEqual([Old.toUpperCase()]);
    expect(oldWordsIn(`const ${old}Artifact = 1;`)).toEqual([old]);
    expect(oldWordsIn(`export function prototype${Old}() {}`)).toEqual([Old]);
    expect(oldWordsIn(`${Old}Shot`)).toEqual([Old]);
    expect(oldWordsIn(`${old.toUpperCase()}_FILE`)).toEqual([old.toUpperCase()]);
    const olds = `${old.slice(0, -1)}ies`;
    expect(oldWordsIn(`Both ${olds} name the Capture identity.`)).toEqual([olds]);
    expect(oldWordsIn(`${olds.toUpperCase()} and ${Old.slice(0, -1)}ies`)).toEqual([olds.toUpperCase(), `${Old.slice(0, -1)}ies`]);
  });

  it("lets the Console's Gallery be named, capitalised as the glossary has it", () => {
    const Old = ["Gal", "lery"].join("");
    expect(oldWordsIn(`The Console's ${Old} shows a Product repo's Prototypes.`)).toEqual([]);
    expect(oldWordsIn(`${Old}: the Console's screen`)).toEqual([]);
  });

  it("has nothing the Kit ships use the old word for its page", async () => {
    const found: string[] = [];
    const files = repoFiles().filter((path) => SCANNED.some((root) => path === root || path.startsWith(root)) && path !== EARLIER_WORDING);
    for (const path of files) {
      const text = await readFile(join(KIT, path), "utf8").catch(() => "");
      text.split("\n").forEach((line, at) => {
        if (oldWordsIn(line).length > 0) found.push(`${path}:${at + 1}: ${line.trim()}`);
      });
    }

    expect(found).toEqual([]);
  });
});
