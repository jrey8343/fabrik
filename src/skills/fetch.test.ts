import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aKitCheckout,
  aProductCheckout,
  archiveUrl,
  aSkillsArchive,
  LOCKED_SHA,
  serving,
  servingEach,
  tempDir,
} from "../__fixtures__/skillsArchive.ts";
import { fetchSkills, readInstallRecord } from "./fetch.ts";

describe("Fetching the pinned skills", () => {
  it("downloads the skills at the SHA the Kit's lockfile pins, and installs them flattened into .claude/skills", async () => {
    const kit = await aKitCheckout();
    const product = await tempDir("product");
    const { urls, download } = serving(await aSkillsArchive({ "skills/engineering/tdd": "# tdd" }));

    const installed = await fetchSkills(kit, product, download);

    expect(urls).toEqual([`https://codeload.github.com/mattpocock/skills/tar.gz/${LOCKED_SHA}`]);
    expect(installed).toEqual({ sha: LOCKED_SHA, skills: ["tdd"], fetched: true, extraSkills: [], errors: [] });
    expect(await readFile(join(product, ".claude/skills/tdd/SKILL.md"), "utf8")).toBe("# tdd");
    expect(await readInstallRecord(product)).toEqual([
      { repository: "mattpocock/skills", sha: LOCKED_SHA, skills: ["tdd"] },
    ]);
  });

  it("records every skill it installed from the source, and leaves no single-SHA marker", async () => {
    const product = await tempDir("product");
    const archive = await aSkillsArchive({ "skills/engineering/tdd": "# tdd", "skills/productivity/grilling": "# grilling" });

    await fetchSkills(await aKitCheckout(), product, serving(archive).download);

    expect(await readInstallRecord(product)).toEqual([
      { repository: "mattpocock/skills", sha: LOCKED_SHA, skills: ["tdd", "grilling"] },
    ]);
    await expect(readFile(join(product, ".claude/skills/.fabrik-skills-sha"), "utf8")).rejects.toThrow();
  });

  it("finds no install record in a checkout the fetch never installed into", async () => {
    expect(await readInstallRecord(await tempDir("product"))).toBeUndefined();
  });

  it("skips the download when the skills at that SHA are already installed", async () => {
    const kit = await aKitCheckout();
    const product = await tempDir("product");
    await fetchSkills(kit, product, serving(await aSkillsArchive()).download);
    const again = serving(await aSkillsArchive());

    const installed = await fetchSkills(kit, product, again.download);

    expect(again.urls).toEqual([]);
    expect(installed).toEqual({ sha: LOCKED_SHA, skills: [], fetched: false, extraSkills: [], errors: [] });
  });

  it.each(["../../src", "..", "nested/tdd", ""])(
    "treats an install record naming %j as unreadable, so it never removes a folder outside .claude/skills",
    async (name) => {
      const product = await tempDir("product");
      await mkdir(join(product, "src"), { recursive: true });
      await writeFile(join(product, "src/app.ts"), "export {};\n");
      await mkdir(join(product, ".claude/skills"), { recursive: true });
      await writeFile(
        join(product, ".claude/skills/.fabrik-install.json"),
        JSON.stringify([{ repository: "mattpocock/skills", sha: LOCKED_SHA, skills: [name] }]),
      );

      expect(await readInstallRecord(product)).toBeUndefined();
      await fetchSkills(await aKitCheckout(), product, serving(await aSkillsArchive()).download);

      expect(await readFile(join(product, "src/app.ts"), "utf8")).toBe("export {};\n");
      expect(await readInstallRecord(product)).toEqual([{ repository: "mattpocock/skills", sha: LOCKED_SHA, skills: ["tdd"] }]);
    },
  );

  it("downloads again when the Kit pins a different SHA from the one installed", async () => {
    const product = await tempDir("product");
    await fetchSkills(await aKitCheckout(), product, serving(await aSkillsArchive()).download);
    const bumped = "0123456789abcdef0123456789abcdef01234567";
    const { urls, download } = serving(await aSkillsArchive());

    await fetchSkills(await aKitCheckout(bumped), product, download);

    expect(urls).toEqual([`https://codeload.github.com/mattpocock/skills/tar.gz/${bumped}`]);
    expect(await readInstallRecord(product)).toEqual([{ repository: "mattpocock/skills", sha: bumped, skills: ["tdd"] }]);
  });
});

