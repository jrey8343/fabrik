// The notes for the Operator session's part of the major that carries the
// Kit's Operator sessions (#918) are drafted ahead, beside the others (#958).
// While they are a draft they must say what the code does: every export they
// name is one the read library's entry exports, every file they name exists,
// the field they name is on Row, and the releasing guide's entry for the
// major links them last. Once the release ships they are a record, listed in
// RELEASED_NOTES, and keep the words of their day.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, RELEASED_NOTES, repoFiles } from "../__fixtures__/repoScan.ts";
import { A_ROW_KEPT_AT_V3_4_1, EXPORT_CALLS, EXPORT_SHAPES } from "../read/exports.fixture.ts";
import * as entry from "../read/index.ts";
import { settingsUpdate } from "../setup/shims.ts";
import { resolveKitConfig } from "./config.ts";
import { OPERATOR_SESSION_PATH, operatorSessionMarker } from "./operatorSession.ts";

const NOTES = "docs/release-notes/operator-session.md";
const read = (path: string): string => readFileSync(join(KIT, path), "utf8");

/** The Spec, as the notes link it. */
const SPEC = "[Spec: The Operator session: the Kit's skills and facts reach a cloud session, and the session reports itself on its issue](https://github.com/jrey8343/fabrik/issues/918)";

