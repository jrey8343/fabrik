/**
 * JSON text as Prettier 3 prints JSON with its default options, for files setup
 * writes into a Product repo, whose `prettier --check` must pass on setup's PR.
 *
 * Every non-empty object is printed expanded, one member per line: Prettier keeps
 * an object expanded once it is. An array goes on one line, as `["a", "b"]`, when
 * that line, trailing comma and all, fits in 80 columns; otherwise each item goes
 * on its own line. Empty ones print as `[]` and `{}`.
 *
 * Not covered, as setup writes none of it: Prettier's packed (fill) printing of
 * arrays of numbers, and the extra width of wide (East Asian) characters.
 */
export function printJson(value: unknown, at: JsonPosition = {}): string {
  const { indent = "  ", eol = "\n", level = 0, before = "", trailing = 0 } = at;
  const pad = (n: number) => indent.repeat(n);
  const width = (text: string) => [...text].reduce((sum, char) => sum + (char === "\t" ? TAB_WIDTH : 1), 0);

  function print(node: unknown, depth: number, start: number, after: number): string {
    if (Array.isArray(node)) {
      if (node.length === 0) return "[]";
      const flat = flatArray(node);
      if (flat !== null && start + width(flat) + after <= PRINT_WIDTH) return flat;
      const inner = pad(depth + 1);
      const items = node.map((item, i) => `${inner}${print(item, depth + 1, width(inner), i < node.length - 1 ? 1 : 0)}`);
      return `[${eol}${items.join(`,${eol}`)}${eol}${pad(depth)}]`;
    }
    if (isObject(node)) {
      const members = Object.entries(node).filter(([, v]) => v !== undefined);
      if (members.length === 0) return "{}";
      const inner = pad(depth + 1);
      const lines = members.map(([key, v], i) => {
        const head = `${inner}${JSON.stringify(key)}: `;
        return `${head}${print(v, depth + 1, width(head), i < members.length - 1 ? 1 : 0)}`;
      });
      return `{${eol}${lines.join(`,${eol}`)}${eol}${pad(depth)}}`;
    }
    return JSON.stringify(node) ?? "null";
  }

  return print(value, level, width(before), trailing);
}

/** Where a value sits: the file's indent and line ending, its nesting level, and what's before and after it on its line. */
export interface JsonPosition {
  readonly indent?: string;
  readonly eol?: string;
  readonly level?: number;
  /** The line's text before the value, as `  "ui": `. */
  readonly before?: string;
  /** Characters after the value on its line, as 1 for a trailing comma. */
  readonly trailing?: number;
}

const PRINT_WIDTH = 80;
const TAB_WIDTH = 2;

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
