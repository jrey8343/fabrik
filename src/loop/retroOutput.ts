// The Retro output contract (#151): the `<retro>` JSON a Retro's reply ends
// with, which the Kit checks against the evidence and renders into the Retro.
// The agent job's schema and the push job both check it with readRetroOutput,
// so a reply that breaks it fails the run as an Infrastructure failure rather
// than filing a half-formed Retro. Pure.

/** Whether a lint rule or grep assertion could catch the mistake, or only judgement can. */
export const PROPOSAL_KINDS = ["mechanical", "judgement"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** Whether a proposal makes the factory stricter or relaxes an earlier tightening. */
export const PROPOSAL_DIRECTIONS = ["tighten", "loosen"] as const;
export type ProposalDirection = (typeof PROPOSAL_DIRECTIONS)[number];

/**
 * Where a proposal's change lands, which picks its Open as issue link: a
 * Trust-root file in the Product repo, the Product repo's own code (its lint
 * config and check scripts), the Kit, or an Extra skill's Skills source.
 */
export const PROPOSAL_TARGETS = ["product-trust-root", "product-code", "kit", "extra-skill"] as const;
export type ProposalTarget = (typeof PROPOSAL_TARGETS)[number];

/**
 * The fewest merged agent PRs a loosening's streak counts, none of them named
 * in an escape, reverted or sent back with Request changes. A Kit constant:
 * landing a Retro drops a loosening whose streak falls short.
 */
export const LOOSENING_STREAK_MINIMUM = 20;

/** The counted streak a loosening rests on, unchecked: the Kit checks it against its streak table. */
export interface Streak {
  /** The merged agent PRs counted. */
  readonly pullRequests: readonly number[];
  /** The kind of PR they share, in words. */
  readonly kind: string;
}

interface ProposalFields {
  readonly title: string;
  /** What keeps going wrong. */
  readonly problem: string;
  /** The exact edit or check. */
  readonly change: string;
  readonly kind: ProposalKind;
  readonly target: ProposalTarget;
  /** The Extra skill's name when the target is `extra-skill`, and null for every other target. */
  readonly skill: string | null;
  /** Refs from the evidence bundle, unchecked: the Kit drops any the bundle doesn't hold. */
  readonly evidence: readonly string[];
}

/** A proposal that makes the factory stricter, on one escape or one repeated pattern. */
export interface TighteningProposal extends ProposalFields {
  readonly direction: "tighten";
}

/** A proposal that relaxes an earlier tightening, on a counted streak. */
export interface LooseningProposal extends ProposalFields {
  readonly direction: "loosen";
  readonly streak: Streak;
  /** The `From retro` issue or Retro proposal it relaxes. */
  readonly undoes: string;
}

/** One change to how the factory works, as the Retro wrote it. */
export type RetroProposal = TighteningProposal | LooseningProposal;

export interface RetroOutput {
  /** Most important first. */
  readonly proposals: readonly RetroProposal[];
}

export type RetroOutputResult =
  | { readonly ok: true; readonly output: RetroOutput }
  | { readonly ok: false; readonly errors: readonly string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** The most proposals one Retro holds, so it takes about 10 minutes to read. Fixed by the Kit, never a cap. */
export const MAX_RETRO_PROPOSALS = 3;

/** Checks an already-parsed value against the contract, naming every problem. */
export function readRetroOutput(value: unknown): RetroOutputResult {
  if (!isObject(value)) return { ok: false, errors: ["Retro output must be a JSON object"] };
  const { proposals } = value;
  if (!Array.isArray(proposals)) return { ok: false, errors: ["proposals must be a list"] };
  const errors: string[] = [];
  if (proposals.length > MAX_RETRO_PROPOSALS) {
    errors.push(`proposals must number at most ${MAX_RETRO_PROPOSALS}, not ${proposals.length}`);
  }
  const read = proposals.map((proposal, index) => readProposal(proposal, `proposals[${index}]`, errors));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, output: { proposals: read.filter((proposal) => proposal !== null) } };
}

const TEXT_FIELDS = ["title", "problem", "change"] as const;

function readProposal(value: unknown, where: string, errors: string[]): RetroProposal | null {
  if (!isObject(value)) {
    errors.push(`${where} must be an object`);
    return null;
  }
  const errorsBefore = errors.length;
  for (const field of TEXT_FIELDS) {
    if (!isText(value[field])) errors.push(`${where}.${field} must be non-empty text`);
  }
  const { kind, direction, target, skill, evidence, streak: givenStreak, undoes } = value;
  const enums = [
    ["kind", PROPOSAL_KINDS, kind],
    ["direction", PROPOSAL_DIRECTIONS, direction],
    ["target", PROPOSAL_TARGETS, target],
  ] as const;
  for (const [field, values, given] of enums) {
    if (!isOneOf(values, given)) errors.push(`${where}.${field} must be one of ${values.join(", ")}, not ${JSON.stringify(given)}`);
  }
  if (!Array.isArray(evidence) || !evidence.every(isText)) errors.push(`${where}.evidence must be a list of refs from the evidence`);

  // Mechanical before prose: a mistake a check could catch is proposed as one in the Product repo's own lint config or scripts.
  if (kind === "mechanical" && isOneOf(PROPOSAL_TARGETS, target) && target !== "product-code") {
    errors.push(`${where} is mechanical, so its target must be product-code, not ${JSON.stringify(target)}`);
  }

  if (target === "extra-skill") {
    if (!isText(skill)) errors.push(`${where}.skill must name the Extra skill an extra-skill proposal changes`);
  } else if (isOneOf(PROPOSAL_TARGETS, target) && isGiven(skill)) {
    errors.push(`${where}.skill is only for an extra-skill proposal, not one that targets ${JSON.stringify(target)}`);
  }

  // A loosening rests on a counted streak and names the tightening it undoes; a tightening needs neither.
  const streak = readStreak(givenStreak);
  if (direction === "loosen") {
    if (streak === null) {
      errors.push(`${where}.streak must hold the merged agent PRs counted, at least one, and the kind they share: a loosening rests on a streak`);
    }
    if (!isText(undoes)) errors.push(`${where}.undoes must name the From retro issue or Retro proposal a loosening relaxes`);
  } else if (direction === "tighten") {
    if (isGiven(givenStreak)) errors.push(`${where}.streak is only for a loosening`);
    if (isGiven(undoes)) errors.push(`${where}.undoes is only for a loosening`);
  }
  if (errors.length > errorsBefore) return null;

  const fields: ProposalFields = {
    title: value["title"] as string,
    problem: value["problem"] as string,
    change: value["change"] as string,
    kind: kind as ProposalKind,
    target: target as ProposalTarget,
    skill: target === "extra-skill" ? (skill as string) : null,
    evidence: evidence as string[],
  };
  if (direction === "loosen" && streak !== null) return { ...fields, direction, streak, undoes: undoes as string };
  return { ...fields, direction: "tighten" };
}

/** An optional field counts as left out when it's absent or null. */
function isGiven(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function readStreak(value: unknown): Streak | null {
  if (!isObject(value)) return null;
  const { pullRequests, kind } = value;
  if (!Array.isArray(pullRequests) || pullRequests.length === 0) return null;
  if (!pullRequests.every((n) => Number.isInteger(n) && n > 0) || !isText(kind)) return null;
  return { pullRequests: pullRequests as number[], kind };
}

/** Parses the text an agent emitted, then checks it. */
export function parseRetroOutput(text: string): RetroOutputResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`Retro output is not valid JSON: ${(error as Error).message}`] };
  }
  return readRetroOutput(value);
}
