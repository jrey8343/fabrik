// The setup skill's planner: given what a Product repo holds now and the
// Fabrik release being set up, it returns every step that would leave the repo
// ready to run the Loop. A working install plans nothing, so re-running the
// skill only repairs what's missing.
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { checkCallerWorkflow } from "../kit/caller.ts";
import { DEFAULT_KIT_CONFIG, resolveKitConfig } from "../kit/config.ts";
import { aCleanProduct, afterApplying } from "../__fixtures__/productState.ts";
import { loadSetupKit, type SetupKit } from "./kit.ts";
import { type ProductState, type SetupAction, planSetup } from "./plan.ts";

const KIT_DIR = resolve(import.meta.dirname, "..", "..");
let kit: SetupKit;

beforeAll(async () => {
  kit = await loadSetupKit(KIT_DIR, "v1.4.2");
});

function written(actions: readonly SetupAction[], path: string): string | undefined {
  const action = actions.find((a) => a.kind === "write-file" && a.path === path);
  return action?.kind === "write-file" ? action.content : undefined;
}

describe("Setting up a clean Product repo", () => {
  it("writes the caller workflow with every uses: line pinned to the release being set up", () => {
    const { actions } = planSetup(aCleanProduct(), kit);

    const caller = written(actions, ".github/workflows/fabrik.yml");
    expect(caller).toBeDefined();
    expect(checkCallerWorkflow(caller ?? "")).toEqual({ ok: true, release: "v1.4.2" });
  });

  it("adds the SessionStart hook entry and switches the skills plugin off in .claude/settings.json", () => {
    const { actions } = planSetup(aCleanProduct(), kit);

    const settings = JSON.parse(written(actions, ".claude/settings.json") ?? "{}") as Record<string, unknown>;
    expect(settings["enabledPlugins"]).toEqual({ "mattpocock-skills@claude-plugins-official": false });
    expect(JSON.stringify(settings["hooks"])).toContain("codeload.github.com/jrey8343/fabrik");
  });

  it("gitignores the skills the Kit installs", () => {
    const { actions } = planSetup(aCleanProduct(), kit);

    expect(written(actions, ".gitignore")?.split("\n")).toContain(".claude/skills/");
  });

  it("writes the Dependabot config that bumps only the Fabrik pin, with no cooldown", () => {
    const { actions } = planSetup(aCleanProduct(), kit);

    const dependabot = written(actions, ".github/dependabot.yml") ?? "";
    expect(dependabot).toContain("package-ecosystem: github-actions");
    expect(dependabot).toContain('dependency-name: "jrey8343/fabrik*"');
    expect(dependabot).toContain("default-days: 0");
  });
});

describe("Re-running setup", () => {
  function installed(state = aCleanProduct()): ProductState {
    return afterApplying(state, planSetup(state, kit));
  }

  it("changes nothing on a working install", () => {
    expect(planSetup(installed(), kit).actions).toEqual([]);
  });

  it("repairs a missing label and a missing secret, and nothing else", () => {
    const working = installed();
    const broken = {
      ...working,
      labels: working.labels.filter((l) => l !== "needs-design"),
      secrets: working.secrets.filter((s) => s !== "FABRIK_OP_PUSH_TOKEN"),
    };

    const actions = planSetup(broken, kit).actions.map((a) => `${a.kind} ${"name" in a ? a.name : ""}`);

    expect(actions).toEqual(["create-label needs-design", "create-service-account fabrik-acme-clinic-push"]);
  });

  it("restores a stable shim the repo lost, and rewrites only Kit-owned files", () => {
    const working = installed();
    const edited: ProductState = {
      ...working,
      files: Object.fromEntries(
        Object.keys(working.files).map((path) => [path, path.endsWith(".json") ? "{}\n" : "# edited by hand\n"]),
      ),
    };

    const paths = planSetup(edited, kit).actions.flatMap((a) => (a.kind === "write-file" ? [a.path] : []));

    expect(paths.sort()).toEqual([".claude/settings.json", ".github/dependabot.yml", ".github/workflows/fabrik.yml", ".gitignore"].sort());
  });
});

