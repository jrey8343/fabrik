// Setup's planner: given what a Product repo holds now and the
// Fabrik release being set up, it returns every step that would leave the repo
// ready to run the Loop. A working install plans nothing, so re-running the
// skill only repairs what's missing.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { checkCallerWorkflow } from "../kit/caller.ts";
import { DEFAULT_KIT_CONFIG, resolveKitConfig } from "../kit/config.ts";
import { aCleanProduct, afterApplying, aProtectedBranch } from "../__fixtures__/productState.ts";
import { TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL } from "../loop/labels.ts";
import { describeAction } from "./apply.ts";
import { prBody } from "./finish.ts";
import { loadSetupKit, type SetupKit } from "./kit.ts";
import {
  deleteRepoSecrets,
  type EnvironmentPolicy,
  type EnvironmentState,
  environmentHeld,
  holdEnvironment,
  kitNamesEnvironment,
  oldAccountsNotes,
  type ProductState,
  type RunStoreState,
  type SetupAction,
  planSetup,
  setupPaths,
} from "./plan.ts";
import { pinCaller, scheduleIn } from "./shims.ts";

const KIT_DIR = resolve(import.meta.dirname, "..", "..");
/** The Kit's three Actions secrets, by name, in the order Setup makes their accounts. */
const TOKENS = ["FABRIK_OP_AGENT_TOKEN", "FABRIK_OP_IMPLEMENT_TOKEN", "FABRIK_OP_PUSH_TOKEN"];
let kit: SetupKit;

beforeAll(async () => {
  kit = await loadSetupKit(KIT_DIR, "v1.4.2");
});

