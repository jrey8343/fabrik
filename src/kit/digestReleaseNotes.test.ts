// The notes for the release that ships the Digest are drafted ahead, beside
// the others (#657). While they are a draft they must say what the code does:
// the figures, the names and the Kit's own words they give are the ones the
// code holds. Once the release ships they are a record, listed in
// RELEASED_NOTES, and keep the words of their day.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";

const NOTES = "docs/release-notes/digest.md";

const read = (path: string): Promise<string> => readFile(join(KIT, path), "utf8");

describe.skipIf(RELEASED_NOTES.has(NOTES))("The Digest's release notes, while drafted", () => {
  it("open with what they are the notes for, and the releasing guide lists them last among the drafted notes", async () => {
    const notes = await read(NOTES);
    expect(notes.split("\n")[0]).toBe("# Release notes: The Digest");
    expect(notes).toMatch(/^The notes for the release that ships the Digest /m);
    expect(notes).toContain("Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.");
    const releasing = await read("docs/releasing.md");
    const drafted = releasing.split("\n").find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`"));
    expect(drafted).toContain("[the production minor's](release-notes/production.md) and [the Digest minor's](release-notes/digest.md).");
  });
});
