// One run of the setup program in a terminal, from the plan to the setup PR:
// git runs for real against a bare origin, GitHub and 1Password are a fake
// world that keeps what each run did, and the wizard is a stand-in that
// stores what the Operator would.
import { execFileSync } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { aReadyOperator, fakeCommands } from "../__fixtures__/setupCommands.ts";
import { aWorld, store, type World, worldScript } from "../__fixtures__/setupWorld.ts";
import { tempDir } from "../__fixtures__/skillsArchive.ts";
import { type Env, type Run, spawnRun } from "./exec.ts";
import { runSetup } from "./program.ts";
import type { Prompt } from "./prompt.ts";

const KIT_DIR = resolve(import.meta.dirname, "..", "..");
const BRANCH = "fabrik/setup-v1.4.2";
/** Every question but the yes answered by a flag. */
const FLAGS = ["--no-time-zone", "--no-second-subscription", "--no-paused"];

let origin: string;
let checkout: string;
let env: Env;

const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, encoding: "utf8", env: env as NodeJS.ProcessEnv });
const originGit = (...args: string[]) => execFileSync("git", args, { cwd: origin, encoding: "utf8", env: env as NodeJS.ProcessEnv });

beforeEach(async () => {
  // Never the developer's own git config, such as commit signing.
  env = { PATH: process.env["PATH"], HOME: await tempDir("setup-home"), GIT_CONFIG_NOSYSTEM: "1" };
  origin = await tempDir("setup-origin");
  originGit("init", "-q", "--bare", "-b", "main");
  checkout = await tempDir("setup-checkout");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Operator");
  git("config", "user.email", "operator@example.com");
  await writeFile(join(checkout, "README.md"), "# Clinic\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "Start");
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "main");
});

type Wizard = (world: World, env: Env) => Promise<void>;

/** The Operator walks every stage: the App installed, its key and the Claude token stored. */
const walksEveryStage: Wizard = async (world, wizardEnv) => {
  await writeFile(wizardEnv["FABRIK_WIZARD_REPORT"]!, "app-installed acme/clinic\n");
  store(world, "Fabrik App", "Fabrik App");
  store(world, "Fabrik", "Claude token");
};

/** The Operator stops at the Claude token stage. */
const skipsTheClaudeToken: Wizard = async (world, wizardEnv) => {
  await writeFile(wizardEnv["FABRIK_WIZARD_REPORT"]!, "app-installed acme/clinic\n");
  store(world, "Fabrik App", "Fabrik App");
};

function scripted(answers: string[]): Prompt & { questions: string[] } {
  const questions: string[] = [];
  return {
    questions,
    ask: async (question) => {
      questions.push(question);
      if (answers.length === 0) throw new Error(`Asked more than the script answers: ${question}`);
      return answers.shift()!;
    },
  };
}

interface Options {
  readonly answers?: string[];
  readonly wizard?: Wizard;
  readonly args?: string[];
}

async function setupOnce(world: World, { answers = ["y"], wizard = walksEveryStage, args = FLAGS }: Options = {}) {
  const log: string[] = [];
  const said: string[] = [];
  const complaints: string[] = [];
  const wizardRuns: { cwd: string; env: Env }[] = [];
  const commands = fakeCommands({ ...aReadyOperator(checkout), ...worldScript(world) });
  const run: Run = async (command, commandArgs, options) => {
    log.push([command, ...commandArgs].join(" "));
    return command === "git" ? spawnRun(command, commandArgs, options) : commands.run(command, commandArgs, options);
  };
  const prompt = scripted(answers);
  const code = await runSetup([".", "v1.4.2", ...args], {
    run,
    env,
    cwd: checkout,
    prompt,
    say: (line) => said.push(...line.split("\n")),
    complain: (line) => complaints.push(line),
    kitDir: KIT_DIR,
    nodeVersion: "24.11.0",
    machineTimeZone: "Australia/Sydney",
    wizard: async (options) => {
      log.push("wizard");
      wizardRuns.push(options);
      await wizard(world, options.env);
    },
  });
  return { code, said, complaints, log, questions: prompt.questions, wizardRuns, calls: commands.calls };
}

/** The files on origin's setup branch. */
function filesOnOrigin(branch = BRANCH): string[] {
  return originGit("ls-tree", "-r", "--name-only", branch).split("\n").filter((path) => path !== "");
}

