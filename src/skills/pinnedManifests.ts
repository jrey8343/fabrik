// The Kit job's manifest check on a Product repo's Extra skill picks (#144):
// reads each pinned Skills source's plugin manifest at its pin, and the Base
// manifest at the Base pin, from public GitHub with no credential, then runs
// the pure check in ./extra.ts. A Product repo that pins no source pays nothing:
// no manifest is read.
import type { KitConfig } from "../kit/config.ts";
import { checkExtraSkills } from "./extra.ts";
import { foldersIn, PLUGIN_MANIFEST_PATH, type SkillsLock } from "./lock.ts";

/** A Skills source's `.claude-plugin/plugin.json` text at one commit, or null when it has none. */
export type ReadManifest = (repository: string, sha: string) => Promise<string | null>;

export interface PinnedManifestsInput {
  /** Fabrik's own lock: the Base skills' source and pin. */
  readonly baseLock: SkillsLock;
  /** The names the Kit's own skills install as. */
  readonly kitSkills: readonly string[];
  readonly readManifest?: ReadManifest;
}

/** What's wrong with the Kit config's picks, given each source's manifest at its pin; empty when nothing is. */
export async function checkPicksAtPins(
  config: KitConfig,
  { baseLock, kitSkills, readManifest = readManifestFromGitHub }: PinnedManifestsInput,
): Promise<readonly string[]> {
  if (config.skillsSources.length === 0) return [];
  const [baseManifest, ...manifests] = await Promise.all([
    readManifest(baseLock.repository, baseLock.sha),
    ...config.skillsSources.map((source) => readManifest(source.repository, source.sha)),
  ]);
  return checkExtraSkills({
    config,
    manifests: new Map(config.skillsSources.map((source, i) => [source.repository, manifests[i] ?? null])),
    baseSkills: (foldersIn(baseManifest ?? null) ?? []).map((folder) => folder.name),
    kitSkills,
  });
}

/** Reads a public source's manifest at a commit; a 404 means it has none. */
export const readManifestFromGitHub: ReadManifest = async (repository, sha) => {
  const url = `https://raw.githubusercontent.com/${repository}/${sha}/${PLUGIN_MANIFEST_PATH}`;
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Reading ${url} failed: ${response.status}`);
  return response.text();
};
