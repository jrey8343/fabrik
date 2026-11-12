import { describe, expect, it } from "vitest";
import { forbiddenImportsFrom } from "./importWalk.ts";

/** A made-up graph of modules, by path, read as the walk reads a file. */
function graphOf(files: Readonly<Record<string, string>>): (path: string) => string {
  return (path) => {
    const text = files[path];
    if (text === undefined) throw new Error(`no module at ${path}`);
    return text;
  };
}

describe("the walk of the read library's imports", () => {
  it("finds nothing in modules that import only each other and the three built-ins a Worker loads", () => {
    const read = graphOf({
      "lib/entry.ts": 'export { rule } from "./rule.ts";\nexport { hash } from "./hash.ts";\n',
      "lib/rule.ts": 'import { join } from "node:path";\nimport { readFile } from "node:fs/promises";\nexport const rule = 1;\n',
      "lib/hash.ts": 'import { createHash } from "node:crypto";\nimport { rule } from "./rule.ts";\nexport const hash = 2;\n',
    });

    expect(forbiddenImportsFrom("lib/entry.ts", read)).toEqual([]);
  });

  it("names an npm package a module the entry reaches imports, and the module that imports it", () => {
    const read = graphOf({
      "lib/entry.ts": 'export { rule } from "./rule.ts";\n',
      "lib/rule.ts": 'import { parse } from "../deep/parse.ts";\nexport const rule = 1;\n',
      "deep/parse.ts": 'import YAML from "yaml";\nexport const parse = YAML.parse;\n',
    });

    expect(forbiddenImportsFrom("lib/entry.ts", read)).toEqual([{ module: "deep/parse.ts", imports: "yaml", kind: "package" }]);
  });

  it("names a Node built-in other than the three a Worker loads, prefixed or not", () => {
    const read = graphOf({
      "lib/entry.ts": 'import { execFile } from "node:child_process";\nimport os from "os";\nexport * from "./more.ts";\n',
      "lib/more.ts": 'import { Buffer } from "node:buffer";\nimport * as fs from "node:fs";\n',
    });

    expect(forbiddenImportsFrom("lib/entry.ts", read)).toEqual([
      { module: "lib/entry.ts", imports: "node:child_process", kind: "builtin" },
      { module: "lib/entry.ts", imports: "os", kind: "builtin" },
      { module: "lib/more.ts", imports: "node:buffer", kind: "builtin" },
      { module: "lib/more.ts", imports: "node:fs", kind: "builtin" },
    ]);
  });

  it("does not follow an import of types alone, which nothing runs", () => {
    const read = graphOf({
      "lib/entry.ts": [
        'import type { Job } from "./jobs.ts";',
        'import { type Shell, type Exec } from "./shell.ts";',
        'export type { Clock } from "./clock.ts";',
        "export const entry = 1;",
      ].join("\n"),
      "lib/jobs.ts": 'import { execFile } from "node:child_process";\n',
      "lib/shell.ts": 'import { execFile } from "node:child_process";\n',
      "lib/clock.ts": 'import { setTimeout } from "node:timers/promises";\n',
    });

    expect(forbiddenImportsFrom("lib/entry.ts", read)).toEqual([]);
  });

  it("follows an import that brings in a value beside its types, over several lines", () => {
    const read = graphOf({
      "lib/entry.ts": ['import {', "  type Job,", "  jobOf,", '} from "./jobs.ts";', "export const entry = jobOf;"].join("\n"),
      "lib/jobs.ts": 'import { execFile } from "node:child_process";\nexport const jobOf = 1;\n',
    });

    expect(forbiddenImportsFrom("lib/entry.ts", read)).toEqual([{ module: "lib/jobs.ts", imports: "node:child_process", kind: "builtin" }]);
  });

  it("follows an import made for its effect alone, and one made at run time", () => {
    const read = graphOf({
      "lib/entry.ts": 'import "./setup.ts";\nexport async function later() {\n  return import("./later.ts");\n}\n',
      "lib/setup.ts": 'import "dotenv/config";\n',
      "lib/later.ts": 'const { spawn } = await import("node:child_process");\n',
    });

    expect(forbiddenImportsFrom("lib/entry.ts", read)).toEqual([
      { module: "lib/setup.ts", imports: "dotenv/config", kind: "package" },
      { module: "lib/later.ts", imports: "node:child_process", kind: "builtin" },
    ]);
  });

  it("reads each module once, however many import it", () => {
    const reads: string[] = [];
    const files: Record<string, string> = {
      "lib/entry.ts": 'export { a } from "./a.ts";\nexport { b } from "./b.ts";\n',
      "lib/a.ts": 'import { c } from "./c.ts";\nexport const a = c;\n',
      "lib/b.ts": 'import { c } from "./c.ts";\nexport const b = c;\n',
      "lib/c.ts": 'import { a } from "./a.ts";\nexport const c = 1;\n',
    };

    forbiddenImportsFrom("lib/entry.ts", (path) => {
      reads.push(path);
      return graphOf(files)(path);
    });

    expect(reads.toSorted()).toEqual(["lib/a.ts", "lib/b.ts", "lib/c.ts", "lib/entry.ts"]);
  });
});
