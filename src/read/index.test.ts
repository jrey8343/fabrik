import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isUi } from "../evidence/uiEvidence.ts";
import type { UiConfig } from "../kit/config.ts";
import { EXPORT_CALLS, EXPORT_SHAPES, NOT_DATA } from "./exports.fixture.ts";

const ENTRY = new URL("./index.ts", import.meta.url);

/** The entry's text, comments taken out. */
function entryStatements(): string {
  return readFileSync(ENTRY, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .trim();
}

/** The names of the types the entry exports, read from its `export type { … } from` lines. */
function exportedTypeNames(): string[] {
  return [...entryStatements().matchAll(/export\s+type\s*\{([^}]*)\}\s*from/g)].flatMap((match) =>
    (match[1] ?? "")
      .split(",")
      .map((name) => name.trim().split(/\s+as\s+/).at(-1) ?? "")
      .filter((name) => name !== ""),
  );
}

/** The names of the values the entry exports, as a program importing it sees them. */
async function exportedValueNames(): Promise<string[]> {
  return Object.keys(await import("./index.ts"));
}

describe("the read library's entry", () => {
  it("holds nothing but re-exports of other modules", () => {
    const statements = entryStatements()
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement !== "");

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) expect(statement).toMatch(/^export\s+(type\s+)?\{[^}]*\}\s*from\s*"\.\.?\/[^"]+"$/);
  });

  it("exports every value the interface fixture holds a call for, and no other", async () => {
    expect((await exportedValueNames()).toSorted()).toEqual(Object.keys(EXPORT_CALLS).toSorted());
  });

  it("exports every type the interface fixture holds a value of, and no other", () => {
    expect(exportedTypeNames().toSorted()).toEqual(Object.keys(EXPORT_SHAPES).toSorted());
  });
});

/** A value as a reader gets it back after writing it as JSON and reading it again. */
function roundTripped(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe("the read library's values", () => {
  it.each(Object.entries(EXPORT_SHAPES).filter(([name]) => !NOT_DATA.includes(name)))(
    "a value of %s comes back equal after being written as JSON and read again",
    (_name, value) => {
      expect(roundTripped(value)).toStrictEqual(value);
    },
  );

  it.each(Object.entries(EXPORT_CALLS).filter(([name]) => !NOT_DATA.includes(name)))(
    "what the call of %s returns comes back equal after being written as JSON and read again",
    async (_name, call) => {
      const value = await call();

      expect(roundTripped(value)).toStrictEqual(value);
    },
  );
});

describe("the read library in a Worker", () => {
  const WORKER_REFUSAL = "path.posix.matchesGlob is not implemented in the Workers runtime";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Node's path globs made to throw, as the Workers runtime does. */
  function asInAWorker(): void {
    vi.spyOn(path.posix, "matchesGlob").mockImplementation(() => {
      throw new Error(WORKER_REFUSAL);
    });
  }

  it("throws where the Kit matches a path glob, so the trap is set where the Kit would fall in", () => {
    asInAWorker();
    const ui: UiConfig = { paths: ["src/pages/**"], serve: "npm run dev", url: "http://127.0.0.1:4321", beforeUrl: null, defaultRoutes: ["/"] };

    expect(() => isUi(["src/pages/book.astro"], ui)).toThrow(WORKER_REFUSAL);
  });

  it.each(Object.entries(EXPORT_CALLS))("the call of %s returns without matching a path glob", async (_name, call) => {
    asInAWorker();

    const outcome = await Promise.resolve()
      .then(call)
      .then(
        () => "returned",
        (error: unknown) => error,
      );

    expect(outcome).toBe("returned");
  });
});
