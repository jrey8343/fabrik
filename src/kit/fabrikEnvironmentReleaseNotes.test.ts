// The notes for the `fabrik` environment's part of the major that carries the
// Kit's Operator sessions (#915) are drafted ahead, beside the others (#935).
// While they are a draft they must say what the code does: the environment's
// name, the hand-off's job and inputs, the accounts' names and the report's
// heading each as the code holds them, and every name they give one the code
// holds under that name. Once the release ships they are a record, listed in
// RELEASED_NOTES, and keep the words of their day.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";

const NOTES = "docs/release-notes/fabrik-environment.md";
const read = (path: string): string => readFileSync(join(KIT, path), "utf8");

/** The Spec, as the notes and the releasing guide link it. */
const SPEC = "[Spec: The Kit's tokens in the `fabrik` environment, which only the default branch may use](https://github.com/jrey8343/fabrik/issues/915)";

describe.skipIf(RELEASED_NOTES.has(NOTES))("The fabrik environment release notes, while drafted", () => {
  const notes = read(NOTES);

  it("open with their title, the major and the Spec they are a part of, and the paste line, in one paragraph", () => {
    const [title, blank, opening, after] = notes.split("\n");

    expect(title).toBe("# Release notes: the Kit's tokens in the `fabrik` environment");
    expect([blank, after]).toEqual(["", ""]);
    expect(opening).toMatch(/^These are the notes of this part of the major that carries the Kit's Operator sessions \(/);
    expect(opening).toContain(`the major that carries the Kit's Operator sessions (${SPEC})`);
    expect(opening?.endsWith("Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.")).toBe(true);
  });

  it("are linked from the releasing guide's one entry for the Operator sessions major, after the Console check's, with no entry of their own", () => {
    const drafted =
      read("docs/releasing.md")
        .split("\n")
        .find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`")) ?? "";
    const [, ...entries] = drafted.split("the Operator sessions major's are ");

    // One entry for the major, which holds this draft's link by its text. The later parts add theirs to the same entry, so nothing here says it is the last.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("[the Kit's tokens in the `fabrik` environment](release-notes/fabrik-environment.md)");
    expect(entries[0]?.startsWith("[the Console check](release-notes/console-check.md)")).toBe(true);
  });
});
