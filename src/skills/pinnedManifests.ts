// The Kit job's manifest check on a Product repo's Extra skill picks (#144):
// reads each pinned Skills source's plugin manifest at its pin, and the Base
// manifest at the Base pin, from public GitHub with no credential, then runs
// the pure check in ./extra.ts. A Product repo that pins no source pays nothing:
// no manifest is read, nor the Kit checkout's Base lock.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KitCheck } from "../kit/caller.ts";
import { type KitConfig, SKILLS_SOURCES_LOCK_PATH } from "../kit/config.ts";
import { checkExtraSkills } from "./extra.ts";
import { kitSkillNames } from "./fetch.ts";
import { foldersIn, PLUGIN_MANIFEST_PATH, readSkillsLock, SKILLS_LOCK_PATH, type SkillsLock, shortSha } from "./lock.ts";

/** A Skills source's `.claude-plugin/plugin.json` text at one commit, or null when it has none. */
export type ReadManifest = (repository: string, sha: string) => Promise<string | null>;

export interface PinnedManifestsInput {
  /** Fabrik's own lock: the Base skills' source and pin. */
  readonly baseLock: SkillsLock;
  /** The names the Kit's own skills install as. */
  readonly kitSkills: readonly string[];
  readonly readManifest?: ReadManifest;
}

/**
 * What the Kit job reports as an invalid Kit config before it routes any agent
 * run: the Kit check's own errors, or else what's wrong with the picks at
 * their pins, judged against the Base lock and the Kit skills in `kitDir`.
 */
export async function kitConfigErrors(
  check: KitCheck,
  { kitDir, readManifest }: { readonly kitDir: string; readonly readManifest?: ReadManifest },
): Promise<readonly string[]> {
  if (!check.ok) return check.errors;
  if (check.config.skillsSources.length === 0) return [];
  return checkPicksAtPins(check.config, {
    baseLock: readSkillsLock(await readFile(join(kitDir, SKILLS_LOCK_PATH), "utf8")),
    kitSkills: await kitSkillNames(kitDir),
    ...(readManifest === undefined ? {} : { readManifest }),
  });
}

/** A manifest read: its text (null when there's none), or why the read failed. */
type ManifestRead = { readonly text: string | null } | { readonly failed: string };

/** What's wrong with the Kit config's picks, given each source's manifest at its pin; empty when nothing is. */
export async function checkPicksAtPins(
  config: KitConfig,
  { baseLock, kitSkills, readManifest = readManifestFromGitHub }: PinnedManifestsInput,
): Promise<readonly string[]> {
  if (config.skillsSources.length === 0) return [];
  const read = async (repository: string, sha: string): Promise<ManifestRead> => {
    try {
      return { text: await readManifest(repository, sha) };
    } catch (error) {
      return { failed: error instanceof Error ? error.message : String(error) };
    }
  };
  const [base, ...sources] = await Promise.all([
    read(baseLock.repository, baseLock.sha),
    ...config.skillsSources.map((source) => read(source.repository, source.sha)),
  ]);

  const errors: string[] = [];
  const baseFolders = base !== undefined && "text" in base ? foldersIn(base.text) : null;
  if (baseFolders === null) {
    const reason = base !== undefined && "failed" in base ? `: ${base.failed}` : "";
    errors.push(
      `Fabrik's ${SKILLS_LOCK_PATH} pins ${baseLock.repository} at ${shortSha(baseLock.sha)}, whose plugin manifest couldn't be read${reason}`,
    );
  }
  const manifests = new Map<string, string | null>();
  config.skillsSources.forEach((source, i) => {
    const result = sources[i] ?? { failed: "it was never read" };
    if ("text" in result) {
      manifests.set(source.repository, result.text);
    } else {
      errors.push(
        `${SKILLS_SOURCES_LOCK_PATH}[${i}] pins ${source.repository} at ${shortSha(source.sha)}, whose plugin manifest couldn't be read: ${result.failed}`,
      );
    }
  });
  // Without the Base manifest the Base-name check can't run, so the picks wait until it can.
  if (baseFolders === null) return errors;
  return [
    ...errors,
    ...checkExtraSkills({ config, manifests, baseSkills: baseFolders.map((folder) => folder.name), kitSkills }),
  ];
}

/** Reads a public source's manifest at a commit; a 404 means it has none. */
export const readManifestFromGitHub: ReadManifest = async (repository, sha) => {
  const url = `https://raw.githubusercontent.com/${repository}/${sha}/${PLUGIN_MANIFEST_PATH}`;
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Reading ${url} failed: ${response.status}`);
  return response.text();
};
