// Reads the Kit config folder from a Product checkout on disk, as data only.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  INSTRUCTED_ROLES,
  instructionsPath,
  KIT_CONFIG_PATH,
  type KitConfigResult,
  resolveKitConfig,
  SKILLS_SOURCES_LOCK_PATH,
} from "./config.ts";

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
  const [config, skillsLock, ...instructions] = await Promise.all([
    readIfPresent(join(productDir, KIT_CONFIG_PATH)),
    readIfPresent(join(productDir, SKILLS_SOURCES_LOCK_PATH)),
    ...INSTRUCTED_ROLES.map((role) => readIfPresent(join(productDir, instructionsPath(role)))),
  ]);
  return resolveKitConfig({
    config: config ?? null,
    skillsLock: skillsLock ?? null,
    instructions: Object.fromEntries(INSTRUCTED_ROLES.map((role, i) => [role, instructions[i] ?? null])),
  });
}
