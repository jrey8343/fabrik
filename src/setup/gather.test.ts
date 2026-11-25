// What setup reads with the Operator's own gh of a repo's environment, which
// refs it lets through and its secrets' names, and of a repo's Deployments, to
// offer production's environment and address: each environment's name, and
// the address on its newest successful Deployment where GitHub has one.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Answer, aReadyOperator, fakeCommands, HEAD_SHA } from "../__fixtures__/setupCommands.ts";
import { tempDir } from "../__fixtures__/skillsArchive.ts";
import { gatherDeployments, gatherEnvironment, gatherState, gatherWorkflows, readEnvironmentPolicy } from "./gather.ts";

const REPO = { owner: "acme", name: "clinic", defaultBranch: "main", inOrganization: false };
const page = (n: number) => `gh api repos/acme/clinic/deployments?per_page=100&page=${n}`;
const LIST = page(1);
const statuses = (id: number) => `gh api repos/acme/clinic/deployments/${id}/statuses?per_page=100`;

const json = (value: unknown): Answer => ({ stdout: JSON.stringify(value) });
const deployment = (id: number, environment: string, createdAt: string) => ({ id, environment, created_at: createdAt });
const status = (state: string, url = "") => ({ state, environment_url: url });

async function read(script: Record<string, Answer>) {
  const commands = fakeCommands(script);
  return { seen: await gatherDeployments(commands.run, "/clinic", REPO), calls: commands.calls.map((call) => call.line) };
}

