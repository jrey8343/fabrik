// The setup program's checks, run before any planning: each one that fails
// stops setup with a message naming what to fix.
import { mkdir, realpath } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../__fixtures__/skillsArchive.ts";
import {
  aReadyOperator,
  type Answer,
  fakeCommands,
  ghUser,
  HEAD_SHA,
  lsRemote,
  OTHER_SHA,
  REPO_VIEW,
  STATUS,
} from "../__fixtures__/setupCommands.ts";
import { checkSetup } from "./checks.ts";

const EARLIER_WRITES = [".github/workflows/fabrik.yml", ".fabrik/config.json", "docs/agents/domain.md", "AGENTS.md"];

let productDir: string;

beforeEach(async () => {
  productDir = await tempDir("setup-checks");
});

function check(overrides: Record<string, Answer> = {}, options: { env?: Record<string, string>; nodeVersion?: string } = {}) {
  const commands = fakeCommands({ ...aReadyOperator(productDir), ...overrides });
  const result = checkSetup({
    run: commands.run,
    productDir,
    release: "v1.4.2",
    env: options.env ?? {},
    nodeVersion: options.nodeVersion ?? "24.11.0",
    earlierWrites: async () => EARLIER_WRITES,
  });
  return { result, commands };
}

async function problem(overrides: Record<string, Answer> = {}, options: { env?: Record<string, string>; nodeVersion?: string } = {}) {
  const outcome = await check(overrides, options).result;
  if (outcome.ok) throw new Error("the checks passed");
  return outcome.problem;
}

