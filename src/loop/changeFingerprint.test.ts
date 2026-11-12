import { describe, expect, it } from "vitest";
import { changeFingerprintOf } from "./changeFingerprint.ts";

const INDEX = "1111111111111111111111111111111111111111..2222222222222222222222222222222222222222";

/** One file's section of a diff as Git prints it with no context: its headers, then each hunk's removed and added lines. */
function fileDiff(
  path: string,
  hunks: readonly { readonly at: number; readonly removed?: readonly string[]; readonly added?: readonly string[] }[],
  index = INDEX,
): string {
  return [
    `diff --git a/${path} b/${path}`,
    `index ${index} 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks.flatMap(({ at, removed = [], added = [] }) => [
      `@@ -${at},${removed.length} +${at},${added.length} @@ function near(${at}) {`,
      ...removed.map((line) => `-${line}`),
      ...added.map((line) => `+${line}`),
    ]),
    "",
  ].join("\n");
}

const CART = fileDiff("src/cart.ts", [{ at: 3, removed: ["  return 0;"], added: ["  const sum = items.length;", "  return sum;"] }]);

describe("The change fingerprint: what a file's hash is made of", () => {
  it("is the same for the same added and removed lines at other line numbers, under another index line", () => {
    const moved = fileDiff(
      "src/cart.ts",
      [{ at: 41, removed: ["  return 0;"], added: ["  const sum = items.length;", "  return sum;"] }],
      "3333333333333333333333333333333333333333..4444444444444444444444444444444444444444",
    );

    expect(changeFingerprintOf(moved)).toEqual(changeFingerprintOf(CART));
  });

  it("is 12 hex characters, and another for one changed character in one line", () => {
    const edited = fileDiff("src/cart.ts", [{ at: 3, removed: ["  return 0;"], added: ["  const sum = items.length;", "  return sun;"] }]);

    const before = changeFingerprintOf(CART);
    const after = changeFingerprintOf(edited);

    expect(before.files?.["src/cart.ts"]).toMatch(/^[0-9a-f]{12}$/);
    expect(after.files?.["src/cart.ts"]).toMatch(/^[0-9a-f]{12}$/);
    expect(after.files?.["src/cart.ts"]).not.toBe(before.files?.["src/cart.ts"]);
    expect(after.all).not.toBe(before.all);
  });

  it("reads a removed line that looks like a file's header as the line it is", () => {
    const plain = fileDiff("notes.md", [{ at: 2, removed: ["a line"] }, { at: 9, added: ["the last line"] }]);
    const headerLike = fileDiff("notes.md", [{ at: 2, removed: ["-- a/notes.md"] }, { at: 9, added: ["the last line"] }]);

    const fingerprint = changeFingerprintOf(headerLike);

    expect(Object.keys(fingerprint.files ?? {})).toEqual(["notes.md"]);
    expect(fingerprint.files?.["notes.md"]).not.toBe(changeFingerprintOf(plain).files?.["notes.md"]);
    // The hunk after it is still read: without its line the hash is another.
    expect(fingerprint.files?.["notes.md"]).not.toBe(changeFingerprintOf(fileDiff("notes.md", [{ at: 2, removed: ["-- a/notes.md"] }])).files?.["notes.md"]);
  });

  it("tells a line added from the same line removed", () => {
    const added = fileDiff("notes.md", [{ at: 2, added: ["a line"] }]);
    const removed = fileDiff("notes.md", [{ at: 2, removed: ["a line"] }]);

    expect(changeFingerprintOf(added).files?.["notes.md"]).not.toBe(changeFingerprintOf(removed).files?.["notes.md"]);
  });
});

describe("The change fingerprint: all and product", () => {
  const TEST = fileDiff("src/cart.test.ts", [{ at: 10, added: ["  expect(total()).toBe(2);"] }]);
  const TEST_EDITED = fileDiff("src/cart.test.ts", [{ at: 10, added: ["  expect(total()).toBe(3);"] }]);
  const CART_EDITED = fileDiff("src/cart.ts", [{ at: 3, removed: ["  return 0;"], added: ["  return items.length;"] }]);

  it("a change to a test file moves all and leaves product", () => {
    const before = changeFingerprintOf(CART + TEST);
    const after = changeFingerprintOf(CART + TEST_EDITED);

    expect(after.all).not.toBe(before.all);
    expect(after.product).toBe(before.product);
  });

  it("a change to any other file moves both", () => {
    const before = changeFingerprintOf(CART + TEST);
    const after = changeFingerprintOf(CART_EDITED + TEST);

    expect(after.all).not.toBe(before.all);
    expect(after.product).not.toBe(before.product);
  });

  it("is the same whatever order the diff lists the files in, with each file's hash by its path", () => {
    const one = changeFingerprintOf(CART + TEST);
    const other = changeFingerprintOf(TEST + CART);

    expect(other).toEqual(one);
    expect(Object.keys(one.files ?? {})).toEqual(["src/cart.test.ts", "src/cart.ts"]);
    expect(one.all).toMatch(/^[0-9a-f]{12}$/);
    expect(one.product).toMatch(/^[0-9a-f]{12}$/);
  });

  it("a file added to the change moves all, and product only when it is no test", () => {
    const base = changeFingerprintOf(CART);

    expect(changeFingerprintOf(CART + TEST)).toMatchObject({ product: base.product });
    expect(changeFingerprintOf(CART + TEST).all).not.toBe(base.all);
    expect(changeFingerprintOf(CART + fileDiff("src/price.ts", [{ at: 1, added: ["export const TAX = 0.1;"] }])).product).not.toBe(base.product);
  });
});

describe("The change fingerprint: files that are not a plain edit", () => {
  const NONE = "0000000000000000000000000000000000000000";
  const BLOB_A = "a".repeat(40);
  const BLOB_B = "b".repeat(40);
  const BLOB_C = "c".repeat(40);

  it("a moved file is its lines removed at the old path and added at the new one", () => {
    const moved = [
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      `index ${BLOB_A}..${NONE}`,
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-one",
      "-two",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      `index ${NONE}..${BLOB_A}`,
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "",
    ].join("\n");

    const { files } = changeFingerprintOf(moved);

    expect(Object.keys(files ?? {})).toEqual(["src/new.ts", "src/old.ts"]);
    expect(files?.["src/old.ts"]).toBe(changeFingerprintOf(fileDiff("src/old.ts", [{ at: 7, removed: ["one", "two"] }])).files?.["src/old.ts"]);
    expect(files?.["src/new.ts"]).toBe(changeFingerprintOf(fileDiff("src/new.ts", [{ at: 7, added: ["one", "two"] }])).files?.["src/new.ts"]);
  });

  const binary = (index: string, more: readonly string[] = [], from = "a/logo.png", to = "b/logo.png") =>
    ["diff --git a/logo.png b/logo.png", ...more, `index ${index}`, `Binary files ${from} and ${to} differ`, ""].join("\n");

  it("a binary file is the hash of its content at the head, whatever it was before", () => {
    const changed = changeFingerprintOf(binary(`${BLOB_A}..${BLOB_B} 100644`));
    const onAnotherBase = changeFingerprintOf(binary(`${BLOB_C}..${BLOB_B} 100644`));
    const added = changeFingerprintOf(binary(`${NONE}..${BLOB_B}`, ["new file mode 100644"], "/dev/null"));
    const otherContent = changeFingerprintOf(binary(`${BLOB_A}..${BLOB_C} 100644`));

    expect(changed.files?.["logo.png"]).toMatch(/^[0-9a-f]{12}$/);
    expect(onAnotherBase).toEqual(changed);
    expect(added).toEqual(changed);
    expect(otherContent.files?.["logo.png"]).not.toBe(changed.files?.["logo.png"]);
    expect(otherContent.all).not.toBe(changed.all);
  });

  it("a deleted binary file is a fixed word", () => {
    const deleted = (blob: string) => changeFingerprintOf(binary(`${blob}..${NONE}`, ["deleted file mode 100644"], "a/logo.png", "/dev/null"));

    expect(deleted(BLOB_A).files).toEqual({ "logo.png": "deleted" });
    expect(deleted(BLOB_B)).toEqual(deleted(BLOB_A));
  });

  it("a deleted text file is its removed lines", () => {
    const deleted = [
      "diff --git a/notes.md b/notes.md",
      "deleted file mode 100644",
      `index ${BLOB_A}..${NONE}`,
      "--- a/notes.md",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-one",
      "-two",
      "",
    ].join("\n");

    expect(changeFingerprintOf(deleted)).toEqual(changeFingerprintOf(fileDiff("notes.md", [{ at: 1, removed: ["one", "two"] }])));
  });

  it("a file whose only change is its mode is left out", () => {
    const modeOnly = ["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755", ""].join("\n");

    expect(changeFingerprintOf(modeOnly + CART)).toEqual(changeFingerprintOf(CART));
    expect(changeFingerprintOf(modeOnly).files).toEqual({});
  });

  it("a file whose mode and lines both change is its lines", () => {
    const both = [
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      `index ${BLOB_A}..${BLOB_B}`,
      "--- a/run.sh",
      "+++ b/run.sh",
      "@@ -1 +1 @@",
      "-echo a",
      "+echo b",
      "",
    ].join("\n");

    expect(changeFingerprintOf(both)).toEqual(changeFingerprintOf(fileDiff("run.sh", [{ at: 1, removed: ["echo a"], added: ["echo b"] }])));
  });

  it("a file added empty is in the change, with no lines", () => {
    const empty = ["diff --git a/src/.keep b/src/.keep", "new file mode 100644", `index ${NONE}..e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`, ""].join("\n");

    expect(Object.keys(changeFingerprintOf(empty + CART).files ?? {})).toEqual(["src/.keep", "src/cart.ts"]);
    expect(changeFingerprintOf(empty + CART).all).not.toBe(changeFingerprintOf(CART).all);
  });

  it("a last line with no newline is another change than the same line with one", () => {
    const withNewline = fileDiff("notes.md", [{ at: 4, removed: ["end"], added: ["The end"] }]);
    const without = `${withNewline}\\ No newline at end of file\n`;

    expect(changeFingerprintOf(without).files?.["notes.md"]).not.toBe(changeFingerprintOf(withNewline).files?.["notes.md"]);
    // The file after it is still read.
    expect(Object.keys(changeFingerprintOf(without + CART).files ?? {})).toEqual(["notes.md", "src/cart.ts"]);
  });

  it("reads a path with a space in it, and one Git quotes", () => {
    const spaced = fileDiff("docs/read me.md", [{ at: 1, added: ["Hello"] }]);
    const quoted = [
      'diff --git "a/docs/caf\\303\\251 \\"menu\\".md" "b/docs/caf\\303\\251 \\"menu\\".md"',
      `index ${BLOB_A}..${BLOB_B} 100644`,
      '--- "a/docs/caf\\303\\251 \\"menu\\".md"',
      '+++ "b/docs/caf\\303\\251 \\"menu\\".md"',
      "@@ -0,0 +1 @@",
      "+Hello",
      "",
    ].join("\n");

    expect(Object.keys(changeFingerprintOf(spaced).files ?? {})).toEqual(["docs/read me.md"]);
    expect(Object.keys(changeFingerprintOf(quoted).files ?? {})).toEqual(['docs/café "menu".md']);
  });
});

describe("The change fingerprint: a change of many files", () => {
  const files = (count: number, line = "export {};") =>
    Array.from({ length: count }, (_, at) => fileDiff(`src/file${at}.ts`, [{ at: 1, added: [at === 0 ? line : "export {};"] }])).join("");

  it("names each of 200 files", () => {
    expect(Object.keys(changeFingerprintOf(files(200)).files ?? {})).toHaveLength(200);
  });

  it("past 200 files names none, and all and product are still set", () => {
    const many = changeFingerprintOf(files(201));
    const edited = changeFingerprintOf(files(201, "export const one = 1;"));
    const withTest = changeFingerprintOf(files(201) + fileDiff("src/a.test.ts", [{ at: 1, added: ["it.todo('x');"] }]));

    expect(many.files).toBeNull();
    expect(many.all).toMatch(/^[0-9a-f]{12}$/);
    expect(many.product).toMatch(/^[0-9a-f]{12}$/);
    expect(edited.all).not.toBe(many.all);
    expect(edited.product).not.toBe(many.product);
    expect(withTest.all).not.toBe(many.all);
    expect(withTest.product).toBe(many.product);
  });

  it("a change of nothing has no files", () => {
    expect(changeFingerprintOf("")).toMatchObject({ v: 1, files: {} });
  });
});
