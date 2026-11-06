// Reads the Kit config folder from a Product checkout on disk, or from any
// other source of its files, as data only.
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
  return readKitConfigWith((path) => readIfPresent(join(productDir, path)));
}

/**
 * The Kit config, every default filled in, or what's wrong with it, from the
 * Kit config folder's files as `read` gives each by its path in the Product
 * repo: its text, or null when the file isn't there.
 */
export async function readKitConfigWith(read: (path: string) => Promise<string | null>): Promise<KitConfigResult> {
  const [config, skillsLock, ...instructions] = await Promise.all([
    read(KIT_CONFIG_PATH),
    read(SKILLS_SOURCES_LOCK_PATH),
    ...INSTRUCTED_ROLES.map((role) => read(instructionsPath(role))),
  ]);
  return resolveKitConfig({
    config: config ?? null,
    skillsLock: skillsLock ?? null,
    instructions: Object.fromEntries(INSTRUCTED_ROLES.map((role, i) => [role, instructions[i] ?? null])),
  });
}
