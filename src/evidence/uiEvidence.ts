// The UI evidence module (#153): whether a pull request is UI, which routes to
// capture and why, and the capture result the Implement job's capture step
// writes and every later reader shares. Pure, no I/O.
import { posix } from "node:path";
import { UI_ROUTE_CAP, type UiConfig } from "../kit/config.ts";
import { linesOutsideCode } from "../loop/markers.ts";

/**
 * Whether a pull request is UI: some changed path matches one of `ui.paths`,
 * read as Node's path globs. Only the Kit makes this call, from the diff, never an agent.
 */
export function isUi(diffPaths: readonly string[], ui: UiConfig | null): boolean {
  return ui !== null && diffPaths.some((path) => ui.paths.some((glob) => posix.matchesGlob(path, glob)));
}

/** Why a route is captured: the Ticket named it, the Implementer did, or it's one of `ui.default_routes`. */
export type RouteReason = "ticket" | "implementer" | "default";

/** A route UI evidence captures, and why. */
export interface ChosenRoute {
  readonly route: string;
  readonly reason: RouteReason;
}

/** An inline code span in a Ticket body: text between single backticks on one line. */
const CODE_SPAN = /`([^`\n]+)`/g;

/** A route: a path starting with a single `/` (so never `//host/...`), with no spaces. */
const ROUTE = /^\/(?!\/)\S*$/;

/**
 * The routes a Ticket body names, in the order it names them. A Ticket names
 * a route by putting the path alone in an inline code span: `/book` or
 * `/services/physio` does, and so does `/` for the home page. A bare /book in
 * the text doesn't, nor does a code span holding anything else beside or
 * instead of one path (`GET /api/slots`, `src/pages/book.astro`, `/book now`),
 * nor anything in a fenced code block, which quotes code rather than names a route.
 */
function ticketRoutes(body: string): string[] {
  return linesOutsideCode(body)
    .flatMap((line) => [...line.matchAll(CODE_SPAN)].map(([, text = ""]) => text))
    .filter((text) => ROUTE.test(text));
}

/** The routes to capture, each with its reason. */
export function routesFor(
  ticketBody: string,
  implementerRoutes: readonly string[],
  defaultRoutes: readonly string[],
): readonly ChosenRoute[] {
  const named = onceEach([
    ...ticketRoutes(ticketBody).map((route): ChosenRoute => ({ route, reason: "ticket" })),
    ...implementerRoutes.map((route): ChosenRoute => ({ route, reason: "implementer" })),
  ]);
  const routes = named.length > 0 ? named : onceEach(defaultRoutes.map((route) => ({ route, reason: "default" })));
  // The cap trims every route but the Ticket's, which always come first.
  return routes.filter(({ reason }, index) => reason === "ticket" || index < UI_ROUTE_CAP);
}

/** Each route once, where it first appears. */
function onceEach(routes: readonly ChosenRoute[]): ChosenRoute[] {
  return routes.filter(({ route }, index) => routes.findIndex((other) => other.route === route) === index);
}
