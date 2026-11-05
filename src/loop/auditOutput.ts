// The Audit output contract (#150): the `<audit>` JSON an Auditor's reply ends
// with, which the Kit renders into the Audit. The agent job's schema and the
// push job both check it with readAuditOutput, so a reply that breaks it fails
// the run rather than filing a half-formed Audit. Pure.
import { STRENGTHS, type Strength } from "./types.ts";

/** A deepening opportunity the Auditor found, as it wrote it. */
export interface AuditCandidate {
  readonly title: string;
  /** Repo paths. */
  readonly files: readonly string[];
  readonly problem: string;
  readonly solution: string;
  readonly benefits: string;
  /** Mermaid source for the structure now. */
  readonly before: string;
  /** Mermaid source for the structure the Solution leaves. */
  readonly after: string;
  readonly strength: Strength;
  /** The PRs the Auditor traced it to, unchecked: the Kit keeps only merged agent PRs. */
  readonly introducedBy: readonly number[];
}

export interface AuditOutput {
  /** Strongest first. */
  readonly candidates: readonly AuditCandidate[];
  /** Text naming one candidate by its title, or null when there are none. */
  readonly topRecommendation: string | null;
}

export type AuditOutputResult =
  | { readonly ok: true; readonly output: AuditOutput }
  | { readonly ok: false; readonly errors: readonly string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** The most candidates one Audit holds, so it takes 5 to 10 minutes to read. */
export const MAX_AUDIT_CANDIDATES = 3;

/** Checks an already-parsed value against the contract, naming every problem. */
export function readAuditOutput(value: unknown): AuditOutputResult {
  if (!isObject(value)) return { ok: false, errors: ["Audit output must be a JSON object"] };
  const errors: string[] = [];
  const { candidates, topRecommendation } = value;
  if (!Array.isArray(candidates)) {
    errors.push("candidates must be a list");
  } else if (candidates.length > MAX_AUDIT_CANDIDATES) {
    errors.push(`candidates must number at most ${MAX_AUDIT_CANDIDATES}, not ${candidates.length}`);
  }
  const read = Array.isArray(candidates)
    ? candidates.map((candidate, index) => readCandidate(candidate, `candidates[${index}]`, errors))
    : [];
  const titles = read.flatMap((candidate) => (candidate === null ? [] : [candidate.title]));
  if (topRecommendation === null) {
    if (titles.length > 0) errors.push("topRecommendation must name one of the candidates by its title");
  } else if (!isText(topRecommendation)) {
    errors.push("topRecommendation must be text naming a candidate, or null when there are none");
  } else if (!titles.some((title) => topRecommendation.toLowerCase().includes(title.toLowerCase()))) {
    errors.push(
      titles.length === 0
        ? "topRecommendation must be null when there are no candidates"
        : `topRecommendation must name one of the candidates by its title (${titles.map((title) => JSON.stringify(title)).join(", ")})`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    output: { candidates: read.filter((candidate) => candidate !== null), topRecommendation: topRecommendation as string | null },
  };
}

const TEXT_FIELDS = ["title", "problem", "solution", "benefits", "before", "after"] as const;

const DIAGRAM_FIELDS = ["before", "after"] as const;

/** A Markdown code fence: three backticks or three tildes. */
const CODE_FENCE = /```|~~~/;

function readCandidate(value: unknown, where: string, errors: string[]): AuditCandidate | null {
  if (!isObject(value)) {
    errors.push(`${where} must be an object`);
    return null;
  }
  const errorsBefore = errors.length;
  for (const field of TEXT_FIELDS) {
    if (!isText(value[field])) errors.push(`${where}.${field} must be non-empty text`);
  }
  // The Kit fences each diagram itself, so a fence inside one would break the Audit's layout.
  for (const field of DIAGRAM_FIELDS) {
    const source = value[field];
    if (typeof source === "string" && CODE_FENCE.test(source)) {
      errors.push(`${where}.${field} must be bare Mermaid source, with no code fence`);
    }
  }
  const { files, strength, introducedBy } = value;
  if (!Array.isArray(files) || files.length === 0 || !files.every(isText)) {
    errors.push(`${where}.files must be a list of at least one repo path`);
  }
  if (typeof strength !== "string" || !(STRENGTHS as readonly string[]).includes(strength)) {
    errors.push(`${where}.strength must be one of ${STRENGTHS.join(", ")}, not ${JSON.stringify(strength)}`);
  }
  if (!Array.isArray(introducedBy) || !introducedBy.every((n) => Number.isInteger(n) && n > 0)) {
    errors.push(`${where}.introducedBy must be a list of PR numbers`);
  }
  if (errors.length > errorsBefore) return null;
  return {
    title: value["title"] as string,
    files: files as string[],
    problem: value["problem"] as string,
    solution: value["solution"] as string,
    benefits: value["benefits"] as string,
    before: value["before"] as string,
    after: value["after"] as string,
    strength: strength as Strength,
    introducedBy: introducedBy as number[],
  };
}

/** Parses the text an agent emitted, then checks it. */
export function parseAuditOutput(text: string): AuditOutputResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`Audit output is not valid JSON: ${(error as Error).message}`] };
  }
  return readAuditOutput(value);
}
