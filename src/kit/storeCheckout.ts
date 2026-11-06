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
import type { KitConfig } from "./config.ts";
import { readRunRecord, type RunRecord } from "./runRecord.ts";
import type { ScoreFile } from "./scorer.ts";

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

/** Every file under `runs/` or `scores/`, parsed, by its path in the store, whatever repo or month. */
async function readStoreFiles(storeDir: string, directory: "runs" | "scores"): Promise<[string, unknown][]> {
  const paths = await pathsIn(storeDir, directory, ".json");
  return Promise.all(paths.map(async (path): Promise<[string, unknown]> => [path, JSON.parse(await readFile(join(storeDir, path), "utf8"))]));
}

/**
 * Every Run record under `runs/`, by its path in the store, at the current
 * schema: a schema 1 record, which names no Subscription, as being on the
 * first of `subscriptions` (readRunRecord). A file of a schema the Kit
 * doesn't know is left out.
 */
export async function readStoreRunRecords(
  storeDir: string,
  subscriptions: KitConfig["subscriptions"],
): Promise<Record<string, RunRecord>> {
  const files = await readStoreFiles(storeDir, "runs");
  return Object.fromEntries(
    files.flatMap(([path, file]): [string, RunRecord][] => {
      const record = readRunRecord(file, subscriptions);
      return record === null ? [] : [[path, record]];
    }),
  );
}

/** Every schema 1 score file under `scores/`, by its path in the store. */
export async function readStoreScoreFiles(storeDir: string): Promise<Record<string, ScoreFile>> {
  const files = await readStoreFiles(storeDir, "scores");
  return Object.fromEntries(
    files.filter((entry): entry is [string, ScoreFile] => {
      const [, file] = entry;
      return typeof file === "object" && file !== null && (file as { schema?: unknown }).schema === 1;
    }),
  );
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
