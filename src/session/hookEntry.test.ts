// The SessionStart hook entry is one of the Kit's stable shims in a Product
// repo, so it can't import anything: it's run here as Claude Code runs it, with
// git told by the environment to read `https://github.com/` from a local folder
// that holds a stand-in Fabrik.
import { execFile } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { aRepository, aSkillsSource, git, gitHubFrom, tempDir } from "../__fixtures__/skillsArchive.ts";

const run = promisify(execFile);
const TEMPLATE = resolve(import.meta.dirname, "..", "..", "templates", "claude-settings.json");

interface HookSettings {
  hooks: { SessionStart: { hooks: { type: string; command: string; timeout: number }[] }[] };
  enabledPlugins: Record<string, boolean>;
}

async function hookCommand(): Promise<string> {
  const settings = JSON.parse(await readFile(TEMPLATE, "utf8")) as HookSettings;
  const [entry] = settings.hooks.SessionStart;
  const [hook] = entry?.hooks ?? [];
  if (hook === undefined) throw new Error("The template has no SessionStart hook");
  return hook.command;
}

/** A stand-in start.ts that prints the arguments it was run with, and which commit of Fabrik it is. */
const standInStart = (at: string) =>
  `const args: string[] = process.argv.slice(2);\nconsole.log(JSON.stringify({ ran: args, at: ${JSON.stringify(at)} }));\n`;

/**
 * A folder standing in for github.com, where jrey8343/fabrik is a repository
 * whose annotated tag v1.4.2 holds a stand-in start.ts, and whose branch has
 * moved on past it.
 */
async function aGitHub(): Promise<string> {
  const github = await tempDir("github");
  const fabrik = join(github, "jrey8343/fabrik");
  await aRepository(fabrik, { "src/session/start.ts": standInStart("v1.4.2") });
  git(fabrik, "tag", "-a", "v1.4.2", "-m", "Fabrik v1.4.2");
  await writeFile(join(fabrik, "src/session/start.ts"), standInStart("main"));
  git(fabrik, "commit", "-q", "-am", "Later work");
  return github;
}

async function aProduct(caller: string | null): Promise<string> {
  const product = await tempDir("product");
  if (caller !== null) {
    await mkdir(join(product, ".github/workflows"), { recursive: true });
    await writeFile(join(product, ".github/workflows/fabrik.yml"), caller);
  }
  return product;
}

const callerAt = (release: string) => `jobs:
  loop:
    uses: jrey8343/fabrik/.github/workflows/loop.yml@${release}
  tick:
    uses: "jrey8343/fabrik/.github/workflows/schedule.yml@${release}" # pinned
`;

async function runHook(product: string, github: string): Promise<string> {
  const { stdout } = await run("sh", ["-c", await hookCommand()], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: product, ...gitHubFrom(github) },
  });
  return stdout.trim();
}

describe("The SessionStart hook entry", () => {
  it("fetches Fabrik from github.com at the release the caller workflow pins and runs its session start on the project", async () => {
    const product = await aProduct(callerAt("v1.4.2"));

    const stdout = await runHook(product, await aGitHub());

    expect(JSON.parse(stdout)).toEqual({ ran: [product, "v1.4.2"], at: "v1.4.2" });
  });

  it("warns the Operator, without failing the session, when the repo pins no Fabrik release", async () => {
    const product = await aProduct(null);

    const stdout = await runHook(product, await aGitHub());

    expect(JSON.parse(stdout)).toEqual({
      systemMessage: "Fabrik didn't install its skills: .github/workflows/fabrik.yml pins no Fabrik release",
    });
  });

  it("warns the Operator, without failing the session, when the release can't be fetched from github.com", async () => {
    const product = await aProduct(callerAt("v9.9.9"));

    const stdout = await runHook(product, await aGitHub());

    expect(JSON.parse(stdout)).toEqual({
      systemMessage: "Fabrik didn't install its skills: fetching Fabrik v9.9.9 from github.com failed",
    });
  });

  it("downloads no archive, and keeps the Kit's name, by which Setup finds its entry in a Product repo's settings", async () => {
    const command = await hookCommand();

    expect(command).not.toContain("curl");
    expect(command).not.toContain("tar.gz");
    expect(command).toContain('git -C "$d" fetch -q --depth 1 https://github.com/jrey8343/fabrik "refs/tags/$v"');
  });

  it("is described in the README's Layout as fetching Fabrik and each Skills source by git's own shallow fetch from github.com", async () => {
    const readme = await readFile(resolve(import.meta.dirname, "..", "..", "README.md"), "utf8");
    const layout = readme.split("\n## Layout\n")[1]?.split("\n## ")[0] ?? "";
    const bullet = layout.split("\n").find((line) => line.startsWith("- `templates/claude-settings.json`"));

    expect(bullet).toBe(
      "- `templates/claude-settings.json` holds the `SessionStart` hook entry a Product repo merges into `.claude/settings.json`, and disables the `mattpocock-skills` plugin there. The entry reads the release from `fabrik.yml`, fetches Fabrik at that tag by git's own shallow fetch from `github.com` (public, no credentials, and served to a cloud session for a repo that isn't attached), and runs `src/session/start.ts`, which installs the skills that release's `skills.lock.json` pins, the same commit the Kit step installs in Actions, plus Fabrik's own `skills/` (`fabrik-live-design`, `fabrik-pair`, `fabrik-trial` and `fabrik-visual-evidence`). The skills are fetched the same way, each Skills source at its pinned commit, in a cloud session, at a terminal and in an AFK run alike. It also removes the `fabrik-setup` skill earlier releases installed there, and warns the Operator while their personal skills hold an old copy of it.",
    );
  });

  it("gives the hook two minutes, and disables the skills plugin, so every session runs the pinned skills", async () => {
    const settings = JSON.parse(await readFile(TEMPLATE, "utf8")) as HookSettings;

    expect(settings.hooks.SessionStart[0]?.hooks[0]?.timeout).toBe(120);
    expect(settings.enabledPlugins).toEqual({ "mattpocock-skills@claude-plugins-official": false });
  });
});

