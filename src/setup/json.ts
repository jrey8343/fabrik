// JSON text as Prettier 3 prints JSON with its default options, for every JSON
// file setup or the Visual evidence writer writes or rewrites in a Product
// repo, whose `prettier --check` must pass on their PRs. Use it there in place
// of `JSON.stringify(value, null, 2)`. Pure, no I/O.
//
// Every non-empty object is printed expanded, one member per line: Prettier keeps
// an object expanded once it is. An array goes on one line, as `["a", "b"]`, when
// that line, trailing comma and all, fits in 80 columns; otherwise each item goes
// on its own line. Empty ones print as `[]` and `{}`.
//
// Not covered, as setup writes none of it: Prettier's packed (fill) printing of
// arrays of numbers, and the extra width of wide (East Asian) characters.

/** A JSON file's own indent unit and line ending. */
export interface JsonLayout {
  readonly indent: string;
  readonly eol: string;
}

/** The layout a JSON file's text already uses: the indent of its first indented member, two spaces when it has none. */
export function layoutOf(text: string): JsonLayout {
  return { indent: /\n([ \t]+)"/.exec(text)?.[1] ?? "  ", eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

/** A whole JSON value, printed at the top level of a file with this layout. */
export function printJson(value: unknown, layout: JsonLayout = { indent: "  ", eol: "\n" }): string {
  return printValue(value, layout, 0, 0, false);
}

/**
 * Object members, one per line at this nesting level (1 for a top-level
 * object's members), joined by commas, with no comma after the last.
 */
export function printMembers(members: readonly (readonly [string, unknown])[], layout: JsonLayout, level: number): string {
  const kept = members.filter(([, value]) => value !== undefined);
  return kept
    .map(([key, value], i) => {
      const head = `${layout.indent.repeat(level)}${JSON.stringify(key)}: `;
      return `${head}${printValue(value, layout, level, widthOf(head), i < kept.length - 1)}`;
    })
    .join(`,${layout.eol}`);
}

/**
 * A JSON object's text with the member at this path set to this value,
 * printed as Prettier prints it, and every other byte kept as it was. The
 * member is set where it stands when its object has it, and otherwise after
 * that object's last member. A one-line object it changes goes one member per
 * line, as Prettier breaks it, and so does every one-line object around it,
 * since Prettier breaks those too. `["ui"]` is a top-level member, and
 * `["ui", "url"]` one in the `ui` object, which must be there.
 */
export function withMember(text: string, path: readonly string[], value: unknown): string {
  const key = path.at(-1);
  if (key === undefined) throw new Error("withMember needs the path of a member");
  const layout = layoutOf(text);
  let open = text.indexOf("{");
  for (const [depth, parent] of path.slice(0, -1).entries()) {
    text = expanded(text, open, depth + 1, layout);
    const member = membersOf(text, open).members.findLast((m) => m.key === parent);
    if (member === undefined || text[member.valueStart] !== "{") throw new Error(`${path.join(".")} isn't in an object`);
    open = member.valueStart;
  }
  return setMember(expanded(text, open, path.length, layout), open, path.length, key, value, layout);
}

/**
 * The text with the object whose brace is at `open`, its members `level` deep,
 * one member per line when it was on one line, each member's own text kept.
 */
function expanded(text: string, open: number, level: number, { indent, eol }: JsonLayout): string {
  const { members, close } = membersOf(text, open);
  if (text.slice(open, members[0]?.start ?? close).includes("\n")) return text;
  const lines = members.map((m) => `${indent.repeat(level)}${text.slice(m.start, m.end)}`);
  const body = lines.length === 0 ? "" : `${lines.join(`,${eol}`)}${eol}`;
  return `${text.slice(0, open)}{${eol}${body}${indent.repeat(level - 1)}}${text.slice(close + 1)}`;
}

/** The text with this member of the object whose brace is at `open` set, its members `level` deep and one per line. */
function setMember(text: string, open: number, level: number, key: string, value: unknown, layout: JsonLayout): string {
  const { eol } = layout;
  const { members, close } = membersOf(text, open);
  const head = `${JSON.stringify(key)}: `;
  // JSON.parse keeps a repeated key's last value, so that's the one to set.
  const at = members.findLastIndex((member) => member.key === key);
  const member = members[at];
  if (member !== undefined) {
    const column = widthOf(text.slice(text.lastIndexOf("\n", member.start) + 1, member.start) + head);
    return `${text.slice(0, member.start)}${head}${printValue(value, layout, level, column, at < members.length - 1)}${text.slice(member.end)}`;
  }
  // Everything up to the end of its last member, then the closing brace with whatever whitespace is around it.
  const before = text.slice(0, close).trimEnd();
  const after = text.slice(before.length);
  return `${before}${before.endsWith("{") ? "" : ","}${eol}${printMembers([[key, value]], layout, level)}${after.startsWith(eol) ? "" : eol}${after}`;
}

/** Where a member's text starts, at its key, and ends, after its value. */
interface MemberSpan {
  readonly key: string;
  readonly start: number;
  readonly valueStart: number;
  readonly end: number;
}

/** The members of the JSON object whose brace is at `open`, and where its closing brace is. */
function membersOf(text: string, open: number): { members: MemberSpan[]; close: number } {
  const members: MemberSpan[] = [];
  let i = skipSpace(text, open + 1);
  while (text[i] === '"') {
    const start = i;
    i = endOfString(text, i);
    const key = JSON.parse(text.slice(start, i)) as string;
    const valueStart = skipSpace(text, skipSpace(text, i) + 1); // past the colon
    i = endOfValue(text, valueStart);
    members.push({ key, start, valueStart, end: i });
    i = skipSpace(text, i);
    if (text[i] === ",") i = skipSpace(text, i + 1);
  }
  return { members, close: i };
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && " \t\n\r".includes(text[i] ?? "")) i++;
  return i;
}

/** The index just after the string starting at `i`. */
function endOfString(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === '"') return j + 1;
  }
  return text.length;
}

