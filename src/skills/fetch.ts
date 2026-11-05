// Fetches the pinned skills into a Product checkout's gitignored .claude/skills/
// before `claude` starts (ADR-0003). Run as
//   node src/skills/fetch.ts <product checkout>
// The download is content-addressed by commit, so the SHA in the lockfile is the pin.
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { readSkillsLock, SKILLS_LOCK_PATH, skillFolders } from "./lock.ts";

const run = promisify(execFile);

/**
 * The install record, beside the skills: each Skills source installed, its SHA
 * and the skills installed from it. It's written last, so it only ever
 * describes a complete install.
 */
export const INSTALL_RECORD = ".fabrik-install.json";

/** The single-SHA marker the install record replaced, removed when a fetch finds it. */
const OLD_SKILLS_MARKER = ".fabrik-skills-sha";

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

/** What a fetch left in .claude/skills/. */
export interface InstalledSkills {
  /** The upstream commit the installed skills came from. */
  readonly sha: string;
  /** The skills this fetch installed, empty when the right ones were already there. */
  readonly skills: readonly string[];
  /** Whether it downloaded them, rather than finding that commit already installed. */
  readonly fetched: boolean;
}

/** Downloads a URL's bytes, failing on anything but success. */
export type Download = (url: string) => Promise<Buffer>;

const downloadFromGitHub: Download = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Downloading ${url} failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

/**
 * Installs the skills the Kit checkout's lockfile pins into the Product
 * checkout. Actions and the SessionStart hook both call it with Fabrik checked
 * out at the pinned release, so both install the same commit.
 */
export async function fetchSkills(
  kitDir: string,
  productDir: string,
  download: Download = downloadFromGitHub,
): Promise<InstalledSkills> {
  const lock = readSkillsLock(await readFile(join(kitDir, SKILLS_LOCK_PATH), "utf8"));
  const dest = skillsDir(productDir);
  const recordPath = join(dest, INSTALL_RECORD);
  const installed = (await readInstallRecord(productDir))?.find((source) => source.repository === lock.repository);
  if (installed?.sha === lock.sha) return { sha: lock.sha, skills: [], fetched: false };

  const work = await mkdtemp(join(tmpdir(), "fabrik-skills-"));
  try {
    const url = `https://codeload.github.com/${lock.repository}/tar.gz/${lock.sha}`;
    const archive = join(work, "skills.tar.gz");
    await writeFile(archive, await download(url));
    const extracted = join(work, "src");
    await mkdir(extracted);
    await run("tar", ["-xzf", archive, "-C", extracted, "--strip-components=1"]);

    const folders = skillFolders(await readFile(join(extracted, ".claude-plugin", "plugin.json"), "utf8"));
    await mkdir(dest, { recursive: true });
    await rm(recordPath, { force: true });
    await rm(join(dest, OLD_SKILLS_MARKER), { force: true });
    for (const folder of folders) {
      const target = join(dest, folder.name);
      await rm(target, { recursive: true, force: true });
      // verbatimSymlinks keeps a link as a link rather than following it out of the archive.
      await cp(join(extracted, folder.from), target, { recursive: true, verbatimSymlinks: true });
    }
    const skills = folders.map((folder) => folder.name);
    const record: InstallRecord = [{ repository: lock.repository, sha: lock.sha, skills }];
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    return { sha: lock.sha, skills, fetched: true };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function skillsDir(productDir: string): string {
  return resolve(productDir, ".claude", "skills");
}

/**
 * The install record in a Product checkout, or undefined when there is none or
 * it can't be read, in which case the next fetch installs afresh.
 */
export async function readInstallRecord(productDir: string): Promise<InstallRecord | undefined> {
  const text = await readFile(join(skillsDir(productDir), INSTALL_RECORD), "utf8").catch(() => null);
  if (text === null) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && value.every(isInstalledSource) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isInstalledSource(value: unknown): value is InstalledSource {
  if (typeof value !== "object" || value === null) return false;
  const { repository, sha, skills } = value as Record<string, unknown>;
  return (
    typeof repository === "string" &&
    typeof sha === "string" &&
    Array.isArray(skills) &&
    skills.every((skill) => typeof skill === "string")
  );
}

if (import.meta.main) {
  const productDir = process.argv[2];
  if (productDir === undefined) {
    console.error("Usage: node src/skills/fetch.ts <product checkout>");
    process.exit(2);
  }
  const kitDir = resolve(import.meta.dirname, "..", "..");
  fetchSkills(kitDir, productDir).then(
    ({ sha, skills, fetched }) =>
      console.log(
        fetched
          ? `Installed ${skills.length} skills at ${sha} into ${productDir}/.claude/skills: ${skills.join(", ")}`
          : `The skills at ${sha} are already installed in ${productDir}/.claude/skills`,
      ),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
