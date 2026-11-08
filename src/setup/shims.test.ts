import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dependabotUpdate, scheduleIn, settingsUpdate, timeZoneIn } from "./shims.ts";

const template = readFileSync(new URL("../../templates/fabrik-runs-caller.yml", import.meta.url), "utf8");
const dependabotTemplate = readFileSync(new URL("../../templates/dependabot.yml", import.meta.url), "utf8");
const settingsTemplate = readFileSync(new URL("../../templates/claude-settings.json", import.meta.url), "utf8");

describe("The Operator's time zone in the store's caller workflow", () => {
  it("is the one setup wrote into its schedule, which the Weekly summary weeks by", () => {
    expect(timeZoneIn(scheduleIn(template, "Australia/Sydney"))).toBe("Australia/Sydney");
  });

  it("is unknown for a caller whose schedule names none", () => {
    expect(timeZoneIn(template.replace(/^\s+timezone:.*\n/m, ""))).toBeNull();
  });
});

describe("A Dependabot config that already groups the Fabrik pins", () => {
  // The Product's own entry after the Fabrik one, so the file isn't setup's unchanged template.
  const productEntry = '  - package-ecosystem: npm\n    directory: "/"\n    schedule:\n      interval: weekly\n';
  const withPattern = (pattern: string) =>
    `${dependabotTemplate.replace('- "jrey8343/fabrik*"\n    # A', `- ${pattern}\n    # A`)}${productEntry}`;

  it.each([
    ["double quotes", '"jrey8343/fabrik*"'],
    ["single quotes", "'jrey8343/fabrik*'"],
    ["no quotes", "jrey8343/fabrik*"],
    ["double quotes with a trailing comment", '"jrey8343/fabrik*" # every Fabrik pin'],
    ["no quotes with a trailing comment", "jrey8343/fabrik* # every Fabrik pin"],
  ])("is left alone with no note when the pattern is in %s", (_style, pattern) => {
    const existing = withPattern(pattern);
    expect(existing).toContain(`patterns:\n          - ${pattern}\n`);

    expect(dependabotUpdate(existing, dependabotTemplate)).toBeNull();
  });

  it("still gets the note when its Fabrik entry has no fabrik group", () => {
    const ungrouped = dependabotTemplate.replace(/^ {4}# Each pinned Fabrik workflow[\s\S]*?- "jrey8343\/fabrik\*"\n/m, "");

    expect(dependabotUpdate(`${ungrouped}${productEntry}`, dependabotTemplate)).toEqual({
      note: expect.stringContaining("doesn't group the Fabrik pins"),
    });
  });
});

// #422: a major may change the caller's shape, so a Dependabot bump of it kills every run; only Setup delivers one.
describe("A Dependabot config and a major Fabrik release", () => {
  const ignoreBlock = /^ {4}# Never a major[\s\S]*?update-types: \["version-update:semver-major"\]\n/m;
  const productEntry = '  - package-ecosystem: npm\n    directory: "/"\n    schedule:\n      interval: weekly\n';

  it("the shim the Kit ships ignores a major for the Kit, so Dependabot proposes only a patch or a minor", () => {
    expect(dependabotTemplate).toMatch(
      /^ {4}ignore:\n {6}- dependency-name: "jrey8343\/fabrik\*"\n {8}update-types: \["version-update:semver-major"\]\n/m,
    );
  });

  it("the shim an earlier Setup wrote, unchanged, with no ignore of a major, is replaced by the template", () => {
    const earlier = dependabotTemplate.replace(ignoreBlock, "");
    expect(earlier).not.toBe(dependabotTemplate);

    expect(dependabotUpdate(earlier, dependabotTemplate)).toEqual({ content: dependabotTemplate });
  });

  it("an edited Fabrik entry that groups the pins but doesn't ignore a major gets a note saying what to add", () => {
    const edited = `${dependabotTemplate.replace(ignoreBlock, "")}${productEntry}`;

    expect(dependabotUpdate(edited, dependabotTemplate)).toEqual({
      note: expect.stringMatching(/doesn't ignore a major Fabrik release.*version-update:semver-major/),
    });
  });

  it("an edited Fabrik entry that ignores a major in its own quoting is left alone", () => {
    const edited = `${dependabotTemplate.replace('update-types: ["version-update:semver-major"]', "update-types:\n          - version-update:semver-major")}${productEntry}`;

    expect(dependabotUpdate(edited, dependabotTemplate)).toBeNull();
  });
});

describe("The Product's .claude/settings.json with the Fabrik SessionStart hook merged in", () => {
  it("is printed as Prettier prints JSON, in the file's own indent, with an array that fits on one line", () => {
    const theirs = '{\n    "permissions": {\n        "allow": [\n            "Bash(npm test)",\n            "Bash(npm run lint)"\n        ]\n    }\n}\n';

    const update = settingsUpdate(theirs, settingsTemplate);

    const content = update !== null && "content" in update ? update.content : "";
    expect(content).toMatch(/^\{\n {4}"permissions": \{\n {8}"allow": \["Bash\(npm test\)", "Bash\(npm run lint\)"\]\n {4}\},\n {4}"hooks": \{\n/);
    expect(content.endsWith("\n}\n")).toBe(true);
  });
});
