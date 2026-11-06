// The UI evidence module (#153): whether a pull request is UI, which routes to
// capture and why, and the capture result the Implement job's capture step
// writes and every later reader shares. Pure, no I/O.
import { posix } from "node:path";
import type { UiConfig } from "../kit/config.ts";

/**
 * Whether a pull request is UI: some changed path matches one of `ui.paths`,
 * read as Node's path globs. Only the Kit makes this call, from the diff, never an agent.
 */
export function isUi(diffPaths: readonly string[], ui: UiConfig | null): boolean {
  return ui !== null && diffPaths.some((path) => ui.paths.some((glob) => posix.matchesGlob(path, glob)));
}
