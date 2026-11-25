// The notes for the `fabrik` environment's part of the major that carries the
// Kit's Operator sessions (#915) are drafted ahead, beside the others (#935).
// While they are a draft they must say what the code does: the environment's
// name, the hand-off's job and inputs, the accounts' names and the report's
// heading each as the code holds them, and every name they give one the code
// holds under that name. Once the release ships they are a record, listed in
// RELEASED_NOTES, and keep the words of their day.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { aCleanProduct, afterApplying } from "../__fixtures__/productState.ts";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import { fakeCommands } from "../__fixtures__/setupCommands.ts";
import { anEnvironment, aWorld, environmentOf, worldScript } from "../__fixtures__/setupWorld.ts";
import type { ReadClient } from "../github/client.ts";
import { handOffFrom } from "../github/events.ts";
import { readHandOff } from "../github/handOff.ts";
import { EXPORT_CALLS, EXPORT_SHAPES } from "../read/exports.fixture.ts";
import { apply } from "../setup/apply.ts";
import type { Run } from "../setup/exec.ts";
import { appliedLines, closingLines, prBody, reportSection } from "../setup/finish.ts";
import { readEnvironmentPolicy } from "../setup/gather.ts";
import { loadSetupKit, type SetupKit } from "../setup/kit.ts";
import { type OneRunSteps, runOnce } from "../setup/oneRun.ts";
import { type EnvironmentPolicy, type EnvironmentState, environmentHeld, planSetup, type RunStoreState, type SetupAction } from "../setup/plan.ts";
import { CALLER_PATH, pinCaller, scheduleIn, STORE_CALLER_PATH } from "../setup/shims.ts";
import { KIT_ENVIRONMENT } from "./environment.ts";
import { RUN_STORE, RUN_STORE_REPO } from "./runStore.ts";

const NOTES = "docs/release-notes/fabrik-environment.md";
const read = (path: string): string => readFileSync(join(KIT, path), "utf8");

/** The Kit's three tokens, by the names of their secrets, in the order Setup makes their accounts. */
const TOKENS = ["FABRIK_OP_AGENT_TOKEN", "FABRIK_OP_IMPLEMENT_TOKEN", "FABRIK_OP_PUSH_TOKEN"] as const;

/** The Product repo the Setup tests set up, and the Operator's answer that sets the store up. */
const PRODUCT = { owner: "acme", name: "clinic", defaultBranch: "main", inOrganization: false };
const OPERATOR = { timeZone: "Australia/Sydney" };

/** The notes' section under `## heading`, up to the next one. */
const section = (notes: string, heading: string): string => notes.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";

/** The bullet of `text` that opens with `lead` in bold. */
const bullet = (text: string, lead: string): string => text.split("\n").find((line) => line.startsWith(`- **${lead}`)) ?? "";

/** The Spec, as the notes and the releasing guide link it. */
const SPEC = "[Spec: The Kit's tokens in the `fabrik` environment, which only the default branch may use](https://github.com/jrey8343/fabrik/issues/915)";

/** Everything `notes` write as code, each once. */
const written = (notes: string): string[] => [...new Set([...notes.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""))];

const LOOP = ".github/workflows/loop.yml";
const CALLER_TEMPLATE = "templates/fabrik.yml";

