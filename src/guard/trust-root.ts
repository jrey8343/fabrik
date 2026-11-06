import { RUBRICS_DIR } from "../kit/rubrics.ts";
import { AGENT_ROLES, type AgentRole } from "../loop/types.ts";

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

/** Where the Kit keeps each role's prompt, relative to the Kit's own root. */
export function kitPromptPath(role: AgentRole): string {
  return `prompts/${role}.md`;
}

/**
 * The Kit's role prompts, which steer the agents, and its Scorers' rubrics,
 * which judge their work: trust roots only when the Loop runs on Fabrik
 * itself, since a Product's own `prompts/` folder is its own business.
 */
const KIT_PROMPTS: readonly string[] = AGENT_ROLES.map(kitPromptPath);
const KIT_RUBRICS = `${RUBRICS_DIR}/`;

/**
 * Folders that are trust roots only at the repo root: the Product repo's Kit
 * config and phase files, the workflows GitHub runs, and the Vision and
 * Roadmap that hold its Product intent.
 */
const ROOT_FOLDERS = [".fabrik/", ".github/workflows/", "docs/product/"];

function isTrustRoot(path: string): boolean {
  if (KIT_PROMPTS.includes(path) || path.startsWith(KIT_RUBRICS)) return true;
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