/** The paths the plan said it would write. */
function writtenIn(said: string[]): string[] {
  return said.flatMap((line) => /^- write (\S+) \(/.exec(line)?.[1] ?? []);
}

const index = (log: string[], pattern: RegExp) => log.findIndex((line) => pattern.test(line));

// Each run makes real git commits and pushes, so allow more than the default.
describe("One run of the setup program", { timeout: 30_000 }, () => {
  it("on a fresh repo, leaves an open setup PR on fabrik/setup-<release> holding every file setup wrote", async () => {
    const world = aWorld();

    const { code, said, complaints } = await setupOnce(world);

    expect(complaints).toEqual([]);
    expect(code).toBe(0);
    const written = writtenIn(said);
    expect(written).toEqual(expect.arrayContaining([".github/workflows/fabrik.yml", ".fabrik/config.json", ".claude/settings.json"]));
    expect(filesOnOrigin().sort()).toEqual(["README.md", ...new Set(written)].sort());
    expect(world.prs).toEqual([expect.objectContaining({ head: BRANCH, base: "main", open: true })]);
    expect(git("branch", "--show-current").trim()).toBe(BRANCH);
    expect(git("status", "--porcelain")).toBe("");
    expect(said).toContain("The setup PR: https://github.com/acme/clinic/pull/1");
  });

  it("asks the Operator's yes to the plan, naming the branch, before it changes anything", async () => {
    const { questions, log } = await setupOnce(aWorld());

    expect(questions).toEqual([`Apply this plan on ${BRANCH}, walk the wizard, then push it and open the setup PR? [y/N] `]);
    expect(index(log, /^git switch/)).toBeGreaterThan(-1);
    expect(log.slice(0, index(log, /^git switch/)).filter((line) => /^gh label create|^op vault create/.test(line))).toEqual([]);
  });

  it("runs the wizard's stages after applying and before the PR is pushed, with the 1Password account in its env", async () => {
    const { log, wizardRuns } = await setupOnce(aWorld());

    const wizard = log.indexOf("wizard");
    expect(index(log, /^git switch -C fabrik\/setup-v1\.4\.2$/)).toBeLessThan(wizard);
    expect(index(log, /^gh api --method POST repos\/acme\/clinic\/rulesets/)).toBeLessThan(wizard);
    expect(wizard).toBeLessThan(index(log, /^git commit/));
    expect(wizard).toBeLessThan(index(log, /^git push/));
    expect(wizard).toBeLessThan(index(log, /^gh pr create/));
    expect(wizardRuns).toHaveLength(1);
    expect(wizardRuns[0]?.env["OP_ACCOUNT"]).toBe("my.1password.com");
    expect(await realpath(wizardRuns[0]!.cwd)).toBe(await realpath(checkout));
  });

  it("applies the plan in the 1Password account it named, every op call from choosing it on included", async () => {
    const { calls } = await setupOnce(aWorld());

    const ops = calls.filter((call) => call.command === "op");
    const afterChoosing = ops.slice(ops.findIndex((call) => call.line.startsWith("op account list")) + 1);
    expect(afterChoosing.some((call) => call.line.startsWith("op service-account create"))).toBe(true);
    expect(new Set(afterChoosing.map((call) => call.env["OP_ACCOUNT"]))).toEqual(new Set(["my.1password.com"]));
  });

  it("asks for the merge once the App is installed, its key stored and the Claude token stored", async () => {
    const world = aWorld();

    const { said } = await setupOnce(world);

    expect(said.some((line) => line.startsWith("Merge it yourself once its gating checks pass."))).toBe(true);
    expect(world.prs[0]?.body).toContain("Merge this PR yourself once its gating checks pass.");
  });

  it("with the Claude token stage skipped, doesn't ask for the merge and says why", async () => {
    const world = aWorld();

    const { code, said } = await setupOnce(world, { wizard: skipsTheClaudeToken });

    expect(code).toBe(0);
    expect(said.some((line) => line.startsWith("Merge it yourself"))).toBe(false);
    expect(said).toContain("Don't merge it yet. The Kit's first runs need these, which the wizard didn't finish:");
    expect(said).toContain('- the Claude token, in the "Fabrik" vault');
    expect(world.prs[0]?.body).toContain("Don't merge this yet.");
  });

  it("a second run after the wizard stopped partway reuses the branch and PR, applies nothing again, and then asks for the merge", async () => {
    const world = aWorld();
    await setupOnce(world, { wizard: skipsTheClaudeToken });
    const firstBody = world.prs[0]!.body;

    const { code, said, log, questions } = await setupOnce(world);

    expect(code).toBe(0);
    expect(said).not.toContain("Setup would:");
    expect(questions).toEqual([`Nothing's left to apply. Walk the wizard, then push ${BRANCH} and open the setup PR? [y/N] `]);
    expect(log.filter((line) => /^gh label create|^op vault create|^op service-account|^gh api --method|^git switch|^gh pr create/.test(line))).toEqual([]);
    expect(log).toContain("wizard");
    expect(log.some((line) => line.startsWith("gh pr edit 1 "))).toBe(true);
    expect(world.prs).toHaveLength(1);
    expect(world.prs[0]!.body).toContain("- write .github/workflows/fabrik.yml (");
    expect(world.prs[0]!.body).not.toBe(firstBody);
    expect(world.prs[0]!.body).toContain("Merge this PR yourself");
  });

  it("a second run after applying stopped partway plans only what's still missing, then commits every file on the same branch", async () => {
    const world = aWorld();
    world.failingLabels.add("needs-info");
    const first = await setupOnce(world);
    expect(first.code).toBe(1);
    expect(first.complaints[0]).toContain("creating needs-info failed");
    expect(world.prs).toEqual([]);
    world.failingLabels.clear();

    const { code, said, log } = await setupOnce(world);

    expect(code).toBe(0);
    expect(writtenIn(said)).toEqual([]);
    expect(said).toContain("- create the label needs-info");
    expect(said).not.toContain("- create the label needs-triage");
    expect(log.filter((line) => line.startsWith("git switch"))).toEqual([]);
    expect(filesOnOrigin()).toEqual(expect.arrayContaining([".github/workflows/fabrik.yml", ".fabrik/config.json"]));
    expect(world.prs).toHaveLength(1);
  });

  it("a run on a working install plans nothing, opens no PR and says the install is complete", async () => {
    const world = aWorld();
    await setupOnce(world);
    // The Operator merges the setup PR.
    git("switch", "-q", "main");
    git("merge", "-q", "--ff-only", BRANCH);
    git("push", "-q", "origin", "main");
    world.prs[0]!.open = false;

    const { code, said, log, questions } = await setupOnce(world);

    expect(code).toBe(0);
    expect(said).toContain("Nothing to do: this repo's Fabrik install is complete.");
    expect(questions).toEqual([]);
    expect(log.filter((line) => /^gh pr (create|edit)|^git (switch|commit|push)|^wizard$/.test(line))).toEqual([]);
    expect(world.prs).toHaveLength(1);
  });

  it("changes nothing when the Operator says no to the plan", async () => {
    const world = aWorld();

    const { code, said, log } = await setupOnce(world, { answers: ["n"] });

    expect(code).toBe(0);
    expect(said).toContain("Setup changed nothing.");
    expect(log.filter((line) => /^gh label create|^op vault create|^git (switch|commit|push)|^gh pr|^wizard$/.test(line))).toEqual([]);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("branch", "--show-current").trim()).toBe("main");
  });

  it("from the default branch, stops at an earlier run's setup branch that isn't merged, and says to switch to it", async () => {
    const world = aWorld();
    await setupOnce(world, { wizard: skipsTheClaudeToken });
    git("switch", "-q", "main");

    const { code, complaints, questions } = await setupOnce(world);

    expect(code).toBe(1);
    expect(complaints[0]).toBe(
      `${BRANCH} holds an earlier run of setup that isn't on main yet. Switch to it with git switch ${BRANCH}, then run setup again: it picks up where that run stopped.`,
    );
    expect(questions).toEqual([]);
  });

  it("with --plan in a terminal, prints the plan and asks no yes", async () => {
    const { code, said, questions, log } = await setupOnce(aWorld(), { args: [...FLAGS, "--plan"] });

    expect(code).toBe(0);
    expect(said).toContain("Setup would:");
    expect(questions).toEqual([]);
    expect(log.filter((line) => /^git switch|^wizard$/.test(line))).toEqual([]);
  });
});