/** The index just after the value starting at `i`. */
function endOfValue(text: string, i: number): number {
  if (text[i] === '"') return endOfString(text, i);
  if (text[i] === "{" || text[i] === "[") {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const char = text[j];
      if (char === '"') j = endOfString(text, j) - 1;
      else if (char === "{" || char === "[") depth++;
      else if ((char === "}" || char === "]") && --depth === 0) return j + 1;
    }
    return text.length;
  }
  let j = i;
  while (j < text.length && !" \t\n\r,}]".includes(text[j] ?? "")) j++;
  return j;
}

/** A value whose line is `column` wide before it, at this nesting level, followed on its line by a comma or not. */
function printValue(value: unknown, layout: JsonLayout, level: number, column: number, comma: boolean): string {
  const { indent, eol } = layout;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const flat = flatArray(value);
    if (flat !== null && column + widthOf(flat) + (comma ? 1 : 0) <= PRINT_WIDTH) return flat;
    const inner = indent.repeat(level + 1);
    const items = value.map((item, i) => `${inner}${printValue(item, layout, level + 1, widthOf(inner), i < value.length - 1)}`);
    return `[${eol}${items.join(`,${eol}`)}${eol}${indent.repeat(level)}]`;
  }
  if (isObject(value)) {
    const members = printMembers(Object.entries(value), layout, level + 1);
    return members === "" ? "{}" : `{${eol}${members}${eol}${indent.repeat(level)}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const PRINT_WIDTH = 80;
// Prettier's default tabWidth, which it counts each tab as.
const TAB_WIDTH = 2;

function widthOf(text: string): number {
  return [...text].reduce((sum, char) => sum + (char === "\t" ? TAB_WIDTH : 1), 0);
}

/**
 * An array on one line, or null when Prettier would never print it so: it holds
 * a non-empty object, or is two or more arrays of two or more items each.
 */
function flatArray(items: readonly unknown[]): string | null {
  if (items.length > 1 && items.every((item) => Array.isArray(item) && item.length > 1)) return null;
  const parts: string[] = [];
  for (const item of items) {
    if (Array.isArray(item)) {
      if (item.length === 0) parts.push("[]");
      else {
        const inner = flatArray(item);
        if (inner === null) return null;
        parts.push(inner);
      }
    } else if (isObject(item)) {
      if (Object.values(item).some((v) => v !== undefined)) return null;
      parts.push("{}");
    } else parts.push(JSON.stringify(item) ?? "null");
  }
  return `[${parts.join(", ")}]`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
