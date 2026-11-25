// What the Kit knows of an Operator session: the Session environment it opens
// in, its address, and the marker it reports itself with on its issue, the
// first marker the Kit reads from the Operator's own comments (#951). Pure.
import type { KitConfig } from "./config.ts";
import type { CommentFacts } from "./retroEvidence.ts";

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

/** Where every Operator session's address starts: an id follows it. */
const SESSION_ADDRESS_PREFIX = "https://claude.ai/code/session_";

/** A session's id after its prefix: one or more letters, digits, `_` or `-`. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * An Operator session's address, from its `CLAUDE_CODE_REMOTE_SESSION_ID`:
 * the value with its `cse_` prefix swapped for `session_`, after
 * `https://claude.ai/code/`, so `cse_abc` gives
 * `https://claude.ai/code/session_abc`. Null for a value that is missing,
 * empty, or not `cse_` and an id. No address is built from any other id.
 */
export function sessionAddressOf(sessionId: string | undefined): string | null {
  if (sessionId === undefined || !sessionId.startsWith("cse_")) return null;
  const id = sessionId.slice("cse_".length);
  return SESSION_ID.test(id) ? `${SESSION_ADDRESS_PREFIX}${id}` : null;
}

/** Whether `text` is exactly an Operator session's address: `https://claude.ai/code/session_` and an id, and nothing else. */
export function isSessionAddress(text: string): boolean {
  return text.startsWith(SESSION_ADDRESS_PREFIX) && SESSION_ID.test(text.slice(SESSION_ADDRESS_PREFIX.length));
}

/** The name in the hidden line an Operator session reports itself with on its issue. */
export const OPERATOR_SESSION_MARKER = "fabrik:operator-session";

/**
 * The hidden line an Operator session's first comment on its issue opens
 * with, above a visible link: `<!-- fabrik:operator-session <address> -->`.
 */
export function operatorSessionMarker(address: string): string {
  return `<!-- ${OPERATOR_SESSION_MARKER} ${address} -->`;
}

/** The marker line, with the address it holds: what operatorSessionMarker writes, read back. */
const MARKER_LINE = new RegExp(`^<!-- ${OPERATOR_SESSION_MARKER} (\\S+) -->$`);

/**
 * The address of the Operator session that last reported itself among an
 * issue's comments: the newest comment by its `at` whose author is the
 * Operator, `operator` compared as the Kit compares their login elsewhere,
 * and whose first line is the marker line holding an address
 * isSessionAddress holds. Null when no comment is. A marker on any line but
 * the first, in anyone else's comment, an App's included, or holding an
 * address of any other form counts for nothing: anyone can comment on a
 * public repo, and the address is a link the Operator taps.
 */
export function operatorSessionIn(comments: readonly CommentFacts[], operator: string): string | null {
  let newest: { readonly address: string; readonly at: number } | null = null;
  for (const { author, body, at } of comments) {
    if (author !== operator) continue;
    const address = addressInMarkerLine(body.split("\n", 1)[0] ?? "");
    const when = Date.parse(at);
    if (address !== null && (newest === null || when >= newest.at)) newest = { address, at: when };
  }
  return newest?.address ?? null;
}

/** The session address a comment's first line holds as the marker line, or null. */
function addressInMarkerLine(line: string): string | null {
  const address = MARKER_LINE.exec(line.replace(/\r$/, ""))?.[1];
  return address !== undefined && isSessionAddress(address) ? address : null;
}
