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

/** Records which commit the installed skills came from, beside them. */
export const SKILLS_MARKER = ".fabrik-skills-sha";

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
  const dest = resolve(productDir, ".claude", "skills");
  const marker = join(dest, SKILLS_MARKER);
  // The marker is written last, so it only names a commit that installed in full.
  const installedSha = (await readFile(marker, "utf8").catch(() => "")).trim();
  if (installedSha === lock.sha) return { sha: lock.sha, skills: [], fetched: false };

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
    await rm(marker, { force: true });
    for (const folder of folders) {
      const target = join(dest, folder.name);
      await rm(target, { recursive: true, force: true });
      // verbatimSymlinks keeps a link as a link rather than following it out of the archive.
      await cp(join(extracted, folder.from), target, { recursive: true, verbatimSymlinks: true });
    }
    await writeFile(marker, `${lock.sha}\n`);
    return { sha: lock.sha, skills: folders.map((folder) => folder.name), fetched: true };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
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
