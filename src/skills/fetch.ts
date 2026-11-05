// Fetches the pinned skills into a Product checkout's gitignored .claude/skills/
// before `claude` starts (ADR-0003, ADR-0008): the Base skills Fabrik's own
// lockfile pins, plus the Extra skills the Product repo picks from its own
// Skills sources. Run as
//   node src/skills/fetch.ts <product checkout> [role]
// where a role installs only that role's Extra skills, and none installs every
// pick. Each download is content-addressed by commit, so the SHA is the pin.
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { readKitConfigFromCheckout } from "../kit/checkout.ts";
import { type Phase, PHASES, picksIn } from "../kit/config.ts";
import { checkExtraSkills } from "./extra.ts";
import { INSTALL_RECORD, type InstallRecord, parseInstallRecord } from "./installRecord.ts";
import { PLUGIN_MANIFEST_PATH, readSkillsLock, SKILLS_LOCK_PATH, skillFolders } from "./lock.ts";

const run = promisify(execFile);

/** The single-SHA marker the install record replaced, removed when a fetch finds it. */
const OLD_SKILLS_MARKER = ".fabrik-skills-sha";

/** Which Extra skill picks a fetch installs: one role's, or every role's (a session at the wheel). */
export type SkillsToInstall = Phase | "every";

export interface FetchOptions {
  /** Which picks to install beside the Base skills; every pick unless one role is named. */
  readonly install?: SkillsToInstall;
}

/** What a fetch left in .claude/skills/. */
export interface InstalledSkills {
  /** The upstream commit the installed Base skills came from. */
  readonly sha: string;
  /** The Base skills this fetch installed, empty when the right ones were already there. */
  readonly skills: readonly string[];
  /** Whether it downloaded the Base skills, rather than finding that commit already installed. */
  readonly fetched: boolean;
  /** The Extra skills now installed, by the name they install as. */
  readonly extraSkills: readonly string[];
  /**
   * Why the requested Extra skills weren't installed: Kit config errors, or
   * what the manifest check found. The Base skills are installed either way.
   */
  readonly errors: readonly string[];
}

/** Downloads a URL's bytes, failing on anything but success. */
export type Download = (url: string) => Promise<Buffer>;

const downloadFromGitHub: Download = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Downloading ${url} failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

/** Fabrik's own skills, the folders under the Kit's skills/. */
const KIT_SKILLS_DIR = "skills";

/** One Skills source the fetch was asked to install from, and what it found there. */
interface Wanted {
  readonly repository: string;
  readonly sha: string;
  /** The skill names wanted from it; the Base source wants every one its manifest lists. */
  readonly skills: readonly string[];
  /** Where the downloaded archive was extracted; undefined when the record says it's already installed. */
  readonly extracted?: string;
  /** The manifest text, null when the source has none; undefined when it wasn't downloaded. */
  readonly manifest?: string | null;
}

/**
 * Installs the Base skills the Kit checkout's lockfile pins, plus the
 * requested Extra skills the Product checkout's Kit config picks, into the
 * Product checkout. Actions and the SessionStart hook both call it with Fabrik
 * checked out at the pinned release, so both install the same commits.
 *
 * Each source's archive is downloaded at most once, and not at all when the
 * install record shows the same pin and skills already there. Skills the Kit
 * installed earlier that are no longer wanted are removed; a folder the
 * install record doesn't name is never touched.
 */