/** The hook entry's command as releases before the shallow fetch shipped it, downloading Fabrik's archive from codeload. */
const OLD_HOOK_COMMAND =
  "f=\"$CLAUDE_PROJECT_DIR/.github/workflows/fabrik.yml\"; v=$(sed -n -E \"s|^[[:space:]-]*uses:[[:space:]\\\"']*jrey8343/fabrik/[^@]*@([A-Za-z0-9._+-]+).*|\\1|p\" \"$f\" 2>/dev/null | head -n 1); if [ -z \"$v\" ]; then echo \"{\\\"systemMessage\\\":\\\"Fabrik didn't install its skills: .github/workflows/fabrik.yml pins no Fabrik release\\\"}\"; exit 0; fi; d=$(mktemp -d); if curl -fsSL \"https://codeload.github.com/jrey8343/fabrik/tar.gz/refs/tags/$v\" 2>/dev/null | tar -xzf - -C \"$d\" --strip-components=1 2>/dev/null && [ -f \"$d/src/session/start.ts\" ]; then node \"$d/src/session/start.ts\" \"$CLAUDE_PROJECT_DIR\" \"$v\"; else echo \"{\\\"systemMessage\\\":\\\"Fabrik didn't install its skills: downloading Fabrik $v failed\\\"}\"; fi; rm -rf \"$d\"";

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

  // #927: a review's own run starts the caller workflow on the default branch, which reads the tokens there.
  it("writes a caller workflow that a review's hand-off can start, and that still passes the three tokens by name", () => {
    const caller = written(planSetup(aCleanProduct(), kit).actions, ".github/workflows/fabrik.yml") ?? "";

    expect(caller).toMatch(/^ {2}workflow_dispatch:\n {4}inputs:\n {6}pull_request:\n(?: {8}.*\n)+ {6}review:\n/m);
    expect(caller).toContain(
      "    secrets:\n" +
        "      OP_AGENT_TOKEN: ${{ secrets.FABRIK_OP_AGENT_TOKEN }}\n" +
        "      OP_IMPLEMENT_TOKEN: ${{ secrets.FABRIK_OP_IMPLEMENT_TOKEN }}\n" +
        "      OP_PUSH_TOKEN: ${{ secrets.FABRIK_OP_PUSH_TOKEN }}\n",
    );
  });

  it("adds the SessionStart hook entry and switches the skills plugin off in .claude/settings.json", () => {
    const { actions } = planSetup(aCleanProduct(), kit);

    const settings = JSON.parse(written(actions, ".claude/settings.json") ?? "{}") as Record<string, unknown>;
    expect(settings["enabledPlugins"]).toEqual({ "mattpocock-skills@claude-plugins-official": false });
    expect(JSON.stringify(settings["hooks"])).toContain("https://github.com/jrey8343/fabrik");
    expect(JSON.stringify(settings["hooks"])).not.toContain("codeload.github.com");
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

  it("repairs a missing label and a secret the fabrik environment lacks, and nothing else", () => {
    const working = installed();
    const broken = {
      ...working,
      labels: working.labels.filter((l) => l !== "needs-design"),
      environment: { ...working.environment!, secrets: working.environment!.secrets.filter((s) => s !== "FABRIK_OP_PUSH_TOKEN") },
    };

    const actions = planSetup(broken, kit).actions.map((a) => `${a.kind} ${"name" in a ? a.name : ""}`);

    expect(actions).toEqual(["create-label needs-design", "create-service-account fabrik-acme-clinic-push-env"]);
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

  it("replaces the entry that downloaded Fabrik from codeload with the one that fetches it from github.com, keeping the repo's other hooks", () => {
    const theirs = { hooks: [{ type: "command", command: "echo hi" }] };
    const old = { hooks: [{ type: "command", command: OLD_HOOK_COMMAND, timeout: 120 }] };
    const files = { ".claude/settings.json": JSON.stringify({ hooks: { SessionStart: [theirs, old], Stop: [theirs] } }) };

    const { actions } = planSetup(aCleanProduct({ files }), kit);

    const settings = JSON.parse(written(actions, ".claude/settings.json") ?? "{}") as {
      hooks: { SessionStart: { hooks: { command: string }[] }[]; Stop: unknown[] };
    };
    expect(settings.hooks.Stop).toEqual([theirs]);
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart[0]).toEqual(theirs);
    expect(settings.hooks.SessionStart[1]?.hooks[0]?.command).toContain(
      'git -C "$d" fetch -q --depth 1 https://github.com/jrey8343/fabrik "refs/tags/$v"',
    );
    expect(JSON.stringify(settings.hooks)).not.toContain("codeload.github.com");
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

  it("skips a Dependabot config it can't parse, and says so, rather than write one Dependabot rejects", () => {
    const existing = 'version: 2\nupdates:\n    - package-ecosystem: npm\n      directory: "/"\n  - package-ecosystem: pip\n';

    const plan = planSetup(aCleanProduct({ files: { ".github/dependabot.yml": existing } }), kit);

    expect(written(plan.actions, ".github/dependabot.yml")).toBeUndefined();
    expect(plan.notes.join("\n")).toContain(".github/dependabot.yml doesn't parse");
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
        "with curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/v2.0.0/setup.sh | bash -s -- v2.0.0. The caller workflow was left as it is.",
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
    "agent:digest",
    "agent:rerun-checks",
    "bug",
    "enhancement",
    "fabrik:token-rotation",
    "fabrik:weekly-limit",
    "fabrik:usage-credits",
    "fabrik:audit",
    "fabrik:retro",
    "fabrik:replay",
    "fabrik:dead-tick",
    "fabrik:monitor",
    "fabrik:flaky-check",
    "fabrik:step-up",
    "fabrik:kept-branch",
    "fabrik:trial-accepted",
    "fabrik:trial-problem",
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

  // A trigger label still on can then be read as a run that never started (#436).
  it("describes each trigger label as coming off, in no more than the 100 characters GitHub takes", () => {
    const created = planSetup(aCleanProduct(), kit).actions.flatMap((a) => (a.kind === "create-label" ? [a] : []));
    const triggers = created.filter((label) => label.name.startsWith("agent:"));

    expect(triggers.map((label) => label.name).sort()).toEqual(["agent:design", "agent:digest", "agent:implement", "agent:replay", "agent:rerun-checks", "agent:research", "agent:review"]);
    for (const label of triggers) expect(label.description).toMatch(/\boff\b/);
    for (const label of created) expect(label.description.length).toBeLessThanOrEqual(100);
  });

  it("creates only the labels the repo lacks, matching names as GitHub does, ignoring case", () => {
    const labels = LOOP_LABELS.filter((l) => l !== "agent:review").map((l) => (l === "bug" ? "Bug" : l));

    expect(createdLabels(aCleanProduct({ labels }))).toEqual(["agent:review"]);
  });

  it("creates fabrik:step-up, saying what it does, on a re-run of an install from before it", () => {
    const working = afterApplying(aCleanProduct(), planSetup(aCleanProduct(), kit));
    const before = { ...working, labels: working.labels.filter((l) => l !== "fabrik:step-up") };

    expect(planSetup(before, kit).actions).toEqual([
      expect.objectContaining({ kind: "create-label", name: "fabrik:step-up", description: expect.stringMatching(/Implement runs .*Step-up/) }),
    ]);
  });

  it("creates agent:rerun-checks with the Kit's colour and description on a re-run of an install from before it (#783)", () => {
    const working = afterApplying(aCleanProduct(), planSetup(aCleanProduct(), kit));
    const before = { ...working, labels: working.labels.filter((l) => l !== "agent:rerun-checks") };

    expect(planSetup(before, kit).actions).toEqual([
      expect.objectContaining({ kind: "create-label", name: "agent:rerun-checks", color: "c2e0c6", description: expect.stringMatching(/Unrelated failure .*Merge gate .*off as the run starts/) }),
    ]);
  });

  it("creates fabrik:kept-branch, saying what it does, on a re-run of an install from before it (#536)", () => {
    const working = afterApplying(aCleanProduct(), planSetup(aCleanProduct(), kit));
    const before = { ...working, labels: working.labels.filter((l) => l !== "fabrik:kept-branch") };

    expect(planSetup(before, kit).actions).toEqual([
      expect.objectContaining({ kind: "create-label", name: "fabrik:kept-branch", description: expect.stringMatching(/carries on its Kept branch/) }),
    ]);
  });

  it("creates the two trial labels, each saying it marks a merged pull request, on a re-run of an install from before them (#814)", () => {
    const working = afterApplying(aCleanProduct(), planSetup(aCleanProduct(), kit));
    const before = { ...working, labels: working.labels.filter((l) => !l.startsWith("fabrik:trial-")) };

    expect(planSetup(before, kit).actions).toEqual([
      expect.objectContaining({ kind: "create-label", name: TRIAL_ACCEPTED_LABEL, description: expect.stringMatching(/merged PR.* accepted/) }),
      expect.objectContaining({ kind: "create-label", name: TRIAL_PROBLEM_LABEL, description: expect.stringMatching(/merged PR.* problem/) }),
    ]);
    expect([TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL]).toEqual(["fabrik:trial-accepted", "fabrik:trial-problem"]);
  });

  it("are each named in the README's list of the labels setup creates", () => {
    const readme = readFileSync(resolve(KIT_DIR, "README.md"), "utf8");
    const line = readme.split("\n").find((l) => l.startsWith("- **Labels**:")) ?? "";
    const named = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

    expect(named.sort()).toEqual(createdLabels(aCleanProduct()).sort());
  });
});

describe("The fabrik environment, held to the default branch (ADR-0004)", () => {
  it("on a repo with no fabrik environment, plans making it first, ahead of every other step, held to the default branch alone", () => {
    const { actions } = planSetup(aCleanProduct({ environment: null }), kit);

    expect(actions[0]).toEqual({ kind: "hold-environment", environment: "fabrik", branch: "main", found: null });
    expect(actions.filter((action) => action.kind === "hold-environment")).toHaveLength(1);
    expect(describeAction(actions[0]!)).toBe("create the fabrik environment, held to main alone: only a run of main is given its secrets");
  });

  it("is said in the README's list of what Setup does, straight after the 1Password bullet", () => {
    const BULLET =
      '- **The `fabrik` environment** (ADR-0004): made when the repo lacks it, and held to the default branch by one branch rule naming it ("Selected branches and tags"), which Setup adds and reads back before it stores a token there. On every run Setup checks that the one rule is there and names the default branch, and puts right what it finds, saying from what to what. GitHub makes an environment a workflow names when the repo lacks it, with no rule, and one with no rule gives its secrets to every branch, so Setup never takes the environment\'s being there for its being held. On a private repo whose GitHub plan has no environments, Setup stops and says so: there is no fallback to repo-level secrets.';
    const lines = readFileSync(resolve(KIT_DIR, "README.md"), "utf8").split("\n");

    // A later Ticket adds a sentence to its end, so only its start is held here.
    const bullet = lines.find((line) => line.startsWith("- **The `fabrik` environment**"));
    expect(bullet?.slice(0, BULLET.length)).toBe(BULLET);
    expect(lines[lines.indexOf(bullet ?? "") - 1]).toMatch(/^- \*\*1Password\*\* \(ADR-0004\): /);
  });

  const rule = (name: string, type: "branch" | "tag" = "branch", id = 1) => ({ id, name, type });

  describe("is held only when its one rule is a branch rule naming the default branch", () => {
    it("is held with selected branches and tags and that one rule", () => {
      expect(environmentHeld({ branches: "selected", rules: [rule("main")] }, "main")).toBe(true);
    });

    it.each<[string, EnvironmentPolicy | null]>([
      ["a repo with no such environment", null],
      ["every branch, as GitHub makes one a workflow names", { branches: "all", rules: [] }],
      ["protected branches only", { branches: "protected", rules: [] }],
      ["selected branches and tags with no rule, which lets every ref through", { branches: "selected", rules: [] }],
      ["a rule naming another branch", { branches: "selected", rules: [rule("release")] }],
      ["a tag rule named as the default branch is, which lets a tag's run in", { branches: "selected", rules: [rule("main", "tag")] }],
      ["the right rule beside another", { branches: "selected", rules: [rule("main"), rule("release/*", "branch", 2)] }],
      ["the right rule beside a tag rule of its name", { branches: "selected", rules: [rule("main"), rule("main", "tag", 2)] }],
    ])("isn't held with %s", (_, policy) => {
      expect(environmentHeld(policy, "main")).toBe(false);
    });

    it("isn't held by a rule naming what the default branch was called before it was renamed", () => {
      expect(environmentHeld({ branches: "selected", rules: [rule("master")] }, "main")).toBe(false);
    });
  });

  function holds(environment: EnvironmentState | null, defaultBranch = "main") {
    const clean = aCleanProduct();
    const { actions } = planSetup({ ...clean, repo: { ...clean.repo, defaultBranch }, environment }, kit);
    return actions.filter((action) => action.kind === "hold-environment");
  }

  it("plans nothing for one already held, whatever secrets it holds", () => {
    expect(holds({ branches: "selected", rules: [rule("main")], secrets: ["FABRIK_OP_PUSH_TOKEN", "STRIPE_KEY"] })).toEqual([]);
  });

  it.each<[string, EnvironmentPolicy, string]>([
    ["every branch", { branches: "all", rules: [] }, "every branch"],
    ["protected branches only", { branches: "protected", rules: [] }, "protected branches only"],
    ["selected branches and tags with no rule", { branches: "selected", rules: [] }, "none"],
    ["a rule naming another branch", { branches: "selected", rules: [rule("release")] }, "release"],
    ["a tag rule named main", { branches: "selected", rules: [rule("main", "tag")] }, "tag main"],
    ["the right rule beside others", { branches: "selected", rules: [rule("main"), rule("release/*", "branch", 2), rule("v*", "tag", 3)] }, "main, release/*, tag v*"],
  ])("plans holding one found with %s, as the plan's first step, naming the change from what to what", (_, policy, before) => {
    const clean = aCleanProduct();
    const { actions } = planSetup({ ...clean, environment: { ...policy, secrets: ["STRIPE_KEY"] } }, kit);

    expect(actions[0]).toEqual({ kind: "hold-environment", environment: "fabrik", branch: "main", found: policy });
    expect(holds({ ...policy, secrets: [] })).toHaveLength(1);
    expect(describeAction(actions[0]!)).toBe(`hold the fabrik environment to main alone: rules ${before} → main`);
  });

  it("plans holding one whose rule names what the default branch was called before it was renamed, to the new name", () => {
    const found: EnvironmentPolicy = { branches: "selected", rules: [rule("master")] };

    const planned = holds({ ...found, secrets: [] }, "trunk");

    expect(planned).toEqual([{ kind: "hold-environment", environment: "fabrik", branch: "trunk", found }]);
    expect(describeAction(planned[0]!)).toBe("hold the fabrik environment to trunk alone: rules master → trunk");
  });

  it("plans the same step for another repo's environment, naming the repo, and none once that one is held", () => {
    const found: EnvironmentPolicy = { branches: "all", rules: [] };

    expect(holdEnvironment("fabrik", found, "trunk", "jrey8343/fabrik-runs")).toEqual([
      { kind: "hold-environment", environment: "fabrik", branch: "trunk", found, repo: "jrey8343/fabrik-runs" },
    ]);
    expect(holdEnvironment("fabrik", { branches: "selected", rules: [rule("trunk")] }, "trunk", "jrey8343/fabrik-runs")).toEqual([]);
  });

  it("is held once its step is applied, so the next run plans nothing for it", () => {
    const state = aCleanProduct({ environment: { branches: "all", rules: [], secrets: ["STRIPE_KEY"] } });

    const after = afterApplying(state, planSetup(state, kit));

    // Its own secret stays, beside the three tokens the plan's later steps store in it.
    expect(after.environment).toEqual({
      branches: "selected",
      rules: [expect.objectContaining({ name: "main", type: "branch" })],
      secrets: ["STRIPE_KEY", ...TOKENS],
    });
    expect(planSetup(after, kit).actions).toEqual([]);
  });
});

describe("Service accounts, their tokens the secrets of the fabrik environment (ADR-0004)", () => {
  function accounts(state: ProductState) {
    return planSetup(state, kit).actions.flatMap((a) => (a.kind === "create-service-account" ? [a] : []));
  }

  it("on a fresh repo, creates three read-only service accounts named -env, each reading only its role's vaults, stored in the fabrik environment", () => {
    expect(accounts(aCleanProduct())).toEqual([
      {
        kind: "create-service-account",
        name: "fabrik-acme-clinic-agent-env",
        vaults: ["Fabrik"],
        secret: "FABRIK_OP_AGENT_TOKEN",
        environment: "fabrik",
      },
      {
        kind: "create-service-account",
        name: "fabrik-acme-clinic-implement-env",
        vaults: ["Fabrik", "Fabrik Sandbox · clinic"],
        secret: "FABRIK_OP_IMPLEMENT_TOKEN",
        environment: "fabrik",
      },
      {
        kind: "create-service-account",
        name: "fabrik-acme-clinic-push-env",
        vaults: ["Fabrik App"],
        secret: "FABRIK_OP_PUSH_TOKEN",
        environment: "fabrik",
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

  /** A fabrik environment held to main, with these secrets. */
  const held = (secrets: readonly string[]): EnvironmentState => ({ branches: "selected", rules: [{ id: 1, name: "main", type: "branch" }], secrets });

  it("on a repo whose three tokens sit at repo level only, as one already on the Kit, creates three new accounts in the environment", () => {
    const onTheKit = aCleanProduct({ secrets: [...TOKENS, "STRIPE_KEY"], environment: null });

    expect(accounts(onTheKit).map((a) => [a.name, a.secret, a.environment])).toEqual([
      ["fabrik-acme-clinic-agent-env", "FABRIK_OP_AGENT_TOKEN", "fabrik"],
      ["fabrik-acme-clinic-implement-env", "FABRIK_OP_IMPLEMENT_TOKEN", "fabrik"],
      ["fabrik-acme-clinic-push-env", "FABRIK_OP_PUSH_TOKEN", "fabrik"],
    ]);
    expect(accounts({ ...onTheKit, environment: held([]) })).toHaveLength(3);
  });

  it.each<[string, readonly string[]]>([
    ["none of them", []],
    ["all three", TOKENS],
    ["one of them, beside a secret of the repo's own", ["FABRIK_OP_IMPLEMENT_TOKEN", "STRIPE_KEY"]],
  ])("creates no account on a repo whose environment holds all three, with %s at repo level", (_, repoLevel) => {
    expect(accounts(aCleanProduct({ secrets: repoLevel, environment: held([...TOKENS, "STRIPE_KEY"]) }))).toEqual([]);
  });

  it("creates only the account of the role whose token the environment lacks, though a repo-level secret carries its name", () => {
    const state = aCleanProduct({ secrets: TOKENS, environment: held(["FABRIK_OP_AGENT_TOKEN", "FABRIK_OP_PUSH_TOKEN", "STRIPE_KEY"]) });

    expect(accounts(state).map((a) => a.name)).toEqual(["fabrik-acme-clinic-implement-env"]);
  });

  it("plans every account after the step that holds the environment, so no token is stored before its rule is in and read back", () => {
    const { actions } = planSetup(aCleanProduct({ secrets: TOKENS }), kit);

    expect(actions[0]?.kind).toBe("hold-environment");
    expect(actions.findIndex((a) => a.kind === "create-service-account")).toBeGreaterThan(0);
  });

  it("is said in the README's list of what Setup does, in the 1Password bullet", () => {
    const BULLET =
      "- **1Password** (ADR-0004): the `Fabrik`, `Fabrik App` and `Fabrik Sandbox · <repo>` vaults when they're missing, and three read-only service accounts with no expiry, `fabrik-<owner>-<repo>-agent-env` (reads `Fabrik`), `-implement-env` (reads `Fabrik` and the Sandbox vault) and `-push-env` (reads `Fabrik App`), stored as the secrets `FABRIK_OP_AGENT_TOKEN`, `FABRIK_OP_IMPLEMENT_TOKEN` and `FABRIK_OP_PUSH_TOKEN` of the `fabrik` environment, straight from 1Password and never as repo-level Actions secrets. A token the environment lacks is missing, even when a repo-level secret carries its name.";

    expect(readFileSync(resolve(KIT_DIR, "README.md"), "utf8").split("\n")).toContain(BULLET);
  });

  it("names each step with its account, the vaults it reads, its secret and the fabrik environment", () => {
    expect(accounts(aCleanProduct()).map(describeAction)).toEqual([
      'create the read-only service account "fabrik-acme-clinic-agent-env" (reads "Fabrik") and store it as FABRIK_OP_AGENT_TOKEN in the fabrik environment',
      'create the read-only service account "fabrik-acme-clinic-implement-env" (reads "Fabrik", "Fabrik Sandbox · clinic") and store it as FABRIK_OP_IMPLEMENT_TOKEN in the fabrik environment',
      'create the read-only service account "fabrik-acme-clinic-push-env" (reads "Fabrik App") and store it as FABRIK_OP_PUSH_TOKEN in the fabrik environment',
    ]);
  });
});

describe("The repo-level tokens, deleted once the default branch's Kit names the fabrik environment (ADR-0004)", () => {
  /** A fabrik environment held to main, with these secrets. */
  const held = (secrets: readonly string[]): EnvironmentState => ({ branches: "selected", rules: [{ id: 1, name: "main", type: "branch" }], secrets });
  /** The caller workflow as Setup writes it at a release. */
  const callerAt = (release: string) => pinCaller(kit.templates.caller, release);
  const deletions = (actions: readonly SetupAction[]) => actions.flatMap((a) => (a.kind === "delete-repo-secret" ? [a] : []));
  const accounts = (actions: readonly SetupAction[]) => actions.flatMap((a) => (a.kind === "create-service-account" ? [a] : []));
  const COMMAND = "curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/v1.4.2/setup.sh | bash -s -- v1.4.2";
  const STAY = `The repo-level Actions secrets FABRIK_OP_AGENT_TOKEN, FABRIK_OP_IMPLEMENT_TOKEN and FABRIK_OP_PUSH_TOKEN stay for now, since the Kit main pins names no environment and reads them. Once the setup PR is merged, run setup again and it deletes them: ${COMMAND}`;
  const OLD_ACCOUNTS =
    "Once the repo-level secrets are deleted, delete the old service accounts fabrik-acme-clinic-agent, fabrik-acme-clinic-implement and fabrik-acme-clinic-push on 1Password's site. Their tokens still work until you do, though they sit nowhere on GitHub.";

  it("on a repo on an earlier major with its three tokens at repo level, plans the environment and three new accounts, deletes nothing, and says the repo-level secrets stay until the setup PR is merged", () => {
    const earlier = callerAt("v0.9.1");
    const onTheKit = aCleanProduct({ files: { ".github/workflows/fabrik.yml": earlier }, defaultBranchCaller: earlier, secrets: [...TOKENS, "STRIPE_KEY"] });

    const { actions, notes } = planSetup(onTheKit, kit);

    expect(actions[0]?.kind).toBe("hold-environment");
    expect(accounts(actions).map((a) => a.name)).toEqual(["fabrik-acme-clinic-agent-env", "fabrik-acme-clinic-implement-env", "fabrik-acme-clinic-push-env"]);
    expect(deletions(actions)).toEqual([]);
    expect(notes).toContain(STAY);
    expect(notes).not.toContain(OLD_ACCOUNTS);
  });

  it("once the setup PR is merged, plans deleting each of the three at repo level, names the three old accounts, and plans no new account", () => {
    const moved = aCleanProduct({ secrets: [...TOKENS, "STRIPE_KEY"], environment: held(TOKENS), defaultBranchCaller: callerAt("v1.4.2") });

    const { actions, notes } = planSetup(moved, kit);

    expect(deletions(actions)).toEqual([
      { kind: "delete-repo-secret", secret: "FABRIK_OP_AGENT_TOKEN", account: "fabrik-acme-clinic-agent", environment: "fabrik", branch: "main" },
      { kind: "delete-repo-secret", secret: "FABRIK_OP_IMPLEMENT_TOKEN", account: "fabrik-acme-clinic-implement", environment: "fabrik", branch: "main" },
      { kind: "delete-repo-secret", secret: "FABRIK_OP_PUSH_TOKEN", account: "fabrik-acme-clinic-push", environment: "fabrik", branch: "main" },
    ]);
    expect(deletions(actions).map(describeAction)).toEqual([
      "delete the repo-level Actions secret FABRIK_OP_AGENT_TOKEN: the Kit main pins reads the fabrik environment's",
      "delete the repo-level Actions secret FABRIK_OP_IMPLEMENT_TOKEN: the Kit main pins reads the fabrik environment's",
      "delete the repo-level Actions secret FABRIK_OP_PUSH_TOKEN: the Kit main pins reads the fabrik environment's",
    ]);
    expect(notes).toContain(OLD_ACCOUNTS);
    expect(notes).not.toContain(STAY);
    expect(accounts(actions)).toEqual([]);
  });

  /** A repo whose environment holds the three tokens, with all three at repo level too, and this caller workflow on its default branch. */
  const withCallerOnTheDefaultBranch = (caller: string | null) =>
    planSetup(aCleanProduct({ secrets: TOKENS, environment: held(TOKENS), defaultBranchCaller: caller }), kit);

  it.each([
    ["Setup's own release", "v1.4.2"],
    ["an earlier release of Setup's major", "v1.0.0"],
    ["a later release of Setup's major, as Dependabot bumps it", "v1.6.0"],
    ["a later major", "v2.0.0"],
  ])("counts a default branch whose caller pins %s as naming the environment, and deletes", (_, release) => {
    const { actions, notes } = withCallerOnTheDefaultBranch(callerAt(release));

    expect(deletions(actions).map((a) => a.secret)).toEqual(TOKENS);
    expect(notes).toContain(OLD_ACCOUNTS);
  });

  it.each<[string, () => string | null]>([
    ["has no caller workflow", () => null],
    ["pins an earlier major", () => callerAt("v0.9.1")],
    ["pins two releases", () => callerAt("v1.4.2").replace("schedule.yml@v1.4.2", "schedule.yml@v1.4.3")],
    ["pins a branch, which is no release", () => callerAt("main")],
    ["names Fabrik in no uses: line", () => "on: push\njobs: {}\n"],
  ])("doesn't count a default branch that %s, deletes nothing, and says the repo-level secrets stay", (_, caller) => {
    const { actions, notes } = withCallerOnTheDefaultBranch(caller());

    expect(deletions(actions)).toEqual([]);
    expect(notes).toContain(STAY);
  });

  it("reads the default branch's caller workflow, never the checkout's own, which can be the setup branch's", () => {
    const tokens = { secrets: TOKENS, environment: held(TOKENS) };
    const onTheSetupBranch = aCleanProduct({ ...tokens, files: { ".github/workflows/fabrik.yml": callerAt("v1.4.2") }, defaultBranchCaller: callerAt("v0.9.1") });
    const merged = aCleanProduct({ ...tokens, files: { ".github/workflows/fabrik.yml": callerAt("v0.9.1") }, defaultBranchCaller: callerAt("v1.4.2") });

    expect(deletions(planSetup(onTheSetupBranch, kit).actions)).toEqual([]);
    expect(deletions(planSetup(merged, kit).actions)).toHaveLength(3);
  });

  it("with only one Kit secret at repo level, deletes only it and names only its role's old account", () => {
    const state = aCleanProduct({ secrets: ["FABRIK_OP_IMPLEMENT_TOKEN", "STRIPE_KEY"], environment: held(TOKENS), defaultBranchCaller: callerAt("v1.4.2") });

    const { actions, notes } = planSetup(state, kit);

    expect(deletions(actions)).toEqual([
      { kind: "delete-repo-secret", secret: "FABRIK_OP_IMPLEMENT_TOKEN", account: "fabrik-acme-clinic-implement", environment: "fabrik", branch: "main" },
    ]);
    expect(notes.filter((note) => note.includes("old service account"))).toEqual([
      "Once the repo-level secret is deleted, delete the old service account fabrik-acme-clinic-implement on 1Password's site. Its token still works until you do, though it sits nowhere on GitHub.",
    ]);
  });

  it("names two old accounts with an and between them", () => {
    const state = aCleanProduct({ secrets: ["FABRIK_OP_PUSH_TOKEN", "FABRIK_OP_AGENT_TOKEN"], environment: held(TOKENS), defaultBranchCaller: callerAt("v1.4.2") });

    expect(planSetup(state, kit).notes).toContain(
      "Once the repo-level secrets are deleted, delete the old service accounts fabrik-acme-clinic-agent and fabrik-acme-clinic-push on 1Password's site. Their tokens still work until you do, though they sit nowhere on GitHub.",
    );
  });

  it("while they stay, names only those that sit at repo level", () => {
    const stays = (secrets: readonly string[]) =>
      planSetup(aCleanProduct({ secrets, environment: held(TOKENS), defaultBranchCaller: callerAt("v0.9.1") }), kit).notes.filter((note) => note.includes("for now"));

    expect(stays(["STRIPE_KEY", "FABRIK_OP_PUSH_TOKEN"])).toEqual([
      `The repo-level Actions secret FABRIK_OP_PUSH_TOKEN stays for now, since the Kit main pins names no environment and reads it. Once the setup PR is merged, run setup again and it deletes it: ${COMMAND}`,
    ]);
    expect(stays(["FABRIK_OP_IMPLEMENT_TOKEN", "FABRIK_OP_AGENT_TOKEN"])).toEqual([
      `The repo-level Actions secrets FABRIK_OP_AGENT_TOKEN and FABRIK_OP_IMPLEMENT_TOKEN stay for now, since the Kit main pins names no environment and reads them. Once the setup PR is merged, run setup again and it deletes them: ${COMMAND}`,
    ]);
  });

  it.each<[string, () => string | null]>([
    ["names the environment", () => callerAt("v1.4.2")],
    ["names none", () => callerAt("v0.9.1")],
    ["isn't there", () => null],
  ])("on a repo with no Kit secret at repo level, whose default branch's caller %s, plans no deletion and gives no note of one", (_, caller) => {
    const state = aCleanProduct({ secrets: ["STRIPE_KEY", "FABRIK_OP_TOKEN"], environment: held(TOKENS), defaultBranchCaller: caller() });

    const { actions, notes } = planSetup(state, kit);

    expect(deletions(actions)).toEqual([]);
    expect(notes.filter((note) => /repo-level|old service account/.test(note))).toEqual([]);
  });

  it("never deletes a repo-level secret of any other name, whatever the default branch pins", () => {
    const own = ["STRIPE_KEY", "FABRIK_OP_TOKEN", "OP_PUSH_TOKEN", "fabrik_op_push_token_old", "FABRIK_OP_PUSH_TOKEN_2"];
    for (const caller of [callerAt("v1.4.2"), callerAt("v0.9.1"), null]) {
      const { actions } = planSetup(aCleanProduct({ secrets: [...own, ...TOKENS], defaultBranchCaller: caller }), kit);

      expect(deletions(actions).filter((a) => !TOKENS.includes(a.secret))).toEqual([]);
    }
  });

  it("plans each deletion after every new account, the one for its own name included, so the environment holds the name first", () => {
    const state = aCleanProduct({ secrets: TOKENS, environment: held(["FABRIK_OP_AGENT_TOKEN"]), defaultBranchCaller: callerAt("v1.4.2") });

    const steps = planSetup(state, kit).actions.flatMap((a) => (a.kind === "create-service-account" || a.kind === "delete-repo-secret" ? [`${a.kind} ${a.secret}`] : []));

    expect(steps).toEqual([
      "create-service-account FABRIK_OP_IMPLEMENT_TOKEN",
      "create-service-account FABRIK_OP_PUSH_TOKEN",
      "delete-repo-secret FABRIK_OP_AGENT_TOKEN",
      "delete-repo-secret FABRIK_OP_IMPLEMENT_TOKEN",
      "delete-repo-secret FABRIK_OP_PUSH_TOKEN",
    ]);
  });

  it("is gone from repo level once its step is applied, so the next run plans nothing and names no old account again", () => {
    const state = aCleanProduct({ secrets: [...TOKENS, "STRIPE_KEY"], defaultBranchCaller: callerAt("v1.4.2") });
    const installed = afterApplying(state, planSetup(state, kit));

    const { actions, notes } = planSetup(installed, kit);

    expect(installed.secrets).toEqual(["STRIPE_KEY"]);
    expect(installed.environment?.secrets).toEqual(TOKENS);
    expect(actions).toEqual([]);
    expect(notes.filter((note) => /repo-level|old service account/.test(note))).toEqual([]);
  });

  describe("for another repo's tokens, as the store's one", () => {
    const STORE = "jrey8343/fabrik-runs";
    const storeToken = { secret: "FABRIK_OP_PUSH_TOKEN", account: "fabrik-jrey8343-fabrik-runs-push" };

    it("plans the same step naming the repo and its own default branch, and names its old account in a note of its own, the repo first", () => {
      const steps = deleteRepoSecrets([storeToken], "fabrik", "trunk", STORE);

      expect(steps).toEqual([{ kind: "delete-repo-secret", ...storeToken, environment: "fabrik", branch: "trunk", repo: STORE }]);
      expect(oldAccountsNotes(steps)).toEqual([
        "jrey8343/fabrik-runs: Once the repo-level secret is deleted, delete the old service account fabrik-jrey8343-fabrik-runs-push on 1Password's site. Its token still works until you do, though it sits nowhere on GitHub.",
      ]);
    });

    it("keeps each repo's old accounts in that repo's note, the Product repo's first", () => {
      const moved = aCleanProduct({ secrets: TOKENS, environment: held(TOKENS), defaultBranchCaller: callerAt("v1.4.2") });
      const steps = [...deleteRepoSecrets([storeToken], "fabrik", "trunk", STORE), ...planSetup(moved, kit).actions];

      expect(oldAccountsNotes(steps)).toEqual([
        OLD_ACCOUNTS,
        "jrey8343/fabrik-runs: Once the repo-level secret is deleted, delete the old service account fabrik-jrey8343-fabrik-runs-push on 1Password's site. Its token still works until you do, though it sits nowhere on GitHub.",
      ]);
    });

    it("tells whether the Kit a caller workflow pins names the environment from any caller's text, the store's too", () => {
      const storeCaller = (release: string) => pinCaller(kit.templates.storeCaller, release);

      expect(kitNamesEnvironment(storeCaller("v1.4.2"), "v1.4.2")).toBe(true);
      expect(kitNamesEnvironment(storeCaller("v2.1.0"), "v1.4.2")).toBe(true);
      expect(kitNamesEnvironment(storeCaller("v0.9.1"), "v1.4.2")).toBe(false);
      expect(kitNamesEnvironment(null, "v1.4.2")).toBe(false);
    });
  });

  it("is said in the README, in the paragraph on a repo's move, after the one on running Setup again", () => {
    const PARAGRAPH =
      "A repo already on the Kit moves its tokens to the `fabrik` environment over two runs of Setup at the major that brought it. The first makes the environment and three new service accounts in it, and opens the setup PR. Until that PR is merged, the Kit the repo pins names no environment and keeps running on the repo-level secrets. The first run that finds the new caller workflow on the default branch deletes the three repo-level secrets, and names the three old service accounts, `fabrik-<owner>-<repo>-agent`, `-implement` and `-push`, for you to delete on 1Password's site. Until you do, their tokens still work, though they sit nowhere on GitHub, and the repo has six accounts against 1Password's limit of 100.";
    const lines = readFileSync(resolve(KIT_DIR, "README.md"), "utf8").split("\n");

    // A later Ticket adds a sentence to its end, so only its start is held here.
    const paragraph = lines.find((line) => line.startsWith("A repo already on the Kit moves its tokens"));
    expect(paragraph?.slice(0, PARAGRAPH.length)).toBe(PARAGRAPH);
    // Straight after that paragraph and the command its last sentence gives.
    const before = lines.slice(0, lines.indexOf(paragraph ?? "")).filter((line) => line !== "");
    expect(before.slice(-4)).toEqual([expect.stringMatching(/^Running Setup again on a working install changes nothing.*name that release:$/), "```sh", expect.stringMatching(/^curl /), "```"]);
  });

  it("treats each 0.x minor as its own major, as semver does", () => {
    const state = aCleanProduct({ secrets: TOKENS, environment: held(TOKENS), defaultBranchCaller: callerAt("v0.1.9") });

    expect(deletions(planSetup(state, { ...kit, release: "v0.2.0" }).actions)).toEqual([]);
    expect(deletions(planSetup(state, { ...kit, release: "v0.1.0" }).actions)).toHaveLength(3);
  });
});

describe("Branch protection", () => {
  function protects(state: ProductState) {
    return planSetup(state, kit).actions.flatMap((a) => (a.kind === "protect-branch" ? [a] : []));
  }
  const withChecks = (checks: string[]) => ({
    ".fabrik/config.json": JSON.stringify({ sandbox: { checks } }),
  });

  it("requires a PR and the Required checks the Kit config lists on the default branch, with no bypass and no approving review, and holds admins to those rules", () => {
    const state = aCleanProduct({ files: withChecks(["build", "test"]) });

    expect(protects(state)).toEqual([
      {
        kind: "protect-branch",
        branch: "main",
        found: null,
        protection: {
          required_status_checks: { strict: false, checks: [{ context: "build" }, { context: "test" }] },
          enforce_admins: true,
          required_pull_request_reviews: {
            required_approving_review_count: 0,
            dismiss_stale_reviews: true,
            require_code_owner_reviews: false,
            require_last_push_approval: false,
          },
          restrictions: null,
          required_linear_history: false,
          allow_force_pushes: false,
          allow_deletions: false,
          block_creations: false,
          required_conversation_resolution: false,
          lock_branch: false,
          allow_fork_syncing: false,
        },
      },
    ]);
    expect(describeAction(protects(state)[0]!)).toBe(
      "protect main: a pull request: not required → required; required checks: none → build, test; admins held to the rules: no → yes; every other setting stays as it is",
    );
  });

  it("keeps the checks the branch already requires", () => {
    const state = aCleanProduct({ files: withChecks(["build"]), protection: aProtectedBranch(["lint"]) });

    expect(protects(state)[0]?.protection.required_status_checks?.checks).toEqual([{ context: "lint" }, { context: "build" }]);
  });

  it("changes only the settings Setup owns, keeping every other one as it finds it, and says nothing of admins already held to the rules", () => {
    const state = aCleanProduct({
      files: withChecks(["ci", "lint"]),
      protection: aProtectedBranch(["ci"], {
        required_status_checks: { strict: true, checks: [{ context: "ci", app_id: 15368 }] },
        enforce_admins: true,
        required_pull_request_reviews: {
          required_approving_review_count: 1,
          dismiss_stale_reviews: false,
          require_code_owner_reviews: true,
          require_last_push_approval: true,
        },
        required_linear_history: true,
        required_conversation_resolution: true,
        allow_force_pushes: true,
        lock_branch: true,
      }),
    });

    const [action] = protects(state);

    expect(action?.protection).toEqual({
      required_status_checks: { strict: true, checks: [{ context: "ci", app_id: 15368 }, { context: "lint" }] },
      enforce_admins: true,
      required_pull_request_reviews: {
        required_approving_review_count: 0,
        dismiss_stale_reviews: false,
        require_code_owner_reviews: true,
        require_last_push_approval: true,
      },
      restrictions: null,
      required_linear_history: true,
      allow_force_pushes: true,
      allow_deletions: false,
      block_creations: false,
      required_conversation_resolution: true,
      lock_branch: true,
      allow_fork_syncing: false,
    });
    expect(describeAction(action!)).toBe("protect main: required checks: ci → ci, lint; approving reviews: 1 → 0; every other setting stays as it is");
  });

  it("takes away a bypass that would let the Fabrik App merge without the Operator, keeping an organization repo's push and dismissal restrictions", () => {
    const team = { users: [], teams: ["maintainers"], apps: [] };
    const found = aProtectedBranch(["build"], {
      required_pull_request_reviews: {
        required_approving_review_count: 0,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        require_last_push_approval: false,
        dismissal_restrictions: team,
        bypass_pull_request_allowances: { users: ["octocat"], teams: [], apps: ["fabrik"] },
      },
      restrictions: team,
      required_linear_history: true,
      allow_deletions: true,
    });
    const state = aCleanProduct({
      repo: { owner: "acme", name: "clinic", defaultBranch: "main", inOrganization: true },
      files: withChecks(["build"]),
      protection: found,
    });

    const [action] = protects(state);

    expect(action?.protection).toEqual({
      ...found,
      enforce_admins: true,
      required_pull_request_reviews: { ...found.required_pull_request_reviews, bypass_pull_request_allowances: { users: [], teams: [], apps: [] } },
    });
    expect(action?.protection.required_pull_request_reviews).toEqual({
      required_approving_review_count: 0,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      require_last_push_approval: false,
      dismissal_restrictions: team,
      bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
    });
    expect(action?.protection.restrictions).toEqual(team);
    expect(describeAction(action!)).toBe("protect main: bypass allowances: app:fabrik, user:octocat → none; admins held to the rules: no → yes; every other setting stays as it is");
  });

  it("tells the Operator when the branch has no Required check yet", () => {
    const plan = planSetup(aCleanProduct(), kit);

    expect(plan.notes.join("\n")).toContain("sandbox.checks");
    expect(plan.notes).toContain("main has no Required checks yet: list the CI checks that must pass in sandbox.checks in .fabrik/config.json, then run setup again.");
  });

  it("holds admins to the rules of a branch that has everything else, changing nothing more", () => {
    const found = aProtectedBranch(["build", "lint"], { required_linear_history: true });
    const state = aCleanProduct({ files: withChecks(["build"]), protection: found });

    const [action] = protects(state);

    expect(action?.protection).toEqual({ ...found, enforce_admins: true });
    expect(describeAction(action!)).toBe("protect main: admins held to the rules: no → yes; every other setting stays as it is");
  });

  describe("a branch that asks for an approving review", () => {
    const asksForAReview = (enforce_admins: boolean) =>
      aProtectedBranch(["build"], {
        enforce_admins,
        required_pull_request_reviews: {
          required_approving_review_count: 1,
          dismiss_stale_reviews: true,
          require_code_owner_reviews: false,
          require_last_push_approval: false,
        },
      });

    it("holds admins to the rules and asks for none, since the Operator can't approve their own pull request", () => {
      const [action] = protects(aCleanProduct({ files: withChecks(["build"]), protection: asksForAReview(false) }));

      expect(action?.protection.enforce_admins).toBe(true);
      expect(action?.protection.required_pull_request_reviews?.required_approving_review_count).toBe(0);
      expect(describeAction(action!)).toBe("protect main: approving reviews: 1 → 0; admins held to the rules: no → yes; every other setting stays as it is");
    });

    it("is left alone when it already holds admins to its rules", () => {
      expect(protects(aCleanProduct({ files: withChecks(["build"]), protection: asksForAReview(true) }))).toEqual([]);
    });
  });

  it("holds admins to the rules when the Kit config lists no checks, and still says to list them", () => {
    const plan = planSetup(aCleanProduct({ protection: aProtectedBranch([]) }), kit);
    const [action] = plan.actions.flatMap((a) => (a.kind === "protect-branch" ? [a] : []));

    expect(action?.protection.enforce_admins).toBe(true);
    expect(action?.protection.required_status_checks).toBeNull();
    expect(describeAction(action!)).toBe("protect main: admins held to the rules: no → yes; every other setting stays as it is");
    expect(plan.notes).toContain("main has no Required checks yet: list the CI checks that must pass in sandbox.checks in .fabrik/config.json, then run setup again.");
  });

  it("leaves protection alone when it already requires all of that and holds admins to its rules", () => {
    const state = aCleanProduct({ files: withChecks(["build"]), protection: aProtectedBranch(["build", "lint"], { enforce_admins: true }) });

    expect(protects(state)).toEqual([]);
  });

  it("leaves protection alone once its own step is applied, whatever else the branch had", () => {
    const state = aCleanProduct({
      files: withChecks(["build"]),
      protection: aProtectedBranch([], { required_pull_request_reviews: null, required_linear_history: true }),
    });
    const plan = planSetup(state, kit);

    expect(protects(afterApplying(state, plan))).toEqual([]);
  });

  describe("a Kit config with Extra skills", () => {
    const config = JSON.stringify({ sandbox: { checks: ["build"] }, roles: { design: { skills: ["jrey8343/skills/event-storming"] } } });
    const pin = (repository: string) => JSON.stringify([{ repository, sha: "a".repeat(40) }]);

    it("checks the config with its skills lock, so a config whose picks are pinned still has the Required checks it lists required", () => {
      const state = aCleanProduct({ files: { ".fabrik/config.json": config, ".fabrik/skills.lock.json": pin("jrey8343/skills") } });

      expect(protects(state).map((a) => a.protection.required_status_checks?.checks)).toEqual([[{ context: "build" }]]);
      expect(planSetup(state, kit).notes.join("\n")).not.toContain("is invalid");
    });

    it.each([
      ["there's no skills lock", {}],
      ["the skills lock doesn't pin the pick's Skills source", { ".fabrik/skills.lock.json": pin("someone/else") }],
    ])("still calls the config invalid when %s", (_, lock) => {
      const plan = planSetup(aCleanProduct({ files: { ".fabrik/config.json": config, ...lock } }), kit);

      expect(plan.notes.join("\n")).toContain(".fabrik/config.json is invalid, so the Required checks it lists weren't added to the branch");
    });
  });

  describe("a Kit config that names the Console's App (console.app_id)", () => {
    const withKey = (checks: string[], appId = 42) => ({
      ".fabrik/config.json": JSON.stringify({ sandbox: { checks }, console: { app_id: appId } }),
    });
    const consoleNote = (id: number, branch = "main") =>
      `The Kit config names the Console's App (console.app_id is ${id}), so from this run on ${branch} merges only from the Console: GitHub refuses a merge at any head that App hasn't passed, from github.com, gh and an Operator session alike, the setup PR's included. Setup can't check the Console is ready, so look for this repo in the Console before you go on. Until the Console can pass a head here, the only way to merge is the Merge gate's by-hand way past.`;

    it("requires the Console check from that App at once, beside the listed checks, holds admins, and says from this run on the branch merges only from the Console", () => {
      const state = aCleanProduct({ files: withKey(["test"]) });
      const plan = planSetup(state, kit);
      const [action] = plan.actions.flatMap((a) => (a.kind === "protect-branch" ? [a] : []));

      expect(action?.protection.required_status_checks?.checks).toEqual([{ context: "test" }, { context: "Merge from the Console", app_id: 42 }]);
      expect(action?.protection.enforce_admins).toBe(true);
      expect(plan.notes).toContain(consoleNote(42));
    });

    it("keeps the App the branch requires each other check from", () => {
      const state = aCleanProduct({
        files: withKey(["test"]),
        protection: aProtectedBranch([], { required_status_checks: { strict: false, checks: [{ context: "test", app_id: 7 }] } }),
      });

      expect(protects(state)[0]?.protection.required_status_checks?.checks).toEqual([
        { context: "test", app_id: 7 },
        { context: "Merge from the Console", app_id: 42 },
      ]);
    });

    it.each([
      ["from another App", { context: "Merge from the Console", app_id: 41 }, "Merge from the Console (App 41)"],
      ["with no App", { context: "Merge from the Console" }, "Merge from the Console"],
    ])("puts the key's App beside the Console check the branch requires %s, and says so", (_, consoleCheck, before) => {
      const state = aCleanProduct({
        files: withKey(["test"]),
        protection: aProtectedBranch([], { enforce_admins: true, required_status_checks: { strict: false, checks: [{ context: "test" }, consoleCheck] } }),
      });
      const plan = planSetup(state, kit);
      const [action] = plan.actions.flatMap((a) => (a.kind === "protect-branch" ? [a] : []));

      expect(action?.protection.required_status_checks?.checks).toEqual([{ context: "test" }, { context: "Merge from the Console", app_id: 42 }]);
      expect(plan.notes).toContain(consoleNote(42));
      expect(describeAction(action!)).toBe(
        `protect main: required checks: test, ${before} → test, Merge from the Console (App 42); every other setting stays as it is`,
      );
    });

    it("names the Console check with its App when it adds it", () => {
      const state = aCleanProduct({ files: withKey(["test"]), protection: aProtectedBranch(["test"], { enforce_admins: true }) });

      expect(describeAction(protects(state)[0]!)).toBe(
        "protect main: required checks: test → test, Merge from the Console (App 42); every other setting stays as it is",
      );
    });

    it("leaves a branch alone, with no note, once it requires the Console check from that App", () => {
      const state = aCleanProduct({
        files: withKey(["test"]),
        protection: aProtectedBranch([], {
          enforce_admins: true,
          required_status_checks: { strict: false, checks: [{ context: "test" }, { context: "Merge from the Console", app_id: 42 }] },
        }),
      });
      const plan = planSetup(state, kit);

      expect(protects(state)).toEqual([]);
      expect(plan.notes.join("\n")).not.toContain("Console");
    });

    it("gives no note when the branch already requires the Console check from that App and the step changes something else", () => {
      const state = aCleanProduct({
        files: withKey(["test"]),
        protection: aProtectedBranch([], { required_status_checks: { strict: false, checks: [{ context: "test" }, { context: "Merge from the Console", app_id: 42 }] } }),
      });
      const plan = planSetup(state, kit);
      const [action] = plan.actions.flatMap((a) => (a.kind === "protect-branch" ? [a] : []));

      expect(describeAction(action!)).toBe("protect main: admins held to the rules: no → yes; every other setting stays as it is");
      expect(plan.notes.join("\n")).not.toContain("Console");
    });

    it("still says the branch has no Required checks yet when sandbox.checks is empty", () => {
      const plan = planSetup(aCleanProduct({ files: withKey([]) }), kit);
      const [action] = plan.actions.flatMap((a) => (a.kind === "protect-branch" ? [a] : []));

      expect(action?.protection.required_status_checks?.checks).toEqual([{ context: "Merge from the Console", app_id: 42 }]);
      expect(plan.notes).toContain("main has no Required checks yet: list the CI checks that must pass in sandbox.checks in .fabrik/config.json, then run setup again.");
    });

    it("adds no check, the Console check included, from a Kit config that is invalid, and says it is invalid", () => {
      const config = JSON.stringify({ sandbox: { checks: ["test"], nonsense: true }, console: { app_id: 42 } });
      const plan = planSetup(aCleanProduct({ files: { ".fabrik/config.json": config } }), kit);
      const [action] = plan.actions.flatMap((a) => (a.kind === "protect-branch" ? [a] : []));

      expect(action?.protection.required_status_checks).toBeNull();
      expect(plan.notes.join("\n")).toContain(".fabrik/config.json is invalid, so the Required checks it lists weren't added to the branch");
      expect(plan.notes.join("\n")).not.toContain("console.app_id is");
    });

    it("leaves the branch requiring the Console check once its own step is applied", () => {
      const state = aCleanProduct({ files: withKey(["test"]), protection: aProtectedBranch(["test", "lint"]) });

      expect(protects(afterApplying(state, planSetup(state, kit)))).toEqual([]);
    });
  });

  describe("a Kit config without console.app_id", () => {
    it.each([
      ["from an App", { context: "Merge from the Console", app_id: 41 }],
      ["with no App", { context: "Merge from the Console" }],
    ])("keeps a Console check the branch requires %s as it finds it, and says nothing of it", (_, consoleCheck) => {
      const state = aCleanProduct({ files: withChecks(["test"]), protection: aProtectedBranch([], { required_status_checks: { strict: false, checks: [consoleCheck] } }) });
      const plan = planSetup(state, kit);
      const [action] = plan.actions.flatMap((a) => (a.kind === "protect-branch" ? [a] : []));

      expect(action?.protection.required_status_checks?.checks).toEqual([consoleCheck, { context: "test" }]);
      expect(plan.notes.join("\n")).not.toContain("console.app_id is");
    });

    it("leaves a branch that requires the Console check and the rest alone", () => {
      const state = aCleanProduct({
        files: withChecks(["test"]),
        protection: aProtectedBranch([], { enforce_admins: true, required_status_checks: { strict: false, checks: [{ context: "test" }, { context: "Merge from the Console", app_id: 41 }] } }),
      });

      expect(protects(state)).toEqual([]);
    });

    it("requires no Console check on a first setup, which writes the starter Kit config", () => {
      const plan = planSetup(aCleanProduct(), kit);
      const [action] = plan.actions.flatMap((a) => (a.kind === "protect-branch" ? [a] : []));

      expect(written(plan.actions, ".fabrik/config.json")).toBeDefined();
      expect(JSON.stringify(action?.protection.required_status_checks ?? null)).not.toContain("Merge from the Console");
      expect(plan.notes.join("\n")).not.toContain("Console");
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
        triage: { model: "claude-opus-5-5", effort: "medium", timeout_minutes: 10 },
        design: { model: "claude-opus-5-5", effort: "high", timeout_minutes: 30 },
        implement: { model: "claude-sonnet-5-5", effort: "medium", timeout_minutes: 60 },
        review: { model: "claude-opus-5-5", effort: "high", timeout_minutes: 30 },
        audit: { model: "claude-opus-5-5", effort: "medium", timeout_minutes: 45 },
        retro: { model: "claude-opus-5-5", effort: "medium", timeout_minutes: 45 },
        research: { model: "claude-opus-5-5", effort: "medium", timeout_minutes: 30 },
        // The Digest writer's model is left to roles.review; its effort is its own medium (#759).
        digest: { effort: "medium", timeout_minutes: 10 },
        dispatch: { timeout_minutes: 10 },
        step_up: { model: "claude-opus-5-5", effort: "medium" },
      },
      max_in_flight: 2,
      caps: { design_sessions: 2, monitor_issues: 5, maps: 1, merge_gate: 3, follow_up_issues: 5 },
      monitor: { errors: null, red_main: true, main_checks: [] },
      audit: { day: "sunday" },
      retro: { day: "saturday" },
      digest: { enabled: true },
      operator: null,
      subscriptions: ["Claude token"],
      ui: null,
      preview: { url: null },
      production: null,
      staging: null,
      time_zone: null,
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

  it("creates a read-only service account for the Fabrik App vault, stored in the store's fabrik environment (ADR-0004)", () => {
    const { actions } = planSetup(aCleanProduct(), kit, operator);

    expect(actions).toContainEqual({
      kind: "create-service-account",
      name: "fabrik-jrey8343-fabrik-runs-push-env",
      vaults: ["Fabrik App"],
      secret: "FABRIK_OP_PUSH_TOKEN",
      environment: "fabrik",
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

    expect(planSetup(state, kit, operator)).toEqual({ actions: [], notes: expect.any(Array) as unknown, report: expect.any(Array) as unknown });
    expect(storeActions(state)).toEqual([]);
  });

  it("never makes a public store private: it tells the Operator, and changes nothing there", () => {
    const store = { exists: true, private: false, defaultBranch: "main", files: {}, secrets: [], environment: null };

    const plan = planSetup(aCleanProduct({ store }), kit, operator);

    expect(storeActions(aCleanProduct({ store }))).toEqual([]);
    expect(plan.notes.join("\n")).toMatch(/jrey8343\/fabrik-runs is public/);
  });

  it("repairs only what a private store lacks", () => {
    const clean = aCleanProduct();
    const setUp = afterApplying(clean, planSetup(clean, kit, operator));
    const lostSecret = { ...setUp, store: { ...setUp.store, environment: { ...setUp.store.environment!, secrets: [] } } };
    const lostRule = { ...setUp, store: { ...setUp.store, environment: { ...setUp.store.environment!, rules: [] } } };

    expect(storeActions(lostSecret)).toEqual(["create-service-account"]);
    expect(storeActions(lostRule)).toEqual(["hold-environment"]);
  });

  it("moves the Weekly summary's schedule and the Kit config's time_zone when the Operator gives a new time zone, and touches nothing else", () => {
    const clean = aCleanProduct();
    const setUp = afterApplying(clean, planSetup(clean, kit, operator));

    const actions = planSetup(setUp, kit, { timeZone: "Europe/London" }).actions;

    expect(actions.map((a) => a.kind)).toEqual(["write-file", "write-store-file"]);
    expect(storeWritten(actions, ".github/workflows/weekly-summary.yml")).toContain('timezone: "Europe/London"');
    expect(written(actions, ".fabrik/config.json")).toContain('"time_zone": "Europe/London"');
  });

  // #461: the daily Tick check's workflow doesn't exist at a release from before it, and a caller naming it there fails every run at startup.
  function storeCallerPinnedAt(release: string): string {
    const clean = aCleanProduct();
    const setUp = afterApplying(clean, planSetup(clean, kit, operator));
    const caller = setUp.store.files[".github/workflows/weekly-summary.yml"] ?? "";
    const pinned = caller.replaceAll("@v1.4.2", `@${release}`);
    const state = { ...setUp, store: { ...setUp.store, files: { ...setUp.store.files, ".github/workflows/weekly-summary.yml": pinned } } };
    return storeWritten(planSetup(state, kit, operator).actions, ".github/workflows/weekly-summary.yml") ?? pinned;
  }

  it("moves a store caller pinned to an older release in the same major up to Setup's release", () => {
    const caller = storeCallerPinnedAt("v1.3.0");

    expect(caller).toContain("uses: jrey8343/fabrik/.github/workflows/tick-check.yml@v1.4.2");
    expect(checkCallerWorkflow(caller)).toEqual({ ok: true, release: "v1.4.2" });
  });

  it("keeps a store caller pinned to a newer release in the same major at that release", () => {
    expect(checkCallerWorkflow(storeCallerPinnedAt("v1.5.0"))).toEqual({ ok: true, release: "v1.5.0" });
  });

  it("moves an older patch of Setup's own minor up too", () => {
    expect(checkCallerWorkflow(storeCallerPinnedAt("v1.4.1"))).toEqual({ ok: true, release: "v1.4.2" });
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

describe("The store's one token, the push account's, in the store's own fabrik environment (ADR-0004)", () => {
  const operator = { timeZone: "Australia/Sydney" };
  const STORE = "jrey8343/fabrik-runs";
  const STORE_CALLER = ".github/workflows/weekly-summary.yml";
  const TOKEN = "FABRIK_OP_PUSH_TOKEN";
  const COMMAND = "curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/v1.4.2/setup.sh | bash -s -- v1.4.2";
  const STAYS = `jrey8343/fabrik-runs: The repo-level Actions secret FABRIK_OP_PUSH_TOKEN stays for now, since the caller workflow setup found there pins no Kit that names the fabrik environment. Once setup has written the one that does, run setup again and it deletes it: ${COMMAND}`;
  const OLD_ACCOUNT =
    "jrey8343/fabrik-runs: Once the repo-level secret is deleted, delete the old service account fabrik-jrey8343-fabrik-runs-push on 1Password's site. Its token still works until you do, though it sits nowhere on GitHub.";
  const NEW_ACCOUNT: SetupAction = {
    kind: "create-service-account",
    name: "fabrik-jrey8343-fabrik-runs-push-env",
    vaults: ["Fabrik App"],
    secret: TOKEN,
    environment: "fabrik",
    repo: STORE,
  };
  /** The store's caller workflow as Setup writes it at a release, in the Operator's time zone. */
  const storeCallerAt = (release: string) => pinCaller(scheduleIn(kit.templates.storeCaller, operator.timeZone), release);
  /** A fabrik environment held to this branch, with these secrets. */
  const heldTo = (branch: string, secrets: readonly string[] = []): EnvironmentState => ({ branches: "selected", rules: [{ id: 1, name: branch, type: "branch" }], secrets });
  /** A private store with commits on its default branch, `trunk`, and Setup's Dependabot entry, then the overrides. */
  const aStore = (overrides: Partial<RunStoreState> = {}): RunStoreState => ({
    exists: true,
    private: true,
    defaultBranch: "trunk",
    files: { [STORE_CALLER]: storeCallerAt("v1.4.2"), ".github/dependabot.yml": kit.templates.dependabot },
    secrets: [],
    environment: null,
    ...overrides,
  });
  /** A Product repo that is set up, its own environment held and holding its three tokens and its Kit config the Operator's time zone, beside this store. */
  const beside = (store: RunStoreState): ProductState => {
    const clean = aCleanProduct();
    return { ...afterApplying(clean, planSetup(clean, kit, operator)), store };
  };
  /** The steps the plan has for the store, in the plan's order. */
  const ofTheStore = (actions: readonly SetupAction[]) => actions.filter((a) => "repo" in a && a.repo === STORE);
  const kinds = (actions: readonly SetupAction[]) => actions.map((a) => a.kind);

  it("for a store on an earlier major whose token sits at repo level, holds the store's environment to the store's own default branch, makes the -env account in it, rewrites the store's caller, deletes nothing, and says the repo-level secret stays until Setup runs again", () => {
    const onTheKit = aStore({ files: { [STORE_CALLER]: storeCallerAt("v0.9.1"), ".github/dependabot.yml": kit.templates.dependabot }, secrets: [TOKEN] });

    const { actions, notes } = planSetup(beside(onTheKit), kit, operator);

    expect(ofTheStore(actions)).toEqual([
      { kind: "hold-environment", environment: "fabrik", branch: "trunk", found: null, repo: STORE },
      { kind: "write-store-file", repo: STORE, path: STORE_CALLER, content: storeCallerAt("v1.4.2"), why: expect.any(String) as unknown },
      NEW_ACCOUNT,
    ]);
    expect(notes).toContain(STAYS);
    expect(notes).not.toContain(OLD_ACCOUNT);
  });

  it("on the next run, which finds the store's caller at Setup's release, deletes the store's repo-level token and names the old account, and makes no new one", () => {
    const moved = aStore({ secrets: [TOKEN, "ANOTHER"], environment: heldTo("trunk", [TOKEN]) });

    const { actions, notes } = planSetup(beside(moved), kit, operator);

    expect(actions).toEqual([
      { kind: "delete-repo-secret", secret: TOKEN, account: "fabrik-jrey8343-fabrik-runs-push", environment: "fabrik", branch: "trunk", repo: STORE },
    ]);
    expect(notes).toContain(OLD_ACCOUNT);
    expect(notes).not.toContain(STAYS);
  });

  it("plans the store's environment right after the Product repo's own, ahead of every other step, when both are to be held", () => {
    const { actions } = planSetup(aCleanProduct({ store: aStore() }), kit, operator);

    expect(actions.slice(0, 3).map((a) => [a.kind, "repo" in a ? a.repo : undefined])).toEqual([
      ["hold-environment", undefined],
      ["hold-environment", STORE],
      ["write-file", undefined],
    ]);
    expect(actions[1]).toEqual({ kind: "hold-environment", environment: "fabrik", branch: "trunk", found: null, repo: STORE });
  });

  it("plans the store's environment as the plan's first step when the Product repo's own is held, naming what it lets through as found", () => {
    const everyBranch = aStore({ environment: { branches: "all", rules: [], secrets: [TOKEN] } });
    const namesTheProductsBranch = aStore({ environment: heldTo("main", [TOKEN]) });

    expect(planSetup(beside(everyBranch), kit, operator).actions).toEqual([
      { kind: "hold-environment", environment: "fabrik", branch: "trunk", found: { branches: "all", rules: [] }, repo: STORE },
    ]);
    // The store's rule names the store's default branch, whatever the Product repo's is.
    expect(planSetup(beside(namesTheProductsBranch), kit, operator).actions.map(describeAction)).toEqual([
      "hold the fabrik environment in jrey8343/fabrik-runs to trunk alone: rules main → trunk",
    ]);
  });

  it("plans the deletion after the step that stores the token in the store's environment, when that environment lacks it", () => {
    const lacking = aStore({ secrets: [TOKEN], environment: heldTo("trunk") });

    const { actions, notes } = planSetup(beside(lacking), kit, operator);

    expect(kinds(actions)).toEqual(["create-service-account", "delete-repo-secret"]);
    expect(ofTheStore(actions)).toHaveLength(2);
    expect(actions.map(describeAction)).toEqual([
      'create the read-only service account "fabrik-jrey8343-fabrik-runs-push-env" (reads "Fabrik App") and store it as FABRIK_OP_PUSH_TOKEN in the fabrik environment in jrey8343/fabrik-runs',
      "delete the repo-level Actions secret FABRIK_OP_PUSH_TOKEN in jrey8343/fabrik-runs: the Kit trunk pins reads the fabrik environment's",
    ]);
    expect(notes).toContain(OLD_ACCOUNT);
  });

  /** A store whose environment holds the token, with it at repo level too, and this caller workflow on its default branch. */
  const withStoreCaller = (caller: string | null) =>
    planSetup(beside(aStore({ files: { [STORE_CALLER]: caller, ".github/dependabot.yml": kit.templates.dependabot }, secrets: [TOKEN], environment: heldTo("trunk", [TOKEN]) })), kit, operator);
  const deletions = (actions: readonly SetupAction[]) => actions.filter((a) => a.kind === "delete-repo-secret");

  it.each([
    ["Setup's own release", "v1.4.2"],
    ["an earlier release of Setup's major", "v1.0.0"],
    ["a later release of Setup's major, as Dependabot bumps it", "v1.6.0"],
    ["a later major", "v2.0.0"],
  ])("counts a store whose caller pins %s as naming the environment, and deletes", (_, release) => {
    const { actions, notes } = withStoreCaller(storeCallerAt(release));

    expect(deletions(actions)).toHaveLength(1);
    expect(notes).toContain(OLD_ACCOUNT);
    expect(notes).not.toContain(STAYS);
  });

  it.each<[string, () => string | null]>([
    ["has no caller workflow", () => null],
    ["pins an earlier major", () => storeCallerAt("v0.9.1")],
    ["pins two releases", () => storeCallerAt("v1.4.2").replace("tick-check.yml@v1.4.2", "tick-check.yml@v1.4.3")],
    ["names Fabrik in no uses: line", () => "on: push\njobs: {}\n"],
  ])("doesn't count a store that %s, deletes nothing though this run writes its caller, and says the repo-level secret stays until Setup runs again", (_, caller) => {
    const { actions, notes } = withStoreCaller(caller());

    expect(kinds(actions)).toEqual(["write-store-file"]);
    expect(notes).toContain(STAYS);
    expect(notes).not.toContain(OLD_ACCOUNT);
  });

  it("judges by the store's caller as the run first read it, in a plan made after the run wrote it: it deletes nothing, and still says the repo-level secret stays", () => {
    // What a run that began with the store's caller on an earlier major, or with none, reads once it has applied its plan.
    const afterTheRun = beside(aStore({ secrets: [TOKEN], environment: heldTo("trunk", [TOKEN]) }));

    for (const storeCallerAtStart of [storeCallerAt("v0.9.1"), null]) {
      const { actions, notes } = planSetup(afterTheRun, kit, operator, { storeCallerAtStart });

      expect(actions).toEqual([]);
      expect(notes).toContain(STAYS);
      expect(notes).not.toContain(OLD_ACCOUNT);
    }
    // A run that found the new caller there to begin with deletes, in whichever of its plans still finds the secret.
    expect(kinds(planSetup(afterTheRun, kit, operator, { storeCallerAtStart: storeCallerAt("v1.4.2") }).actions)).toEqual(["delete-repo-secret"]);
  });

  it("says nothing of a repo-level secret for a store that has none, whatever its caller pins", () => {
    for (const release of ["v1.4.2", "v0.9.1"]) {
      const store = aStore({ files: { [STORE_CALLER]: storeCallerAt(release), ".github/dependabot.yml": kit.templates.dependabot }, secrets: ["ANOTHER"], environment: heldTo("trunk", [TOKEN]) });

      const { actions, notes } = planSetup(beside(store), kit, operator);

      expect(deletions(actions)).toEqual([]);
      expect(notes.filter((note) => /repo-level|old service account/.test(note))).toEqual([]);
    }
  });

  it.each<[string, Partial<RunStoreState>, { timeZone?: string }]>([
    ["without the Operator's time zone", {}, {}],
    ["for a public store", { private: false }, operator],
  ])("plans nothing of the store %s, and says nothing of its token, though it sits at repo level in a store with no environment", (_, overrides, answers) => {
    const clean = aCleanProduct();
    const product = afterApplying(clean, planSetup(clean, kit, answers));
    const store = aStore({ files: { [STORE_CALLER]: storeCallerAt("v0.9.1") }, secrets: [TOKEN], ...overrides });

    const { actions, notes } = planSetup({ ...product, store }, kit, answers);

    expect(actions).toEqual([]);
    expect(notes.filter((note) => /repo-level|old service account|environment/.test(note))).toEqual([]);
  });

  it("for a store this run makes, plans its files, then its environment, held to the default branch its first commit makes, then its token in it, and never a repo-level secret", () => {
    const { actions, notes } = planSetup(aCleanProduct(), kit, operator);

    expect(kinds(actions.slice(0, 2))).toEqual(["hold-environment", "write-file"]);
    expect(actions.filter((a) => a.kind === "create-run-store" || ofTheStore([a]).length > 0)).toEqual([
      { kind: "create-run-store", repo: STORE, private: true },
      expect.objectContaining({ kind: "write-store-file", path: STORE_CALLER }),
      expect.objectContaining({ kind: "write-store-file", path: ".github/dependabot.yml" }),
      // No branch yet: the store has none until its first file is committed, so applying the step reads its name.
      { kind: "hold-environment", environment: "fabrik", branch: null, found: null, repo: STORE },
      NEW_ACCOUNT,
    ]);
    expect(notes.filter((note) => note.startsWith(STORE))).toEqual([]);
  });

  it("is said in the README: the last sentence of the fabrik environment's bullet, and the last of the paragraph on a repo's move", () => {
    const OF_ITS_OWN = " `fabrik-runs` gets a `fabrik` environment of its own, held to its own default branch, for its one token, the push account's.";
    const THE_SAME_WAY =
      " The store's one token moves the same way: on the first run that sets the store up at the major, and on the next, which finds its new caller workflow and deletes the repo-level secret, naming the old `fabrik-<owner>-fabrik-runs-push` account.";
    const lines = readFileSync(resolve(KIT_DIR, "README.md"), "utf8").split("\n");

    const bullet = lines.find((line) => line.startsWith("- **The `fabrik` environment**")) ?? "";
    expect(bullet.slice(-OF_ITS_OWN.length)).toBe(OF_ITS_OWN);
    // Straight after the sentences #929 wrote, which end on the stop with no fallback.
    expect(bullet.slice(0, -OF_ITS_OWN.length)).toMatch(/there is no fallback to repo-level secrets\.$/);
    const paragraph = lines.find((line) => line.startsWith("A repo already on the Kit moves its tokens")) ?? "";
    expect(paragraph.slice(-THE_SAME_WAY.length)).toBe(THE_SAME_WAY);
    // Straight after the sentences #931 wrote, which end on 1Password's limit.
    expect(paragraph.slice(0, -THE_SAME_WAY.length)).toMatch(/against 1Password's limit of 100\.$/);
  });

  it("is held, with its token in it, once the plan for a new store is applied, so the next run plans nothing for the store", () => {
    const clean = aCleanProduct();
    const setUp = afterApplying(clean, planSetup(clean, kit, operator));

    expect(setUp.store).toMatchObject({ exists: true, defaultBranch: "main", secrets: [], environment: heldTo("main", [TOKEN]) });
    expect(planSetup(setUp, kit, operator).actions).toEqual([]);
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
      /Running setup again walks it, then lists it in subscriptions in \.fabrik\/config\.json: curl -fsSL https:\/\/raw\.githubusercontent\.com\/jrey8343\/fabrik\/v1\.4\.2\/setup\.sh \| bash -s -- v1\.4\.2$/,
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
      `${lacks}: run setup again to walk the wizard's "A second Subscription" stage for it: curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/v1.4.2/setup.sh | bash -s -- v1.4.2`,
    );
    expect(planSetup(withConfig(twoListed, ["Claude token"]), kit, {}, { wizardNext: true }).notes).toContainEqual(
      `${lacks}: walk the wizard's "A second Subscription" stage for it.`,
    );
  });

  it("names the Claude token stage for a listed Claude token the Fabrik vault lacks", () => {
    const lacks = '.fabrik/config.json lists "Claude token" in subscriptions, but the "Fabrik" vault has no item of that name';

    expect(planSetup(withConfig(twoListed, ["Claude token 2"]), kit).notes).toContainEqual(
      `${lacks}: run setup again to walk the wizard's "The Claude token" stage for it: curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/v1.4.2/setup.sh | bash -s -- v1.4.2`,
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

  it("names a Subscription the Fabrik vault lacks in a list of one under its own name, which the Kit reads in place of the Claude token", () => {
    const byHand =
      '.fabrik/config.json lists "Claude backup" in subscriptions, but the "Fabrik" vault has no item of that name: run `claude setup-token` on that Subscription\'s Claude account and save the token as the "Claude backup" API Credential, with its expiry date, in the "Fabrik" vault yourself, since the wizard stores only "Claude token" and "Claude token 2".';

    for (const fabrikItems of [["Claude token"], []]) {
      const { notes } = planSetup(withConfig('{ "subscriptions": ["Claude backup"] }\n', fabrikItems), kit);
      expect(notes.filter((note) => note.includes("subscriptions"))).toEqual([byHand]);
    }
  });

  it("on a yes, only names the second Subscription's token for a list that names it alone, which setup lists nothing after", () => {
    const { actions, notes } = planSetup(withConfig('{ "subscriptions": ["Claude token 2"] }\n', ["Claude token"]), kit, operator);

    expect(written(actions, ".fabrik/config.json")).toBeUndefined();
    expect(notes.filter((note) => note.includes("Claude token 2"))).toEqual([
      '.fabrik/config.json lists "Claude token 2" in subscriptions, but the "Fabrik" vault has no item of that name: run setup again to walk the wizard\'s "A second Subscription" stage for it: curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/v1.4.2/setup.sh | bash -s -- v1.4.2',
    ]);
  });

  it("gives the Claude token no note in the default list, the Claude token alone, whose token the merge rule names", () => {
    for (const config of [oneListed, '{ "max_in_flight": 1 }\n']) {
      expect(planSetup(withConfig(config, []), kit).notes.join("\n")).not.toContain("subscriptions");
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

describe("The production block, which Setup proposes", () => {
  const live = { url: "https://clinic.example.com", environment: "production" };
  const why = (actions: readonly SetupAction[]) => {
    const action = actions.find((a) => a.kind === "write-file" && a.path === ".fabrik/config.json");
    return action === undefined ? undefined : describeAction(action);
  };
  const withConfig = (config: string) => aCleanProduct({ files: { ".fabrik/config.json": config } });
  const declared = (config: string | undefined) => {
    const resolved = resolveKitConfig({ config: config ?? null });
    return resolved.ok ? resolved.config.production : resolved.errors;
  };

  it("writes the starter with its production member set where it stands, and names the block and both values in the plan", () => {
    const { actions } = planSetup(aCleanProduct(), kit, { production: live });

    const config = written(actions, ".fabrik/config.json");
    expect(config).toBe(
      kit.templates.kitConfig.replace(
        '  "production": null,\n',
        '  "production": {\n    "url": "https://clinic.example.com",\n    "environment": "production"\n  },\n',
      ),
    );
    expect(declared(config)).toEqual({ ...live, workflow: null });
    expect(why(actions)).toBe(
      'write .fabrik/config.json (a starter Kit config with every v1 default, and the production block: url "https://clinic.example.com", environment "production")',
    );
  });

  it("writes an address with no environment as environment null, and names that", () => {
    const { actions } = planSetup(aCleanProduct(), kit, { production: { url: "https://clinic.example.com", environment: null } });

    expect(declared(written(actions, ".fabrik/config.json"))).toEqual({ url: "https://clinic.example.com", environment: null, workflow: null });
    expect(why(actions)).toContain('the production block: url "https://clinic.example.com", environment null');
  });

  it("adds the block as one member of an existing Kit config, every other byte kept, its tabs and CRLF line endings included", () => {
    const own = '{\r\n\t"operator": "jrey8343",\r\n\t"max_in_flight": 1\r\n}\r\n';

    const { actions } = planSetup(withConfig(own), kit, { production: live });

    expect(written(actions, ".fabrik/config.json")).toBe(
      '{\r\n\t"operator": "jrey8343",\r\n\t"max_in_flight": 1,\r\n\t"production": {\r\n\t\t"url": "https://clinic.example.com",\r\n\t\t"environment": "production"\r\n\t}\r\n}\r\n',
    );
    expect(why(actions)).toBe('write .fabrik/config.json (add the production block: url "https://clinic.example.com", environment "production")');
  });

  it("sets a production member that is null where it stands", () => {
    const config = '{\n  "production": null,\n  "max_in_flight": 1\n}\n';

    expect(written(planSetup(withConfig(config), kit, { production: live }).actions, ".fabrik/config.json")).toBe(
      '{\n  "production": {\n    "url": "https://clinic.example.com",\n    "environment": "production"\n  },\n  "max_in_flight": 1\n}\n',
    );
  });

  it("writes nothing when setup runs again with the same answers", () => {
    for (const state of [aCleanProduct(), withConfig('{\n  "max_in_flight": 1\n}\n')]) {
      const setUp = afterApplying(state, planSetup(state, kit, { production: live }));

      expect(written(planSetup(setUp, kit, { production: live }).actions, ".fabrik/config.json")).toBeUndefined();
    }
  });

  it("leaves a Kit config that already declares production byte for byte, whatever the answer, and says nothing of it", () => {
    const config = '{\n  "production": { "url": "https://www.clinic.example.com", "environment": "live" }\n}\n';

    const { actions, notes } = planSetup(withConfig(config), kit, { production: live });

    expect(written(actions, ".fabrik/config.json")).toBeUndefined();
    expect(notes.join("\n")).not.toContain("production");
  });

  it("leaves a Kit config that is not a JSON object byte for byte, with one line saying why", () => {
    for (const config of ["[]\n", "{ not json\n"]) {
      const { actions, notes } = planSetup(withConfig(config), kit, { production: live });

      expect(written(actions, ".fabrik/config.json")).toBeUndefined();
      expect(notes).toContainEqual(".fabrik/config.json isn't a JSON object, so setup didn't add the production block to it: fix it, then run setup again.");
    }
  });

  it("never writes an address Kit config would refuse, and says why", () => {
    const { actions, notes } = planSetup(aCleanProduct(), kit, { production: { url: "ftp://clinic.example.com", environment: null } });

    expect(written(actions, ".fabrik/config.json")).toBe(kit.templates.kitConfig);
    expect(notes.find((note) => note.includes("production"))).toMatch(/^Setup didn't write the production block: .*http:\/\/ or https:\/\//);
  });

  it("writes it with the second Subscription and Dispatch paused in the plan's one write of the starter on setup's branch", () => {
    const starter = aCleanProduct({ files: { ".fabrik/config.json": kit.templates.kitConfig }, vaults: ["Fabrik"], fabrikItems: ["Claude token", "Claude token 2"] });

    const { actions } = planSetup(starter, kit, { production: live, paused: true, secondSubscription: true }, { wroteStarter: true });

    const config = resolveKitConfig({ config: written(actions, ".fabrik/config.json") ?? null });
    expect(config.ok && [config.config.production, config.config.maxInFlight, config.config.subscriptions]).toEqual([{ ...live, workflow: null }, 0, ["Claude token", "Claude token 2"]]);
    expect(why(actions)).toContain('the production block: url "https://clinic.example.com", environment "production"');
    expect(actions.filter((a) => a.kind === "write-file" && a.path === ".fabrik/config.json")).toHaveLength(1);
  });

  it("adds it to the starter on setup's branch with nothing else to change", () => {
    const { actions } = planSetup(withConfig(kit.templates.kitConfig), kit, { production: live }, { wroteStarter: true });

    expect(declared(written(actions, ".fabrik/config.json"))).toEqual({ ...live, workflow: null });
    expect(why(actions)).toBe('write .fabrik/config.json (add the production block: url "https://clinic.example.com", environment "production")');
  });
});

describe("The staging block, which Setup proposes beside production's", () => {
  const trial = { url: "https://staging.clinic.example.com", environment: "staging" };
  const live = { url: "https://clinic.example.com", environment: "production" };
  const NAMED = 'the staging block: url "https://staging.clinic.example.com", environment "staging"';
  const why = (actions: readonly SetupAction[]) => {
    const action = actions.find((a) => a.kind === "write-file" && a.path === ".fabrik/config.json");
    return action === undefined ? undefined : describeAction(action);
  };
  const withConfig = (config: string) => aCleanProduct({ files: { ".fabrik/config.json": config } });
  const declared = (config: string | undefined) => {
    const resolved = resolveKitConfig({ config: config ?? null });
    return resolved.ok ? resolved.config.staging : resolved.errors;
  };

  it("writes the starter with its staging member set where it stands, a block Kit config accepts, and names the block and both values in the plan", () => {
    const { actions } = planSetup(aCleanProduct(), kit, { staging: trial });

    const config = written(actions, ".fabrik/config.json");
    expect(declared(config)).toEqual(trial);
    expect(config).toBe(
      kit.templates.kitConfig.replace(
        '  "staging": null,\n',
        '  "staging": {\n    "url": "https://staging.clinic.example.com",\n    "environment": "staging"\n  },\n',
      ),
    );
    expect(why(actions)).toBe(`write .fabrik/config.json (a starter Kit config with every v1 default, and ${NAMED})`);
  });

  it("declares no staging when the Operator declined: the starter as it is, its staging null as every default is spelled out, and no write to an existing Kit config", () => {
    const own = '{\n  "max_in_flight": 1\n}\n';

    expect(written(planSetup(aCleanProduct(), kit, {}).actions, ".fabrik/config.json")).toBe(kit.templates.kitConfig);
    expect(JSON.parse(kit.templates.kitConfig)).toMatchObject({ production: null, staging: null });
    expect(written(planSetup(withConfig(own), kit, {}).actions, ".fabrik/config.json")).toBeUndefined();
  });

  it("adds the block as one member of an existing Kit config, every other byte kept", () => {
    const own = '{\n  "operator": "jrey8343",\n  "production": { "url": "https://clinic.example.com", "environment": "production" }\n}\n';

    const { actions } = planSetup(withConfig(own), kit, { staging: trial });

    expect(written(actions, ".fabrik/config.json")).toBe(
      '{\n  "operator": "jrey8343",\n  "production": { "url": "https://clinic.example.com", "environment": "production" },\n  "staging": {\n    "url": "https://staging.clinic.example.com",\n    "environment": "staging"\n  }\n}\n',
    );
    expect(why(actions)).toBe(`write .fabrik/config.json (add ${NAMED})`);
  });

  it("sets a staging member that is null where it stands", () => {
    const config = '{\n  "staging": null,\n  "max_in_flight": 1\n}\n';

    expect(written(planSetup(withConfig(config), kit, { staging: trial }).actions, ".fabrik/config.json")).toBe(
      '{\n  "staging": {\n    "url": "https://staging.clinic.example.com",\n    "environment": "staging"\n  },\n  "max_in_flight": 1\n}\n',
    );
  });

  it("writes it in the same one write as the production block and the time zone, production's first", () => {
    const { actions } = planSetup(withConfig('{\n  "max_in_flight": 1\n}\n'), kit, { production: live, staging: trial, timeZone: "Australia/Sydney" });

    const config = resolveKitConfig({ config: written(actions, ".fabrik/config.json") ?? null });
    expect(config.ok && [config.config.production, config.config.staging, config.config.timeZone]).toEqual([{ ...live, workflow: null }, trial, "Australia/Sydney"]);
    expect(why(actions)).toBe(
      `write .fabrik/config.json (add the production block: url "https://clinic.example.com", environment "production", and add ${NAMED}, and set time_zone "Australia/Sydney")`,
    );
    expect(actions.filter((a) => a.kind === "write-file" && a.path === ".fabrik/config.json")).toHaveLength(1);
  });

  it("writes nothing when setup runs again with the same answers", () => {
    for (const state of [aCleanProduct(), withConfig('{\n  "max_in_flight": 1\n}\n')]) {
      const setUp = afterApplying(state, planSetup(state, kit, { staging: trial }));

      expect(written(planSetup(setUp, kit, { staging: trial }).actions, ".fabrik/config.json")).toBeUndefined();
    }
  });

  it("leaves a Kit config that already declares staging byte for byte, whatever the answer, and says nothing of it", () => {
    const config = '{\n  "staging": { "url": "https://next.clinic.example.com", "environment": "next" }\n}\n';

    const { actions, notes } = planSetup(withConfig(config), kit, { staging: trial });

    expect(written(actions, ".fabrik/config.json")).toBeUndefined();
    expect(notes.join("\n")).not.toContain("staging");
  });

  it("leaves a Kit config that is not a JSON object byte for byte, with one line saying why", () => {
    for (const config of ["[]\n", "{ not json\n"]) {
      const { actions, notes } = planSetup(withConfig(config), kit, { staging: trial });

      expect(written(actions, ".fabrik/config.json")).toBeUndefined();
      expect(notes).toContainEqual(".fabrik/config.json isn't a JSON object, so setup didn't add the staging block to it: fix it, then run setup again.");
    }
  });

  it("never writes a block Kit config would refuse, its own or beside the production the same plan writes, and says why", () => {
    const badAddress = planSetup(aCleanProduct(), kit, { staging: { ...trial, url: "ftp://staging.clinic.example.com" } });
    const sameEnvironment = planSetup(aCleanProduct(), kit, { production: live, staging: { ...trial, environment: "production" } });
    const besideDeclared = planSetup(withConfig('{\n  "production": { "url": "https://clinic.example.com", "environment": "staging" }\n}\n'), kit, { staging: trial });

    expect(written(badAddress.actions, ".fabrik/config.json")).toBe(kit.templates.kitConfig);
    expect(badAddress.notes.find((note) => note.includes("staging"))).toMatch(/^Setup didn't write the staging block: staging\.url is .*http:\/\/ or https:\/\/\.$/);
    expect(declared(written(sameEnvironment.actions, ".fabrik/config.json"))).toBeNull();
    expect(sameEnvironment.notes).toContainEqual(
      `Setup didn't write the staging block: staging.environment is "production": production.environment names it, and staging's environment is never production's.`,
    );
    expect(written(besideDeclared.actions, ".fabrik/config.json")).toBeUndefined();
    expect(besideDeclared.notes.find((note) => note.includes("staging block"))).toMatch(/^Setup didn't write the staging block: staging\.environment is "staging"/);
  });
});

describe("The Operator's time zone in the Kit config, which Setup keeps in step with the store's caller (ADR-0023)", () => {
  const sydney = { timeZone: "Australia/Sydney" };
  const why = (actions: readonly SetupAction[]) => {
    const action = actions.find((a) => a.kind === "write-file" && a.path === ".fabrik/config.json");
    return action === undefined ? undefined : describeAction(action);
  };
  const withConfig = (config: string) => aCleanProduct({ files: { ".fabrik/config.json": config } });
  const zoneIn = (config: string | undefined) => {
    const resolved = resolveKitConfig({ config: config ?? null });
    return resolved.ok ? resolved.config.timeZone : resolved.errors;
  };

  it("writes the starter with the answered zone in its time_zone, where it stands, and names it in the plan", () => {
    const { actions } = planSetup(aCleanProduct(), kit, sydney);

    const config = written(actions, ".fabrik/config.json");
    expect(config).toBe(kit.templates.kitConfig.replace('  "time_zone": null\n', '  "time_zone": "Australia/Sydney"\n'));
    expect(zoneIn(config)).toBe("Australia/Sydney");
    expect(why(actions)).toBe('write .fabrik/config.json (a starter Kit config with every v1 default, and time_zone "Australia/Sydney")');
  });

  it("adds time_zone to an existing Kit config, every other byte kept", () => {
    const { actions } = planSetup(withConfig('{\n  "max_in_flight": 1\n}\n'), kit, sydney);

    expect(written(actions, ".fabrik/config.json")).toBe('{\n  "max_in_flight": 1,\n  "time_zone": "Australia/Sydney"\n}\n');
    expect(why(actions)).toBe('write .fabrik/config.json (set time_zone "Australia/Sydney")');
  });

  it("overwrites a time_zone the Kit config already gives, where it stands", () => {
    const { actions } = planSetup(withConfig('{\n  "time_zone": "Europe/London",\n  "max_in_flight": 1\n}\n'), kit, sydney);

    expect(written(actions, ".fabrik/config.json")).toBe('{\n  "time_zone": "Australia/Sydney",\n  "max_in_flight": 1\n}\n');
  });

  it("writes nothing when the Kit config already gives the answered zone, or setup runs again with it", () => {
    expect(written(planSetup(withConfig('{\n  "time_zone": "Australia/Sydney"\n}\n'), kit, sydney).actions, ".fabrik/config.json")).toBeUndefined();
    const setUp = afterApplying(aCleanProduct(), planSetup(aCleanProduct(), kit, sydney));
    expect(written(planSetup(setUp, kit, sydney).actions, ".fabrik/config.json")).toBeUndefined();
  });

  it("writes no time_zone when the Operator leaves fabrik-runs out, or gives a zone that isn't one", () => {
    const own = '{\n  "time_zone": "Europe/London"\n}\n';
    for (const answers of [{}, { timeZone: "Mars/Olympus_Mons" }]) {
      expect(written(planSetup(aCleanProduct(), kit, answers).actions, ".fabrik/config.json")).toBe(kit.templates.kitConfig);
      expect(written(planSetup(withConfig(own), kit, answers).actions, ".fabrik/config.json")).toBeUndefined();
    }
  });

  it("sets it in the same one write as the production block", () => {
    const live = { url: "https://clinic.example.com", environment: "production" };

    const { actions } = planSetup(withConfig('{\n  "max_in_flight": 1\n}\n'), kit, { ...sydney, production: live });

    const config = resolveKitConfig({ config: written(actions, ".fabrik/config.json") ?? null });
    expect(config.ok && [config.config.production, config.config.timeZone]).toEqual([{ ...live, workflow: null }, "Australia/Sydney"]);
    expect(why(actions)).toBe('write .fabrik/config.json (add the production block: url "https://clinic.example.com", environment "production", and set time_zone "Australia/Sydney")');
    expect(actions.filter((a) => a.kind === "write-file" && a.path === ".fabrik/config.json")).toHaveLength(1);
  });

  it("leaves a Kit config that is not a JSON object byte for byte, with one line saying why", () => {
    const { actions, notes } = planSetup(withConfig("[]\n"), kit, sydney);

    expect(written(actions, ".fabrik/config.json")).toBeUndefined();
    expect(notes).toContainEqual(".fabrik/config.json isn't a JSON object, so setup didn't set time_zone in it: fix it, then run setup again.");
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

describe("Setup's report on a Product repo's own credentials", () => {
  const RULE =
    "A credential that can reach production belongs in an environment held to main alone, or in a role taken by OIDC whose trust names that environment and not the whole repo. Only test and preview credentials sit at repo level.";

  it("names each repo-level Actions secret of the repo's own, in name order, then the Kit's rule, with no line for the Kit's three", () => {
    const secrets = ["STRIPE_KEY", "FABRIK_OP_AGENT_TOKEN", "FABRIK_OP_IMPLEMENT_TOKEN", "CLOUDFLARE_API_TOKEN", "FABRIK_OP_PUSH_TOKEN"];

    const { report } = planSetup(aCleanProduct({ secrets }), kit);

    expect(report).toEqual([
      "The repo-level Actions secret CLOUDFLARE_API_TOKEN can be read by a workflow run on any branch.",
      "The repo-level Actions secret STRIPE_KEY can be read by a workflow run on any branch.",
      RULE,
    ]);
  });

  it("says a repo with none of its own holds none, and gives no rule's line, whether or not it holds the Kit's three", () => {
    const NONE = ["This repo holds no repo-level Actions secret of its own."];

    expect(planSetup(aCleanProduct({ secrets: [] }), kit).report).toEqual(NONE);
    expect(planSetup(aCleanProduct({ secrets: TOKENS }), kit).report).toEqual(NONE);
  });

  it("names the repo's default branch in the rule's line", () => {
    const clean = aCleanProduct({ secrets: ["STRIPE_KEY"] });

    const { report } = planSetup({ ...clean, repo: { ...clean.repo, defaultBranch: "trunk" } }, kit);

    expect(report.at(-1)).toBe(RULE.replace("held to main alone", "held to trunk alone"));
  });

  describe("on production's environment, when the Kit config's production block names one", () => {
    const rule = (name: string, type: "branch" | "tag" = "branch", id = 1) => ({ id, name, type });
    const NONE_OF_ITS_OWN = "This repo holds no repo-level Actions secret of its own.";
    /** The report's lines after those on the repo-level secrets. */
    const onProduction = (policy: EnvironmentPolicy | null, name = "production") =>
      planSetup(aCleanProduct({ production: { name, policy } }), kit).report.slice(1);

    it("says it is held to the default branch alone, after the lines on the repo-level secrets", () => {
      const held: EnvironmentPolicy = { branches: "selected", rules: [rule("main")] };

      expect(planSetup(aCleanProduct({ production: { name: "production", policy: held } }), kit).report).toEqual([
        NONE_OF_ITS_OWN,
        "Production's environment, production, is held to main alone.",
      ]);
      expect(planSetup(aCleanProduct({ secrets: ["STRIPE_KEY"], production: { name: "production", policy: held } }), kit).report).toEqual([
        "The repo-level Actions secret STRIPE_KEY can be read by a workflow run on any branch.",
        RULE,
        "Production's environment, production, is held to main alone.",
      ]);
    });

    it.each<[string, EnvironmentPolicy, string]>([
      ["every branch", { branches: "all", rules: [] }, "every branch"],
      ["protected branches only", { branches: "protected", rules: [] }, "protected branches only"],
      ["selected branches and tags with no rule", { branches: "selected", rules: [] }, "none"],
      ["a second rule", { branches: "selected", rules: [rule("main"), rule("release/*", "branch", 2)] }, "main, release/*"],
      ["a tag rule named as the default branch is", { branches: "selected", rules: [rule("main", "tag")] }, "tag main"],
      ["a tag rule beside the right one", { branches: "selected", rules: [rule("main"), rule("v*", "tag", 2)] }, "main, tag v*"],
    ])("says it isn't held with %s, naming its rules as the plan writes them", (_, policy, rules) => {
      expect(onProduction(policy)).toEqual([
        `Production's environment, production, isn't held to main alone (${rules}), so a run on another ref that names it is given its secrets.`,
      ]);
    });

    it("says it isn't on the repo when GitHub has none of that name", () => {
      expect(onProduction(null, "Production – clinic")).toEqual(["Production's environment, Production – clinic, isn't on this repo."]);
    });

    it("says it couldn't be read, with GitHub's answer, when GitHub refused the read, in place of whether it is held, and plans what it would have", () => {
      const refused = { name: "production", policy: null, refused: "gh: Resource not accessible by personal access token (HTTP 403)" };

      const { report, ...planned } = planSetup(aCleanProduct({ production: refused }), kit);

      expect(report.slice(1)).toEqual([
        "Production's environment, production, couldn't be read (gh: Resource not accessible by personal access token (HTTP 403)), so Setup can't say whether it is held to main alone.",
      ]);
      const { report: _unnamed, ...plannedWithNone } = planSetup(aCleanProduct({ production: null }), kit);
      expect(planned).toEqual(plannedWithNone);
    });

    it("keeps GitHub's answer to its first line, and drops its control characters as it drops the name's", () => {
      const clean = aCleanProduct({ production: { name: "live", policy: null, refused: "\n  gh: Bad \u001b[31mGateway\u0007 (HTTP 502)  \nRequest ID: 1\n" } });

      const { report } = planSetup({ ...clean, repo: { ...clean.repo, defaultBranch: "trunk" } }, kit);

      expect(report.slice(1)).toEqual(["Production's environment, live, couldn't be read (gh: Bad [31mGateway (HTTP 502)), so Setup can't say whether it is held to trunk alone."]);
    });

    it("judges it by the repo's default branch, whatever that is called", () => {
      const clean = aCleanProduct({ production: { name: "live", policy: { branches: "selected", rules: [rule("main")] } } });

      const { report } = planSetup({ ...clean, repo: { ...clean.repo, defaultBranch: "trunk" } }, kit);

      expect(report.slice(1)).toEqual(["Production's environment, live, isn't held to trunk alone (main), so a run on another ref that names it is given its secrets."]);
    });

    it("drops control characters from the name the Kit config gives, such as a terminal escape, since the report is printed to the terminal", () => {
      expect(onProduction(null, "live\u001b]52;c;ZXZpbA==\u0007\u009b2J")).toEqual(["Production's environment, live]52;c;ZXZpbA==2J, isn't on this repo."]);
    });

    it("says nothing of production when the Kit config names no environment for it", () => {
      expect(planSetup(aCleanProduct({ production: null }), kit).report).toEqual([NONE_OF_ITS_OWN]);
    });
  });

  it("changes no step and no note of the plan, whatever it says", () => {
    const quiet = aCleanProduct({ secrets: ["FABRIK_OP_AGENT_TOKEN"] });
    const loud = aCleanProduct({
      secrets: ["FABRIK_OP_AGENT_TOKEN", "STRIPE_KEY", "AWS_SECRET_ACCESS_KEY"],
      production: { name: "production", policy: { branches: "all", rules: [] } },
    });
    const { report: _quiet, ...planned } = planSetup(quiet, kit);
    const { report, ...plannedLoud } = planSetup(loud, kit);

    expect(report).toHaveLength(4);
    expect(plannedLoud).toEqual(planned);
    const settled = afterApplying(loud, planSetup(loud, kit));
    expect(planSetup(settled, kit).actions).toEqual([]);
    expect(planSetup(settled, kit).report).toEqual(report);
  });

  it("is said in the README's list of what Setup does, straight after the fabrik environment's bullet", () => {
    const BULLET =
      "- **Setup's report**, said on every run under the plan and again in its last lines, never in the setup PR: each repo-level Actions secret that isn't one of the Kit's three, by name, and that a workflow run on any branch can read it; and, when the Kit config's `production` block names an environment, whether that environment is held to the default branch alone. The Kit's rule for a Product repo's own credentials is that one that can reach production is the secret of an environment held to the default branch, or no stored secret at all: a role taken by OIDC whose trust names that environment and not the whole repo. Only test and preview credentials sit at repo level. Setup reports and never blocks: it makes and changes none of the repo's own environments, judges no secret by its name, and doesn't look inside a cloud account's trust policy, which is yours to check in each repo.";
    const lines = readFileSync(resolve(KIT_DIR, "README.md"), "utf8").split("\n");

    expect(lines).toContain(BULLET);
    expect(lines[lines.indexOf(BULLET) - 1]).toMatch(/^- \*\*The `fabrik` environment\*\* \(ADR-0004\): /);
  });
});

describe("Setup's report on each workflow a session can start that holds a role", () => {
  const NONE_OF_ITS_OWN = "This repo holds no repo-level Actions secret of its own.";
  const LISTING = (...held: readonly string[]) => JSON.stringify({ console: { app_id: 1234567, held_workflows: held } });
  /** A workflow with these lines for its `on:`, then these lines under `jobs:`. */
  const workflow = (on: readonly string[], jobs: readonly string[], top: readonly string[] = []) =>
    ["name: Some workflow", ...on, ...top, "jobs:", ...jobs, ""].join("\n");
  const DISPATCH = ["on:", "  workflow_dispatch:", "    inputs:", "      sha:", "        type: string"];
  const PROMOTE = workflow(DISPATCH, ["  promote:", "    runs-on: ubuntu-latest", "    environment: production", "    steps:", "      - run: ./promote"]);
  const DEPLOY = workflow(["on: [push, workflow_dispatch]"], [
    "  deploy:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      id-token: write",
    "      contents: read",
    "    environment:",
    "      name: production",
    "      url: https://clinic.example.com",
  ]);
  /** The report's lines but those on a job that can take a role off the default branch, which have their own tests below. */
  const held = (report: readonly string[]) => report.filter((line) => !line.startsWith(".github/workflows/"));
  /** The report's lines after the one on the repo-level secrets, for a repo holding these workflows and this Kit config, or none. */
  const onWorkflows = (workflows: Readonly<Record<string, string>>, config: string | null = null) =>
    held(planSetup(aCleanProduct({ workflows, files: config === null ? {} : { ".fabrik/config.json": config } }), kit).report.slice(1));
  const LISTED = (file: string, asks: string) =>
    `\`${file}\` can be started by dispatch, and a job of it ${asks}. Kit config lists it in console.held_workflows, so the Console offers a tap for it.`;
  const NOT_LISTED = (file: string, asks: string) =>
    `\`${file}\` can be started by dispatch, and a job of it ${asks}. Kit config doesn't list it in console.held_workflows, so a session can start it with no tap of yours: if only you may start it, make it a Held workflow (README, "Held workflows").`;

  it("says a workflow console.held_workflows lists is offered a tap, word for word", () => {
    expect(onWorkflows({ "promote.yml": PROMOTE }, LISTING("promote.yml"))).toEqual([
      "`promote.yml` can be started by dispatch, and a job of it names the environment `production`. Kit config lists it in console.held_workflows, so the Console offers a tap for it.",
    ]);
  });

  it("says one it doesn't list can be started with no tap, word for word, and so for a repo with no console block", () => {
    const LINE =
      '`deploy.yml` can be started by dispatch, and a job of it asks for id-token: write and names the environment `production`. Kit config doesn\'t list it in console.held_workflows, so a session can start it with no tap of yours: if only you may start it, make it a Held workflow (README, "Held workflows").';

    expect(onWorkflows({ "deploy.yml": DEPLOY }, LISTING("promote.yml"))).toEqual([LINE]);
    expect(onWorkflows({ "deploy.yml": DEPLOY }, '{ "max_in_flight": 1 }\n')).toEqual([LINE]);
    expect(onWorkflows({ "deploy.yml": DEPLOY })).toEqual([LINE]);
  });

  it("gives a line for a job that asks for id-token: write through the workflow's own permissions:, or write-all, and names no environment", () => {
    const job = ["  plan:", "    runs-on: ubuntu-latest"];

    expect(onWorkflows({ "plan.yml": workflow(["on: workflow_dispatch"], job, ["permissions:", "  id-token: write"]) })).toEqual([
      NOT_LISTED("plan.yml", "asks for id-token: write"),
    ]);
    expect(onWorkflows({ "plan.yml": workflow(["on: workflow_dispatch"], job, ["permissions: write-all"]) })).toEqual([NOT_LISTED("plan.yml", "asks for id-token: write")]);
  });

  it("gives none for a job whose own permissions: {} replaces the workflow's id-token: write, and which names no environment", () => {
    const text = workflow(["on: workflow_dispatch"], ["  plan:", "    permissions: {}", "    runs-on: ubuntu-latest"], ["permissions:", "  id-token: write"]);

    expect(onWorkflows({ "plan.yml": text })).toEqual([]);
  });

  it("gives none for a workflow that names an environment but can't be dispatched, nor for a dispatchable one with no job that holds a role", () => {
    const pushed = workflow(["on: push"], ["  deploy:", "    environment: production", "    permissions:", "      id-token: write"]);
    const tests = workflow(["on: [pull_request, workflow_dispatch]"], ["  test:", "    runs-on: ubuntu-latest", "    permissions:", "      contents: read"]);

    expect(onWorkflows({ "deploy-on-merge.yml": pushed, "test.yml": tests })).toEqual([]);
  });

  it("names each environment the jobs name once, in the order the jobs give them", () => {
    const text = workflow(
      ["on: workflow_dispatch"],
      [
        "  staging:",
        "    environment: staging",
        "  production:",
        "    environment: production",
        "  again:",
        "    environment: staging",
        "  dns:",
        "    environment: dns",
        "    permissions:",
        "      id-token: write",
      ],
    );

    expect(onWorkflows({ "promote.yaml": text })).toEqual([
      NOT_LISTED("promote.yaml", "asks for id-token: write and names the environments `staging`, `production` and `dns`"),
    ]);
    expect(onWorkflows({ "two.yml": workflow(["on: workflow_dispatch"], ["  a:", "    environment: staging", "  b:", "    environment: production"]) })).toEqual([
      NOT_LISTED("two.yml", "names the environments `staging` and `production`"),
    ]);
  });

  it("gives one line to each workflow, in the order of the files' names, whatever order they're read in", () => {
    expect(onWorkflows({ "promote.yml": PROMOTE, "deploy.yml": DEPLOY, "dns-apply.yaml": PROMOTE }, LISTING("promote.yml", "dns-apply.yaml"))).toEqual([
      NOT_LISTED("deploy.yml", "asks for id-token: write and names the environment `production`"),
      LISTED("dns-apply.yaml", "names the environment `production`"),
      LISTED("promote.yml", "names the environment `production`"),
    ]);
  });

  it("gives no line to the Kit's own caller workflow, fabrik.yml, whatever it asks for", () => {
    expect(onWorkflows({ "fabrik.yml": DEPLOY }, LISTING("fabrik.yml"))).toEqual([]);
    expect(onWorkflows({ "fabrik.yml": written(planSetup(aCleanProduct(), kit).actions, ".github/workflows/fabrik.yml") ?? "" })).toEqual([]);
  });

  it("still gives every line when the Kit config is invalid, saying it can't say whether the list holds it", () => {
    const INVALID = (file: string, asks: string) =>
      `\`${file}\` can be started by dispatch, and a job of it ${asks}. Kit config is invalid, so setup can't say whether console.held_workflows lists it.`;

    for (const config of ["{ not json\n", JSON.stringify({ console: { held_workflows: ["promote.yml"] } })]) {
      expect(onWorkflows({ "promote.yml": PROMOTE, "deploy.yml": DEPLOY }, config)).toEqual([
        INVALID("deploy.yml", "asks for id-token: write and names the environment `production`"),
        INVALID("promote.yml", "names the environment `production`"),
      ]);
    }
  });

  it("drops control characters from a file's name and an environment's, since the report is printed to the terminal", () => {
    const text = workflow(["on: workflow_dispatch"], ["  deploy:", "    environment: prod\u001b]52;c;ZXZpbA==\u0007uction"]);

    expect(onWorkflows({ "dep\u001b[2Jloy.yml": text })).toEqual([NOT_LISTED("dep[2Jloy.yml", "names the environment `prod]52;c;ZXZpbA==uction`")]);
  });

  it("puts its lines in the report after those on the repo's own credentials, and none in the plan's notes, its steps or the setup PR", () => {
    const quiet = aCleanProduct({ secrets: ["STRIPE_KEY"], production: { name: "production", policy: { branches: "all", rules: [] } } });
    const loud = { ...quiet, workflows: { "promote.yml": PROMOTE, "deploy.yml": DEPLOY } };

    const { report, ...planned } = planSetup(loud, kit);

    const { report: credentials, ...plannedQuiet } = planSetup(quiet, kit);
    expect(held(report)).toEqual([
      ...credentials,
      NOT_LISTED("deploy.yml", "asks for id-token: write and names the environment `production`"),
      NOT_LISTED("promote.yml", "names the environment `production`"),
    ]);
    expect(planned).toEqual(plannedQuiet);
    const body = prBody({ release: "v1.4.2", defaultBranch: "main", summary: { done: [], notes: planned.notes, blockers: [], report } });
    expect(body).not.toContain("can be started by dispatch");
    expect(body).not.toContain("held_workflows");
  });

  it("is said on every run, the same once the plan is applied", () => {
    const state = aCleanProduct({ workflows: { "promote.yml": PROMOTE } });
    const settled = afterApplying(state, planSetup(state, kit));

    expect(planSetup(settled, kit).actions).toEqual([]);
    expect(planSetup(settled, kit).report).toEqual([NONE_OF_ITS_OWN, NOT_LISTED("promote.yml", "names the environment `production`")]);
  });
});

describe("Setup's report on what an Operator session could reach", () => {
  /** A workflow with these lines for its `on:`, then these lines under `jobs:`. */
  const workflow = (on: readonly string[], jobs: readonly string[], top: readonly string[] = []) =>
    ["name: Some workflow", ...on, ...top, "jobs:", ...jobs, ""].join("\n");
  /** One job of this name asking for id-token: write by its own permissions:, with these lines more. */
  const roleJob = (name: string, ...more: readonly string[]) => [`  ${name}:`, "    runs-on: ubuntu-latest", "    permissions:", "      id-token: write", ...more];
  const pushed = (...jobs: readonly string[]) => workflow(["on: push"], jobs);
  /** The report's lines after the one on the repo-level secrets, for a repo holding these workflows and these environments. */
  const onRoles = (workflows: Readonly<Record<string, string>>, roleEnvironments: ProductState["roleEnvironments"] = {}) =>
    planSetup(aCleanProduct({ workflows, roleEnvironments }), kit).report.slice(1);
  const NO_ENVIRONMENT = (file: string, job: string) =>
    `.github/workflows/${file}: its job \`${job}\` asks for id-token: write and names no environment, so a run on any branch can take a role this repo's trust allows.`;
  const NOT_HELD = (file: string, job: string, environment: string) =>
    `.github/workflows/${file}: its job \`${job}\` asks for id-token: write and names the environment \`${environment}\`, which isn't held to the default branch alone, so a run on another branch can take its role.`;

  it("names a job that asks for id-token: write and names no environment, word for word", () => {
    expect(onRoles({ "plan.yml": pushed(...roleJob("plan")) })).toEqual([
      ".github/workflows/plan.yml: its job `plan` asks for id-token: write and names no environment, so a run on any branch can take a role this repo's trust allows.",
    ]);
  });

  it("names a job whose environment isn't held to the default branch alone, word for word, and none whose environment is", () => {
    const text = pushed(...roleJob("deploy", "    environment: production"));
    const held: EnvironmentPolicy = { branches: "selected", rules: [{ id: 1, name: "main", type: "branch" }] };

    expect(onRoles({ "deploy.yml": text }, { production: { branches: "all", rules: [] } })).toEqual([
      ".github/workflows/deploy.yml: its job `deploy` asks for id-token: write and names the environment `production`, which isn't held to the default branch alone, so a run on another branch can take its role.",
    ]);
    expect(onRoles({ "deploy.yml": text }, { production: { branches: "selected", rules: [{ id: 1, name: "main", type: "tag" }] } })).toEqual([
      NOT_HELD("deploy.yml", "deploy", "production"),
    ]);
    expect(onRoles({ "deploy.yml": text }, { production: held })).toEqual([]);
  });

  it("counts an environment the repo doesn't have as not held, whether read as missing or never read", () => {
    const text = pushed(...roleJob("deploy", "    environment:", "      name: production", "      url: https://clinic.example.com"));

    expect(onRoles({ "deploy.yml": text }, { production: null })).toEqual([NOT_HELD("deploy.yml", "deploy", "production")]);
    expect(onRoles({ "deploy.yml": text })).toEqual([NOT_HELD("deploy.yml", "deploy", "production")]);
    expect(onRoles({ "deploy.yml": pushed(...roleJob("deploy", "    environment: constructor")) })).toEqual([NOT_HELD("deploy.yml", "deploy", "constructor")]);
  });

  it("judges an environment by the repo's default branch, whatever that is called", () => {
    const clean = aCleanProduct({
      workflows: { "deploy.yml": pushed(...roleJob("deploy", "    environment: production")) },
      roleEnvironments: { production: { branches: "selected", rules: [{ id: 1, name: "main", type: "branch" }] } },
    });

    expect(planSetup({ ...clean, repo: { ...clean.repo, defaultBranch: "trunk" } }, kit).report.slice(1)).toEqual([NOT_HELD("deploy.yml", "deploy", "production")]);
  });

  it("reads id-token: write from the workflow's own permissions:, or write-all, and none from a job whose own permissions: grants none", () => {
    const job = ["  plan:", "    runs-on: ubuntu-latest"];
    const own = ["  plan:", "    runs-on: ubuntu-latest", "    permissions:", "      contents: read"];

    expect(onRoles({ "plan.yml": workflow(["on: push"], job, ["permissions:", "  id-token: write"]) })).toEqual([NO_ENVIRONMENT("plan.yml", "plan")]);
    expect(onRoles({ "plan.yml": workflow(["on: push"], job, ["permissions: write-all"]) })).toEqual([NO_ENVIRONMENT("plan.yml", "plan")]);
    expect(onRoles({ "plan.yml": workflow(["on: push"], own, ["permissions:", "  id-token: write"]) })).toEqual([]);
    expect(onRoles({ "plan.yml": workflow(["on: push"], ["  plan:", "    permissions: {}"], ["permissions: write-all"]) })).toEqual([]);
  });

  it("gives a workflow that can't be dispatched its lines all the same, beside a dispatchable one's own line", () => {
    const dispatched = workflow(["on: workflow_dispatch"], roleJob("apply"));

    expect(onRoles({ "on-merge.yml": pushed(...roleJob("deploy")), "apply.yml": dispatched })).toEqual([
      expect.stringMatching(/^`apply\.yml` can be started by dispatch/),
      NO_ENVIRONMENT("apply.yml", "apply"),
      NO_ENVIRONMENT("on-merge.yml", "deploy"),
    ]);
  });

  it("goes in the order of the files' names, then of the jobs in each, whatever order they're read in", () => {
    const two = pushed(...roleJob("zeta"), ...roleJob("alpha", "    environment: staging"), "  test:", "    runs-on: ubuntu-latest");

    expect(onRoles({ "b.yml": two, "a.yaml": pushed(...roleJob("only")) })).toEqual([
      NO_ENVIRONMENT("a.yaml", "only"),
      NO_ENVIRONMENT("b.yml", "zeta"),
      NOT_HELD("b.yml", "alpha", "staging"),
    ]);
  });

  it("gives no line to the Kit's own caller workflow, fabrik.yml, as the plan writes it or whatever it asks for", () => {
    expect(onRoles({ "fabrik.yml": written(planSetup(aCleanProduct(), kit).actions, ".github/workflows/fabrik.yml") ?? "" })).toEqual([]);
    expect(onRoles({ "fabrik.yml": pushed(...roleJob("deploy")) })).toEqual([]);
  });

  it("drops control characters from a file's and an environment's name, since the report is printed to the terminal", () => {
    const text = pushed(...roleJob("deploy", "    environment: prod\u001b]52;c;ZXZpbA==\u0007uction"));

    expect(onRoles({ "dep\u001b[2Jloy.yml": text })).toEqual([NOT_HELD("dep[2Jloy.yml", "deploy", "prod]52;c;ZXZpbA==uction")]);
  });

  describe("on a Session environment Kit config names", () => {
    const NAMING = (name: string) => JSON.stringify({ console: { session_environment: name } });
    /** The report's lines after the one on the repo-level secrets, for a checkout holding these files. */
    const onFiles = (files: ProductState["files"], workflows: Readonly<Record<string, string>> = {}) => planSetup(aCleanProduct({ files, workflows }), kit).report.slice(1);

    it("says its sessions take it to attach nothing when the repo has no .fabrik/operator-session.md, word for word", () => {
      expect(onFiles({ ".fabrik/config.json": NAMING("clinic-sessions") })).toEqual([
        "Kit config names the Session environment `clinic-sessions`, and the repo has no .fabrik/operator-session.md, so its Operator sessions take it to attach nothing.",
      ]);
    });

    it("says nothing when the repo has .fabrik/operator-session.md, and nothing when Kit config names none", () => {
      expect(onFiles({ ".fabrik/config.json": NAMING("clinic-sessions"), ".fabrik/operator-session.md": "# What sessions can reach\n" })).toEqual([]);
      expect(onFiles({ ".fabrik/config.json": '{ "max_in_flight": 1 }\n' })).toEqual([]);
      expect(onFiles({ ".fabrik/config.json": JSON.stringify({ console: { app_id: 1234567 } }) })).toEqual([]);
      expect(onFiles({})).toEqual([]);
    });

    it("says nothing for an invalid Kit config, whose errors are a note of their own", () => {
      for (const config of ["{ not json\n", JSON.stringify({ console: { session_environment: "clinic-sessions", held_workflows: ["promote.yml"] } })]) {
        const { report, notes } = planSetup(aCleanProduct({ files: { ".fabrik/config.json": config } }), kit);

        expect(report.slice(1)).toEqual([]);
        expect(notes).toContainEqual(expect.stringMatching(/^\.fabrik\/config\.json is invalid/));
      }
    });

    it("comes after the lines on jobs that can take a role off the default branch", () => {
      expect(onFiles({ ".fabrik/config.json": NAMING("clinic-sessions") }, { "plan.yml": pushed(...roleJob("plan")) })).toEqual([
        NO_ENVIRONMENT("plan.yml", "plan"),
        expect.stringMatching(/^Kit config names the Session environment `clinic-sessions`/),
      ]);
    });

    it("drops control characters from the name, since the report is printed to the terminal", () => {
      expect(onFiles({ ".fabrik/config.json": NAMING("clinic\u001b[2J-sessions") })).toEqual([
        "Kit config names the Session environment `clinic[2J-sessions`, and the repo has no .fabrik/operator-session.md, so its Operator sessions take it to attach nothing.",
      ]);
    });

    it("reads .fabrik/operator-session.md from the checkout, with the other files Setup reads", () => {
      expect(setupPaths(kit)).toContain(".fabrik/operator-session.md");
    });
  });

  it("puts its lines last in the report, and none in the plan's notes, its steps or the setup PR, on every run", () => {
    const files = { ".fabrik/config.json": JSON.stringify({ console: { session_environment: "clinic-sessions" } }) };
    const quiet = aCleanProduct({ secrets: ["STRIPE_KEY"], files, workflows: { "promote.yml": workflow(["on: workflow_dispatch"], ["  promote:", "    environment: production"]) } });
    const loud = { ...quiet, workflows: { ...quiet.workflows, "deploy.yml": pushed(...roleJob("deploy", "    environment: production")), "plan.yml": pushed(...roleJob("plan")) } };

    const { report, ...planned } = planSetup(loud, kit);

    const { report: before, ...plannedQuiet } = planSetup({ ...quiet, files: { ...files, ".fabrik/operator-session.md": "Nothing.\n" } }, kit);
    const ours = [
      NOT_HELD("deploy.yml", "deploy", "production"),
      NO_ENVIRONMENT("plan.yml", "plan"),
      "Kit config names the Session environment `clinic-sessions`, and the repo has no .fabrik/operator-session.md, so its Operator sessions take it to attach nothing.",
    ];
    expect(report).toEqual([...before, ...ours]);
    expect(planned).toEqual(plannedQuiet);
    const body = prBody({ release: "v1.4.2", defaultBranch: "main", summary: { done: [], notes: planned.notes, blockers: [], report } });
    for (const line of ours) expect(body).not.toContain(line);
    expect(body).not.toContain("id-token");
    expect(body).not.toContain("operator-session.md");
    const settled = afterApplying(loud, planSetup(loud, kit));
    expect(planSetup(settled, kit).report).toEqual(report);
  });

  it("is said in the README's list of what Setup does, straight after the Setup's report bullet", () => {
    const BULLET =
      "- **What an Operator session could reach,** also in Setup's report, on every run: each job that asks for `id-token: write` and names no environment, or names one that isn't held to the default branch alone, by file and job; and, when Kit config names a Session environment (`console.session_environment`) and the repo has no `.fabrik/operator-session.md`, that its sessions take it to attach nothing. Beside them is the line on each workflow a session can start by dispatch (see [Held workflows](#held-workflows)). The Kit's own caller workflow is in none of them. Setup never blocks on any of these, changes nothing of the repo's, and never looks inside a cloud account's trust policy: which workflows do a short-list act is your judgement (see [Operator sessions](#operator-sessions)).";
    const lines = readFileSync(resolve(KIT_DIR, "README.md"), "utf8").split("\n");

    expect(lines).toContain(BULLET);
    expect(lines[lines.indexOf(BULLET) - 1]).toMatch(/^- \*\*Setup's report\*\*, /);
  });
});
