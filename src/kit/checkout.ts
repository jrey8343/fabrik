// Reads the Kit config folder from a Product checkout on disk, as data only.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { instructionsPath, KIT_CONFIG_PATH, type KitConfigResult, PHASES, resolveKitConfig } from "./config.ts";

export async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
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