/** What the notes write as code that is no file under `src/`: the file that holds it, and the text it holds it as. */
const HELD_IN: Readonly<Record<string, readonly [file: string, text: string]>> = {
  fabrik: ["src/kit/environment.ts", `export const KIT_ENVIRONMENT = "fabrik";`],
  KIT_ENVIRONMENT: ["src/kit/environment.ts", "export const KIT_ENVIRONMENT ="],
  "deployment: false": [LOOP, "    environment:\n      name: fabrik\n      deployment: false\n"],
  "loop.yml": [LOOP, "\nname: "],
  "schedule.yml": [".github/workflows/schedule.yml", "\nname: "],
  "weekly-summary.yml": [".github/workflows/weekly-summary.yml", "\nname: "],
  "tick-check.yml": [".github/workflows/tick-check.yml", "\nname: "],
  kit: [".github/workflows/schedule.yml", "\n  kit:\n"],
  "review-checks": [LOOP, "\n  review-checks:\n"],
  "rerun-checks": [LOOP, "\n  rerun-checks:\n"],
  "rerun-wait": [LOOP, "\n  rerun-wait:\n"],
  "review-hand-off": [LOOP, "\n  review-hand-off:\n"],
  "actions: write": [LOOP, "    permissions:\n      actions: write\n    steps:\n      - name: Start the caller workflow on the default branch\n"],
  "secrets:": [CALLER_TEMPLATE, "    secrets:\n      OP_AGENT_TOKEN: ${{ secrets.FABRIK_OP_AGENT_TOKEN }}\n"],
  FABRIK_OP_AGENT_TOKEN: [CALLER_TEMPLATE, "OP_AGENT_TOKEN: ${{ secrets.FABRIK_OP_AGENT_TOKEN }}"],
  FABRIK_OP_IMPLEMENT_TOKEN: [CALLER_TEMPLATE, "OP_IMPLEMENT_TOKEN: ${{ secrets.FABRIK_OP_IMPLEMENT_TOKEN }}"],
  FABRIK_OP_PUSH_TOKEN: [CALLER_TEMPLATE, "OP_PUSH_TOKEN: ${{ secrets.FABRIK_OP_PUSH_TOKEN }}"],
  pull_request_review: [CALLER_TEMPLATE, "\n  pull_request_review:\n    types: [submitted]\n"],
  pull_request_target: [CALLER_TEMPLATE, "\n  pull_request_target:\n"],
  workflow_dispatch: [CALLER_TEMPLATE, "\n  workflow_dispatch:\n    inputs:\n"],
  pull_request: [CALLER_TEMPLATE, "    inputs:\n      pull_request:\n"],
  review: [CALLER_TEMPLATE, "\n      review:\n        description: The review's id\n"],
  "Review on PR #<number>, handed off": [CALLER_TEMPLATE, "format('Review on PR #{0}, handed off', github.event.inputs.pull_request)"],
  operator: ["src/kit/config.ts", `file.nullableString("operator"`],
  production: ["src/kit/config.ts", `file.nullableObject("production")`],
  "fabrik-<owner>-<repo>-agent-env": ["src/setup/plan.ts", "const name = `fabrik-${state.repo.owner}-${state.repo.name}-${role}-env`;"],
  "-implement-env": ["src/setup/plan.ts", `{ role: "implement", vaults: [FABRIK_VAULT, sandbox], secret: "FABRIK_OP_IMPLEMENT_TOKEN" }`],
  "-push-env": ["src/setup/plan.ts", `{ role: "push", vaults: [FABRIK_APP_VAULT], secret: "FABRIK_OP_PUSH_TOKEN" }`],
  "-env": ["src/setup/plan.ts", "-${role}-env`"],
  "fabrik-<owner>-<repo>-agent": ["src/setup/plan.ts", "account: `fabrik-${state.repo.owner}-${state.repo.name}-${role}` }"],
  "-implement": ["src/setup/plan.ts", `{ role: "implement", vaults: [FABRIK_VAULT, sandbox], secret: "FABRIK_OP_IMPLEMENT_TOKEN" }`],
  "-push": ["src/setup/plan.ts", `{ role: "push", vaults: [FABRIK_APP_VAULT], secret: "FABRIK_OP_PUSH_TOKEN" }`],
  "fabrik-<owner>-fabrik-runs-push-env": ["src/setup/plan.ts", "name: `${STORE_OLD_ACCOUNT}-env`,"],
  "fabrik-<owner>-fabrik-runs-push": ["src/setup/plan.ts", "const STORE_OLD_ACCOUNT = `fabrik-${RUN_STORE.owner}-${RUN_STORE.name}-push`;"],
  "fabrik-runs": ["src/kit/runStore.ts", `name: "fabrik-runs"`],
  "gh secret set --env": ["src/setup/apply.ts", `"gh", ["secret", "set", action.secret, "--env", environment, ...where]`],
  "gh secret list --env": ["src/setup/gather.ts", `"gh", ["secret", "list", "--env", name, ...where, "--json", "name"]`],
  "gh secret delete": ["src/setup/apply.ts", `"gh", ["secret", "delete", action.secret,`],
  "--repo": ["src/setup/apply.ts", `["--repo", action.repo]`],
  op: ["src/setup/apply.ts", `"op", ["service-account", "create", action.name,`],
  origin: ["src/setup/gather.ts", "`defaultBranchTip` is the default branch's tip on origin"],
  "--no-time-zone": ["src/setup/args.ts", `flag === "--no-time-zone"`],
  "Setup's report:": ["src/setup/finish.ts", `"Setup's report:"`],
};

/** A job of a workflow, as much of it as these tests read. */
interface Job {
  readonly if?: string;
  readonly environment?: unknown;
  readonly permissions?: unknown;
  readonly steps?: readonly { readonly uses?: string }[];
  readonly secrets?: unknown;
}

/** The jobs of one of the Kit's workflows, or of a caller template, by their keys. */
const jobsOf = (path: string): Readonly<Record<string, Job>> => (parse(read(path)) as { jobs: Record<string, Job> }).jobs;

/** The Kit's four reusable workflows, and in each the jobs the notes say read no token, so name no environment. */
const READS_NO_TOKEN: Readonly<Record<string, readonly string[]>> = {
  "loop.yml": ["review-checks", "rerun-checks", "rerun-wait", "review-hand-off"],
  "schedule.yml": ["kit"],
  "weekly-summary.yml": ["kit"],
  "tick-check.yml": ["kit"],
};

/** A review as GitHub's REST API answers it: a Request changes on PR #45 of acme/shop, by `login`. */
const aReview = (login: string, state = "CHANGES_REQUESTED") => ({
  id: 123,
  node_id: "PRR_kwDO123",
  user: { login, type: "User" },
  body: "Use the parking copy.",
  state,
  pull_request_url: "https://api.github.com/repos/acme/shop/pulls/45",
});

/** A read-only GitHub that holds one review, 123 on PR #45 of acme/shop, and answers nothing else. */
const gitHubWith = (review: ReturnType<typeof aReview>): ReadClient => ({
  rest: (_method, path) => Promise.resolve(path === "/repos/acme/shop/pulls/45/reviews/123" ? review : null),
  graphql: () => Promise.reject(new Error("The hand-off's read makes no query")),
  fileText: () => Promise.reject(new Error("The hand-off's read reads no file")),
});

