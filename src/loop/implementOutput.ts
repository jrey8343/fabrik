// The Implementer output contract: alongside its commits (passed out as a git
// bundle), an Implement agent job emits the title and summary of the draft PR
// its push job opens. Both sides check it, so a malformed output never half-applies.
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
}

export type ImplementOutputResult =
  | { readonly ok: true; readonly output: ImplementOutput }
  | { readonly ok: false; readonly errors: readonly string[] };

/** GitHub caps PR titles at 256 characters. */
const MAX_TITLE = 256;

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Checks an already-parsed value against the contract, naming every problem. */
export function readImplementOutput(value: unknown): ImplementOutputResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["Implementer output must be a JSON object"] };
  }
  const { title, summary, fix, operatorCommentsConsidered: considered } = value as Record<string, unknown>;
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

/** Parses the text an agent emitted, then checks it, against the contract for a run on an existing PR when `onPullRequest`. */
export function parseImplementOutput(text: string, onPullRequest = false): ImplementOutputResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`Implementer output is not valid JSON: ${(error as Error).message}`] };
  }
  return onPullRequest ? readPullRequestRunOutput(value) : readImplementOutput(value);
}
