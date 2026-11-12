// The notes for the release that ships the Digest are drafted ahead, beside
// the others (#657). While they are a draft they must say what the code does:
// the figures, the names and the Kit's own words they give are the ones the
// code holds. Once the release ships they are a record, listed in
// RELEASED_NOTES, and keep the words of their day.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import { DIGEST_JOB_NAME } from "../github/snapshot.ts";
import { digestCommentOf, NO_DIGEST_HOWS, noDigestLine } from "../loop/digestContract.ts";
import { DIGEST_LABEL } from "../loop/labels.ts";

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

  it("say what the Operator sees at the Merge gate as the contract renders it: the top's four sections and the four folds, each by its name, in order", async () => {
    const notes = await read(NOTES);
    const digest = digestCommentOf(aDigestReply(), aDigestGiven());
    const body = digest.ok ? digest.body : "";
    const sections = [...body.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
    const folds = [...body.matchAll(/^<summary>(.+)<\/summary>$/gm)].map((match) => match[1]);

    expect(sections).toHaveLength(4);
    expect(folds).toHaveLength(4);
    const at = [...sections, ...folds].map((name) => notes.indexOf(`- **${name}**: `));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual(at.toSorted((a, b) => a - b));
    expect(notes).toContain("a comment of its own");
    expect(notes).toContain("as of one head");
  });

  it("say how the wait shows: the label, the run's title on the Actions tab as the unchanged caller names it, and the job's name", async () => {
    const notes = await read(NOTES);
    const caller = await read("templates/fabrik.yml");

    expect(DIGEST_LABEL).toBe("agent:digest");
    expect(caller).toContain("github.event.action == 'labeled' && format('PR #{0} labeled {1}', github.event.pull_request.number, github.event.label.name)");
    expect(caller).not.toContain(DIGEST_LABEL);
    expect(notes).toContain('"PR #<number> labeled agent:digest"');
    expect(notes).toContain(`"${DIGEST_JOB_NAME} PR #<number>"`);
    expect(notes).toContain("holds its `max_in_flight` slot");
  });

  it("say the gate never waits on a Digest's success, with the no-Digest line's own words and every way an attempt ends with none", async () => {
    const notes = await read(NOTES);
    const said = "No Digest could be written for this head";

    expect(noDigestLine({ head: "a".repeat(40), how: "failed" })).toContain(said);
    expect(notes).toContain(`"${said}"`);
    expect(notes).toContain("never waits on a Digest's success");
    for (const how of NO_DIGEST_HOWS) expect(notes).toContain(`\`${how}\``);
  });
});
