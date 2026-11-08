// The Implementer output contract: alongside its commits (passed out as a git
// bundle), an Implement agent job emits the title and summary of the draft PR
// its push job opens. Both sides check it, so a malformed output never half-applies.
import { isRoute } from "../kit/config.ts";
import { isCommentIdList } from "./considered.ts";

export interface ImplementOutput {
  /** The PR title, one line. */
  readonly title: string;
  /** Markdown for the PR body: what the PR as a whole changes, and how it was tested. */
  readonly summary: string;
  /**
   * For a run on an existing PR (a retry or a Request-changes run): what this
   * run was asked to fix and what it changed, posted as a comment on the PR
   * while `summary` replaces its body. A first run leaves it out.
   */
  readonly fix?: string;
  /**
   * For a run on an existing PR: the ids of the Operator comments it weighed,
   * which its fix comment links when the run was given them (src/loop/considered.ts).
   * Left out when the run gave anything but a list of ids: a bad list never fails the run.
   */
  readonly operatorCommentsConsidered?: readonly string[];
  /**
   * When the change touched UI: the routes it shows on, each a path starting
   * with `/`, so UI evidence is captured where the change is. Left out when
   * the run gave anything but a list of paths: a bad list never fails the run.
   */
  readonly routes?: readonly string[];
  /**
   * For a Request-changes run alone: its two answers about the review it was
   * started for, which the Kit records on the PR (#369). Every other run
   * leaves them out.
   */
  readonly answers?: RequestChangesAnswers;
}

/**
 * A Request-changes run's two independent answers about the review it was
 * started for: whether it holds a Review miss (GLOSSARY.md), naming each such
 * point, and whether it amends the Ticket.
 */
export interface RequestChangesAnswers {
  readonly reviewMiss: boolean;
  /** Each point that is a Review miss; none when there is no Review miss. */
  readonly points: readonly string[];
  readonly amendsTicket: boolean;
}

/** Which run's contract an Implementer output is checked against: a first run's, a retry's or conflict-only run's, or a Request-changes run's. */
export type ImplementRunKind = "first" | "pull-request" | "request-changes";

export type ImplementOutputResult =
  | { readonly ok: true; readonly output: ImplementOutput }
  | { readonly ok: false; readonly errors: readonly string[] };

/** GitHub caps PR titles at 256 characters. */
const MAX_TITLE = 256;

/** Whether a run's routes are a list of paths starting with `/`; anything else reads as none named. */
function isRouteList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isRoute);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Checks an already-parsed value against the contract, naming every problem. */
export function readImplementOutput(value: unknown): ImplementOutputResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["Implementer output must be a JSON object"] };
  }
  const { title, summary, fix, operatorCommentsConsidered: considered, routes } = value as Record<string, unknown>;
  const errors: string[] = [];
  if (!isText(title) || title.includes("\n") || title.length > MAX_TITLE) {
    errors.push(`title must be one non-empty line of at most ${MAX_TITLE} characters`);
  }
  if (!isText(summary)) errors.push("summary must be non-empty Markdown");
  if (fix !== undefined && !isText(fix)) errors.push("fix, when given, must be non-empty Markdown");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    output: {
      title: (title as string).trim(),
      summary: (summary as string).trim(),
      ...(fix === undefined ? {} : { fix: (fix as string).trim() }),
      // A malformed list never fails the run: it reads as none weighed.
      ...(isCommentIdList(considered) ? { operatorCommentsConsidered: considered } : {}),
      // Nor does a malformed list of routes: it reads as none named.
      ...(isRouteList(routes) ? { routes } : {}),
    },
  };
}

/**
 * The contract for a run on an existing PR: the output a first run gives,
 * plus the `fix` that says what this run changed.
 */
export function readPullRequestRunOutput(value: unknown): ImplementOutputResult {
  const result = readImplementOutput(value);
  if (result.ok && result.output.fix === undefined) {
    return { ok: false, errors: ["fix must be non-empty Markdown on a retry or Request-changes run"] };
  }
  return result;
}

/**
 * The contract for a Request-changes run: a run on an existing PR's, plus its
 * two answers about the review it was started for, both required.
 */
export function readRequestChangesRunOutput(value: unknown): ImplementOutputResult {
  const result = readPullRequestRunOutput(value);
  if (!result.ok) return result;
  const { reviewMiss, reviewMissPoints, amendsTicket } = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof reviewMiss !== "boolean") errors.push("reviewMiss must be true or false on a Request-changes run");
  if (typeof amendsTicket !== "boolean") errors.push("amendsTicket must be true or false on a Request-changes run");
  const points = Array.isArray(reviewMissPoints) && reviewMissPoints.length > 0 && reviewMissPoints.every(isText) ? reviewMissPoints : null;
  if (reviewMiss === true && points === null) errors.push("reviewMissPoints must name each point that is a Review miss");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    output: {
      ...result.output,
      // A no names no point, whatever the run listed.
      answers: { reviewMiss: reviewMiss as boolean, points: reviewMiss === true ? (points as string[]).map((point) => point.trim()) : [], amendsTicket: amendsTicket as boolean },
    },
  };
}

/** The contract each kind of run is checked against. */
const READERS: Readonly<Record<ImplementRunKind, (value: unknown) => ImplementOutputResult>> = {
  first: readImplementOutput,
  "pull-request": readPullRequestRunOutput,
  "request-changes": readRequestChangesRunOutput,
};

/** Parses the text an agent emitted, then checks it against the contract for `run`, a first run's unless given. */
export function parseImplementOutput(text: string, run: ImplementRunKind = "first"): ImplementOutputResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`Implementer output is not valid JSON: ${(error as Error).message}`] };
  }
  return READERS[run](value);
}
