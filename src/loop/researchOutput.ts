// The research output contract (#154): the `<research>` JSON a Researcher's
// reply ends with, beside the findings file it wrote. The Kit posts it on the
// Decision as the resolution and gists it into the Map's Decisions so far. The
// agent job's schema and the push job both check it with readResearchOutput,
// so a reply that breaks it fails the run as an Infrastructure failure rather
// than half-resolving the Decision. Pure.

export interface ResearchOutput {
  /** The answer the sources give, in one line: the Map's Decisions so far line carries it. */
  readonly gist: string;
  /** What the gist rests on, at least one fact, each with its source. */
  readonly keyFacts: readonly string[];
}

export type ResearchOutputResult =
  | { readonly ok: true; readonly output: ResearchOutput }
  | { readonly ok: false; readonly errors: readonly string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Checks an already-parsed value against the contract, naming every problem. */
export function readResearchOutput(value: unknown): ResearchOutputResult {
  if (!isObject(value)) return { ok: false, errors: ["Research output must be a JSON object"] };
  const errors: string[] = [];
  const { gist, keyFacts } = value;
  if (!isText(gist)) errors.push("gist must be non-empty text");
  else if (/[\r\n]/.test(gist)) errors.push("gist must be one line");
  if (!Array.isArray(keyFacts) || keyFacts.length === 0) {
    errors.push("keyFacts must be a list of at least one fact");
  } else {
    keyFacts.forEach((fact, index) => {
      if (!isText(fact)) errors.push(`keyFacts[${index}] must be non-empty text`);
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, output: { gist: gist as string, keyFacts: keyFacts as string[] } };
}

/** Parses the text an agent emitted, then checks it. */
export function parseResearchOutput(text: string): ResearchOutputResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`Research output is not valid JSON: ${(error as Error).message}`] };
  }
  return readResearchOutput(value);
}
