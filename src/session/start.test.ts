import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aKitCheckout,
  aProductCheckout,
  aRepository,
  aSkillsSource,
  git,
  LOCKED_SHA,
  serving,
  servingEach,
  sourceAt,
  tempDir,
} from "../__fixtures__/skillsArchive.ts";
import { operatorSessionMarker } from "../kit/operatorSession.ts";
import type { FetchSource } from "../skills/fetch.ts";
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
    const { fetched, fetchSource } = serving(await aSkillsSource({ "skills/engineering/grilling": "# grilling" }));

    const output = await sessionStart({ kitDir: kit, productDir: product, release: "v1.2.3", fetchSource });

    expect(fetched).toEqual([{ repository: "mattpocock/skills", sha: LOCKED_SHA }]);
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
      fetchSource: serving(await aSkillsSource()).fetchSource,
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
      fetchSource: serving(await aSkillsSource()).fetchSource,
    });

    expect(await readFile(join(product, ".claude/skills/fabrik-pair/SKILL.md"), "utf8")).toContain("# Pair");
    expect(output.hookSpecificOutput.additionalContext).toContain("/fabrik-pair <issue number>");
  });

  it("installs the release's Visual evidence skill, and tells Claude how the Operator turns Visual evidence on", async () => {
    const kit = resolve(import.meta.dirname, "..", "..");
    const product = await aProduct(callerAt("v1.2.3"));

    const output = await sessionStart({ kitDir: kit, productDir: product, release: "v1.2.3", fetchSource: serving(await aSkillsSource()).fetchSource });

    expect(await readFile(join(product, ".claude/skills/fabrik-visual-evidence/SKILL.md"), "utf8")).toBe(
      await readFile(join(kit, "skills/fabrik-visual-evidence/SKILL.md"), "utf8"),
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "To turn Visual evidence on, or change its answers, the Operator runs /fabrik-visual-evidence.",
    );
  });

  it("installs the release's Trial session skill, and tells Claude how the Operator starts one, for the untried queue or for one pull request", async () => {
    const kit = resolve(import.meta.dirname, "..", "..");
    const product = await aProduct(callerAt("v1.2.3"));

    const output = await sessionStart({ kitDir: kit, productDir: product, release: "v1.2.3", fetchSource: serving(await aSkillsSource()).fetchSource });

    expect(await readFile(join(product, ".claude/skills/fabrik-trial/SKILL.md"), "utf8")).toBe(await readFile(join(kit, "skills/fabrik-trial/SKILL.md"), "utf8"));
    expect(output.hookSpecificOutput.additionalContext.split("\n")).toContain(
      "To try the merged changes untried on staging with an agent driving their own Chrome (a Trial session), the Operator runs /fabrik-trial, or /fabrik-trial <pull request number> for one, in a local session with Claude in Chrome connected.",
    );
  });

  it("installs the release's text for cloud sessions with the Kit's other skills, as any Kit skill", async () => {
    const kit = resolve(import.meta.dirname, "..", "..");
    const product = await aProduct(callerAt("v1.2.3"));

    await sessionStart({ kitDir: kit, productDir: product, release: "v1.2.3", fetchSource: serving(await aSkillsSource()).fetchSource });

    expect(await readFile(join(product, ".claude/skills/fabrik-operator-session/SKILL.md"), "utf8")).toBe(
      await readFile(join(kit, "skills/fabrik-operator-session/SKILL.md"), "utf8"),
    );
    expect(await readdir(join(product, ".claude/skills"))).toEqual(
      expect.arrayContaining(["fabrik-live-design", "fabrik-operator-session", "fabrik-pair", "fabrik-trial", "fabrik-visual-evidence"]),
    );
  });

  it("doesn't mention the Trial session skill when the release has none", async () => {
    const output = await sessionStart({
      kitDir: await aKitCheckout(LOCKED_SHA, { "skills/fabrik-pair/SKILL.md": "---\nname: fabrik-pair\n---\n# Pair" }),
      productDir: await aProduct(callerAt("v1.2.3")),
      release: "v1.2.3",
      fetchSource: serving(await aSkillsSource()).fetchSource,
    });

    expect(output.hookSpecificOutput.additionalContext).not.toContain("/fabrik-trial");
    expect(output.hookSpecificOutput.additionalContext).not.toContain("Trial session");
  });

  it("doesn't mention the Pairing session skill when the release has none", async () => {
    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: await aProduct(callerAt("v1.2.3")),
      release: "v1.2.3",
      fetchSource: serving(await aSkillsSource()).fetchSource,
    });

    expect(output.hookSpecificOutput.additionalContext).not.toContain("/fabrik-pair");
  });

  it("still reloads skills when the right ones were already installed", async () => {
    const kit = await kitWithLiveSkill();
    const product = await aProduct(callerAt("v1.2.3"));
    await sessionStart({ kitDir: kit, productDir: product, release: "v1.2.3", fetchSource: serving(await aSkillsSource()).fetchSource });

    const output = await sessionStart({
      kitDir: kit,
      productDir: product,
      release: "v1.2.3",
      fetchSource: serving(await aSkillsSource()).fetchSource,
    });

    expect(output.hookSpecificOutput.reloadSkills).toBe(true);
  });

  it("installs nothing and warns when the caller workflow pins a different release from the Kit it fetched", async () => {
    const kit = await kitWithLiveSkill();
    const product = await aProduct(callerAt("v1.2.4"));
    const { fetched, fetchSource } = serving(await aSkillsSource());

    const output = await sessionStart({ kitDir: kit, productDir: product, release: "v1.2.3", fetchSource });

    expect(fetched).toEqual([]);
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
      fetchSource: serving(await aSkillsSource()).fetchSource,
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
      fetchSource: serving(await aSkillsSource()).fetchSource,
    });

    expect(output.systemMessage).toBe(
      "Fabrik didn't install its skills: .github/workflows/fabrik.yml was not found",
    );
  });

  it("warns rather than throwing when the Base skills can't be fetched from github.com, naming the fetch", async () => {
    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: await aProduct(callerAt("v1.2.3")),
      release: "v1.2.3",
      fetchSource: servingEach({}).fetchSource,
    });

    expect(output.hookSpecificOutput.reloadSkills).toBe(false);
    expect(output.systemMessage).toBe(
      `Fabrik didn't install its skills: mattpocock/skills at 4ae2317 could not be fetched from github.com: fatal: remote error: upload-pack: not our ref ${LOCKED_SHA}`,
    );
  });
});

