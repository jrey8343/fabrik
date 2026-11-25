// The notes for the Console check's part of the major that carries the Kit's
// Operator sessions (#914) are drafted ahead, beside the others (#925). While
// they are a draft they must say what the code does: the key, the check's name
// and the read's new field each as the code holds them, and every name they
// give one the code holds under that name. Once the release ships they are a
// record, listed in RELEASED_NOTES, and keep the words of their day.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import type { ReadClient } from "../github/client.ts";
import { EXPORT_CALLS, EXPORT_SHAPES } from "../read/exports.fixture.ts";
import * as entry from "../read/index.ts";
import { checksFromGh } from "../review/checks.ts";
import { prBody } from "../setup/finish.ts";
import { DEFAULT_KIT_CONFIG, resolveKitConfig } from "./config.ts";
import { CONSOLE_CHECK } from "./consoleCheck.ts";

const NOTES = "docs/release-notes/console-check.md";
const read = (path: string): string => readFileSync(join(KIT, path), "utf8");
const issue = (number: number) => `[#${number}](https://github.com/jrey8343/fabrik/issues/${number})`;

/** The notes' section under `## heading`, up to the next one. */
const section = (notes: string, heading: string): string => notes.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";

/** The bullet of `text` that opens with `lead` in bold. */
const bullet = (text: string, lead: string): string => text.split("\n").find((line) => line.startsWith(`- **${lead}`)) ?? "";

/** The Tickets of #914 before this one, whose parts the notes hold. */
const TICKETS = [919, 920, 921, 922, 923, 924];

/** The exports the six Tickets added to the read library's entry, and no others. */
const NEW_EXPORTS = ["CONSOLE_CHECK", "ConsoleCheckRead"];

/** What the notes write as a Kit config key, and a Kit config that gives it, which must resolve. */
const KIT_CONFIG_KEYS: Readonly<Record<string, string>> = {
  "console.app_id": `{ "console": { "app_id": 1234567 } }`,
  "sandbox.checks": `{ "sandbox": { "checks": ["build"] } }`,
};

/** What the notes write as code that is no export, no file and no Kit config key: the file that holds it, and the text it holds it as. */
const HELD_IN: Readonly<Record<string, readonly [file: string, text: string]>> = {
  "Merge from the Console": ["src/kit/consoleCheck.ts", `CONSOLE_CHECK = "Merge from the Console"`],
  console: ["src/kit/config.ts", `file.object("console")`],
  app_id: ["src/setup/plan.ts", "app_id: consoleApp"],
  "console.appId": ["src/kit/config.ts", "defaults.console.appId"],
  "KitConfig.console.appId": ["src/kit/config.ts", "readonly appId: number | null;"],
  "console: { appId: null, heldWorkflows: [] }": ["src/kit/config.ts", "console: { appId: null, heldWorkflows: [] }"],
  consoleCheck: ["src/read/requiredChecks.ts", "readonly consoleCheck: ConsoleCheckRead;"],
  "RequiredChecksRead.consoleCheck": ["src/read/requiredChecks.ts", "readonly consoleCheck: ConsoleCheckRead;"],
  required: ["src/read/requiredChecks.ts", `{ readonly is: "required"; readonly apps: readonly (number | null)[] }`],
  apps: ["src/read/requiredChecks.ts", "readonly apps: readonly (number | null)[]"],
  "not-required": ["src/read/requiredChecks.ts", `{ readonly is: "not-required" }`],
  unknown: ["src/read/requiredChecks.ts", `{ readonly is: "unknown" }`],
  readDefaultBranchRequiredChecks: ["src/read/requiredChecks.ts", "export async function readDefaultBranchRequiredChecks("],
  "gh pr checks": ["src/review/wait.ts", `gh("pr", "checks"`],
  gh: ["src/setup/finish.ts", "github.com and gh included"],
  "Fabrik Merge gate": ["src/setup/plan.ts", `MERGE_GATE_RULESET = "Fabrik Merge gate"`],
  fabrik: ["docs/adr/0019-the-merge-gate-holds-the-operator-to-the-required-checks.md", "`fabrik` and `fabrik-console` are not Product repos under the Merge gate"],
  "fabrik-console": ["docs/adr/0019-the-merge-gate-holds-the-operator-to-the-required-checks.md", "`fabrik` and `fabrik-console` are not Product repos under the Merge gate"],
};