describe("Merging a shim into a file the Product repo already has", () => {
  it("adds the skills line to an existing .gitignore, keeping its lines", () => {
    const { actions } = planSetup(aCleanProduct({ files: { ".gitignore": "node_modules/\n.env" } }), kit);

    const lines = written(actions, ".gitignore")?.split("\n") ?? [];
    expect(lines.slice(0, 2)).toEqual(["node_modules/", ".env"]);
    expect(lines).toContain(".claude/skills/");
  });

  it("leaves a .gitignore that already ignores the skills alone", () => {
    const { actions } = planSetup(aCleanProduct({ files: { ".gitignore": "dist\n.claude/skills\n" } }), kit);

    expect(written(actions, ".gitignore")).toBeUndefined();
  });

  it("adds the hook entry to existing settings, keeping the Product's own hooks and settings", () => {
    const ours = { hooks: [{ type: "command", command: "echo hi" }] };
    const existing = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { SessionStart: [ours], Stop: [ours] },
      enabledPlugins: { "other@market": true },
    };

    const { actions } = planSetup(aCleanProduct({ files: { ".claude/settings.json": JSON.stringify(existing) } }), kit);

    const settings = JSON.parse(written(actions, ".claude/settings.json") ?? "{}") as typeof existing;
    expect(settings.permissions).toEqual(existing.permissions);
    expect(settings.hooks.Stop).toEqual([ours]);
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart[0]).toEqual(ours);
    expect(settings.enabledPlugins).toEqual({ "other@market": true, "mattpocock-skills@claude-plugins-official": false });
  });

  it("replaces an out-of-date Fabrik hook entry instead of adding a second", () => {
    const stale = { hooks: [{ type: "command", command: "curl https://codeload.github.com/jrey8343/fabrik/old", timeout: 5 }] };
    const files = { ".claude/settings.json": JSON.stringify({ hooks: { SessionStart: [stale] } }) };

    const { actions } = planSetup(aCleanProduct({ files }), kit);

    const settings = JSON.parse(written(actions, ".claude/settings.json") ?? "{}") as { hooks: { SessionStart: unknown[] } };
    expect(settings.hooks.SessionStart).toEqual(
      (JSON.parse(kit.templates.claudeSettings) as { hooks: { SessionStart: unknown[] } }).hooks.SessionStart,
    );
  });

  it("asks the Operator to fix settings that aren't JSON, rather than overwrite them", () => {
    const plan = planSetup(aCleanProduct({ files: { ".claude/settings.json": "{ oops" } }), kit);

    expect(written(plan.actions, ".claude/settings.json")).toBeUndefined();
    expect(plan.notes.join("\n")).toContain(".claude/settings.json");
  });

  it("adds the Fabrik entry to an existing Dependabot config's updates", () => {
    const existing = 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: "/"\n    schedule:\n      interval: weekly\n';

    const { actions } = planSetup(aCleanProduct({ files: { ".github/dependabot.yml": existing } }), kit);

    const merged = written(actions, ".github/dependabot.yml") ?? "";
    expect(merged.startsWith(existing)).toBe(true);
    expect(merged).toContain("  - package-ecosystem: github-actions\n");
    expect(merged).toContain('dependency-name: "jrey8343/fabrik*"');
  });

  it("asks the Operator to merge by hand when the Dependabot config already updates GitHub Actions", () => {
    const existing = 'version: 2\nupdates:\n  - package-ecosystem: "github-actions"\n    directory: "/"\n    schedule:\n      interval: weekly\n';

    const plan = planSetup(aCleanProduct({ files: { ".github/dependabot.yml": existing } }), kit);

    expect(written(plan.actions, ".github/dependabot.yml")).toBeUndefined();
    expect(plan.notes.join("\n")).toContain("jrey8343/fabrik*");
  });
});

