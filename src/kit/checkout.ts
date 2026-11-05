// Reads the Kit config folder from a Product checkout on disk, as data only.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { instructionsPath, KIT_CONFIG_PATH, type KitConfigResult, PHASES, resolveKitConfig } from "./config.ts";

/** The file's text, or null if it isn't there. */
export async function readIfPresent(path: string): Promise<string | null> {
  return (await readBytesIfPresent(path))?.toString("utf8") ?? null;
}

/** The file's bytes, or null if it isn't there. */
export async function readBytesIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The Product checkout's Kit config, every default filled in, or what's wrong with it. */
export async function readKitConfigFromCheckout(productDir: string): Promise<KitConfigResult> {
  const [config, ...instructions] = await Promise.all([
    readIfPresent(join(productDir, KIT_CONFIG_PATH)),
    ...PHASES.map((phase) => readIfPresent(join(productDir, instructionsPath(phase)))),
  ]);
  return resolveKitConfig({
    config: config ?? null,
    instructions: Object.fromEntries(PHASES.map((phase, i) => [phase, instructions[i] ?? null])),
  });
}