const FABRIK = resolve(import.meta.dirname, "..", "..");

describe("fabrik's own SessionStart hook entry", () => {
  /**
   * A stand-in fabrik checkout, its src/ this one's, whose skills.lock.json pins
   * a mattpocock/skills held in the stand-in for github.com, with skills of its
   * own and no caller workflow.
   */
  async function aFabrikCheckout(github: string): Promise<string> {
    const { sha } = await aSkillsSource({ "skills/engineering/grilling": "# grilling" }, { at: join(github, "mattpocock/skills") });
    const fabrik = await tempDir("fabrik");
    await symlink(join(FABRIK, "src"), join(fabrik, "src"));
    await writeFile(join(fabrik, "skills.lock.json"), JSON.stringify({ repository: "mattpocock/skills", sha }));
    await mkdir(join(fabrik, "skills/fabrik-pair"), { recursive: true });
    await writeFile(join(fabrik, "skills/fabrik-pair/SKILL.md"), "---\nname: fabrik-pair\n---\n# Pair");
    return fabrik;
  }

  async function ownSettings(): Promise<HookSettings> {
    return JSON.parse(await readFile(join(FABRIK, ".claude/settings.json"), "utf8")) as HookSettings;
  }

  it("is one SessionStart hook that runs src/session/start.ts --kit on fabrik's own checkout, with two minutes, and turns the skills plugin off", async () => {
    const settings = await ownSettings();

    expect(settings.hooks.SessionStart).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: 'node "$CLAUDE_PROJECT_DIR/src/session/start.ts" --kit "$CLAUDE_PROJECT_DIR"',
            timeout: 120,
          },
        ],
      },
    ]);
    expect(settings.enabledPlugins).toEqual({ "mattpocock-skills@claude-plugins-official": false });
  });

  it("installs the Base skills the checkout pins and its own skills/ into its .claude/skills/, downloading no Fabrik, and asks Claude Code to reload them", async () => {
    const github = await tempDir("github");
    const fabrik = await aFabrikCheckout(github);
    const [hook] = (await ownSettings()).hooks.SessionStart[0]?.hooks ?? [];

    const { stdout } = await run("sh", ["-c", hook?.command ?? "exit 1"], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: fabrik, HOME: await tempDir("home"), CLAUDE_CONFIG_DIR: "", ...gitHubFrom(github) },
    });
    const output = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string; reloadSkills: boolean }; systemMessage?: string };

    expect(output.systemMessage).toBeUndefined();
    expect(output.hookSpecificOutput.reloadSkills).toBe(true);
    expect(output.hookSpecificOutput.additionalContext.split("\n")[0]).toMatch(/^This checkout is Fabrik itself\. /);
    expect(await readFile(join(fabrik, ".claude/skills/grilling/SKILL.md"), "utf8")).toBe("# grilling");
    expect(await readFile(join(fabrik, ".claude/skills/fabrik-pair/SKILL.md"), "utf8")).toContain("# Pair");
  });

  it("names both forms when it's run with neither", async () => {
    const failed = await run("node", [join(FABRIK, "src/session/start.ts"), "--kit"]).catch((error: { code: number; stderr: string }) => error);

    expect(failed).toMatchObject({ code: 2 });
    expect((failed as { stderr: string }).stderr.trim()).toBe(
      "Usage: node src/session/start.ts <product checkout> <release>\n       node src/session/start.ts --kit <fabrik checkout>",
    );
  });

  it("leaves nothing it installs to be committed: fabrik's .gitignore ignores .claude/skills/, beside .claude/worktrees/", async () => {
    const ignored = (await readFile(join(FABRIK, ".gitignore"), "utf8")).split("\n");

    expect(ignored).toContain(".claude/skills/");
    expect(ignored).toContain(".claude/worktrees/");
  });
});
