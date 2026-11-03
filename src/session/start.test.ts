import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aKitCheckout, aSkillsArchive, LOCKED_SHA, serving, tempDir } from "../__fixtures__/skillsArchive.ts";
import { sessionStart } from "./start.ts";

const callerAt = (release: string) => `jobs:
  loop:
    uses: jrey8343/fabrik/.github/workflows/loop.yml@${release}
  tick:
    uses: jrey8343/fabrik/.github/workflows/schedule.yml@${release}
`;

async function aProduct(caller: string | null): Promise<string> {
  const product = await tempDir("product");
  if (caller !== null) {
    await mkdir(join(product, ".github/workflows"), { recursive: true });
    await writeFile(join(product, ".github/workflows/fabrik.yml"), caller);
  }
  return product;
}

const kitWithLiveSkill = () =>
  aKitCheckout(LOCKED_SHA, { "skills/fabrik-live-design/SKILL.md": "---\nname: fabrik-live-design\n---\n# Live" });

describe("The SessionStart hook in a cloud or local session", () => {
  it("installs the skills the pinned release locks, the same SHA Actions installs, and asks Claude Code to reload them", async () => {
    const kit = await kitWithLiveSkill();
    const product = await aProduct(callerAt("v1.2.3"));
    const { urls, download } = serving(await aSkillsArchive({ "skills/engineering/grilling": "# grilling" }));

    const output = await sessionStart({ kitDir: kit, productDir: product, release: "v1.2.3", download });

    expect(urls).toEqual([`https://codeload.github.com/mattpocock/skills/tar.gz/${LOCKED_SHA}`]);
    expect(await readFile(join(product, ".claude/skills/grilling/SKILL.md"), "utf8")).toBe("# grilling");
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput.reloadSkills).toBe(true);
    expect(output.hookSpecificOutput.additionalContext).toContain(`Fabrik v1.2.3`);
    expect(output.hookSpecificOutput.additionalContext).toContain(LOCKED_SHA);
    expect(output.systemMessage).toBeUndefined();
  });

  it("installs Fabrik's own live Design session skill beside them, and tells Claude how to start one", async () => {
    const kit = await kitWithLiveSkill();
    const product = await aProduct(callerAt("v1.2.3"));

    const output = await sessionStart({
      kitDir: kit,
      productDir: product,
      release: "v1.2.3",
      download: serving(await aSkillsArchive()).download,
    });

    expect(await readFile(join(product, ".claude/skills/fabrik-live-design/SKILL.md"), "utf8")).toContain("# Live");
    expect(output.hookSpecificOutput.additionalContext).toContain("/fabrik-live-design");
  });

  it("installs Fabrik's Pairing session skill too, and tells Claude how the Operator starts one", async () => {
    const kit = await aKitCheckout(LOCKED_SHA, {
      "skills/fabrik-live-design/SKILL.md": "---\nname: fabrik-live-design\n---\n# Live",
      "skills/fabrik-pair/SKILL.md": "---\nname: fabrik-pair\n---\n# Pair",
    });
    const product = await aProduct(callerAt("v1.2.3"));

    const output = await sessionStart({
      kitDir: kit,
      productDir: product,
      release: "v1.2.3",
      download: serving(await aSkillsArchive()).download,
    });

    expect(await readFile(join(product, ".claude/skills/fabrik-pair/SKILL.md"), "utf8")).toContain("# Pair");
    expect(output.hookSpecificOutput.additionalContext).toContain("/fabrik-pair <issue number>");
  });

  it("doesn't mention the Pairing session skill when the release has none", async () => {
    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: await aProduct(callerAt("v1.2.3")),
      release: "v1.2.3",
      download: serving(await aSkillsArchive()).download,
    });

    expect(output.hookSpecificOutput.additionalContext).not.toContain("/fabrik-pair");
  });

  it("still reloads skills when the right ones were already installed", async () => {
    const kit = await kitWithLiveSkill();
    const product = await aProduct(callerAt("v1.2.3"));
    await sessionStart({ kitDir: kit, productDir: product, release: "v1.2.3", download: serving(await aSkillsArchive()).download });

    const output = await sessionStart({
      kitDir: kit,
      productDir: product,
      release: "v1.2.3",
      download: serving(await aSkillsArchive()).download,
    });

    expect(output.hookSpecificOutput.reloadSkills).toBe(true);
  });

  it("installs nothing and warns when the caller workflow pins a different release from the Kit it fetched", async () => {
    const kit = await kitWithLiveSkill();
    const product = await aProduct(callerAt("v1.2.4"));
    const { urls, download } = serving(await aSkillsArchive());

    const output = await sessionStart({ kitDir: kit, productDir: product, release: "v1.2.3", download });

    expect(urls).toEqual([]);
    expect(output.hookSpecificOutput.reloadSkills).toBe(false);
    expect(output.systemMessage).toBe(
      "Fabrik didn't install its skills: the hook fetched Fabrik v1.2.3, but .github/workflows/fabrik.yml pins v1.2.4",
    );
  });

  it("installs nothing and warns when the caller workflow's pins disagree", async () => {
    const kit = await kitWithLiveSkill();
    const product = await aProduct(
      "jobs:\n  a:\n    uses: jrey8343/fabrik/.github/workflows/loop.yml@v1.2.3\n  b:\n    uses: jrey8343/fabrik/.github/workflows/schedule.yml@v1.2.4\n",
    );

    const output = await sessionStart({
      kitDir: kit,
      productDir: product,
      release: "v1.2.3",
      download: serving(await aSkillsArchive()).download,
    });

    expect(output.systemMessage).toBe(
      "Fabrik didn't install its skills: .github/workflows/fabrik.yml: The caller workflow pins more than one Fabrik release (v1.2.3, v1.2.4); every uses: line must pin the same one",
    );
  });

  it("installs nothing and warns when the repo has no caller workflow", async () => {
    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: await aProduct(null),
      release: "v1.2.3",
      download: serving(await aSkillsArchive()).download,
    });

    expect(output.systemMessage).toBe(
      "Fabrik didn't install its skills: .github/workflows/fabrik.yml was not found",
    );
  });

  it("warns rather than throwing when the download fails", async () => {
    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: await aProduct(callerAt("v1.2.3")),
      release: "v1.2.3",
      download: async (url) => {
        throw new Error(`Downloading ${url} failed: 503`);
      },
    });

    expect(output.hookSpecificOutput.reloadSkills).toBe(false);
    expect(output.systemMessage).toBe(
      `Fabrik didn't install its skills: Downloading https://codeload.github.com/mattpocock/skills/tar.gz/${LOCKED_SHA} failed: 503`,
    );
  });
});