describe("The SessionStart hook in fabrik itself, whose checkout is the Kit", () => {
  /** A stand-in Fabrik checkout: a skills.lock.json, its own skills/ and no caller workflow. */
  const aFabrikCheckout = () =>
    aKitCheckout(LOCKED_SHA, {
      "skills/fabrik-live-design/SKILL.md": "---\nname: fabrik-live-design\n---\n# Live",
      "skills/fabrik-pair/SKILL.md": "---\nname: fabrik-pair\n---\n# Pair",
      "skills/fabrik-visual-evidence/SKILL.md": "---\nname: fabrik-visual-evidence\n---\n# Visual evidence",
    });

  it("installs the Base skills its skills.lock.json pins and its own skills/ into its own .claude/skills/, with no caller workflow and no release", async () => {
    const fabrik = await aFabrikCheckout();
    const { fetched, fetchSource } = serving(await aSkillsSource({ "skills/engineering/grilling": "# grilling" }));

    const output = await sessionStart({ kitDir: fabrik, productDir: fabrik, release: null, fetchSource });

    expect(fetched).toEqual([{ repository: "mattpocock/skills", sha: LOCKED_SHA }]);
    expect(await installedFolders(fabrik)).toEqual(["fabrik-live-design", "fabrik-pair", "fabrik-visual-evidence", "grilling"]);
    expect(await readFile(join(fabrik, ".claude/skills/fabrik-pair/SKILL.md"), "utf8")).toContain("# Pair");
    expect(output.systemMessage).toBeUndefined();
    expect(output.hookSpecificOutput.reloadSkills).toBe(true);
  });

  it("says in its first line of context that the skills came from this checkout, and gives the same lines on Fabrik's own skills as a Product repo's", async () => {
    const fabrik = await aFabrikCheckout();

    const output = await sessionStart({
      kitDir: fabrik,
      productDir: fabrik,
      release: null,
      fetchSource: serving(await aSkillsSource()).fetchSource,
    });

    expect(output.hookSpecificOutput.additionalContext).toBe(
      `This checkout is Fabrik itself. The skills its skills.lock.json pins (mattpocock/skills at ${LOCKED_SHA}) and its own skills/ are in .claude/skills/, as this branch held them when the session started, installed by the SessionStart hook; they're gitignored, so never commit or edit them there: a skill of Fabrik's own is edited under skills/.\n` +
        "To take an issue's Design session live, the Operator runs /fabrik-live-design <issue number>.\n" +
        "To work through a ready-for-human or weekly-limit issue with an agent beside them (a Pairing session), the Operator runs /fabrik-pair <issue number>.\n" +
        "To turn Visual evidence on, or change its answers, the Operator runs /fabrik-visual-evidence.",
    );
  });

  it("warns rather than throwing when the Base skills can't be fetched from github.com", async () => {
    const fabrik = await aFabrikCheckout();

    const output = await sessionStart({ kitDir: fabrik, productDir: fabrik, release: null, fetchSource: servingEach({}).fetchSource });

    expect(output.hookSpecificOutput.reloadSkills).toBe(false);
    expect(output.systemMessage).toBe(
      `Fabrik didn't install its skills: mattpocock/skills at 4ae2317 could not be fetched from github.com: fatal: remote error: upload-pack: not our ref ${LOCKED_SHA}`,
    );
  });
});

