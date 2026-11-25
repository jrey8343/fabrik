// The notes for the release tags' and Setup's bootstrap's part of the major
// that carries the Kit's Operator sessions (#916) are drafted ahead, beside the
// others (#938). While they are a draft they must give the commands the Kit
// gives: Setup's two commands as `setupCommand` and the README give them. Once
// the release ships they are a record, listed in RELEASED_NOTES, and keep the
// words of their day.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import { setupCommand } from "../setup/finish.ts";

const NOTES = "docs/release-notes/release-tags.md";
const read = (path: string): string => readFileSync(join(KIT, path), "utf8");

/** The text under `## heading` in `text`, up to the next `## ` heading. */
const section = (text: string, heading: string): string => text.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";

/** Each `sh` block in `text`, as the commands it holds, its indent taken off. */
const shBlocks = (text: string): string[] =>
  [...text.matchAll(/^( *)```sh\n([\s\S]*?)\n\1```$/gm)].map(([, indent = "", body = ""]) =>
    body
      .split("\n")
      .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
      .join("\n"),
  );

/** The Spec, as the notes link it. */
const SPEC =
  "[Spec: Release tags and Setup's bootstrap: `setup.sh` fetched at the release it runs, and the releasing guide that reads the tag hold before it uses it](https://github.com/jrey8343/fabrik/issues/916)";

describe.skipIf(RELEASED_NOTES.has(NOTES))("The release tags release notes, while drafted", () => {
  const notes = read(NOTES);

  it("open with their title, the major and the Spec they are a part of, and the paste line, in one paragraph", () => {
    const [title, blank, opening, after] = notes.split("\n");

    expect(title).toBe("# Release notes: Release tags and Setup's bootstrap");
    expect([blank, after]).toEqual(["", ""]);
    expect(opening).toMatch(/^These are the notes for this part of the major that carries the Kit's Operator sessions \(/);
    expect(opening).toContain(`the major that carries the Kit's Operator sessions (${SPEC})`);
    expect(opening?.endsWith("Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.")).toBe(true);
  });

  it("are linked from the releasing guide's one entry for the Operator sessions major, with no entry of their own", () => {
    const drafted =
      read("docs/releasing.md")
        .split("\n")
        .find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`")) ?? "";
    const [, ...entries] = drafted.split("the Operator sessions major's are ");

    // One entry for the major, which holds this draft's link by its text alone. A later part adds its own after it, so nothing here says where in the entry it is.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("[release tags and Setup's bootstrap](release-notes/release-tags.md)");
  });

  it("give Setup's two commands as the Kit gives them: the named form as setupCommand gives it, and the latest form as the README does, character for character", () => {
    const commands = shBlocks(section(notes, "What changed"));
    // The README's first command under Adopting the Kit is the latest form.
    const [latest] = shBlocks(section(read("README.md"), "Adopting the Kit"));

    expect(latest).toContain("gh release view");
    expect(commands).toEqual([latest, setupCommand("<release>")]);
  });

  it("say the Console's line is a guess until the release's check of the Console, whose run replaces it", () => {
    const consoleNeeds = section(notes, "What the Console needs");

    expect(consoleNeeds).toContain("This line is a guess until the release is checked against the Console (step 4 of [releasing.md](../releasing.md)), and that run's answer replaces it.");
    expect(read("docs/releasing.md")).toContain("A line about the Console in a draft in `docs/release-notes/` was written when the part was built, so it is a guess until this run.");
  });

  it("hold each of the Spec's Tickets, by its link", () => {
    for (const ticket of [936, 937]) expect(notes).toContain(`[#${ticket}](https://github.com/jrey8343/fabrik/issues/${ticket})`);
  });
});
