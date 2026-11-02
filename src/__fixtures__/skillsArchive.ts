// Fixtures for the skills fetch: a Kit checkout holding a skills lockfile, and
// an upstream skills archive like the one codeload serves for a commit.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const LOCKED_SHA = "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d";

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `fabrik-test-${prefix}-`));
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

/** A Kit checkout whose lockfile pins the skills at this SHA, plus any other files. */
export async function aKitCheckout(sha = LOCKED_SHA, files: Record<string, string> = {}): Promise<string> {
  const kit = await tempDir("kit");
  await writeFiles(kit, {
    "skills.lock.json": JSON.stringify({ repository: "mattpocock/skills", sha }),
    ...files,
  });
  return kit;
}

/** A gzipped tarball shaped like codeload's: one top folder holding the repo at that commit. */
export async function aSkillsArchive(skills: Record<string, string> = { "skills/engineering/tdd": "# tdd" }): Promise<Buffer> {
  const root = await tempDir("archive");
  const top = join(root, "skills-top");
  await writeFiles(top, {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "mattpocock-skills", skills: Object.keys(skills) }),
    ...Object.fromEntries(Object.entries(skills).map(([folder, text]) => [`${folder}/SKILL.md`, text])),
  });
  const archive = join(root, "skills.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", root, "skills-top"]);
  return readFile(archive);
}

/** A download that serves this archive and records every URL it was asked for. */
export function serving(archive: Buffer): { readonly urls: string[]; readonly download: (url: string) => Promise<Buffer> } {
  const urls: string[] = [];
  return {
    urls,
    download: async (url) => {
      urls.push(url);
      return archive;
    },
  };
}