const OPERATOR_SKILLS = "jrey8343/skills";
const OPERATOR_SHA = "1111111111111111111111111111111111111111";
const OTHER_SKILLS = "someone/skills";
const OTHER_SHA = "2222222222222222222222222222222222222222";
const BASE = sourceAt("mattpocock/skills", LOCKED_SHA);
const OPERATOR = sourceAt(OPERATOR_SKILLS, OPERATOR_SHA);
const OTHER = sourceAt(OTHER_SKILLS, OTHER_SHA);
const PINS = [
  { repository: OPERATOR_SKILLS, sha: OPERATOR_SHA },
  { repository: OTHER_SKILLS, sha: OTHER_SHA },
];

async function upstream() {
  return {
    [BASE]: await aSkillsSource({ "skills/engineering/grilling": "# grilling" }),
    [OPERATOR]: await aSkillsSource({
      "skills/modelling/event-storming": "# event-storming",
      "skills/modelling/deciders": "# deciders",
    }),
    [OTHER]: await aSkillsSource({ "skills/review/threat-model": "# threat-model" }),
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
      fetchSource: servingEach(await upstream()).fetchSource,
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
      fetchSource: servingEach(await upstream()).fetchSource,
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
      fetchSource: servingEach(await upstream()).fetchSource,
    });

    expect(await installedFolders(product)).toEqual(["fabrik-live-design", "grilling"]);
    expect(output.systemMessage).toMatch(/^Fabrik installed its Base and Kit skills, but not this repo's Extra skills: .*roles\.design\.skills\[0\]/);
  });

  it("warns when an Extra skills source can't be fetched from github.com, and still installs the Base and Kit skills", async () => {
    const product = await aProductWithPicks(PINS, {
      design: ["jrey8343/skills/event-storming"],
      review: ["someone/skills/threat-model"],
    });
    const { [OTHER]: _unreachable, ...reachable } = await upstream();

    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: product,
      release: "v1.2.3",
      fetchSource: servingEach(reachable).fetchSource,
    });

    expect(await installedFolders(product)).toEqual(["fabrik-live-design", "grilling"]);
    expect(output.hookSpecificOutput.reloadSkills).toBe(true);
    expect(output.systemMessage).toBe(
      `Fabrik installed its Base and Kit skills, but not this repo's Extra skills: someone/skills at 2222222 could not be fetched from github.com: fatal: remote error: upload-pack: not our ref ${OTHER_SHA}`,
    );
  });

  it("says nothing of Extra skills when the repo picks none and its Kit config is invalid for another reason", async () => {
    const product = await aProductWithPicks([], {});
    await writeFile(join(product, ".fabrik/config.json"), JSON.stringify({ roles: { design: { model: "best" } } }));

    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: product,
      release: "v1.2.3",
      fetchSource: servingEach(await upstream()).fetchSource,
    });

    expect(await installedFolders(product)).toEqual(["fabrik-live-design", "grilling"]);
    expect(output.systemMessage).toBeUndefined();
  });

  it("fetches nothing at a second session start when the pins and picks haven't changed", async () => {
    const kit = await kitWithLiveSkill();
    const product = await aProductWithPicks(PINS, {
      design: ["jrey8343/skills/event-storming"],
      review: ["someone/skills/threat-model"],
    });
    const start = async (fetchSource: FetchSource) =>
      sessionStart({ kitDir: kit, productDir: product, release: "v1.2.3", fetchSource });
    await start(servingEach(await upstream()).fetchSource);
    const again = servingEach(await upstream());

    const output = await start(again.fetchSource);

    expect(again.fetched).toEqual([]);
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
      fetchSource: servingEach(await upstream()).fetchSource,
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
      fetchSource: servingEach(await upstream()).fetchSource,
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
      fetchSource: servingEach(await upstream()).fetchSource,
    });

    expect(output.systemMessage).toBeUndefined();
    expect(output.hookSpecificOutput.additionalContext).toBe(
      `Fabrik v1.2.3 is installed in this repo. The skills it pins (mattpocock/skills at ${LOCKED_SHA}) are in .claude/skills/, fetched by the SessionStart hook; they're gitignored, so never commit or edit them.\n` +
        "To take an issue's Design session live, the Operator runs /fabrik-live-design <issue number>.",
    );
  });
});

