import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { callerUpdate, dependabotUpdate, pinCaller, scheduleIn, settingsUpdate, STORE_CALLER_PATH, timeZoneIn } from "./shims.ts";

const template = readFileSync(new URL("../../templates/fabrik-runs-caller.yml", import.meta.url), "utf8");
const dependabotTemplate = readFileSync(new URL("../../templates/dependabot.yml", import.meta.url), "utf8");
const settingsTemplate = readFileSync(new URL("../../templates/claude-settings.json", import.meta.url), "utf8");

describe("The Operator's time zone in the store's caller workflow", () => {
  it("is the one setup wrote into its schedule, which the Weekly summary weeks by", () => {
    expect(timeZoneIn(scheduleIn(template, "Australia/Sydney"))).toBe("Australia/Sydney");
  });

  it("is unknown for a caller whose schedule names none", () => {
    expect(timeZoneIn(template.replace(/^\s+timezone:.*\n/gm, ""))).toBeNull();
  });
});

describe("The store's caller workflow's two schedules", () => {
  const caller = parse(scheduleIn(template, "Australia/Sydney")) as {
    on: { schedule: { cron: string; timezone: string }[]; workflow_dispatch: unknown };
    jobs: Record<string, { if?: string; uses: string; permissions: Record<string, string> }>;
  };

  it("runs at 07:00 every day and every Monday, both in the Operator's time zone", () => {
    expect(caller.on.schedule).toEqual([
      { cron: "0 7 * * 1", timezone: "Australia/Sydney" },
      { cron: "0 7 * * *", timezone: "Australia/Sydney" },
    ]);
  });

  it("files the Weekly summary only on the Monday schedule and by hand", () => {
    expect(caller.jobs["summary"]?.if).toBe("github.event_name == 'workflow_dispatch' || github.event.schedule == '0 7 * * 1'");
    expect(caller.jobs["summary"]?.uses).toMatch(/^jrey8343\/fabrik\/\.github\/workflows\/weekly-summary\.yml@/);
  });

  it("runs the Tick check only on the daily schedule, at the same pin as the summary", () => {
    const pin = (uses = "") => uses.slice(uses.lastIndexOf("@"));

    expect(caller.jobs["tick-check"]?.if).toBe("github.event.schedule == '0 7 * * *'");
    expect(caller.jobs["tick-check"]?.uses).toMatch(/^jrey8343\/fabrik\/\.github\/workflows\/tick-check\.yml@/);
    expect(pin(caller.jobs["tick-check"]?.uses)).toBe(pin(caller.jobs["summary"]?.uses));
  });

  it("is what re-running Setup writes over an older caller with no daily schedule, at the release it pins", () => {
    const older = [
      "name: Fabrik weekly summary",
      "on:",
      "  schedule:",
      '    - cron: "0 7 * * 1"',
      '      timezone: "Australia/Sydney"',
      "  workflow_dispatch:",
      "permissions: {}",
      "jobs:",
      "  summary:",
      "    uses: jrey8343/fabrik/.github/workflows/weekly-summary.yml@v1.1.0",
      "    permissions:",
      "      id-token: write",
      "    secrets:",
      "      OP_PUSH_TOKEN: ${{ secrets.FABRIK_OP_PUSH_TOKEN }}",
      "",
    ].join("\n");

    const update = callerUpdate(older, scheduleIn(template, "Australia/Sydney"), "v1.1.0", STORE_CALLER_PATH);

    expect(update).toEqual({ content: pinCaller(scheduleIn(template, "Australia/Sydney"), "v1.1.0") });
    expect(timeZoneIn(older)).toBe("Australia/Sydney");
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

// #452: Dependabot rejects a config it can't parse, and every update for the repo stops, the Fabrik pin's included.
describe("A Product's own Dependabot config with the Fabrik entry merged in", () => {
  const npmEntry = { "package-ecosystem": "npm", directory: "/", schedule: { interval: "weekly" } };
  const fabrikEntry = (parse(dependabotTemplate) as { updates: unknown[] }).updates[0];
  const merged = (existing: string): string => {
    const update = dependabotUpdate(existing, dependabotTemplate);
    if (update === null || !("content" in update)) throw new Error(`no content: ${JSON.stringify(update)}`);
    return update.content;
  };

  it.each([
    ["a 4-space list", 'version: 2\nupdates:\n    - package-ecosystem: npm\n      directory: "/"\n      schedule:\n        interval: weekly\n'],
    ["a column-0 list", 'version: 2\nupdates:\n- package-ecosystem: npm\n  directory: "/"\n  schedule:\n    interval: weekly\n'],
    ["a comment on updates:", 'version: 2\nupdates: # bumps\n  - package-ecosystem: npm\n    directory: "/"\n    schedule:\n      interval: weekly\n'],
    ["a list followed by a top-level key", 'updates:\n  - package-ecosystem: npm\n    directory: "/"\n    schedule:\n      interval: weekly\n\n# Then the version\nversion: 2\n'],
    ["a list and no newline at the end", 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: "/"\n    schedule:\n      interval: weekly'],
  ])("keeps the Product's entries and parses, from %s", (_shape, existing) => {
    expect(parse(merged(existing))).toEqual({ version: 2, updates: [npmEntry, fabrikEntry] });
  });

  it.each([
    ["updates: []", "version: 2\nupdates: []\n"],
    ["updates: [] with a comment", "version: 2\nupdates: [] # none yet\n"],
    ["an updates: with no value", "version: 2\nupdates:\n"],
    ["no updates: key", "version: 2\n"],
  ])("adds the Fabrik entry and parses, from %s", (_shape, existing) => {
    expect(parse(merged(existing))).toEqual({ version: 2, updates: [fabrikEntry] });
  });

  it("keeps the comment on updates: and every line of the Product's own", () => {
    const existing = "# Our bumps\nversion: 2\nupdates: [] # none yet\n";

    expect(merged(existing)).toMatch(/^# Our bumps\nversion: 2\nupdates: # none yet\n {2}- package-ecosystem: github-actions\n/);
  });

  it("adds an updates: key after the Product's own keys when the file has none", () => {
    expect(merged("version: 2\n")).toMatch(/^version: 2\nupdates:\n {2}- package-ecosystem: github-actions\n/);
  });

  it.each([
    ["a list indented less than its first entry", 'version: 2\nupdates:\n    - package-ecosystem: npm\n      directory: "/"\n  - package-ecosystem: pip\n'],
    ["a mapping for updates:", "version: 2\nupdates:\n  npm: weekly\n"],
    ["a flow list with entries", 'version: 2\nupdates: [{ package-ecosystem: npm, directory: "/" }]\n'],
    ["tab indentation", "version: 2\nupdates:\n\t- package-ecosystem: npm\n"],
    ["two updates: keys", "version: 2\nupdates:\n  - package-ecosystem: npm\nupdates: []\n"],
  ])("isn't written when the file doesn't parse, and the plan says so: %s", (_shape, existing) => {
    expect(dependabotUpdate(existing, dependabotTemplate)).toEqual({ note: expect.stringMatching(/^\.github\/dependabot\.yml doesn't parse.*line \d/) });
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
