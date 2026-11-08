import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
import type { Download } from "../skills/fetch.ts";
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

  it("installs the release's Visual evidence skill, and tells Claude how the Operator turns Visual evidence on", async () => {
    const kit = resolve(import.meta.dirname, "..", "..");
    const product = await aProduct(callerAt("v1.2.3"));

    const output = await sessionStart({ kitDir: kit, productDir: product, release: "v1.2.3", download: serving(await aSkillsArchive()).download });

    expect(await readFile(join(product, ".claude/skills/fabrik-visual-evidence/SKILL.md"), "utf8")).toBe(
      await readFile(join(kit, "skills/fabrik-visual-evidence/SKILL.md"), "utf8"),
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "To turn Visual evidence on, or change its answers, the Operator runs /fabrik-visual-evidence.",
    );
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

const OPERATOR_SKILLS = "jrey8343/skills";
const OPERATOR_SHA = "1111111111111111111111111111111111111111";
const OTHER_SKILLS = "someone/skills";
const OTHER_SHA = "2222222222222222222222222222222222222222";
const BASE_URL = archiveUrl("mattpocock/skills", LOCKED_SHA);
const OPERATOR_URL = archiveUrl(OPERATOR_SKILLS, OPERATOR_SHA);
const OTHER_URL = archiveUrl(OTHER_SKILLS, OTHER_SHA);
const PINS = [
  { repository: OPERATOR_SKILLS, sha: OPERATOR_SHA },
  { repository: OTHER_SKILLS, sha: OTHER_SHA },
];

async function upstream() {
  return {
    [BASE_URL]: await aSkillsArchive({ "skills/engineering/grilling": "# grilling" }),
    [OPERATOR_URL]: await aSkillsArchive({
      "skills/modelling/event-storming": "# event-storming",
      "skills/modelling/deciders": "# deciders",
    }),
    [OTHER_URL]: await aSkillsArchive({ "skills/review/threat-model": "# threat-model" }),
  };
}

/** A Product checkout with its caller workflow, pinning these sources and picking these Extra skills. */
async function aProductWithPicks(
  pins: Parameters<typeof aProductCheckout>[0],
  picks: Parameters<typeof aProductCheckout>[1],
): Promise<string> {
  const product = await aProductCheckout(pins, picks);
  await mkdir(join(product, ".github/workflows"), { recursive: true });
  await writeFile(join(product, ".github/workflows/fabrik.yml"), callerAt("v1.2.3"));
  return product;
}

async function installedFolders(product: string): Promise<readonly string[]> {
  const entries = await readdir(join(product, ".claude/skills"), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

describe("The SessionStart hook with Extra skills picked, the Operator at the wheel", () => {
  it("installs every pick across all roles beside the Base and Kit skills, and names the Extra skills in its context", async () => {
    const product = await aProductWithPicks(PINS, {
      triage: ["jrey8343/skills/deciders"],
      design: ["jrey8343/skills/event-storming"],
      review: ["someone/skills/threat-model", "jrey8343/skills/event-storming"],
    });

    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: product,
      release: "v1.2.3",
      download: servingEach(await upstream()).download,
    });

    expect(await installedFolders(product)).toEqual([
      "deciders",
      "event-storming",
      "fabrik-live-design",
      "grilling",
      "threat-model",
    ]);
    expect(output.systemMessage).toBeUndefined();
    expect(output.hookSpecificOutput.reloadSkills).toBe(true);
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "This repo's Extra skills are also in .claude/skills/: deciders, event-storming, threat-model.",
    );
  });

  it("warns with the reason when a pick names a skill its source doesn't have, and still installs the Base and Kit skills", async () => {
    const product = await aProductWithPicks([{ repository: OPERATOR_SKILLS, sha: OPERATOR_SHA }], {
      design: ["jrey8343/skills/event-storming", "jrey8343/skills/no-such-skill"],
    });

    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: product,
      release: "v1.2.3",
      download: servingEach(await upstream()).download,
    });

    expect(await installedFolders(product)).toEqual(["fabrik-live-design", "grilling"]);
    expect(output.hookSpecificOutput.reloadSkills).toBe(true);
    expect(output.systemMessage).toMatch(/^Fabrik installed its Base and Kit skills, but not this repo's Extra skills: .*no-such-skill/);
    expect(output.hookSpecificOutput.additionalContext).not.toContain("Extra skills are also in");
  });

  it("warns with the reason when the Kit config's picks are invalid, and still installs the Base and Kit skills", async () => {
    const product = await aProductWithPicks([], { design: ["jrey8343/skills/event-storming"] });

    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: product,
      release: "v1.2.3",
      download: servingEach(await upstream()).download,
    });

    expect(await installedFolders(product)).toEqual(["fabrik-live-design", "grilling"]);
    expect(output.systemMessage).toMatch(/^Fabrik installed its Base and Kit skills, but not this repo's Extra skills: .*roles\.design\.skills\[0\]/);
  });

  it("warns when an Extra skills source can't be downloaded, and still installs the Base and Kit skills", async () => {
    const product = await aProductWithPicks(PINS, {
      design: ["jrey8343/skills/event-storming"],
      review: ["someone/skills/threat-model"],
    });
    const { [OTHER_URL]: _unreachable, ...reachable } = await upstream();

    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: product,
      release: "v1.2.3",
      download: servingEach(reachable).download,
    });

    expect(await installedFolders(product)).toEqual(["fabrik-live-design", "grilling"]);
    expect(output.hookSpecificOutput.reloadSkills).toBe(true);
    expect(output.systemMessage).toBe(
      `Fabrik installed its Base and Kit skills, but not this repo's Extra skills: someone/skills at 2222222 could not be downloaded: Downloading ${OTHER_URL} failed: 404`,
    );
  });

  it("says nothing of Extra skills when the repo picks none and its Kit config is invalid for another reason", async () => {
    const product = await aProductWithPicks([], {});
    await writeFile(join(product, ".fabrik/config.json"), JSON.stringify({ roles: { design: { model: "best" } } }));

    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: product,
      release: "v1.2.3",
      download: servingEach(await upstream()).download,
    });

    expect(await installedFolders(product)).toEqual(["fabrik-live-design", "grilling"]);
    expect(output.systemMessage).toBeUndefined();
  });

  it("downloads nothing at a second session start when the pins and picks haven't changed", async () => {
    const kit = await kitWithLiveSkill();
    const product = await aProductWithPicks(PINS, {
      design: ["jrey8343/skills/event-storming"],
      review: ["someone/skills/threat-model"],
    });
    const start = async (download: Download) =>
      sessionStart({ kitDir: kit, productDir: product, release: "v1.2.3", download });
    await start(servingEach(await upstream()).download);
    const again = servingEach(await upstream());

    const output = await start(again.download);

    expect(again.urls).toEqual([]);
    expect(output.systemMessage).toBeUndefined();
    expect(output.hookSpecificOutput.additionalContext).toContain("event-storming, threat-model");
  });

  it("removes a dropped pick at the next session start, and leaves a folder the Kit didn't install", async () => {
    const kit = await kitWithLiveSkill();
    const product = await aProductWithPicks(PINS, {
      design: ["jrey8343/skills/event-storming", "jrey8343/skills/deciders"],
      review: ["someone/skills/threat-model"],
    });
    await sessionStart({
      kitDir: kit,
      productDir: product,
      release: "v1.2.3",
      download: servingEach(await upstream()).download,
    });
    await mkdir(join(product, ".claude/skills/my-own-skill"));
    await writeFile(
      join(product, ".fabrik/config.json"),
      JSON.stringify({ roles: { design: { skills: ["jrey8343/skills/event-storming"] } } }),
    );
    await writeFile(join(product, ".fabrik/skills.lock.json"), JSON.stringify([PINS[0]]));

    const output = await sessionStart({
      kitDir: kit,
      productDir: product,
      release: "v1.2.3",
      download: servingEach(await upstream()).download,
    });

    expect(output.systemMessage).toBeUndefined();
    expect(await installedFolders(product)).toEqual(["event-storming", "fabrik-live-design", "grilling", "my-own-skill"]);
  });

  it("leaves its context as it was when the repo picks no Extra skills", async () => {
    const product = await aProductWithPicks([], {});

    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: product,
      release: "v1.2.3",
      download: servingEach(await upstream()).download,
    });

    expect(output.systemMessage).toBeUndefined();
    expect(output.hookSpecificOutput.additionalContext).toBe(
      `Fabrik v1.2.3 is installed in this repo. The skills it pins (mattpocock/skills at ${LOCKED_SHA}) are in .claude/skills/, fetched by the SessionStart hook; they're gitignored, so never commit or edit them.\n` +
        "To take an issue's Design session live, the Operator runs /fabrik-live-design <issue number>.",
    );
  });
});

