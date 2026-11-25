// What the Kit knows of an Operator session, starting with the Session environment it opens in. Pure.
import type { KitConfig } from "./config.ts";

/**
 * The bare Session environment's name: the one on each Subscription that
 * holds no credential, which every repo that attaches nothing to its Operator
 * sessions shares. The Kit fixes it, so the Console's link and the
 * `SessionStart` hook's check name it alike.
 */
export const BARE_SESSION_ENVIRONMENT = "operator-sessions";

/**
 * Where a Product repo says, in prose, what its Operator sessions can reach.
 * Only an Operator session reads it, and no Kit code acts on what it says.
 */
export const OPERATOR_SESSION_PATH = ".fabrik/operator-session.md";

/**
 * The name of the Session environment a repo's Operator sessions open in: its
 * Kit config's `console.session_environment` when it names one, and the bare
 * one's otherwise. A reader passes null for a Kit config it didn't read, that
 * is invalid, or that isn't there, as in `fabrik`, so each gets the bare one,
 * the environment with no credential. No name is ever worked out from a
 * repo's name.
 */
export function sessionEnvironmentOf(config: KitConfig | null): string {
  return config?.console.sessionEnvironment ?? BARE_SESSION_ENVIRONMENT;
}