describe.skipIf(RELEASED_NOTES.has(NOTES))("The fabrik environment release notes, while drafted", () => {
  const notes = read(NOTES);
  const changed = section(notes, "What changed");

  it("open with their title, the major and the Spec they are a part of, and the paste line, in one paragraph", () => {
    const [title, blank, opening, after] = notes.split("\n");

    expect(title).toBe("# Release notes: the Kit's tokens in the `fabrik` environment");
    expect([blank, after]).toEqual(["", ""]);
    expect(opening).toMatch(/^These are the notes for this part of the major that carries the Kit's Operator sessions \(/);
    expect(opening).toContain(`the major that carries the Kit's Operator sessions (${SPEC})`);
    expect(opening?.endsWith("Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.")).toBe(true);
  });

  it("are linked from the releasing guide's one entry for the Operator sessions major, after the Console check's, with no entry of their own", () => {
    const drafted =
      read("docs/releasing.md")
        .split("\n")
        .find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`")) ?? "";
    const [, ...entries] = drafted.split("the Operator sessions major's are ");

    // One entry for the major, which holds this draft's link by its text. The later parts add theirs to the same entry, so nothing here says it is the last.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("[the Kit's tokens in the `fabrik` environment](release-notes/fabrik-environment.md)");
    expect(entries[0]?.startsWith("[the Console check](release-notes/console-check.md)")).toBe(true);
  });

  it("give the environment's name as the code holds it, and name as reading no token exactly the jobs that name no environment", () => {
    const jobs = bullet(changed, "Each Kit job that reads a token names the `fabrik` environment");

    expect(jobs).toContain("names the caller repo's `fabrik` environment, with `deployment: false`");
    expect(jobs).toContain("The name is one constant, `KIT_ENVIRONMENT`, `fabrik`, in `src/kit/environment.ts`");
    expect(KIT_ENVIRONMENT).toBe("fabrik");
    expect(jobs).toContain("the Kit's four reusable workflows, `loop.yml`, `schedule.yml`, `weekly-summary.yml` and `tick-check.yml`");
    expect(jobs).toContain("A job that reads no token names none: `loop.yml`'s `review-checks`, `rerun-checks`, `rerun-wait` and `review-hand-off`, and the `kit` job of each of the other three.");

    for (const [file, readsNoToken] of Object.entries(READS_NO_TOKEN)) {
      const jobsOfFile = Object.entries(jobsOf(`.github/workflows/${file}`));
      const namingNone = jobsOfFile.filter(([, job]) => job.environment === undefined).map(([name]) => name);
      expect(namingNone.toSorted(), file).toEqual(readsNoToken.toSorted());
      for (const [name, job] of jobsOfFile.filter(([name]) => !readsNoToken.includes(name))) expect(job.environment, `${file}'s ${name}`).toEqual({ name: KIT_ENVIRONMENT, deployment: false });
    }
  });

  it("say the caller workflow's three secrets lines keep their names, as the caller template holds them", () => {
    expect(bullet(changed, "Each Kit job that reads a token names the `fabrik` environment")).toContain("The tokens keep their names, and the caller workflow's three `secrets:` lines don't change");
    expect(jobsOf("templates/fabrik.yml")["loop"]?.secrets).toEqual({
      OP_AGENT_TOKEN: "${{ secrets.FABRIK_OP_AGENT_TOKEN }}",
      OP_IMPLEMENT_TOKEN: "${{ secrets.FABRIK_OP_IMPLEMENT_TOKEN }}",
      OP_PUSH_TOKEN: "${{ secrets.FABRIK_OP_PUSH_TOKEN }}",
    });
  });

  it("name the review's hand-off job, what it holds and the event it runs on, as loop.yml holds them", () => {
    const handOff = bullet(changed, "A pull request review's run reads no token and hands off");
    expect(handOff).toContain("On a `pull_request_review` event the Kit job is skipped, and with it every job that needs it");
    expect(handOff).toContain("the run runs one job alone, `review-hand-off`");
    expect(handOff).toContain("It holds `actions: write` and nothing else, names no environment, reads no secret and checks nothing out");

    const loop = jobsOf(".github/workflows/loop.yml");
    const job = loop["review-hand-off"];
    expect(job).toMatchObject({ if: "github.event_name == 'pull_request_review'", permissions: { actions: "write" } });
    expect(job).not.toHaveProperty("environment");
    expect(job?.steps?.filter((step) => step.uses !== undefined)).toEqual([]);
    expect(read(".github/workflows/loop.yml").split("\n  review-hand-off:\n")[1]?.split("\n\n")[0]).not.toMatch(/\bsecrets[.[]/);
    expect(loop["kit"]?.if).toBe("github.event_name != 'pull_request_review'");
  });

  it("name the caller workflow's new trigger, its two inputs and the run's name, as the caller template holds them", () => {
    const handOff = bullet(changed, "A pull request review's run reads no token and hands off");
    expect(handOff).toContain("The caller workflow gains that trigger, with two required string inputs, `pull_request`, the pull request's number, and `review`, the review's id");
    expect(handOff).toContain("the run it starts is named `Review on PR #<number>, handed off`");

    const template = parse(read("templates/fabrik.yml")) as { on: { workflow_dispatch: { inputs: Record<string, { required: boolean; type: string }> } }; "run-name": string };
    expect(Object.keys(template.on.workflow_dispatch.inputs)).toEqual(["pull_request", "review"]);
    for (const input of Object.values(template.on.workflow_dispatch.inputs)) expect(input).toMatchObject({ required: true, type: "string" });
    expect(template["run-name"]).toContain("github.event_name == 'workflow_dispatch' && format('Review on PR #{0}, handed off', github.event.inputs.pull_request)");
  });

  it("say what an input must be to make a hand-off, as the run reads its inputs", () => {
    expect(bullet(changed, "A pull request review's run reads no token and hands off")).toContain("Each input must be a positive whole number with no leading zero, or the run does nothing");

    const dispatched = (inputs: Record<string, unknown>) => handOffFrom("workflow_dispatch", { inputs });
    expect(dispatched({ pull_request: "45", review: "123" })).toEqual({ pullRequest: 45, review: 123 });
    for (const written of ["045", "0", "-45", "4.5", "45abc", " 45", ""]) {
      expect(dispatched({ pull_request: written, review: "123" }), JSON.stringify(written)).toBeNull();
      expect(dispatched({ pull_request: "45", review: written }), JSON.stringify(written)).toBeNull();
    }
    expect(dispatched({ pull_request: "45" })).toBeNull();
  });

  it("say the run a review hands off to acts only on a review of the Operator's that GitHub holds, so anyone else's Request changes gets no line", async () => {
    const handOff = bullet(changed, "A pull request review's run reads no token and hands off");
    expect(handOff).toContain("act only on a review that is there, on that pull request, submitted and not dismissed, and written by the Operator (Kit config's `operator`, or the repo's owner), whatever the case of the login");
    const requested = bullet(changed, "A Request-changes run uses the default branch's caller workflow and Kit config");
    expect(requested).toContain("A Request changes from anyone but the Operator now gets no line at all");
    expect(requested).toContain("That line is the one behaviour the move loses.");

    const repo = { owner: "acme", name: "shop" };
    const named = { pullRequest: 45, review: 123 };
    expect(await readHandOff(gitHubWith(aReview("Operator")), repo, named, "operator")).toMatchObject({ kind: "pull-request-changes-requested", pullRequest: 45 });
    // Nothing is planned for anyone else's, a person's included, so nothing is said on the pull request.
    expect(await readHandOff(gitHubWith(aReview("someone-else")), repo, named, "operator")).toBeNull();
    expect(await readHandOff(gitHubWith(aReview("operator", "DISMISSED")), repo, named, "operator")).toBeNull();
    expect(await readHandOff(gitHubWith(aReview("operator")), repo, { pullRequest: 46, review: 123 }, "operator")).toBeNull();
  });

  describe("on Setup", () => {
    let kit: SetupKit;
    beforeAll(async () => {
      kit = await loadSetupKit(KIT, "v9.0.0");
    });

    /** A fabrik environment held to this branch, with these secrets. */
    const heldTo = (branch: string, secrets: readonly string[] = []): EnvironmentState => ({ branches: "selected", rules: [{ id: 1, name: branch, type: "branch" }], secrets });
    /** The Product repo's caller workflow as Setup writes it at a release. */
    const callerAt = (release: string) => pinCaller(kit.templates.caller, release);
    /** The store's caller workflow as Setup writes it at a release, in the Operator's time zone. */
    const storeCallerAt = (release: string) => pinCaller(scheduleIn(kit.templates.storeCaller, OPERATOR.timeZone), release);
    /** A private store with commits on its default branch, `trunk`, and its caller as Setup wrote it at this release. */
    const aStore = (release: string, overrides: Partial<RunStoreState> = {}): RunStoreState => ({
      exists: true,
      private: true,
      defaultBranch: "trunk",
      files: { [STORE_CALLER_PATH]: storeCallerAt(release), ".github/dependabot.yml": kit.templates.dependabot },
      secrets: [],
      environment: null,
      ...overrides,
    });
    const accounts = (actions: readonly SetupAction[]) => actions.flatMap((action) => (action.kind === "create-service-account" ? [action] : []));
    const deletions = (actions: readonly SetupAction[]) => actions.flatMap((action) => (action.kind === "delete-repo-secret" ? [action] : []));
    /** What the notes write as an account's name, for acme/clinic and the store's owner: `fabrik-<owner>-<repo>-agent-env` whole, and a later one of the same list by its ending alone. */
    const accountNamed = (written: string, stem: string) => (written.startsWith("-") ? `${stem}${written}` : written.replace("fabrik-<owner>-<repo>", stem).replace("<owner>", RUN_STORE.owner));
    /** The names a bullet writes as code, in its order, that are an account's: those that end as these do. */
    const accountsIn = (text: string, ending: RegExp, stem = "fabrik-acme-clinic") => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "").filter((name) => ending.test(name)).map((name) => accountNamed(name, stem));

    it("say Setup's step for the environment goes first, what held means, and the order of its calls, as Setup plans and applies it", async () => {
      const hold = bullet(changed, "Setup makes the `fabrik` environment and holds it to the default branch");
      expect(hold).toContain("plans one step, first among the plan's steps");
      expect(hold).toContain('An environment is held when it is set to "Selected branches and tags" and its rules are exactly one, a branch rule naming the default branch');
      expect(hold).toContain("a PUT of the environment that sends only its branch policy; the rule naming the default branch added, if it isn't there; only then every other rule deleted; and the rules read back");
      expect(hold).toContain("Unless they read back as exactly the one rule, Setup stops and stores no token");

      expect(planSetup(aCleanProduct(), kit).actions[0]).toEqual({ kind: "hold-environment", environment: KIT_ENVIRONMENT, branch: "main", found: null });
      expect(planSetup(aCleanProduct({ environment: heldTo("main") }), kit).actions.map((action) => action.kind)).not.toContain("hold-environment");
      const main = { id: 1, name: "main", type: "branch" } as const;
      expect(environmentHeld({ branches: "selected", rules: [main] }, "main")).toBe(true);
      const notHeld: readonly (EnvironmentPolicy | null)[] = [
        null,
        { branches: "all", rules: [] },
        { branches: "protected", rules: [] },
        { branches: "selected", rules: [] },
        { branches: "selected", rules: [{ id: 2, name: "main", type: "tag" }] },
        { branches: "selected", rules: [main, { id: 3, name: "release", type: "branch" }] },
      ];
      for (const policy of notHeld) expect(environmentHeld(policy, "main"), JSON.stringify(policy)).toBe(false);

      // Applied over a world whose environment holds one other rule: the rule naming main is in before the other is out.
      const world = aWorld();
      anEnvironment(world, { rules: ["release"] });
      const [step] = planSetup(aCleanProduct({ environment: { branches: "selected", rules: [{ id: 1, name: "release", type: "branch" }], secrets: [] } }), kit).actions;
      await apply(fakeCommands(worldScript(world)).run, step!, "/clinic", PRODUCT);
      const changing = world.environmentCalls.flatMap((line) => /--method (PUT|POST|DELETE)/.exec(line)?.[1] ?? []);
      expect(changing).toEqual(["PUT", "POST", "DELETE"]);
      expect(world.environmentCalls.at(-1)).toMatch(/deployment-branch-policies/);
      expect(world.environmentCalls.at(-1)).not.toMatch(/--method/);
      expect(environmentOf(world)?.rules.map(({ name, type }) => ({ name, type }))).toEqual([{ name: "main", type: "branch" }]);
    });

    it("say there is no fallback when GitHub refuses the environment, with the plans the stop names, and that a refused read stops Setup with GitHub's answer", async () => {
      const hold = bullet(changed, "Setup makes the `fabrik` environment and holds it to the default branch");
      expect(hold).toContain("There is no fallback to repo-level secrets");
      expect(hold).toContain("GitHub Pro for a personal account's repo, or GitHub Team for an organization's");
      expect(hold).toContain("A read of the environment that GitHub refuses with anything but a 404 stops Setup too, with GitHub's answer in what it says");

      // What GitHub answers on a plan with no environments wasn't tried, so this answer is made up: Setup gives whatever it is.
      const world = aWorld();
      world.environmentRefusal = "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)";
      const commands = fakeCommands(worldScript(world));
      const [step] = planSetup(aCleanProduct(), kit).actions;
      await expect(apply(commands.run, step!, "/clinic", PRODUCT)).rejects.toThrow(
        `GitHub refused the fabrik environment on acme/clinic: ${world.environmentRefusal}. A private repo needs a GitHub plan with environments: GitHub Pro for a personal account's repo, or GitHub Team for an organization's. The Kit keeps no fallback to repo-level secrets, so Setup stopped before changing anything else.`,
      );
      expect(environmentOf(world)).toBeUndefined();

      const refused: Run = () => Promise.resolve({ code: 1, stdout: "", stderr: "gh: Resource not accessible by personal access token (HTTP 403)" });
      await expect(readEnvironmentPolicy(refused, "/clinic", "acme/clinic", KIT_ENVIRONMENT)).rejects.toThrow(
        "Reading the fabrik environment on acme/clinic failed: gh: Resource not accessible by personal access token (HTTP 403)",
      );
      const missing: Run = () => Promise.resolve({ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
      expect(await readEnvironmentPolicy(missing, "/clinic", "acme/clinic", KIT_ENVIRONMENT)).toBeNull();
    });

    it("name the three new accounts as Setup names them, each one's token a secret of the environment, stored on gh's stdin after a read of the rules", async () => {
      const tokens = bullet(changed, "The three tokens are in the `fabrik` environment, under new service accounts");
      expect(tokens).toContain("A token is missing when the `fabrik` environment lacks it, wherever else it sits");
      expect(tokens).toContain("`FABRIK_OP_AGENT_TOKEN`, `FABRIK_OP_IMPLEMENT_TOKEN` or `FABRIK_OP_PUSH_TOKEN`");
      expect(tokens).toContain("with `gh secret set --env`, on its stdin");
      expect(tokens).toContain("the step reads the environment's rules itself, whether or not this run changed the environment, and stops with no account made unless they are the one rule");

      // A repo on the Kit before the move: its three tokens at repo level, and no environment.
      const onTheKit = aCleanProduct({ secrets: [...TOKENS] });
      const made = accounts(planSetup(onTheKit, kit).actions);
      expect(accountsIn(tokens, /-(agent|implement|push)-env$/)).toEqual(["fabrik-acme-clinic-agent-env", "fabrik-acme-clinic-implement-env", "fabrik-acme-clinic-push-env"]);
      expect(made.map(({ name }) => name)).toEqual(accountsIn(tokens, /-(agent|implement|push)-env$/));
      expect(made.map(({ secret, environment }) => ({ secret, environment }))).toEqual(TOKENS.map((secret) => ({ secret, environment: KIT_ENVIRONMENT })));
      expect(accounts(planSetup(aCleanProduct({ secrets: [...TOKENS], environment: heldTo("main", TOKENS) }), kit).actions)).toEqual([]);

      // Applied to a held environment, the token goes to gh on its stdin and into the environment, never to a repo-level secret.
      const world = aWorld();
      anEnvironment(world, { rules: ["main"] });
      const commands = fakeCommands(worldScript(world));
      await apply(commands.run, made[0]!, "/clinic", PRODUCT);
      const stored = commands.calls.find(({ line }) => line.startsWith("gh secret set"));
      expect(stored?.line).toBe("gh secret set FABRIK_OP_AGENT_TOKEN --env fabrik");
      expect(stored?.input).toEqual(expect.stringMatching(/\S/));
      expect(commands.calls.findIndex(({ line }) => line.includes("deployment-branch-policies"))).toBeLessThan(commands.calls.findIndex(({ line }) => line.startsWith("op service-account create")));
      expect([...(environmentOf(world)?.secrets ?? [])]).toEqual(["FABRIK_OP_AGENT_TOKEN"]);
      expect(world.secrets.has("FABRIK_OP_AGENT_TOKEN")).toBe(false);

      // Applied to one that isn't held, no account is made.
      const open = aWorld();
      anEnvironment(open, { policy: "selected" });
      const refused = fakeCommands(worldScript(open));
      await expect(apply(refused.run, made[0]!, "/clinic", PRODUCT)).rejects.toThrow("The fabrik environment on acme/clinic isn't held to main alone, so Setup stored no token in it. Run setup again.");
      expect(refused.calls.filter(({ command }) => command === "op")).toEqual([]);
    });

    it("say when Setup deletes the repo-level tokens, name the old accounts as Setup names them, and say the note is said under the plan and again in the run's last lines", async () => {
      const deleted = bullet(changed, "The repo-level tokens are deleted once the default branch's Kit names the `fabrik` environment");
      expect(deleted).toContain("Once it pins one release of Setup's own major or a later one");
      expect(deleted).toContain("after every new account");
      expect(deleted).toContain("by `gh secret delete`, and never a repo-level secret of any other name");
      expect(deleted).toContain("under the plan and again in the run's last lines");
      expect(deleted).toContain("On any other run where one sits at repo level, Setup deletes nothing and says they stay until the setup PR is merged and Setup runs again");

      const repoLevel = { secrets: [...TOKENS, "STRIPE_KEY"], environment: heldTo("main", TOKENS) };
      const old = accountsIn(deleted, /-(agent|implement|push)$/);
      expect(old).toEqual(["fabrik-acme-clinic-agent", "fabrik-acme-clinic-implement", "fabrik-acme-clinic-push"]);
      const OLD_ACCOUNTS = `Once the repo-level secrets are deleted, delete the old service accounts ${old[0]}, ${old[1]} and ${old[2]} on 1Password's site. Their tokens still work until you do, though they sit nowhere on GitHub.`;

      // The default branch still pins an earlier major: nothing is deleted, and the note says they stay.
      const before = planSetup(aCleanProduct({ ...repoLevel, defaultBranchCaller: callerAt("v8.4.1") }), kit);
      expect(deletions(before.actions)).toEqual([]);
      expect(before.notes.filter((note) => note.includes("stay for now"))).toHaveLength(1);
      expect(before.notes).not.toContain(OLD_ACCOUNTS);

      // It pins Setup's major, or a later one: the Kit's three go, and no other.
      for (const release of ["v9.0.0", "v9.2.1", "v10.0.0"]) {
        const plan = planSetup(aCleanProduct({ ...repoLevel, defaultBranchCaller: callerAt(release) }), kit);
        expect(deletions(plan.actions).map(({ secret, account }) => ({ secret, account })), release).toEqual(TOKENS.map((secret, at) => ({ secret, account: old[at] })));
        expect(plan.notes, release).toContain(OLD_ACCOUNTS);
      }
      const world = aWorld();
      for (const secret of [...TOKENS, "STRIPE_KEY"]) world.secrets.add(secret);
      const commands = fakeCommands(worldScript(world));
      const moved = aCleanProduct({ ...repoLevel, defaultBranchCaller: callerAt("v9.0.0") });
      const plan = planSetup(moved, kit);
      for (const step of deletions(plan.actions)) await apply(commands.run, step, "/clinic", PRODUCT);
      expect(commands.calls.map(({ line }) => line)).toEqual(TOKENS.map((secret) => `gh secret delete ${secret}`));
      expect([...world.secrets]).toEqual(["STRIPE_KEY"]);

      // The plan made after the wizard no longer finds the secrets, and the run's last lines name the old accounts all the same.
      const after = planSetup(afterApplying(moved, plan), kit);
      expect(after.notes).not.toContain(OLD_ACCOUNTS);
      const steps: OneRunSteps = {
        confirm: () => Promise.resolve(true),
        switchToSetupBranch: () => Promise.resolve(),
        apply: () => Promise.resolve(),
        wizard: () => Promise.resolve(),
        afterWizard: () => Promise.resolve({ plan: after, readiness: { appInstalled: true, appKeyStored: true, tokensLacking: [] } }),
        commit: () => Promise.resolve(false),
        somethingToPublish: () => Promise.resolve(false),
        leaveSetupBranch: () => Promise.resolve(),
        push: () => Promise.resolve(),
        publish: (summary) => Promise.resolve({ url: "https://github.com/acme/clinic/pull/7", summary }),
      };
      const ran = await runOnce({ plan, repo: "acme/clinic" }, steps);
      expect(ran.kind === "applied" && appliedLines("main", ran.summary)).toContain(`- ${OLD_ACCOUNTS}`);
    });

    it("say the store's token moves the same way, on a run where the Operator's time zone is answered, under the account names Setup gives", () => {
      const store = bullet(changed, "`fabrik-runs`'s token moves the same way");
      expect(store).toContain("On a run where the Operator's time zone is answered");
      expect(store).toContain("held to the store's own default branch, right after the Product repo's own");
      expect(store).toContain("only on a run that found the store's caller workflow already pinning Setup's major or a later one, never on the run that writes that caller");
      expect(store).toContain("With `--no-time-zone` nothing of the store is planned");
      expect(read("src/setup/args.ts")).toContain(`flag === "--no-time-zone"`);
      expect(accountsIn(store, /-push-env$/)).toEqual(["fabrik-jrey8343-fabrik-runs-push-env"]);
      expect(accountsIn(store, /-push$/)).toEqual(["fabrik-jrey8343-fabrik-runs-push"]);

      const ofTheStore = (actions: readonly SetupAction[]) => actions.filter((action) => "repo" in action && action.repo === RUN_STORE_REPO);
      const setUp = afterApplying(aCleanProduct(), planSetup(aCleanProduct(), kit, OPERATOR));

      // The store on an earlier major, its token at repo level, beside a Product repo not yet moved: its environment is the plan's second step.
      const onTheKit = aStore("v8.4.1", { secrets: ["FABRIK_OP_PUSH_TOKEN"] });
      const first = planSetup(aCleanProduct({ store: onTheKit }), kit, OPERATOR);
      expect(first.actions.slice(0, 2)).toEqual([
        { kind: "hold-environment", environment: KIT_ENVIRONMENT, branch: "main", found: null },
        { kind: "hold-environment", environment: KIT_ENVIRONMENT, branch: "trunk", found: null, repo: RUN_STORE_REPO },
      ]);
      expect(accounts(ofTheStore(first.actions)).map(({ name, secret, environment }) => ({ name, secret, environment }))).toEqual([
        { name: accountsIn(store, /-push-env$/)[0], secret: "FABRIK_OP_PUSH_TOKEN", environment: KIT_ENVIRONMENT },
      ]);
      expect(deletions(first.actions)).toEqual([]);
      expect(first.notes.filter((note) => note.startsWith(`${RUN_STORE_REPO}: The repo-level Actions secret FABRIK_OP_PUSH_TOKEN stays for now`))).toHaveLength(1);

      // The next run finds the store's caller at Setup's release: the repo-level secret goes, and the old account is named.
      const moved = aStore("v9.0.0", { secrets: ["FABRIK_OP_PUSH_TOKEN"], environment: heldTo("trunk", ["FABRIK_OP_PUSH_TOKEN"]) });
      const second = planSetup({ ...setUp, store: moved }, kit, OPERATOR);
      expect(ofTheStore(second.actions)).toEqual([
        { kind: "delete-repo-secret", secret: "FABRIK_OP_PUSH_TOKEN", account: accountsIn(store, /-push$/)[0], environment: KIT_ENVIRONMENT, branch: "trunk", repo: RUN_STORE_REPO },
      ]);
      expect(second.notes.filter((note) => note.startsWith(`${RUN_STORE_REPO}: Once the repo-level secret is deleted, delete the old service account ${accountsIn(store, /-push$/)[0]} on 1Password's site.`))).toHaveLength(1);

      // With no time zone answered, nothing of the store is planned and nothing said of it.
      const unanswered = planSetup({ ...setUp, store: onTheKit }, kit);
      expect(ofTheStore(unanswered.actions)).toEqual([]);
      expect(unanswered.notes.filter((note) => note.includes(RUN_STORE_REPO))).toEqual([]);
    });

    it("give the report's heading and lines as Setup says them, under the plan and in the last lines, and never in the setup PR", () => {
      const report = bullet(changed, "Setup's report");
      expect(report).toContain("headed `Setup's report:`");
      expect(report).toContain("said on every run under the plan, after its notes, and again in the run's last lines, and never in the setup PR");
      expect(report).toContain("a credential that can reach production belongs in an environment held to the default branch alone, or in a role taken by OIDC whose trust names that environment and not the whole repo, and only test and preview credentials sit at repo level");
      expect(report).toContain("Setup reports and never blocks");

      expect(reportSection(["A line."])).toEqual(["", "Setup's report:", "- A line."]);
      const own = planSetup(aCleanProduct({ secrets: [...TOKENS, "STRIPE_KEY", "ALGOLIA_KEY"], production: { name: "production", policy: { branches: "all", rules: [] } } }), kit);
      expect(own.report).toEqual([
        "The repo-level Actions secret ALGOLIA_KEY can be read by a workflow run on any branch.",
        "The repo-level Actions secret STRIPE_KEY can be read by a workflow run on any branch.",
        "A credential that can reach production belongs in an environment held to main alone, or in a role taken by OIDC whose trust names that environment and not the whole repo. Only test and preview credentials sit at repo level.",
        "Production's environment, production, isn't held to main alone (every branch), so a run on another ref that names it is given its secrets.",
      ]);
      expect(planSetup(aCleanProduct({ secrets: [...TOKENS] }), kit).report).toEqual(["This repo holds no repo-level Actions secret of its own."]);
      // The report changes no step and no note.
      const { report: _, ...planned } = own;
      const { report: __, ...unreported } = planSetup(aCleanProduct({ secrets: [...TOKENS] }), kit);
      expect(planned).toEqual(unreported);

      const summary = { done: [], notes: [], blockers: [], report: own.report };
      for (const line of own.report) {
        expect(closingLines({ release: "v9.0.0", defaultBranch: "main", url: "https://github.com/acme/clinic/pull/7", summary })).toContain(`- ${line}`);
        expect(appliedLines("main", summary)).toContain(`- ${line}`);
        expect(prBody({ release: "v9.0.0", defaultBranch: "main", summary })).not.toContain(line);
      }
    });

    it("give a repo's move as four steps in order, which Setup's two runs with the setup PR merged between them make", () => {
      const upgrading = section(notes, "Upgrading");
      const steps = upgrading.split("\n").filter((line) => /^\d\. /.test(line));
      expect(steps.map((line) => /^\d\. \*\*[^*]+\*\*/.exec(line)?.[0])).toEqual([
        "1. **Run Setup at the major, naming it.**",
        "2. **Merge the setup PR.**",
        "3. **Run Setup again.**",
        "4. **Delete the three old service accounts on 1Password's site**",
      ]);
      expect(upgrading).toContain("in this order, the Pilot first");
      expect(steps[0]).toContain("It deletes nothing, and says the repo-level tokens stay");
      expect(steps[2]).toContain("deletes the three repo-level tokens and names the three old service accounts");
      expect(steps[3]).toContain("the repo has six accounts against 1Password's limit of 100");

      // A repo on an earlier major, its three tokens at repo level. The first run makes the environment and the accounts, writes the caller, and deletes nothing.
      const earlier = callerAt("v8.4.1");
      const onTheKit = aCleanProduct({ files: { [CALLER_PATH]: earlier }, defaultBranchCaller: earlier, secrets: [...TOKENS] });
      const first = planSetup(onTheKit, kit);
      expect(first.actions[0]?.kind).toBe("hold-environment");
      expect(accounts(first.actions)).toHaveLength(3);
      expect(deletions(first.actions)).toEqual([]);
      const setupBranch = afterApplying(onTheKit, first);
      expect(setupBranch.files[CALLER_PATH]).toBe(callerAt("v9.0.0"));
      expect(setupBranch.files[CALLER_PATH]).toContain("\n  workflow_dispatch:\n");
      // Run again before the merge, it still deletes nothing.
      expect(planSetup(setupBranch, kit).actions).toEqual([]);

      // The setup PR merged, the second run deletes the three and does nothing else, and a third finds nothing to do.
      const merged = { ...setupBranch, defaultBranchCaller: callerAt("v9.0.0") };
      const second = planSetup(merged, kit);
      expect(second.actions.map(({ kind }) => kind)).toEqual(["delete-repo-secret", "delete-repo-secret", "delete-repo-secret"]);
      const moved = afterApplying(merged, second);
      expect(moved.secrets).toEqual([]);
      expect([...(moved.environment?.secrets ?? [])].toSorted()).toEqual([...TOKENS]);
      expect(planSetup(moved, kit).actions).toEqual([]);
      expect(planSetup(moved, kit).notes.filter((note) => /repo-level|service account/.test(note))).toEqual([]);
    });

    it("say the plan a private repo needs, the store's included, and that the store moves on the same two runs", () => {
      const upgrading = section(notes, "Upgrading");
      const plan = bullet(upgrading, "A private repo needs a GitHub plan with environments, or Setup stops");
      expect(plan).toContain("GitHub Pro for a personal account's repo, or GitHub Team for an organization's");
      expect(plan).toContain("`fabrik-runs` is private, so the store's own `fabrik` environment needs the plan too");
      const store = bullet(upgrading, "The store moves on the same two runs");
      expect(store).toContain("where the Operator's time zone is answered");
      expect(store).toContain("with no pull request to merge");
      expect(store).toContain("its old push account, which is deleted on 1Password's site the same way");

      // Setup makes the store private, and changes nothing in one that is public.
      const made = planSetup(aCleanProduct(), kit, OPERATOR).actions.find((action) => action.kind === "create-run-store");
      expect(made).toMatchObject({ repo: RUN_STORE_REPO, private: true });
      const set = afterApplying(aCleanProduct(), planSetup(aCleanProduct(), kit, OPERATOR));
      expect(planSetup({ ...set, store: aStore("v8.4.1", { private: false, secrets: ["FABRIK_OP_PUSH_TOKEN"] }) }, kit, OPERATOR).actions).toEqual([]);
    });
  });

  it("have each section the Ticket asks for, in its order, and no section to turn it on", () => {
    const headings = notes.split("\n").filter((line) => line.startsWith("## "));

    expect(headings).toEqual(["Release-note line", "What changed", "Why a major", "Upgrading", "What the Console needs", "Not covered"].map((heading) => `## ${heading}`));
    expect(notes).not.toContain("To turn it on");
  });

  it("say the release is a major, and why, in the releasing guide's terms, with nothing the read library exports changed", () => {
    const why = section(notes, "Why a major");
    expect(why).toContain(`The release is one major with the four other parts of the Kit's Operator sessions ([How are the Specs cut, and who builds them?](https://github.com/jrey8343/fabrik/issues/874))`);
    expect(why).toContain("[Choosing the version](../releasing.md#choosing-the-version)");
    expect(why).toContain("the caller workflow gains a trigger, `workflow_dispatch`, which is a changed shim");
    expect(why).toContain("the tokens' new place is a new Operator setup step that the Loop can't run without");
    expect(why).toContain("Nothing the read library exports changes");
    // The guide's own terms, which the section answers to.
    const guide = read("docs/releasing.md");
    expect(guide).toContain("a changed shim (the caller workflow's shape, the session hook entry, the `.gitignore` lines or the Dependabot config)");
    expect(guide).toContain("or a new Operator setup step, such as a new secret or App permission, that the Loop can't run without");
    // No name the notes write as code is an export of the read library: the part adds none and renames none.
    const exported = [...Object.keys(EXPORT_CALLS), ...Object.keys(EXPORT_SHAPES)];
    expect(written(notes).filter((name) => exported.includes(name))).toEqual([]);
  });

  it("say the Console's line is a guess until the release's check of the Console, whose run replaces it", () => {
    const console = section(notes, "What the Console needs");
    expect(console).toContain("This part changes nothing the Console reads");
    expect(console).toContain("This line is a guess until the release is checked against the Console (step 4 of [releasing.md](../releasing.md)), and that run's answer replaces it.");
    expect(read("docs/releasing.md")).toContain("A line about the Console in a draft in `docs/release-notes/` was written when the part was built, so it is a guess until this run.");
  });

  it("name what they don't cover: #847, whose fix rides this major if it changes the caller workflow, Dependabot's runs, and a cloud account's trust policy", () => {
    const uncovered = section(notes, "Not covered");
    const targets = bullet(uncovered, "A public Product repo's `pull_request_target` runs from 2 December 2026");
    expect(targets).toContain("([#847](https://github.com/jrey8343/fabrik/issues/847))");
    expect(targets).toContain("Its fix rides this major if it changes the caller workflow");
    expect(bullet(uncovered, "Whether Dependabot's runs are given an environment's secrets")).toContain("wasn't looked into");
    expect(bullet(uncovered, "A cloud account's trust policy")).toContain("is the Operator's to check in each repo");
  });

  it("say what was seen on GitHub and what was tested only over fixtures, and call nothing of Setup's verified against GitHub", () => {
    const tried = bullet(section(notes, "Not covered"), "Tried on GitHub only in part.");
    expect(tried).toContain("([Try the Kit's tokens in an environment held to the default branch](https://github.com/jrey8343/fabrik/issues/846))");
    expect(tried).toContain("were tested over fixtures and not run against GitHub");
    for (const untried of ["`gh secret set --env`, `gh secret list --env` and `gh secret delete` with `--repo`", "a private repo whose GitHub plan has no environments", "an environment's reviewers and wait timer", "an environment on `fabrik-runs`", "a renamed default branch", "a fork's pull request"]) {
      expect(tried, untried).toContain(untried);
    }
    expect(notes).not.toMatch(/verified/i);
  });

  describe("name only what the Spec's Tickets shipped, by the name the code holds it under", () => {
    it("link each of the nine Tickets before this one", () => {
      for (const ticket of [926, 927, 928, 929, 930, 931, 932, 933, 934]) expect(notes, `#${ticket}`).toContain(`[#${ticket}](https://github.com/jrey8343/fabrik/issues/${ticket})`);
    });

    it("write as code only a file that exists or a name the code holds", () => {
      const held = (name: string) => {
        const [file, text] = HELD_IN[name] ?? [];
        return file !== undefined && text !== undefined && read(file).includes(text);
      };
      const unknown = written(notes).filter((name) => !(name.startsWith("src/") && existsSync(join(KIT, name))) && !held(name));

      expect(unknown).toEqual([]);
    });

    it("say the `fabrik` environment in full, and the environment alone only in a paragraph or bullet that has already named it so", () => {
      for (const line of notes.split("\n")) {
        const alone = line.search(/\bthe environment\b/i);
        if (alone !== -1) expect(line.slice(0, alone), line.slice(0, 80)).toContain("`fabrik` environment");
      }
    });

    it("name no person and no private repo", () => {
      expect(notes).not.toMatch(/gradually|jrey(?!8343\/fabrik)/i);
    });
  });
});
