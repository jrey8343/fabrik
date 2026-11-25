// One run of the setup program in a terminal, from the plan to the setup PR:
// git runs for real against a bare origin, GitHub and 1Password are a fake
// world that keeps what each run did, and the wizard is a stand-in that
// stores what the Operator would.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { aReadyOperator, fakeCommands } from "../__fixtures__/setupCommands.ts";
import { anEnvironment, aWorld, environmentOf, store, type World, type WorldEnvironment, worldScript } from "../__fixtures__/setupWorld.ts";
import { tempDir } from "../__fixtures__/skillsArchive.ts";
import { resolveKitConfig } from "../kit/config.ts";
import { type Env, type Run, spawnRun } from "./exec.ts";
import { runSetup } from "./program.ts";
import type { Prompt } from "./prompt.ts";
import { pinCaller } from "./shims.ts";
import { WIZARD_SECOND_SUBSCRIPTION_ENV } from "./wizard.ts";

const KIT_DIR = resolve(import.meta.dirname, "..", "..");
const BRANCH = "fabrik/setup-v1.4.2";
/** Every question but the yes answered by a flag. */
const FLAGS = ["--no-production", "--no-staging", "--no-time-zone", "--no-second-subscription", "--no-paused"];

let origin: string;
let checkout: string;
let env: Env;

/** The Kit's three Actions secrets, by name, in the order Setup makes their accounts. */
const TOKENS = ["FABRIK_OP_AGENT_TOKEN", "FABRIK_OP_IMPLEMENT_TOKEN", "FABRIK_OP_PUSH_TOKEN"];

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

/** The Operator ends the wizard at its banner, so it reports nothing and stores nothing. */
const endsAtTheBanner: Wizard = async () => {};

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
  /** What happens elsewhere as the run goes, given each command line before it runs, as when someone changes the repo on github.com meanwhile. */
  readonly during?: (line: string) => void;
}