const OPERATOR_SKILLS = "jrey8343/skills";
const OPERATOR_SHA = "1111111111111111111111111111111111111111";
const OTHER_SKILLS = "someone/skills";
const OTHER_SHA = "2222222222222222222222222222222222222222";
const BASE_URL = archiveUrl("mattpocock/skills", LOCKED_SHA);
const OPERATOR_URL = archiveUrl(OPERATOR_SKILLS, OPERATOR_SHA);
const OTHER_URL = archiveUrl(OTHER_SKILLS, OTHER_SHA);

async function cpDir(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, verbatimSymlinks: true });
}

async function installedFolders(product: string): Promise<readonly string[]> {
  const entries = await readdir(join(product, ".claude/skills"), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function upstream() {
  return {
    [BASE_URL]: await aSkillsArchive({ "skills/engineering/tdd": "# tdd" }),
    [OPERATOR_URL]: await aSkillsArchive({
      "skills/modelling/event-storming": "# event-storming",
      "skills/modelling/deciders": "# deciders",
      "skills/misc/unpicked": "# unpicked",
    }),
    [OTHER_URL]: await aSkillsArchive({ "skills/review/threat-model": "# threat-model" }),
  };
}

const PINS = [
  { repository: OPERATOR_SKILLS, sha: OPERATOR_SHA },
  { repository: OTHER_SKILLS, sha: OTHER_SHA },
];

describe("Installing a Product repo's Extra skills", () => {
  it("installs the Base skills and only one role's Extra skills when asked for that role", async () => {
    const product = await aProductCheckout(PINS, {
      design: ["jrey8343/skills/event-storming"],
      implement: ["jrey8343/skills/deciders"],
      review: ["someone/skills/threat-model"],
    });
    const { download } = servingEach(await upstream());

    const installed = await fetchSkills(await aKitCheckout(), product, download, { install: "implement" });

    expect(installed.errors).toEqual([]);
    expect(await installedFolders(product)).toEqual(["deciders", "tdd"]);
    expect(await readFile(join(product, ".claude/skills/deciders/SKILL.md"), "utf8")).toBe("# deciders");
    expect(await readInstallRecord(product)).toEqual([
      { repository: "mattpocock/skills", sha: LOCKED_SHA, skills: ["tdd"] },
      { repository: OPERATOR_SKILLS, sha: OPERATOR_SHA, skills: ["deciders"] },
    ]);
  });

  // ADR-0008: only triage, design, implement and review take picks.
  it.each([
    ["an Auditor", "audit"],
    ["a Retro", "retro"],
    ["a Researcher", "research"],
    ["a Digest", "digest"],
  ] as const)("installs only the Base skills for %s run, and downloads no Skills source, whatever the roles pick", async (_run, role) => {
    const product = await aProductCheckout(PINS, {
      design: ["jrey8343/skills/event-storming"],
      implement: ["jrey8343/skills/deciders"],
      review: ["someone/skills/threat-model"],
    });
    const { urls, download } = servingEach(await upstream());

    const installed = await fetchSkills(await aKitCheckout(), product, download, { install: role });

    expect(installed).toMatchObject({ skills: ["tdd"], extraSkills: [], errors: [] });
    expect(urls).toEqual([BASE_URL]);
    expect(await installedFolders(product)).toEqual(["tdd"]);
    expect(await readInstallRecord(product)).toEqual([{ repository: "mattpocock/skills", sha: LOCKED_SHA, skills: ["tdd"] }]);
  });

  it("installs every role's Extra skills, each once, when asked for every pick", async () => {
    const product = await aProductCheckout(PINS, {
      design: ["jrey8343/skills/event-storming"],
      implement: ["jrey8343/skills/deciders"],
      review: ["someone/skills/threat-model", "jrey8343/skills/event-storming"],
    });
    const { download } = servingEach(await upstream());

    const installed = await fetchSkills(await aKitCheckout(), product, download, { install: "every" });

    expect(installed.extraSkills).toEqual(["event-storming", "deciders", "threat-model"]);
    expect(await installedFolders(product)).toEqual(["deciders", "event-storming", "tdd", "threat-model"]);
    expect(await readInstallRecord(product)).toEqual([
      { repository: "mattpocock/skills", sha: LOCKED_SHA, skills: ["tdd"] },
      { repository: OPERATOR_SKILLS, sha: OPERATOR_SHA, skills: ["event-storming", "deciders"] },
      { repository: OTHER_SKILLS, sha: OTHER_SHA, skills: ["threat-model"] },
    ]);
  });

  it("downloads each needed source once, and never a source no requested pick needs", async () => {
    const product = await aProductCheckout(PINS, {
      implement: ["jrey8343/skills/deciders", "jrey8343/skills/event-storming"],
      review: ["someone/skills/threat-model"],
    });
    const { urls, download } = servingEach(await upstream());

    await fetchSkills(await aKitCheckout(), product, download, { install: "implement" });

    expect(urls).toEqual([BASE_URL, OPERATOR_URL]);
  });

  it("downloads nothing again when every source's pin and picks are unchanged since the last install", async () => {
    const kit = await aKitCheckout();
    const product = await aProductCheckout(PINS, {
      design: ["jrey8343/skills/event-storming"],
      review: ["someone/skills/threat-model"],
    });
    await fetchSkills(kit, product, servingEach(await upstream()).download);
    const again = servingEach(await upstream());

    const installed = await fetchSkills(kit, product, again.download);

    expect(again.urls).toEqual([]);
    expect(installed.extraSkills).toEqual(["event-storming", "threat-model"]);
    expect(await installedFolders(product)).toEqual(["event-storming", "tdd", "threat-model"]);
  });

  it("downloads only the source whose picks changed since the last install", async () => {
    const kit = await aKitCheckout();
    const picks = { design: ["jrey8343/skills/event-storming"], review: ["someone/skills/threat-model"] };
    const product = await aProductCheckout(PINS, picks);
    await fetchSkills(kit, product, servingEach(await upstream()).download);
    const repicked = await aProductCheckout(PINS, { ...picks, implement: ["jrey8343/skills/deciders"] });
    await cpDir(join(product, ".claude"), join(repicked, ".claude"));
    const again = servingEach(await upstream());

    await fetchSkills(kit, repicked, again.download);

    expect(again.urls).toEqual([OPERATOR_URL]);
    expect(await installedFolders(repicked)).toEqual(["deciders", "event-storming", "tdd", "threat-model"]);
  });

  it("removes an Extra skill it installed earlier that is no longer picked, and never a folder it didn't install", async () => {
    const kit = await aKitCheckout();
    const before = await aProductCheckout(PINS, {
      design: ["jrey8343/skills/event-storming", "jrey8343/skills/deciders"],
      review: ["someone/skills/threat-model"],
    });
    await fetchSkills(kit, before, servingEach(await upstream()).download);
    await mkdir(join(before, ".claude/skills/my-own-skill"));
    const after = await aProductCheckout([{ repository: OPERATOR_SKILLS, sha: OPERATOR_SHA }], {
      design: ["jrey8343/skills/event-storming"],
    });
    await cpDir(join(before, ".claude"), join(after, ".claude"));

    await fetchSkills(kit, after, servingEach(await upstream()).download);

    expect(await installedFolders(after)).toEqual(["event-storming", "my-own-skill", "tdd"]);
    expect(await readInstallRecord(after)).toEqual([
      { repository: "mattpocock/skills", sha: LOCKED_SHA, skills: ["tdd"] },
      { repository: OPERATOR_SKILLS, sha: OPERATOR_SHA, skills: ["event-storming"] },
    ]);
  });
});

describe("The manifest check under the install", () => {
  async function installing(
    picks: Record<string, readonly string[]>,
    operatorArchive: Buffer,
    kit?: string,
  ): Promise<{ readonly product: string; readonly installed: Awaited<ReturnType<typeof fetchSkills>> }> {
    const product = await aProductCheckout([{ repository: OPERATOR_SKILLS, sha: OPERATOR_SHA }], picks);
    const { download } = servingEach({ ...(await upstream()), [OPERATOR_URL]: operatorArchive });
    const installed = await fetchSkills(kit ?? (await aKitCheckout()), product, download, { install: "every" });
    return { product, installed };
  }

  it("fails the install on a pick the source's manifest doesn't list, still installing the Base skills", async () => {
    const { product, installed } = await installing(
      { design: ["jrey8343/skills/event-storming", "jrey8343/skills/sagas"] },
      await aSkillsArchive({ "skills/modelling/event-storming": "# event-storming" }),
    );

    expect(installed.errors).toEqual([
      'roles.design.skills[1] is "jrey8343/skills/sagas": jrey8343/skills at 1111111 lists no skill named sagas in .claude-plugin/plugin.json',
    ]);
    expect(installed.extraSkills).toEqual([]);
    expect(await installedFolders(product)).toEqual(["tdd"]);
    expect(await readInstallRecord(product)).toEqual([{ repository: "mattpocock/skills", sha: LOCKED_SHA, skills: ["tdd"] }]);
  });

  it("reports no Extra skills installed when a pick fails the check and nothing else changed", async () => {
    const kit = await aKitCheckout();
    const product = await aProductCheckout([{ repository: OPERATOR_SKILLS, sha: OPERATOR_SHA }], {
      design: ["jrey8343/skills/sagas"],
    });
    await fetchSkills(kit, product, servingEach(await upstream()).download);

    const again = await fetchSkills(kit, product, servingEach(await upstream()).download);

    expect(again.errors).toHaveLength(1);
    expect(again.extraSkills).toEqual([]);
  });

  it("fails the install on a source with no manifest", async () => {
    const { product, installed } = await installing(
      { design: ["jrey8343/skills/event-storming"] },
      await aSkillsArchive({ "skills/modelling/event-storming": "# event-storming" }, { manifest: false }),
    );

    expect(installed.errors).toEqual([
      ".fabrik/skills.lock.json[0] pins jrey8343/skills at 1111111, which has no readable .claude-plugin/plugin.json listing its skills",
    ]);
    expect(await installedFolders(product)).toEqual(["tdd"]);
  });

  it("fails the install on a pick named like a Base skill, leaving the Base skill in place", async () => {
    const { product, installed } = await installing(
      { implement: ["jrey8343/skills/tdd"] },
      await aSkillsArchive({ "skills/engineering/tdd": "# the Operator's tdd" }),
    );

    expect(installed.errors).toEqual([
      'roles.implement.skills[0] is "jrey8343/skills/tdd": tdd is a Base skill, and an Extra skill can\'t replace it',
    ]);
    expect(await readFile(join(product, ".claude/skills/tdd/SKILL.md"), "utf8")).toBe("# tdd");
  });

  it("fails the install on a pick named like a Kit skill", async () => {
    const kit = await aKitCheckout(LOCKED_SHA, { "skills/fabrik-pair/SKILL.md": "# pair" });
    const { product, installed } = await installing(
      { review: ["jrey8343/skills/fabrik-pair"] },
      await aSkillsArchive({ "skills/fabrik-pair": "# the Operator's pair" }),
      kit,
    );

    expect(installed.errors).toEqual([
      'roles.review.skills[0] is "jrey8343/skills/fabrik-pair": fabrik-pair is a Kit skill, and an Extra skill can\'t replace it',
    ]);
    expect(await installedFolders(product)).toEqual(["tdd"]);
  });

  it("fails the install on a Kit config that doesn't resolve, still installing the Base skills", async () => {
    const product = await aProductCheckout([{ repository: OPERATOR_SKILLS, sha: OPERATOR_SHA }], {
      design: ["jrey8343/skills/event-storming"],
      review: ["unpinned/skills/thing"],
    });

    const installed = await fetchSkills(await aKitCheckout(), product, servingEach(await upstream()).download);

    expect(installed.errors).toEqual([
      'roles.review.skills[0] is "unpinned/skills/thing": unpinned/skills has no pin in .fabrik/skills.lock.json',
    ]);
    expect(await installedFolders(product)).toEqual(["tdd"]);
  });
});