describe("The SessionStart hook, now Setup is no longer a skill", () => {
  /** The Operator's personal skills folder, holding an old copy of the fabrik-setup skill. */
  async function personalSkillsWithAnOldCopy(): Promise<{ personalSkills: string; copy: string }> {
    const personalSkills = await tempDir("personal-skills");
    const copy = join(personalSkills, "fabrik-setup");
    await mkdir(copy);
    await writeFile(join(copy, "SKILL.md"), "---\nname: fabrik-setup\n---\n# Fabrik setup\n");
    return { personalSkills, copy };
  }

  const warning = (copy: string) =>
    `${copy} is an out-of-date copy of the fabrik-setup skill, which Setup no longer uses. It's stale: delete it with rm -rf '${copy}'.`;

  it("warns the Operator in one line while an old personal copy of the setup skill is there, and still installs every skill", async () => {
    const { personalSkills, copy } = await personalSkillsWithAnOldCopy();
    const product = await aProduct(callerAt("v1.2.3"));

    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: product,
      release: "v1.2.3",
      download: serving(await aSkillsArchive({ "skills/engineering/grilling": "# grilling" })).download,
      personalSkills,
    });

    expect(output.systemMessage).toBe(warning(copy));
    expect(await installedFolders(product)).toEqual(["fabrik-live-design", "grilling"]);
    expect(output.hookSpecificOutput.reloadSkills).toBe(true);
    expect(await readdir(personalSkills)).toEqual(["fabrik-setup"]);
  });

  it("puts the warning after a wrong Extra skill pick's, in the same message", async () => {
    const { personalSkills, copy } = await personalSkillsWithAnOldCopy();
    const product = await aProductWithPicks([{ repository: OPERATOR_SKILLS, sha: OPERATOR_SHA }], { design: ["jrey8343/skills/no-such-skill"] });

    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: product,
      release: "v1.2.3",
      download: servingEach(await upstream()).download,
      personalSkills,
    });

    expect(output.systemMessage).toMatch(/^Fabrik installed its Base and Kit skills, but not this repo's Extra skills: .*no-such-skill.*\. \//);
    expect(output.systemMessage?.endsWith(warning(copy))).toBe(true);
    expect(await installedFolders(product)).toEqual(["fabrik-live-design", "grilling"]);
  });

  it("warns about it too when it can't install the skills", async () => {
    const { personalSkills, copy } = await personalSkillsWithAnOldCopy();

    const output = await sessionStart({ kitDir: await kitWithLiveSkill(), productDir: await aProduct(null), release: "v1.2.3", personalSkills });

    expect(output.systemMessage).toBe(`Fabrik didn't install its skills: .github/workflows/fabrik.yml was not found. ${warning(copy)}`);
  });

  it("says nothing more when the personal skills hold no copy of it", async () => {
    const personalSkills = await tempDir("personal-skills");
    await mkdir(join(personalSkills, "grilling"));

    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: await aProduct(callerAt("v1.2.3")),
      release: "v1.2.3",
      download: serving(await aSkillsArchive()).download,
      personalSkills,
    });

    expect(output.systemMessage).toBeUndefined();
  });

  it("removes the fabrik-setup skill an earlier release installed in the repo", async () => {
    const product = await aProduct(callerAt("v1.2.3"));
    await mkdir(join(product, ".claude/skills/fabrik-setup"), { recursive: true });
    await writeFile(join(product, ".claude/skills/fabrik-setup/SKILL.md"), "---\nname: fabrik-setup\n---\n# Fabrik setup\n");

    await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: product,
      release: "v1.2.3",
      download: serving(await aSkillsArchive({ "skills/engineering/grilling": "# grilling" })).download,
    });

    expect(await installedFolders(product)).toEqual(["fabrik-live-design", "grilling"]);
  });

  it("keeps an Extra skill the repo picks under that name", async () => {
    const product = await aProductWithPicks([{ repository: OPERATOR_SKILLS, sha: OPERATOR_SHA }], { design: ["jrey8343/skills/fabrik-setup"] });

    await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: product,
      release: "v1.2.3",
      download: servingEach({
        [BASE_URL]: await aSkillsArchive({ "skills/engineering/grilling": "# grilling" }),
        [OPERATOR_URL]: await aSkillsArchive({ "skills/setup/fabrik-setup": "# the repo's own" }),
      }).download,
    });

    expect(await readFile(join(product, ".claude/skills/fabrik-setup/SKILL.md"), "utf8")).toBe("# the repo's own");
  });
});
