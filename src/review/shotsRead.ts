// The review job's reading of the Evidence shots artifact it downloaded
// (#820): `manifest.json` and the images it lists, never anything else in
// the folder, read by the artifact's rules (src/evidence/shotsManifest.ts)
// against the pull request's names, and the Evidence page of every shot the
// reading kept. It runs none of it: the pull request's own code wrote it.
import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type PageShot, shotsEvidencePage } from "../evidence/evidencePage.ts";
import { collectShots, type ReviewShots, type ShotsCollected } from "../evidence/shotsCollect.ts";
import { type ArtifactFile, readShotsManifest, SHOTS_MANIFEST_FILE, type ShotSize } from "../evidence/shotsManifest.ts";

/**
 * What the review job's read step leaves: what it collected, or null when it
 * could read nothing of an artifact the check did upload, and the Evidence
 * page's HTML, or null when it has no shot to show.
 */
export interface DownloadedShots {
  readonly collected: ShotsCollected | null;
  readonly page: string | null;
}

/**
 * Reads the folder `dir` the review job downloaded the named check's
 * artifact into, when the find step `found` one, against the names the
 * Review was `given`, at `head`, the named check `red` or not. No artifact
 * found is `no-artifact`. A folder that isn't there although one was found,
 * as when its download failed, is read as nothing at all, never as
 * `no-artifact`, which means only that the check uploaded none: the Review
 * then runs no Reviewer, as a wait that gives up runs none, and the section
 * keeps waiting. The Evidence page holds every shot the reading kept, the
 * named ones first, for `ticket`.
 */
export async function readDownloadedShots({
  dir,
  found,
  given,
  head,
  red,
  ticket,
}: {
  readonly dir: string;
  readonly found: boolean;
  readonly given: ReviewShots;
  readonly head: string;
  readonly red: boolean;
  readonly ticket: number;
}): Promise<DownloadedShots> {
  if (!found) return { collected: collectShots({ reading: null, given, head, red }), page: null };
  const files = await filesIn(dir);
  if (files === null) return { collected: null, page: null };
  const manifest = await readFile(join(dir, SHOTS_MANIFEST_FILE), "utf8").catch(() => null);
  const reading = readShotsManifest(manifest, files);
  const collected = collectShots({ reading, given, head, red });
  if (!reading.ok || reading.shots.length === 0) return { collected, page: null };
  // Only the images of the shots that passed the rules, which the reader allows only as flat .png names beside the manifest.
  const shots = await Promise.all(
    reading.shots.map(async ({ name, journey, path, images }): Promise<PageShot> => {
      const read = await Promise.all(Object.entries(images).map(async ([size, file]) => [size, await readFile(join(dir, file))] as const));
      return { name, ...(journey === undefined ? {} : { journey }), ...(path === undefined ? {} : { path }), images: Object.fromEntries(read) as Partial<Record<ShotSize, Uint8Array>> };
    }),
  );
  return { collected, page: shotsEvidencePage(shots, { ticket, headSha: head, check: given.check, named: given.names }) };
}

/** The bytes the reader needs of each file: enough to tell a PNG. */
const START_BYTES = 8;

/** The regular files at the folder's top, each with its size and how it starts; null when the folder isn't there. */
async function filesIn(dir: string): Promise<ArtifactFile[] | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return null;
  const files: ArtifactFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const handle = await open(join(dir, entry.name), "r");
    try {
      const { size } = await handle.stat();
      const start = new Uint8Array(START_BYTES);
      const { bytesRead } = await handle.read(start, 0, START_BYTES, 0);
      files.push({ name: entry.name, size, start: start.subarray(0, bytesRead) });
    } finally {
      await handle.close();
    }
  }
  return files;
}