describe("Reading a repo's environment: which refs it lets through, and its secrets' names", () => {
  const ENVIRONMENT = "gh api repos/acme/clinic/environments/fabrik";
  const RULES = "gh api repos/acme/clinic/environments/fabrik/deployment-branch-policies?per_page=100";
  const SECRETS = "gh secret list --env fabrik --json name";

  async function readEnvironment(script: Record<string, Answer>) {
    const commands = fakeCommands(script);
    return { environment: await gatherEnvironment(commands.run, "/clinic", "acme/clinic", "fabrik"), calls: commands.calls.map((call) => call.line) };
  }

  it("gives no environment for one GitHub answers 404 for, and reads nothing more of it", async () => {
    const { environment, calls } = await readEnvironment({ [ENVIRONMENT]: { code: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: "gh: Not Found (HTTP 404)\n" } });

    expect(environment).toBeNull();
    expect(calls).toEqual([ENVIRONMENT]);
  });

  /** The environment as GitHub's GET answers it, with the members Setup never reads. */
  const anEnvironment = (policy: unknown) => json({ id: 7, name: "fabrik", protection_rules: [], deployment_branch_policy: policy });

  it("reads one GitHub made because a workflow named it as every branch, with no rule to read", async () => {
    const { environment, calls } = await readEnvironment({ [ENVIRONMENT]: anEnvironment(null), [SECRETS]: json([]) });

    expect(environment).toEqual({ branches: "all", rules: [], secrets: [] });
    expect(calls).toEqual([ENVIRONMENT, SECRETS]);
  });

  it("reads protected branches only, with no rule to read", async () => {
    const { environment, calls } = await readEnvironment({
      [ENVIRONMENT]: anEnvironment({ protected_branches: true, custom_branch_policies: false }),
      [SECRETS]: json([]),
    });

    expect(environment).toEqual({ branches: "protected", rules: [], secrets: [] });
    expect(calls).not.toContain(RULES);
  });

  it("reads selected branches and tags with each rule's id, name and type, and its secrets' names", async () => {
    const { environment } = await readEnvironment({
      [ENVIRONMENT]: anEnvironment({ protected_branches: false, custom_branch_policies: true }),
      [RULES]: json({
        total_count: 2,
        branch_policies: [
          { id: 41, node_id: "MDE2", name: "main", type: "branch" },
          { id: 42, node_id: "MDE3", name: "v*", type: "tag" },
        ],
      }),
      [SECRETS]: json([{ name: "FABRIK_OP_PUSH_TOKEN" }, { name: "STRIPE_KEY" }]),
    });

    expect(environment).toEqual({
      branches: "selected",
      rules: [
        { id: 41, name: "main", type: "branch" },
        { id: 42, name: "v*", type: "tag" },
      ],
      secrets: ["FABRIK_OP_PUSH_TOKEN", "STRIPE_KEY"],
    });
  });

  it("reads selected branches and tags with no rule in it as no rules", async () => {
    const { environment } = await readEnvironment({
      [ENVIRONMENT]: anEnvironment({ protected_branches: false, custom_branch_policies: true }),
      [RULES]: json({ total_count: 0, branch_policies: [] }),
      [SECRETS]: json([]),
    });

    expect(environment).toEqual({ branches: "selected", rules: [], secrets: [] });
  });

  it("stops at any refusal but a 404, naming GitHub's answer", async () => {
    const refused = readEnvironment({ [ENVIRONMENT]: { code: 1, stderr: "gh: Resource not accessible by personal access token (HTTP 403)\n" } });

    await expect(refused).rejects.toThrow(
      "Reading the fabrik environment on acme/clinic failed: gh: Resource not accessible by personal access token (HTTP 403)",
    );
  });

  it("reads another repo's environment of another name, telling gh secret the repo", async () => {
    const commands = fakeCommands({
      "gh api repos/jrey8343/fabrik-runs/environments/production": anEnvironment({ protected_branches: false, custom_branch_policies: true }),
      "gh api repos/jrey8343/fabrik-runs/environments/production/deployment-branch-policies?per_page=100": json({
        total_count: 1,
        branch_policies: [{ id: 9, name: "main", type: "branch" }],
      }),
      "gh secret list --env production --repo jrey8343/fabrik-runs --json name": json([{ name: "DEPLOY_KEY" }]),
    });

    const environment = await gatherEnvironment(commands.run, "/clinic", "jrey8343/fabrik-runs", "production", { elsewhere: true });

    expect(environment).toEqual({ branches: "selected", rules: [{ id: 9, name: "main", type: "branch" }], secrets: ["DEPLOY_KEY"] });
  });

  it("reads which refs an environment lets through alone, its secrets' names left unread", async () => {
    const commands = fakeCommands({ [ENVIRONMENT]: anEnvironment({ protected_branches: false, custom_branch_policies: true }), [RULES]: json({ branch_policies: [] }) });

    const policy = await readEnvironmentPolicy(commands.run, "/clinic", "acme/clinic", "fabrik");

    expect(policy).toEqual({ branches: "selected", rules: [] });
    expect(commands.calls.map((call) => call.line)).toEqual([ENVIRONMENT, RULES]);
  });
});

