// A GitHub Actions workflow read line by line, with no YAML library, since
// Setup runs with no npm install and the Kit has no runtime dependency. It
// reads a workflow's top-level keys, its jobs and the keys of each job, a
// `permissions:` value, and a one-line flow map or flow list, which is as far
// as the caller's permissions check (#422) and Setup's report on a Product
// repo's workflows (Spec #917) read. It is no YAML parser: anchors, multi-line
// flow collections and block scalars are read as lines, never as values.
// Pure, no I/O.

/** One line of a workflow: how far it's indented, and its text with the indent and any comment dropped. */
export interface Line {
  readonly indent: number;
  readonly body: string;
}

/** A workflow text as lines, with every comment and blank line dropped. */
export function linesOf(text: string): Line[] {
  return text.split("\n").flatMap((raw) => {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#")) return [];
    return [{ indent: line.length - line.trimStart().length, body: line.trim() }];
  });
}

/**
 * The lines nested under the line at `at`: every following line indented more
 * than it, and, under a key with nothing after its colon, a block list whose
 * dashes sit at the key's own column (`on:` then `- push`), as YAML allows.
 */
export function childrenOf(lines: readonly Line[], at: number): Line[] {
  const parent = lines[at]!;
  const opensList = parent.body.endsWith(":") && !parent.body.startsWith("-");
  const children: Line[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const nested = line.indent > parent.indent || (opensList && line.indent === parent.indent && /^-(\s|$)/.test(line.body));
    if (!nested) break;
    children.push(line);
  }
  return children;
}

export function unquoted(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/, "$2");
}

/** A key of a block: its name, unquoted, what follows its colon, and the lines under it. */
export interface Key {
  readonly name: string;
  readonly value: string;
  readonly block: readonly Line[];
}

/** Each key of a block: every line at the block's first line's indent that is a key, with what follows its colon and the lines under it. */
export function keysOf(lines: readonly Line[]): Key[] {
  const own = lines[0]?.indent;
  return lines.flatMap((line, at) => {
    const key = line.indent === own ? /^((["'])[^"']*\2|[^:\s]+):(.*)$/.exec(line.body) : null;
    return key === null ? [] : [{ name: unquoted(key[1] ?? ""), value: (key[3] ?? "").trim(), block: childrenOf(lines, at) }];
  });
}

/** A workflow's top-level keys, and each of its jobs: a key under `jobs:` named as GitHub names a job, with the job's own keys. */
export function workflowKeysOf(text: string): { readonly top: readonly Key[]; readonly jobs: readonly { readonly name: string; readonly keys: readonly Key[] }[] } {
  const top = keysOf(linesOf(text));
  const jobs = top.filter((key) => key.name === "jobs").flatMap((key) => keysOf(key.block));
  return {
    top,
    jobs: jobs.filter((job) => job.value === "" && /^[A-Za-z_][\w-]*$/.test(job.name)).map((job) => ({ name: job.name, keys: keysOf(job.block) })),
  };
}

/** A one-line flow map's entries (`{ name: production, url: x }`), each key unquoted to its value as written; null for a value that isn't one. */
export function flowMapOf(inline: string): ReadonlyMap<string, string> | null {
  if (!/^\{.*\}$/.test(inline)) return null;
  const entries = new Map<string, string>();
  for (const entry of flowItemsOf(inline.slice(1, -1))) {
    const at = colonOf(entry);
    if (at === -1) entries.set(unquoted(entry), "");
    else entries.set(unquoted(entry.slice(0, at)), entry.slice(at + 1).trim());
  }
  return entries;
}

/** A one-line flow list's items (`[push, 'workflow_dispatch']`), each as written; null for a value that isn't one. */
export function flowListOf(inline: string): readonly string[] | null {
  return /^\[.*\]$/.test(inline) ? flowItemsOf(inline.slice(1, -1)) : null;
}

/** A flow collection's inside split at its own commas, never one in a quoted scalar or a collection nested in it. */
function flowItemsOf(inside: string): string[] {
  const items: string[] = [];
  let start = 0;
  scan(inside, (char, at, depth) => {
    if (char === "," && depth === 0) {
      items.push(inside.slice(start, at));
      start = at + 1;
    }
  });
  items.push(inside.slice(start));
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

/** Where a flow map entry's key ends: its first colon outside a quoted scalar or nested collection, followed by a space or the end, or right after a quoted key. */
function colonOf(entry: string): number {
  let found = -1;
  scan(entry, (char, at, depth) => {
    if (found !== -1 || char !== ":" || depth !== 0) return;
    if (at + 1 === entry.length || /\s/.test(entry[at + 1]!) || /["']/.test(entry[at - 1] ?? "")) found = at;
  });
  return found;
}

/** Each character of a flow collection outside a quoted scalar, with how deep in nested collections it is. A quote opens a scalar only where one starts. */
function scan(text: string, visit: (char: string, at: number, depth: number) => void): void {
  let depth = 0;
  let quote: string | null = null;
  let previous = "";
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (quote !== null) {
      if (char === quote) quote = null;
      previous = char;
      continue;
    }
    if ((char === '"' || char === "'") && /^$|[\s,:[{]/.test(previous)) quote = char;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    else visit(char, at, depth);
    previous = char;
  }
}

export type Level = "none" | "read" | "write";

/** A `permissions:` value: `read-all`/`write-all` as `all`, else each scope's level, `{}` as none. */
export interface Permissions {
  readonly all: Level | null;
  readonly scopes: ReadonlyMap<string, Level>;
}

function levelOf(value: string): Level {
  const level = unquoted(value);
  return level === "read" || level === "write" ? level : "none";
}

/** A `permissions:` value from its inline form (`{}`, `read-all`, `{ contents: read }`) or its block lines. */
export function permissionsOf(inline: string, block: readonly Line[]): Permissions {
  const value = unquoted(inline);
  if (value === "read-all" || value === "write-all") return { all: value === "read-all" ? "read" : "write", scopes: new Map() };
  const entries = value === "" ? keysOf(block).map((key) => [key.name, key.value] as const) : [...(flowMapOf(value) ?? [])];
  return { all: null, scopes: new Map(entries.map(([scope, level]) => [scope, levelOf(level)])) };
}
