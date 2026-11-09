import { RUBRICS_DIR } from "../kit/rubrics.ts";
import { AGENT_ROLES } from "../loop/types.ts";

/** One path an agent branch changes. A rename also carries the path it moved from. */
export interface ChangedPath {
  readonly path: string;
  readonly from?: string;
}

export type GuardResult =
  | { readonly kind: "allow" }
  | { readonly kind: "refuse"; readonly paths: readonly string[] }
  | { readonly kind: "empty-diff" };

/**
 * The trust-root guard (ADR-0005): decides whether the push job may push an
 * agent branch, given the paths it changes. Pure, no I/O. An empty diff is its
 * own result, never allow, because the Loop counts it as an Execution flaw.
 */
export function checkTrustRoot(changes: readonly ChangedPath[]): GuardResult {
  if (changes.length === 0) return { kind: "empty-diff" };
  // A rename touches both ends: moving a trust-root file away changes it as surely as editing it.
  const touched = changes.flatMap((change) => (change.from === undefined ? [change.path] : [change.from, change.path]));
  const offending = [...new Set(touched.filter(isTrustRoot))];
  if (offending.length > 0) return { kind: "refuse", paths: offending };
  return { kind: "allow" };
}

/** Instruction files agents read from any folder they work in, so they count at any depth. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

/**
 * The Kit's prompts: one for each role, and one for a Design session's
 * prototype turn (#155), a mode of the design role with a prompt of its own.
 */
export const KIT_PROMPT_NAMES = [...AGENT_ROLES, "prototype"] as const;

export type KitPrompt = (typeof KIT_PROMPT_NAMES)[number];

/** Where the Kit keeps each of its prompts, relative to the Kit's own root. */
export function kitPromptPath(prompt: KitPrompt): string {
  return `prompts/${prompt}.md`;
}

/**
 * The Kit's prompts, which steer the agents, and its Scorers' rubrics,
 * which judge their work: trust roots in any repo, so a Product's own file
 * at one of these paths is refused too. A Product's other `prompts/` files are not.
 */
const KIT_PROMPTS: readonly string[] = KIT_PROMPT_NAMES.map(kitPromptPath);
const KIT_RUBRICS = `${RUBRICS_DIR}/`;

/**
 * Folders that are trust roots only at the repo root: the Product repo's Kit
 * config and phase files, the workflows GitHub runs, and the Vision and
 * Roadmap that hold its Product intent.
 */
const ROOT_FOLDERS = [".fabrik/", ".github/workflows/", "docs/product/"];

/** The Product repo's Coding standards, which only the Reviewer reads, from the repo root. */
export const CODING_STANDARDS_FILE = "CODING_STANDARDS.md";

/** Files that are trust roots only at the repo root: the Coding standards the Reviewer judges against. */
const ROOT_FILES = [CODING_STANDARDS_FILE];

function isTrustRoot(path: string): boolean {
  if (KIT_PROMPTS.includes(path) || path.startsWith(KIT_RUBRICS)) return true;
  if (ROOT_FILES.includes(path)) return true;
  if (ROOT_FOLDERS.some((folder) => path.startsWith(folder))) return true;
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  if (INSTRUCTION_FILES.includes(name)) return true;
  // Claude settings and skills under a .claude folder at any depth.
  return segments.some((segment, i) => {
    const next = segments[i + 1];
    return segment === ".claude" && next !== undefined && (next === "skills" || next.startsWith("settings"));
  });
}
