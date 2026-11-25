// The notes for the Held workflows' part of the major that carries the Kit's
// Operator sessions (#917) are drafted ahead, beside the others (#944). While
// they are a draft they must say what the code does: the Kit config key and
// its errors as resolveKitConfig gives them, the exports as the read library's
// entry holds them, Setup's line as planSetup gives it, and every name they
// give one the code holds under that name. Once the release ships they are a
// record, listed in RELEASED_NOTES, and keep the words of their day.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { headingAnchor } from "../__fixtures__/headingAnchor.ts";
import { aCleanProduct } from "../__fixtures__/productState.ts";
import { KIT, RELEASED_NOTES, repoFiles } from "../__fixtures__/repoScan.ts";
import { EXPORT_CALLS, EXPORT_SHAPES } from "../read/exports.fixture.ts";
import * as entry from "../read/index.ts";
import { resolveKitConfig } from "./config.ts";
import { prBody } from "../setup/finish.ts";
import { loadSetupKit, type SetupKit } from "../setup/kit.ts";
import { planSetup } from "../setup/plan.ts";
import { CALLER_FILE } from "../setup/shims.ts";

const NOTES = "docs/release-notes/held-workflows.md";
const read = (path: string): string => readFileSync(join(KIT, path), "utf8");
const issue = (number: number) => `[#${number}](https://github.com/jrey8343/fabrik/issues/${number})`;

/** The Spec, as the notes link it. */
const SPEC = "[Spec: Held workflows and the Start check](https://github.com/jrey8343/fabrik/issues/917)";

/** The four other parts' Specs, as the notes link them. */
const OTHER_SPECS = [
  "[Spec: The Console check: `console.app_id`, Setup's part, and the Kit's read leaving it out](https://github.com/jrey8343/fabrik/issues/914)",
  "[Spec: The Kit's tokens in the `fabrik` environment, which only the default branch may use](https://github.com/jrey8343/fabrik/issues/915)",
  "[Spec: Release tags and Setup's bootstrap: `setup.sh` fetched at the release it runs, and the releasing guide that reads the tag hold before it uses it](https://github.com/jrey8343/fabrik/issues/916)",
  "[Spec: The Operator session: the Kit's skills and facts reach a cloud session, and the session reports itself on its issue](https://github.com/jrey8343/fabrik/issues/918)",
];

/** The Tickets of #917 before this one, whose parts the notes hold. */
const TICKETS = [939, 940, 941, 942, 943];

