// JSON text as Prettier 3 prints JSON with its default options, for every JSON
// file setup writes or rewrites in a Product repo, whose `prettier --check` must
// pass on setup's PR. Use it there in place of `JSON.stringify(value, null, 2)`.
// Pure, no I/O.
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