describe("The checks before setup plans anything", () => {
  it("pass for the repo's admin in a clean, up-to-date clone on its default branch", async () => {
    const outcome = await check().result;

    expect(outcome).toEqual({
      ok: true,
      repo: { owner: "acme", name: "clinic", defaultBranch: "main", inOrganization: false },
      branch: "main",
      origin: { defaultBranch: HEAD_SHA, setupBranch: null },
    });
  });

  it.each(["22.11.0", "24.2.0"])("stop on Node before 24.3, such as %s", async (nodeVersion) => {
    expect(await problem({}, { nodeVersion })).toBe(
      `Setup needs Node 24.3 or later, and this is Node ${nodeVersion}. Install Node 24.3 or later, then run setup again.`,
    );
  });

  it.each(["24.3.0", "25.0.0"])("pass on Node %s", async (nodeVersion) => {
    expect((await check({}, { nodeVersion }).result).ok).toBe(true);
  });

  it("stop when OP_SERVICE_ACCOUNT_TOKEN is set, asking to be run without it, and leave it set", async () => {
    const env = { OP_SERVICE_ACCOUNT_TOKEN: "ops_limited" };
    const { result, commands } = check({}, { env });
    const outcome = await result;

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.problem).toMatch(/OP_SERVICE_ACCOUNT_TOKEN is set.*Run setup again without it/s);
    expect(env).toEqual({ OP_SERVICE_ACCOUNT_TOKEN: "ops_limited" });
    expect(commands.calls).toEqual([]);
  });

  it("stop outside a git clone", async () => {
    expect(await problem({ "git rev-parse --show-toplevel": { code: 128, stderr: "fatal: not a git repository" } })).toBe(
      `${productDir} isn't in a git clone. Run setup from the root of the Product repo's clone.`,
    );
  });

  it("stop in a folder below the clone's root, naming the root", async () => {
    const root = productDir;
    productDir = `${root}/docs`;
    await mkdir(productDir);

    expect(await problem({ "git rev-parse --show-toplevel": { stdout: `${await realpath(root)}\n` } })).toBe(
      `${root}/docs isn't the root of its clone. Run setup from ${await realpath(root)}.`,
    );
  });

  it("stop when gh isn't signed in", async () => {
    const stderr = "To get started with GitHub CLI, please run:  gh auth login";

    expect(await problem({ "gh api -i user": { code: 4, stderr } })).toBe(
      `gh couldn't reach GitHub as you (${stderr}). Sign in with gh auth login --scopes workflow, then run setup again.`,
    );
  });

  it("stop without the workflow scope, which pushing the caller workflow needs", async () => {
    expect(await problem({ "gh api -i user": { stdout: ghUser("acme-operator", "gist, read:org, repo") } })).toBe(
      "gh is signed in as acme-operator without the workflow scope, which pushing the caller workflow needs. Run gh auth refresh --scopes workflow, then run setup again.",
    );
  });

  it("stop on a token that names no scopes, such as a fine-grained one in GH_TOKEN", async () => {
    expect(await problem({ "gh api -i user": { stdout: ghUser("acme-operator", null) } })).toMatch(
      /^gh's token for acme-operator names no scopes, so setup can't tell it has the workflow scope\. .*gh auth login --scopes workflow/,
    );
  });

  it("stop when gh can't find the clone's repo", async () => {
    expect(await problem({ [REPO_VIEW]: { code: 1, stderr: "none of the git remotes configured for this repository point to a known GitHub host" } })).toBe(
      "gh can't find this clone's repo on GitHub (none of the git remotes configured for this repository point to a known GitHub host). Run setup from a clone of the Product repo.",
    );
  });

  it("stop unless the signed-in account is the repo's admin", async () => {
    const view = { owner: { login: "acme" }, name: "clinic", defaultBranchRef: { name: "main" }, isInOrganization: false, viewerPermission: "WRITE" };

    expect(await problem({ [REPO_VIEW]: { stdout: JSON.stringify(view) } })).toBe(
      "gh is signed in as acme-operator, who has WRITE on acme/clinic, and setup needs ADMIN. Sign in to gh as the repo's admin with gh auth login, then run setup again.",
    );
  });

  it("stop on a branch other than the default branch", async () => {
    expect(await problem({ "git branch --show-current": { stdout: "ticket-12\n" } })).toBe(
      "This clone is on ticket-12, not main. Switch to main with git switch main, then run setup again.",
    );
  });

  it("stop when the repo has no default branch on GitHub, as one nothing has been pushed to", async () => {
    const view = { owner: { login: "acme" }, name: "clinic", defaultBranchRef: null, isInOrganization: false, viewerPermission: "ADMIN" };

    expect(await problem({ [REPO_VIEW]: { stdout: JSON.stringify(view) }, "git branch --show-current": { stdout: "main\n" } })).toBe(
      "acme/clinic has no default branch on GitHub: nothing has been pushed to it yet. Push a first commit to it, then run setup again.",
    );
  });

  it("stop with no branch checked out", async () => {
    expect(await problem({ "git branch --show-current": { stdout: "\n" } })).toBe(
      "This clone isn't on a branch. Switch to main with git switch main, then run setup again.",
    );
  });

  it("stop on uncommitted changes, naming them", async () => {
    expect(await problem({ [STATUS]: { stdout: " M README.md\0?? notes/todo.md\0R  src/new.ts\0src/old.ts\0" } })).toBe(
      "This clone has uncommitted changes (README.md, notes/todo.md, src/new.ts, src/old.ts). Commit or stash them, then run setup again.",
    );
  });

  describe("with skills the SessionStart hook installed left untracked in .claude/skills/, as after a setup PR was closed", () => {
    const skills = "?? .claude/skills/tdd/SKILL.md\0?? .claude/skills/.fabrik-install.json\0";

    it("pass as if the clone were clean", async () => {
      expect((await check({ [STATUS]: { stdout: skills } }).result).ok).toBe(true);
    });

    it("pass on the setup branch, alongside files an earlier run wrote", async () => {
      const status = { stdout: `${skills}?? .github/workflows/fabrik.yml\0` };

      expect((await check({ "git branch --show-current": { stdout: "fabrik/setup-v1.4.2\n" }, [STATUS]: status }).result).ok).toBe(true);
    });

    it("stop on any other uncommitted change, naming only it", async () => {
      expect(await problem({ [STATUS]: { stdout: `${skills} M README.md\0` } })).toBe(
        "This clone has uncommitted changes (README.md). Commit or stash them, then run setup again.",
      );
    });

    it.each([".claude/skillsets/x.md", ".claude/settings.json", ".claude/skills"])("stop on an untracked %s, which isn't in the folder", async (path) => {
      expect(await problem({ [STATUS]: { stdout: `${skills}?? ${path}\0` } })).toBe(
        `This clone has uncommitted changes (${path}). Commit or stash them, then run setup again.`,
      );
    });

    it.each([" M", "M ", " D", "A "])("stop on a tracked file in the folder with status %j, on either branch", async (code) => {
      const status = { stdout: `${skills}${code} .claude/skills/mine/SKILL.md\0` };

      expect(await problem({ [STATUS]: status })).toBe(
        "This clone has uncommitted changes (.claude/skills/mine/SKILL.md). Commit or stash them, then run setup again.",
      );
      expect(await problem({ "git branch --show-current": { stdout: "fabrik/setup-v1.4.2\n" }, [STATUS]: status })).toBe(
        "fabrik/setup-v1.4.2 has uncommitted changes setup didn't make (.claude/skills/mine/SKILL.md). Commit or stash them, then run setup again.",
      );
    });

    it("stop on a tracked file renamed out of the folder, naming both its paths", async () => {
      expect(await problem({ [STATUS]: { stdout: `${skills}R  notes/SKILL.md\0.claude/skills/mine/SKILL.md\0` } })).toBe(
        "This clone has uncommitted changes (notes/SKILL.md, .claude/skills/mine/SKILL.md). Commit or stash them, then run setup again.",
      );
    });
  });

  it("stop when the default branch here isn't the one on origin", async () => {
    expect(await problem({ [lsRemote("v1.4.2")]: { stdout: `${OTHER_SHA}\trefs/heads/main\n` } })).toBe(
      "main here isn't the same as on origin (4ae2317 here, 9f86d08 on origin). Pull, or take the commits made here to origin through a pull request, then run setup again.",
    );
  });

  it("stop when origin has no default branch", async () => {
    expect(await problem({ [lsRemote("v1.4.2")]: { stdout: "" } })).toBe("origin has no main branch. Push main, then run setup again.");
  });

  it("stop when git can't reach origin", async () => {
    expect(await problem({ [lsRemote("v1.4.2")]: { code: 128, stderr: "fatal: 'origin' does not appear to be a git repository" } })).toBe(
      "git can't reach origin (fatal: 'origin' does not appear to be a git repository). Check the clone's origin remote, then run setup again.",
    );
  });

  describe("on the setup branch, where a run applies its plan and a later run picks up", () => {
    const onSetupBranch = { "git branch --show-current": { stdout: "fabrik/setup-v1.4.2\n" } };

    it("pass when it holds origin's default branch", async () => {
      expect((await check(onSetupBranch).result).ok).toBe(true);
    });

    it("pass with the files an earlier run wrote uncommitted, as a run that stopped partway leaves them", async () => {
      const status = { stdout: "?? .github/workflows/fabrik.yml\0?? docs/agents/domain.md\0 M AGENTS.md\0" };

      expect((await check({ ...onSetupBranch, [STATUS]: status }).result).ok).toBe(true);
    });

    it("stop on any other uncommitted change, naming it", async () => {
      const status = { stdout: "?? .fabrik/config.json\0 M README.md\0" };

      expect(await problem({ ...onSetupBranch, [STATUS]: status })).toBe(
        "fabrik/setup-v1.4.2 has uncommitted changes setup didn't make (README.md). Commit or stash them, then run setup again.",
      );
    });

    it("stop when it lacks the default branch's latest commit on origin", async () => {
      const unmerged = { "gh pr list --head fabrik/setup-v1.4.2 --state merged": { stdout: "[]" } };

      expect(await problem({ ...onSetupBranch, ...unmerged, [lsRemote("v1.4.2")]: { stdout: `${OTHER_SHA}\trefs/heads/main\n` } })).toBe(
        "fabrik/setup-v1.4.2 doesn't hold origin's latest main (9f86d08). Merge it in with git pull --no-rebase origin main, then run setup again.",
      );
    });

    it("stop, saying to go back to the default branch, when a merged setup PR's head holds it, as after GitHub moved the head on and the PR was squash-merged", async () => {
      const movedHead = "c0ffee5ddb22b046e26455e4f9c9b3aaaf62212d";
      const merged = { stdout: JSON.stringify([{ number: 1, headRefOid: movedHead, isCrossRepository: false }]) };
      const noForcePush = { stdout: JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes: [] } } } } }) };

      expect(
        await problem({
          ...onSetupBranch,
          [lsRemote("v1.4.2")]: { stdout: `${OTHER_SHA}\trefs/heads/main\n` },
          "gh pr list --head fabrik/setup-v1.4.2 --state merged": merged,
          "gh pr list --head fabrik/setup-v1.4.2 --state open": { stdout: "[]" },
          "gh api graphql": noForcePush,
          [`gh api repos/acme/clinic/compare/${HEAD_SHA}...${movedHead}`]: { stdout: "ahead\n" },
        }),
      ).toBe("fabrik/setup-v1.4.2's setup PR is merged. Switch to main with git switch main && git pull, then run setup again.");
    });

    it("stop, saying to go back to the default branch, when its setup PR is merged and only skills the hook installed are untracked", async () => {
      const merged = { stdout: JSON.stringify([{ number: 1, headRefOid: HEAD_SHA, isCrossRepository: false }]) };

      expect(
        await problem({
          ...onSetupBranch,
          [STATUS]: { stdout: "?? .claude/skills/tdd/SKILL.md\0" },
          [lsRemote("v1.4.2")]: { stdout: `${OTHER_SHA}\trefs/heads/main\n` },
          "gh pr list --head fabrik/setup-v1.4.2 --state merged": merged,
          "gh pr list --head fabrik/setup-v1.4.2 --state open": { stdout: "[]" },
          "gh api graphql": { stdout: JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes: [] } } } } }) },
        }),
      ).toBe("fabrik/setup-v1.4.2's setup PR is merged. Switch to main with git switch main && git pull, then run setup again.");
    });

    it("stop when origin's copy of it has commits this clone lacks", async () => {
      const remote = { stdout: `${HEAD_SHA}\trefs/heads/main\n${OTHER_SHA}\trefs/heads/fabrik/setup-v1.4.2\n` };

      expect(await problem({ ...onSetupBranch, [lsRemote("v1.4.2")]: remote })).toBe(
        "origin's fabrik/setup-v1.4.2 has commits this clone lacks (9f86d08). Pull them with git pull --no-rebase origin fabrik/setup-v1.4.2, then run setup again.",
      );
    });

    it("stop on another release's setup branch", async () => {
      expect(await problem({ "git branch --show-current": { stdout: "fabrik/setup-v1.3.0\n" } })).toBe(
        "This clone is on fabrik/setup-v1.3.0, not main. Switch to main with git switch main, then run setup again.",
      );
    });
  });

  it("take the root by its real path, as git gives it", async () => {
    const outcome = await check({ "git rev-parse --show-toplevel": { stdout: `${await realpath(productDir)}\n` } }).result;

    expect(outcome.ok).toBe(true);
  });
});