describe.skipIf(RELEASED_NOTES.has(NOTES))("The Held workflows release notes, while drafted", () => {
  const notes = read(NOTES);

  it("open with their title, then one paragraph naming the Spec, the four other parts' Specs as shipping in the same major, and the paste line", () => {
    const [title, blank, opening, after] = notes.split("\n");

    expect(title).toBe("# Release notes: Held workflows and the Start check");
    expect([blank, after]).toEqual(["", ""]);
    expect(opening).toMatch(/^These are the notes for the Held workflows part of the major that carries the Kit's Operator sessions \(/);
    expect(opening).toContain(`the major that carries the Kit's Operator sessions (${SPEC})`);
    for (const spec of OTHER_SPECS) expect(opening).toContain(spec);
    expect(opening).toContain("ship in the same major");
    expect(opening?.endsWith("Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.")).toBe(true);
  });

  it("are linked from the releasing guide's one entry for the Operator sessions major, with no entry of their own", () => {
    const drafted =
      read("docs/releasing.md")
        .split("\n")
        .find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`")) ?? "";
    const [, ...entries] = drafted.split("the Operator sessions major's are ");

    // One entry for the major, which holds this draft's link by its text alone. A later part adds its own after it, so nothing here says where in the entry it is.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("[Held workflows and the Start check](release-notes/held-workflows.md)");
    expect(drafted.split("release-notes/held-workflows.md")).toHaveLength(2);
  });

  it("hold each of the Spec's Tickets, by its link", () => {
    for (const ticket of TICKETS) expect(notes, `#${ticket}`).toContain(issue(ticket));
  });

  it("have each section the Ticket asks for, in its order", () => {
    expect(notes.split("\n").filter((line) => line.startsWith("## "))).toEqual(HEADINGS.map((heading) => `## ${heading}`));
  });

  describe("Setup's line", () => {
    let kit: SetupKit;
    beforeAll(async () => {
      kit = await loadSetupKit(KIT, "v9.0.0");
    });
    const noAction = section(notes, "What changes with no action");
    /** The report's lines after the one on the repo-level secrets, for a repo holding the two workflows and this Kit config. */
    const lines = (config: string) =>
      planSetup(aCleanProduct({ workflows: { "deploy.yml": DEPLOY, "promote.yml": PROMOTE }, files: { ".fabrik/config.json": config } }), kit).report.slice(1);

    it("is quoted as planSetup gives it, for a workflow Kit config lists and one it doesn't", () => {
      expect(textBlocks(noAction)).toEqual([lines(LISTING).join("\n")]);
    });

    it("ends as the notes say where the Kit config is invalid", () => {
      const ending = "Kit config is invalid, so setup can't say whether console.held_workflows lists it.";
      expect(noAction).toContain(`ends \`${ending}\``);
      for (const line of lines("{ not json\n")) expect(line.endsWith(ending), line).toBe(true);
    });

    it("is said in Setup's report, in the terminal and never in the setup PR, and blocks and changes nothing", () => {
      const said = bullet(noAction, "Setup's report gains a line");
      expect(said).toContain("in Setup's report, which Setup says in the terminal and never in the setup PR");
      expect(said).toContain("On every run");
      expect(said).toContain("can be started by `workflow_dispatch` and has a job that asks for `id-token: write` or names an environment");
      expect(said).toContain("It blocks nothing and changes nothing");
      expect(noAction).toContain("Nothing else changes in a repo that lists no Held workflow.");

      const state = aCleanProduct({ workflows: { "promote.yml": PROMOTE } });
      const { report, ...planned } = planSetup(state, kit);
      const { report: without, ...plannedWithout } = planSetup(aCleanProduct(), kit);
      expect(report).not.toEqual(without);
      expect(planned).toEqual(plannedWithout);
      expect(prBody({ release: "v9.0.0", defaultBranch: "main", summary: { done: [], notes: planned.notes, blockers: [], report } })).not.toContain("can be started by dispatch");
    });

    it("leaves out the Kit's own caller workflow by name", () => {
      expect(bullet(noAction, "Setup's report gains a line")).toContain(`except the Kit's own caller workflow, \`${CALLER_FILE}\`, by name`);
      expect(planSetup(aCleanProduct({ workflows: { [CALLER_FILE]: DEPLOY } }), kit).report.slice(1)).toEqual([]);
    });
  });

  it("give the Kit config key, its default and each error they quote as resolveKitConfig gives them", () => {
    const config = section(notes, "What is new in Kit config");
    expect(config).toContain("It is `[]` by default, where the key or the block is left out, so a repo with neither reads exactly as before.");
    for (const text of [null, `{ "max_in_flight": 1 }`, `{ "console": { "app_id": 1234567 } }`]) {
      expect(resolveKitConfig({ config: text })).toMatchObject({ ok: true, config: { console: { heldWorkflows: [] } } });
    }
    expect(resolveKitConfig({ config: LISTING })).toMatchObject({ ok: true, config: { console: { appId: 1234567, heldWorkflows: ["promote.yml"] } } });

    expect(config).toContain("The key without it, an empty list included, is refused with");
    for (const [error, text] of Object.entries(ERRORS)) {
      expect(config).toContain(`\`${error}\``);
      expect(resolveKitConfig({ config: text })).toEqual({ ok: false, errors: [error] });
    }
    // Each kind of name the notes say is refused, refused by its place in the list.
    for (const name of ["", "promote.yml\ndns.yml", ".github/workflows/promote.yml", "promote.json"]) {
      const refused = resolveKitConfig({ config: JSON.stringify({ console: { app_id: 1234567, held_workflows: ["deploy.yml", name] } }) });
      expect(refused.ok ? [] : refused.errors).toEqual([expect.stringMatching(/^console\.held_workflows\[1\] is /)]);
    }
    expect(config).toContain("where it is blank, more than one line, a path,");
    expect(config).toContain("or not a `.yml` or `.yaml` file's name");
    // Only app_id's own error, where it is there and refused.
    expect(resolveKitConfig({ config: JSON.stringify({ console: { app_id: 0, held_workflows: ["promote.yml"] } }) })).toEqual({
      ok: false,
      errors: ["console.app_id must be a whole number of at least 1"],
    });
  });

  it("give as new exactly the two exports the read library's entry holds under their own heading, each with what it gives", () => {
    const added = bullet(section(notes, "For a reader of the read library"), "New exports");
    const named = [...new Set([...added.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""))].filter((name) => !(name in HELD_IN) && name !== "src/read/index.ts");
    const heading = read("src/read/index.ts").split("\n// Held workflows and the Start check\n")[1]?.split("\n// ")[0] ?? "";

    expect(named.toSorted()).toEqual(NEW_EXPORTS.toSorted());
    expect(heading.trim()).toBe(`export { ${NEW_EXPORTS.join(", ")} } from "../kit/startCheck.ts";`);
    expect(NEW_EXPORTS.filter((name) => !(name in EXPORT_CALLS) && !(name in EXPORT_SHAPES))).toEqual([]);
    expect(added).toContain(`\`${entry.startCheckName("promote.yml")}\` for \`promote.yml\``);
    expect(added).toContain(`\`START_CHECK_MINUTES\`, ${entry.START_CHECK_MINUTES}, how old a Start check may be`);
  });

  it("give KitConfig.console.heldWorkflows and the default as the read library's entry gives them", () => {
    const kitConfig = bullet(section(notes, "For a reader of the read library"), "`KitConfig.console.heldWorkflows`");
    expect(kitConfig).toContain("`DEFAULT_KIT_CONFIG` has `console: { appId: null, heldWorkflows: [], sessionEnvironment: null }`.");
    expect(entry.DEFAULT_KIT_CONFIG.console).toEqual({ appId: null, heldWorkflows: [], sessionEnvironment: null });
    expect(read("src/kit/config.ts")).toContain("readonly heldWorkflows: readonly string[];");
    expect(section(notes, "For a reader of the read library")).toContain("Nothing the entry exported is removed or changes meaning.");
  });

  it("say nothing in the Kit's code names a Start check but the read library's entry and the module that gives its name", () => {
    expect(bullet(section(notes, "What it never does"), "The Kit makes, reads and waits on no Start check.")).toContain(
      "Nothing in the Kit's code names one but the read library's entry and `src/kit/startCheck.ts`",
    );
    const code = repoFiles().filter((path) => /^(src|templates|skills|\.github)\//.test(path) && !path.endsWith(".test.ts") && !path.endsWith(".fixture.ts") && !path.endsWith(".md"));
    const naming = code.filter((path) => /startCheckName|START_CHECK_MINUTES|Start \S+ from the Console/.test(read(path)));

    expect(naming.toSorted()).toEqual(["src/kit/startCheck.ts", "src/read/index.ts"]);
  });

  it("say how to turn it on, step by step, the Pilot first, and that it needs the Console's tap", () => {
    const turnOn = section(notes, "To turn it on");
    const steps = turnOn.split("\n").filter((line) => /^\d+\. /.test(line));

    expect(turnOn).toContain("the Pilot first");
    expect(turnOn).toContain("A Held workflow needs the Console's tap, which the Console's own release brings");
    expect(steps.map((line) => /^\d+\. \*\*([^*]+)\*\*/.exec(line)?.[1])).toEqual([
      "Add the step to the workflow,",
      "List it in `console.held_workflows`, beside `console.app_id`,",
      "Merge that pull request.",
      "Delete the workflow's runs from before the step, or wait the 30 days out,",
    ]);
    expect(steps[0]).toContain("with the Console's App's id written in the workflow file beside the check's name");
    expect(steps[1]).toContain("in the same pull request");
    expect(steps[3]).toContain("before an Operator session works on the repo");
    expect(turnOn).toContain("For a deploy on every merge, add the step that refuses any commit but the head instead");
    expect(turnOn).toContain("and list nothing.");
  });

  it("link only headings the README has", () => {
    const headings = new Set(
      read("README.md")
        .split("\n")
        .filter((line) => /^#{2,} /.test(line))
        .map((line) => headingAnchor(line.replace(/^#+ /, ""))),
    );
    const anchors = [...notes.matchAll(/\]\(\.\.\/\.\.\/README\.md#([^)]+)\)/g)].map(([, anchor = ""]) => anchor);

    expect(anchors).toEqual(expect.arrayContaining(["held-workflows", "runs-from-before-the-step", "a-deploy-on-every-merge", "merge-gate"]));
    expect(anchors.filter((anchor) => !headings.has(anchor))).toEqual([]);
  });

  it("say why it would be a minor on its own, in the releasing guide's terms, and that it ships in the major", () => {
    const why = section(notes, "Why a minor on its own, in a major");
    expect(why).toContain("[Choosing the version](../releasing.md#choosing-the-version), this part alone would be a minor");
    expect(why).toContain("a new Kit config key with an empty default, two new exports and a new kind of line in Setup's report");
    expect(why).toContain("The major is the other parts'.");
    expect(read("docs/releasing.md")).toContain("A new export, a new field or a new Standing name is not.");
  });

  it("say the Console's line is a guess until the release's check of the Console, whose run replaces it", () => {
    const console = section(notes, "What the Console needs");
    expect(console).toContain("[Write the Console's Spec and cut it into slices](https://github.com/jrey8343/fabrik/issues/913)");
    expect(console).toContain("This line is a guess until the release is checked against the Console (step 4 of [releasing.md](../releasing.md)), and that run's answer replaces it.");
    expect(read("docs/releasing.md")).toContain("A line about the Console in a draft in `docs/release-notes/` was written when the part was built, so it is a guess until this run.");
  });

  it("say what they do not cover", () => {
    const notCovered = section(notes, "What it does not cover");
    expect(bullet(notCovered, "A Product repo's own workflow change")).toContain("that repo's own issue");
    expect(bullet(notCovered, "A way past the Start check while the Console is down")).toContain("other than the Merge gate's by-hand way past");
    expect(bullet(notCovered, "GitHub's required reviewers")).toContain("for public repos only on the Operator's plan");
  });

  describe("name only what the five Tickets shipped, by the name the code holds it under", () => {
    const exported = [...Object.keys(EXPORT_CALLS), ...Object.keys(EXPORT_SHAPES)];
    /** Everything the notes write as code outside the quoted lines of Setup's, each once. */
    const written = [...new Set([...notes.replace(/^```text\n[\s\S]*?\n```$/gm, "").matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""))];

    it("write as code only an export of the entry, a file that exists, a Kit config key that resolves, an error it gives, or a name the code holds", () => {
      const held = (name: string) => {
        const [file, text] = HELD_IN[name] ?? [];
        return file !== undefined && text !== undefined && read(file).includes(text);
      };
      const resolves = (name: string) => KIT_CONFIG_KEYS[name] !== undefined && resolveKitConfig({ config: KIT_CONFIG_KEYS[name] ?? "" }).ok;
      const unknown = written.filter(
        (name) => !exported.includes(name) && !(name.startsWith("src/") && existsSync(join(KIT, name))) && !resolves(name) && !(name in ERRORS) && !held(name),
      );

      expect(unknown).toEqual([]);
    });

    it("name no person, no private repo and no App id", () => {
      expect(notes).not.toMatch(/gradually|jrey(?!8343\/fabrik)/i);
      expect([...notes.matchAll(/https:\/\/github\.com\/[^)\s]+/g)].map(([link]) => link).filter((link) => !link.startsWith("https://github.com/jrey8343/fabrik/issues/"))).toEqual([]);
      expect(notes).not.toMatch(/\d{5,}/);
    });

    it("say Required check, never the old term", () => {
      expect(notes).not.toMatch(/gating/i);
    });
  });
});

/** The exports the five Tickets added to the read library's entry, and no others. */
const NEW_EXPORTS = ["START_CHECK_MINUTES", "startCheckName"];

/** Each Kit config error the notes quote, and a Kit config that gives that error alone. */
const ERRORS: Readonly<Record<string, string>> = {
  "console.held_workflows is valid only beside console.app_id: a Held workflow reads its Start check by that App's id": `{ "console": { "held_workflows": [] } }`,
  "console.held_workflows must be a list of strings": `{ "console": { "app_id": 1234567, "held_workflows": "promote.yml" } }`,
  'console.held_workflows[1] is ".github/workflows/promote.yml": a workflow is named by its file\'s name alone, such as deploy.yml, not by a path': `{ "console": { "app_id": 1234567, "held_workflows": ["deploy.yml", ".github/workflows/promote.yml"] } }`,
  'console.held_workflows[2] is "promote.yml", which console.held_workflows[0] already lists': `{ "console": { "app_id": 1234567, "held_workflows": ["promote.yml", "deploy.yml", "promote.yml"] } }`,
};

/** What the notes write as a Kit config key, and a Kit config that gives it, which must resolve. */
const KIT_CONFIG_KEYS: Readonly<Record<string, string>> = {
  "console.held_workflows": `{ "console": { "app_id": 1234567, "held_workflows": ["promote.yml"] } }`,
  "console.app_id": `{ "console": { "app_id": 1234567 } }`,
  "production.workflow": `{ "production": { "url": "https://clinic.example.com", "workflow": "promote.yml" } }`,
};

/** What the notes write as code that is no export, no file and no Kit config key: the file that holds it, and the text it holds it as. */
const HELD_IN: Readonly<Record<string, readonly [file: string, text: string]>> = {
  workflow_dispatch: ["src/setup/workflowRoles.ts", "workflow_dispatch"],
  "id-token: write": ["src/setup/plan.ts", "asks for id-token: write"],
  "permissions:": ["src/setup/workflowRoles.ts", "permissions"],
  "write-all": ["src/setup/workflowRoles.ts", "write-all"],
  "fabrik.yml": ["src/setup/shims.ts", `CALLER_PATH = ".github/workflows/fabrik.yml"`],
  "promote.yml": ["src/kit/startCheck.test.ts", "promote.yml"],
  "deploy.yml": ["src/kit/config.ts", "such as deploy.yml"],
  production: ["src/setup/plan.test.ts", "environment: production"],
  "Kit config is invalid, so setup can't say whether console.held_workflows lists it.": [
    "src/setup/plan.ts",
    "Kit config is invalid, so setup can't say whether console.held_workflows lists it.",
  ],
  "[]": ["src/kit/config.ts", "console: { appId: null, heldWorkflows: [], sessionEnvironment: null }"],
  console: ["src/kit/config.ts", `file.object("console")`],
  app_id: ["src/kit/config.ts", `block.wholeNumber("app_id", 1)`],
  ".yml": ["src/kit/config.ts", "a workflow's file name ends in .yml or .yaml"],
  ".yaml": ["src/kit/config.ts", "a workflow's file name ends in .yml or .yaml"],
  "Start promote.yml from the Console": ["src/kit/startCheck.test.ts", "Start promote.yml from the Console"],
  completed_at: ["src/kit/startCheck.ts", "`completed_at`"],
  "KitConfig.console.heldWorkflows": ["src/kit/config.ts", "readonly heldWorkflows: readonly string[];"],
  "console.heldWorkflows": ["src/kit/config.ts", "defaults.console.heldWorkflows"],
  "console.appId": ["src/kit/config.ts", "defaults.console.appId"],
  "console: { appId: null, heldWorkflows: [], sessionEnvironment: null }": ["src/kit/config.ts", "console: { appId: null, heldWorkflows: [], sessionEnvironment: null }"],
  // In the titles of the other parts' Specs.
  fabrik: ["src/kit/environment.ts", `KIT_ENVIRONMENT = "fabrik"`],
  "setup.sh": ["setup.sh", "#!"],
};

/** The sections the Ticket asks for, in its order. */
const HEADINGS = [
  "What changes with no action",
  "What is new in Kit config",
  "For a reader of the read library",
  "What it never does",
  "To turn it on",
  "Why a minor on its own, in a major",
  "What the Console needs",
  "What it does not cover",
];

/** The notes' section under `## heading`, up to the next one. */
function section(notes: string, heading: string): string {
  return notes.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";
}

/** The bullet of `text` that opens with `lead` in bold. */
function bullet(text: string, lead: string): string {
  return text.split("\n").find((line) => line.startsWith(`- **${lead}`)) ?? "";
}

/** Each `text` block in `text`, as the lines it holds. */
function textBlocks(text: string): string[] {
  return [...text.matchAll(/^```text\n([\s\S]*?)\n```$/gm)].map(([, body = ""]) => body);
}

/** Kit config that lists `promote.yml` as held, beside the Console's App. */
const LISTING = JSON.stringify({ console: { app_id: 1234567, held_workflows: ["promote.yml"] } });

/** A workflow promoted by hand: dispatched, with a job that names production's environment. */
const PROMOTE = ["on:", "  workflow_dispatch:", "jobs:", "  deploy:", "    runs-on: ubuntu-latest", "    environment: production", "    steps:", "      - run: ./promote", ""].join("\n");

/** A deploy on every merge, which can also be dispatched, with a job that takes a role by OIDC and names production's environment. */
const DEPLOY = [
  "on: [push, workflow_dispatch]",
  "jobs:",
  "  deploy:",
  "    runs-on: ubuntu-latest",
  "    permissions:",
  "      id-token: write",
  "    environment: production",
  "    steps:",
  "      - run: ./deploy",
  "",
].join("\n");