describe("Reading a repo's Deployments for production's question", () => {
  it("gives each environment, newest first, with the address on its newest successful Deployment", async () => {
    const { seen } = await read({
      [LIST]: json([
        deployment(3, "preview", "2026-11-10T09:00:00Z"),
        deployment(2, "production", "2026-11-09T09:00:00Z"),
        deployment(1, "production", "2026-11-08T09:00:00Z"),
      ]),
      [statuses(3)]: json([status("success", "https://pr-4.clinic.example.dev")]),
      // The newest failed; the one before succeeded, and GitHub turned that success inactive when a later one came.
      [statuses(2)]: json([status("failure"), status("in_progress")]),
      [statuses(1)]: json([status("inactive", "https://clinic.example.com"), status("success", "https://clinic.example.com")]),
    });

    expect(seen).toEqual({
      read: true,
      environments: [
        { name: "preview", url: "https://pr-4.clinic.example.dev" },
        { name: "production", url: "https://clinic.example.com" },
      ],
    });
  });

  it("gives no address for an environment none of whose Deployments succeeded with one", async () => {
    const { seen } = await read({
      [LIST]: json([deployment(2, "staging", "2026-11-09T09:00:00Z"), deployment(1, "production", "2026-11-08T09:00:00Z")]),
      [statuses(2)]: json([status("success")]),
      [statuses(1)]: json([status("in_progress", "https://clinic.example.com")]),
    });

    expect(seen).toEqual({ read: true, environments: [{ name: "staging", url: null }, { name: "production", url: null }] });
  });

  it("takes an address GitHub holds that isn't http or https as none", async () => {
    const { seen } = await read({
      [LIST]: json([deployment(1, "production", "2026-11-08T09:00:00Z")]),
      [statuses(1)]: json([status("success", "ftp://clinic.example.com")]),
    });

    expect(seen).toEqual({ read: true, environments: [{ name: "production", url: null }] });
  });

  it("gives no environments for a repo that reports no Deployments", async () => {
    expect((await read({ [LIST]: json([]) })).seen).toEqual({ read: true, environments: [] });
  });

  it("lists an environment none of whose Deployments is among the newest hundred", async () => {
    const previews = Array.from({ length: 100 }, (_, i) => deployment(200 - i, "preview", `2026-11-10T09:${String(i % 60).padStart(2, "0")}:00Z`));
    const script: Record<string, Answer> = {
      [page(1)]: json(previews),
      [page(2)]: json([deployment(1, "production", "2026-10-01T09:00:00Z")]),
      [statuses(1)]: json([status("success", "https://clinic.example.com")]),
    };
    for (const { id } of previews) script[statuses(id)] = json([status("success", "https://pr.clinic.example.dev")]);

    const { seen } = await read(script);

    expect(seen).toEqual({
      read: true,
      environments: [
        { name: "preview", url: "https://pr.clinic.example.dev" },
        { name: "production", url: "https://clinic.example.com" },
      ],
    });
  });

  it("reads further back than a run of failed Deployments for the newest that succeeded, and no further", async () => {
    const many = Array.from({ length: 9 }, (_, i) => deployment(9 - i, "production", `2026-11-0${9 - i}T09:00:00Z`));
    const script: Record<string, Answer> = { [LIST]: json(many) };
    for (const { id } of many) script[statuses(id)] = json([status("failure")]);
    script[statuses(2)] = json([status("inactive", "https://clinic.example.com"), status("success", "https://clinic.example.com")]);

    const { seen, calls } = await read(script);

    expect(seen).toEqual({ read: true, environments: [{ name: "production", url: "https://clinic.example.com" }] });
    expect(calls.filter((line) => line.includes("/statuses"))).toEqual([9, 8, 7, 6, 5, 4, 3, 2].map(statuses));
  });

  it("says why when the read is refused, and fails nothing", async () => {
    const { seen } = await read({ [LIST]: { code: 1, stderr: "gh: Resource not accessible by integration (HTTP 403)\n" } });

    expect(seen).toEqual({ read: false, why: "gh: Resource not accessible by integration (HTTP 403)" });
  });

  it("says why when GitHub's answer can't be read, and fails nothing", async () => {
    const { seen } = await read({ [LIST]: { stdout: "<html>" } });

    expect(seen.read).toBe(false);
  });

  it("takes a refused read of one Deployment's statuses as no address there", async () => {
    const { seen } = await read({
      [LIST]: json([deployment(1, "production", "2026-11-08T09:00:00Z")]),
      [statuses(1)]: { code: 1, stderr: "gh: Not Found (HTTP 404)" },
    });

    expect(seen).toEqual({ read: true, environments: [{ name: "production", url: null }] });
  });
});

