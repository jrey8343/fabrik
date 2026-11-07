// Setup was once the fabrik-setup skill, which the Operator copied by hand into
// their personal skills folder. Setup is now a program the bootstrap command
// downloads for each run (ADR-0013), so a copy left there only goes stale, and
// Claude Code still lists it in every session. Setup offers to delete it, and
// the SessionStart hook warns while it's there.
import { stat } from "node:fs/promises";
import { join } from "node:path";

/** The name the old skill was copied under. */
const OLD_SETUP_SKILL = "fabrik-setup";

/** Claude Code's personal skills folder: in CLAUDE_CONFIG_DIR when that's set, else ~/.claude. Null when the environment names neither. */
export function personalSkillsDir(env: Readonly<Record<string, string | undefined>>): string | null {
  const config = env["CLAUDE_CONFIG_DIR"] || (env["HOME"] ? join(env["HOME"], ".claude") : "");
  return config === "" ? null : join(config, "skills");
}

/** The old skill's folder in these personal skills, or null when there's none. */
export async function oldSetupSkillIn(skillsDir: string | null): Promise<string | null> {
  if (skillsDir === null) return null;
  const copy = join(skillsDir, OLD_SETUP_SKILL);
  const found = await stat(copy).catch(() => null);
  return found?.isDirectory() === true ? copy : null;
}

/** What the old copy is. */
export function foundOldSetupSkill(copy: string): string {
  return `${copy} is an out-of-date copy of the ${OLD_SETUP_SKILL} skill, which Setup no longer uses.`;
}

/** The warning for a copy that's kept. */
export function staleOldSetupSkill(copy: string): string {
  return `It's stale: delete it with rm -rf '${copy.replaceAll("'", `'\\''`)}'.`;
}