/** A repo whose default branch requires `build` and the Console check from App 1234567 in its protection, and the Console check from no App in a ruleset. */
const coveredRepo: Pick<ReadClient, "rest"> = {
  rest: (_method, path) => {
    if (path === "/repos/acme/shop") return Promise.resolve({ default_branch: "main" });
    if (path === "/repos/acme/shop/branches/main") {
      const checks = [{ context: "build", app_id: 15368 }, { context: CONSOLE_CHECK, app_id: 1234567 }];
      return Promise.resolve({ protected: true, protection: { required_status_checks: { enforcement_level: "everyone", checks } } });
    }
    if (path.startsWith("/repos/acme/shop/rules/branches/main")) return Promise.resolve([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: CONSOLE_CHECK }] } }]);
    if (path.includes("/check-runs")) return Promise.resolve({ total_count: 1, check_runs: [{ name: "build", status: "completed", conclusion: "success" }] });
    if (path.includes("/statuses")) return Promise.resolve([]);
    return Promise.reject(new Error(`Unexpected REST: ${path}`));
  },
};

describe.skipIf(RELEASED_NOTES.has(NOTES))("The Console check release notes, while drafted", () => {
  const notes = read(NOTES);
  const changed = section(notes, "What changed");

  it("are listed among the drafted notes in the releasing guide, in the entry for the major the four Specs after it add their own links to", () => {
    const drafted = read("docs/releasing.md")
      .split("\n")
      .find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`"));
    expect(drafted).toContain("the Operator sessions major's are [the Console check](release-notes/console-check.md)");
  });

  it("open with their title and the paste line, and name each of the six Tickets by its link", () => {
    expect(notes.split("\n")[0]).toBe("# Release notes: the Console check");
    expect(notes).toMatch(/^These are the notes of the Console check's part of the major that carries the Kit's Operator sessions \(\[Spec: The Console check: `console\.app_id`, Setup's part, and the Kit's read leaving it out\]\(https:\/\/github\.com\/jrey8343\/fabrik\/issues\/914\)\)/m);
    expect(notes).toMatch(/Paste them into the release's notes file \(see \[releasing\.md\]\(\.\.\/releasing\.md\)\), with its version and pins\.\n/);
    const line = notes.split("\n").find((text) => text.startsWith("This draft holds")) ?? "";
    for (const ticket of TICKETS) expect(line, `#${ticket}`).toContain(issue(ticket));
  });

  it("have each section the Ticket asks for, in its order, and no section to turn it on", () => {
    const headings = notes.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(
      ["Release-note line", "Why", "What changed", "For a reader of the read library", "What the Console needs", "Why a major", "Upgrading", "What does not change", "Known limits"].map((heading) => `## ${heading}`),
    );
    expect(notes).not.toContain("## To turn it on");
  });

  it("give the key, the check's name and the read's field each as the code holds them", async () => {
    const line = section(notes, "Release-note line");
    expect(line).toContain("Kit config names the Console's App in `console.app_id`, Setup requires the Console check, `Merge from the Console`, from that App, and the repo merges only from the Console");
    expect(line).toContain("hands it back as `consoleCheck`");
    expect(line).toContain("Nothing changes on a repo without the key.");

    expect(CONSOLE_CHECK).toBe("Merge from the Console");
    expect(resolveKitConfig({ config: KIT_CONFIG_KEYS["console.app_id"] ?? "" })).toMatchObject({ ok: true, config: { console: { appId: 1234567 } } });
    expect(resolveKitConfig({ config: null })).toMatchObject({ ok: true, config: { console: { appId: null } } });
    // The notes give the whole default, the Held workflows' list beside the key included.
    expect(bullet(section(notes, "For a reader of the read library"), "`KitConfig.console.appId`.")).toContain(
      "`DEFAULT_KIT_CONFIG` has `console: { appId: null, heldWorkflows: [] }`",
    );
    expect(DEFAULT_KIT_CONFIG.console).toEqual({ appId: null, heldWorkflows: [] });

    // The read leaves it out of the branch's list and the head's, and hands back the App GitHub expects it from in each place.
    const checks = await entry.readRequiredChecks(coveredRepo, "acme/shop", ["a".repeat(40)], "2026-11-25T09:00:00Z");
    expect(checks).toMatchObject({ required: ["build"], heads: { ["a".repeat(40)]: [{ name: "build" }] }, consoleCheck: { is: "required", apps: [1234567, null] } });
  });

  it("say the Review's wait skips the Console check, whatever it reported, and Setup's merge ask follows the key", () => {
    expect(bullet(changed, "The Review's wait skips it")).toContain("whatever it reported, so a failed or running one neither holds the wait nor is among the red checks it re-runs");
    const printed = JSON.stringify([{ name: "build", bucket: "pass" }, { name: CONSOLE_CHECK, bucket: "fail" }]);
    expect(checksFromGh({ stdout: printed, stderr: "", failed: true })).toEqual([{ name: "build", bucket: "pass" }]);

    expect(bullet(changed, "Setup's merge ask follows the key")).toContain("say to merge it from the Console once its Required checks pass");
    const summary = { done: [], notes: [], blockers: [], report: [] };
    expect(prBody({ release: "v9.0.0", defaultBranch: "main", summary: { ...summary, mergesFromConsole: true } })).toContain("Merge this PR from the Console once its Required checks pass.");
    expect(prBody({ release: "v9.0.0", defaultBranch: "main", summary })).toContain("Merge this PR yourself once its Required checks pass.");
  });

  it("say the part is in one major, and why, in the releasing guide's terms", () => {
    const why = section(notes, "Why a major");
    expect(why).toContain(`The release is one major with the four other parts of the Kit's Operator sessions ([How are the Specs cut, and who builds them?](https://github.com/jrey8343/fabrik/issues/874))`);
    expect(why).toContain("[Choosing the version](../releasing.md#choosing-the-version)");
    expect(why).toContain("this part's new Kit config field and new exports alone would be a minor");
    expect(why).toContain("`required` and every head's list leaving out a check the branch requires is a change in what an export gives");
    // The guide's own terms, which the section answers to.
    const guide = read("docs/releasing.md");
    expect(guide).toContain("a release that removes anything the read library exports, or changes what one means, is a major, whatever it asks of a Product repo. A new export, a new field or a new Standing name is not.");
  });

  it("say a repo without the key needs nothing from it beyond Setup at the major, and when a repo is given the key", () => {
    const upgrading = section(notes, "Upgrading");
    expect(bullet(upgrading, "A Product repo runs Setup at the major")).toContain("without the key nothing of this part changes, and a first setup is unchanged");
    expect(bullet(upgrading, "The key comes later, repo by repo.")).toContain("only once the Console can pass a head there");
    expect(upgrading).toContain("Kit bumps and Setup's own pull requests merge from the Console on a covered repo like any other.");
  });

  it("say the Console's line is a guess until the release's check of the Console, whose run replaces it", () => {
    const console = section(notes, "What the Console needs");
    expect(console).toContain("`consoleCheck` filled wherever it builds a `RequiredChecksRead`");
    expect(console).toContain("before any Product repo is given the key");
    expect(console).toContain("This line is a guess until the release is checked against the Console (step 4 of [releasing.md](../releasing.md)), and that run's answer replaces it.");
    expect(read("docs/releasing.md")).toContain("A line about the Console in a draft in `docs/release-notes/` was written when the part was built, so it is a guess until this run.");
  });

  it("give the known limits the six Tickets leave", () => {
    const limits = section(notes, "Known limits");
    expect(bullet(limits, "Setup can't tell whether the Console is ready.")).toContain("by-hand way past");
    expect(bullet(limits, "Setup never removes the check.")).toContain("merge it yourself");
    expect(bullet(limits, "Not tried on GitHub.")).toContain("Setup's PUT with an App beside a check");
  });

  describe("name only what the six Tickets shipped, by the name the code holds it under", () => {
    const exported = [...Object.keys(EXPORT_CALLS), ...Object.keys(EXPORT_SHAPES)];
    /** Everything the notes write as code, each once. */
    const written = [...new Set([...notes.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""))];

    it("give as new exactly the exports the six added, each one the read library's entry and its exports fixture hold", () => {
      const added = bullet(section(notes, "For a reader of the read library"), "New exports.");
      const named = [...new Set([...added.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""))].filter((name) => !HELD_IN[name] && name !== "src/read/index.ts");

      expect(named.toSorted()).toEqual(NEW_EXPORTS.toSorted());
      expect(NEW_EXPORTS.filter((name) => !exported.includes(name))).toEqual([]);
      expect(entry.CONSOLE_CHECK).toBe(CONSOLE_CHECK);
      expect(read("src/read/index.ts")).toContain("export type { ConsoleCheckRead,");
    });

    it("write as code only an export of the entry, a file that exists, a Kit config key that resolves, or a name the code holds", () => {
      const held = (name: string) => {
        const [file, text] = HELD_IN[name] ?? [];
        return file !== undefined && text !== undefined && read(file).includes(text);
      };
      const resolves = (name: string) => KIT_CONFIG_KEYS[name] !== undefined && resolveKitConfig({ config: KIT_CONFIG_KEYS[name] ?? "" }).ok;
      const unknown = written.filter((name) => !exported.includes(name) && !(name.startsWith("src/") && existsSync(join(KIT, name))) && !resolves(name) && !held(name));

      expect(unknown).toEqual([]);
    });

    it("say Required check and Console check, never the old term", () => {
      expect(notes).not.toMatch(/gating/i);
    });

    it("name no person and no private repo", () => {
      expect(notes).not.toMatch(/gradually|jrey(?!8343\/fabrik)/i);
    });
  });
});
