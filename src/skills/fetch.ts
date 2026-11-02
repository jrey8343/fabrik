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

export async function fetchSkills(kitDir: string, productDir: string): Promise<readonly string[]> {
  const lock = readSkillsLock(await readFile(join(kitDir, SKILLS_LOCK_PATH), "utf8"));
  const work = await mkdtemp(join(tmpdir(), "fabrik-skills-"));
  try {
    const url = `https://codeload.github.com/${lock.repository}/tar.gz/${lock.sha}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetching skills at ${lock.sha} failed: ${response.status}`);
    const archive = join(work, "skills.tar.gz");
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const extracted = join(work, "src");
    await mkdir(extracted);
    await run("tar", ["-xzf", archive, "-C", extracted, "--strip-components=1"]);

    const folders = skillFolders(await readFile(join(extracted, ".claude-plugin", "plugin.json"), "utf8"));
    const dest = resolve(productDir, ".claude", "skills");
    await mkdir(dest, { recursive: true });
    for (const folder of folders) {
      const target = join(dest, folder.name);
      await rm(target, { recursive: true, force: true });
      // verbatimSymlinks keeps a link as a link rather than following it out of the archive.
      await cp(join(extracted, folder.from), target, { recursive: true, verbatimSymlinks: true });
    }
    await writeFile(join(dest, SKILLS_MARKER), `${lock.sha}\n`);
    return folders.map((folder) => folder.name);
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
    (names) => console.log(`Installed ${names.length} skills into ${productDir}/.claude/skills: ${names.join(", ")}`),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
