import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aKitCheckout,
  aProductCheckout,
  aSkillsSource,
  type SkillsSource,
  git,
  gitHubFrom,
  LOCKED_SHA,
  serving,
  servingEach,
  sourceAt,
  tempDir,
} from "../__fixtures__/skillsArchive.ts";
import { fetchSkills, readInstallRecord } from "./fetch.ts";

describe("Fetching the pinned skills", () => {
  it("fetches the skills at the SHA the Kit's lockfile pins, and installs them flattened into .claude/skills", async () => {
    const kit = await aKitCheckout();
    const product = await tempDir("product");
    const { fetched, fetchSource } = serving(await aSkillsSource({ "skills/engineering/tdd": "# tdd" }));

    const installed = await fetchSkills(kit, product, fetchSource);

    expect(fetched).toEqual([{ repository: "mattpocock/skills", sha: LOCKED_SHA }]);
    expect(installed).toEqual({ sha: LOCKED_SHA, skills: ["tdd"], fetched: true, extraSkills: [], errors: [] });
    expect(await readFile(join(product, ".claude/skills/tdd/SKILL.md"), "utf8")).toBe("# tdd");
    expect(await readInstallRecord(product)).toEqual([
      { repository: "mattpocock/skills", sha: LOCKED_SHA, skills: ["tdd"] },
    ]);
  });

  it("records every skill it installed from the source, and leaves no single-SHA marker", async () => {
    const product = await tempDir("product");
    const source = await aSkillsSource({ "skills/engineering/tdd": "# tdd", "skills/productivity/grilling": "# grilling" });

    await fetchSkills(await aKitCheckout(), product, serving(source).fetchSource);

    expect(await readInstallRecord(product)).toEqual([
      { repository: "mattpocock/skills", sha: LOCKED_SHA, skills: ["tdd", "grilling"] },
    ]);
    await expect(readFile(join(product, ".claude/skills/.fabrik-skills-sha"), "utf8")).rejects.toThrow();
  });

  it("finds no install record in a checkout the fetch never installed into", async () => {
    expect(await readInstallRecord(await tempDir("product"))).toBeUndefined();
  });

  it("skips the fetch when the skills at that SHA are already installed", async () => {
    const kit = await aKitCheckout();
    const product = await tempDir("product");
    await fetchSkills(kit, product, serving(await aSkillsSource()).fetchSource);
    const again = serving(await aSkillsSource());

    const installed = await fetchSkills(kit, product, again.fetchSource);

    expect(again.fetched).toEqual([]);
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
      await fetchSkills(await aKitCheckout(), product, serving(await aSkillsSource()).fetchSource);

      expect(await readFile(join(product, "src/app.ts"), "utf8")).toBe("export {};\n");
      expect(await readInstallRecord(product)).toEqual([{ repository: "mattpocock/skills", sha: LOCKED_SHA, skills: ["tdd"] }]);
    },
  );

  it("throws, naming the Base skills' repository and commit, when they can't be fetched from github.com", async () => {
    const failing = servingEach({});

    await expect(fetchSkills(await aKitCheckout(), await tempDir("product"), failing.fetchSource)).rejects.toThrow(
      `mattpocock/skills at 4ae2317 could not be fetched from github.com: fatal: remote error: upload-pack: not our ref ${LOCKED_SHA}`,
    );
  });

  it("fetches again when the Kit pins a different SHA from the one installed", async () => {
    const product = await tempDir("product");
    await fetchSkills(await aKitCheckout(), product, serving(await aSkillsSource()).fetchSource);
    const bumped = "0123456789abcdef0123456789abcdef01234567";
    const { fetched, fetchSource } = serving(await aSkillsSource());

    await fetchSkills(await aKitCheckout(bumped), product, fetchSource);

    expect(fetched).toEqual([{ repository: "mattpocock/skills", sha: bumped }]);
    expect(await readInstallRecord(product)).toEqual([{ repository: "mattpocock/skills", sha: bumped, skills: ["tdd"] }]);
  });
});