describe.skipIf(RELEASED_NOTES.has(NOTES))("The Operator session release notes, while drafted", () => {
  const notes = read(NOTES);

  it("open with their title, then one paragraph naming the Spec and ending with the paste line", () => {
    const [title, blank, opening, after] = notes.split("\n");

    expect(title).toBe("# Release notes: the Operator session");
    expect([blank, after]).toEqual(["", ""]);
    expect(opening).toMatch(/^These are the notes for the Operator session's part of the major /);
    expect(opening).toContain(`(${SPEC})`);
    expect(opening?.endsWith("Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.")).toBe(true);
  });

  it("are linked last from the releasing guide's one entry for the Operator sessions major, after the four other parts' links as they landed, with no entry of their own", () => {
    const drafted =
      read("docs/releasing.md")
        .split("\n")
        .find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`")) ?? "";
    const [, ...entries] = drafted.split("the Operator sessions major's are ");

    expect(entries).toEqual([
      "[the Console check](release-notes/console-check.md), [the Kit's tokens in the `fabrik` environment](release-notes/fabrik-environment.md), [release tags and Setup's bootstrap](release-notes/release-tags.md), [Held workflows and the Start check](release-notes/held-workflows.md) and [the Operator session](release-notes/operator-session.md).",
    ]);
    expect(drafted.split("release-notes/operator-session.md")).toHaveLength(2);
  });

  it("have each section the Ticket asks for, in its order", () => {
    expect(notes.split("\n").filter((line) => line.startsWith("## "))).toEqual(HEADINGS.map((heading) => `## ${heading}`));
  });

  describe("What changed", () => {
    const changed = section(notes, "What changed");

    it("name each part, part by part, with the Ticket that built it", () => {
      for (const [lead, tickets] of PARTS) {
        const said = bullet(changed, lead);
        expect(said, lead).not.toBe("");
        for (const ticket of tickets) expect(said, `${lead} #${ticket}`).toContain(issue(ticket));
      }
      expect(changed.split("\n").filter((line) => line.startsWith("- **"))).toHaveLength(PARTS.length);
    });

    it("say the downloads are git's own shallow fetch from github.com everywhere, where a cloud session refused codeload's archive", () => {
      const fetch = bullet(changed, PARTS[0][0]);
      expect(fetch).toContain("in a cloud session, at a terminal and in an AFK run alike");
      expect(fetch).toContain("`codeload.github.com`");
      expect(read("templates/claude-settings.json")).toContain("fetch -q --depth 1 https://github.com/jrey8343/fabrik");
      expect(read("templates/claude-settings.json")).not.toContain("codeload.github.com");
      expect(read("src/skills/fetch.ts")).not.toContain("codeload.github.com");
    });

    it("say fabrik's own hook entry runs the pinned skills under plain names, with the mattpocock-skills plugin off", () => {
      const hook = bullet(changed, PARTS[1][0]);
      expect(hook).toContain("under their plain names");
      expect(hook).toContain("the `mattpocock-skills` plugin off");
      const settings = JSON.parse(read(".claude/settings.json")) as { enabledPlugins: Record<string, boolean> };
      expect(settings.enabledPlugins).toEqual({ "mattpocock-skills@claude-plugins-official": false });
      expect(read(".claude/settings.json")).toContain("src/session/start.ts\\\" --kit");
    });

    it("say /fabrik-pair merges nothing where console.app_id is set and asks for the tap before a Held workflow, as the skill does", () => {
      const pair = bullet(changed, PARTS[4][0]);
      const skill = read("skills/fabrik-pair/SKILL.md");
      expect(pair).toContain("merges nothing on a repo whose Kit config holds `console.app_id`");
      expect(skill).toContain("on any repo whose `.fabrik/config.json` holds `console.app_id`");
      expect(pair).toContain("asks for the Operator's tap in the Console before it starts a Held workflow");
      expect(skill).toContain("ask for the tap, naming the workflow, then start the run");
      expect(pair).toContain("with rotation on");
      expect(skill).toContain("**Two or more, so rotation is on.**");
    });

    it("give the marker as operatorSessionMarker writes it", () => {
      expect(bullet(changed, PARTS[5][0])).toContain(`\`${operatorSessionMarker("<address>")}\``);
    });

    it("name the two new ADRs by their files, and the Glossary's five entries as the Glossary has them", () => {
      const docs = bullet(changed, PARTS[8][0]);
      for (const adr of NEW_ADRS) {
        expect(docs, adr).toContain(`(../adr/${adr})`);
        expect(existsSync(join(KIT, "docs/adr", adr)), adr).toBe(true);
      }
      const glossary = read("GLOSSARY.md");
      for (const term of GLOSSARY_ENTRIES) {
        expect(docs, term).toContain(term);
        expect(glossary, term).toContain(`**${term}**:`);
      }
      expect(docs).toContain("ADR-0003's addendum");
      expect(docs).toContain("ADR-0005, ADR-0008 and ADR-0009");
    });

    it("quote the hook's line on a failed fetch as the hook entry gives it", () => {
      expect(bullet(changed, PARTS[0][0])).toContain("`Fabrik didn't install its skills: fetching Fabrik <release> from github.com failed`");
      expect(read("templates/claude-settings.json")).toContain("Fabrik didn't install its skills: fetching Fabrik $v from github.com failed");
    });
  });

  describe("Why a major", () => {
    const why = section(notes, "Why a major");

    it("say the hook entry is a changed shim, so a Product repo runs Setup again at the major, once for all five Specs, as the releasing guide has it", () => {
      expect(why).toContain("the hook entry in `.claude/settings.json` is a changed shim");
      expect(why).toContain("each Product repo takes this by running Setup again at the major, once for all five Specs");
      expect(read("docs/releasing.md")).toContain("a changed shim (the caller workflow's shape, the session hook entry,");
      expect(read("docs/releasing.md")).toContain("Each Product repo migrates by running Setup again, naming the new release");
    });

    it("say Setup's merge replaces the Kit's old hook entry and keeps the repo's other hooks, as settingsUpdate does", () => {
      expect(why).toContain("Setup's merge replaces the Kit's old hook entry where it stands and keeps the repo's other hooks");
      const template = read("templates/claude-settings.json");
      const ours = (JSON.parse(template) as { hooks: { SessionStart: unknown[] } }).hooks.SessionStart[0];
      const theirs = { hooks: [{ type: "command", command: "echo hello" }] };
      const old = { hooks: [{ type: "command", command: 'curl -fsSL "https://codeload.github.com/jrey8343/fabrik/tar.gz/refs/tags/v4.0.0" | tar -xzf -' }] };
      const update = settingsUpdate(JSON.stringify({ hooks: { SessionStart: [theirs, old] } }), template);

      expect(update !== null && "content" in update ? (JSON.parse(update.content) as { hooks: { SessionStart: unknown[] } }).hooks.SessionStart : update).toEqual([theirs, ours]);
    });
  });

  describe("For a reader of the read library", () => {
    const reader = section(notes, "For a reader of the read library");

    it("give as new exactly the two exports the read library's entry holds under Operator sessions, each held by the exports fixture", () => {
      const added = bullet(reader, "New exports");
      const named = [...new Set([...added.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""))].filter((name) => name in entry);
      const heading = read("src/read/index.ts").split("\n// Operator sessions\n")[1]?.split("\n// ")[0] ?? "";

      expect(named.toSorted()).toEqual(NEW_EXPORTS.toSorted());
      expect(heading.trim()).toBe(`export { ${NEW_EXPORTS.join(", ")} } from "../kit/operatorSession.ts";`);
      expect(NEW_EXPORTS.filter((name) => !(name in EXPORT_CALLS))).toEqual([]);
      expect(added).toContain(`\`BARE_SESSION_ENVIRONMENT\`, \`${entry.BARE_SESSION_ENVIRONMENT}\``);
      expect(entry.sessionEnvironmentOf(null)).toBe(entry.BARE_SESSION_ENVIRONMENT);
    });

    it("give the row's new field as Row holds it, and say a row kept before it reads with it null through readRow", () => {
      const field = bullet(reader, "The row's `operatorSession`");
      expect(field).toContain("a row kept before it reads with `operatorSession: null` through `readRow`");
      expect(EXPORT_SHAPES["Row"]).toHaveProperty("operatorSession");
      expect(read("src/read/rows.ts")).toContain("readonly operatorSession: string | null;");
      expect(A_ROW_KEPT_AT_V3_4_1).not.toHaveProperty("operatorSession");
      expect(entry.readRow(A_ROW_KEPT_AT_V3_4_1)).toMatchObject({ operatorSession: null });
    });

    it("say nothing exported is removed or changes meaning", () => {
      expect(reader).toContain("Nothing the entry exported is removed or changes meaning.");
    });
  });

  it("give the Console's line as a guess, the row's field for the Session pill and sessionEnvironmentOf for the link, until the release's check of the Console replaces it", () => {
    const console = section(notes, "What the Console needs");
    expect(console).toContain("the row's `operatorSession` for the Session pill");
    expect(console).toContain("`sessionEnvironmentOf` for the link's `environment=`");
    expect(console).toContain("This line is a guess until the release is checked against the Console (step 4 of [releasing.md](../releasing.md)), and that run's answer replaces it.");
    expect(read("docs/releasing.md")).toContain("A line about the Console in a draft in `docs/release-notes/` was written when the part was built, so it is a guess until this run.");
  });

  it("say nothing in a Product repo turns it on, and name the two account-wide Operator steps", () => {
    const turnOn = section(notes, "To turn it on");
    expect(turnOn).toContain("Nothing in a Product repo.");
    expect(turnOn).toContain("[Operator step: cut the Claude GitHub App's list to `fabrik` and the Product repos](https://github.com/jrey8343/fabrik/issues/910)");
    expect(turnOn).toContain("[Operator step: run the README's checklist on both Subscriptions](https://github.com/jrey8343/fabrik/issues/960)");
    expect(turnOn).toContain("the Console offers no session until each is done");
    expect(turnOn).toContain("[The checklist, on each Subscription](../../README.md#the-checklist-on-each-subscription)");
    expect(read("README.md")).toContain("\n### The checklist, on each Subscription\n");
    expect(turnOn).toContain("A Product repo that attaches a credential makes its own Session environment and `.fabrik/operator-session.md` as its own issue.");
  });

  describe("What does not change", () => {
    const unchanged = section(notes, "What does not change");

    it("say no Standing, Human touch, Run record or Weekly summary line reads a session, as only the row's code reads the marker", () => {
      expect(bullet(unchanged, "Nothing the Kit counts reads a session.")).toContain("No Standing, no Human touch, no Run record and no Weekly summary line reads a session");
      const code = repoFiles().filter((path) => /^(src|templates|skills|\.github)\//.test(path) && !path.endsWith(".test.ts") && !path.endsWith(".fixture.ts") && !path.endsWith(".md"));
      const reading = code.filter((path) => /operatorSessionIn|OPERATOR_SESSION_MARKER|operatorSession:/.test(read(path)));

      expect(reading.toSorted()).toEqual(["src/kit/operatorSession.ts", "src/read/keptRow.ts", "src/read/rows.ts"]);
    });

    it("say the AFK runs install their own role's picks as before, as ADR-0008 still has it", () => {
      expect(bullet(unchanged, "The AFK runs install their own role's picks")).toContain("as before");
      expect(read("docs/adr/0008-product-repos-pin-extra-skills-per-role.md")).toContain("Each AFK run installs the Base skills plus only its own role's Extra skills");
    });

    it("say a terminal Pairing session on a repo with no console.app_id merges another pull request on the Operator's word, as the skill does", () => {
      expect(bullet(unchanged, "A Pairing session at the terminal")).toContain("on a repo with no `console.app_id` merges another pull request on the Operator's word, as before");
      expect(read("skills/fabrik-pair/SKILL.md")).toContain("Anywhere else, at the terminal, you merge it on the Operator's word.");
    });
  });

  describe("name only what the Spec's Tickets shipped, by the name the code holds it under", () => {
    const exported = [...Object.keys(EXPORT_CALLS), ...Object.keys(EXPORT_SHAPES)];
    /** Everything the notes write as code, each once. */
    const written = [...new Set([...notes.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""))];

    it("write as code only an export of the entry, a file or folder that exists, a Kit config key that resolves, or a name the code holds", () => {
      const held = (name: string) => {
        const [file, text] = HELD_IN[name] ?? [];
        return file !== undefined && text !== undefined && read(file).includes(text);
      };
      const exists = (name: string) => /^\.?[\w-]+\//.test(name) && existsSync(join(KIT, name));
      const resolves = (name: string) => KIT_CONFIG_KEYS[name] !== undefined && resolveKitConfig({ config: KIT_CONFIG_KEYS[name] ?? "" }).ok;
      const gone = (name: string) => GONE[name]?.every((file) => !read(file).includes(name)) ?? false;
      const unknown = written.filter((name) => !exported.includes(name) && !exists(name) && !resolves(name) && !held(name) && !gone(name) && !CONSOLE_NAMES.includes(name));

      expect(unknown).toEqual([]);
    });

    it("give the Console's own names only in the guess at what the Console needs", () => {
      const console = section(notes, "What the Console needs");
      for (const name of CONSOLE_NAMES) expect(notes.split(`\`${name}\``).length - 1, name).toBe(console.split(`\`${name}\``).length - 1);
    });

    it("name the Product repo's file by the path the Kit gives it", () => {
      expect(written).toContain(OPERATOR_SESSION_PATH);
    });

    it("name no person and no private repo", () => {
      expect(notes).not.toMatch(/gradually|jrey(?!8343\/fabrik)/i);
      expect([...notes.matchAll(/https:\/\/github\.com\/[^)\s]+/g)].map(([link]) => link).filter((link) => !link.startsWith("https://github.com/jrey8343/fabrik/issues/"))).toEqual([]);
    });
  });
});

/** What the notes write as a Kit config key, and a Kit config that gives it, which must resolve. */
const KIT_CONFIG_KEYS: Readonly<Record<string, string>> = {
  "console.session_environment": `{ "console": { "session_environment": "product-sessions" } }`,
  "console.app_id": `{ "console": { "app_id": 1234567 } }`,
};

/** What the notes write as code that is no export, no file and no Kit config key: the file that holds it, and the text it holds it as. */
const HELD_IN: Readonly<Record<string, readonly [file: string, text: string]>> = {
  fabrik: ["src/kit/environment.ts", `KIT_ENVIRONMENT = "fabrik"`],
  "github.com": ["src/skills/fetch.ts", "`https://github.com/${repository}`"],
  "Fabrik didn't install its skills: fetching Fabrik <release> from github.com failed": [
    "templates/claude-settings.json",
    "Fabrik didn't install its skills: fetching Fabrik $v from github.com failed",
  ],
  SessionStart: ["templates/claude-settings.json", `"SessionStart"`],
  "git init": ["src/skills/fetch.ts", `"init"`],
  "git fetch --depth 1": ["src/skills/fetch.ts", `"fetch", "-q", "--depth", "1"`],
  "src/session/start.ts --kit": [".claude/settings.json", `src/session/start.ts\\" --kit`],
  "skills.lock.json": ["src/session/start.ts", "skills.lock.json"],
  "mattpocock-skills": [".claude/settings.json", `"mattpocock-skills@claude-plugins-official": false`],
  CLAUDE_CODE_REMOTE: ["src/session/cloudSession.ts", `env.CLAUDE_CODE_REMOTE === "true"`],
  true: ["src/session/cloudSession.ts", `env.CLAUDE_CODE_REMOTE === "true"`],
  "gh issue": ["src/session/cloudSession.ts", "`gh issue` and `gh pr` are refused here"],
  "gh pr": ["src/session/cloudSession.ts", "`gh issue` and `gh pr` are refused here"],
  gh: ["skills/fabrik-pair/SKILL.md", "write to the issue with `gh`"],
  "fabrik-operator-session": ["skills/fabrik-operator-session/SKILL.md", "name: fabrik-operator-session"],
  FABRIK_SESSION_ENVIRONMENT: ["src/session/cloudSession.ts", "env.FABRIK_SESSION_ENVIRONMENT"],
  CLAUDE_CODE_REMOTE_SESSION_ID: ["src/session/cloudSession.ts", "env.CLAUDE_CODE_REMOTE_SESSION_ID"],
  [OPERATOR_SESSION_PATH]: ["src/kit/operatorSession.ts", `OPERATOR_SESSION_PATH = "${OPERATOR_SESSION_PATH}"`],
  "/fabrik-pair": ["skills/fabrik-pair/SKILL.md", "Run as /fabrik-pair <issue number>."],
  [operatorSessionMarker("<address>")]: ["src/kit/operatorSession.ts", "`<!-- fabrik:operator-session <address> -->`"],
  "https://claude.ai/code/session_": ["src/kit/operatorSession.ts", `SESSION_ADDRESS_PREFIX = "https://claude.ai/code/session_"`],
  operatorSession: ["src/read/rows.ts", "readonly operatorSession: string | null;"],
  "operatorSession: null": ["src/read/keptRow.ts", "operatorSession: null"],
  "operator-sessions": ["src/kit/operatorSession.ts", `BARE_SESSION_ENVIRONMENT = "operator-sessions"`],
  "id-token: write": ["src/setup/plan.ts", "asks for id-token: write"],
  ".fabrik/": ["src/kit/config.ts", `".fabrik/config.json"`],
  ".claude/settings.json": ["src/setup/shims.ts", `SETTINGS_PATH = ".claude/settings.json"`],
  ".claude/skills/": [".gitignore", ".claude/skills/"],
  "KitConfig.console.sessionEnvironment": ["src/kit/config.ts", "readonly sessionEnvironment: string | null;"],
  "console: { appId: null, heldWorkflows: [], sessionEnvironment: null }": ["src/kit/config.ts", "console: { appId: null, heldWorkflows: [], sessionEnvironment: null }"],
};

/** What the notes write as code that the Kit no longer holds, and the files it is gone from. */
const GONE: Readonly<Record<string, readonly string[]>> = {
  "codeload.github.com": ["templates/claude-settings.json", "src/skills/fetch.ts", "src/session/start.ts"],
};

/** The Console's own names, which the guess at what the Console needs gives and the Kit holds none of: its link's Session environment parameter. */
const CONSOLE_NAMES: readonly string[] = ["environment="];

/** The exports the Spec added to the read library's entry, and no others. */
const NEW_EXPORTS = ["BARE_SESSION_ENVIRONMENT", "sessionEnvironmentOf"];

/** Each part the notes name under What changed, by the bold lead of its bullet, and the Tickets that built it. */
const PARTS = [
  ["The hook entry and the Skills fetch download by git's own shallow fetch from `github.com`", [948]],
  ["`fabrik` has a hook entry of its own", [949]],
  ["The hook's lines in a cloud session", [953]],
  ["`fabrik-operator-session`, the Kit's text for cloud sessions", [952]],
  ["`/fabrik-pair` in both places", [954]],
  ["The marker, and the row's `operatorSession`", [951]],
  ["The Session environment", [950]],
  ["`.fabrik/operator-session.md`, and Setup's two report lines", [955]],
  ["The docs", [956, 946, 947, 949, 957]],
] as const satisfies readonly (readonly [lead: string, tickets: readonly number[]])[];

/** The two ADRs the Spec added, by their files. */
const NEW_ADRS = [
  "0041-an-operator-session-runs-in-a-claude-code-cloud-session-started-by-a-link-and-the-console-draws-no-chat.md",
  "0042-an-operator-session-is-trusted-as-the-operator-up-to-a-short-list-of-acts-which-stop-at-a-pull-request-the-operator-merges-or-at-the-operators-own-hands.md",
];

/** The Glossary's five entries the Spec wrote or rewrote. */
const GLOSSARY_ENTRIES = ["Spec", "Pairing session", "Operator session", "Session environment", "Trust-root file"];

/** The sections the Ticket asks for, in its order. */
const HEADINGS = ["What changed", "Why a major", "For a reader of the read library", "What the Console needs", "To turn it on", "What does not change"];

const issue = (number: number) => `[#${number}](https://github.com/jrey8343/fabrik/issues/${number})`;

/** The notes' section under `## heading`, up to the next one. */
function section(notes: string, heading: string): string {
  return notes.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";
}

/** The bullet of `text` that opens with `lead` in bold. */
function bullet(text: string, lead: string): string {
  return text.split("\n").find((line) => line.startsWith(`- **${lead}`)) ?? "";
}
