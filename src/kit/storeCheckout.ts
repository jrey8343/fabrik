// A checkout of the fabrik-runs store (ADR-0009), as a program that reads it
// reads its files: the Weekly summary's (src/kit/weekly-main.ts), and the
// Retro evidence job's (src/kit/retro-evidence-main.ts), whose sparse checkout
// holds one Product repo's records, score files and transcripts. Each file is
// keyed by its path in the store, as a Run record names its transcript and a
// score file's evidence names it (src/kit/runRecord.ts, src/kit/scorer.ts).
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readTranscriptGzip } from "../agent/transcript.ts";

/** Every path under one of the checkout's directories ending in `suffix`, as a path in the store: none when the directory isn't there. */
async function pathsIn(storeDir: string, directory: string, suffix: string): Promise<string[]> {
  try {
    const paths = await readdir(join(storeDir, directory), { recursive: true });
    return paths.filter((path) => path.endsWith(suffix)).map((path) => `${directory}/${path.split("\\").join("/")}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Every schema 1 file under `runs/` or `scores/`, by its path in the store, whatever repo or month. */
export async function readStoreFiles<T extends { readonly schema: number }>(storeDir: string, directory: "runs" | "scores"): Promise<Record<string, T>> {
  const paths = await pathsIn(storeDir, directory, ".json");
  const files = await Promise.all(paths.map(async (path) => [path, JSON.parse(await readFile(join(storeDir, path), "utf8")) as T] as const));
  return Object.fromEntries(files.filter(([, file]) => file.schema === 1));
}

/**
 * Every transcript under `transcripts/`, by its path in the store, as its
 * stream-json lines. The store keeps them forever and a reader digests only a
 * few, so each is read and gunzipped only when it's asked for. One cut off by
 * its run's timeout keeps the lines that decoded; bytes that aren't gzip read
 * as no lines.
 */
export async function readStoreTranscripts(storeDir: string): Promise<Readonly<Record<string, readonly string[]>>> {
  const transcripts: Record<string, readonly string[]> = {};
  for (const path of await pathsIn(storeDir, "transcripts", ".jsonl.gz")) {
    Object.defineProperty(transcripts, path, {
      enumerable: true,
      get: () => readTranscriptGzip(readFileSync(join(storeDir, path)))?.lines ?? [],
    });
  }
  return transcripts;
}
