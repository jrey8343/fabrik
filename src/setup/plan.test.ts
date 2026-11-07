// Setup's planner: given what a Product repo holds now and the
// Fabrik release being set up, it returns every step that would leave the repo
// ready to run the Loop. A working install plans nothing, so re-running the
// skill only repairs what's missing.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { checkCallerWorkflow } from "../kit/caller.ts";
import { DEFAULT_KIT_CONFIG, resolveKitConfig } from "../kit/config.ts";
import { aCleanProduct, afterApplying } from "../__fixtures__/productState.ts";
import { loadSetupKit, type SetupKit } from "./kit.ts";
import { type ProductState, type SetupAction, planSetup, setupPaths } from "./plan.ts";

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

  it("groups every Fabrik pin into one Dependabot PR, so a release never lands half-bumped", () => {
    const { actions } = planSetup(aCleanProduct(), kit);

    const dependabot = written(actions, ".github/dependabot.yml") ?? "";
    expect(dependabot).toMatch(/groups:\n\s+fabrik:\n\s+patterns:\n\s+- "jrey8343\/fabrik\*"/);
  });
});

describe("A Dependabot shim from before Fabrik pins were grouped", () => {
  // The shim v0.1.0 and v0.1.1 wrote: it opened one PR per pinned workflow.
  const ungrouped = [
    "# Fabrik's Dependabot shim in a Product repo (ADR-0003). It opens a PR each time",
    "# Fabrik cuts a release, bumping the one pin in .github/workflows/fabrik.yml,",
    "# and the Operator merges it through the Merge gate like any other change.",
    "version: 2",
    "updates:",
    "  - package-ecosystem: github-actions",
    '    directory: "/"',
    "    schedule:",
    "      interval: daily",
    "    # Only the Kit pin; this entry leaves the Product's other actions alone.",
    "    allow:",
    '      - dependency-name: "jrey8343/fabrik*"',
    "    # A release reaches the Product repo the day it's cut.",
    "    cooldown:",
    "      default-days: 0",
    "    commit-message:",
    '      prefix: "fabrik"',
    "",
  ].join("\n");

  it("is replaced with the grouped shim when setup wrote it unchanged", () => {
    const { actions } = planSetup(aCleanProduct({ files: { ".github/dependabot.yml": ungrouped } }), kit);

    expect(written(actions, ".github/dependabot.yml")).toBe(kit.templates.dependabot);
  });

  it("asks the Operator to add the group when the Product has edited it", () => {
    const edited = `${ungrouped}  - package-ecosystem: npm\n    directory: "/"\n    schedule:\n      interval: weekly\n`;

    const plan = planSetup(aCleanProduct({ files: { ".github/dependabot.yml": edited } }), kit);

    expect(written(plan.actions, ".github/dependabot.yml")).toBeUndefined();
    expect(plan.notes.join("\n")).toContain("groups:");
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

describe("Keeping Prettier off the Kit-owned caller workflow", () => {
  it("creates a .prettierignore that ignores the caller workflow when the Product has a .prettierrc", () => {
    const { actions } = planSetup(aCleanProduct({ files: { ".prettierrc": "{ \"singleQuote\": true }\n" } }), kit);

    expect(written(actions, ".prettierignore")?.split("\n")).toContain(".github/workflows/fabrik.yml");
  });

  it("does the same when the Product configures Prettier in package.json", () => {
    const packageJson = JSON.stringify({ name: "clinic", prettier: { singleQuote: true } });
    const { actions } = planSetup(aCleanProduct({ files: { "package.json": packageJson } }), kit);

    expect(written(actions, ".prettierignore")?.split("\n")).toContain(".github/workflows/fabrik.yml");
  });

  it("adds the caller line to an existing .prettierignore, keeping its lines", () => {
    const files = { ".prettierrc": "{}\n", ".prettierignore": "dist\nnode_modules" };
    const { actions } = planSetup(aCleanProduct({ files }), kit);

    const lines = written(actions, ".prettierignore")?.split("\n") ?? [];
    expect(lines.slice(0, 3)).toEqual(["dist", "node_modules", ""]);
    expect(lines).toContain(".github/workflows/fabrik.yml");
  });

  it("leaves a .prettierignore that already lists the caller workflow alone", () => {
    const files = { ".prettierrc": "{}\n", ".prettierignore": "dist\n  .github/workflows/fabrik.yml  \n" };
    const { actions } = planSetup(aCleanProduct({ files }), kit);

    expect(written(actions, ".prettierignore")).toBeUndefined();
  });

  it("doesn't count a wider glob as ignoring the caller workflow", () => {
    const files = { ".prettierrc": "{}\n", ".prettierignore": ".github/\n" };
    const { actions } = planSetup(aCleanProduct({ files }), kit);

    expect(written(actions, ".prettierignore")?.split("\n")).toContain(".github/workflows/fabrik.yml");
  });

  it.each([
    ["it created", { ".prettierrc": "{}\n" }],
    ["it merged into", { ".prettierrc": "{}\n", ".prettierignore": "dist\n" }],
  ])("plans nothing for a .prettierignore %s on a re-run", (_, files) => {
    const state = aCleanProduct({ files });
    const rerun = planSetup(afterApplying(state, planSetup(state, kit)), kit);

    expect(written(rerun.actions, ".prettierignore")).toBeUndefined();
  });

  it("leaves .prettierignore alone when the Product has no Prettier config", () => {
    const { actions } = planSetup(aCleanProduct({ files: { ".prettierignore": "dist\n", "package.json": "{}" } }), kit);

    expect(written(actions, ".prettierignore")).toBeUndefined();
  });

  it("counts a package.json that isn't valid JSON as having no Prettier config", () => {
    const { actions } = planSetup(aCleanProduct({ files: { "package.json": '{ "prettier": ' } }), kit);

    expect(written(actions, ".prettierignore")).toBeUndefined();
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
    expect(plan.notes).toContain(
      ".github/workflows/fabrik.yml pins Fabrik v2.0.0, a later major release than v1.4.2: run Setup at v2.0.0 instead, " +
        "with curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/main/setup.sh | bash -s -- v2.0.0. The caller workflow was left as it is.",
    );
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
    "agent:design",
    "agent:review",
    "bug",
    "enhancement",
    "fabrik:token-rotation",
    "fabrik:weekly-limit",
    "fabrik:usage-credits",
    "fabrik:audit",
    "fabrik:retro",
    "fabrik:replay",
    "fabrik:monitor",
    "wayfinder:map",
    "wayfinder:research",
    "wayfinder:prototype",
    "wayfinder:grilling",
    "wayfinder:task",
    "agent:research",
    "agent:replay",
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

  it("are each named in the README's list of the labels setup creates", () => {
    const readme = readFileSync(resolve(KIT_DIR, "README.md"), "utf8");
    const line = readme.split("\n").find((l) => l.startsWith("- **Labels**:")) ?? "";
    const named = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

    expect(named.sort()).toEqual(createdLabels(aCleanProduct()).sort());
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

  describe("a Kit config with Extra skills", () => {
    const config = JSON.stringify({ sandbox: { checks: ["build"] }, roles: { design: { skills: ["jrey8343/skills/event-storming"] } } });
    const pin = (repository: string) => JSON.stringify([{ repository, sha: "a".repeat(40) }]);

    it("checks the config with its skills lock, so a config whose picks are pinned still has its gating checks required", () => {
      const state = aCleanProduct({ files: { ".fabrik/config.json": config, ".fabrik/skills.lock.json": pin("jrey8343/skills") } });

      expect(protects(state)).toEqual([{ kind: "protect-branch", branch: "main", requiredChecks: ["build"] }]);
      expect(planSetup(state, kit).notes.join("\n")).not.toContain("is invalid");
    });

    it.each([
      ["there's no skills lock", {}],
      ["the skills lock doesn't pin the pick's Skills source", { ".fabrik/skills.lock.json": pin("someone/else") }],
    ])("still calls the config invalid when %s", (_, lock) => {
      const plan = planSetup(aCleanProduct({ files: { ".fabrik/config.json": config, ...lock } }), kit);

      expect(plan.notes.join("\n")).toContain(".fabrik/config.json is invalid, so its gating checks weren't required");
    });
  });
});

describe("What setup reads from the Product repo", () => {
  it("reads the skills lock, so setup checks the Kit config with it", () => {
    expect(setupPaths(kit)).toContain(".fabrik/skills.lock.json");
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
        audit: { model: "claude-opus-5-5", effort: null, timeout_minutes: 45 },
        retro: { model: "claude-opus-5-5", effort: null, timeout_minutes: 45 },
        research: { model: "claude-opus-5-5", effort: null, timeout_minutes: 30 },
        dispatch: { timeout_minutes: 10 },
        step_up: { model: "claude-opus-5-5", effort: null },
      },
      max_in_flight: 2,
      caps: { design_sessions: 2, monitor_issues: 5, maps: 1 },
      monitor: { errors: null, red_main: true },
      audit: { day: "sunday" },
      retro: { day: "saturday" },
      operator: null,
      subscriptions: ["Claude token"],
      ui: null,
      preview: { url: null },
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

describe("The fabrik-runs store, the opt-in step for Run records and the Weekly summary", () => {
  const operator = { timeZone: "Australia/Sydney" };

  it("creates a missing store as a private repo", () => {
    const { actions } = planSetup(aCleanProduct(), kit, operator);

    expect(actions).toContainEqual({ kind: "create-run-store", repo: "jrey8343/fabrik-runs", private: true });
  });

  it("writes the store's caller workflow: the Weekly summary each Monday morning in the Operator's time zone, and on demand", () => {
    const { actions } = planSetup(aCleanProduct(), kit, operator);

    const caller = storeWritten(actions, ".github/workflows/weekly-summary.yml") ?? "";
    expect(caller).toMatch(/schedule:\n\s+- cron: "0 7 \* \* 1"\n\s+timezone: "Australia\/Sydney"/);
    expect(caller).toMatch(/^\s+workflow_dispatch:/m);
    expect(caller).toContain("uses: jrey8343/fabrik/.github/workflows/weekly-summary.yml@v1.4.2");
    expect(checkCallerWorkflow(caller)).toEqual({ ok: true, release: "v1.4.2" });
  });

  it("writes the store's Dependabot entry, so Dependabot bumps its Fabrik pin", () => {
    const { actions } = planSetup(aCleanProduct(), kit, operator);

    expect(storeWritten(actions, ".github/dependabot.yml")).toBe(kit.templates.dependabot);
  });

  it("creates a read-only service account for the Fabrik App vault, stored as an Actions secret on the store (ADR-0004)", () => {
    const { actions } = planSetup(aCleanProduct(), kit, operator);

    expect(actions).toContainEqual({
      kind: "create-service-account",
      name: "fabrik-jrey8343-fabrik-runs-push",
      vaults: ["Fabrik App"],
      secret: "FABRIK_OP_PUSH_TOKEN",
      repo: "jrey8343/fabrik-runs",
    });
  });

  it("passes that secret to the Weekly summary from the store's caller workflow", () => {
    const { actions } = planSetup(aCleanProduct(), kit, operator);

    expect(storeWritten(actions, ".github/workflows/weekly-summary.yml")).toContain("${{ secrets.FABRIK_OP_PUSH_TOKEN }}");
  });

  function storeActions(state: ProductState): string[] {
    return planSetup(state, kit, operator).actions.flatMap((a) =>
      a.kind === "create-run-store" || a.kind === "write-store-file" || ("repo" in a && a.repo === "jrey8343/fabrik-runs")
        ? [a.kind]
        : [],
    );
  }

  it("plans nothing for a store that's already set up", () => {
    const clean = aCleanProduct();
    const setUp = afterApplying(clean, planSetup(clean, kit, operator));

    expect(setUp.store.exists).toBe(true);
    expect(storeActions(setUp)).toEqual([]);
    expect(planSetup(setUp, kit, operator).actions).toEqual([]);
  });

  it("keeps planning nothing for the store however many times setup runs again", () => {
    let state = aCleanProduct();
    for (let run = 0; run < 3; run++) state = afterApplying(state, planSetup(state, kit, operator));

    expect(planSetup(state, kit, operator)).toEqual({ actions: [], notes: expect.any(Array) as unknown });
    expect(storeActions(state)).toEqual([]);
  });

  it("never makes a public store private: it tells the Operator, and changes nothing there", () => {
    const store = { exists: true, private: false, files: {}, secrets: [] };

    const plan = planSetup(aCleanProduct({ store }), kit, operator);

    expect(storeActions(aCleanProduct({ store }))).toEqual([]);
    expect(plan.notes.join("\n")).toMatch(/jrey8343\/fabrik-runs is public/);
  });

  it("repairs only what a private store lacks", () => {
    const clean = aCleanProduct();
    const setUp = afterApplying(clean, planSetup(clean, kit, operator));
    const lostSecret = { ...setUp, store: { ...setUp.store, secrets: [] } };

    expect(storeActions(lostSecret)).toEqual(["create-service-account"]);
  });

  it("moves the Weekly summary's schedule when the Operator gives a new time zone, and touches nothing else", () => {
    const clean = aCleanProduct();
    const setUp = afterApplying(clean, planSetup(clean, kit, operator));

    const actions = planSetup(setUp, kit, { timeZone: "Europe/London" }).actions;

    expect(actions.map((a) => a.kind)).toEqual(["write-store-file"]);
    expect(storeWritten(actions, ".github/workflows/weekly-summary.yml")).toContain('timezone: "Europe/London"');
  });

  it("leaves the store alone until the Operator gives setup their time zone, so it stays opt-in", () => {
    expect(storeActions(aCleanProduct()).length).toBeGreaterThan(0);

    const { actions } = planSetup(aCleanProduct(), kit);

    expect(actions.filter((a) => a.kind === "create-run-store" || a.kind === "write-store-file" || ("repo" in a && a.repo !== undefined))).toEqual([]);
  });

  it("tells the Operator when their time zone isn't one GitHub's schedule knows, and changes nothing for the store", () => {
    const plan = planSetup(aCleanProduct(), kit, { timeZone: "Mars/Olympus_Mons" });

    expect(plan.actions.filter((a) => a.kind === "create-run-store" || a.kind === "write-store-file")).toEqual([]);
    expect(plan.notes.join("\n")).toContain("Mars/Olympus_Mons");
  });
});

describe("A second Subscription, the opt-in step for Subscription rotation", () => {
  const operator = { secondSubscription: true };
  const oneListed = '{ "subscriptions": ["Claude token"] }\n';
  const twoListed = '{ "subscriptions": ["Claude token", "Claude token 2"] }\n';

  function withConfig(config: string, fabrikItems: readonly string[]): ProductState {
    return aCleanProduct({ files: { ".fabrik/config.json": config }, vaults: ["Fabrik"], fabrikItems });
  }

  it("walks the Operator through the second account, its token and usage credits, then setup's command again, which walks the stage, when the vault has no item yet", () => {
    const { actions, notes } = planSetup(withConfig(oneListed, ["Claude token"]), kit, operator);

    expect(written(actions, ".fabrik/config.json")).toBeUndefined();
    const step = notes.find((note) => note.includes("A second Subscription")) ?? "";
    expect(step).toContain("create a second Claude account");
    expect(step).toContain("`claude setup-token`");
    expect(step).toContain('the "Claude token 2" API Credential, with its expiry date, in the "Fabrik" vault');
    expect(step).toContain("usage credits off on every account");
    expect(step).toMatch(
      /Running setup again walks it, then lists it in subscriptions in \.fabrik\/config\.json: curl -fsSL https:\/\/raw\.githubusercontent\.com\/jrey8343\/fabrik\/main\/setup\.sh \| bash -s -- v1\.4\.2$/,
    );
  });

  it("says setup lists it in the setup PR when the plan's own run walks the wizard next", () => {
    const { actions, notes } = planSetup(withConfig(oneListed, ["Claude token"]), kit, operator, { wizardNext: true });

    expect(written(actions, ".fabrik/config.json")).toBeUndefined();
    const step = notes.find((note) => note.includes("A second Subscription")) ?? "";
    expect(step).toContain("create a second Claude account");
    expect(step).toMatch(/Setup then lists it in subscriptions in \.fabrik\/config\.json, in the setup PR\.$/);
    expect(step).not.toContain("run setup again");
  });

  it("is planned for a repo that leaves subscriptions to its one-item default", () => {
    const { notes } = planSetup(withConfig('{ "max_in_flight": 1 }\n', ["Claude token"]), kit, operator);

    expect(notes.join("\n")).toContain("A second Subscription");
  });

  it("lists the second Subscription in the Kit config itself, after the first, once its vault item exists", () => {
    const { actions, notes } = planSetup(withConfig(kit.templates.kitConfig, ["Claude token", "Claude token 2"]), kit, operator);

    expect(written(actions, ".fabrik/config.json")).toBe(
      kit.templates.kitConfig.replace('  "subscriptions": ["Claude token"],\n', '  "subscriptions": ["Claude token", "Claude token 2"],\n'),
    );
    expect(notes.join("\n")).not.toMatch(/Claude token 2|A second Subscription/);
  });

  it("keeps every other byte of the Kit config it lists it in, its tabs and CRLF line endings included", () => {
    const stored = ["Claude token", "Claude token 2"];
    const own = '{\r\n\t"operator": "jrey8343",\r\n\t"subscriptions": [ "Claude token" ],\r\n\t"max_in_flight": 1\r\n}\r\n';
    const unlisted = '{\n  "max_in_flight": 1\n}\n';

    expect(written(planSetup(withConfig(own, stored), kit, operator).actions, ".fabrik/config.json")).toBe(
      '{\r\n\t"operator": "jrey8343",\r\n\t"subscriptions": ["Claude token", "Claude token 2"],\r\n\t"max_in_flight": 1\r\n}\r\n',
    );
    expect(written(planSetup(withConfig(unlisted, stored), kit, operator).actions, ".fabrik/config.json")).toBe(
      '{\n  "max_in_flight": 1,\n  "subscriptions": ["Claude token", "Claude token 2"]\n}\n',
    );
  });

  it("lists it in the starter on a repo with no Kit config, in the plan's one write of it, paused or not", () => {
    const fresh = aCleanProduct({ vaults: ["Fabrik"], fabrikItems: ["Claude token", "Claude token 2"] });
    const listedIn = (starter: string) =>
      starter.replace('  "subscriptions": ["Claude token"],\n', '  "subscriptions": ["Claude token", "Claude token 2"],\n');

    for (const [answers, starter] of [
      [operator, kit.templates.kitConfig],
      [{ ...operator, paused: true }, kit.templates.kitConfig.replace('"max_in_flight": 2', '"max_in_flight": 0')],
    ] as const) {
      const writes = planSetup(fresh, kit, answers).actions.filter((a) => a.kind === "write-file" && a.path === ".fabrik/config.json");
      expect(writes).toEqual([expect.objectContaining({ content: listedIn(starter), why: expect.stringContaining("the second Subscription listed") })]);
    }
  });

  it("writes nothing to a Kit config it can't read a list from, and says so", () => {
    for (const config of ["{ not json\n", '[ "Claude token" ]\n', '{ "subscriptions": "Claude token" }\n', '{ "subscriptions": [] }\n']) {
      const { actions, notes } = planSetup(withConfig(config, ["Claude token", "Claude token 2"]), kit, operator);

      expect(written(actions, ".fabrik/config.json")).toBeUndefined();
      expect(notes).toContainEqual(
        '.fabrik/config.json isn\'t a JSON object whose subscriptions is a list of names, so setup didn\'t list "Claude token 2" in it: fix it, then run setup again.',
      );
    }
  });

  it("leaves a list of two or more Subscriptions as the Operator wrote it", () => {
    const state = withConfig('{ "subscriptions": ["Claude token", "Claude token B"] }\n', ["Claude token", "Claude token B", "Claude token 2"]);

    expect(planSetup(state, kit, operator)).toEqual(planSetup(state, kit));
  });

  it("is planned away once the second vault item exists and is listed", () => {
    const state = withConfig(twoListed, ["Claude token", "Claude token 2"]);

    expect(planSetup(state, kit, operator)).toEqual(planSetup(state, kit));
    expect(planSetup(state, kit, operator).notes.join("\n")).not.toMatch(/Claude token 2|A second Subscription/);
  });

  it("names a listed Subscription the Fabrik vault lacks, so no run asks 1Password for a missing item, and how to walk the wizard for it", () => {
    const lacks = '.fabrik/config.json lists "Claude token 2" in subscriptions, but the "Fabrik" vault has no item of that name';

    expect(planSetup(withConfig(twoListed, ["Claude token"]), kit).notes).toContainEqual(
      `${lacks}: run setup again to walk the wizard's "A second Subscription" stage for it: curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/main/setup.sh | bash -s -- v1.4.2`,
    );
    expect(planSetup(withConfig(twoListed, ["Claude token"]), kit, {}, { wizardNext: true }).notes).toContainEqual(
      `${lacks}: walk the wizard's "A second Subscription" stage for it.`,
    );
  });

  it("names the Claude token stage for a listed Claude token the Fabrik vault lacks", () => {
    const lacks = '.fabrik/config.json lists "Claude token" in subscriptions, but the "Fabrik" vault has no item of that name';

    expect(planSetup(withConfig(twoListed, ["Claude token 2"]), kit).notes).toContainEqual(
      `${lacks}: run setup again to walk the wizard's "The Claude token" stage for it: curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/main/setup.sh | bash -s -- v1.4.2`,
    );
  });

  it("says to store by hand a listed Subscription the Fabrik vault lacks under a name no wizard stage stores, such as a third", () => {
    const threeListed = '{ "subscriptions": ["Claude token", "Claude token 2", "Claude token 3"] }\n';
    const byHand =
      '.fabrik/config.json lists "Claude token 3" in subscriptions, but the "Fabrik" vault has no item of that name: run `claude setup-token` on that Subscription\'s Claude account and save the token as the "Claude token 3" API Credential, with its expiry date, in the "Fabrik" vault yourself, since the wizard stores only "Claude token" and "Claude token 2".';

    for (const context of [{}, { wizardNext: true }]) {
      const { notes } = planSetup(withConfig(threeListed, ["Claude token", "Claude token 2"]), kit, {}, context);
      expect(notes.filter((note) => note.includes("subscriptions"))).toEqual([byHand]);
    }
  });

  it("creates no service account: the agent and implement accounts already read the Fabrik vault", () => {
    const state = withConfig(oneListed, ["Claude token"]);

    expect(planSetup(state, kit, operator).actions).toEqual(planSetup(state, kit).actions);
  });

  it("leaves Subscriptions alone until the Operator opts in", () => {
    const { notes } = planSetup(withConfig(oneListed, ["Claude token"]), kit);

    expect(notes.join("\n")).not.toContain("Subscription");
  });
});

// Visual evidence is /fabrik-visual-evidence's to write, through its own writer (visualEvidence.ts).
describe("Visual evidence, which setup leaves to /fabrik-visual-evidence", () => {
  it("writes the starter Kit config with Visual evidence off, as the starter has it", () => {
    const config = written(planSetup(aCleanProduct(), kit).actions, ".fabrik/config.json") ?? null;

    expect(config).toBe(kit.templates.kitConfig);
    const resolved = resolveKitConfig({ config });
    expect(resolved.ok && [resolved.config.ui, resolved.config.preview]).toEqual([null, null]);
  });

  it("never writes a Kit config the repo already has, whether or not it has a ui block", () => {
    const off = '{\n  "operator": "jrey8343"\n}\n';
    const on = JSON.stringify({ ui: { paths: ["src/**"], serve: "npm run preview", url: "http://localhost:4321" } });

    for (const config of [off, on]) {
      const { actions, notes } = planSetup(aCleanProduct({ files: { ".fabrik/config.json": config } }), kit);
      expect(written(actions, ".fabrik/config.json")).toBeUndefined();
      expect(notes.join("\n")).not.toContain("Visual evidence");
    }
  });
});

function storeWritten(actions: readonly SetupAction[], path: string): string | undefined {
  const action = actions.find((a) => a.kind === "write-store-file" && a.path === path);
  return action?.kind === "write-store-file" ? action.content : undefined;
}

describe("Installing with Dispatch paused", () => {
  const paused = { paused: true };
  const pausedText = (config: string) => config.replace('"max_in_flight": 2,', '"max_in_flight": 0,');

  it("writes the starter Kit config with max_in_flight 0 and every other byte the same", () => {
    const { actions } = planSetup(aCleanProduct(), kit, paused);

    expect(written(actions, ".fabrik/config.json")).toBe(pausedText(kit.templates.kitConfig));
  });

  it("says in the plan that the starter is paused", () => {
    const { actions } = planSetup(aCleanProduct(), kit, paused);

    const action = actions.find((a) => a.kind === "write-file" && a.path === ".fabrik/config.json");
    expect(action?.kind === "write-file" ? action.why : "").toContain("Dispatch paused");
  });

  it("leaves an existing Kit config alone, telling the Operator its max_in_flight and how to pause it by hand", () => {
    const state = aCleanProduct({ files: { ".fabrik/config.json": '{ "max_in_flight": 3 }\n' } });

    const plan = planSetup(state, kit, paused);

    expect(written(plan.actions, ".fabrik/config.json")).toBeUndefined();
    expect(plan.notes).toContainEqual(
      "--paused had no effect: .fabrik/config.json already exists, with max_in_flight 3. Set it to 0 by hand to pause Dispatch.",
    );
  });

  it("counts a Kit config without max_in_flight as having the default", () => {
    const plan = planSetup(aCleanProduct({ files: { ".fabrik/config.json": "{}\n" } }), kit, paused);

    expect(plan.notes.find((n) => n.startsWith("--paused"))).toContain("max_in_flight 2");
  });

  it("plans nothing new for the Kit config when setup runs again with --paused", () => {
    const setUp = afterApplying(aCleanProduct(), planSetup(aCleanProduct(), kit, paused));

    const again = planSetup(setUp, kit, paused);

    expect(again.actions).toEqual([]);
    expect(again.notes.find((n) => n.startsWith("--paused"))).toContain("already paused");
  });

  it("warns that open ready-for-agent issues start as soon as the setup PR merges, unless setup is paused", () => {
    const plan = planSetup(aCleanProduct({ readyForAgent: 4 }), kit);

    expect(plan.notes).toContainEqual(
      "4 open issues are labelled ready-for-agent: Dispatch starts releasing them to Implementers as soon as the setup PR merges. Run setup with --paused to hold them back.",
    );
  });

  it("says nothing about ready-for-agent issues when there are none, when paused, or when the Kit config exists", () => {
    const readyForAgentNotes = (plan: { notes: readonly string[] }) => plan.notes.filter((n) => n.includes("ready-for-agent"));

    expect(readyForAgentNotes(planSetup(aCleanProduct(), kit))).toEqual([]);
    expect(readyForAgentNotes(planSetup(aCleanProduct({ readyForAgent: 4 }), kit, paused))).toEqual([]);
    expect(readyForAgentNotes(planSetup(aCleanProduct({ readyForAgent: 4, files: { ".fabrik/config.json": "{}\n" } }), kit))).toEqual([]);
  });

  it("names a single issue in the singular", () => {
    expect(planSetup(aCleanProduct({ readyForAgent: 1 }), kit).notes).toContainEqual(
      "1 open issue is labelled ready-for-agent: Dispatch starts releasing it to an Implementer as soon as the setup PR merges. Run setup with --paused to hold it back.",
    );
  });

  describe("with a Kit config only on the setup branch, the starter setup wrote there", () => {
    const wroteStarter = { wroteStarter: true };
    const withStarter = (starter: string) => aCleanProduct({ readyForAgent: 4, files: { ".fabrik/config.json": starter } });
    const pausedNote = (plan: { notes: readonly string[] }) => plan.notes.filter((n) => n.startsWith("--paused"));
    const readyForAgentNotes = (plan: { notes: readonly string[] }) => plan.notes.filter((n) => n.includes("ready-for-agent"));

    it("with --paused and a paused starter, says nothing about --paused", () => {
      const plan = planSetup(withStarter(pausedText(kit.templates.kitConfig)), kit, paused, wroteStarter);

      expect(pausedNote(plan)).toEqual([]);
      expect(readyForAgentNotes(plan)).toEqual([]);
    });

    it("unpaused, warns that the ready-for-agent issues start as soon as the setup PR merges", () => {
      const plan = planSetup(withStarter(kit.templates.kitConfig), kit, {}, wroteStarter);

      expect(readyForAgentNotes(plan)).toEqual([
        "4 open issues are labelled ready-for-agent: Dispatch starts releasing them to Implementers as soon as the setup PR merges. Run setup with --paused to hold them back.",
      ]);
    });

    it("with --paused and a starter an earlier run wrote unpaused, pauses Dispatch in it, every other byte kept", () => {
      const plan = planSetup(withStarter(kit.templates.kitConfig), kit, paused, wroteStarter);

      expect(plan.actions.filter((a) => a.kind === "write-file" && a.path === ".fabrik/config.json")).toEqual([
        expect.objectContaining({ content: pausedText(kit.templates.kitConfig), why: "the starter Kit config, with Dispatch paused now (max_in_flight 0)" }),
      ]);
      expect(pausedNote(plan)).toEqual([]);
      expect(readyForAgentNotes(plan)).toEqual([]);
    });

    it("unpaused, with a starter an earlier run wrote paused, gives it the v1 default max_in_flight and warns about the ready-for-agent issues", () => {
      const plan = planSetup(withStarter(pausedText(kit.templates.kitConfig)), kit, {}, wroteStarter);

      expect(plan.actions.filter((a) => a.kind === "write-file" && a.path === ".fabrik/config.json")).toEqual([
        expect.objectContaining({ content: kit.templates.kitConfig, why: "the starter Kit config, with Dispatch not paused now (max_in_flight 2)" }),
      ]);
      expect(readyForAgentNotes(plan)).toEqual([
        "4 open issues are labelled ready-for-agent: Dispatch starts releasing them to Implementers as soon as the setup PR merges. Run setup with --paused to hold them back.",
      ]);
    });

    it("pauses Dispatch and lists the second Subscription in one write", () => {
      const state = aCleanProduct({ files: { ".fabrik/config.json": kit.templates.kitConfig }, vaults: ["Fabrik"], fabrikItems: ["Claude token", "Claude token 2"] });

      const writes = planSetup(state, kit, { paused: true, secondSubscription: true }, wroteStarter).actions.filter(
        (a) => a.kind === "write-file" && a.path === ".fabrik/config.json",
      );

      expect(writes).toEqual([
        expect.objectContaining({
          content: pausedText(kit.templates.kitConfig).replace('"subscriptions": ["Claude token"]', '"subscriptions": ["Claude token", "Claude token 2"]'),
          why: "the starter Kit config, with Dispatch paused now (max_in_flight 0), and the second Subscription listed",
        }),
      ]);
    });

    it("plans nothing more for it once the starter pauses Dispatch as this run asks", () => {
      const once = planSetup(withStarter(kit.templates.kitConfig), kit, paused, wroteStarter);
      const again = planSetup(afterApplying(withStarter(kit.templates.kitConfig), once), kit, paused, wroteStarter);

      expect(written(again.actions, ".fabrik/config.json")).toBeUndefined();
      expect(pausedNote(again)).toEqual([]);
    });

    it("leaves a starter that isn't a JSON object alone, as a Kit config of the Product's own", () => {
      const plan = planSetup(withStarter("{ not json\n"), kit, paused, wroteStarter);

      expect(written(plan.actions, ".fabrik/config.json")).toBeUndefined();
      expect(pausedNote(plan)).toEqual(["--paused had no effect: .fabrik/config.json already exists. Set max_in_flight to 0 in it by hand to pause Dispatch."]);
    });
  });
});