describe("Fetching from github.com by git's own shallow fetch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A folder standing in for github.com, which git reads `https://github.com/` from for the rest of the test, logging each command it runs. */
  async function aGitHub(): Promise<{ readonly github: string; readonly trace: string }> {
    const github = await tempDir("github");
    const trace = join(await tempDir("trace"), "git.log");
    for (const [key, value] of Object.entries(gitHubFrom(github))) vi.stubEnv(key, value);
    vi.stubEnv("GIT_TRACE", trace);
    return { github, trace };
  }

  it("fetches the pinned commit, though no branch's tip names it, with --depth 1, and installs the skills it holds", async () => {
    const { github, trace } = await aGitHub();
    const upstream = join(github, "mattpocock/skills");
    const { sha } = await aSkillsSource({ "skills/engineering/tdd": "# tdd at the pin" }, { at: upstream });
    await writeFile(join(upstream, "skills/engineering/tdd/SKILL.md"), "# tdd past the pin");
    git(upstream, "commit", "-q", "-am", "Past the pin");
    const product = await tempDir("product");

    const installed = await fetchSkills(await aKitCheckout(sha), product);

    expect(installed).toEqual({ sha, skills: ["tdd"], fetched: true, extraSkills: [], errors: [] });
    expect(await readFile(join(product, ".claude/skills/tdd/SKILL.md"), "utf8")).toBe("# tdd at the pin");
    expect(await readFile(trace, "utf8")).toContain(`git fetch -q --depth 1 https://github.com/mattpocock/skills ${sha}`);
  });

  it("names a Skills source github.com doesn't hold in errors, with git's last line on stderr, and still installs the Base skills", async () => {
    const { github } = await aGitHub();
    const { sha } = await aSkillsSource({ "skills/engineering/tdd": "# tdd" }, { at: join(github, "mattpocock/skills") });
    const product = await aProductCheckout([{ repository: "someone/skills", sha: OTHER_SHA }], {
      review: ["someone/skills/threat-model"],
    });

    const installed = await fetchSkills(await aKitCheckout(sha), product);

    // git's advice under its fatal line ("Please make sure you have the correct access rights") is left out.
    expect(installed.errors).toEqual([
      "someone/skills at 2222222 could not be fetched from github.com: fatal: Could not read from remote repository.",
    ]);
    expect(await installedFolders(product)).toEqual(["tdd"]);
  });
});

const OPERATOR_SKILLS = "jrey8343/skills";
const OPERATOR_SHA = "1111111111111111111111111111111111111111";
const OTHER_SKILLS = "someone/skills";
const OTHER_SHA = "2222222222222222222222222222222222222222";
const BASE = { repository: "mattpocock/skills", sha: LOCKED_SHA };
const OPERATOR = { repository: OPERATOR_SKILLS, sha: OPERATOR_SHA };
const OTHER = { repository: OTHER_SKILLS, sha: OTHER_SHA };

async function cpDir(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, verbatimSymlinks: true });
}