describe("Reading production's environment for Setup's report, when the checkout's Kit config names one", () => {
  const KIT_CONFIG = ".fabrik/config.json";
  const LIVE = "gh api repos/acme/clinic/environments/live";
  const RULES = `${LIVE}/deployment-branch-policies?per_page=100`;

  /** What Setup gathers of acme/clinic from a checkout holding this Kit config, or none, and the environments it asked GitHub for. */
  async function gathered(config: string | null, script: Record<string, Answer> = {}) {
    const dir = await tempDir("setup-gather");
    if (config !== null) {
      await mkdir(join(dir, ".fabrik"));
      await writeFile(join(dir, KIT_CONFIG), config);
    }
    const commands = fakeCommands({ ...aReadyOperator(dir), ...script });
    const state = await gatherState(commands.run, dir, REPO, [KIT_CONFIG], HEAD_SHA);
    return { production: state.production, asked: commands.calls.map((call) => call.line).filter((line) => /environments\/|--env/.test(line)) };
  }
  const naming = (environment: string | null) => JSON.stringify({ production: { url: "https://clinic.example.com", environment } });

  it("reads which refs that environment lets through, by its name, and never its secrets' names", async () => {
    const { production, asked } = await gathered(naming("live"), {
      [LIVE]: json({ id: 9, name: "live", deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }),
      [RULES]: json({ total_count: 2, branch_policies: [{ id: 41, name: "main", type: "branch" }, { id: 42, name: "v*", type: "tag" }] }),
    });

    expect(production).toEqual({
      name: "live",
      policy: {
        branches: "selected",
        rules: [
          { id: 41, name: "main", type: "branch" },
          { id: 42, name: "v*", type: "tag" },
        ],
      },
    });
    expect(asked).toEqual(["gh api repos/acme/clinic/environments/fabrik", LIVE, RULES]);
  });

  it("gives it with no policy when the repo has no environment of that name", async () => {
    const { production } = await gathered(naming("live"), { [LIVE]: { code: 1, stderr: "gh: Not Found (HTTP 404)\n" } });

    expect(production).toEqual({ name: "live", policy: null });
  });

  it.each<[string, Record<string, Answer>]>([
    ["the environment", { [LIVE]: { code: 1, stderr: "gh: Resource not accessible by personal access token (HTTP 403)\n" } }],
    [
      "its rules",
      {
        [LIVE]: json({ id: 9, name: "live", deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }),
        [RULES]: { code: 1, stderr: "gh: Resource not accessible by personal access token (HTTP 403)\n" },
      },
    ],
  ])("gives it with GitHub's answer, and stops nothing, when GitHub refuses the read of %s with anything but a 404", async (_, script) => {
    const { production } = await gathered(naming("live"), script);

    expect(production).toEqual({ name: "live", policy: null, refused: "gh: Resource not accessible by personal access token (HTTP 403)" });
  });

  it("still stops on a refused read of the fabrik environment, which the plan is made from, naming GitHub's answer", async () => {
    const refused = gathered(naming("live"), { "gh api repos/acme/clinic/environments/fabrik": { code: 1, stderr: "gh: Bad Gateway (HTTP 502)\n" } });

    await expect(refused).rejects.toThrow("Reading the fabrik environment on acme/clinic failed: gh: Bad Gateway (HTTP 502)");
  });

  it("asks GitHub for a name that holds a space or a slash as one segment of the path, and keeps the name as the Kit config gives it", async () => {
    const ENCODED = "gh api repos/acme/clinic/environments/Live%20%2F%20clinic";
    const { production, asked } = await gathered(naming("Live / clinic"), {
      [ENCODED]: json({ id: 9, name: "Live / clinic", deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }),
      [`${ENCODED}/deployment-branch-policies?per_page=100`]: json({ total_count: 1, branch_policies: [{ id: 41, name: "main", type: "branch" }] }),
    });

    expect(production).toEqual({ name: "Live / clinic", policy: { branches: "selected", rules: [{ id: 41, name: "main", type: "branch" }] } });
    expect(asked.slice(1)).toEqual([ENCODED, `${ENCODED}/deployment-branch-policies?per_page=100`]);
  });

  it.each<[string, string | null]>([
    ["no Kit config", null],
    ["a Kit config with no production block", '{ "max_in_flight": 1 }\n'],
    ["a production block that is null", '{ "production": null }\n'],
    ["a production block whose environment is null", naming(null)],
    ["a Kit config that isn't JSON", "{ not json\n"],
  ])("gives none and reads no environment for it with %s", async (_, config) => {
    const { production, asked } = await gathered(config);

    expect(production).toBeNull();
    expect(asked).toEqual(["gh api repos/acme/clinic/environments/fabrik"]);
  });
});