/** A cloud session's environment, in the bare Session environment, with an id of the `cse_` form. */
const CLOUD = {
  CLAUDE_CODE_REMOTE: "true",
  CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01AbC-d_9",
  FABRIK_SESSION_ENVIRONMENT: "operator-sessions",
} as const;

const ADDRESS = "https://claude.ai/code/session_01AbC-d_9";

/**
 * A Product checkout as a cloud session clones it: a git repository whose
 * `origin` remote is this address, its default branch as last fetched
 * (`refs/remotes/origin/HEAD`) the commit that holds the caller workflow, this
 * Kit config and these files. With `originHead: false` the checkout has no
 * `origin/HEAD`, and with `origin: null` no `origin` remote.
 */
async function aClonedProduct({
  origin = "https://github.com/acme/widgets.git",
  config,
  files = {},
  originHead = true,
}: {
  readonly origin?: string | null;
  readonly config?: unknown;
  readonly files?: Record<string, string>;
  readonly originHead?: boolean;
} = {}): Promise<string> {
  const product = await aProduct(callerAt("v1.2.3"));
  await aRepository(product, config === undefined ? files : { ".fabrik/config.json": JSON.stringify(config), ...files });
  if (origin !== null) git(product, "remote", "add", "origin", origin);
  git(product, "update-ref", "refs/remotes/origin/main", git(product, "rev-parse", "HEAD"));
  if (originHead) git(product, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return product;
}

/** The hook's context, line by line, for a stand-in Kit with the live Design session skill, in this checkout and environment. */
async function contextIn(productDir: string, env: Record<string, string>, { kit = false } = {}): Promise<readonly string[]> {
  const kitDir = kit ? productDir : await kitWithLiveSkill();
  if (kit) await writeFile(join(productDir, "skills.lock.json"), JSON.stringify({ repository: "mattpocock/skills", sha: LOCKED_SHA }));
  const output = await sessionStart({
    kitDir,
    productDir,
    release: kit ? null : "v1.2.3",
    fetchSource: serving(await aSkillsSource()).fetchSource,
    env,
  });
  return output.hookSpecificOutput.additionalContext.split("\n");
}

/** The context's lines after the ones every session gets, for a stand-in Kit with the live Design session skill. */
async function cloudLinesIn(productDir: string, env: Record<string, string> = CLOUD): Promise<readonly string[]> {
  return (await contextIn(productDir, env)).slice(2);
}

const TERMINAL_CONTEXT = [
  `Fabrik v1.2.3 is installed in this repo. The skills it pins (mattpocock/skills at ${LOCKED_SHA}) are in .claude/skills/, fetched by the SessionStart hook; they're gitignored, so never commit or edit them.`,
  "To take an issue's Design session live, the Operator runs /fabrik-live-design <issue number>.",
];

const WHERE_IT_IS = (repo: string) =>
  `This is a Claude Code cloud session on ${repo}. \`gh issue\` and \`gh pr\` are refused here: every tracker operation goes over REST, by the forms in .claude/skills/fabrik-operator-session/SKILL.md. Read that skill before any work.`;
const THE_OPERATOR = (login: string) => `The Operator is ${login}: claim and assign with that login, since REST has no @me.`;
const HAS_A_RESEARCHER =
  "This repo has a Researcher: fire no research subagent, since the Kit's Researcher takes each unblocked research Decision.";
const HAS_NO_RESEARCHER =
  "This repo has no Researcher: fire a research subagent for each unblocked research Decision you file, as fabrik-operator-session says.";
const IN_THE_EXPECTED = (name: string) => `This session is in the Session environment ${name}, the one this repo expects.`;
const IN_ANOTHER = (expected: string, found: string) =>
  `This repo expects the Session environment ${expected}, and this session is in ${found}. Say so as your first words, and do no work until the Operator says to go on or starts again.`;
const IN_NONE = (expected: string) =>
  `This repo expects the Session environment ${expected}, and this session's environment sets no FABRIK_SESSION_ENVIRONMENT, so it isn't one. Say so as your first words, and do no work until the Operator says to go on or starts again.`;
const THE_ADDRESS = [
  `This session's address is ${ADDRESS}. When you work an issue as a Pairing session, or a Map's Decision, write these two lines there as your first comment, after your skill's opening checks pass and before any work, unless the issue already holds a marker with this address:`,
  `<!-- fabrik:operator-session ${ADDRESS} -->`,
  `This issue is being worked in [an Operator session](${ADDRESS}).`,
];
const NO_ADDRESS =
  "CLAUDE_CODE_REMOTE_SESSION_ID is missing or isn't of the cse_ form, so the hook can't give this session's address. Take it from the session link in your own attribution lines; with neither, write no marker, say so, and work on.";
const NOTHING_ATTACHED = "This repo's default branch has no .fabrik/operator-session.md, so nothing is attached to its Operator sessions.";

describe("The SessionStart hook in a cloud session", () => {
  it("gives a terminal today's context and none of the cloud lines, CLAUDE_CODE_REMOTE unset or anything but true", async () => {
    for (const env of [{}, { ...CLOUD, CLAUDE_CODE_REMOTE: "false" }, { ...CLOUD, CLAUDE_CODE_REMOTE: "TRUE" }]) {
      expect(await contextIn(await aClonedProduct({ config: { operator: "octo-op" } }), env)).toEqual(TERMINAL_CONTEXT);
    }
  });

  it("adds the six lines after the others, in order, with the repo from the origin remote and the Operator from Kit config", async () => {
    const product = await aClonedProduct({ config: { operator: "octo-op" } });

    expect(await contextIn(product, CLOUD)).toEqual([
      ...TERMINAL_CONTEXT,
      WHERE_IT_IS("acme/widgets"),
      THE_OPERATOR("octo-op"),
      HAS_A_RESEARCHER,
      IN_THE_EXPECTED("operator-sessions"),
      ...THE_ADDRESS,
      NOTHING_ATTACHED,
    ]);
  });

  it("takes the Operator's login from the remote's owner when Kit config names none", async () => {
    const [, operator] = await cloudLinesIn(await aClonedProduct());

    expect(operator).toBe(THE_OPERATOR("acme"));
  });

  it("reads the repo from the last two parts of the origin remote's path, any .git dropped, whatever its host", async () => {
    for (const origin of [
      "git@github.com:acme/widgets.git",
      "http://local_proxy@127.0.0.1:41723/git/acme/widgets",
      "https://ghe.example.com/team/acme/widgets/",
    ]) {
      const [whereItIs, operator] = await cloudLinesIn(await aClonedProduct({ origin }));

      expect(whereItIs).toBe(WHERE_IT_IS("acme/widgets"));
      expect(operator).toBe(THE_OPERATOR("acme"));
    }
  });

  it("says the repo's name and the Operator's login aren't known when the remote can't be read and Kit config names no Operator", async () => {
    const [whereItIs, operator] = await cloudLinesIn(await aClonedProduct({ origin: null }));

    expect(whereItIs).toBe(
      "This is a Claude Code cloud session. This repo's name isn't known here: ask the Operator for it before you write to the tracker. `gh issue` and `gh pr` are refused here: every tracker operation goes over REST, by the forms in .claude/skills/fabrik-operator-session/SKILL.md. Read that skill before any work.",
    );
    expect(operator).toBe("The Operator's login isn't known here: ask the Operator for it before you claim or assign.");
  });

  it("still names the Operator from Kit config when the remote can't be read", async () => {
    const [, operator] = await cloudLinesIn(await aClonedProduct({ origin: null, config: { operator: "octo-op" } }));

    expect(operator).toBe(THE_OPERATOR("octo-op"));
  });

  describe("the Session environment, compared with FABRIK_SESSION_ENVIRONMENT exactly", () => {
    const withOwn = () => aClonedProduct({ config: { console: { session_environment: "widgets-sessions" } } });
    const environmentLine = async (product: string, found: string | undefined) => {
      const { FABRIK_SESSION_ENVIRONMENT: _, ...rest } = CLOUD;
      return (await cloudLinesIn(product, found === undefined ? rest : { ...rest, FABRIK_SESSION_ENVIRONMENT: found }))[3];
    };

    it("expects the repo's own when its Kit config names one", async () => {
      expect(await environmentLine(await withOwn(), "widgets-sessions")).toBe(IN_THE_EXPECTED("widgets-sessions"));
      expect(await environmentLine(await withOwn(), "operator-sessions")).toBe(IN_ANOTHER("widgets-sessions", "operator-sessions"));
      expect(await environmentLine(await withOwn(), "Widgets-Sessions")).toBe(IN_ANOTHER("widgets-sessions", "Widgets-Sessions"));
      expect(await environmentLine(await withOwn(), undefined)).toBe(IN_NONE("widgets-sessions"));
      expect(await environmentLine(await withOwn(), "")).toBe(IN_NONE("widgets-sessions"));
    });

    it("expects the bare one when Kit config names none", async () => {
      expect(await environmentLine(await aClonedProduct(), "operator-sessions")).toBe(IN_THE_EXPECTED("operator-sessions"));
      expect(await environmentLine(await aClonedProduct(), "widgets-sessions")).toBe(IN_ANOTHER("operator-sessions", "widgets-sessions"));
      expect(await environmentLine(await aClonedProduct(), undefined)).toBe(IN_NONE("operator-sessions"));
    });

    it("expects the bare one, and takes the Operator from the remote, when Kit config is invalid", async () => {
      const product = await aClonedProduct({ config: { operator: "octo-op", console: { session_environment: "widgets-sessions" }, roles: 7 } });

      const lines = await cloudLinesIn(product, { ...CLOUD, FABRIK_SESSION_ENVIRONMENT: "widgets-sessions" });

      expect(lines[1]).toBe(THE_OPERATOR("acme"));
      expect(lines[3]).toBe(IN_ANOTHER("operator-sessions", "widgets-sessions"));
    });
  });

  it("says the hook can't give the address when CLAUDE_CODE_REMOTE_SESSION_ID is missing or of another form", async () => {
    const { CLAUDE_CODE_REMOTE_SESSION_ID: _, ...withNone } = CLOUD;
    for (const env of [withNone, { ...CLOUD, CLAUDE_CODE_REMOTE_SESSION_ID: "session_01AbC" }, { ...CLOUD, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_" }]) {
      const lines = await cloudLinesIn(await aClonedProduct(), env);

      expect(lines.slice(4)).toEqual([NO_ADDRESS, NOTHING_ATTACHED]);
    }
  });

  it("gives as the marker line the one operatorSessionMarker writes for the address", async () => {
    const lines = await cloudLinesIn(await aClonedProduct());

    expect(lines[5]).toBe(operatorSessionMarker(ADDRESS));
  });

  describe("what the repo attaches, read from the default branch as the checkout last fetched it", () => {
    const ATTACHED = (where: string) =>
      `${where} .fabrik/operator-session.md, which says what its Operator sessions can reach: read it as the default branch has it before you sort any step.`;
    const attachedLine = async (product: string) => (await cloudLinesIn(product)).at(-1);

    it("finds the file on origin/HEAD when the working tree doesn't hold it", async () => {
      const product = await aClonedProduct({ files: { ".fabrik/operator-session.md": "Sessions here reach staging." } });
      await rm(join(product, ".fabrik/operator-session.md"));

      expect(await attachedLine(product)).toBe(ATTACHED("This repo's default branch has"));
    });

    it("says nothing is attached when only the working tree holds it", async () => {
      const product = await aClonedProduct();
      await mkdir(join(product, ".fabrik"), { recursive: true });
      await writeFile(join(product, ".fabrik/operator-session.md"), "Sessions here reach staging.");

      expect(await attachedLine(product)).toBe(NOTHING_ATTACHED);
    });

    it("reads the working tree, and says so, when the checkout has no origin/HEAD", async () => {
      const held = await aClonedProduct({ originHead: false, files: { ".fabrik/operator-session.md": "Sessions here reach staging." } });
      const none = await aClonedProduct({ originHead: false });

      expect(await attachedLine(held)).toBe(ATTACHED("This checkout has"));
      expect(await attachedLine(none)).toBe("This checkout has no .fabrik/operator-session.md, so nothing is attached to its Operator sessions.");
    });
  });

  it("gives fabrik (--kit) the same lines, with no Researcher and the bare Session environment expected", async () => {
    const fabrik = await aClonedProduct({ origin: "https://github.com/jrey8343/fabrik" });

    const lines = await contextIn(fabrik, { ...CLOUD, FABRIK_SESSION_ENVIRONMENT: "widgets-sessions" }, { kit: true });

    expect(lines.slice(1)).toEqual([
      WHERE_IT_IS("jrey8343/fabrik"),
      THE_OPERATOR("jrey8343"),
      HAS_NO_RESEARCHER,
      IN_ANOTHER("operator-sessions", "widgets-sessions"),
      ...THE_ADDRESS,
      NOTHING_ATTACHED,
    ]);
  });

  it("tells a Product repo it has a Researcher", async () => {
    expect((await cloudLinesIn(await aClonedProduct()))[2]).toBe(HAS_A_RESEARCHER);
  });

  it("gives a cloud session whose skills weren't installed the line saying so alone, and no reload", async () => {
    const product = await aClonedProduct();
    await writeFile(join(product, ".github/workflows/fabrik.yml"), callerAt("v1.2.4"));

    const output = await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: product,
      release: "v1.2.3",
      fetchSource: serving(await aSkillsSource()).fetchSource,
      env: CLOUD,
    });

    expect(output.hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      additionalContext:
        "Fabrik didn't install its skills: the hook fetched Fabrik v1.2.3, but .github/workflows/fabrik.yml pins v1.2.4. Skills such as grilling, to-spec and to-tickets may be missing from this session.",
      reloadSkills: false,
    });
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
      fetchSource: serving(await aSkillsSource({ "skills/engineering/grilling": "# grilling" })).fetchSource,
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
      fetchSource: servingEach(await upstream()).fetchSource,
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
      fetchSource: serving(await aSkillsSource()).fetchSource,
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
      fetchSource: serving(await aSkillsSource({ "skills/engineering/grilling": "# grilling" })).fetchSource,
    });

    expect(await installedFolders(product)).toEqual(["fabrik-live-design", "grilling"]);
  });

  it("keeps an Extra skill the repo picks under that name", async () => {
    const product = await aProductWithPicks([{ repository: OPERATOR_SKILLS, sha: OPERATOR_SHA }], { design: ["jrey8343/skills/fabrik-setup"] });

    await sessionStart({
      kitDir: await kitWithLiveSkill(),
      productDir: product,
      release: "v1.2.3",
      fetchSource: servingEach({
        [BASE]: await aSkillsSource({ "skills/engineering/grilling": "# grilling" }),
        [OPERATOR]: await aSkillsSource({ "skills/setup/fabrik-setup": "# the repo's own" }),
      }).fetchSource,
    });

    expect(await readFile(join(product, ".claude/skills/fabrik-setup/SKILL.md"), "utf8")).toBe("# the repo's own");
  });
});
