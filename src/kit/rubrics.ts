// The Scorers' rubrics: the Kit-owned, versioned prompts in prompts/scorers/,
// one per Scorer, that a judge model applies to a finished run's transcript.
// Each file holds the rubric's name, version, pass threshold and labels in
// front matter, then the rubric text. A rubric's version names its content:
// the version guard fails any rubric that changed without a version bump.
// Pure, no I/O: src/kit/kitFiles.ts reads the files.
import { createHash } from "node:crypto";

/** The Kit's Scorers, in the order the Kit lists them. */
export const SCORERS = ["efficiency", "ticket-compliance", "skill-use"] as const;

/** Where the Kit keeps the rubrics, relative to its own root: `<name>.md` for each Scorer. */
export const RUBRICS_DIR = "prompts/scorers";

/** One Scorer's rubric, as its file holds it. */
export interface Rubric {
  /** The Scorer's name, such as `efficiency`, which is also its file's name. */
  readonly name: string;
  /** A positive whole number, bumped whenever anything else here changes. */
  readonly version: number;
  /** The score, from 0 to 1, at or above which the run passes this rubric. */
  readonly threshold: number;
  /** The fixed labels the judge picks one from. */
  readonly labels: readonly string[];
  /** The rubric text the judge applies. */
  readonly text: string;
}

const FIELDS = ["name", "version", "threshold", "labels"];

/** Lowercase words joined by hyphens, as a rubric's name and its labels are. */
const KEBAB = /^[a-z]+(?:-[a-z]+)*$/;

/**
 * A rubric file's text as a Rubric: front matter between `---` lines, one
 * `field: value` line each, then the rubric text. Throws, naming `source`
 * and the problem, on anything else.
 */
export function readRubric(text: string, source = "rubric"): Rubric {
  const refuse = (problem: string): never => {
    throw new Error(`${source}: ${problem}`);
  };
  const [, header = "", body = ""] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? refuse("must start with front matter between --- lines");
  const fields = new Map<string, string>();
  for (const line of header.split("\n")) {
    const [, key = "", value = ""] = /^([a-z]+):\s*(.*)$/.exec(line) ?? refuse(`front matter line ${JSON.stringify(line)} must be field: value`);
    if (!FIELDS.includes(key)) refuse(`${key} isn't a rubric field; the fields are ${FIELDS.join(", ")}`);
    if (fields.has(key)) refuse(`${key} is given twice`);
    fields.set(key, value.trim());
  }
  const field = (key: string) => fields.get(key) ?? refuse(`${key} is missing`);

  const name = field("name");
  if (!KEBAB.test(name)) refuse(`name must be lowercase words joined by hyphens, not ${JSON.stringify(name)}`);
  const version = field("version");
  if (!/^[1-9][0-9]*$/.test(version)) refuse(`version must be a positive whole number, not ${JSON.stringify(version)}`);
  const threshold = field("threshold");
  if (!/^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$/.test(threshold)) refuse(`threshold must be a number from 0 to 1, not ${JSON.stringify(threshold)}`);
  const list = /^\[(.*)\]$/.exec(field("labels"))?.[1] ?? refuse("labels must be a [list]");
  const labels = list.split(",").map((label) => label.trim());
  if (!labels.every((label) => KEBAB.test(label))) refuse(`labels must each be lowercase words joined by hyphens, not ${JSON.stringify(list)}`);
  if (new Set(labels).size !== labels.length) refuse("labels must each be listed once");
  const rubric = body.trim();
  if (rubric === "") refuse("the rubric text after the front matter is empty");

  return { name, version: Number(version), threshold: Number(threshold), labels, text: rubric };
}

/** A rubric as the rubric set names it: `<name>@<version>`, such as `efficiency@1`. */
export function rubricId(rubric: Pick<Rubric, "name" | "version">): string {
  return `${rubric.name}@${rubric.version}`;
}

/** The rubrics a score was given under. */
export interface RubricSet {
  /** Each rubric's `<name>@<version>`, in the order given. */
  readonly pairs: readonly string[];
  /** A short hash of the pairs, whatever their order, for naming score files. */
  readonly hash: string;
}

/** How many hex characters of the set's SHA-256 its short hash keeps. */
const SET_HASH_LENGTH = 7;

/** The rubric set the rubrics make: their `name@version` pairs and its short hash. */
export function rubricSet(rubrics: readonly Pick<Rubric, "name" | "version">[]): RubricSet {
  const pairs = rubrics.map(rubricId);
  const hash = createHash("sha256").update([...pairs].sort().join("\n")).digest("hex").slice(0, SET_HASH_LENGTH);
  return { pairs, hash };
}

/**
 * The content hash recorded for each rubric version, by `name@version`. A
 * rubric whose content no longer matches its version's hash fails the version
 * guard, so changing a rubric means bumping its version and recording the new
 * version's hash here. Old versions stay recorded, so no version is reused.
 */
export const RUBRIC_HASHES: Readonly<Record<string, string>> = {
  "efficiency@1": "b7e376564bd8fa6675f191d09348691cb20447cec6bb213ec22d66c6f6904c54",
  "ticket-compliance@1": "a3a94ba735f65ac3fd5a21985be041a4fca34878d71bfff10c2a741a80f8b1bd",
  "ticket-compliance@2": "329daa807c4f255c1fa88eb69a635e324050befb95afae3f7da053f8b89800c1",
  "skill-use@1": "37ff8befe470d3c5604614d0ace707540792184811232ac5580680166fbfdf80",
};

/** A rubric's content hash: everything the rubric says, but not its version. */
export function rubricContentHash(rubric: Rubric): string {
  const { name, threshold, labels, text } = rubric;
  return createHash("sha256").update(JSON.stringify({ name, threshold, labels, text })).digest("hex");
}

/**
 * The version guard: what's wrong with each rubric whose content isn't the
 * content recorded for its version, or whose version has no hash recorded.
 * Empty when every rubric matches.
 */
export function rubricVersionErrors(rubrics: readonly Rubric[], recorded: Readonly<Record<string, string>>): readonly string[] {
  return rubrics.flatMap((rubric) => {
    const id = rubricId(rubric);
    const hash = rubricContentHash(rubric);
    const expected = recorded[id];
    const record = (version: string) => `record "${version}": "${hash}" in RUBRIC_HASHES (src/kit/rubrics.ts)`;
    if (expected === undefined) return [`${id} has no recorded hash: ${record(id)}`];
    if (expected !== hash) {
      return [`${id} has changed since its hash was recorded: bump its version, then ${record(rubricId({ ...rubric, version: rubric.version + 1 }))}`];
    }
    return [];
  });
}
