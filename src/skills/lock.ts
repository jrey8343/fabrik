// The skills lockfile (ADR-0003): each Fabrik release pins Matt Pocock's skills
// at one commit SHA, and the Kit installs the skills that commit's plugin
// manifest promotes, flattened into a gitignored .claude/skills/. Pure, no I/O.

export interface SkillsLock {
  /** `owner/name` on GitHub. */
  readonly repository: string;
  readonly sha: string;
}

/** Where the lockfile lives in Fabrik. */
export const SKILLS_LOCK_PATH = "skills.lock.json";

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function readSkillsLock(text: string): SkillsLock {
  const value = JSON.parse(text) as Record<string, unknown>;
  const { repository, sha } = value;
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) {
    throw new Error(`${SKILLS_LOCK_PATH}: repository must be owner/name`);
  }
  if (typeof sha !== "string" || !FULL_SHA.test(sha)) {
    throw new Error(`${SKILLS_LOCK_PATH}: sha must be a 40-character commit SHA, not ${JSON.stringify(sha)}`);
  }
  return { repository, sha };
}

export interface SkillFolder {
  /** The folder in the upstream repo, such as skills/engineering/tdd. */
  readonly from: string;
  /** The folder name under .claude/skills/. */
  readonly name: string;
}

/** The folders listed in the upstream `.claude-plugin/plugin.json`, each to install as its last path segment. */
export function skillFolders(manifestText: string): readonly SkillFolder[] {
  const manifest = JSON.parse(manifestText) as { skills?: unknown };
  if (!Array.isArray(manifest.skills) || !manifest.skills.every((path) => typeof path === "string")) {
    throw new Error("The skills plugin manifest has no list of skill paths");
  }
  const folders = manifest.skills.map(skillFolder);
  const seen = new Set<string>();
  for (const { name } of folders) {
    if (seen.has(name)) throw new Error(`Two skills in the plugin manifest would both install as ${name}`);
    seen.add(name);
  }
  return folders;
}

function skillFolder(path: string): SkillFolder {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  const name = segments.at(-1);
  if (
    path.startsWith("/") ||
    segments[0] !== "skills" ||
    segments.length < 2 ||
    segments.includes("..") ||
    name === undefined
  ) {
    throw new Error(`The skills plugin manifest lists ${path}, which is outside skills/`);
  }
  return { from: segments.join("/"), name };
}
