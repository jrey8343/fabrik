// The Kit's reusable workflows are wiring only. These hold the wiring to the
// files it names, since nothing runs the workflows before a release.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const workflows = [".github/workflows/loop.yml", ".github/workflows/schedule.yml"].map((path) => ({
  path,
  text: readFileSync(new URL(path, root), "utf8"),
}));

describe("The Kit's workflows", () => {
  it.each(workflows)("$path checks the Kit out at kit/ in every job", ({ text }) => {
    const kitCheckouts = [...text.matchAll(/repository: jrey8343\/fabrik\n(?:.*\n){1,2}?\s+path: (\S+)/g)].map((match) => match[1]);

    expect(kitCheckouts.length).toBeGreaterThan(0);
    expect(new Set(kitCheckouts)).toEqual(new Set(["kit"]));
  });

  it.each(workflows)("$path uses only composite actions the Kit ships", ({ text }) => {
    const local = [...text.matchAll(/uses: \.\/kit\/(\S+)/g)].map((match) => match[1]!);

    expect(local.length).toBeGreaterThan(0);
    for (const action of local) expect(existsSync(new URL(`${action}/action.yml`, root)), action).toBe(true);
  });

  it("loop.yml leaves reading GitHub to the Kit's Node program, never inline gh calls", () => {
    const loop = workflows.find((workflow) => workflow.path.endsWith("loop.yml"))!.text;

    expect(loop).not.toMatch(/\bgh (api|issue|pr) /);
  });
});
