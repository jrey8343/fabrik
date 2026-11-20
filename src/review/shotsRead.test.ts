// The review job's reading of the artifact it downloaded (#820): the manifest
// and the images it lists, read by the artifact's rules against the pull
// request's names, and the Evidence page of every shot.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewShots } from "../evidence/shotsCollect.ts";
import { readDownloadedShots } from "./shotsRead.ts";

const HEAD = "a".repeat(40);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const given: ReviewShots = { check: "e2e", artifact: "fabrik-evidence-shots", names: ["composer: draft ready"], sendsBackAt: HEAD };

/** A folder as download-artifact leaves the named check's artifact: these files, the manifest among them when given. */
async function downloaded(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fabrik-evidence-shots-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

const manifest = (shots: readonly unknown[]) => JSON.stringify({ version: 1, shots });
const draft = { name: "composer: draft ready", journey: "write-a-clinical-note", images: { mobile: "draft.mobile.png", desktop: "draft.desktop.png" } };
const inbox = { name: "inbox: empty", images: { mobile: "inbox.mobile.png" } };

describe("Reading the Evidence shots the review job downloaded (#820)", () => {
  it("reads the manifest and its images against the names, and builds the Evidence page of every shot, the named first", async () => {
    const dir = await downloaded({ "manifest.json": manifest([inbox, draft]), "draft.mobile.png": PNG, "draft.desktop.png": PNG, "inbox.mobile.png": PNG });

    const { collected, page } = await readDownloadedShots({ dir, found: true, given, head: HEAD, red: false, ticket: 7 });

    expect(collected).toMatchObject({ failure: null, named: [{ name: "composer: draft ready", images: draft.images }], missed: [], produced: ["inbox: empty", "composer: draft ready"], sendsBack: false });
    expect(page).toContain("<title>Evidence page: Evidence shots for #7 at aaaaaaa</title>");
    expect(page!.indexOf("<code>composer: draft ready</code>")).toBeLessThan(page!.indexOf("<code>inbox: empty</code>"));
    expect(page!.match(/data:image\/png;base64,/g)).toHaveLength(3);
  });

  it("finds a named shot the manifest lacks, which sends back at the head the plan named", async () => {
    const dir = await downloaded({ "manifest.json": manifest([inbox]), "inbox.mobile.png": PNG });

    const { collected } = await readDownloadedShots({ dir, found: true, given, head: HEAD, red: false, ticket: 7 });

    expect(collected).toMatchObject({ missed: [{ name: "composer: draft ready", why: "not-produced" }], produced: ["inbox: empty"], sendsBack: true });
  });

  it("refuses an image that isn't a PNG, and never reads a file the manifest doesn't list into the page", async () => {
    const dir = await downloaded({
      "manifest.json": manifest([{ ...draft, images: { mobile: "draft.mobile.png" } }, inbox]),
      "draft.mobile.png": "<script>not a png</script>",
      "inbox.mobile.png": PNG,
      "secret.png": PNG,
    });

    const { collected, page } = await readDownloadedShots({ dir, found: true, given, head: HEAD, red: false, ticket: 7 });

    expect(collected?.missed).toEqual([{ name: "composer: draft ready", why: "refused" }]);
    expect(page!.match(/data:image\/png;base64,/g)).toHaveLength(1);
  });

  it("is no-artifact when the check's run uploaded no artifact of that name, with no Evidence page", async () => {
    expect(await readDownloadedShots({ dir: await downloaded({}), found: false, given, head: HEAD, red: false, ticket: 7 })).toEqual({
      collected: expect.objectContaining({ failure: "no-artifact", sendsBack: false }),
      page: null,
    });
  });

  it("reads nothing, never no-artifact, when the check uploaded the artifact and its download left no folder", async () => {
    const dir = join(await downloaded({}), "never-downloaded");

    expect(await readDownloadedShots({ dir, found: true, given, head: HEAD, red: false, ticket: 7 })).toEqual({ collected: null, page: null });
  });

  it("is bad-manifest when the artifact has no manifest that reads, with no Evidence page", async () => {
    const dir = await downloaded({ "manifest.json": "{ not json", "draft.mobile.png": PNG });

    expect(await readDownloadedShots({ dir, found: true, given, head: HEAD, red: false, ticket: 7 })).toEqual({
      collected: expect.objectContaining({ failure: "bad-manifest", sendsBack: false }),
      page: null,
    });
  });
});