async function installedFolders(product: string): Promise<readonly string[]> {
  const entries = await readdir(join(product, ".claude/skills"), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function upstream() {
  return {
    [sourceAt(BASE.repository, BASE.sha)]: await aSkillsSource({ "skills/engineering/tdd": "# tdd" }),
    [sourceAt(OPERATOR.repository, OPERATOR.sha)]: await aSkillsSource({
      "skills/modelling/event-storming": "# event-storming",
      "skills/modelling/deciders": "# deciders",
      "skills/misc/unpicked": "# unpicked",
    }),
    [sourceAt(OTHER.repository, OTHER.sha)]: await aSkillsSource({ "skills/review/threat-model": "# threat-model" }),
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
    const { fetchSource } = servingEach(await upstream());

    const installed = await fetchSkills(await aKitCheckout(), product, fetchSource, { install: "implement" });

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
  ] as const)("installs only the Base skills for %s run, and fetches no Skills source, whatever the roles pick", async (_run, role) => {
    const product = await aProductCheckout(PINS, {
      design: ["jrey8343/skills/event-storming"],
      implement: ["jrey8343/skills/deciders"],
      review: ["someone/skills/threat-model"],
    });
    const { fetched, fetchSource } = servingEach(await upstream());

    const installed = await fetchSkills(await aKitCheckout(), product, fetchSource, { install: role });

    expect(installed).toMatchObject({ skills: ["tdd"], extraSkills: [], errors: [] });
    expect(fetched).toEqual([BASE]);
    expect(await installedFolders(product)).toEqual(["tdd"]);
    expect(await readInstallRecord(product)).toEqual([{ repository: "mattpocock/skills", sha: LOCKED_SHA, skills: ["tdd"] }]);
  });

  it("installs every role's Extra skills, each once, when asked for every pick", async () => {
    const product = await aProductCheckout(PINS, {
      design: ["jrey8343/skills/event-storming"],
      implement: ["jrey8343/skills/deciders"],
      review: ["someone/skills/threat-model", "jrey8343/skills/event-storming"],
    });
    const { fetchSource } = servingEach(await upstream());

    const installed = await fetchSkills(await aKitCheckout(), product, fetchSource, { install: "every" });

    expect(installed.extraSkills).toEqual(["event-storming", "deciders", "threat-model"]);
    expect(await installedFolders(product)).toEqual(["deciders", "event-storming", "tdd", "threat-model"]);
    expect(await readInstallRecord(product)).toEqual([
      { repository: "mattpocock/skills", sha: LOCKED_SHA, skills: ["tdd"] },
      { repository: OPERATOR_SKILLS, sha: OPERATOR_SHA, skills: ["event-storming", "deciders"] },
      { repository: OTHER_SKILLS, sha: OTHER_SHA, skills: ["threat-model"] },
    ]);
  });

  it("fetches each needed source once, and never a source no requested pick needs", async () => {
    const product = await aProductCheckout(PINS, {
      implement: ["jrey8343/skills/deciders", "jrey8343/skills/event-storming"],
      review: ["someone/skills/threat-model"],
    });
    const { fetched, fetchSource } = servingEach(await upstream());

    await fetchSkills(await aKitCheckout(), product, fetchSource, { install: "implement" });

    expect(fetched).toEqual([BASE, OPERATOR]);
  });

  it("fetches nothing again when every source's pin and picks are unchanged since the last install", async () => {
    const kit = await aKitCheckout();
    const product = await aProductCheckout(PINS, {
      design: ["jrey8343/skills/event-storming"],
      review: ["someone/skills/threat-model"],
    });
    await fetchSkills(kit, product, servingEach(await upstream()).fetchSource);
    const again = servingEach(await upstream());

    const installed = await fetchSkills(kit, product, again.fetchSource);

    expect(again.fetched).toEqual([]);
    expect(installed.extraSkills).toEqual(["event-storming", "threat-model"]);
    expect(await installedFolders(product)).toEqual(["event-storming", "tdd", "threat-model"]);
  });

  it("fetches only the source whose picks changed since the last install", async () => {
    const kit = await aKitCheckout();
    const picks = { design: ["jrey8343/skills/event-storming"], review: ["someone/skills/threat-model"] };
    const product = await aProductCheckout(PINS, picks);
    await fetchSkills(kit, product, servingEach(await upstream()).fetchSource);
    const repicked = await aProductCheckout(PINS, { ...picks, implement: ["jrey8343/skills/deciders"] });
    await cpDir(join(product, ".claude"), join(repicked, ".claude"));
    const again = servingEach(await upstream());

    await fetchSkills(kit, repicked, again.fetchSource);

    expect(again.fetched).toEqual([OPERATOR]);
    expect(await installedFolders(repicked)).toEqual(["deciders", "event-storming", "tdd", "threat-model"]);
  });

  it("removes an Extra skill it installed earlier that is no longer picked, and never a folder it didn't install", async () => {
    const kit = await aKitCheckout();
    const before = await aProductCheckout(PINS, {
      design: ["jrey8343/skills/event-storming", "jrey8343/skills/deciders"],
      review: ["someone/skills/threat-model"],
    });
    await fetchSkills(kit, before, servingEach(await upstream()).fetchSource);
    await mkdir(join(before, ".claude/skills/my-own-skill"));
    const after = await aProductCheckout([{ repository: OPERATOR_SKILLS, sha: OPERATOR_SHA }], {
      design: ["jrey8343/skills/event-storming"],
    });
    await cpDir(join(before, ".claude"), join(after, ".claude"));

    await fetchSkills(kit, after, servingEach(await upstream()).fetchSource);

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
    operatorSource: SkillsSource,
    kit?: string,
  ): Promise<{ readonly product: string; readonly installed: Awaited<ReturnType<typeof fetchSkills>> }> {
    const product = await aProductCheckout([{ repository: OPERATOR_SKILLS, sha: OPERATOR_SHA }], picks);
    const { fetchSource } = servingEach({ ...(await upstream()), [sourceAt(OPERATOR.repository, OPERATOR.sha)]: operatorSource });
    const installed = await fetchSkills(kit ?? (await aKitCheckout()), product, fetchSource, { install: "every" });
    return { product, installed };
  }

  it("fails the install on a pick the source's manifest doesn't list, still installing the Base skills", async () => {
    const { product, installed } = await installing(
      { design: ["jrey8343/skills/event-storming", "jrey8343/skills/sagas"] },
      await aSkillsSource({ "skills/modelling/event-storming": "# event-storming" }),
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
    await fetchSkills(kit, product, servingEach(await upstream()).fetchSource);

    const again = await fetchSkills(kit, product, servingEach(await upstream()).fetchSource);

    expect(again.errors).toHaveLength(1);
    expect(again.extraSkills).toEqual([]);
  });

  it("fails the install on a source with no manifest", async () => {
    const { product, installed } = await installing(
      { design: ["jrey8343/skills/event-storming"] },
      await aSkillsSource({ "skills/modelling/event-storming": "# event-storming" }, { manifest: false }),
    );

    expect(installed.errors).toEqual([
      ".fabrik/skills.lock.json[0] pins jrey8343/skills at 1111111, which has no readable .claude-plugin/plugin.json listing its skills",
    ]);
    expect(await installedFolders(product)).toEqual(["tdd"]);
  });

  it("fails the install on a pick named like a Base skill, leaving the Base skill in place", async () => {
    const { product, installed } = await installing(
      { implement: ["jrey8343/skills/tdd"] },
      await aSkillsSource({ "skills/engineering/tdd": "# the Operator's tdd" }),
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
      await aSkillsSource({ "skills/fabrik-pair": "# the Operator's pair" }),
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

    const installed = await fetchSkills(await aKitCheckout(), product, servingEach(await upstream()).fetchSource);

    expect(installed.errors).toEqual([
      'roles.review.skills[0] is "unpinned/skills/thing": unpinned/skills has no pin in .fabrik/skills.lock.json',
    ]);
    expect(await installedFolders(product)).toEqual(["tdd"]);
  });
});