async function setupOnce(world: World, { answers = ["y"], wizard = walksEveryStage, args = FLAGS, terminal = true, during }: Options = {}) {
  const log: string[] = [];
  const said: string[] = [];
  const complaints: string[] = [];
  const wizardRuns: { cwd: string; env: Env }[] = [];
  const commands = fakeCommands({ ...aReadyOperator(checkout), ...worldScript(world, { commitsAhead, compare }) });
  const run: Run = async (command, commandArgs, options) => {
    log.push([command, ...commandArgs].join(" "));
    during?.(log.at(-1)!);
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

/** The Operator squash-merges the setup PR: one new commit on main, and the setup branch left as it was. */
function squashTheSetupPr(world: World): void {
  const head = originGit("rev-parse", BRANCH).trim();
  git("switch", "-q", "main");
  git("merge", "-q", "--squash", BRANCH);
  git("commit", "-q", "-m", "Set up Fabrik v1.4.2 (#1)");
  git("push", "-q", "origin", "main");
  Object.assign(world.prs[0]!, { open: false, merged: true, headRefOid: head });
}

/** GitHub moves the setup PR's head on after setup's last push, as its "Update branch" button does: a commit on origin's setup branch the clone never fetches. */
function moveTheHeadOnGitHub(): void {
  const tip = originGit("rev-parse", BRANCH).trim();
  const moved = originGit("-c", "user.name=GitHub", "-c", "user.email=noreply@github.com", "commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "Merge main");
  originGit("update-ref", `refs/heads/${BRANCH}`, moved.trim());
}

/** A clone of origin that does to it what GitHub does, with its own commits and pushes. */
async function aGitHubClone(): Promise<{ dir: string; git: (...args: string[]) => string }> {
  const dir = await tempDir("setup-github");
  const github = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=GitHub", "-c", "user.email=noreply@github.com", ...args], { cwd: dir, encoding: "utf8", env: env as NodeJS.ProcessEnv });
  github("clone", "-q", origin, ".");
  return { dir, git: github };
}

/** Another PR lands on origin's main, one that changes no file of setup's. */
async function anotherPrOnGitHub(): Promise<void> {
  const github = await aGitHubClone();
  await writeFile(join(github.dir, "CHANGELOG.md"), "# Changes\n");
  github.git("add", "CHANGELOG.md");
  github.git("commit", "-q", "-m", "Another PR");
  github.git("push", "-q", "origin", "main");
}

/**
 * GitHub's "Update with rebase" replays the open setup PR's commits onto
 * origin's main and force-pushes them. The PR's timeline keeps the head that
 * force-push replaced.
 */
async function updateWithRebaseOnGitHub(world: World): Promise<void> {
  const github = await aGitHubClone();
  const replaced = github.git("rev-parse", `origin/${BRANCH}`).trim();
  github.git("switch", "-q", BRANCH);
  github.git("rebase", "-q", "main");
  github.git("push", "-q", "--force", "origin", BRANCH);
  const pr = world.prs.find((candidate) => candidate.open && candidate.head === BRANCH && !candidate.isCrossRepository);
  if (pr !== undefined) (pr.forcePushedFrom ??= []).push(replaced);
}

/** Another PR lands on main, then GitHub's "Update with rebase" replays the setup PR's commits onto it: origin's setup branch no longer holds the clone's tip. */
async function rebaseTheHeadOnGitHub(world: World): Promise<void> {
  await anotherPrOnGitHub();
  await updateWithRebaseOnGitHub(world);
}

/**
 * The repo's .gitignore, which setup adds its block to, and a line of it that
 * another PR changes once the setup PR is open.
 */
async function aGitignoreOnMain(): Promise<void> {
  await writeFile(join(checkout, ".gitignore"), "node_modules\ndist\n.env\n");
  git("add", ".gitignore");
  git("commit", "-q", "-m", "Ignore the build");
  git("push", "-q", "origin", "main");
}

/**
 * Another PR changes a line next to setup's block in .gitignore, then GitHub's
 * "Update with rebase" replays the setup PR's commits onto it. The rebase goes
 * through, but the copy's change has other lines around it.
 */
async function rebaseOverANearbyEditOnGitHub(world: World): Promise<void> {
  const github = await aGitHubClone();
  await writeFile(join(github.dir, ".gitignore"), "node_modules\nbuild\n.env\n");
  github.git("commit", "-q", "-am", "Another PR: the build goes in build");
  github.git("push", "-q", "origin", "main");
  await updateWithRebaseOnGitHub(world);
}

/** A commit on origin's setup branch, made on GitHub as an applied suggestion is: a line added to a file setup wrote. */
async function editOnGitHub(path: string, line: string): Promise<void> {
  const github = await aGitHubClone();
  github.git("switch", "-q", BRANCH);
  await writeFile(join(github.dir, path), `${await readFile(join(github.dir, path), "utf8")}${line}`);
  github.git("commit", "-q", "-am", "Apply suggestion");
  github.git("push", "-q", "origin", BRANCH);
}

/** GitHub squash-merges the setup PR: origin's head, as one new commit on origin's main. The PR's own ref keeps that head. */
async function squashOnGitHub(world: World): Promise<void> {
  const github = await aGitHubClone();
  const head = github.git("rev-parse", `origin/${BRANCH}`).trim();
  github.git("merge", "-q", "--squash", `origin/${BRANCH}`);
  github.git("commit", "-q", "-m", "Set up Fabrik v1.4.2 (#1)");
  github.git("push", "-q", "origin", "main");
  originGit("update-ref", "refs/pull/1/head", head);
  Object.assign(world.prs[0]!, { open: false, merged: true, headRefOid: head });
}

/** Runs the command a stop names, as the Operator pastes it into a terminal with git's default config. */
function follow(complaint: string | undefined): void {
  const command = /with (git .+?), then run setup again/.exec(complaint ?? "")?.[1];
  if (command === undefined) throw new Error(`No command to follow in: ${complaint}`);
  execFileSync("sh", ["-c", command], { cwd: checkout, encoding: "utf8", env: env as NodeJS.ProcessEnv, stdio: "pipe" });
}

/** As GitHub's compare of two commits sums it up: how the head stands to the base, null when origin lacks either. */
function compare(base: string, head: string): string | null {
  try {
    const behind = Number(originGit("rev-list", "--count", `${head}..${base}`).trim());
    const ahead = Number(originGit("rev-list", "--count", `${base}..${head}`).trim());
    if (behind === 0) return ahead === 0 ? "identical" : "ahead";
    return ahead === 0 ? "behind" : "diverged";
  } catch {
    return null;
  }
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

  it("with skills the SessionStart hook installed left untracked, as after a setup PR was closed, runs and commits none of them", async () => {
    await mkdir(join(checkout, ".claude/skills/tdd"), { recursive: true });
    await writeFile(join(checkout, ".claude/skills/tdd/SKILL.md"), "# tdd\n");
    const world = aWorld();

    const { code, said, complaints } = await setupOnce(world);

    expect(complaints).toEqual([]);
    expect(code).toBe(0);
    expect(filesOnOrigin().sort()).toEqual(["README.md", ...new Set(writtenIn(said))].sort());
    expect(git("status", "--porcelain")).toBe("");
  });

  it("on a protected default branch, changes only the protection settings setup owns, names each change, and keeps the rest as GitHub has them", async () => {
    const world = aWorld();
    world.protection = {
      required_status_checks: { strict: true, contexts: ["ci"], checks: [{ context: "ci", app_id: 15368 }] },
      enforce_admins: { enabled: true },
      required_linear_history: { enabled: true },
      required_conversation_resolution: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      block_creations: { enabled: false },
      lock_branch: { enabled: false },
      allow_fork_syncing: { enabled: true },
    };

    const { calls, said } = await setupOnce(world);

    const puts = calls.filter((call) => call.line.startsWith("gh api --method PUT repos/acme/clinic/branches/main/protection "));
    expect(puts.map((call) => JSON.parse(call.input ?? ""))).toEqual([
      {
        required_status_checks: { strict: true, checks: [{ context: "ci", app_id: 15368 }] },
        enforce_admins: true,
        required_pull_request_reviews: {
          dismiss_stale_reviews: true,
          require_code_owner_reviews: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
        },
        restrictions: null,
        required_linear_history: true,
        allow_force_pushes: false,
        allow_deletions: false,
        block_creations: false,
        required_conversation_resolution: true,
        lock_branch: false,
        allow_fork_syncing: true,
      },
    ]);
    expect(said).toContain("- protect main: a pull request: not required → required; every other setting stays as it is");
  });

  it("with the checkout's Kit config naming the Console's App, requires the Console check from that App, and says so in the plan it shows before the Operator's yes", async () => {
    await mkdir(join(checkout, ".fabrik"));
    await writeFile(join(checkout, ".fabrik", "config.json"), `${JSON.stringify({ sandbox: { checks: ["test"] }, console: { app_id: 42 } }, null, 2)}\n`);
    git("add", ".fabrik");
    git("commit", "-q", "-m", "Our Kit config");
    git("push", "-q", "origin", "main");
    const world = aWorld();

    const { code, calls, said } = await setupOnce(world);

    expect(code).toBe(0);
    const puts = calls.filter((call) => call.line.startsWith("gh api --method PUT repos/acme/clinic/branches/main/protection "));
    expect(puts.map((call) => JSON.parse(call.input ?? "").required_status_checks)).toEqual([
      { strict: false, checks: [{ context: "test" }, { context: "Merge from the Console", app_id: 42 }] },
    ]);
    const note = said.findIndex((line) => line.startsWith("- The Kit config names the Console's App (console.app_id is 42), so from this run on main merges only from the Console"));
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(said.indexOf("What setup did:"));
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

    expect(said.some((line) => line.startsWith("Merge it yourself once its Required checks pass."))).toBe(true);
    expect(world.prs[0]?.body).toContain("Merge this PR yourself once its Required checks pass.");
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

  it("with the Claude token stage skipped, asks for the merge when the Kit config lists only a Subscription under another name, as the Kit never reads the Claude token", async () => {
    await mkdir(join(checkout, ".fabrik"));
    await writeFile(join(checkout, ".fabrik", "config.json"), '{\n  "subscriptions": ["Claude backup"]\n}\n');
    git("add", ".fabrik/config.json");
    git("commit", "-q", "-m", "Our Kit config");
    git("push", "-q", "origin", "main");
    const world = aWorld();
    store(world, "Fabrik", "Claude backup");

    const { code, said } = await setupOnce(world, { wizard: skipsTheClaudeToken });

    expect(code).toBe(0);
    expect(said.some((line) => line.startsWith("Merge it yourself once its Required checks pass."))).toBe(true);
    expect(said).not.toContain('- the Claude token, in the "Fabrik" vault');
    expect(world.prs[0]?.body).not.toContain("Don't merge this yet.");
  });

  it("with the Kit config listing only a Subscription under another name, which 1Password lacks, doesn't ask for the merge, and names its token to store by hand", async () => {
    await mkdir(join(checkout, ".fabrik"));
    await writeFile(join(checkout, ".fabrik", "config.json"), '{\n  "subscriptions": ["Claude backup"]\n}\n');
    git("add", ".fabrik/config.json");
    git("commit", "-q", "-m", "Our Kit config");
    git("push", "-q", "origin", "main");
    const world = aWorld();

    const { code, said } = await setupOnce(world, { wizard: skipsTheClaudeToken });

    expect(code).toBe(0);
    expect(said.some((line) => line.startsWith("Merge it yourself"))).toBe(false);
    const merging = said.slice(said.indexOf("Don't merge it yet. The Kit's first runs need these, which no wizard stage stores, so you store them yourself, as For the Operator says:"));
    expect(merging.slice(0, 2)).toEqual([
      "Don't merge it yet. The Kit's first runs need these, which no wizard stage stores, so you store them yourself, as For the Operator says:",
      '- the "Claude backup" Subscription\'s token, in the "Fabrik" vault',
    ]);
    expect(merging[2]).toMatch(/^Then merge it yourself once its Required checks pass\. /);
    expect(said.join("\n")).not.toMatch(/the Claude token|walk the wizard for them/);
    const body = world.prs[0]?.body ?? "";
    expect(body).toContain(
      "Don't merge this yet. The Kit's first runs need these, which no wizard stage stores, so you store them yourself, as For the Operator says:\n\n" +
        '- the "Claude backup" Subscription\'s token, in the "Fabrik" vault\n\n' +
        "Then merge this PR yourself once its Required checks pass.",
    );
    expect(body).not.toContain("Merge this PR yourself");
  });

  it("with the Kit config listing a rotation whose later Subscription 1Password lacks, asks for the merge, as the first runs read only the first, and notes the other", async () => {
    await mkdir(join(checkout, ".fabrik"));
    await writeFile(join(checkout, ".fabrik", "config.json"), '{\n  "subscriptions": ["Claude token", "Claude token 2"]\n}\n');
    git("add", ".fabrik/config.json");
    git("commit", "-q", "-m", "Our Kit config");
    git("push", "-q", "origin", "main");
    const world = aWorld();

    const { code, said } = await setupOnce(world);

    expect(code).toBe(0);
    expect(said.some((line) => line.startsWith("Merge it yourself once its Required checks pass."))).toBe(true);
    expect(said.some((line) => line.startsWith("Don't merge it yet."))).toBe(false);
    expect(said.some((line) => line.includes('lists "Claude token 2" in subscriptions, but the "Fabrik" vault has no item of that name'))).toBe(true);
    const body = world.prs[0]?.body ?? "";
    expect(body).toContain("Merge this PR yourself once its Required checks pass.");
    expect(body).not.toContain("Don't merge this yet.");
  });

  describe("the merge ask, from the Kit config the setup PR merges", () => {
    const ownKitConfig = async (config: string) => {
      await mkdir(join(checkout, ".fabrik"));
      await writeFile(join(checkout, ".fabrik", "config.json"), config);
      git("add", ".fabrik/config.json");
      git("commit", "-q", "-m", "Our Kit config");
      git("push", "-q", "origin", "main");
    };

    it("where the setup branch's Kit config holds console.app_id, says to merge from the Console in the setup PR and the closing lines", async () => {
      await ownKitConfig('{\n  "console": { "app_id": 2471093 }\n}\n');
      const world = aWorld();

      const { code, said } = await setupOnce(world);

      expect(code).toBe(0);
      const body = world.prs[0]?.body ?? "";
      expect(body).toContain("Merge this PR from the Console once its Required checks pass. This repo's Kit config names the Console's App (console.app_id)");
      expect(body).not.toContain("Merge this PR yourself");
      expect(said.some((line) => line.startsWith("Merge it from the Console once its Required checks pass."))).toBe(true);
      expect(said.some((line) => line.startsWith("Merge it yourself"))).toBe(false);
    });

    it("on a first setup, whose starter Kit config holds no console.app_id, says to merge it yourself", async () => {
      const world = aWorld();

      await setupOnce(world);

      expect(world.prs[0]?.body).toContain("Merge this PR yourself once its Required checks pass.");
      expect(world.prs[0]?.body).not.toContain("from the Console");
    });

    it("where the setup branch's Kit config is invalid, says to merge it yourself, though it holds console.app_id", async () => {
      await ownKitConfig('{\n  "console": { "app_id": 2471093 },\n  "ui": false\n}\n');
      const world = aWorld();

      const { said } = await setupOnce(world);

      expect(world.prs[0]?.body).toContain("Merge this PR yourself once its Required checks pass.");
      expect(world.prs[0]?.body).not.toContain("from the Console");
      expect(said.some((line) => line.startsWith("Merge it yourself once its Required checks pass."))).toBe(true);
    });
  });

  it("with a second Subscription, the setup PR lists it in the Kit config once the wizard's stage has stored its token", async () => {
    const world = aWorld();
    const starter = await readFile(join(KIT_DIR, "templates", "fabrik-config.json"), "utf8");

    const { code, said, wizardRuns } = await setupOnce(world, { wizard: addsASecondSubscription, args: ["--no-production", "--no-staging", "--no-time-zone", "--second-subscription", "--no-paused"] });

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
    expect(said.join("\n")).not.toContain("Running setup again walks it");
  });

  it("with a second Subscription whose stage the Operator skipped, lists nothing and says to walk it and run setup again", async () => {
    const world = aWorld();

    const { code } = await setupOnce(world, { args: ["--no-production", "--no-staging", "--no-time-zone", "--second-subscription", "--no-paused"] });

    expect(code).toBe(0);
    expect(JSON.parse(originGit("show", `${BRANCH}:.fabrik/config.json`)).subscriptions).toEqual(["Claude token"]);
    expect(world.prs[0]?.body).toMatch(
      /Walk the wizard's "A second Subscription" stage: .* Running setup again walks it, then lists it in subscriptions in \.fabrik\/config\.json: curl -fsSL \S+ \| bash -s -- v1\.4\.2\n/,
    );
  });

  it("with --paused on a fresh repo, the setup PR says the starter pauses Dispatch, not that --paused had no effect", async () => {
    const world = aWorld();

    const { code, said } = await setupOnce(world, { args: ["--no-production", "--no-staging", "--no-time-zone", "--no-second-subscription", "--paused"] });

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

  it("with --paused, a run after one that wrote the starter and stopped partway says nothing about --paused having had no effect", async () => {
    const world = aWorld();
    world.failingLabels.add("needs-info");
    const args = ["--no-production", "--no-staging", "--no-time-zone", "--no-second-subscription", "--paused"];
    await setupOnce(world, { args });
    world.failingLabels.clear();

    const { code, said } = await setupOnce(world, { args });

    expect(code).toBe(0);
    expect(world.prs[0]?.body).toContain("but Dispatch paused (max_in_flight 0)");
    expect(world.prs[0]?.body).not.toContain("--paused had no effect");
    expect(said.join("\n")).not.toContain("--paused had no effect");
  });

  it("unpaused, a run after one that wrote the starter and stopped partway still warns that Dispatch releases the ready-for-agent issues on the merge", async () => {
    const world = aWorld();
    world.labels.add("ready-for-agent");
    world.readyForAgent = 2;
    world.failingLabels.add("needs-info");
    await setupOnce(world);
    world.failingLabels.clear();
    const warning = "2 open issues are labelled ready-for-agent: Dispatch starts releasing them to Implementers as soon as the setup PR merges.";

    const { code, said } = await setupOnce(world);

    expect(code).toBe(0);
    expect(said.slice(0, said.indexOf(`On ${BRANCH}.`)).some((line) => line.startsWith(`- ${warning}`))).toBe(true);
    expect(world.prs[0]?.body).toContain(`- ${warning}`);
    expect(said.slice(said.indexOf("The setup PR: https://github.com/acme/clinic/pull/1")).some((line) => line.startsWith(`- ${warning}`))).toBe(true);
  });

  describe("pausing the starter on the setup branch, which is still setup's own", () => {
    const PAUSED = "Dispatch is paused, so no Implementer starts until you set max_in_flight in .fabrik/config.json above 0.";
    const WARNING = "2 open issues are labelled ready-for-agent: Dispatch starts releasing them to Implementers as soon as the setup PR merges.";
    const PAUSES = "- write .fabrik/config.json (the starter Kit config, with Dispatch paused now (max_in_flight 0))";
    const withPaused = (paused: boolean) => ["--no-production", "--no-staging", "--no-time-zone", "--no-second-subscription", paused ? "--paused" : "--no-paused"];
    const closingOf = (said: string[]) => said.slice(said.indexOf("The setup PR: https://github.com/acme/clinic/pull/1"));
    const maxInFlight = () => JSON.parse(originGit("show", `${BRANCH}:.fabrik/config.json`)).max_in_flight;

    const withReadyIssues = () => {
      const world = aWorld();
      world.labels.add("ready-for-agent");
      world.readyForAgent = 2;
      return world;
    };

    it.each([
      ["opened the setup PR", false],
      ["stopped partway", true],
    ])("with --paused after an unpaused run %s, pauses Dispatch in it, and the setup PR and the closing lines say so", async (_, partway) => {
      const world = withReadyIssues();
      if (partway) world.failingLabels.add("needs-info");
      await setupOnce(world);
      world.failingLabels.clear();

      const { code, said } = await setupOnce(world, { args: withPaused(true) });

      expect(code).toBe(0);
      expect(maxInFlight()).toBe(0);
      const body = world.prs[0]!.body;
      expect(body).toContain(PAUSES);
      expect(body).toContain(PAUSED);
      expect(body).not.toContain(WARNING);
      expect(said.join("\n")).not.toContain("--paused had no effect");
      expect(closingOf(said).some((line) => line.startsWith(`- ${PAUSED}`))).toBe(true);
      expect(closingOf(said).some((line) => line.includes(WARNING))).toBe(false);
    });

    it("with --plan, after an unpaused run stopped partway, plans the same pause as the run that carries it out, which plans nothing more after the wizard", async () => {
      const world = withReadyIssues();
      world.failingLabels.add("needs-info");
      await setupOnce(world);
      world.failingLabels.clear();

      const planned = await setupOnce(world, { args: [...withPaused(true), "--plan"] });
      const { said } = await setupOnce(world, { args: withPaused(true) });

      expect(planned.said).toContain(PAUSES);
      expect(planned.said.join("\n")).not.toMatch(/--paused had no effect|Dispatch starts releasing/);
      expect(said.slice(said.indexOf("Setup would:"), said.indexOf(`On ${BRANCH}.`))).toContain(PAUSES);
      expect(said.join("\n")).not.toContain("Setup found more to do after the wizard");
    });

    it("in a run after a paused one stopped partway, asks again, offering the pause, and the closing lines say Dispatch is paused", async () => {
      const world = withReadyIssues();
      world.failingLabels.add("needs-info");
      await setupOnce(world, { args: withPaused(true) });
      world.failingLabels.clear();

      const { code, said, questions } = await setupOnce(world, { args: ["--no-production", "--no-staging", "--no-time-zone", "--no-second-subscription"], answers: ["", "y"] });

      expect(code).toBe(0);
      expect(questions[0]).toBe("Install with Dispatch paused, so no Implementer starts until you raise max_in_flight? [Y/n] ");
      expect(maxInFlight()).toBe(0);
      expect(world.prs[0]!.body).toContain(PAUSED);
      expect(closingOf(said).some((line) => line.startsWith(`- ${PAUSED}`))).toBe(true);
    });

    it("with --no-paused after a paused run opened the setup PR, gives it the v1 default max_in_flight, and the setup PR and the closing lines warn about the ready-for-agent issues", async () => {
      const world = withReadyIssues();
      await setupOnce(world, { args: withPaused(true) });

      const { code, said } = await setupOnce(world, { args: withPaused(false) });

      expect(code).toBe(0);
      expect(maxInFlight()).toBe(2);
      expect(world.prs[0]!.body).toContain(WARNING);
      expect(world.prs[0]!.body).not.toContain(PAUSED);
      expect(closingOf(said).some((line) => line.startsWith(`- ${WARNING}`))).toBe(true);
      expect(closingOf(said).some((line) => line.includes(PAUSED))).toBe(false);
    });

    it("pausing again after a run that took back an earlier pause, ends what setup did on the pause, in the setup PR and the closing lines", async () => {
      const world = withReadyIssues();
      await setupOnce(world);
      await setupOnce(world, { args: withPaused(true) });
      await setupOnce(world, { args: withPaused(false) });

      const { code, said } = await setupOnce(world, { args: withPaused(true) });

      expect(code).toBe(0);
      expect(maxInFlight()).toBe(0);
      const configSteps = (lines: readonly string[]) => lines.filter((line) => line.startsWith("- write .fabrik/config.json ("));
      expect(configSteps(world.prs[0]!.body.split("\n")).at(-1)).toBe(PAUSES);
      expect(configSteps(closingOf(said)).at(-1)).toBe(PAUSES);
    });

    it("with --paused and the Product's own Kit config, which doesn't pause Dispatch, doesn't say Dispatch is paused", async () => {
      await mkdir(join(checkout, ".fabrik"));
      await writeFile(join(checkout, ".fabrik", "config.json"), '{\n  "max_in_flight": 3\n}\n');
      git("add", ".fabrik/config.json");
      git("commit", "-q", "-m", "Our Kit config");
      git("push", "-q", "origin", "main");
      const world = aWorld();

      const { code, said } = await setupOnce(world, { args: withPaused(true) });

      expect(code).toBe(0);
      expect(world.prs[0]!.body).toContain("--paused had no effect: .fabrik/config.json already exists, with max_in_flight 3.");
      expect(world.prs[0]!.body).not.toContain(PAUSED);
      expect(closingOf(said).some((line) => line.includes(PAUSED))).toBe(false);
    });
  });

  describe("the closing lines' Then list, with the Product's own Kit config", () => {
    const THEN = {
      checks: "- List the CI checks",
      extraSkills: "- To give roles Extra skills",
      monitor: "- The Monitor files an issue",
      visualEvidence: "- With Visual evidence on",
    };
    const thenOf = (said: string[]) => said.slice(said.indexOf("Then:") + 1);
    const ownKitConfig = async (config: object | string, skillsLock?: string) => {
      await mkdir(join(checkout, ".fabrik"));
      await writeFile(join(checkout, ".fabrik", "config.json"), typeof config === "string" ? config : `${JSON.stringify(config, null, 2)}\n`);
      if (skillsLock !== undefined) await writeFile(join(checkout, ".fabrik", "skills.lock.json"), skillsLock);
      git("add", ".fabrik");
      git("commit", "-q", "-m", "Our Kit config");
      git("push", "-q", "origin", "main");
    };
    const storesTheSentryToken: Wizard = async (world, wizardEnv) => {
      await walksEveryStage(world, wizardEnv);
      store(world, "Fabrik App", "Sentry token");
    };

    it("leaves out the notes for the checks branch protection now requires, the Sentry token stored and ui set, from the setup branch's Kit config", async () => {
      await ownKitConfig({
        sandbox: { checks: ["gate"] },
        monitor: { errors: { provider: "sentry", org: "acme", project: "clinic" } },
        ui: { paths: ["src/**"], serve: "npm run preview", url: "http://localhost:4321" },
      });
      const world = aWorld();

      const { code, said } = await setupOnce(world, { wizard: storesTheSentryToken });

      expect(code).toBe(0);
      const then = thenOf(said);
      expect(then.some((line) => line.startsWith(THEN.checks))).toBe(false);
      expect(then.some((line) => line.startsWith(THEN.monitor))).toBe(false);
      expect(then.some((line) => line.startsWith(THEN.visualEvidence))).toBe(false);
      expect(then.some((line) => line.startsWith(THEN.extraSkills))).toBe(true);
      expect(then.some((line) => line.startsWith("- Running setup again repairs the install"))).toBe(true);
    });

    it("leaves out the Extra skills note once the setup branch's lockfile pins a source some role picks from", async () => {
      await ownKitConfig(
        { roles: { design: { skills: ["acme/skills/event-storming"] } } },
        `${JSON.stringify([{ repository: "acme/skills", sha: "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d" }])}\n`,
      );

      const { code, said } = await setupOnce(aWorld());

      expect(code).toBe(0);
      expect(thenOf(said).some((line) => line.startsWith(THEN.extraSkills))).toBe(false);
      expect(thenOf(said).some((line) => line.startsWith(THEN.visualEvidence))).toBe(true);
    });

    it("gives every note when the setup branch's Kit config is invalid, however much it lists", async () => {
      await ownKitConfig('{ "sandbox": { "checks": ["gate"] }, "ui": false }\n');

      const { said } = await setupOnce(aWorld());

      for (const start of Object.values(THEN)) expect(thenOf(said).some((line) => line.startsWith(start))).toBe(true);
    });

    it("gives every note on a fresh repo, whose starter Kit config lists no checks, no Sentry project and no ui", async () => {
      const { code, said } = await setupOnce(aWorld());

      expect(code).toBe(0);
      for (const start of Object.values(THEN)) expect(thenOf(said).some((line) => line.startsWith(start))).toBe(true);
    });
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

  it("a later run whose wizard ends at its banner keeps the setup PR asking for the merge, the App's install confirmed in an earlier run", async () => {
    const world = aWorld();
    await setupOnce(world);
    expect(world.prs[0]!.body).toContain("Merge this PR yourself");

    const { code, said } = await setupOnce(world, { wizard: endsAtTheBanner });

    expect(code).toBe(0);
    expect(world.prs[0]!.body).toContain("Merge this PR yourself");
    expect(world.prs[0]!.body).not.toContain("the Fabrik App, installed on acme/clinic");
    expect(said.some((line) => line.startsWith("Merge it yourself"))).toBe(true);
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
    const planned = said.slice(said.indexOf("Setup would:"), said.indexOf(`On ${BRANCH}.`));
    expect(writtenIn(planned)).toEqual([]);
    expect(planned).toContain("- create the label needs-info");
    expect(planned).not.toContain("- create the label needs-triage");
    expect(log.filter((line) => line.startsWith("git switch"))).toEqual([]);
    expect(filesOnOrigin()).toEqual(expect.arrayContaining([".github/workflows/fabrik.yml", ".fabrik/config.json"]));
    expect(world.prs).toHaveLength(1);
    // What the first run did before it stopped is in the PR too.
    for (const done of ["- write .github/workflows/fabrik.yml (", "- create the label needs-triage", "- create the label needs-info"]) {
      expect(world.prs[0]!.body).toContain(done);
    }
    const closing = said.slice(said.indexOf("What setup did:"));
    expect(closing).toContain("- create the label needs-triage");
  });

  it.each([
    ["", false],
    [", which the clone fetched", true],
  ])("on the setup branch after applying stopped partway and another PR landed on main%s, says to merge main in, which works, then picks up", async (_, fetched) => {
    const world = aWorld();
    world.failingLabels.add("needs-info");
    await setupOnce(world);
    world.failingLabels.clear();
    await anotherPrOnGitHub();
    if (fetched) git("fetch", "-q", "origin");

    const behind = await setupOnce(world);

    expect(behind.complaints[0]).toMatch(new RegExp(`^${BRANCH} doesn't hold origin's latest main \\(\\w{7}\\)\\. Merge it in with git pull --no-rebase origin main, then run setup again\\.$`));
    follow(behind.complaints[0]);
    const { code, complaints, said } = await setupOnce(world);
    expect(complaints).toEqual([]);
    expect(code).toBe(0);
    expect(said).toContain("- create the label needs-info");
    expect(filesOnOrigin()).toEqual(expect.arrayContaining(["CHANGELOG.md", ".github/workflows/fabrik.yml", ".fabrik/config.json"]));
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

  it("on the setup branch, stops at an uncommitted CLAUDE.md, a file setup writes only in some repos and the earlier run didn't", async () => {
    const world = aWorld();
    world.failingLabels.add("needs-info");
    const first = await setupOnce(world);
    expect(writtenIn(first.said)).toContain("AGENTS.md");
    world.failingLabels.clear();
    await writeFile(join(checkout, "CLAUDE.md"), "# My own notes, half written\n");

    const { code, complaints, log } = await setupOnce(world);

    expect(code).toBe(1);
    expect(complaints[0]).toBe(`${BRANCH} has uncommitted changes setup didn't make (CLAUDE.md). Commit or stash them, then run setup again.`);
    expect(log.filter((line) => /^git commit/.test(line))).toEqual([]);
  });

  it("leaves out of the setup commit a file setup writes only in some repos, made while the wizard ran in a run that didn't write it", async () => {
    const world = aWorld();
    const startsClaudeMd: Wizard = async (world, wizardEnv) => {
      await walksEveryStage(world, wizardEnv);
      await writeFile(join(checkout, "CLAUDE.md"), "# My own notes, half written\n");
    };

    const { code } = await setupOnce(world, { wizard: startsClaudeMd });

    expect(code).toBe(0);
    expect(filesOnOrigin()).toContain("AGENTS.md");
    expect(filesOnOrigin()).not.toContain("CLAUDE.md");
    expect(git("status", "--porcelain")).toBe("?? CLAUDE.md\n");
  });

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

  describe("production's question", () => {
    const OTHERS = ["--no-time-zone", "--no-second-subscription", "--no-paused", "--no-staging"];
    const COMPLETE = "Nothing to do: this repo's Fabrik install is complete.";
    const NAMED = 'the production block: url "https://clinic.example.com", environment "production"';

    it("on a fresh repo, offers what the Deployments carry and writes the block into the starter in the setup PR; once merged, a later run asks nothing and leaves it byte for byte", async () => {
      const world = aWorld();
      world.deployments.push({ environment: "production", url: "https://clinic.example.com" });

      const first = await setupOnce(world, { args: OTHERS, answers: ["", "", "y"] });

      expect(first.code).toBe(0);
      expect(first.questions.slice(0, 2)).toEqual([
        "The environment production's deploys carry in GitHub's Deployments, or none [production]: ",
        "Production's address, or no to leave production out [https://clinic.example.com]: ",
      ]);
      const config = originGit("show", `${BRANCH}:.fabrik/config.json`);
      expect((JSON.parse(config) as Record<string, unknown>)["production"]).toEqual({ url: "https://clinic.example.com", environment: "production" });
      expect(world.prs[0]?.body).toContain(NAMED);
      mergeTheSetupPr(world);

      const again = await setupOnce(world, { args: OTHERS, answers: [] });

      expect(again.code).toBe(0);
      expect(again.questions).toEqual([]);
      expect(again.said).toContain(COMPLETE);
      expect(await readFile(join(checkout, ".fabrik/config.json"), "utf8")).toBe(config);
      expect(again.calls.some((call) => call.line.includes("deployments"))).toBe(false);
    });

    it("adds the block to the Product's own Kit config as one member in the setup PR, and a second run with the same answers writes nothing", async () => {
      const own = '{\n  "max_in_flight": 1\n}\n';
      await mkdir(join(checkout, ".fabrik"));
      await writeFile(join(checkout, ".fabrik/config.json"), own);
      git("add", ".fabrik/config.json");
      git("commit", "-q", "-m", "Kit config");
      git("push", "-q", "origin", "main");
      const world = aWorld();
      const flags = [...OTHERS, "--production-url=https://clinic.example.com", "--production-environment="];

      const first = await setupOnce(world, { args: flags });

      expect(first.code).toBe(0);
      expect(originGit("show", `${BRANCH}:.fabrik/config.json`)).toBe(
        '{\n  "max_in_flight": 1,\n  "production": {\n    "url": "https://clinic.example.com",\n    "environment": null\n  }\n}\n',
      );
      expect(world.prs[0]?.body).toContain('- write .fabrik/config.json (add the production block: url "https://clinic.example.com", environment null)');
      mergeTheSetupPr(world);

      const again = await setupOnce(world, { args: flags, answers: [] });

      expect(again.code).toBe(0);
      expect(again.said).toContain(COMPLETE);
      expect(world.prs).toHaveLength(1);
    });
  });

  describe("staging's question", () => {
    const OTHERS = ["--no-time-zone", "--no-second-subscription", "--no-paused", "--no-production"];
    const COMPLETE = "Nothing to do: this repo's Fabrik install is complete.";
    const trial = { url: "https://staging.clinic.example.com", environment: "staging" };

    it("on a fresh repo, offers what the Deployments carry and writes a block Kit config accepts into the setup PR; once merged, a later run asks nothing and leaves it byte for byte", async () => {
      const world = aWorld();
      world.deployments.push({ environment: "staging", url: "https://staging.clinic.example.com" }, { environment: "production", url: "https://clinic.example.com" });

      const first = await setupOnce(world, { args: OTHERS, answers: ["", "", "y"] });

      expect(first.code).toBe(0);
      expect(first.questions.slice(0, 2)).toEqual([
        "The environment staging's deploys carry in GitHub's Deployments, or none to leave staging out [staging]: ",
        "Staging's address, or no to leave staging out [https://staging.clinic.example.com]: ",
      ]);
      const config = originGit("show", `${BRANCH}:.fabrik/config.json`);
      const resolved = resolveKitConfig({ config });
      expect(resolved.ok && resolved.config.staging).toEqual(trial);
      expect(world.prs[0]?.body).toContain('the staging block: url "https://staging.clinic.example.com", environment "staging"');
      mergeTheSetupPr(world);

      const again = await setupOnce(world, { args: OTHERS, answers: [] });

      expect(again.code).toBe(0);
      expect(again.questions).toEqual([]);
      expect(again.said).toContain(COMPLETE);
      expect(await readFile(join(checkout, ".fabrik/config.json"), "utf8")).toBe(config);
      expect(again.calls.some((call) => call.line.includes("deployments"))).toBe(false);
    });

    it("leaves the starter's staging null when the Operator declines, and asks again on the next run", async () => {
      const world = aWorld();
      world.deployments.push({ environment: "staging", url: "https://staging.clinic.example.com" });

      const first = await setupOnce(world, { args: OTHERS, answers: ["none", "y"] });

      expect(first.code).toBe(0);
      expect(JSON.parse(originGit("show", `${BRANCH}:.fabrik/config.json`))).toMatchObject({ staging: null });
      mergeTheSetupPr(world);

      const again = await setupOnce(world, { args: OTHERS, answers: ["none"] });

      expect(again.questions).toEqual(["The environment staging's deploys carry in GitHub's Deployments, or none to leave staging out [staging]: "]);
      expect(again.said).toContain(COMPLETE);
    });
  });

  describe("on a merged install with nothing to apply, but 1Password lacking what a wizard stage stores", () => {
    const COMPLETE = "Nothing to do: this repo's Fabrik install is complete.";
    const WALK = "Walk the wizard now? [y/N] ";
    const COMMAND = "curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/main/setup.sh | bash -s -- v1.4.2";

    const unstore = (world: World, vault: string, title: string) => void world.items.get(vault)?.delete(title);

    /** The Operator points monitor.errors at a Sentry project in the Product's Kit config on main. */
    async function sentryOnMain(): Promise<void> {
      const config = JSON.parse(await readFile(join(checkout, ".fabrik/config.json"), "utf8")) as Record<string, unknown>;
      const monitor = { errors: { provider: "sentry", org: "acme", project: "clinic" }, red_main: true };
      await writeFile(join(checkout, ".fabrik/config.json"), `${JSON.stringify({ ...config, monitor }, null, 2)}\n`);
      git("commit", "-q", "-am", "Read production errors from Sentry");
      git("push", "-q", "origin", "main");
    }

    /** The Operator stores the Sentry token in the wizard's Sentry stage, and walks the rest. */
    const storesTheSentryToken: Wizard = async (world, wizardEnv) => {
      await walksEveryStage(world, wizardEnv);
      store(world, "Fabrik App", "Sentry token");
    };

    const GAPS: [string, (world: World) => void | Promise<void>, string, Wizard][] = [
      ["the Fabrik App's key", (world) => unstore(world, "Fabrik App", "Fabrik App"), 'the Fabrik App\'s key, in the "Fabrik App" vault', walksEveryStage],
      ["the Claude token", (world) => unstore(world, "Fabrik", "Claude token"), 'the Claude token, in the "Fabrik" vault', walksEveryStage],
      ["the Sentry token monitor.errors reads", sentryOnMain, 'the Sentry token, in the "Fabrik App" vault, which monitor.errors in .fabrik/config.json reads', storesTheSentryToken],
    ];

    async function aMergedInstallLacking(world: World, lacking: (world: World) => void | Promise<void>): Promise<void> {
      await setupOnce(world);
      mergeTheSetupPr(world);
      await lacking(world);
    }

    it.each(GAPS)("lacking %s, names it, asks whether to walk the wizard, and on a no runs nothing", async (_, lacking, gap) => {
      const world = aWorld();
      await aMergedInstallLacking(world, lacking);

      const { code, said, log, questions } = await setupOnce(world, { answers: ["n"] });

      expect(code).toBe(0);
      expect(said).toContain(`- ${gap}`);
      expect(said).not.toContain(COMPLETE);
      expect(questions).toEqual([WALK]);
      expect(log.filter((line) => /^gh pr (create|edit)|^git (switch|commit|push)|^wizard$/.test(line))).toEqual([]);
      expect(said).toContain("Setup changed nothing.");
    });

    it.each(GAPS)("lacking %s, walks the wizard on a yes, then says the install is complete, with no setup branch or PR", async (_, lacking, gap, wizard) => {
      const world = aWorld();
      await aMergedInstallLacking(world, lacking);

      const { code, said, complaints, log, wizardRuns } = await setupOnce(world, { wizard });

      expect(complaints).toEqual([]);
      expect(code).toBe(0);
      expect(said).toContain(`- ${gap}`);
      expect(wizardRuns).toHaveLength(1);
      expect(wizardRuns[0]?.env["OP_ACCOUNT"]).toBe("my.1password.com");
      expect(wizardRuns[0]?.env["FABRIK_WIZARD_REPORT"]).toEqual(expect.any(String));
      expect(wizardRuns[0]?.env[WIZARD_SECOND_SUBSCRIPTION_ENV]).toBe("no");
      expect(said.at(-1)).toBe(COMPLETE);
      expect(log.filter((line) => /^gh pr (create|edit)|^git (commit|push)/.test(line))).toEqual([]);
      expect(world.prs).toHaveLength(1);
      expect(git("branch", "--show-current").trim()).toBe("main");
      expect(git("branch", "--list", BRANCH)).toBe("");
      expect((await setupOnce(world)).said).toContain(COMPLETE);
    });

    it("whose wizard leaves the gap, says what's still missing and how to walk the wizard again, not that the install is complete", async () => {
      const world = aWorld();
      await aMergedInstallLacking(world, (lacking) => unstore(lacking, "Fabrik", "Claude token"));

      const { code, said } = await setupOnce(world, { wizard: endsAtTheBanner });

      expect(code).toBe(0);
      expect(said).not.toContain(COMPLETE);
      expect(said.slice(said.lastIndexOf("1Password still lacks what the wizard stores:"))).toEqual([
        "1Password still lacks what the wizard stores:",
        '- the Claude token, in the "Fabrik" vault',
        `Run setup again to walk the wizard for them: ${COMMAND}`,
      ]);
      expect(world.prs).toHaveLength(1);
      expect(git("branch", "--list", BRANCH)).toBe("");
    });

    it("with a yes to a second Subscription whose token isn't stored, walks the wizard, and lists it in the subscriptions line in a setup PR", async () => {
      const world = aWorld();
      await aMergedInstallLacking(world, () => {});
      const args = ["--no-production", "--no-staging", "--no-time-zone", "--second-subscription", "--no-paused"];

      const { code, said, complaints, questions, wizardRuns } = await setupOnce(world, { args, wizard: addsASecondSubscription });

      expect(complaints).toEqual([]);
      expect(code).toBe(0);
      expect(said).toContain('- the second Subscription\'s token, "Claude token 2", in the "Fabrik" vault');
      expect(questions).toEqual([WALK]);
      expect(wizardRuns[0]?.env[WIZARD_SECOND_SUBSCRIPTION_ENV]).toBe("yes");
      expect(JSON.parse(originGit("show", `${BRANCH}:.fabrik/config.json`)).subscriptions).toEqual(["Claude token", "Claude token 2"]);
      expect(world.prs).toEqual([expect.objectContaining({ open: false }), expect.objectContaining({ number: 2, head: BRANCH, open: true })]);
      expect(said).toContain("The setup PR: https://github.com/acme/clinic/pull/2");
    });

    it("listing a third Subscription 1Password lacks, which no wizard stage stores, says the install is complete and to store it by hand, asking nothing", async () => {
      const world = aWorld();
      await aMergedInstallLacking(world, async (lacking) => {
        store(lacking, "Fabrik", "Claude token 2");
        const config = JSON.parse(await readFile(join(checkout, ".fabrik/config.json"), "utf8")) as Record<string, unknown>;
        const subscriptions = ["Claude token", "Claude token 2", "Claude token 3"];
        await writeFile(join(checkout, ".fabrik/config.json"), `${JSON.stringify({ ...config, subscriptions }, null, 2)}\n`);
        git("commit", "-q", "-am", "A third Subscription");
        git("push", "-q", "origin", "main");
      });

      for (const _ of [1, 2]) {
        const { code, said, log, questions } = await setupOnce(world, { answers: [] });

        expect(code).toBe(0);
        expect(said).toContain(COMPLETE);
        expect(said).toContainEqual(
          expect.stringMatching(/^- \.fabrik\/config\.json lists "Claude token 3" in subscriptions, .* yourself, since the wizard stores only "Claude token" and "Claude token 2"\.$/),
        );
        expect(said.join("\n")).not.toMatch(/still lacks|Run setup again to walk|"A second Subscription" stage/);
        expect(questions).toEqual([]);
        expect(log.filter((line) => /^gh pr (create|edit)|^git (switch|commit|push)|^wizard$/.test(line))).toEqual([]);
      }
    });

    /** The Operator lists the Subscriptions the Kit runs on in the Product's Kit config on main. */
    async function listOnMain(subscriptions: readonly string[]): Promise<void> {
      const config = JSON.parse(await readFile(join(checkout, ".fabrik/config.json"), "utf8")) as Record<string, unknown>;
      await writeFile(join(checkout, ".fabrik/config.json"), `${JSON.stringify({ ...config, subscriptions }, null, 2)}\n`);
      git("commit", "-q", "-am", "Our own Subscription");
      git("push", "-q", "origin", "main");
    }

    it.each([
      ["in a terminal", {}],
      ["with --plan", { args: [...FLAGS, "--plan"] }],
    ])("listing one Subscription under its own name, which 1Password lacks, %s says the install is complete and to store it by hand", async (_, options) => {
      const world = aWorld();
      await aMergedInstallLacking(world, () => listOnMain(["Claude backup"]));

      const { code, said, questions } = await setupOnce(world, { answers: [], ...options });

      expect(code).toBe(0);
      expect(said).toContain(COMPLETE);
      expect(said).toContain(
        '- .fabrik/config.json lists "Claude backup" in subscriptions, but the "Fabrik" vault has no item of that name: run `claude setup-token` on that Subscription\'s Claude account and save the token as the "Claude backup" API Credential, with its expiry date, in the "Fabrik" vault yourself, since the wizard stores only "Claude token" and "Claude token 2".',
      );
      expect(questions).toEqual([]);
    });

    it("listing only Subscriptions under other names, says the install is complete with 1Password lacking the Claude token, which the Kit never reads", async () => {
      const world = aWorld();
      await aMergedInstallLacking(world, async (lacking) => {
        store(lacking, "Fabrik", "Claude backup");
        unstore(lacking, "Fabrik", "Claude token");
        await listOnMain(["Claude backup"]);
      });

      const { code, said, log, questions } = await setupOnce(world, { answers: [] });

      expect(code).toBe(0);
      expect(said).toContain(COMPLETE);
      expect(said.join("\n")).not.toContain("Claude token");
      expect(questions).toEqual([]);
      expect(log).not.toContain("wizard");
    });

    describe("listing two Subscriptions, a rotation setup never adds to", () => {
      const LEFT_AS_IT_IS = ".fabrik/config.json already lists 2 Subscriptions, and Setup leaves a list of two or more as it is";
      const withTheFlag = ["--no-production", "--no-staging", "--no-time-zone", "--second-subscription", "--no-paused"];

      async function aRotationOnMain(world: World): Promise<void> {
        await aMergedInstallLacking(world, async (lacking) => {
          store(lacking, "Fabrik", "Claude backup");
          await listOnMain(["Claude token", "Claude backup"]);
        });
      }

      it("doesn't ask about a second Subscription, and says it leaves that list as it is", async () => {
        const world = aWorld();
        await aRotationOnMain(world);

        const { code, said, questions } = await setupOnce(world, { answers: [], args: ["--no-production", "--no-staging", "--no-time-zone", "--no-paused"] });

        expect(code).toBe(0);
        expect(questions).toEqual([]);
        expect(said).toContain(`${LEFT_AS_IT_IS}, so it doesn't ask about a second.`);
        expect(said).toContain(COMPLETE);
      });

      it("takes --second-subscription as doing nothing, and says so", async () => {
        const world = aWorld();
        await aRotationOnMain(world);

        const { code, said, questions, log } = await setupOnce(world, { answers: [], args: withTheFlag });

        expect(code).toBe(0);
        expect(said).toContain(`--second-subscription has no effect: ${LEFT_AS_IT_IS}.`);
        expect(said).toContain(COMPLETE);
        expect(questions).toEqual([]);
        expect(log).not.toContain("wizard");
      });

      it("with --second-subscription, tells the wizard setup lists no second Subscription, when it walks it for the Claude token", async () => {
        const world = aWorld();
        await aRotationOnMain(world);
        unstore(world, "Fabrik", "Claude token");

        const { code, wizardRuns } = await setupOnce(world, { args: withTheFlag });

        expect(code).toBe(0);
        expect(wizardRuns[0]?.env[WIZARD_SECOND_SUBSCRIPTION_ENV]).toBe("no");
      });
    });

    it("with --second-subscription and a Kit config that lists the second Subscription alone, tells the wizard setup lists nothing, as it's listed", async () => {
      const world = aWorld();
      await aMergedInstallLacking(world, () => listOnMain(["Claude token 2"]));

      const { code, wizardRuns } = await setupOnce(world, { args: ["--no-production", "--no-staging", "--no-time-zone", "--second-subscription", "--no-paused"], wizard: addsASecondSubscription });

      expect(code).toBe(0);
      expect(wizardRuns[0]?.env[WIZARD_SECOND_SUBSCRIPTION_ENV]).toBe("no");
    });

    it("with a Kit config that lists the second Subscription alone, its token stored, doesn't ask about a second, and says the install is complete", async () => {
      const world = aWorld();
      await aMergedInstallLacking(world, async (lacking) => {
        store(lacking, "Fabrik", "Claude token 2");
        await listOnMain(["Claude token 2"]);
      });

      const { code, said, questions } = await setupOnce(world, { answers: [], args: ["--no-production", "--no-staging", "--no-time-zone", "--no-paused"] });

      expect(code).toBe(0);
      expect(questions).toEqual([]);
      expect(said).toContain('.fabrik/config.json already lists the second Subscription, "Claude token 2", so it doesn\'t ask about a second.');
      expect(said).toContain(COMPLETE);
    });

    it.each([
      ["without a terminal", { terminal: false }],
      ["with --plan", { args: [...FLAGS, "--plan"] }],
    ])("%s, names the gap and says to run setup in a terminal to walk the wizard, running nothing", async (_, options) => {
      const world = aWorld();
      await aMergedInstallLacking(world, (lacking) => unstore(lacking, "Fabrik", "Claude token"));

      const { code, said, log, questions } = await setupOnce(world, options);

      expect(code).toBe(0);
      expect(said).not.toContain(COMPLETE);
      expect(said).toContain('- the Claude token, in the "Fabrik" vault');
      expect(said).toContain(`Run setup in a terminal to walk the wizard for them: ${COMMAND}`);
      expect(questions).toEqual([]);
      expect(log.filter((line) => /^git (switch|commit|push)|^gh pr (create|edit)|^wizard$/.test(line))).toEqual([]);
    });
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

  describe("the fabrik environment, held to the default branch (ADR-0004)", () => {
    const ENVIRONMENT = "repos/acme/clinic/environments/fabrik";
    const CREATE = "- create the fabrik environment, held to main alone: only a run of main is given its secrets";
    /** The environment's rules as GitHub holds them, without the ids it gave them. */
    const rulesOf = (world: World) => environmentOf(world)?.rules.map(({ name, type }) => ({ name, type }));

    it("on a fresh repo, plans making it as the first step, and makes it with one branch rule naming the default branch", async () => {
      const world = aWorld();

      const { code, said, complaints, calls } = await setupOnce(world);

      expect(complaints).toEqual([]);
      expect(code).toBe(0);
      expect(said[said.indexOf("Setup would:") + 1]).toBe(CREATE);
      expect(environmentOf(world)?.policy).toEqual({ protected_branches: false, custom_branch_policies: true });
      expect(rulesOf(world)).toEqual([{ name: "main", type: "branch" }]);
      const puts = calls.filter((call) => call.line === `gh api --method PUT ${ENVIRONMENT} --input -`);
      expect(puts.map((call) => call.input)).toEqual(['{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}']);
    });

    type Found = Parameters<typeof anEnvironment>[1];

    it.each<[string, Found, string]>([
      ["every branch, as GitHub makes one a workflow names", { policy: "all" }, "every branch"],
      ["protected branches only", { policy: "protected" }, "protected branches only"],
      ["selected branches and tags with no rule", { policy: "selected" }, "none"],
      ["a rule naming another branch", { rules: ["release"] }, "release"],
      ["a tag rule named main", { rules: [{ name: "main", type: "tag" }] }, "tag main"],
      ["the right rule beside another", { rules: ["main", "release/*"] }, "main, release/*"],
      ["a rule naming what the default branch was called before it was renamed", { rules: ["master"] }, "master"],
    ])("found with %s, plans holding it first, from what to what, and leaves exactly the one rule and its secrets", async (_, found, before) => {
      const world = aWorld();
      anEnvironment(world, { ...found, secrets: ["STRIPE_KEY"] });

      const { code, said, complaints } = await setupOnce(world);

      expect(complaints).toEqual([]);
      expect(code).toBe(0);
      expect(said[said.indexOf("Setup would:") + 1]).toBe(`- hold the fabrik environment to main alone: rules ${before} → main`);
      expect(environmentOf(world)?.policy).toEqual({ protected_branches: false, custom_branch_policies: true });
      expect(rulesOf(world)).toEqual([{ name: "main", type: "branch" }]);
      // Its own secret stays, beside the three tokens the run's later steps store in it.
      expect([...environmentOf(world)!.secrets]).toEqual(["STRIPE_KEY", ...TOKENS]);
    });

    it("adds the rule naming the default branch before it deletes any other, then reads the environment back, its setting and its rules", async () => {
      const world = aWorld();
      const found = anEnvironment(world, { rules: ["release", { name: "main", type: "tag" }] });
      const [release, tag] = found.rules.map((rule) => rule.id);

      await setupOnce(world);

      const RULES = `${ENVIRONMENT}/deployment-branch-policies`;
      const applying = world.environmentCalls.slice(world.environmentCalls.indexOf(`gh api --method PUT ${ENVIRONMENT} --input -`));
      expect(applying.slice(0, 7)).toEqual([
        `gh api --method PUT ${ENVIRONMENT} --input -`,
        `gh api ${RULES}?per_page=100`,
        `gh api --method POST ${RULES} -f name=main -f type=branch`,
        `gh api --method DELETE ${RULES}/${release}`,
        `gh api --method DELETE ${RULES}/${tag}`,
        `gh api ${ENVIRONMENT}`,
        `gh api ${RULES}?per_page=100`,
      ]);
    });

    it("adds no rule to one that has the default branch's rule beside another, and deletes only the other", async () => {
      const world = aWorld();
      const found = anEnvironment(world, { rules: ["main", "release"] });
      const [main, release] = found.rules.map((rule) => rule.id);

      await setupOnce(world);

      const changes = world.environmentCalls.filter((line) => /--method (POST|DELETE)/.test(line));
      expect(changes).toEqual([`gh api --method DELETE ${ENVIRONMENT}/deployment-branch-policies/${release}`]);
      expect(environmentOf(world)?.rules).toEqual([{ id: main, name: "main", type: "branch" }]);
    });

    const changing = (world: World) => world.environmentCalls.filter((line) => line.includes("--method"));

    it("on a working install, whose environment the first run held, plans no step, changes nothing of it and says the install is complete", async () => {
      const world = aWorld();
      await setupOnce(world);
      mergeTheSetupPr(world);
      world.environmentCalls.length = 0;

      const { code, said } = await setupOnce(world);

      expect(code).toBe(0);
      expect(said).toContain("Nothing to do: this repo's Fabrik install is complete.");
      expect(said.join("\n")).not.toContain("the fabrik environment");
      expect(changing(world)).toEqual([]);
    });

    it("on a working install whose one rule was deleted since, puts it back, opens no PR, and the next run plans nothing", async () => {
      const world = aWorld();
      await setupOnce(world);
      mergeTheSetupPr(world);
      environmentOf(world)!.rules = [];

      const { code, said, complaints } = await setupOnce(world);

      expect(complaints).toEqual([]);
      expect(code).toBe(0);
      expect(said.filter((line) => line.startsWith("- "))).toContain("- hold the fabrik environment to main alone: rules none → main");
      expect(rulesOf(world)).toEqual([{ name: "main", type: "branch" }]);
      expect(world.prs).toHaveLength(1);
      expect(said).toContain("Every file setup writes is already on main, so there's no setup PR to open. Setup switched back to main.");
      expect((await setupOnce(world)).said).toContain("Nothing to do: this repo's Fabrik install is complete.");
    });

    it("with --plan, names the step and changes nothing of the environment", async () => {
      const world = aWorld();
      anEnvironment(world, { rules: ["release"] });

      const { code, said } = await setupOnce(world, { args: [...FLAGS, "--plan"] });

      expect(code).toBe(0);
      expect(said[said.indexOf("Setup would:") + 1]).toBe("- hold the fabrik environment to main alone: rules release → main");
      expect(changing(world)).toEqual([]);
      expect(rulesOf(world)).toEqual([{ name: "release", type: "branch" }]);
    });

    /** What a run changed beyond the fabrik environment: nothing, when it stopped at the environment's step. */
    const changedElsewhere = (world: World, log: string[]) => ({
      labels: [...world.labels],
      secrets: [...world.secrets],
      vaults: [...world.vaults],
      protection: world.protection,
      ruleset: world.ruleset,
      prs: world.prs.length,
      commands: log.filter((line) => /^gh (label create|secret set|pr create)|^op (vault|service-account) create|^git (commit|push)|^wizard$/.test(line)),
    });
    const NOTHING = { labels: [], secrets: [], vaults: [], protection: null, ruleset: null, prs: 0, commands: [] };

    it("stops when the rules don't read back as the one rule, saying what they read back as, and runs no later step", async () => {
      const world = aWorld();
      anEnvironment(world, { policy: "all" }).dropsNewRules = true;

      const { code, complaints, log } = await setupOnce(world);

      expect(code).toBe(1);
      expect(complaints).toEqual([
        "The fabrik environment on acme/clinic reads back as none, not held to main alone, so Setup stored no token in it. Run setup again.",
      ]);
      expect(changedElsewhere(world, log)).toEqual(NOTHING);
    });

    it.each<[string, WorldEnvironment["policy"]]>([
      ["every branch", null],
      ["protected branches only", { protected_branches: true, custom_branch_policies: false }],
    ])("stops when the setting reads back as %s though the one rule is listed, saying so, and runs no later step", async (setting, policy) => {
      const world = aWorld();
      anEnvironment(world, { rules: ["release"] });
      // Someone changes the setting on github.com once Setup has set it, before Setup reads the environment back.
      const during = (line: string) => {
        if (line.startsWith(`gh api --method POST ${ENVIRONMENT}/deployment-branch-policies `)) environmentOf(world)!.policy = policy;
      };

      const { code, complaints, log } = await setupOnce(world, { during });

      expect(rulesOf(world)).toEqual([{ name: "main", type: "branch" }]);
      expect(code).toBe(1);
      expect(complaints).toEqual([
        `The fabrik environment on acme/clinic reads back as ${setting}, not held to main alone, so Setup stored no token in it. Run setup again.`,
      ]);
      expect(changedElsewhere(world, log)).toEqual(NOTHING);
    });

    it("stops when GitHub refuses the environment, naming its answer and the plans that have environments, and applies no other step of the plan", async () => {
      const world = aWorld();
      world.environmentRefusal = "gh: Not Found (HTTP 404)\n";

      const { code, complaints, log } = await setupOnce(world);

      expect(code).toBe(1);
      expect(complaints).toEqual([
        "GitHub refused the fabrik environment on acme/clinic: gh: Not Found (HTTP 404). A private repo needs a GitHub plan with environments: GitHub Pro for a personal account's repo, or GitHub Team for an organization's. The Kit keeps no fallback to repo-level secrets, so Setup stopped before changing anything else.",
      ]);
      expect(world.environments.size).toBe(0);
      expect(changedElsewhere(world, log)).toEqual(NOTHING);
    });
  });

  describe("the three tokens, stored in the fabrik environment under new service accounts (ADR-0004)", () => {
    const ENVIRONMENT = "repos/acme/clinic/environments/fabrik";
    /** Each service account the run made, as op was asked for it. */
    const made = (log: string[]) => log.filter((line) => line.startsWith("op service-account create "));

    it("on a fresh repo, makes the environment, then the three -env accounts, each stored in the fabrik environment, and sets no repo-level secret", async () => {
      const world = aWorld();

      const { code, said, complaints, log } = await setupOnce(world);

      expect(complaints).toEqual([]);
      expect(code).toBe(0);
      expect(said.slice(said.indexOf("Setup would:"), said.indexOf(`On ${BRANCH}.`)).filter((line) => line.includes("service account"))).toEqual([
        '- create the read-only service account "fabrik-acme-clinic-agent-env" (reads "Fabrik") and store it as FABRIK_OP_AGENT_TOKEN in the fabrik environment',
        '- create the read-only service account "fabrik-acme-clinic-implement-env" (reads "Fabrik", "Fabrik Sandbox · clinic") and store it as FABRIK_OP_IMPLEMENT_TOKEN in the fabrik environment',
        '- create the read-only service account "fabrik-acme-clinic-push-env" (reads "Fabrik App") and store it as FABRIK_OP_PUSH_TOKEN in the fabrik environment',
      ]);
      expect(made(log)).toEqual([
        "op service-account create fabrik-acme-clinic-agent-env --vault Fabrik:read_items --raw",
        "op service-account create fabrik-acme-clinic-implement-env --vault Fabrik:read_items --vault Fabrik Sandbox · clinic:read_items --raw",
        "op service-account create fabrik-acme-clinic-push-env --vault Fabrik App:read_items --raw",
      ]);
      expect(index(log, /^gh api --method PUT repos\/acme\/clinic\/environments\/fabrik /)).toBeLessThan(index(log, /^op service-account create /));
      expect([...environmentOf(world)!.secrets]).toEqual(TOKENS);
      expect([...world.secrets]).toEqual([]);
    });

    it("gives each token to gh secret set --env fabrik on its stdin, and shows it in no argument, no line it says and not in the setup PR", async () => {
      const world = aWorld();

      const { said, complaints, calls } = await setupOnce(world);

      const sets = calls.filter((call) => call.line.startsWith("gh secret set "));
      expect(sets.map(({ line, input }) => [line, input])).toEqual(TOKENS.map((name) => [`gh secret set ${name} --env fabrik`, "ops_token"]));
      expect(calls.filter((call) => call.line.includes("ops_token"))).toEqual([]);
      expect([...said, ...complaints, world.prs[0]!.body].join("\n")).not.toContain("ops_token");
    });

    it("reads the environment, its setting and its rules, before it makes each account, and makes none before the environment the run held reads back", async () => {
      const world = aWorld();

      const { log } = await setupOnce(world);

      const PUT = `gh api --method PUT ${ENVIRONMENT} --input -`;
      const RULES = `gh api ${ENVIRONMENT}/deployment-branch-policies?per_page=100`;
      /** The environment read whole: its setting, then its rules. */
      const READ = [`gh api ${ENVIRONMENT}`, RULES];
      const steps = log.filter((line) => line.includes(ENVIRONMENT) || /^op service-account create |^gh secret set /.test(line));
      expect(steps.slice(steps.indexOf(PUT), steps.indexOf(PUT) + 17)).toEqual([
        PUT,
        RULES,
        `gh api --method POST ${ENVIRONMENT}/deployment-branch-policies -f name=main -f type=branch`,
        ...READ,
        ...READ,
        "op service-account create fabrik-acme-clinic-agent-env --vault Fabrik:read_items --raw",
        "gh secret set FABRIK_OP_AGENT_TOKEN --env fabrik",
        ...READ,
        "op service-account create fabrik-acme-clinic-implement-env --vault Fabrik:read_items --vault Fabrik Sandbox · clinic:read_items --raw",
        "gh secret set FABRIK_OP_IMPLEMENT_TOKEN --env fabrik",
        ...READ,
        "op service-account create fabrik-acme-clinic-push-env --vault Fabrik App:read_items --raw",
        "gh secret set FABRIK_OP_PUSH_TOKEN --env fabrik",
      ]);
    });

    /** Someone changes the environment on github.com once the Operator has said yes, after Setup read it. */
    const afterTheYes = (change: () => void) => (line: string) => {
      if (line === `git switch -C ${BRANCH}`) change();
    };
    const STORED_NONE = "The fabrik environment on acme/clinic isn't held to main alone, so Setup stored no token in it. Run setup again.";

    it.each<[string, (environment: WorldEnvironment) => void]>([
      ["no rule", (environment) => void (environment.rules = [])],
      ["a rule naming another branch", (environment) => void (environment.rules = [{ id: 201, name: "release", type: "branch" }])],
      ["a tag rule named main", (environment) => void (environment.rules = [{ id: 201, name: "main", type: "tag" }])],
      ["another rule beside its one", (environment) => void environment.rules.push({ id: 201, name: "release/*", type: "branch" })],
      // GitHub keeps an environment's rules, and lists them, under a setting that doesn't use them.
      ["its one rule, under a setting changed to every branch", (environment) => void (environment.policy = null)],
      [
        "its one rule, under a setting changed to protected branches only",
        (environment) => void (environment.policy = { protected_branches: true, custom_branch_policies: false }),
      ],
    ])("in a run that found the environment held and planned no step for it, stops before it makes an account when its rules read as %s", async (_, change) => {
      const world = aWorld();
      const environment = anEnvironment(world, { rules: ["main"] });

      const { code, said, complaints, log } = await setupOnce(world, { during: afterTheYes(() => change(environment)) });

      expect(said.filter((line) => line.includes("the fabrik environment, held to") || line.includes("hold the fabrik environment"))).toEqual([]);
      expect(code).toBe(1);
      expect(complaints).toEqual([STORED_NONE]);
      expect(made(log)).toEqual([]);
      expect(log.filter((line) => line.startsWith("gh secret set "))).toEqual([]);
      expect([...environment.secrets]).toEqual([]);
      expect([...world.secrets]).toEqual([]);
    });

    it("stops before it makes an account when the environment is gone, as one deleted since Setup read it", async () => {
      const world = aWorld();
      anEnvironment(world, { rules: ["main"] });

      const { code, complaints, log } = await setupOnce(world, { during: afterTheYes(() => world.environments.clear()) });

      expect(complaints).toEqual([STORED_NONE]);
      expect(code).toBe(1);
      expect(made(log)).toEqual([]);
      expect(log.filter((line) => line.startsWith("gh secret set "))).toEqual([]);
      expect([...world.secrets]).toEqual([]);
    });

    it("on a repo whose three tokens sit at repo level only, makes three new accounts in the environment and leaves the repo-level secrets", async () => {
      const world = aWorld();
      const repoLevel = [...TOKENS, "STRIPE_KEY"];
      for (const name of repoLevel) world.secrets.add(name);

      const first = await setupOnce(world);

      expect(first.complaints).toEqual([]);
      expect(made(first.log).map((line) => line.split(" ")[3])).toEqual(["fabrik-acme-clinic-agent-env", "fabrik-acme-clinic-implement-env", "fabrik-acme-clinic-push-env"]);
      expect([...environmentOf(world)!.secrets]).toEqual(TOKENS);
      expect([...world.secrets]).toEqual(repoLevel);
    });

    it.each<[string, readonly string[]]>([
      ["none of them", []],
      ["all three", TOKENS],
    ])("on a repo whose environment holds all three, makes no account, with %s at repo level", async (_, repoLevel) => {
      const world = aWorld();
      anEnvironment(world, { rules: ["main"], secrets: TOKENS });
      for (const name of repoLevel) world.secrets.add(name);

      const { code, said, log } = await setupOnce(world);

      expect(code).toBe(0);
      expect(said.filter((line) => line.includes("service account"))).toEqual([]);
      expect(made(log)).toEqual([]);
      expect(log.filter((line) => line.startsWith("gh secret set "))).toEqual([]);
    });

    it("on a repo whose environment lacks one, makes only that role's account, though a repo-level secret carries its name", async () => {
      const world = aWorld();
      anEnvironment(world, { rules: ["main"], secrets: ["FABRIK_OP_AGENT_TOKEN", "FABRIK_OP_PUSH_TOKEN"] });
      for (const name of TOKENS) world.secrets.add(name);

      const { code, log } = await setupOnce(world);

      expect(code).toBe(0);
      expect(made(log)).toEqual(["op service-account create fabrik-acme-clinic-implement-env --vault Fabrik:read_items --vault Fabrik Sandbox · clinic:read_items --raw"]);
      expect(log.filter((line) => line.startsWith("gh secret set "))).toEqual(["gh secret set FABRIK_OP_IMPLEMENT_TOKEN --env fabrik"]);
      expect([...environmentOf(world)!.secrets]).toEqual(["FABRIK_OP_AGENT_TOKEN", "FABRIK_OP_PUSH_TOKEN", "FABRIK_OP_IMPLEMENT_TOKEN"]);
      expect([...world.secrets]).toEqual(TOKENS);
    });
  });

  describe("the repo-level tokens, deleted once the default branch's Kit names the fabrik environment (ADR-0004)", () => {
    const DELETES = TOKENS.map((name) => `- delete the repo-level Actions secret ${name}: the Kit main pins reads the fabrik environment's`);
    /** Each service account the run made, and each repo-level secret it deleted, as op and gh were asked. */
    const made = (log: string[]) => log.filter((line) => line.startsWith("op service-account create "));
    const deleted = (log: string[]) => log.filter((line) => line.startsWith("gh secret delete "));
    /** The steps of the plan Setup showed, before it applied any. */
    const planned = (said: string[]) => said.slice(said.indexOf("Setup would:") + 1, said.indexOf("", said.indexOf("Setup would:")));

    /** A repo already on the Kit: its default branch's caller workflow pins this release, and its three tokens sit at repo level, beside a secret of its own. */
    async function onTheKitAt(world: World, release: string): Promise<void> {
      const caller = ".github/workflows/fabrik.yml";
      await mkdir(join(checkout, ".github/workflows"), { recursive: true });
      await writeFile(join(checkout, caller), pinCaller(await readFile(join(KIT_DIR, "templates/fabrik.yml"), "utf8"), release));
      git("add", caller);
      git("commit", "-q", "-m", `Fabrik ${release}`);
      git("push", "-q", "origin", "main");
      for (const name of [...TOKENS, "STRIPE_KEY"]) world.secrets.add(name);
    }

    it("over two runs with the setup PR merged between them, moves the three tokens: the first makes the environment and three new accounts and deletes nothing, the second deletes the three repo-level secrets and makes no account", async () => {
      const world = aWorld();
      await onTheKitAt(world, "v0.9.1");

      const first = await setupOnce(world);

      expect(first.complaints).toEqual([]);
      expect(planned(first.said)[0]).toBe("- create the fabrik environment, held to main alone: only a run of main is given its secrets");
      expect(made(first.log).map((line) => line.split(" ")[3])).toEqual(["fabrik-acme-clinic-agent-env", "fabrik-acme-clinic-implement-env", "fabrik-acme-clinic-push-env"]);
      expect(first.said.filter((line) => line.includes("delete the repo-level"))).toEqual([]);
      expect(deleted(first.log)).toEqual([]);
      expect([...world.secrets]).toEqual([...TOKENS, "STRIPE_KEY"]);

      mergeTheSetupPr(world);
      const second = await setupOnce(world);

      expect(second.complaints).toEqual([]);
      expect(planned(second.said)).toEqual(DELETES);
      expect(made(second.log)).toEqual([]);
      expect(deleted(second.log)).toEqual(TOKENS.map((name) => `gh secret delete ${name}`));
      expect([...environmentOf(world)!.secrets]).toEqual(TOKENS);
      expect([...world.secrets]).toEqual(["STRIPE_KEY"]);
      expect((await setupOnce(world)).said).toContain("Nothing to do: this repo's Fabrik install is complete.");
    });

    const STAY =
      "- The repo-level Actions secrets FABRIK_OP_AGENT_TOKEN, FABRIK_OP_IMPLEMENT_TOKEN and FABRIK_OP_PUSH_TOKEN stay for now, since the Kit main pins names no environment and reads them. " +
      "Once the setup PR is merged, run setup again and it deletes them: curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/main/setup.sh | bash -s -- v1.4.2";
    const OLD_ACCOUNTS =
      "- Once the repo-level secrets are deleted, delete the old service accounts fabrik-acme-clinic-agent, fabrik-acme-clinic-implement and fabrik-acme-clinic-push on 1Password's site. " +
      "Their tokens still work until you do, though they sit nowhere on GitHub.";
    /** What a run said before it applied anything, and its last lines, which follow the wizard's cleared screen. */
    const underThePlan = (said: string[]) => said.slice(0, said.indexOf(`On ${BRANCH}.`));
    const lastLines = (said: string[]) => said.slice(said.lastIndexOf("What setup did:"));
    /** A step or a note of the move. Setup's report names the repo's own repo-level secrets on every run, in other words. */
    const OF_THE_MOVE = /delete the repo-level|for now, since the Kit|old service account/;

    it("says the repo-level secrets stay on the first run, and names the three old accounts on the run that deletes them, under the plan and again in its last lines, and on no run after", async () => {
      const world = aWorld();
      await onTheKitAt(world, "v0.9.1");

      const first = await setupOnce(world);

      expect(underThePlan(first.said)).toContain(STAY);
      expect(lastLines(first.said)).toContain(STAY);
      expect(world.prs[0]!.body.split("\n")).toContain(STAY);
      expect(first.said).not.toContain(OLD_ACCOUNTS);

      mergeTheSetupPr(world);
      const second = await setupOnce(world);

      expect(underThePlan(second.said)).toContain(OLD_ACCOUNTS);
      expect(lastLines(second.said).filter((line) => line.includes("old service account"))).toEqual([OLD_ACCOUNTS]);
      expect(second.said).not.toContain(STAY);

      const third = await setupOnce(world);

      expect(third.said.filter((line) => OF_THE_MOVE.test(line))).toEqual([]);
    });

    it("on the setup branch before its PR is merged, where the checkout's caller workflow pins Setup's release and the default branch's doesn't, deletes nothing and says the secrets stay", async () => {
      const world = aWorld();
      await onTheKitAt(world, "v0.9.1");
      await setupOnce(world);

      const { code, said, log } = await setupOnce(world);

      expect(code).toBe(0);
      expect(git("branch", "--show-current").trim()).toBe(BRANCH);
      expect(await readFile(join(checkout, ".github/workflows/fabrik.yml"), "utf8")).toContain("loop.yml@v1.4.2");
      expect(git("show", "origin/main:.github/workflows/fabrik.yml")).toContain("loop.yml@v0.9.1");
      expect(said).toContain(STAY);
      expect(said.filter((line) => line.includes("delete the repo-level"))).toEqual([]);
      expect(deleted(log)).toEqual([]);
      expect([...world.secrets]).toEqual([...TOKENS, "STRIPE_KEY"]);
    });

    it("with only one Kit secret at repo level, deletes only it, names only its role's old account, and leaves every other repo-level secret", async () => {
      const world = aWorld();
      await setupOnce(world);
      mergeTheSetupPr(world);
      const others = ["STRIPE_KEY", "FABRIK_OP_PUSH_TOKEN_OLD", "OP_PUSH_TOKEN"];
      for (const name of ["FABRIK_OP_PUSH_TOKEN", ...others]) world.secrets.add(name);

      const { code, said, log } = await setupOnce(world);

      expect(code).toBe(0);
      expect(planned(said)).toEqual(["- delete the repo-level Actions secret FABRIK_OP_PUSH_TOKEN: the Kit main pins reads the fabrik environment's"]);
      expect(lastLines(said).filter((line) => line.includes("old service account"))).toEqual([
        "- Once the repo-level secret is deleted, delete the old service account fabrik-acme-clinic-push on 1Password's site. Its token still works until you do, though it sits nowhere on GitHub.",
      ]);
      expect(deleted(log)).toEqual(["gh secret delete FABRIK_OP_PUSH_TOKEN"]);
      expect([...world.secrets]).toEqual(others);
      expect([...environmentOf(world)!.secrets]).toEqual(TOKENS);
    });

    it("on a repo with no Kit secret at repo level, deletes nothing and says nothing of it, on a first run and on a working install", async () => {
      const world = aWorld();
      world.secrets.add("STRIPE_KEY");

      const first = await setupOnce(world);
      mergeTheSetupPr(world);
      const second = await setupOnce(world);

      expect(second.said).toContain("Nothing to do: this repo's Fabrik install is complete.");
      expect([...first.said, ...second.said, world.prs[0]!.body].join("\n")).not.toMatch(OF_THE_MOVE);
      expect([...deleted(first.log), ...deleted(second.log)]).toEqual([]);
      expect([...world.secrets]).toEqual(["STRIPE_KEY"]);
    });

    it("leaves the repo-level secrets in place when the step that makes a new account stops, though the default branch's Kit names the environment", async () => {
      const world = aWorld();
      await setupOnce(world);
      mergeTheSetupPr(world);
      // The environment lost one token, and the three still sit at repo level.
      const environment = environmentOf(world)!;
      environment.secrets.delete("FABRIK_OP_IMPLEMENT_TOKEN");
      for (const name of TOKENS) world.secrets.add(name);
      // Someone adds a rule on github.com once the Operator has said yes, after Setup read the environment.
      const during = (line: string) => {
        if (line === `git switch -C ${BRANCH}`) environment.rules.push({ id: 201, name: "release/*", type: "branch" });
      };

      const { code, said, complaints, log } = await setupOnce(world, { during });

      expect(planned(said)).toEqual([
        '- create the read-only service account "fabrik-acme-clinic-implement-env" (reads "Fabrik", "Fabrik Sandbox · clinic") and store it as FABRIK_OP_IMPLEMENT_TOKEN in the fabrik environment',
        ...DELETES,
      ]);
      expect(code).toBe(1);
      expect(complaints).toEqual(["The fabrik environment on acme/clinic isn't held to main alone, so Setup stored no token in it. Run setup again."]);
      expect(deleted(log)).toEqual([]);
      expect([...world.secrets]).toEqual(TOKENS);
    });

    it("with --plan, names the deletions and the old accounts, and deletes nothing", async () => {
      const world = aWorld();
      await setupOnce(world);
      mergeTheSetupPr(world);
      for (const name of TOKENS) world.secrets.add(name);

      const { code, said, log } = await setupOnce(world, { args: [...FLAGS, "--plan"] });

      expect(code).toBe(0);
      expect(said).toEqual(expect.arrayContaining([...DELETES, OLD_ACCOUNTS]));
      expect(deleted(log)).toEqual([]);
      expect([...world.secrets]).toEqual(TOKENS);
    });
  });

  describe("the store's one token, the push account's, in the store's own fabrik environment (ADR-0004)", () => {
    const STORE = "jrey8343/fabrik-runs";
    const STORE_CALLER = ".github/workflows/weekly-summary.yml";
    const TOKEN = "FABRIK_OP_PUSH_TOKEN";
    const STORE_ENVIRONMENT = `repos/${STORE}/environments/fabrik`;
    /** Every question but the yes answered by a flag, the Operator's time zone among them, so Setup sets the store up. */
    const WITH_THE_STORE = ["--no-production", "--no-staging", "--time-zone=Australia/Sydney", "--no-second-subscription", "--no-paused"];
    const NEW_ACCOUNT = "op service-account create fabrik-jrey8343-fabrik-runs-push-env --vault Fabrik App:read_items --raw";
    const STAYS =
      "- jrey8343/fabrik-runs: The repo-level Actions secret FABRIK_OP_PUSH_TOKEN stays for now, since the caller workflow setup found there pins no Kit that names the fabrik environment. " +
      "Once setup has written the one that does, run setup again and it deletes it: curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/main/setup.sh | bash -s -- v1.4.2";
    const OLD_ACCOUNT =
      "- jrey8343/fabrik-runs: Once the repo-level secret is deleted, delete the old service account fabrik-jrey8343-fabrik-runs-push on 1Password's site. " +
      "Its token still works until you do, though it sits nowhere on GitHub.";
    const DELETE = "- delete the repo-level Actions secret FABRIK_OP_PUSH_TOKEN in jrey8343/fabrik-runs: the Kit trunk pins reads the fabrik environment's";
    /** A step or a note of the store's move. */
    const OF_THE_MOVE = /delete the repo-level|stays for now|old service account|found more to do/;
    const planned = (said: string[]) => said.slice(said.indexOf("Setup would:") + 1, said.indexOf("", said.indexOf("Setup would:")));
    const underThePlan = (said: string[]) => said.slice(0, said.indexOf(`On ${BRANCH}.`));
    const lastLines = (said: string[]) => said.slice(said.lastIndexOf("What setup did:"));
    /** Each gh secret call of a run that names a repo, and each that changed a secret, as gh was asked. */
    const secretCalls = (log: string[]) => log.filter((line) => /^gh secret (set|delete) /.test(line) || (line.startsWith("gh secret ") && line.includes("--repo")));

    /** A store already on the Kit: private, with commits on `trunk`, its caller workflow pinned at this release, and its one token at repo level. */
    async function aStoreOnTheKitAt(world: World, release: string): Promise<void> {
      const template = await readFile(join(KIT_DIR, "templates/fabrik-runs-caller.yml"), "utf8");
      Object.assign(world.store, { exists: true, private: true, defaultBranch: "trunk" });
      world.store.files.set(STORE_CALLER, pinCaller(template, release));
      world.store.secrets.add(TOKEN);
    }

    it("over two runs, moves the token of a store already on the Kit: the first holds the store's environment to the store's own default branch, makes the -env account in it and rewrites the store's caller, deleting nothing, and the second deletes the repo-level secret and names the old account", async () => {
      const world = aWorld();
      await aStoreOnTheKitAt(world, "v0.9.1");

      const first = await setupOnce(world, { args: WITH_THE_STORE });

      expect(first.complaints).toEqual([]);
      expect(planned(first.said).slice(0, 2)).toEqual([
        "- create the fabrik environment, held to main alone: only a run of main is given its secrets",
        "- create the fabrik environment in jrey8343/fabrik-runs, held to trunk alone: only a run of trunk is given its secrets",
      ]);
      expect(planned(first.said)).toContain(
        '- create the read-only service account "fabrik-jrey8343-fabrik-runs-push-env" (reads "Fabrik App") and store it as FABRIK_OP_PUSH_TOKEN in the fabrik environment in jrey8343/fabrik-runs',
      );
      expect(first.log).toContain(NEW_ACCOUNT);
      expect(environmentOf(world, "fabrik", STORE)).toEqual({
        policy: { protected_branches: false, custom_branch_policies: true },
        rules: [{ id: expect.any(Number), name: "trunk", type: "branch" }],
        secrets: new Set([TOKEN]),
      });
      expect(world.store.files.get(STORE_CALLER)).toContain("weekly-summary.yml@v1.4.2");
      expect([...world.store.secrets]).toEqual([TOKEN]);
      expect(first.log.filter((line) => line.startsWith("gh secret delete "))).toEqual([]);
      // The run wrote the store's caller, and still deletes nothing and names no old account: only a run that finds it there does.
      expect(underThePlan(first.said)).toContain(STAYS);
      expect(lastLines(first.said).filter((line) => OF_THE_MOVE.test(line))).toEqual([STAYS]);

      mergeTheSetupPr(world);
      const second = await setupOnce(world, { args: WITH_THE_STORE });

      expect(second.complaints).toEqual([]);
      expect(planned(second.said)).toEqual([DELETE]);
      expect(second.log).not.toContain(NEW_ACCOUNT);
      expect([...world.store.secrets]).toEqual([]);
      expect([...environmentOf(world, "fabrik", STORE)!.secrets]).toEqual([TOKEN]);
      expect(underThePlan(second.said)).toContain(OLD_ACCOUNT);
      // What it did, then the old account, named once.
      expect(lastLines(second.said).filter((line) => OF_THE_MOVE.test(line))).toEqual([DELETE, OLD_ACCOUNT]);

      const third = await setupOnce(world, { args: WITH_THE_STORE });

      expect(third.said).toContain("Nothing to do: this repo's Fabrik install is complete.");
      expect(third.said.filter((line) => OF_THE_MOVE.test(line))).toEqual([]);
    });

    it("names --repo jrey8343/fabrik-runs on every gh secret call for the store, and stores and deletes nothing of the Product repo's with them", async () => {
      const world = aWorld();
      await aStoreOnTheKitAt(world, "v0.9.1");

      const first = await setupOnce(world, { args: WITH_THE_STORE });
      mergeTheSetupPr(world);
      const second = await setupOnce(world, { args: WITH_THE_STORE });

      expect(secretCalls(first.log)).toEqual([
        // What Setup reads of the store, before the plan and again after the wizard.
        `gh secret list --repo ${STORE} --json name`,
        "gh secret set FABRIK_OP_AGENT_TOKEN --env fabrik",
        "gh secret set FABRIK_OP_IMPLEMENT_TOKEN --env fabrik",
        "gh secret set FABRIK_OP_PUSH_TOKEN --env fabrik",
        `gh secret set FABRIK_OP_PUSH_TOKEN --env fabrik --repo ${STORE}`,
        `gh secret list --repo ${STORE} --json name`,
        `gh secret list --env fabrik --repo ${STORE} --json name`,
      ]);
      expect(secretCalls(second.log)).toEqual([
        `gh secret list --repo ${STORE} --json name`,
        `gh secret list --env fabrik --repo ${STORE} --json name`,
        `gh secret delete FABRIK_OP_PUSH_TOKEN --repo ${STORE}`,
        `gh secret list --repo ${STORE} --json name`,
        `gh secret list --env fabrik --repo ${STORE} --json name`,
      ]);
      expect([...world.secrets]).toEqual([]);
      expect([...environmentOf(world)!.secrets]).toEqual(TOKENS);
    });

    it("for a store the run makes, writes its files, then holds its environment to the default branch their first commit made, then stores its token there, and never a repo-level secret", async () => {
      const world = aWorld();
      // The owner's setting names a new repo's first branch, whatever the Product repo's default branch is.
      world.store.firstBranch = "trunk";

      const { code, said, complaints, log } = await setupOnce(world, { args: WITH_THE_STORE });

      expect(complaints).toEqual([]);
      expect(code).toBe(0);
      expect(planned(said).filter((line) => line.includes(STORE))).toEqual([
        "- create jrey8343/fabrik-runs, private, to hold Run records, their transcripts and the Weekly summary",
        "- write .github/workflows/weekly-summary.yml in jrey8343/fabrik-runs (the Weekly summary each Monday morning, pinning one Fabrik release)",
        "- write .github/dependabot.yml in jrey8343/fabrik-runs (Dependabot bumps the Fabrik pin)",
        "- create the fabrik environment in jrey8343/fabrik-runs, held to its default branch alone: only a run of its default branch is given its secrets",
        '- create the read-only service account "fabrik-jrey8343-fabrik-runs-push-env" (reads "Fabrik App") and store it as FABRIK_OP_PUSH_TOKEN in the fabrik environment in jrey8343/fabrik-runs',
      ]);
      const RULES = `gh api ${STORE_ENVIRONMENT}/deployment-branch-policies?per_page=100`;
      /** The environment read whole: its setting, then its rules. */
      const READ = [`gh api ${STORE_ENVIRONMENT}`, RULES];
      const BRANCH_NOW = `gh repo view ${STORE} --json defaultBranchRef`;
      const steps = log.slice(index(log, /^gh repo create /));
      expect(steps.slice(0, steps.indexOf(`gh secret set ${TOKEN} --env fabrik --repo ${STORE}`) + 1).filter((line) => line.includes(STORE) || line.startsWith("op service-account"))).toEqual([
        expect.stringMatching(/^gh repo create jrey8343\/fabrik-runs --private /),
        `gh api repos/${STORE}/contents/${STORE_CALLER}`,
        `gh api --method PUT repos/${STORE}/contents/${STORE_CALLER} --input -`,
        `gh api repos/${STORE}/contents/.github/dependabot.yml`,
        `gh api --method PUT repos/${STORE}/contents/.github/dependabot.yml --input -`,
        BRANCH_NOW,
        `gh api --method PUT ${STORE_ENVIRONMENT} --input -`,
        RULES,
        `gh api --method POST ${STORE_ENVIRONMENT}/deployment-branch-policies -f name=trunk -f type=branch`,
        ...READ,
        BRANCH_NOW,
        ...READ,
        NEW_ACCOUNT,
        `gh secret set ${TOKEN} --env fabrik --repo ${STORE}`,
      ]);
      expect(world.store).toMatchObject({ exists: true, private: true, defaultBranch: "trunk" });
      expect(environmentOf(world, "fabrik", STORE)?.rules).toEqual([{ id: expect.any(Number), name: "trunk", type: "branch" }]);
      expect([...environmentOf(world, "fabrik", STORE)!.secrets]).toEqual([TOKEN]);
      expect([...world.store.secrets, ...world.secrets]).toEqual([]);
      expect(said.filter((line) => OF_THE_MOVE.test(line))).toEqual([]);

      mergeTheSetupPr(world);
      expect((await setupOnce(world, { args: WITH_THE_STORE })).said).toContain("Nothing to do: this repo's Fabrik install is complete.");
    });

    it("stops when GitHub refuses the store's environment, with the no-fallback message naming the store, before it writes the store's caller or makes its account", async () => {
      const world = aWorld();
      await aStoreOnTheKitAt(world, "v0.9.1");
      // The Product repo's own environment is held and holds its tokens, so the store's is the plan's first step.
      anEnvironment(world, { rules: ["main"], secrets: TOKENS });
      world.environmentRefusal = "gh: Not Found (HTTP 404)\n";

      const { code, said, complaints, log } = await setupOnce(world, { args: WITH_THE_STORE });

      expect(planned(said)[0]).toBe("- create the fabrik environment in jrey8343/fabrik-runs, held to trunk alone: only a run of trunk is given its secrets");
      expect(code).toBe(1);
      expect(complaints).toEqual([
        "GitHub refused the fabrik environment on jrey8343/fabrik-runs: gh: Not Found (HTTP 404). A private repo needs a GitHub plan with environments: GitHub Pro for a personal account's repo, or GitHub Team for an organization's. The Kit keeps no fallback to repo-level secrets, so Setup stopped before changing anything else.",
      ]);
      expect(environmentOf(world, "fabrik", STORE)).toBeUndefined();
      expect(world.store.files.get(STORE_CALLER)).toContain("weekly-summary.yml@v0.9.1");
      expect(log.filter((line) => /^op service-account create |^gh secret (set|delete) |^gh api --method PUT repos\/jrey8343\/fabrik-runs\/contents\//.test(line))).toEqual([]);
      expect([...world.store.secrets]).toEqual([TOKEN]);
    });

    it("without the Operator's time zone, reads the store's environment with the rest of the store and plans and changes nothing of it", async () => {
      const world = aWorld();
      await aStoreOnTheKitAt(world, "v0.9.1");

      const { code, said, log } = await setupOnce(world);

      expect(code).toBe(0);
      expect(log).toEqual(expect.arrayContaining([`gh repo view ${STORE} --json defaultBranchRef`, `gh api ${STORE_ENVIRONMENT}`]));
      expect(said.filter((line) => line.includes(STORE))).toEqual([]);
      expect(log.filter((line) => line.includes(STORE) && /--method|secret (set|delete)|repo create/.test(line))).toEqual([]);
      expect(environmentOf(world, "fabrik", STORE)).toBeUndefined();
      expect([...world.store.secrets]).toEqual([TOKEN]);
    });

    it("reads no environment and no default branch of a store that doesn't exist", async () => {
      const world = aWorld();

      const { code, log } = await setupOnce(world);

      expect(code).toBe(0);
      expect(log.filter((line) => line.includes(STORE))).toEqual(expect.arrayContaining([`gh repo view ${STORE} --json visibility`]));
      expect(log.filter((line) => line.includes(STORE) && !line.endsWith("--json visibility"))).toEqual([]);
    });
  });

  describe("holding admins to the default branch's rules", () => {
    const HELD = "- protect main: admins held to the rules: no → yes; every other setting stays as it is";
    const protectionPuts = (calls: { line: string; input?: string }[]) =>
      calls.filter((call) => call.line.startsWith("gh api --method PUT repos/acme/clinic/branches/main/protection ")).map((call) => JSON.parse(call.input ?? ""));
    /** Someone switches off "Do not allow bypassing the above settings" on github.com, or the install predates Setup owning it. */
    const switchOffEnforcement = (world: World) => void ((world.protection as Record<string, unknown>)["enforce_admins"] = { enabled: false });

    it("on a fresh repo, sends it on and lists the step as the plan worded it in the setup PR and the closing lines", async () => {
      const world = aWorld();

      const { said, calls } = await setupOnce(world);

      const line = "- protect main: a pull request: not required → required; admins held to the rules: no → yes; every other setting stays as it is";
      expect(protectionPuts(calls).map((put) => put.enforce_admins)).toEqual([true]);
      expect(said).toContain("What setup did:");
      expect(said.slice(said.indexOf("What setup did:"))).toContain(line);
      expect(world.prs[0]!.body.split("\n")).toContain(line);
    });

    it("on an install made before Setup held admins to the rules, applies only that, pushes nothing, opens no PR and goes back to the default branch", async () => {
      const world = aWorld();
      await setupOnce(world);
      mergeTheSetupPr(world);
      switchOffEnforcement(world);
      const before = structuredClone(world.protection);

      const { code, said, complaints, log, calls } = await setupOnce(world);

      expect(complaints).toEqual([]);
      expect(code).toBe(0);
      expect(said).toContain(HELD);
      expect(world.protection).toEqual({ ...(before as object), enforce_admins: { enabled: true } });
      expect(log.filter((line) => /^git (commit|push)|^gh pr (create|edit)/.test(line))).toEqual([]);
      expect(world.prs).toHaveLength(1);
      expect(said).toContain("Every file setup writes is already on main, so there's no setup PR to open. Setup switched back to main.");
      expect(git("branch", "--show-current").trim()).toBe("main");
      expect(protectionPuts(calls)).toHaveLength(1);
      expect((await setupOnce(world)).said).toContain("Nothing to do: this repo's Fabrik install is complete.");
    });

    it("puts it back when it is switched off between two runs", async () => {
      const world = aWorld();
      await setupOnce(world);
      mergeTheSetupPr(world);
      expect((await setupOnce(world)).said).toContain("Nothing to do: this repo's Fabrik install is complete.");
      switchOffEnforcement(world);

      const { said, calls } = await setupOnce(world);

      expect(said).toContain(HELD);
      expect(protectionPuts(calls).map((put) => put.enforce_admins)).toEqual([true]);
      expect((world.protection as Record<string, unknown>)["enforce_admins"]).toEqual({ enabled: true });
    });

    it("with --plan, shows the change and sends nothing", async () => {
      const world = aWorld();
      await setupOnce(world);
      mergeTheSetupPr(world);
      switchOffEnforcement(world);

      const { code, said, calls } = await setupOnce(world, { args: [...FLAGS, "--plan"] });

      expect(code).toBe(0);
      expect(said).toContain(HELD);
      expect(protectionPuts(calls)).toEqual([]);
      expect((world.protection as Record<string, unknown>)["enforce_admins"]).toEqual({ enabled: false });
    });
  });

  it("after a squash merge, a repair run from the default branch gets past the leftover setup branch", async () => {
    const world = aWorld();
    await setupOnce(world);
    squashTheSetupPr(world);
    world.labels.delete("needs-triage");

    const { code, said, complaints } = await setupOnce(world);

    expect(complaints).toEqual([]);
    expect(code).toBe(0);
    expect(said).toContain("- create the label needs-triage");
    expect(world.labels.has("needs-triage")).toBe(true);
    expect(git("branch", "--show-current").trim()).toBe("main");
  });

  it("after a squash merge, with only origin's copy of the setup branch left, a run that writes a file opens a new setup PR from it", async () => {
    const world = aWorld();
    await setupOnce(world);
    squashTheSetupPr(world);
    git("branch", "-q", "-D", BRANCH);
    git("rm", "-q", "docs/agents/domain.md");
    git("commit", "-q", "-m", "Drop the domain doc");
    git("push", "-q", "origin", "main");

    const { code, said, complaints } = await setupOnce(world);

    expect(complaints).toEqual([]);
    expect(code).toBe(0);
    expect(filesOnOrigin()).toContain("docs/agents/domain.md");
    expect(originGit("rev-parse", `${BRANCH}~1`).trim()).toBe(originGit("rev-parse", "main").trim());
    expect(world.prs).toHaveLength(2);
    expect(said).toContain("The setup PR: https://github.com/acme/clinic/pull/2");
  });

  it("on the setup branch after its PR was squash-merged, says to switch to the default branch and pull", async () => {
    const world = aWorld();
    await setupOnce(world);
    squashTheSetupPr(world);
    git("switch", "-q", BRANCH);

    const { code, complaints } = await setupOnce(world);

    expect(code).toBe(1);
    expect(complaints[0]).toBe(`${BRANCH}'s setup PR is merged. Switch to main with git switch main && git pull, then run setup again.`);
  });

  it("after a squash merge of a setup PR whose head GitHub moved on, a repair run from the default branch gets past the leftover setup branch", async () => {
    const world = aWorld();
    await setupOnce(world);
    moveTheHeadOnGitHub();
    squashTheSetupPr(world);
    world.labels.delete("needs-triage");

    const { code, said, complaints } = await setupOnce(world);

    expect(complaints).toEqual([]);
    expect(code).toBe(0);
    expect(said).toContain("- create the label needs-triage");
    expect(world.labels.has("needs-triage")).toBe(true);
    expect(git("branch", "--show-current").trim()).toBe("main");
  });

  it("on the setup branch after its PR, whose head GitHub moved on, was squash-merged, says to switch to the default branch and pull", async () => {
    const world = aWorld();
    await setupOnce(world);
    moveTheHeadOnGitHub();
    squashTheSetupPr(world);
    git("switch", "-q", BRANCH);

    const { code, complaints } = await setupOnce(world);

    expect(code).toBe(1);
    expect(complaints[0]).toBe(`${BRANCH}'s setup PR is merged. Switch to main with git switch main && git pull, then run setup again.`);
  });

  it("after a squash merge of a setup PR GitHub updated with rebase, a repair run from the default branch gets past the leftover setup branch", async () => {
    const world = aWorld();
    await setupOnce(world);
    await rebaseTheHeadOnGitHub(world);
    await squashOnGitHub(world);
    git("switch", "-q", "main");
    git("pull", "-q", "origin", "main");
    world.labels.delete("needs-triage");

    const { code, said, complaints } = await setupOnce(world);

    expect(complaints).toEqual([]);
    expect(code).toBe(0);
    expect(said).toContain("- create the label needs-triage");
    expect(world.labels.has("needs-triage")).toBe(true);
    expect(git("branch", "--show-current").trim()).toBe("main");
  });

  it("on the setup branch after its PR, which GitHub updated with rebase, was squash-merged, says to go back to the default branch, which works", async () => {
    const world = aWorld();
    await setupOnce(world);
    await rebaseTheHeadOnGitHub(world);
    await squashOnGitHub(world);
    git("branch", "-q", "--set-upstream-to=origin/main", "main");

    const { code, complaints } = await setupOnce(world);

    expect(code).toBe(1);
    expect(complaints[0]).toBe(`${BRANCH}'s setup PR is merged. Switch to main with git switch main && git pull, then run setup again.`);
    follow(complaints[0]);
    world.labels.delete("needs-triage");
    const again = await setupOnce(world);
    expect(again.complaints).toEqual([]);
    expect(again.said).toContain("- create the label needs-triage");
  });

  it("after a squash merge of a setup PR GitHub updated with rebase over another PR's edit next to setup's, a repair run from the default branch gets past the leftover setup branch", async () => {
    await aGitignoreOnMain();
    const world = aWorld();
    await setupOnce(world);
    await rebaseOverANearbyEditOnGitHub(world);
    await squashOnGitHub(world);
    git("switch", "-q", "main");
    git("pull", "-q", "origin", "main");
    world.labels.delete("needs-triage");

    const { code, said, complaints } = await setupOnce(world);

    expect(complaints).toEqual([]);
    expect(code).toBe(0);
    expect(said).toContain("- create the label needs-triage");
    expect(world.prs).toHaveLength(1);
    expect(git("branch", "--show-current").trim()).toBe("main");
  });

  it("on the setup branch after its PR, which GitHub updated with rebase over another PR's edit next to setup's, was squash-merged, says to go back to the default branch", async () => {
    await aGitignoreOnMain();
    const world = aWorld();
    await setupOnce(world);
    await rebaseOverANearbyEditOnGitHub(world);
    await squashOnGitHub(world);

    const { code, complaints } = await setupOnce(world);

    expect(code).toBe(1);
    expect(complaints[0]).toBe(`${BRANCH}'s setup PR is merged. Switch to main with git switch main && git pull, then run setup again.`);
  });

  // GitHub's squash has the edit setup's own copy lacks, so merging that copy into main conflicts.
  describe.each([
    ["a suggested change to setup's block in .gitignore", ".gitignore", "# mine\n"],
    ["a line added to the caller workflow setup wrote", ".github/workflows/fabrik.yml", "# reviewed\n"],
  ])("after GitHub updated the setup PR with rebase over another PR's edit next to setup's, then %s was committed on GitHub, and the PR was squash-merged", (_, path, line) => {
    async function mergedAfterAnEditOnGitHub(world: World): Promise<void> {
      await aGitignoreOnMain();
      await setupOnce(world);
      await rebaseOverANearbyEditOnGitHub(world);
      await editOnGitHub(path, line);
      await squashOnGitHub(world);
    }

    // A line added to the Kit-owned caller workflow is drift, which the repair puts back in a setup PR of its own.
    it("a repair run from the default branch gets past the leftover setup branch", async () => {
      const world = aWorld();
      await mergedAfterAnEditOnGitHub(world);
      git("switch", "-q", "main");
      git("pull", "-q", "origin", "main");
      world.labels.delete("needs-triage");

      const { code, said, complaints } = await setupOnce(world);

      expect(complaints).toEqual([]);
      expect(code).toBe(0);
      expect(said).toContain("- create the label needs-triage");
      expect(world.labels.has("needs-triage")).toBe(true);
    });

    it("on the setup branch, says to go back to the default branch, which works", async () => {
      const world = aWorld();
      await mergedAfterAnEditOnGitHub(world);
      git("branch", "-q", "--set-upstream-to=origin/main", "main");

      const { code, complaints } = await setupOnce(world);

      expect(code).toBe(1);
      expect(complaints[0]).toBe(`${BRANCH}'s setup PR is merged. Switch to main with git switch main && git pull, then run setup again.`);
      follow(complaints[0]);
      world.labels.delete("needs-triage");
      const again = await setupOnce(world);
      expect(again.complaints).toEqual([]);
      expect(again.said).toContain("- create the label needs-triage");
    });
  });

  it("on the setup branch after its PR was squash-merged behind another PR, and the Operator pulled the default branch in and pushed, a repair leaves the clone on the up-to-date default branch, and later runs get past origin's copy", async () => {
    const world = aWorld();
    await setupOnce(world);
    await anotherPrOnGitHub();
    await squashOnGitHub(world);
    git("pull", "-q", "--no-rebase", "origin", "main");
    git("push", "-q", "origin", BRANCH);
    world.labels.delete("needs-triage");

    const onTheBranch = await setupOnce(world);

    expect(onTheBranch.complaints).toEqual([]);
    expect(onTheBranch.said).toContain("Every file setup writes is already on main, so there's no setup PR to open. Setup switched back to main.");
    expect(git("branch", "--show-current").trim()).toBe("main");
    expect(git("rev-parse", "main").trim()).toBe(originGit("rev-parse", "main").trim());
    for (const _ of [1, 2]) {
      world.labels.delete("needs-triage");
      const { code, said, complaints } = await setupOnce(world);
      expect(complaints).toEqual([]);
      expect(code).toBe(0);
      expect(said).toContain("- create the label needs-triage");
    }
    expect(world.prs).toHaveLength(1);
  });

  it("after its PR was squash-merged behind another PR, and another clone pulled the default branch into origin's setup branch, every repair run from the default branch gets past origin's copy, which this clone never fetched", async () => {
    const world = aWorld();
    await setupOnce(world);
    await anotherPrOnGitHub();
    await squashOnGitHub(world);
    const other = await aGitHubClone();
    other.git("switch", "-q", BRANCH);
    other.git("pull", "-q", "--no-rebase", "origin", "main");
    other.git("push", "-q", "origin", BRANCH);
    git("switch", "-q", "main");
    git("pull", "-q", "origin", "main");
    expect(() => git("cat-file", "-e", `${originGit("rev-parse", BRANCH).trim()}^{commit}`)).toThrow();
    const tracking = git("rev-parse", `refs/remotes/origin/${BRANCH}`);

    for (const _ of [1, 2]) {
      world.labels.delete("needs-triage");
      const { code, said, complaints } = await setupOnce(world);
      expect(complaints).toEqual([]);
      expect(code).toBe(0);
      expect(said).toContain("- create the label needs-triage");
      expect(git("branch", "--show-current").trim()).toBe("main");
    }
    expect(world.prs).toHaveLength(1);
    // Only origin's commits came in: the clone's copy of origin's setup branch didn't move.
    expect(git("rev-parse", `refs/remotes/origin/${BRANCH}`)).toBe(tracking);
  });

  it("on the setup branch, a repair that writes no file and goes back to a default branch with a commit of its own here says to make it origin's", async () => {
    const world = aWorld();
    await setupOnce(world);
    squashTheSetupPr(world);
    await writeFile(join(checkout, "NOTES.md"), "# Notes\n");
    git("add", "NOTES.md");
    git("commit", "-q", "-m", "Notes, not pushed");
    git("switch", "-q", BRANCH);
    git("pull", "-q", "--no-rebase", "origin", "main");
    world.labels.delete("needs-triage");

    const { code, said, complaints } = await setupOnce(world);

    expect(complaints).toEqual([]);
    expect(code).toBe(0);
    expect(said).toContain(
      "Every file setup writes is already on main, so there's no setup PR to open. Setup switched back to main, which here isn't the same as on origin: pull, or take the commits made here to origin through a pull request, then run setup again.",
    );
    expect(git("branch", "--show-current").trim()).toBe("main");
    expect(git("log", "-1", "--format=%s").trim()).toBe("Notes, not pushed");
  });

  it("after its setup PR was closed unmerged and its commit cherry-picked onto the default branch by hand, every repair run from there gets past the setup branch, here and on origin", async () => {
    const world = aWorld();
    await setupOnce(world);
    world.prs[0]!.open = false;
    const tip = git("rev-parse", "HEAD").trim();
    git("switch", "-q", "main");
    git("cherry-pick", "-x", tip);
    git("push", "-q", "origin", "main");

    for (const _ of [1, 2]) {
      world.labels.delete("needs-triage");
      const { code, said, complaints } = await setupOnce(world);
      expect(complaints).toEqual([]);
      expect(code).toBe(0);
      expect(said).toContain("- create the label needs-triage");
      expect(git("branch", "--show-current").trim()).toBe("main");
    }
    expect(world.prs).toHaveLength(1);
  });

  it("on the setup branch after its PR was squash-merged and the Operator pulled the default branch in, a repair that writes no file opens no setup PR", async () => {
    const world = aWorld();
    await setupOnce(world);
    squashTheSetupPr(world);
    git("switch", "-q", BRANCH);
    git("pull", "-q", "--no-rebase", "origin", "main");
    world.labels.delete("needs-triage");

    const { code, said, complaints } = await setupOnce(world);

    expect(complaints).toEqual([]);
    expect(code).toBe(0);
    expect(said).toContain("- create the label needs-triage");
    expect(world.prs).toHaveLength(1);
    expect(said).toContain("Every file setup writes is already on main, so there's no setup PR to open. Setup switched back to main.");
    expect(git("branch", "--show-current").trim()).toBe("main");
  });

  it("on the setup branch after GitHub updated its open PR with rebase, each stop's command works with git's default config", async () => {
    const world = aWorld();
    await setupOnce(world);
    await rebaseTheHeadOnGitHub(world);

    const behind = await setupOnce(world);
    expect(behind.complaints[0]).toMatch(new RegExp(`^${BRANCH} doesn't hold origin's latest main \\(\\w{7}\\)\\. Merge it in with git pull --no-rebase origin main, then run setup again\\.$`));
    follow(behind.complaints[0]);
    const lacking = await setupOnce(world);
    expect(lacking.complaints[0]).toMatch(
      new RegExp(`^origin's ${BRANCH} has commits this clone lacks \\(\\w{7}\\)\\. Pull them with git pull --no-rebase origin ${BRANCH}, then run setup again\\.$`),
    );
    follow(lacking.complaints[0]);
    const { code, complaints } = await setupOnce(world);

    expect(complaints).toEqual([]);
    expect(code).toBe(0);
    expect(world.prs).toHaveLength(1);
  });

  it("from the default branch, a merged copy of the setup branch here doesn't stop the fetch of origin's newer one", async () => {
    const world = aWorld();
    await setupOnce(world);
    squashTheSetupPr(world);
    // Setup ran again from another clone: a new setup branch on origin, from main, and its open PR.
    const github = await aGitHubClone();
    github.git("switch", "-q", "-C", BRANCH, "origin/main");
    await writeFile(join(github.dir, "CLAUDE.md"), "# Clinic\n");
    github.git("add", "CLAUDE.md");
    github.git("commit", "-q", "-m", "Set up Fabrik v1.4.2");
    github.git("push", "-q", "--force", "origin", BRANCH);
    world.prs.push({ number: 2, url: "https://github.com/acme/clinic/pull/2", head: BRANCH, base: "main", isCrossRepository: false, body: "", open: true });
    world.labels.delete("needs-triage");

    const { code, complaints } = await setupOnce(world);

    expect(code).toBe(1);
    expect(complaints[0]).toMatch(new RegExp(`^origin's ${BRANCH} holds an earlier run of setup that isn't on main yet\\.`));
    follow(complaints[0]);
    expect(git("branch", "--show-current").trim()).toBe(BRANCH);
    expect(git("rev-parse", "HEAD").trim()).toBe(originGit("rev-parse", BRANCH).trim());
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

  describe("Setup's report on the repo's own credentials", () => {
    const HEADING = "Setup's report:";
    const COMPLETE = "Nothing to do: this repo's Fabrik install is complete.";
    const RULE =
      "- A credential that can reach production belongs in an environment held to main alone, or in a role taken by OIDC whose trust names that environment and not the whole repo. Only test and preview credentials sit at repo level.";
    const OWN_SECRET = [HEADING, "- The repo-level Actions secret STRIPE_KEY can be read by a workflow run on any branch.", RULE];
    const NONE_OF_ITS_OWN = "- This repo holds no repo-level Actions secret of its own.";

    it("is said under the plan and again in the closing lines, after For the Operator, never in the setup PR, and on a merged install with nothing to apply however Setup is run", async () => {
      // A repo already on the Kit, whose three tokens sit at repo level beside a secret of its own: the Kit's get no line.
      const world = aWorld();
      for (const name of ["STRIPE_KEY", ...TOKENS]) world.secrets.add(name);

      const first = await setupOnce(world);

      expect(first.code).toBe(0);
      const [underThePlan, inTheLastLines] = first.said.flatMap((line, at) => (line === HEADING ? [at] : []));
      expect(first.said.filter((line) => line === HEADING)).toHaveLength(2);
      expect(first.said.slice(underThePlan, underThePlan! + 3)).toEqual(OWN_SECRET);
      expect(underThePlan).toBeLessThan(first.said.indexOf(`On ${BRANCH}.`));
      expect(first.said.slice(inTheLastLines! - 1, inTheLastLines! + 4)).toEqual(["", ...OWN_SECRET, ""]);
      expect(first.said.lastIndexOf("For the Operator:")).toBeGreaterThan(first.said.indexOf("What setup did:"));
      expect(inTheLastLines).toBeGreaterThan(first.said.lastIndexOf("For the Operator:"));
      expect(first.said[inTheLastLines! + 4]).toMatch(/^Merge it yourself once its Required checks pass\./);
      // The Kit's own three names, public in the caller workflow, are in the PR's note that they stay for now (#931), and no line of the report is.
      expect(world.prs[0]!.body).not.toMatch(/STRIPE_KEY|Setup's report|can be read by a workflow run on any branch|A credential that can reach production/);
      mergeTheSetupPr(world);

      // The run made, changed and deleted no repo-level secret.
      expect([...world.secrets].sort()).toEqual([...TOKENS, "STRIPE_KEY"]);
      // The next run finds the new caller workflow on the default branch and deletes the Kit's three (#931), never the repo's own, which the report still names.
      const deleting = await setupOnce(world);
      expect(deleting.said.slice(deleting.said.lastIndexOf(HEADING))).toEqual([...OWN_SECRET, "", expect.stringMatching(/^Every file setup writes is already on main/)]);
      expect([...world.secrets]).toEqual(["STRIPE_KEY"]);
      for (const options of [{}, { args: [...FLAGS, "--plan"] }, { terminal: false }]) {
        const { code, said, questions } = await setupOnce(world, { answers: [], ...options });

        expect(code).toBe(0);
        expect(questions).toEqual([]);
        expect(said.indexOf(COMPLETE)).toBeGreaterThan(-1);
        expect(said.indexOf(COMPLETE)).toBeLessThan(said.indexOf(HEADING));
        expect(said.slice(said.indexOf(HEADING) - 1)).toEqual(["", ...OWN_SECRET]);
      }
      expect(world.prs).toHaveLength(1);
    });

    it("is said in the last lines of a repair that opens no setup PR, before where the run left the clone", async () => {
      const world = aWorld();
      await setupOnce(world);
      mergeTheSetupPr(world);
      world.labels.delete("needs-triage");

      const { code, said } = await setupOnce(world);

      expect(code).toBe(0);
      const last = said.slice(said.lastIndexOf("What setup did:"));
      expect(last.slice(0, 2)).toEqual(["What setup did:", "- create the label needs-triage"]);
      expect(last.slice(last.indexOf(HEADING) - 1)).toEqual([
        "",
        HEADING,
        NONE_OF_ITS_OWN,
        "",
        "Every file setup writes is already on main, so there's no setup PR to open. Setup switched back to main.",
      ]);
    });

    it("says whether the environment the Kit config names for production is held to the default branch alone, once the checkout's Kit config names it, and changes nothing of it", async () => {
      const world = aWorld();
      anEnvironment(world, { rules: ["main"] }, "production");
      const flags = ["--no-time-zone", "--no-second-subscription", "--no-paused", "--no-staging", "--production-url=https://clinic.example.com", "--production-environment=production"];

      const first = await setupOnce(world, { args: flags });

      expect(first.code).toBe(0);
      // Under the plan the checkout holds no Kit config yet; the last lines are read from the setup branch's, which names it.
      const [underThePlan, inTheLastLines] = first.said.flatMap((line, at) => (line === HEADING ? [at] : []));
      expect(first.said.slice(underThePlan, underThePlan! + 3)).toEqual([HEADING, NONE_OF_ITS_OWN, ""]);
      expect(first.said.slice(inTheLastLines, inTheLastLines! + 4)).toEqual([HEADING, NONE_OF_ITS_OWN, "- Production's environment, production, is held to main alone.", ""]);
      expect(world.prs[0]!.body).not.toContain("Production's environment");
      mergeTheSetupPr(world);

      // Someone adds a tag rule on github.com.
      environmentOf(world, "production")!.rules.push({ id: 900, name: "v*", type: "tag" });
      const loosened = await setupOnce(world, { args: flags, answers: [] });

      expect(loosened.said.slice(loosened.said.indexOf(HEADING))).toEqual([
        HEADING,
        NONE_OF_ITS_OWN,
        "- Production's environment, production, isn't held to main alone (main, tag v*), so a run on another ref that names it is given its secrets.",
      ]);
      expect(loosened.said).toContain(COMPLETE);

      world.environments.delete("acme/clinic/production");
      const gone = await setupOnce(world, { args: flags, answers: [] });

      expect(gone.said.at(-1)).toBe("- Production's environment, production, isn't on this repo.");
      expect(gone.said).toContain(COMPLETE);
      const onProduction = world.environmentCalls.filter((line) => line.includes("environments/production") || line.includes("--env production"));
      expect(onProduction.length).toBeGreaterThan(0);
      expect(onProduction.filter((line) => !/^gh api repos\/acme\/clinic\/environments\/production(\/deployment-branch-policies\?per_page=100)?$/.test(line))).toEqual([]);
    });

    it("carries on when GitHub refuses the read of production's environment, after the wizard and before the plan, and says it couldn't be read", async () => {
      const world = aWorld();
      anEnvironment(world, { rules: ["main"] }, "production").refusesRead = "gh: Resource not accessible by personal access token (HTTP 403)\n";
      const flags = ["--no-time-zone", "--no-second-subscription", "--no-paused", "--no-staging", "--production-url=https://clinic.example.com", "--production-environment=production"];
      const UNREAD =
        "- Production's environment, production, couldn't be read (gh: Resource not accessible by personal access token (HTTP 403)), so Setup can't say whether it is held to main alone.";

      // The first read of it is the one after the wizard, from the setup branch's Kit config.
      const first = await setupOnce(world, { args: flags });

      expect(first.complaints).toEqual([]);
      expect(first.code).toBe(0);
      expect(first.said.slice(first.said.lastIndexOf(HEADING), first.said.lastIndexOf(HEADING) + 4)).toEqual([HEADING, NONE_OF_ITS_OWN, UNREAD, ""]);
      expect(world.prs).toHaveLength(1);
      mergeTheSetupPr(world);

      // On the next run the checkout's Kit config names it, so it is read before the plan.
      const second = await setupOnce(world, { args: flags, answers: [] });

      expect(second.complaints).toEqual([]);
      expect(second.code).toBe(0);
      expect(second.said.slice(second.said.indexOf(HEADING))).toEqual([HEADING, NONE_OF_ITS_OWN, UNREAD]);
      expect(second.said).toContain(COMPLETE);
    });

    it("still stops when GitHub refuses the read of the fabrik environment with anything but a 404, naming its answer", async () => {
      const world = aWorld();
      anEnvironment(world, { rules: ["main"] }).refusesRead = "gh: Bad Gateway (HTTP 502)\n";

      const { code, complaints, log } = await setupOnce(world);

      expect(code).toBe(1);
      expect(complaints.join("\n")).toContain("Reading the fabrik environment on acme/clinic failed: gh: Bad Gateway (HTTP 502)");
      expect(log.filter((line) => /--method|^op service-account create |^gh secret set /.test(line))).toEqual([]);
    });
  });
});