describe("Reading the caller workflow the default branch holds", () => {
  const CALLER = ".github/workflows/fabrik.yml";
  const AT_THE_TIP = `git show ${HEAD_SHA}:${CALLER}`;

  /** What Setup gathers of acme/clinic from a checkout whose own caller workflow is the setup branch's, with git answering for the default branch's tip. */
  async function gathered(script: Record<string, Answer> = {}) {
    const dir = await tempDir("setup-gather");
    await mkdir(join(dir, ".github/workflows"), { recursive: true });
    await writeFile(join(dir, CALLER), "# the setup branch's\n");
    const commands = fakeCommands({ ...aReadyOperator(dir), ...script });
    return { state: await gatherState(commands.run, dir, REPO, [CALLER], HEAD_SHA), calls: commands.calls.map((call) => call.line) };
  }

  it("reads it from the default branch's tip on origin, as the checks found it, and never from the checkout's own copy", async () => {
    const { state, calls } = await gathered({ [AT_THE_TIP]: { stdout: "# the default branch's\n" } });

    expect(state.defaultBranchCaller).toBe("# the default branch's\n");
    expect(state.files[CALLER]).toBe("# the setup branch's\n");
    expect(calls).toContain(AT_THE_TIP);
  });

  it("gives none when the default branch's tip has no caller workflow, though the checkout has one", async () => {
    const { state } = await gathered();

    expect(state.defaultBranchCaller).toBeNull();
  });
});

describe("Reading the checkout's workflows for Setup's report", () => {
  it("reads each .yml and .yaml file directly in .github/workflows/, by its file's name, and nothing else", async () => {
    const dir = await tempDir("setup-gather");
    const workflows = join(dir, ".github/workflows");
    await mkdir(join(workflows, "nested"), { recursive: true });
    await mkdir(join(workflows, "folder.yml"));
    await writeFile(join(workflows, "promote.yml"), "on: workflow_dispatch\n");
    await writeFile(join(workflows, "dns-apply.yaml"), "on: [workflow_dispatch]\n");
    await writeFile(join(workflows, "README.md"), "# not a workflow\n");
    await writeFile(join(workflows, "deploy.yml.bak"), "on: workflow_dispatch\n");
    await writeFile(join(workflows, "nested", "deeper.yml"), "on: workflow_dispatch\n");
    await writeFile(join(dir, ".github", "elsewhere.yml"), "on: workflow_dispatch\n");

    expect(await gatherWorkflows(dir)).toEqual({ "promote.yml": "on: workflow_dispatch\n", "dns-apply.yaml": "on: [workflow_dispatch]\n" });
  });

  it("gives none for a checkout with no .github/workflows/ folder", async () => {
    expect(await gatherWorkflows(await tempDir("setup-gather"))).toEqual({});
  });

  it("is what gatherState gives as the Product state's workflows", async () => {
    const dir = await tempDir("setup-gather");
    await mkdir(join(dir, ".github/workflows"), { recursive: true });
    await writeFile(join(dir, ".github/workflows/promote.yml"), "on: workflow_dispatch\n");
    const commands = fakeCommands(aReadyOperator(dir));

    expect((await gatherState(commands.run, dir, REPO, [], HEAD_SHA)).workflows).toEqual({ "promote.yml": "on: workflow_dispatch\n" });
  });
});

