// The notes for the release that follows merged work to production, keeps a
// Prototype's captures and writes a Round as data are drafted ahead, beside the
// others (#641). While they are a draft they must say what the code does: the
// figures they give are the ones the code holds. Once the release ships they
// are a record, listed in RELEASED_NOTES, and keep the words of their day.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";

const NOTES = "docs/release-notes/production.md";

const read = (path: string): Promise<string> => readFile(join(KIT, path), "utf8");

describe.skipIf(RELEASED_NOTES.has(NOTES))("The production release notes, while drafted", () => {
  it("open with what they are the notes for, and the releasing guide lists them with the other drafted notes", async () => {
    const notes = await read(NOTES);
    expect(notes.split("\n")[0]).toBe("# Release notes: Production, captures and Rounds as data");
    expect(notes).toMatch(/^The notes for the minor release that /m);
    const releasing = await read("docs/releasing.md");
    const drafted = releasing.split("\n").find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`"));
    expect(drafted).toContain("[the production minor's](release-notes/production.md)");
  });
});
