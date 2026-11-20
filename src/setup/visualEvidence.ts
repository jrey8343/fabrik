// The Visual evidence writer: given the Kit config's text and the Operator's
// answers, the text with its `ui` and `preview` blocks as the answers spell
// them. Pure, no I/O. /fabrik-visual-evidence runs it through
// visual-evidence-main.ts.
//
// The answers are the blocks themselves, in JSON spelled as Kit config spells
// them, so a field Kit config gains, structured or not, needs no new input. A
// field of a block the file has that the answers leave out keeps its value,
// so a field is taken out only when the answers' `remove` names it, which is
// the Operator's confirmation: route capture's fields when UI evidence comes
// from Evidence shots, and `ui.shots` when it goes back to captured routes.
// The blocks as they'd be written are checked against Kit config's own rules
// first, and answers it would refuse are written nowhere. A block that means
// the same, whatever its formatting or the order of its fields, is left as it
// is, so running it again with the same answers writes nothing.
import { KIT_CONFIG_PATH, resolveKitConfig } from "../kit/config.ts";
import { withMember, withoutMember } from "./json.ts";

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
 * block or both, spelled as Kit config spells them, and, beside a `ui` block,
 * `remove`, a list of the `ui` fields to take out, such as
 * `["ui.default_routes"]`.
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
  const others = Object.keys(answers).filter((key) => !(BLOCKS as readonly string[]).includes(key) && key !== "remove");
  if (others.length > 0) {
    return { ok: false, problems: others.map((key) => `The answers hold ${JSON.stringify(key)}, which isn't a block this writes: it writes only ui and preview`) };
  }
  const removing = removals(answers);
  if (!Array.isArray(removing)) return { ok: false, problems: removing.problems };
  // The blocks as they'd be written, every other field defaulted: the rest of the file is the Operator's, and one rule
  // alone ties these to it, that ui.shots.check is one of the file's own sandbox.checks.
  const blocks = Object.fromEntries(
    given.map((block) => [block, without(merged(existing[block], answers[block]), block === "ui" ? removing : [])]),
  );
  const checked = resolveKitConfig({ config: JSON.stringify({ ...blocks, ...requiredChecksFor(blocks.ui, existing.sandbox) }) });
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
      if (block === "ui") for (const field of removing.filter((field) => Object.hasOwn(before, field))) text = withoutMember(text, [block, field]);
    } else text = withMember(text, [block], answer);
    written.push(block);
  }
  return { ok: true, written, config: text };
}

/**
 * The `ui` fields the answers may take out, as `remove` names them: route
 * capture's, which Evidence shots take the place of, and `shots`, for going
 * back to captured routes. Taking out any other field is turning off what
 * the Operator turned on, which the answers' blocks say with `null`.
 */
const REMOVABLE = ["ui.before_url", "ui.default_routes", "ui.resolve_route", "ui.shots"] as const;

/**
 * The `ui` fields the answers' `remove` confirms taking out, none when it's
 * left out, or what's wrong with it: it names only fields it may take out,
 * beside a `ui` block that doesn't also give them.
 */
function removals(answers: Record<string, unknown>): string[] | { readonly problems: readonly string[] } {
  const remove = answers.remove;
  if (remove === undefined) return [];
  const removable = `it takes out only ${REMOVABLE.slice(0, -1).join(", ")} and ${REMOVABLE.at(-1)}`;
  if (!Array.isArray(remove) || !remove.every((name) => typeof name === "string")) {
    return { problems: [`The answers' remove must be a list of the fields to take out, such as ["ui.default_routes"]: ${removable}`] };
  }
  const ui = answers.ui;
  const problems = remove.flatMap((name) => {
    if (!(REMOVABLE as readonly string[]).includes(name)) return [`The answers' remove names ${JSON.stringify(name)}, which the writer never takes out: ${removable}`];
    if (!isObject(ui)) return [`The answers' remove names ${name}, but they hold no ui block to take it out of`];
    return Object.hasOwn(ui, fieldOf(name)) ? [`The answers both give ${name} and take it out: give it, or take it out`] : [];
  });
  return problems.length > 0 ? { problems } : remove.map(fieldOf);
}

/** A field of the `ui` block, as `remove` names it. */
function fieldOf(name: string): string {
  return name.slice("ui.".length);
}

/** A block without these fields, when it's an object. */
function without(block: unknown, fields: readonly string[]): unknown {
  return isObject(block) ? Object.fromEntries(Object.entries(block).filter(([field]) => !fields.includes(field))) : block;
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

/**
 * The file's own `sandbox.checks`, as a block to check beside a ui with shots,
 * whose check must be one of them; nothing for any other ui, or a file that
 * lists none.
 */
function requiredChecksFor(ui: unknown, sandbox: unknown): { readonly sandbox?: { readonly checks: unknown } } {
  if (!isObject(ui) || !Object.hasOwn(ui, "shots") || !isObject(sandbox) || !Object.hasOwn(sandbox, "checks")) return {};
  return { sandbox: { checks: sandbox.checks } };
}

/** Whether two JSON values mean the same:an object's members in any order, a list's items in theirs. */
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