export async function fetchSkills(
  kitDir: string,
  productDir: string,
  download: Download = downloadFromGitHub,
  { install = "every" }: FetchOptions = {},
): Promise<InstalledSkills> {
  const lock = readSkillsLock(await readFile(join(kitDir, SKILLS_LOCK_PATH), "utf8"));
  const dest = skillsDir(productDir);
  const recordPath = join(dest, INSTALL_RECORD);
  const record = (await readInstallRecord(productDir)) ?? [];
  const installedFrom = (repository: string) => record.find((source) => source.repository === repository);

  const resolved = await readKitConfigFromCheckout(productDir);
  const config = resolved.ok ? resolved.config : null;
  const picks = config === null ? [] : picksIn(config, install === "every" ? PHASES : [install]);

  const work = await mkdtemp(join(tmpdir(), "fabrik-skills-"));
  try {
    const fetchSource = async (repository: string, sha: string) => {
      const extracted = join(work, `${repository.replace("/", "-")}-${sha}`);
      const archive = `${extracted}.tar.gz`;
      await writeFile(archive, await download(`https://codeload.github.com/${repository}/tar.gz/${sha}`));
      await mkdir(extracted);
      await run("tar", ["-xzf", archive, "-C", extracted, "--strip-components=1"]);
      const manifest = await readFile(join(extracted, PLUGIN_MANIFEST_PATH), "utf8").catch(() => null);
      return { extracted, manifest };
    };

    const base = installedFrom(lock.repository);
    let baseWanted: Wanted;
    if (base?.sha === lock.sha) {
      baseWanted = { ...lock, skills: base.skills };
    } else {
      const fetched = await fetchSource(lock.repository, lock.sha);
      // The Base source must have a manifest; without one there's nothing to install.
      const folders = skillFolders(fetched.manifest ?? "{}");
      baseWanted = { ...lock, skills: folders.map((folder) => folder.name), ...fetched };
    }

    const extras: Wanted[] = [];
    for (const source of config?.skillsSources ?? []) {
      const skills = picks.filter((pick) => pick.source === source.repository).map((pick) => pick.name);
      if (skills.length === 0) continue;
      const earlier = installedFrom(source.repository);
      if (earlier?.sha === source.sha && sameSkills(earlier.skills, skills)) {
        extras.push({ ...source, skills });
      } else {
        extras.push({ ...source, skills, ...(await fetchSource(source.repository, source.sha)) });
      }
    }

    const errors =
      config === null
        ? resolved.ok ? [] : resolved.errors
        : checkExtraSkills({
            config,
            roles: install === "every" ? PHASES : [install],
            // A source the record shows unchanged passed this check when it was installed.
            manifests: new Map(
              extras.flatMap((source) => (source.extracted === undefined ? [] : [[source.repository, source.manifest ?? null]])),
            ),
            baseSkills: baseWanted.skills,
            kitSkills: await kitSkillNames(kitDir),
          });
    const wanted = errors.length === 0 ? [baseWanted, ...extras] : [baseWanted];
    const changed = wanted.some((source) => source.extracted !== undefined);
    const wantedNames = new Set(wanted.flatMap((source) => source.skills));
    const dropped = record.flatMap((source) => source.skills).filter((name) => !wantedNames.has(name));
    if (!changed && dropped.length === 0 && record.length === wanted.length) {
      return { sha: lock.sha, skills: [], fetched: false, extraSkills: extraNames(wanted), errors };
    }

    await mkdir(dest, { recursive: true });
    await rm(recordPath, { force: true });
    await rm(join(dest, OLD_SKILLS_MARKER), { force: true });
    for (const name of dropped) await rm(join(dest, name), { recursive: true, force: true });
    for (const source of wanted) {
      if (source.extracted === undefined) continue;
      const folders = skillFolders(source.manifest ?? "{}");
      for (const name of source.skills) {
        const folder = folders.find((candidate) => candidate.name === name);
        if (folder === undefined) continue;
        const target = join(dest, name);
        await rm(target, { recursive: true, force: true });
        // verbatimSymlinks keeps a link as a link rather than following it out of the archive.
        await cp(join(source.extracted, folder.from), target, { recursive: true, verbatimSymlinks: true });
      }
    }
    const next: InstallRecord = wanted.map(({ repository, sha, skills }) => ({ repository, sha, skills }));
    await writeFile(recordPath, `${JSON.stringify(next, null, 2)}\n`);
    const fetched = baseWanted.extracted !== undefined;
    return {
      sha: lock.sha,
      skills: fetched ? baseWanted.skills : [],
      fetched,
      extraSkills: extraNames(wanted),
      errors,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The Extra skills among what's wanted: everything after the Base source. */
function extraNames(wanted: readonly Wanted[]): readonly string[] {
  return wanted.slice(1).flatMap((source) => source.skills);
}

/** The names Fabrik's own skills install as: the folders under the Kit's skills/. */
export async function kitSkillNames(kitDir: string): Promise<readonly string[]> {
  const entries = await readdir(join(kitDir, KIT_SKILLS_DIR), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function sameSkills(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name) => b.includes(name));
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
  return text === null ? undefined : parseInstallRecord(text);
}

if (import.meta.main) {
  const [productDir, role] = process.argv.slice(2);
  if (productDir === undefined || (role !== undefined && !(PHASES as readonly string[]).includes(role))) {
    console.error(`Usage: node src/skills/fetch.ts <product checkout> [${PHASES.join("|")}]`);
    process.exit(2);
  }
  const kitDir = resolve(import.meta.dirname, "..", "..");
  // An agent job names its role, and gets only that role's Extra skills.
  const install = (role ?? "every") as SkillsToInstall;
  fetchSkills(kitDir, productDir, downloadFromGitHub, { install }).then(
    ({ sha, skills, fetched, extraSkills, errors }) => {
      console.log(
        fetched
          ? `Installed ${skills.length} skills at ${sha} into ${productDir}/.claude/skills: ${skills.join(", ")}`
          : `The skills at ${sha} are already installed in ${productDir}/.claude/skills`,
      );
      if (extraSkills.length > 0) console.log(`Extra skills installed: ${extraSkills.join(", ")}`);
      if (errors.length > 0) {
        for (const error of errors) console.error(error);
        console.error("The Extra skills were not installed, so this run stops before claude starts.");
        process.exitCode = 1;
      }
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