describe("The caller workflow on a repo that has one", () => {
  const caller = (release: string) => planSetup(aCleanProduct(), { ...kit, release }).actions;
  const pinnedAt = (release: string) => written(caller(release), ".github/workflows/fabrik.yml") ?? "";

  it("leaves a caller Dependabot has bumped to a later release in the same major alone", () => {
    const state = aCleanProduct({ files: { ".github/workflows/fabrik.yml": pinnedAt("v1.6.0") } });

    expect(written(planSetup(state, kit).actions, ".github/workflows/fabrik.yml")).toBeUndefined();
  });

  it("repairs a hand-edited caller at the release it already pins, never moving the pin", () => {
    const edited = pinnedAt("v1.3.0").replace("cron:", "# cron:");

    const { actions } = planSetup(aCleanProduct({ files: { ".github/workflows/fabrik.yml": edited } }), kit);

    expect(written(actions, ".github/workflows/fabrik.yml")).toBe(pinnedAt("v1.3.0"));
  });

  it("migrates a caller pinned to an earlier major release to the release being set up", () => {
    const state = aCleanProduct({ files: { ".github/workflows/fabrik.yml": pinnedAt("v0.9.1") } });

    expect(written(planSetup(state, kit).actions, ".github/workflows/fabrik.yml")).toBe(pinnedAt("v1.4.2"));
  });

  it("rewrites a caller whose uses: lines disagree at the release being set up", () => {
    const halfUpdated = pinnedAt("v1.3.0").replace("schedule.yml@v1.3.0", "schedule.yml@v1.4.0");

    const state = aCleanProduct({ files: { ".github/workflows/fabrik.yml": halfUpdated } });

    expect(written(planSetup(state, kit).actions, ".github/workflows/fabrik.yml")).toBe(pinnedAt("v1.4.2"));
  });

  it("refuses to move a caller back from a later major release, telling the Operator to set up from it", () => {
    const state = aCleanProduct({ files: { ".github/workflows/fabrik.yml": pinnedAt("v2.0.0") } });

    const plan = planSetup(state, kit);

    expect(written(plan.actions, ".github/workflows/fabrik.yml")).toBeUndefined();
    expect(plan.notes.join("\n")).toContain("v2.0.0");
  });

  it("treats each 0.x minor as its own major, as semver does", () => {
    const state = aCleanProduct({ files: { ".github/workflows/fabrik.yml": pinnedAt("v0.1.0") } });

    const actions = planSetup(state, { ...kit, release: "v0.2.0" }).actions;

    expect(written(actions, ".github/workflows/fabrik.yml")).toBe(pinnedAt("v0.2.0"));
  });
});

describe("Labels", () => {
  const LOOP_LABELS = [
    "needs-triage",
    "needs-info",
    "ready-for-agent",
    "ready-for-human",
    "wontfix",
    "needs-design",
    "agent:implement",
    "agent:review",
    "bug",
    "enhancement",
    "fabrik:token-rotation",
    "fabrik:weekly-limit",
  ];

  function createdLabels(state: ProductState): string[] {
    return planSetup(state, kit).actions.flatMap((a) => (a.kind === "create-label" ? [a.name] : []));
  }

  it("creates every label the Loop uses on a clean repo", () => {
    expect(createdLabels(aCleanProduct()).sort()).toEqual([...LOOP_LABELS].sort());
  });

  it("creates only the labels the repo lacks, matching names as GitHub does, ignoring case", () => {
    const labels = LOOP_LABELS.filter((l) => l !== "agent:review").map((l) => (l === "bug" ? "Bug" : l));

    expect(createdLabels(aCleanProduct({ labels }))).toEqual(["agent:review"]);
  });
});

