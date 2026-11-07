// One run of the setup program in a terminal, from the plan to the setup PR:
// git runs for real against a bare origin, GitHub and 1Password are a fake
// world that keeps what each run did, and the wizard is a stand-in that
// stores what the Operator would.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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
}

async function setupOnce(world: World, { answers = ["y"], wizard = walksEveryStage, args = FLAGS, terminal = true }: Options = {}) {
  const log: string[] = [];
  const said: string[] = [];
  const complaints: string[] = [];
  const wizardRuns: { cwd: string; env: Env }[] = [];
  const commands = fakeCommands({ ...aReadyOperator(checkout), ...worldScript(world, { commitsAhead, compare }) });
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
    expect(said.some((line) => line.startsWith("Merge it yourself once its gating checks pass."))).toBe(true);
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
    expect(merging[2]).toMatch(/^Then merge it yourself once its gating checks pass\. /);
    expect(said.join("\n")).not.toMatch(/the Claude token|walk the wizard for them/);
    const body = world.prs[0]?.body ?? "";
    expect(body).toContain(
      "Don't merge this yet. The Kit's first runs need these, which no wizard stage stores, so you store them yourself, as For the Operator says:\n\n" +
        '- the "Claude backup" Subscription\'s token, in the "Fabrik" vault\n\n' +
        "Then merge this PR yourself once its gating checks pass.",
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
    expect(said.some((line) => line.startsWith("Merge it yourself once its gating checks pass."))).toBe(true);
    expect(said.some((line) => line.startsWith("Don't merge it yet."))).toBe(false);
    expect(said.some((line) => line.includes('lists "Claude token 2" in subscriptions, but the "Fabrik" vault has no item of that name'))).toBe(true);
    const body = world.prs[0]?.body ?? "";
    expect(body).toContain("Merge this PR yourself once its gating checks pass.");
    expect(body).not.toContain("Don't merge this yet.");
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
    expect(said.join("\n")).not.toContain("Running setup again walks it");
  });

  it("with a second Subscription whose stage the Operator skipped, lists nothing and says to walk it and run setup again", async () => {
    const world = aWorld();

    const { code } = await setupOnce(world, { args: ["--no-time-zone", "--second-subscription", "--no-paused"] });

    expect(code).toBe(0);
    expect(JSON.parse(originGit("show", `${BRANCH}:.fabrik/config.json`)).subscriptions).toEqual(["Claude token"]);
    expect(world.prs[0]?.body).toMatch(
      /Walk the wizard's "A second Subscription" stage: .* Running setup again walks it, then lists it in subscriptions in \.fabrik\/config\.json: curl -fsSL \S+ \| bash -s -- v1\.4\.2\n/,
    );
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

  it("with --paused, a run after one that wrote the starter and stopped partway says nothing about --paused having had no effect", async () => {
    const world = aWorld();
    world.failingLabels.add("needs-info");
    const args = ["--no-time-zone", "--no-second-subscription", "--paused"];
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
    const withPaused = (paused: boolean) => ["--no-time-zone", "--no-second-subscription", paused ? "--paused" : "--no-paused"];
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

      const { code, said, questions } = await setupOnce(world, { args: ["--no-time-zone", "--no-second-subscription"], answers: ["", "y"] });

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
      const args = ["--no-time-zone", "--second-subscription", "--no-paused"];

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
      const withTheFlag = ["--no-time-zone", "--second-subscription", "--no-paused"];

      async function aRotationOnMain(world: World): Promise<void> {
        await aMergedInstallLacking(world, async (lacking) => {
          store(lacking, "Fabrik", "Claude backup");
          await listOnMain(["Claude token", "Claude backup"]);
        });
      }

      it("doesn't ask about a second Subscription, and says it leaves that list as it is", async () => {
        const world = aWorld();
        await aRotationOnMain(world);

        const { code, said, questions } = await setupOnce(world, { answers: [], args: ["--no-time-zone", "--no-paused"] });

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

      const { code, wizardRuns } = await setupOnce(world, { args: ["--no-time-zone", "--second-subscription", "--no-paused"], wizard: addsASecondSubscription });

      expect(code).toBe(0);
      expect(wizardRuns[0]?.env[WIZARD_SECOND_SUBSCRIPTION_ENV]).toBe("no");
    });

    it("with a Kit config that lists the second Subscription alone, its token stored, doesn't ask about a second, and says the install is complete", async () => {
      const world = aWorld();
      await aMergedInstallLacking(world, async (lacking) => {
        store(lacking, "Fabrik", "Claude token 2");
        await listOnMain(["Claude token 2"]);
      });

      const { code, said, questions } = await setupOnce(world, { answers: [], args: ["--no-time-zone", "--no-paused"] });

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
      "Every file setup writes is already on main, so there's no setup PR to open. Setup switched back to main, which here isn't the same as on origin: pull or push so they match, then run setup again.",
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
});
