// The notes for the release that follows merged work to production, keeps a
// Prototype's captures and writes a Round as data are drafted ahead, beside the
// others (#641). While they are a draft they must say what the code does: the
// figures they give are the ones the code holds. Once the release ships they
// are a record, listed in RELEASED_NOTES, and keep the words of their day.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import { MERGED_STANDS_HOURS, NO_DEPLOY_SEEN_MINUTES } from "./standingProduction.ts";

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

  it("give only the figures the code holds: the 24 hours a merge is followed, the hour before No deploy seen, the 30 days captures are kept", async () => {
    const notes = await read(NOTES);
    const loop = await read(".github/workflows/loop.yml");
    const keptDays = (step: string): number => {
      const from = loop.indexOf(`- name: ${step}\n`);
      expect(from).toBeGreaterThan(-1);
      return Number(/retention-days: (\d+)/.exec(loop.slice(from))?.[1]);
    };
    const kept = keptDays("Keep the prototype's captures");
    expect(keptDays("Keep the prototype's Evidence page")).toBe(kept);

    const hours = [...notes.matchAll(/(\d+) hours?\b/g)].map((match) => Number(match[1]));
    const days = [...notes.matchAll(/(\d+) days?\b/g)].map((match) => Number(match[1]));
    const minutes = [...notes.matchAll(/(\d+) minutes?\b/g)].map((match) => Number(match[1]));
    expect(hours.length).toBeGreaterThan(0);
    expect(new Set(hours)).toEqual(new Set([MERGED_STANDS_HOURS]));
    expect(new Set(days)).toEqual(new Set([kept]));
    expect(minutes).toEqual([]);
    // The notes give No deploy seen's wait in words, as "an hour".
    expect(notes).toContain("within an hour of the merge");
    expect(NO_DEPLOY_SEEN_MINUTES).toBe(60);
  });

  it("agree with the README, whose production paragraph cites the ADR it follows by its number", async () => {
    const readme = await read("README.md");
    const production = readme.split("\n").find((line) => line.startsWith("- `production` (default `null`)"));
    expect(production).toContain("(ADR-0021)");
    const adrs = await readdir(join(KIT, "docs/adr"));
    expect(adrs.some((name) => name.startsWith("0021-live-is-read-from-github-deployments"))).toBe(true);
  });
});