describe("Service accounts and Actions secrets (ADR-0004)", () => {
  function accounts(state: ProductState) {
    return planSetup(state, kit).actions.flatMap((a) => (a.kind === "create-service-account" ? [a] : []));
  }

  it("creates three read-only service accounts, each reading only its role's vaults, stored as its Actions secret", () => {
    expect(accounts(aCleanProduct())).toEqual([
      {
        kind: "create-service-account",
        name: "fabrik-acme-clinic-agent",
        vaults: ["Fabrik"],
        secret: "FABRIK_OP_AGENT_TOKEN",
      },
      {
        kind: "create-service-account",
        name: "fabrik-acme-clinic-implement",
        vaults: ["Fabrik", "Fabrik Sandbox · clinic"],
        secret: "FABRIK_OP_IMPLEMENT_TOKEN",
      },
      {
        kind: "create-service-account",
        name: "fabrik-acme-clinic-push",
        vaults: ["Fabrik App"],
        secret: "FABRIK_OP_PUSH_TOKEN",
      },
    ]);
  });

  it("names exactly the secrets the caller workflow passes to the Kit", () => {
    const { actions } = planSetup(aCleanProduct(), kit);
    const caller = written(actions, ".github/workflows/fabrik.yml") ?? "";
    const passed = [...caller.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);

    expect(new Set(accounts(aCleanProduct()).map((a) => a.secret))).toEqual(new Set(passed));
  });

  it("creates the vaults the accounts read, before the accounts, only when 1Password lacks them", () => {
    const { actions } = planSetup(aCleanProduct({ vaults: ["Fabrik", "Private"] }), kit);
    const vaults = actions.flatMap((a) => (a.kind === "create-vault" ? [a.name] : []));

    expect(vaults).toEqual(["Fabrik App", "Fabrik Sandbox · clinic"]);
    const lastVault = actions.findLastIndex((a) => a.kind === "create-vault");
    const firstAccount = actions.findIndex((a) => a.kind === "create-service-account");
    expect(lastVault).toBeLessThan(firstAccount);
  });

  it("replaces only the service account whose Actions secret is missing", () => {
    const state = aCleanProduct({ secrets: ["FABRIK_OP_AGENT_TOKEN", "FABRIK_OP_PUSH_TOKEN", "STRIPE_KEY"] });

    expect(accounts(state).map((a) => a.secret)).toEqual(["FABRIK_OP_IMPLEMENT_TOKEN"]);
  });
});

describe("Branch protection", () => {
  function protects(state: ProductState) {
    return planSetup(state, kit).actions.flatMap((a) => (a.kind === "protect-branch" ? [a] : []));
  }
  const withChecks = (checks: string[]) => ({
    ".fabrik/config.json": JSON.stringify({ sandbox: { checks } }),
  });

  it("requires a PR and the Kit config's gating checks on the default branch, with no bypass and no approving review", () => {
    const state = aCleanProduct({ files: withChecks(["build", "test"]) });

    expect(protects(state)).toEqual([{ kind: "protect-branch", branch: "main", requiredChecks: ["build", "test"] }]);
  });

  it("keeps the checks the branch already requires", () => {
    const state = aCleanProduct({
      files: withChecks(["build"]),
      protection: { requiredChecks: ["lint"], requiresPullRequest: true, bypassAllowances: [] },
    });

    expect(protects(state)[0]?.requiredChecks).toEqual(["lint", "build"]);
  });

  it("takes away a bypass that would let the Fabrik App merge without the Operator", () => {
    const state = aCleanProduct({
      files: withChecks(["build"]),
      protection: { requiredChecks: ["build"], requiresPullRequest: true, bypassAllowances: ["app:fabrik"] },
    });

    expect(protects(state)).toHaveLength(1);
  });

  it("tells the Operator when there's no gating check to require yet", () => {
    const plan = planSetup(aCleanProduct(), kit);

    expect(plan.notes.join("\n")).toContain("sandbox.checks");
  });

  it("leaves protection alone when it already requires all of that", () => {
    const state = aCleanProduct({
      files: withChecks(["build"]),
      protection: { requiredChecks: ["build", "lint"], requiresPullRequest: true, bypassAllowances: [] },
    });

    expect(protects(state)).toEqual([]);
  });
});