describe("Reading the environments a job that asks for id-token: write names, for Setup's report", () => {
  const ENV = (name: string) => `gh api repos/acme/clinic/environments/${name}`;
  const RULES = (name: string) => `${ENV(name)}/deployment-branch-policies?per_page=100`;
  const idTokenJob = (name: string, environment: string) => [`  ${name}:`, "    permissions:", "      id-token: write", `    environment: ${environment}`];
  const workflow = (...jobs: readonly string[]) => ["on: push", "jobs:", ...jobs, ""].join("\n");

  /** What Setup gathers of acme/clinic from a checkout holding these workflows, and the environments it asked GitHub for. */
  async function gathered(workflows: Record<string, string>, script: Record<string, Answer> = {}) {
    const dir = await tempDir("setup-gather");
    await mkdir(join(dir, ".github/workflows"), { recursive: true });
    for (const [name, text] of Object.entries(workflows)) await writeFile(join(dir, ".github/workflows", name), text);
    const commands = fakeCommands({ ...aReadyOperator(dir), ...script });
    const state = await gatherState(commands.run, dir, REPO, [], HEAD_SHA);
    return { idTokenEnvironments: state.idTokenEnvironments, asked: commands.calls.map((call) => call.line).filter((line) => /environments\/|--env/.test(line)).slice(1) };
  }

  it("reads each one once, which refs it lets through and never its secrets, and none a job names without id-token: write, nor the caller's", async () => {
    const { idTokenEnvironments, asked } = await gathered(
      {
        "deploy.yml": workflow(...idTokenJob("deploy", "production"), ...idTokenJob("again", "production"), "  preview:", "    environment: preview"),
        "apply.yml": workflow(...idTokenJob("apply", "staging"), ...idTokenJob("dns", "dns")),
        "fabrik.yml": workflow(...idTokenJob("agent", "agent-only")),
      },
      {
        [ENV("production")]: json({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }),
        [RULES("production")]: json({ branch_policies: [{ id: 41, name: "main", type: "branch" }] }),
        [ENV("staging")]: json({ deployment_branch_policy: null }),
        [ENV("dns")]: { code: 1, stderr: "gh: Not Found (HTTP 404)\n" },
      },
    );

    expect(idTokenEnvironments).toEqual({
      staging: { policy: { branches: "all", rules: [] } },
      dns: { policy: null },
      production: { policy: { branches: "selected", rules: [{ id: 41, name: "main", type: "branch" }] } },
    });
    expect(asked).toEqual([ENV("staging"), ENV("dns"), ENV("production"), RULES("production")]);
  });

  it("keeps GitHub's answer for one it refuses the read of, in place of whether it is on the repo, and stops nothing", async () => {
    const { idTokenEnvironments } = await gathered({ "deploy.yml": workflow(...idTokenJob("deploy", "production")) }, {
      [ENV("production")]: { code: 1, stderr: "gh: Resource not accessible by personal access token (HTTP 403)\n" },
    });

    expect(idTokenEnvironments).toEqual({ production: { refused: "gh: Resource not accessible by personal access token (HTTP 403)" } });
  });

  it("reads none for a checkout with no job that asks for id-token: write and names an environment", async () => {
    const { idTokenEnvironments, asked } = await gathered({ "plan.yml": workflow("  plan:", "    permissions:", "      id-token: write") });

    expect(idTokenEnvironments).toEqual({});
    expect(asked).toEqual([]);
  });
});

