// The walk of the read library's imports: from the entry outward, every import
// that survives to run time, so a test can hold that the entry needs nothing
// installed and nothing a Worker can't load. Imports of types alone are erased
// before anything runs, so they are not followed. Pure: the caller hands in how
// to read a module's text.
import { isBuiltin } from "node:module";
import { posix } from "node:path";

/** The Node built-ins seen to load in a Worker with Node.js compatibility on: the only ones the read library may import. */
export const WORKER_BUILTINS = ["node:crypto", "node:path", "node:fs/promises"] as const;

/** An import the read library may not make: of an npm package, or of a Node built-in a Worker does not load. */
export interface ForbiddenImport {
  /** The module that makes it, as its path was reached. */
  readonly module: string;
  /** What it imports, as written. */
  readonly imports: string;
  readonly kind: "package" | "builtin";
}

/** What an import or re-export brings in: a default, a namespace, a list in braces, or a mix. */
const CLAUSE = String.raw`(?:type\s+)?(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+)`;
const STATIC_IMPORT = new RegExp(String.raw`^[ \t]*(?:import|export)\s+(${CLAUSE})\s*from\s*["']([^"']+)["']`, "gm");
const SIDE_EFFECT_IMPORT = /^[ \t]*import\s*["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /(typeof\s+)?\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** Whether an import clause brings in only types, which nothing runs. */
function typesAlone(clause: string): boolean {
  if (/^type\s/.test(clause)) return true;
  const braces = /^\{([^}]*)\}$/.exec(clause.trim());
  if (braces === null) return false;
  const names = (braces[1] ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
  return names.length > 0 && names.every((name) => /^type\s/.test(name));
}

/** What a module's text imports at run time, as written, in the order written. */
export function runtimeImportsIn(text: string): string[] {
  const found: { at: number; specifier: string }[] = [];
  for (const match of text.matchAll(STATIC_IMPORT)) {
    if (!typesAlone(match[1] ?? "")) found.push({ at: match.index, specifier: match[2] ?? "" });
  }
  for (const match of text.matchAll(SIDE_EFFECT_IMPORT)) found.push({ at: match.index, specifier: match[1] ?? "" });
  for (const match of text.matchAll(DYNAMIC_IMPORT)) {
    if (match[1] === undefined) found.push({ at: match.index, specifier: match[2] ?? "" });
  }
  return found.toSorted((a, b) => a.at - b.at).map(({ specifier }) => specifier);
}

/** Why the read library may not import `specifier`, or null when it may. */
function forbiddenKindOf(specifier: string): ForbiddenImport["kind"] | null {
  const builtin = specifier.startsWith("node:") || isBuiltin(specifier);
  if (!builtin) return "package";
  const named = specifier.startsWith("node:") ? specifier : `node:${specifier}`;
  return (WORKER_BUILTINS as readonly string[]).includes(named) ? null : "builtin";
}

/**
 * Every module reached from `entry` by imports that survive to run time, the
 * entry first, in the order reached, with its text. `read` gives a module's
 * text by its path; relative imports resolve against the importing module's
 * folder.
 */
function modulesReachedFrom(entry: string, read: (path: string) => string): { readonly path: string; readonly text: string }[] {
  const reached: { path: string; text: string }[] = [];
  const seen = new Set<string>();
  const waiting = [posix.normalize(entry)];
  for (let path = waiting.shift(); path !== undefined; path = waiting.shift()) {
    if (seen.has(path)) continue;
    seen.add(path);
    const text = read(path);
    reached.push({ path, text });
    for (const specifier of runtimeImportsIn(text)) {
      if (isRelative(specifier)) waiting.push(posix.join(posix.dirname(path), specifier));
    }
  }
  return reached;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/** Every import the read library may not make, in the modules reached from `entry` (see modulesReachedFrom), in the order reached. */
export function forbiddenImportsFrom(entry: string, read: (path: string) => string): ForbiddenImport[] {
  return modulesReachedFrom(entry, read).flatMap(({ path, text }) =>
    runtimeImportsIn(text).flatMap((specifier) => {
      const kind = isRelative(specifier) ? null : forbiddenKindOf(specifier);
      return kind === null ? [] : [{ module: path, imports: specifier, kind }];
    }),
  );
}

/** The names a module's text imports by name from anywhere, types included, as each is exported. */
function namesImportedIn(text: string): string[] {
  return [...text.matchAll(STATIC_IMPORT)]
    .filter((match) => /^\s*import/.test(match[0]))
    .flatMap((match) => [...(match[1] ?? "").matchAll(/\{([^}]*)\}/g)])
    .flatMap((braces) => (braces[1] ?? "").split(","))
    .map((name) => name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0] ?? "")
    .filter((name) => name !== "");
}

/**
 * The modules reached from `entry` (see modulesReachedFrom) that import
 * `name` by name, as a type or as a value, in the order reached: so a test can
 * hold that nothing the read library runs is typed on the Kit's client class.
 */
export function modulesImporting(name: string, entry: string, read: (path: string) => string): string[] {
  return modulesReachedFrom(entry, read)
    .filter(({ text }) => namesImportedIn(text).includes(name))
    .map(({ path }) => path);
}
