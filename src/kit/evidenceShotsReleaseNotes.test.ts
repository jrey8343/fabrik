// The notes for the release that lets UI evidence come from Evidence shots are
// drafted ahead, beside the others (#823). While they are a draft they must say
// what the code does: the figures they give are the ones the code holds. Once
// the release ships they are a record, listed in RELEASED_NOTES, and keep the
// words of their day.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import { SHOT_LIMIT, SHOT_NAME_MAX_LENGTH } from "../evidence/shotsManifest.ts";
import { MAX_RETRIES } from "../loop/retry.ts";
import { DEFAULT_SHOTS_ARTIFACT, NAMED_SHOT_CAP, REVIEWER_IMAGE_CAP } from "./config.ts";

const NOTES = "docs/release-notes/evidence-shots.md";

const read = (path: string): Promise<string> => readFile(join(KIT, path), "utf8");

describe.skipIf(RELEASED_NOTES.has(NOTES))("The Evidence shots release notes, while drafted", () => {
  it("open with what they are the notes for, and the releasing guide lists them with the other drafted notes", async () => {
    const notes = await read(NOTES);
    expect(notes.split("\n")[0]).toBe("# Release notes: UI evidence from Evidence shots");
    expect(notes).toMatch(/^The notes for the minor release that /m);
    const releasing = await read("docs/releasing.md");
    const drafted = releasing.split("\n").find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`"));
    expect(drafted).toContain("[UI evidence from Evidence shots](release-notes/evidence-shots.md)");
  });

  it("say how to turn it on: build the Product repo's side to the contract, then run /fabrik-visual-evidence and choose Evidence shots", async () => {
    const notes = await read(NOTES);
    const turnOn = notes.slice(notes.indexOf("\n## To turn it on"));
    expect(turnOn).not.toBe(notes);
    expect(turnOn).toContain("README.md#evidence-shots");
    expect(turnOn).toContain("`/fabrik-visual-evidence`");
    expect(turnOn).toContain("Evidence shots");
    expect(turnOn).toContain("Pilot");
  });

  it("give only the figures the code holds", async () => {
    const notes = await read(NOTES);
    const loop = await read(".github/workflows/loop.yml");
    const kept = Number(/retention-days: (\d+)/.exec(loop.slice(loop.indexOf("- name: Keep the Evidence page of the shots\n")))?.[1]);

    expect(notes).toContain(`\`${DEFAULT_SHOTS_ARTIFACT}\``);
    expect(notes).toContain(`at most ${["zero", "one", "two", "three", "four"][NAMED_SHOT_CAP]} Evidence shots`);
    expect(notes).toContain(`at most ${REVIEWER_IMAGE_CAP} images`);
    expect(notes).toContain(`at most ${SHOT_LIMIT} shots`);
    expect(notes).toContain(`at most ${SHOT_NAME_MAX_LENGTH} characters`);
    expect(notes).toContain(`the Ticket's ${["no", "one", "two"][MAX_RETRIES]} Retries`);
    expect(new Set([...notes.matchAll(/(\d+) days\b/g)].map((match) => Number(match[1])))).toEqual(new Set([kept]));
  });

  it("tell a reader of the Kit that Facts gains a required shotsMarkers", async () => {
    const notes = await read(NOTES);
    expect(notes).toContain("`Facts` gains `shotsMarkers`");
  });
});
