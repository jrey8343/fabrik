// The Kit-owned files in a Product repo (ADR-0003): the caller workflow and the
// stable shims. Each is merged into what the repo already holds, keeping the
// Product's own content, so re-running setup puts back only what Fabrik owns.
// Pure, no I/O.
import { checkCallerWorkflow } from "../kit/caller.ts";
import { setupCommand } from "./finish.ts";
import { layoutOf, printJson } from "./json.ts";

/** What to do with one file: nothing, write this content, or tell the Operator why not. */
export type FileUpdate = { readonly content: string } | { readonly note: string } | null;

// --- The caller workflow -----------------------------------------------------

export const CALLER_PATH = ".github/workflows/fabrik.yml";

/** The caller template with every Fabrik uses: line pinned to the release. */
export function pinCaller(template: string, release: string): string {
  return template.replace(/(uses:\s*["']?jrey8343\/fabrik(?:\/[^@\s"']*)?@)[^\s"'#]+/g, `$1${release}`);
}

/**
 * A missing or broken caller is written at the release being set up, and one
 * pinned to an earlier major is migrated to it. Within a major, Dependabot owns
 * the pin, so a hand-edited caller is repaired at the release it already pins.
 */
export function callerUpdate(existing: string | null, template: string, release: string, path = CALLER_PATH): FileUpdate {
  const fresh = pinCaller(template, release);
  if (existing === null) return { content: fresh };
  const pins = checkCallerWorkflow(existing);
  if (!pins.ok) return { content: fresh };
  const order = compareMajors(pins.release, release);
  if (order < 0) return { content: fresh };
  if (order > 0) {
    return {
      note:
        `${path} pins Fabrik ${pins.release}, a later major release than ${release}: run Setup at ${pins.release} instead, ` +
        `with ${setupCommand(pins.release)}. The caller workflow was left as it is.`,
    };
  }
  const repaired = pinCaller(template, pins.release);
  return existing === repaired ? null : { content: repaired };
}

// --- The fabrik-runs store's caller workflow ----------------------------------

export const STORE_CALLER_PATH = ".github/workflows/weekly-summary.yml";

/** The store caller template with its Monday-morning schedule in the Operator's time zone. */
export function scheduleIn(template: string, timeZone: string): string {
  return template.replace(/^(\s+timezone:\s*)\S.*$/m, `$1${JSON.stringify(timeZone)}`);
}

/** The Operator's time zone, as `scheduleIn` wrote it into the store's caller, or null if it names none. */
export function timeZoneIn(caller: string): string | null {
  const value = /^\s+timezone:\s*(\S.*?)\s*$/m.exec(caller)?.[1];
  if (value === undefined) return null;
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

/** Semver majors, where each 0.x minor is a major of its own. */
function compareMajors(a: string, b: string): number {
  const [aMajor, aMinor] = majorLine(a);
  const [bMajor, bMinor] = majorLine(b);
  return aMajor !== bMajor ? aMajor - bMajor : aMinor - bMinor;
}

function majorLine(release: string): [number, number] {
  const [major = 0, minor = 0] = release.replace(/^v/, "").split(/[.-]/).map(Number);
  return major === 0 ? [0, minor] : [major, 0];
}

// --- .claude/settings.json ---------------------------------------------------

export const SETTINGS_PATH = ".claude/settings.json";

type Json = Record<string, unknown>;

/**
 * The template's SessionStart hook entry and plugin switches, merged into the
 * Product's settings. An earlier Fabrik entry is replaced where it stands.
 */
export function settingsUpdate(existing: string | null, template: string): FileUpdate {
  const ours = JSON.parse(template) as { hooks: { SessionStart: unknown[] }; enabledPlugins: Json };
  if (existing === null) return { content: template };
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return { note: `${SETTINGS_PATH} isn't valid JSON, so the Fabrik SessionStart hook entry wasn't added: fix it and run setup again.` };
  }
  if (!isObject(parsed)) return { note: `${SETTINGS_PATH} isn't a JSON object, so the Fabrik SessionStart hook entry wasn't added.` };

  const hooks = isObject(parsed["hooks"]) ? parsed["hooks"] : {};
  const sessionStart = Array.isArray(hooks["SessionStart"]) ? (hooks["SessionStart"] as unknown[]) : [];
  const firstFabrik = sessionStart.findIndex(isFabrikEntry);
  const kept = sessionStart.filter((entry) => !isFabrikEntry(entry));
  const at = firstFabrik === -1 ? kept.length : firstFabrik;
  const mergedSessionStart = [...kept.slice(0, at), ...ours.hooks.SessionStart, ...kept.slice(at)];
  const plugins = isObject(parsed["enabledPlugins"]) ? parsed["enabledPlugins"] : {};

  const merged = {
    ...parsed,
    hooks: { ...hooks, SessionStart: mergedSessionStart },
    enabledPlugins: { ...plugins, ...ours.enabledPlugins },
  };
  if (JSON.stringify(merged) === JSON.stringify(parsed)) return null;
  const layout = layoutOf(existing);
  return { content: `${printJson(merged, layout)}${layout.eol}` };
}

function isFabrikEntry(entry: unknown): boolean {
  return JSON.stringify(entry).includes("jrey8343/fabrik");
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- .gitignore --------------------------------------------------------------

export const GITIGNORE_PATH = ".gitignore";
const SKILLS_IGNORE = ".claude/skills/";
const GITIGNORE_BLOCK = `# Fabrik: the skills its SessionStart hook and Kit steps install\n${SKILLS_IGNORE}\n`;

export function gitignoreUpdate(existing: string | null): FileUpdate {
  if (existing === null) return { content: GITIGNORE_BLOCK };
  const lines = trimmedLines(existing);
  if (lines.includes(SKILLS_IGNORE) || lines.includes(".claude/skills")) return null;
  return { content: appendBlock(existing, GITIGNORE_BLOCK) };
}

function trimmedLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim());
}

/** A Fabrik block after the file's own lines, set apart by one blank line. */
function appendBlock(existing: string, block: string): string {
  const separator = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${block}`;
}

// --- .prettierignore ----------------------------------------------------------

export const PRETTIERIGNORE_PATH = ".prettierignore";
const PRETTIERIGNORE_BLOCK = `# Fabrik: the Kit owns the caller workflow, so the Product's Prettier config can't format it\n${CALLER_PATH}\n`;

const PACKAGE_JSON_PATH = "package.json";

/** The repo-root files that configure Prettier, besides a "prettier" key in package.json. */
const PRETTIER_CONFIG_PATHS: readonly string[] = [
  ".prettierrc",
  ...["json", "json5", "yaml", "yml", "toml", "js", "cjs", "mjs", "ts", "cts", "mts"].map((ext) => `.prettierrc.${ext}`),
  ...["js", "cjs", "mjs", "ts", "cts", "mts"].map((ext) => `prettier.config.${ext}`),
];

/** Every file hasPrettierConfig reads. */
export const PRETTIER_DETECTION_PATHS: readonly string[] = [PACKAGE_JSON_PATH, ...PRETTIER_CONFIG_PATHS];

/** Whether the Product configures Prettier at its root. A package.json that isn't valid JSON has no Prettier key. */
export function hasPrettierConfig(files: Readonly<Record<string, string | null>>): boolean {
  if (PRETTIER_CONFIG_PATHS.some((path) => files[path] != null)) return true;
  const packageJson = files[PACKAGE_JSON_PATH];
  if (packageJson == null) return false;
  try {
    const parsed: unknown = JSON.parse(packageJson);
    return isObject(parsed) && "prettier" in parsed;
  } catch {
    return false;
  }
}

/**
 * No agent branch can push the caller workflow (the Fabrik App has no
 * workflows permission), so a Product whose Prettier config disagrees with the
 * template's quoting could never pass `prettier --check`. Only a line naming the caller exactly counts.
 */
export function prettierignoreUpdate(existing: string | null, prettierConfigured: boolean): FileUpdate {
  if (!prettierConfigured) return null;
  if (existing === null) return { content: PRETTIERIGNORE_BLOCK };
  if (trimmedLines(existing).includes(CALLER_PATH)) return null;
  return { content: appendBlock(existing, PRETTIERIGNORE_BLOCK) };
}

// --- .github/dependabot.yml --------------------------------------------------

export const DEPENDABOT_PATH = ".github/dependabot.yml";

/**
 * Dependabot reads one config, so the Fabrik entry is appended to the
 * Product's `updates:` list. A config that already updates GitHub Actions at
 * the root can't take a second entry for it, so the Operator merges that one.
 */
export function dependabotUpdate(existing: string | null, template: string): FileUpdate {
  if (existing === null) return { content: template };
  if (existing.includes("jrey8343/fabrik")) return fabrikEntryUpdate(existing, template);
  const lines = existing.split("\n");
  const updatesAt = lines.findIndex((line) => /^updates:\s*$/.test(line));
  if (updatesAt === -1) return { content: template };
  const handMerge = `${DEPENDABOT_PATH} already has an entry for GitHub Actions, so the Fabrik one wasn't added: add \`- dependency-name: "jrey8343/fabrik*"\` to that entry's allow list (if it has one), group the Fabrik pins into one PR with \`groups: { fabrik: { patterns: ["jrey8343/fabrik*"] } }\`, ignore a major with \`ignore: [{ dependency-name: "jrey8343/fabrik*", update-types: ["version-update:semver-major"] }]\`, and set its cooldown to 0 days.`;
  if (/package-ecosystem:\s*["']?github-actions/.test(existing)) return { note: handMerge };
  const laterTopLevelKey = lines.slice(updatesAt + 1).some((line) => /^[A-Za-z]/.test(line));
  if (laterTopLevelKey) {
    return { note: `${DEPENDABOT_PATH} has keys after its updates: list, so the Fabrik entry wasn't added: append the github-actions entry from Fabrik's templates/dependabot.yml to updates: by hand.` };
  }
  const templateLines = template.split("\n");
  const entry = templateLines.slice(templateLines.findIndex((line) => /^updates:\s*$/.test(line)) + 1).join("\n");
  const separator = existing.endsWith("\n") ? "" : "\n";
  return { content: `${existing}${separator}${entry}` };
}

/** A YAML text without its comment lines. */
function withoutComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/** The template's group block, which an earlier Setup's shim lacked. */
const GROUP_BLOCK = /^ {4}# Each pinned Fabrik workflow[\s\S]*?- "jrey8343\/fabrik\*"\n/m;
/** The template's ignore of a major release, which a Setup before #422 wrote no shim with. */
const IGNORE_BLOCK = /^ {4}# Never a major[\s\S]*?update-types: \["version-update:semver-major"\]\n/m;

/**
 * Fabrik pins several workflows, and Dependabot opens a PR per dependency
 * unless a group joins them, so an ungrouped shim lands a release half-bumped.
 * And a major may change the caller's shape (a job's permissions, say), which
 * a bump can't carry, so a shim that proposes one kills every run at startup
 * once it merges (#422): a major arrives only through Setup. The shim an
 * earlier Setup wrote unchanged is replaced; an edited one is the Operator's
 * to fix, and the notes say what to add.
 */
function fabrikEntryUpdate(existing: string, template: string): FileUpdate {
  // Whatever quotes the Product's formatter puts on the pattern, or none, and any comment after it.
  const grouped = /^\s+fabrik:\n\s+patterns:\n\s+- (["']?)jrey8343\/fabrik\*\1(?:\s|$)/m.test(existing);
  // The ignore of a major for the Kit, in a flow or block list, whatever the quoting.
  const ignoresMajor = /^\s+ignore:\n\s+- dependency-name: (["']?)jrey8343\/fabrik\*\1\n\s+update-types:\s*(?:\[\s*)?(?:\n\s+- )?(["']?)version-update:semver-major\2(?:\s|\]|$)/m.test(existing);
  if (grouped && ignoresMajor) return null;
  // The same shim but for a block or two and its comments, whose wording each Kit release may change.
  const earlierShims = [template.replace(GROUP_BLOCK, ""), template.replace(IGNORE_BLOCK, ""), template.replace(GROUP_BLOCK, "").replace(IGNORE_BLOCK, "")];
  if (earlierShims.some((shim) => withoutComments(shim) === withoutComments(existing))) return { content: template };
  const notes = [
    grouped
      ? []
      : `${DEPENDABOT_PATH} doesn't group the Fabrik pins, so Dependabot bumps each pinned workflow in its own PR and the caller pins two releases until both merge: add \`groups: { fabrik: { patterns: ["jrey8343/fabrik*"] } }\` to its Fabrik entry.`,
    ignoresMajor
      ? []
      : `${DEPENDABOT_PATH} doesn't ignore a major Fabrik release, so Dependabot proposes one as a plain bump, which can't carry the caller workflow changes a major may need, and a caller granting less than the release's workflows ask fails every run at startup: add \`ignore: [{ dependency-name: "jrey8343/fabrik*", update-types: ["version-update:semver-major"] }]\` to its Fabrik entry, and take a major through Setup.`,
  ].flat();
  return { note: notes.join(" ") };
}
