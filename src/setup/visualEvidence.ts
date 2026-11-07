// The Visual evidence writer: given the Kit config's text and the Operator's
// answers, the text with its `ui` and `preview` blocks as the answers spell
// them. Pure, no I/O. /fabrik-visual-evidence runs it through
// visual-evidence-main.ts.
//
// The answers are the blocks themselves, in JSON spelled as Kit config spells
// them, so a field Kit config gains, structured or not, needs no new input. A
// field of a block the file has that the answers leave out keeps its value.
// The blocks as they'd be written are checked against Kit config's own rules
// first, and answers it would refuse are written nowhere. A block that means
// the same, whatever its formatting or the order of its fields, is left as it
// is, so running it again with the same answers writes nothing.
import { KIT_CONFIG_PATH, resolveKitConfig } from "../kit/config.ts";
import { withMember } from "./json.ts";

/** The blocks this writer owns, in the order it adds them. */
const BLOCKS = ["ui", "preview"] as const;
type Block = (typeof BLOCKS)[number];

export type VisualEvidenceWrite =
  /** `written` names each block that changed; with none, `config` is the text as it was. */
  | { readonly ok: true; readonly written: readonly Block[]; readonly config: string }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * The Kit config's text, or null when the repo has none, with the answers'
 * blocks written into it. The answers are JSON, the `ui` block, the `preview`
 * block or both, spelled as Kit config spells them.
 */
export function writeVisualEvidence(config: string | null, answersText: string): VisualEvidenceWrite {
  if (config === null) return refused(`${KIT_CONFIG_PATH} is missing, so the Kit isn't set up in this repo: run Setup first`);
  const file = parsed(config, `${KIT_CONFIG_PATH} is not valid JSON`);
  if (typeof file === "string") return refused(file);
  const existing = file.value;
  if (!isObject(existing)) return refused(`${KIT_CONFIG_PATH} must be an object`);
  const read = parsed(answersText, "The answers are not valid JSON");
  if (typeof read === "string") return refused(read);
  const answers = read.value;
  const given = BLOCKS.filter((block) => isObject(answers) && Object.hasOwn(answers, block));
  if (!isObject(answers) || given.length === 0) return refused("The answers must be a JSON object holding a ui block, a preview block or both");
  const others = Object.keys(answers).filter((key) => !(BLOCKS as readonly string[]).includes(key));
  if (others.length > 0) {
    return { ok: false, problems: others.map((key) => `The answers hold ${JSON.stringify(key)}, which isn't a block this writes: it writes only ui and preview`) };
  }
  // The blocks alone, as they'd be written, every other field defaulted: the rest of the file is the Operator's, and no rule ties these to it.
  const blocks = Object.fromEntries(given.map((block) => [block, merged(existing[block], answers[block])]));
  const checked = resolveKitConfig({ config: JSON.stringify(blocks) });
  if (!checked.ok) return { ok: false, problems: checked.errors };
  let text = config;
  const written: Block[] = [];
  for (const block of given) {
    const before = existing[block];
    const answer = answers[block];
    if (Object.hasOwn(existing, block) && sameJson(before, blocks[block])) continue;
    if (isObject(before) && isObject(answer)) {
      for (const [field, value] of Object.entries(answer)) {
        if (!Object.hasOwn(before, field) || !sameJson(before[field], value)) text = withMember(text, [block, field], value);
      }
    } else text = withMember(text, [block], answer);
    written.push(block);
  }
  return { ok: true, written, config: text };
}

function refused(problem: string): VisualEvidenceWrite {
  return { ok: false, problems: [problem] };
}

/** The JSON value, or what's wrong with the text: `what` and the parser's reason. */
function parsed(text: string, what: string): { readonly value: unknown } | string {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (error) {
    return `${what}: ${(error as Error).message}`;
  }
}

/**
 * A block as the answers leave it: when the file and the answers both hold it
 * as an object, each field the answers give replaces the file's, and every
 * field they leave out keeps its value. Otherwise it's the answers' block.
 */
function merged(before: unknown, answer: unknown): unknown {
  return isObject(before) && isObject(answer) ? { ...before, ...answer } : answer;
}

/** Whether two JSON values mean the same: an object's members in any order, a list's items in theirs. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
  }
  return a === b;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
