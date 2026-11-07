// One run of the setup program in a terminal, from the plan to the setup PR:
// git runs for real against a bare origin, GitHub and 1Password are a fake
// world that keeps what each run did, and the wizard is a stand-in that
// stores what the Operator would.
import { execFileSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { aReadyOperator, fakeCommands } from "../__fixtures__/setupCommands.ts";
import { aWorld, store, type World, worldScript } from "../__fixtures__/setupWorld.ts";
import { tempDir } from "../__fixtures__/skillsArchive.ts";
import { type Env, type Run, spawnRun } from "./exec.ts";
import { runSetup } from "./program.ts";
import type { Prompt } from "./prompt.ts";
import { WIZARD_SECOND_SUBSCRIPTION_ENV } from "./wizard.ts";

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

/** The Operator walks every stage, and stores a second Subscription's token in its stage. */
const addsASecondSubscription: Wizard = async (world, wizardEnv) => {
  await walksEveryStage(world, wizardEnv);
  store(world, "Fabrik", "Claude token 2");
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
  /** Whether stdin is a terminal. Without one, setup asks nothing. */
  readonly terminal?: boolean;
}

async function setupOnce(world: World, { answers = ["y"], wizard = walksEveryStage, args = FLAGS, terminal = true }: Options = {}) {
  const log: string[] = [];
  const said: string[] = [];
  const complaints: string[] = [];
  const wizardRuns: { cwd: string; env: Env }[] = [];
  const commands = fakeCommands({ ...aReadyOperator(checkout), ...worldScript(world, { commitsAhead }) });
  const run: Run = async (command, commandArgs, options) => {
    log.push([command, ...commandArgs].join(" "));
    return command === "git" ? spawnRun(command, commandArgs, options) : commands.run(command, commandArgs, options);
  };
  const prompt = scripted(answers);
  const code = await runSetup([".", "v1.4.2", ...args], {
    run,
    env,
    cwd: checkout,
    prompt: terminal ? prompt : null,
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

/** As GitHub counts them for a PR: the commits on origin's head that its base lacks, none when the head isn't there. */
function commitsAhead(base: string, head: string): number {
  try {
    return Number(originGit("rev-list", "--count", `${base}..${head}`).trim());
  } catch {
    return 0;
  }
}

/** The Operator merges the setup PR by fast-forwarding main. */
function mergeTheSetupPr(world: World): void {
  git("switch", "-q", "main");
  git("merge", "-q", "--ff-only", BRANCH);
  git("push", "-q", "origin", "main");
  world.prs[0]!.open = false;
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
    // With no second Subscription asked for, so the wizard's stage says setup doesn't list one.
    expect(wizardRuns[0]?.env[WIZARD_SECOND_SUBSCRIPTION_ENV]).toBe("no");
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

  it("with a second Subscription, the setup PR lists it in the Kit config once the wizard's stage has stored its token", async () => {
    const world = aWorld();
    const starter = await readFile(join(KIT_DIR, "templates", "fabrik-config.json"), "utf8");

    const { code, said, wizardRuns } = await setupOnce(world, { wizard: addsASecondSubscription, args: ["--no-time-zone", "--second-subscription", "--no-paused"] });

    expect(code).toBe(0);
    // So the wizard's stage says setup lists it, rather than asking for a hand edit.
    expect(wizardRuns[0]?.env[WIZARD_SECOND_SUBSCRIPTION_ENV]).toBe("yes");
    expect(originGit("show", `${BRANCH}:.fabrik/config.json`)).toBe(
      starter.replace('  "subscriptions": ["Claude token"],\n', '  "subscriptions": ["Claude token", "Claude token 2"],\n'),
    );
    expect(git("status", "--porcelain")).toBe("");
    const body = world.prs[0]?.body ?? "";
    expect(body).toContain('- write .fabrik/config.json (list the second Subscription, "Claude token 2", in subscriptions)');
    expect(body).not.toContain("A second Subscription");
    // The plan, before the wizard, says this run lists it.
    expect(said.some((line) => line.endsWith("Setup then lists it in subscriptions in .fabrik/config.json, in the setup PR."))).toBe(true);
    expect(said.join("\n")).not.toContain("run setup again, and it lists it");
  });

  it("with a second Subscription whose stage the Operator skipped, lists nothing and says to walk it and run setup again", async () => {
    const world = aWorld();

    const { code } = await setupOnce(world, { args: ["--no-time-zone", "--second-subscription", "--no-paused"] });

    expect(code).toBe(0);
    expect(JSON.parse(originGit("show", `${BRANCH}:.fabrik/config.json`)).subscriptions).toEqual(["Claude token"]);
    expect(world.prs[0]?.body).toMatch(/Walk the wizard's "A second Subscription" stage: .* Then run setup again, and it lists it in subscriptions in \.fabrik\/config\.json\./);
  });

  it("with --paused on a fresh repo, the setup PR says the starter pauses Dispatch, not that --paused had no effect", async () => {
    const world = aWorld();

    const { code, said } = await setupOnce(world, { args: ["--no-time-zone", "--no-second-subscription", "--paused"] });

    expect(code).toBe(0);
    expect(JSON.parse(originGit("show", `${BRANCH}:.fabrik/config.json`)).max_in_flight).toBe(0);
    expect(world.prs[0]?.body).toContain("but Dispatch paused (max_in_flight 0)");
    expect(world.prs[0]?.body).not.toContain("--paused had no effect");
    expect(said.join("\n")).not.toContain("--paused had no effect");
  });

  it("unpaused on a fresh repo with ready-for-agent issues, warns in the setup PR and the closing lines that Dispatch releases them on the merge", async () => {
    const world = aWorld();
    world.labels.add("ready-for-agent");
    world.readyForAgent = 2;
    const warning = "2 open issues are labelled ready-for-agent: Dispatch starts releasing them to Implementers as soon as the setup PR merges.";

    const { code, said } = await setupOnce(world);

    expect(code).toBe(0);
    expect(world.prs[0]?.body).toContain(`- ${warning}`);
    expect(said.slice(said.indexOf("The setup PR: https://github.com/acme/clinic/pull/1")).some((line) => line.startsWith(`- ${warning}`))).toBe(true);
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

  it.each(["package.json", ".fabrik/skills.lock.json"])(
    "on the setup branch, stops at an uncommitted %s, a file setup reads but never writes",
    async (path) => {
      const world = aWorld();
      world.failingLabels.add("needs-info");
      await setupOnce(world);
      world.failingLabels.clear();
      await writeFile(join(checkout, path), "{}\n");

      const { code, complaints, log } = await setupOnce(world);

      expect(code).toBe(1);
      expect(complaints[0]).toBe(`${BRANCH} has uncommitted changes setup didn't make (${path}). Commit or stash them, then run setup again.`);
      expect(log.filter((line) => /^git commit/.test(line))).toEqual([]);
    },
  );

  it("leaves out of the setup commit a file setup reads but never writes, edited while the wizard ran", async () => {
    const world = aWorld();
    const editsPackageJson: Wizard = async (world, wizardEnv) => {
      await walksEveryStage(world, wizardEnv);
      await writeFile(join(checkout, "package.json"), '{ "name": "clinic" }\n');
    };

    const { code } = await setupOnce(world, { wizard: editsPackageJson });

    expect(code).toBe(0);
    expect(filesOnOrigin()).not.toContain("package.json");
    expect(git("status", "--porcelain")).toBe("?? package.json\n");
  });

  it("a run on a working install plans nothing, opens no PR and says the install is complete", async () => {
    const world = aWorld();
    await setupOnce(world);
    mergeTheSetupPr(world);

    const { code, said, log, questions } = await setupOnce(world);

    expect(code).toBe(0);
    expect(said).toContain("Nothing to do: this repo's Fabrik install is complete.");
    expect(questions).toEqual([]);
    expect(log.filter((line) => /^gh pr (create|edit)|^git (switch|commit|push)|^wizard$/.test(line))).toEqual([]);
    expect(world.prs).toHaveLength(1);
  });

  it("opens its own setup PR, leaving alone a fork's open PR from a branch of the same name", async () => {
    const world = aWorld();
    const forkBody = "## What setup did\n\n- merge this with your admin bypass\n";
    world.prs.push({
      number: 1,
      url: "https://github.com/acme/clinic/pull/1",
      head: BRANCH,
      base: "main",
      isCrossRepository: true,
      body: forkBody,
      open: true,
    });

    const { code, said, log } = await setupOnce(world);

    expect(code).toBe(0);
    expect(log.some((line) => line.startsWith("gh pr edit"))).toBe(false);
    expect(world.prs[0]!.body).toBe(forkBody);
    expect(world.prs[1]).toEqual(expect.objectContaining({ number: 2, head: BRANCH, isCrossRepository: false, open: true }));
    expect(world.prs[1]!.body).not.toContain("admin bypass\n");
    expect(said).toContain("The setup PR: https://github.com/acme/clinic/pull/2");
    expect(said).not.toContain("- merge this with your admin bypass");
  });

  it("a repair that writes no file applies it, pushes nothing, opens no PR and goes back to the default branch", async () => {
    const world = aWorld();
    await setupOnce(world);
    mergeTheSetupPr(world);
    world.labels.delete("needs-triage");

    const { code, said, complaints, log } = await setupOnce(world);

    expect(complaints).toEqual([]);
    expect(code).toBe(0);
    expect(said).toContain("- create the label needs-triage");
    expect(log.filter((line) => /^git (commit|push)|^gh pr (create|edit)/.test(line))).toEqual([]);
    expect(world.prs).toHaveLength(1);
    expect(said).toContain("Every file setup writes is already on main, so there's no setup PR to open. Setup switched back to main.");
    expect(said.join("\n")).not.toMatch(/The setup PR:|Merge it yourself|Don't merge it yet/);
    expect(git("branch", "--show-current").trim()).toBe("main");
    expect(git("branch", "--list", BRANCH)).toBe("");
    expect((await setupOnce(world)).said).toContain("Nothing to do: this repo's Fabrik install is complete.");
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

  it.each([
    ["with --plan", { args: [...FLAGS, "--plan"] }, "Run setup again without --plan to do it."],
    ["without a terminal", { terminal: false }, "Setup carries the plan out only on your yes, so run it in a terminal to do it."],
  ])("%s on the setup branch with nothing left to apply, says the wizard and the setup PR are left, not that the install is complete", async (_, options, toDoIt) => {
    const world = aWorld();
    await setupOnce(world, { wizard: skipsTheClaudeToken });

    const { code, said, log } = await setupOnce(world, options);

    expect(code).toBe(0);
    expect(said).not.toContain("Nothing to do: this repo's Fabrik install is complete.");
    expect(said).toContain(`${BRANCH} already holds what an earlier run of setup applied.`);
    expect(said).toContain(`What's left is the wizard, then pushing ${BRANCH} and opening or updating the setup PR.`);
    expect(said).toContain(toDoIt);
    expect(log.filter((line) => /^git (switch|commit|push)|^gh pr (create|edit)|^wizard$/.test(line))).toEqual([]);
  });

  it("with --plan in a terminal, prints the plan and asks no yes", async () => {
    const { code, said, questions, log } = await setupOnce(aWorld(), { args: [...FLAGS, "--plan"] });

    expect(code).toBe(0);
    expect(said).toContain("Setup would:");
    expect(questions).toEqual([]);
    expect(log.filter((line) => /^git switch|^wizard$/.test(line))).toEqual([]);
  });
});
