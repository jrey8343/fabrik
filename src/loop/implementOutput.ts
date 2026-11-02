// The Implementer output contract: alongside its commits (passed out as a git
// bundle), an Implement agent job emits the title and summary of the draft PR
// its push job opens. Both sides check it, so a malformed output never half-applies.

export interface ImplementOutput {
  /** The PR title, one line. */
  readonly title: string;
  /** Markdown for the PR body: what changed and how it was tested. */
  readonly summary: string;
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
  const { title, summary } = value as Record<string, unknown>;
  const errors: string[] = [];
  if (!isText(title) || title.includes("\n") || title.length > MAX_TITLE) {
    errors.push(`title must be one non-empty line of at most ${MAX_TITLE} characters`);
  }
  if (!isText(summary)) errors.push("summary must be non-empty Markdown");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, output: { title: (title as string).trim(), summary: (summary as string).trim() } };
}

/** Parses the text an agent emitted, then checks it. */
export function parseImplementOutput(text: string): ImplementOutputResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`Implementer output is not valid JSON: ${(error as Error).message}`] };
  }
  return readImplementOutput(value);
}
