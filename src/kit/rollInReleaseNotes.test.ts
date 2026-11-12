// The notes for the release that ships the Roll-in are drafted ahead, beside
// the others (#665). While they are a draft they must say what the code does:
// the names and the Kit's own words they give are the ones the code holds.
// Once the release ships they are a record, listed in RELEASED_NOTES, and keep
// the words of their day.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import { FILED_FROM_HEADING, filedFromContext } from "../agent/design.ts";
import { filedFromRef, headIsFetched } from "../agent/filedFromFetch.ts";
import type { FiledFrom } from "../agent/inputs.ts";

const NOTES = "docs/release-notes/roll-in.md";

const read = (path: string): Promise<string> => readFile(join(KIT, path), "utf8");

/** The notes' bullet, top-level or nested, that opens with these bold words; empty when there is none. */
const bullet = (notes: string, opening: string): string =>
  notes
    .split("\n")
    .map((line) => line.trimStart())
    .find((line) => line.startsWith(`- **${opening}`)) ?? "";

/** The pull request #42 an issue was filed from, as the inputs step reads it: an open agent pull request at the Merge gate, unless a test says otherwise. */
const filedFrom = (overrides: Partial<Extract<FiledFrom, { kind: "pull-request" }>> = {}): FiledFrom => ({
  kind: "pull-request",
  number: 42,
  title: "Show the cart's total",
  body: "Shows the total beside the cart's heading.",
  state: "open",
  draft: false,
  headSha: "a".repeat(40),
  headRef: "fabrik/ticket-30",
  baseRef: "main",
  isAgent: true,
  ...overrides,
});

describe.skipIf(RELEASED_NOTES.has(NOTES))("The Roll-in's release notes, while drafted", () => {
  it("open with what they are the notes for, and the releasing guide lists them last among the drafted notes", async () => {
    const notes = await read(NOTES);
    expect(notes.split("\n")[0]).toBe("# Release notes: The Roll-in");
    expect(notes).toMatch(/^The notes for the release that ships the Roll-in \(\[#595\]\(https:\/\/github\.com\/jrey8343\/fabrik\/issues\/595\)/m);
    expect(notes).toContain("Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.");
    const releasing = await read("docs/releasing.md");
    const drafted = releasing.split("\n").find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`"));
    expect(drafted).toContain("[the Digest minor's](release-notes/digest.md) and [the Roll-in minor's](release-notes/roll-in.md).");
  });

  it("say what a Design-session turn is told of the pull request its issue was filed from, under the section's own heading, and on which a Roll-in is on offer", async () => {
    const notes = await read(NOTES);
    const told = bullet(notes, "A Design session on an issue filed from a pull request is told about that pull request.**");
    const stands = bullet(notes, "Where it stands says whether a Roll-in is on offer.**");
    const section = (overrides: Parameters<typeof filedFrom>[0]): string => filedFromContext(filedFrom(overrides)).join("\n");

    expect(filedFromContext(filedFrom())[0]).toBe(`## ${FILED_FROM_HEADING}`);
    expect(told).toContain("`From PR #n` line");
    expect(told).toContain(`"${FILED_FROM_HEADING}"`);
    expect(told).toContain("where it stands");
    expect(told).toContain("its description, fenced as data, never instructions");
    expect(told).toContain("afresh on every turn");
    expect(told).toContain("read-only token");

    // The section's own answer for each pull request, which the notes give in the same order.
    expect(section({ state: "merged" })).toContain("a Roll-in is not on offer");
    expect(section({ state: "closed" })).toContain("a Roll-in is not on offer");
    expect(section({ isAgent: false })).toContain("it is a Plain pull request, on which a Request changes means nothing, so a Roll-in is not on offer");
    expect(section({ draft: true })).toContain("a Roll-in may be settled: the Operator sends it once the pull request is at the Merge gate");
    expect(section({ draft: false })).toContain("a Roll-in may be settled");
    const at = ["merged", "closed unmerged", "Plain pull request", "open agent pull request", "in draft", "once it is at the Merge gate"].map((said) => stands.indexOf(said));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual(at.toSorted((a, b) => a - b));
  });

  it("say the session can read an open agent pull request's branch: where the Design job fetches its head, when, and that no credential is left behind", async () => {
    const notes = await read(NOTES);
    const fetched = bullet(notes, "The session can read an open agent pull request's branch.**");
    const failed = bullet(notes, "A read or a fetch that fails**");

    expect(filedFromRef(42)).toBe("refs/fabrik/filed-from/42");
    expect(fetched).toContain("`refs/fabrik/filed-from/<n>`");
    expect(fetched).toContain("Before the agent starts");
    expect(fetched).toContain("read-only token");
    expect(fetched).toContain("no credential is left behind");
    expect(fetched).toContain("(ADR-0002)");
    expect(fetched).toContain("The default branch stays checked out");
    // Only an open agent pull request's head is fetched.
    expect(headIsFetched(filedFrom())).toBe(true);
    expect(headIsFetched(filedFrom({ draft: true }))).toBe(true);
    expect([filedFrom({ state: "merged" }), filedFrom({ state: "closed" }), filedFrom({ isAgent: false })].some(headIsFetched)).toBe(false);
    expect(fetched).toContain("The head of a merged, closed or Plain pull request is not fetched.");
    expect(failed).toContain("fails the turn before its agent starts");
    // A line that names no pull request gives no section at all.
    expect(filedFromContext({ kind: "none" })).toEqual([]);
    expect(failed).toContain("names no pull request in the repo adds nothing");
  });

  it("say the session's first Round asks whether to roll the work in, with a recommendation, and that only the Operator's answer settles it", async () => {
    const notes = await read(NOTES);
    const prompt = await read("prompts/design.md");
    const asked = bullet(notes, "The session's first Round asks whether to roll it in.**");

    // The Design prompt's own two cases for where a Roll-in fits.
    expect(prompt).toContain("The code the issue changes exists only on the pull request's branch, or the work is a small change to what the pull request builds.");
    expect(asked).toContain("the code the issue changes exists only on that pull request's branch");
    expect(asked).toContain("a small change to what the pull request builds");
    expect(asked).toContain("with a recommendation");
    expect(asked).toContain("one reply can finish the session");
    expect(prompt).toContain("Never settle a Roll-in on your own judgement.");
    expect(asked).toContain("never settles a Roll-in on its own judgement");
  });
});
