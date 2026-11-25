// Fixtures for the skills fetch: a Kit checkout holding a skills lockfile, a
// Product checkout pinning its own Skills sources, upstream Skills sources as
// local repositories each at its commit, a seam that lays one into the folder
// it is handed and records each repository and commit it was asked for, and
// the environment that has git read `https://github.com/` from a local folder.
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { FetchSource } from "../skills/fetch.ts";

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

/** A Skills source as a local repository, and the commit that holds its skills. */
export interface SkillsSource {
  readonly dir: string;
  readonly sha: string;
}

/**
 * A Skills source as a local repository at its commit: its plugin manifest
 * lists these skill folders, each holding its SKILL.md. With `manifest: false`
 * the repo has no plugin manifest at all. With `at`, the repository is made in
 * that folder, such as one under a stand-in for github.com.
 */
export async function aSkillsSource(
  skills: Record<string, string> = { "skills/engineering/tdd": "# tdd" },
  { manifest = true, at }: { readonly manifest?: boolean; readonly at?: string } = {},
): Promise<SkillsSource> {
  const dir = at ?? (await tempDir("source"));
  const sha = await aRepository(dir, {
    ...(manifest ? { ".claude-plugin/plugin.json": JSON.stringify({ name: "mattpocock-skills", skills: Object.keys(skills) }) } : {}),
    ...Object.fromEntries(Object.entries(skills).map(([folder, text]) => [`${folder}/SKILL.md`, text])),
  });
  return { dir, sha };
}

/** One repository and commit a fetch was asked for. */
export interface Fetched {
  readonly repository: string;
  readonly sha: string;
}

/** Lays a source's files into a folder, its history left behind, as a checkout of what was fetched leaves them. */
async function layInto(source: SkillsSource, folder: string): Promise<void> {
  await cp(source.dir, folder, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (path) => !path.slice(source.dir.length).split(sep).includes(".git"),
  });
}

/** A seam that lays this source into the folder, whatever it is asked for, and records each repository and commit it was asked for. */
export function serving(source: SkillsSource): { readonly fetched: Fetched[]; readonly fetchSource: FetchSource } {
  const fetched: Fetched[] = [];
  return {
    fetched,
    fetchSource: async (repository, sha, folder) => {
      fetched.push({ repository, sha });
      await layInto(source, folder);
    },
  };
}

/** What `servingEach` holds a source under: a repository at one commit. */
export function sourceAt(repository: string, sha: string): string {
  return `${repository}@${sha}`;
}

/**
 * A seam that lays each source into the folder when asked for the repository
 * and commit it is held under (`sourceAt`), records each one it was asked
 * for, and fails on any other, so no test reaches the network.
 */
export function servingEach(sources: Readonly<Record<string, SkillsSource>>): {
  readonly fetched: Fetched[];
  readonly fetchSource: FetchSource;
} {
  const fetched: Fetched[] = [];
  return {
    fetched,
    fetchSource: async (repository, sha, folder) => {
      fetched.push({ repository, sha });
      const source = sources[sourceAt(repository, sha)];
      if (source === undefined) throw new Error(`fatal: remote error: upload-pack: not our ref ${sha}`);
      await layInto(source, folder);
    },
  };
}

/** Runs git in a folder, with no signing and a fixed author, whatever this machine's git config says. */
export function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
    { encoding: "utf8" },
  ).trim();
}

/** Makes `dir` a repository whose one branch holds these files in a commit, and gives that commit. */
export async function aRepository(dir: string, files: Record<string, string>): Promise<string> {
  await writeFiles(dir, files);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "The fixture's commit");
  return git(dir, "rev-parse", "HEAD");
}

/**
 * The environment that has git read `https://github.com/<owner>/<repo>` from
 * `<folder>/<owner>/<repo>`, so the real git runs on the address the code
 * builds and nothing reaches the network.
 */
export function gitHubFrom(folder: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${folder}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/",
  };
}

/** A Product checkout pinning these Skills sources, with these roles' Extra skill picks. */
export async function aProductCheckout(
  pins: readonly { readonly repository: string; readonly sha: string }[] = [],
  picks: Readonly<Partial<Record<"triage" | "design" | "implement" | "review", readonly string[]>>> = {},
): Promise<string> {
  const product = await tempDir("product");
  const roles = Object.fromEntries(Object.entries(picks).map(([role, skills]) => [role, { skills }]));
  await writeFiles(product, {
    ".fabrik/config.json": JSON.stringify({ roles }),
    ...(pins.length > 0 ? { ".fabrik/skills.lock.json": JSON.stringify(pins) } : {}),
  });
  return product;
}
