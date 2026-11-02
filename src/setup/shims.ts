// The Kit-owned files in a Product repo (ADR-0003): the caller workflow and the
// stable shims. Each is merged into what the repo already holds, keeping the
// Product's own content, so re-running setup puts back only what Fabrik owns.
// Pure, no I/O.
import { checkCallerWorkflow } from "../kit/caller.ts";

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
export function callerUpdate(existing: string | null, template: string, release: string): FileUpdate {
  const fresh = pinCaller(template, release);
  if (existing === null) return { content: fresh };
  const pins = checkCallerWorkflow(existing);
  if (!pins.ok) return { content: fresh };
  const order = compareMajors(pins.release, release);
  if (order < 0) return { content: fresh };
  if (order > 0) {
    return {
      note: `${CALLER_PATH} pins Fabrik ${pins.release}, a later major release than ${release}: run the setup skill from ${pins.release} instead. The caller workflow was left as it is.`,
    };
  }
  const repaired = pinCaller(template, pins.release);
  return existing === repaired ? null : { content: repaired };
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
  return JSON.stringify(merged) === JSON.stringify(parsed) ? null : { content: `${JSON.stringify(merged, null, 2)}\n` };
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
  const lines = existing.split("\n").map((line) => line.trim());
  if (lines.includes(SKILLS_IGNORE) || lines.includes(".claude/skills")) return null;
  const separator = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return { content: `${existing}${separator}${GITIGNORE_BLOCK}` };
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
  if (existing.includes("jrey8343/fabrik")) return null;
  const lines = existing.split("\n");
  const updatesAt = lines.findIndex((line) => /^updates:\s*$/.test(line));
  if (updatesAt === -1) return { content: template };
  const handMerge = `${DEPENDABOT_PATH} already has an entry for GitHub Actions, so the Fabrik one wasn't added: add \`- dependency-name: "jrey8343/fabrik*"\` to that entry's allow list (if it has one) and set its cooldown to 0 days.`;
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