describe("The Merge gate ruleset: only the Operator updates the default branch", () => {
  function gates(state: ProductState) {
    return planSetup(state, kit).actions.flatMap((a) => (a.kind === "restrict-default-branch" ? [a] : []));
  }
  const sound = { id: 12, enforcement: "active", branches: ["~DEFAULT_BRANCH"], restrictsUpdates: true, bypassActors: ["RepositoryRole:5"] };

  it("creates a ruleset that lets only repo admins (the Operator) update the default branch, so the Fabrik App can't merge", () => {
    expect(gates(aCleanProduct())).toEqual([{ kind: "restrict-default-branch", rulesetId: null }]);
  });

  it.each([
    ["isn't enforced", { ...sound, enforcement: "evaluate" }],
    ["doesn't restrict updates", { ...sound, restrictsUpdates: false }],
    ["lets the Fabrik App bypass it", { ...sound, bypassActors: ["RepositoryRole:5", "Integration:99"] }],
    ["doesn't cover the default branch", { ...sound, branches: ["refs/heads/release"] }],
  ])("repairs the ruleset in place when it %s", (_, mergeGate) => {
    expect(gates(aCleanProduct({ mergeGate }))).toEqual([{ kind: "restrict-default-branch", rulesetId: 12 }]);
  });

  it("leaves a sound ruleset alone", () => {
    expect(gates(aCleanProduct({ mergeGate: sound }))).toEqual([]);
  });
});

describe("The starters the Product repo then owns", () => {
  it("writes a starter Kit config that spells out every v1 default", () => {
    const { actions } = planSetup(aCleanProduct(), kit);

    const config = JSON.parse(written(actions, ".fabrik/config.json") ?? "{}") as unknown;
    expect(config).toEqual({
      sandbox: { setup: null, build: null, test: null, checks: [], env: {}, secrets: {} },
      roles: {
        triage: { model: "claude-opus-5-5", effort: null, timeout_minutes: 10 },
        design: { model: "claude-opus-5-5", effort: null, timeout_minutes: 30 },
        implement: { model: "claude-sonnet-5-5", effort: null, timeout_minutes: 60 },
        review: { model: "claude-opus-5-5", effort: null, timeout_minutes: 30 },
        dispatch: { timeout_minutes: 10 },
        step_up: { model: "claude-opus-5-5", effort: null },
      },
      max_in_flight: 2,
      operator: null,
    });
    expect(resolveKitConfig({ config: written(actions, ".fabrik/config.json") ?? null })).toEqual({
      ok: true,
      config: DEFAULT_KIT_CONFIG,
    });
  });

  it("writes docs/agents/* with Fabrik's fixed answers: GitHub, the triage labels and a single context", () => {
    const { actions } = planSetup(aCleanProduct(), kit);

    expect(written(actions, "docs/agents/issue-tracker.md")).toContain("# Issue tracker: GitHub");
    expect(written(actions, "docs/agents/triage-labels.md")).toContain("`needs-design`");
    expect(written(actions, "docs/agents/domain.md")).toContain("Single-context repo");
  });

  it("points the skills at docs/agents/* from a new AGENTS.md when the repo has neither AGENTS.md nor CLAUDE.md", () => {
    const { actions } = planSetup(aCleanProduct(), kit);

    expect(written(actions, "AGENTS.md")).toContain("## Agent skills");
    expect(written(actions, "CLAUDE.md")).toBeUndefined();
  });

  it("adds the Agent skills block to an existing CLAUDE.md, keeping what's there", () => {
    const { actions } = planSetup(aCleanProduct({ files: { "CLAUDE.md": "# Clinic\n\nBe kind.\n" } }), kit);

    expect(written(actions, "CLAUDE.md")).toMatch(/^# Clinic\n\nBe kind.\n\n## Agent skills\n/);
    expect(written(actions, "AGENTS.md")).toBeUndefined();
  });

  it("never rewrites a starter the Product repo already has, even when it differs", () => {
    const state = aCleanProduct({
      files: {
        ".fabrik/config.json": '{ "max_in_flight": 1 }\n',
        "docs/agents/issue-tracker.md": "# Issue tracker: Linear\n",
        "docs/agents/triage-labels.md": "# Ours\n",
        "docs/agents/domain.md": "# Ours\n",
        "AGENTS.md": "# Clinic\n\n## Agent skills\n\nOur own.\n",
      },
    });

    const paths = planSetup(state, kit).actions.flatMap((a) => (a.kind === "write-file" ? [a.path] : []));

    expect(paths).not.toContain(".fabrik/config.json");
    expect(paths.filter((p) => p.startsWith("docs/agents/"))).toEqual([]);
    expect(paths).not.toContain("AGENTS.md");
  });
});