describe("Reading the fabrik-runs store, which Setup has no checkout of", () => {
  const STORE = "jrey8343/fabrik-runs";
  const VIEW = `gh repo view ${STORE} --json visibility`;
  const DEFAULT_BRANCH = `gh repo view ${STORE} --json defaultBranchRef`;
  const ENVIRONMENT = `gh api repos/${STORE}/environments/fabrik`;
  const RULES = `${ENVIRONMENT}/deployment-branch-policies?per_page=100`;
  const ENVIRONMENT_SECRETS = `gh secret list --env fabrik --repo ${STORE} --json name`;
  const EMPTY = { code: 1, stderr: "gh: This repository is empty. (HTTP 404)\n" };
  const NOT_FOUND = { code: 1, stderr: "gh: Not Found (HTTP 404)\n" };

  /** The store as Setup gathers it beside acme/clinic, and each line it asked gh that names the store. */
  async function gathered(script: Record<string, Answer>) {
    const dir = await tempDir("setup-gather");
    const commands = fakeCommands({ ...aReadyOperator(dir), ...script });
    const state = await gatherState(commands.run, dir, REPO, [], HEAD_SHA);
    return { store: state.store, asked: commands.calls.map((call) => call.line).filter((line) => line.includes(STORE)) };
  }

  /** A private store with one commit on this default branch, a repo-level secret, and whatever else the script says. */
  const aStore = (defaultBranch: string, script: Record<string, Answer> = {}): Record<string, Answer> => ({
    [VIEW]: json({ visibility: "PRIVATE" }),
    [DEFAULT_BRANCH]: json({ defaultBranchRef: { name: defaultBranch } }),
    [`gh api repos/${STORE}/contents/.github/workflows/weekly-summary.yml`]: NOT_FOUND,
    [`gh api repos/${STORE}/contents/.github/dependabot.yml`]: NOT_FOUND,
    [`gh secret list --repo ${STORE} --json name`]: json([{ name: "FABRIK_OP_PUSH_TOKEN" }]),
    [ENVIRONMENT]: NOT_FOUND,
    ...script,
  });

  it("reads its default branch's name, whatever the Product repo's is, and its fabrik environment, telling gh secret the repo", async () => {
    const { store, asked } = await gathered(
      aStore("trunk", {
        [ENVIRONMENT]: json({ id: 7, name: "fabrik", deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }),
        [RULES]: json({ total_count: 1, branch_policies: [{ id: 41, name: "trunk", type: "branch" }] }),
        [ENVIRONMENT_SECRETS]: json([{ name: "FABRIK_OP_PUSH_TOKEN" }, { name: "ANOTHER" }]),
      }),
    );

    expect(store.defaultBranch).toBe("trunk");
    expect(store.environment).toEqual({ branches: "selected", rules: [{ id: 41, name: "trunk", type: "branch" }], secrets: ["FABRIK_OP_PUSH_TOKEN", "ANOTHER"] });
    expect(asked).toEqual(expect.arrayContaining([DEFAULT_BRANCH, ENVIRONMENT, RULES, ENVIRONMENT_SECRETS]));
  });

  it("keeps the store's repo-level secrets apart from its environment's, and gives no environment for a store that has none", async () => {
    const { store, asked } = await gathered(aStore("main"));

    expect(store).toMatchObject({ exists: true, private: true, defaultBranch: "main", secrets: ["FABRIK_OP_PUSH_TOKEN"], environment: null });
    expect(asked).not.toContain(ENVIRONMENT_SECRETS);
  });

  it.each<[string, unknown]>([
    ["an empty name, as gh prints it", { defaultBranchRef: { name: "" } }],
    ["none", { defaultBranchRef: null }],
  ])("gives no default branch for a store with no commit yet, whose default branch GitHub answers as %s", async (_, answer) => {
    const { store } = await gathered(
      aStore("", {
        [DEFAULT_BRANCH]: json(answer),
        [`gh api repos/${STORE}/contents/.github/workflows/weekly-summary.yml`]: EMPTY,
        [`gh api repos/${STORE}/contents/.github/dependabot.yml`]: EMPTY,
      }),
    );

    expect(store).toMatchObject({ exists: true, defaultBranch: null, environment: null });
  });

  it("reads nothing more of a store that doesn't exist: no default branch, no environment", async () => {
    const { store, asked } = await gathered({ [VIEW]: { code: 1, stderr: "GraphQL: Could not resolve to a Repository" } });

    expect(store).toEqual({ exists: false, private: false, defaultBranch: null, files: {}, secrets: [], environment: null });
    expect(asked).toEqual([VIEW]);
  });
});
