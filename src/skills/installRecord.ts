// The install record a skills fetch leaves beside the skills in a Product
// checkout's .claude/skills/: each Skills source installed, its SHA and the
// skills installed from it. src/skills/fetch.ts writes it; the agent job's
// summary reads it back. Pure, no I/O.

/** The install record's file name, under .claude/skills/. */
export const INSTALL_RECORD = ".fabrik-install.json";

/** One Skills source in the install record. */
export interface InstalledSource {
  /** `owner/name` on GitHub. */
  readonly repository: string;
  readonly sha: string;
  /** The skill names installed from this source, as their folders under .claude/skills/. */
  readonly skills: readonly string[];
}

/** What a fetch last installed into .claude/skills/, one entry per Skills source. */
export type InstallRecord = readonly InstalledSource[];

/**
 * The install record in `text`, or undefined when it can't be read as one. A
 * skill name must be a single folder name, since the fetch removes the folders
 * the record names; a record naming anything else is unreadable.
 */
export function parseInstallRecord(text: string): InstallRecord | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && value.every(isInstalledSource) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** One folder name: no separators, and not `.` or `..`. */
const SKILL_NAME = /^[A-Za-z0-9_.-]+$/;

function isSkillName(name: unknown): boolean {
  return typeof name === "string" && SKILL_NAME.test(name) && !/^\.+$/.test(name);
}

function isInstalledSource(value: unknown): value is InstalledSource {
  if (typeof value !== "object" || value === null) return false;
  const { repository, sha, skills } = value as Record<string, unknown>;
  return typeof repository === "string" && typeof sha === "string" && Array.isArray(skills) && skills.every(isSkillName);
}
