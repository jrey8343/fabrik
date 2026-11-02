import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aKitCheckout, aSkillsArchive, LOCKED_SHA, serving, tempDir } from "../__fixtures__/skillsArchive.ts";
import { fetchSkills } from "./fetch.ts";

describe("Fetching the pinned skills", () => {
  it("downloads the skills at the SHA the Kit's lockfile pins, and installs them flattened into .claude/skills", async () => {
    const kit = await aKitCheckout();
    const product = await tempDir("product");
    const { urls, download } = serving(await aSkillsArchive({ "skills/engineering/tdd": "# tdd" }));

    const installed = await fetchSkills(kit, product, download);

    expect(urls).toEqual([`https://codeload.github.com/mattpocock/skills/tar.gz/${LOCKED_SHA}`]);
    expect(installed).toEqual({ sha: LOCKED_SHA, skills: ["tdd"], fetched: true });
    expect(await readFile(join(product, ".claude/skills/tdd/SKILL.md"), "utf8")).toBe("# tdd");
    expect(await readFile(join(product, ".claude/skills/.fabrik-skills-sha"), "utf8")).toBe(`${LOCKED_SHA}\n`);
  });

  it("skips the download when the skills at that SHA are already installed", async () => {
    const kit = await aKitCheckout();
    const product = await tempDir("product");
    await fetchSkills(kit, product, serving(await aSkillsArchive()).download);
    const again = serving(await aSkillsArchive());

    const installed = await fetchSkills(kit, product, again.download);

    expect(again.urls).toEqual([]);
    expect(installed).toEqual({ sha: LOCKED_SHA, skills: [], fetched: false });
  });

  it("downloads again when the Kit pins a different SHA from the one installed", async () => {
    const product = await tempDir("product");
    await fetchSkills(await aKitCheckout(), product, serving(await aSkillsArchive()).download);
    const bumped = "0123456789abcdef0123456789abcdef01234567";
    const { urls, download } = serving(await aSkillsArchive());

    await fetchSkills(await aKitCheckout(bumped), product, download);

    expect(urls).toEqual([`https://codeload.github.com/mattpocock/skills/tar.gz/${bumped}`]);
    expect(await readFile(join(product, ".claude/skills/.fabrik-skills-sha"), "utf8")).toBe(`${bumped}\n`);
  });
});
