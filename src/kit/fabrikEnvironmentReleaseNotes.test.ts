// The notes for the `fabrik` environment's part of the major that carries the
// Kit's Operator sessions (#915) are drafted ahead, beside the others (#935).
// While they are a draft they must say what the code does: the environment's
// name, the hand-off's job and inputs, the accounts' names and the report's
// heading each as the code holds them, and every name they give one the code
// holds under that name. Once the release ships they are a record, listed in
// RELEASED_NOTES, and keep the words of their day.
import { readFileSync } from "node:fs";
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
import { apply } from "../setup/apply.ts";
import type { Run } from "../setup/exec.ts";
import { appliedLines, closingLines, prBody, reportSection } from "../setup/finish.ts";
import { readEnvironmentPolicy } from "../setup/gather.ts";
import { loadSetupKit, type SetupKit } from "../setup/kit.ts";
import { type OneRunSteps, runOnce } from "../setup/oneRun.ts";
import { type EnvironmentPolicy, type EnvironmentState, environmentHeld, planSetup, type RunStoreState, type SetupAction } from "../setup/plan.ts";
import { pinCaller, scheduleIn, STORE_CALLER_PATH } from "../setup/shims.ts";
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
    expect(opening).toMatch(/^These are the notes of this part of the major that carries the Kit's Operator sessions \(/);
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
      const tokens = bullet(changed, "The three tokens are in the environment, under new service accounts");
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
      const deleted = bullet(changed, "The repo-level tokens are deleted once the default branch's Kit names the environment");
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
  });
});
