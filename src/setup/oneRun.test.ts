// One setup run's order and its merge rule, with every step a fake that logs
// when it ran: the yes, the setup branch, apply, the wizard, reading again,
// then commit, push and the setup PR.
import { describe, expect, it } from "vitest";
import { aCleanProduct } from "../__fixtures__/productState.ts";
import { mergeBlockers, type OneRunSteps, type Readiness, readinessOf, runOnce, wizardGaps } from "./oneRun.ts";
import type { ProductState, SetupAction, SetupPlan } from "./plan.ts";

const READY: Readiness = { appInstalled: true, appKeyStored: true, claudeTokenStored: true };

const WORKFLOW: SetupAction = { kind: "write-file", path: ".github/workflows/fabrik.yml", content: "on: push\n", why: "the caller workflow" };
const LABEL: SetupAction = { kind: "create-label", name: "needs-triage", color: "ededed", description: "Waiting for Triage" };
const SUBSCRIPTIONS: SetupAction = { kind: "write-file", path: ".fabrik/config.json", content: "{}\n", why: "the subscriptions line" };

function plan(actions: SetupAction[], notes: string[] = []): SetupPlan {
  return { actions, notes };
}

function fakeSteps(options: { yes?: boolean; after?: SetupPlan; readiness?: Readiness; commits?: boolean; onTheBranch?: boolean } = {}) {
  const log: string[] = [];
  const steps: OneRunSteps = {
    confirm: async () => {
      log.push("confirm");
      return options.yes ?? true;
    },
    switchToSetupBranch: async () => void log.push("switch"),
    apply: async (actions) => void log.push(`apply ${actions.map((action) => action.kind).join(",")}`),
    wizard: async () => void log.push("wizard"),
    afterWizard: async () => {
      log.push("read again");
      return { plan: options.after ?? plan([]), readiness: options.readiness ?? READY };
    },
    commit: async () => {
      log.push("commit");
      return options.commits ?? true;
    },
    somethingToPublish: async () => {
      log.push("anything to publish?");
      return options.onTheBranch ?? false;
    },
    leaveSetupBranch: async () => void log.push("leave"),
    push: async () => void log.push("push"),
    publish: async (summary) => {
      log.push("publish");
      return { url: "https://github.com/acme/clinic/pull/7", summary };
    },
  };
  return { steps, log };
}

describe("One setup run", () => {
  it("applies the plan on the setup branch, walks the wizard, reads again, then commits, pushes and opens the PR", async () => {
    const { steps, log } = fakeSteps();

    await runOnce({ plan: plan([WORKFLOW, LABEL]), repo: "acme/clinic" }, steps);

    expect(log).toEqual(["confirm", "switch", "apply write-file,create-label", "wizard", "read again", "commit", "push", "publish"]);
  });

  it("changes nothing when the Operator says no to the plan", async () => {
    const { steps, log } = fakeSteps({ yes: false });

    const result = await runOnce({ plan: plan([WORKFLOW]), repo: "acme/clinic" }, steps);

    expect(result).toEqual({ kind: "declined" });
    expect(log).toEqual(["confirm"]);
  });

  it("writes the files the plan finds missing after the wizard before it commits, and lists them as done", async () => {
    const { steps, log } = fakeSteps({ after: plan([SUBSCRIPTIONS]) });

    const result = await runOnce({ plan: plan([WORKFLOW]), repo: "acme/clinic" }, steps);

    expect(log.slice(log.indexOf("read again"))).toEqual(["read again", "apply write-file", "commit", "push", "publish"]);
    expect(result.kind === "done" && result.summary.done).toEqual([
      "write .github/workflows/fabrik.yml (the caller workflow)",
      "write .fabrik/config.json (the subscriptions line)",
    ]);
  });

  it("lists what an earlier run on the setup branch applied before it stopped, then this run's steps, each once", async () => {
    const { steps } = fakeSteps();
    const earlierDone = ["write .github/workflows/fabrik.yml (the caller workflow)", "create the label needs-info"];

    const result = await runOnce({ plan: plan([LABEL]), repo: "acme/clinic", earlierDone }, steps);

    expect(result.kind === "done" && result.summary.done).toEqual([...earlierDone, "create the label needs-triage"]);
  });

  it("lists a step an earlier run on the setup branch did, and this run did again, where this run did it", async () => {
    const { steps } = fakeSteps();
    const earlierDone = ["create the label needs-triage", "create the label needs-info"];

    const result = await runOnce({ plan: plan([LABEL]), repo: "acme/clinic", earlierDone }, steps);

    expect(result.kind === "done" && result.summary.done).toEqual(["create the label needs-info", "create the label needs-triage"]);
  });

  it("commits the files this run and an earlier one on the setup branch wrote, and no others", async () => {
    const { steps } = fakeSteps({ after: plan([SUBSCRIPTIONS]) });
    const committed: (readonly string[])[] = [];
    const earlierDone = ["write AGENTS.md (point the skills at docs/agents/*)", "create the label needs-info"];

    await runOnce(
      { plan: plan([WORKFLOW, LABEL]), repo: "acme/clinic", earlierDone },
      { ...steps, commit: async (paths) => (committed.push(paths), true) },
    );

    expect(committed).toEqual([["AGENTS.md", ".github/workflows/fabrik.yml", ".fabrik/config.json"]]);
  });

  it("leaves anything else the plan finds after the wizard for the next run, and says so", async () => {
    const { steps, log } = fakeSteps({ after: plan([LABEL], ["a note from after the wizard"]) });

    const result = await runOnce({ plan: plan([WORKFLOW], ["a note from before the wizard"]), repo: "acme/clinic" }, steps);

    expect(log).not.toContain("apply create-label");
    expect(result.kind === "done" && result.summary.notes).toEqual([
      "a note from after the wizard",
      "Setup found more to do after the wizard, and left it for the next run: create the label needs-triage. Run setup again to do it.",
    ]);
  });

  it("with nothing left to apply, still walks the wizard and opens the PR", async () => {
    const { steps, log } = fakeSteps();

    await runOnce({ plan: plan([]), repo: "acme/clinic" }, steps);

    expect(log).toEqual(["confirm", "switch", "wizard", "read again", "commit", "push", "publish"]);
  });

  it("with nothing committed and nothing on the setup branch for a PR, pushes and publishes nothing, and leaves the branch", async () => {
    const { steps, log } = fakeSteps({ commits: false });

    const result = await runOnce({ plan: plan([LABEL], ["a note"]), repo: "acme/clinic" }, steps);

    expect(log).toEqual(["confirm", "switch", "apply create-label", "wizard", "read again", "commit", "anything to publish?", "leave"]);
    expect(result).toEqual({ kind: "applied", summary: { done: ["create the label needs-triage"], notes: [], blockers: [] } });
  });

  it("with nothing committed, still pushes and publishes what an earlier run left on the setup branch", async () => {
    const { steps, log } = fakeSteps({ commits: false, onTheBranch: true });

    await runOnce({ plan: plan([]), repo: "acme/clinic" }, steps);

    expect(log.slice(log.indexOf("commit"))).toEqual(["commit", "anything to publish?", "push", "publish"]);
  });

  it("gives the PR what the merge waits for, as read after the wizard", async () => {
    const { steps } = fakeSteps({ readiness: { ...READY, claudeTokenStored: false } });

    const result = await runOnce({ plan: plan([WORKFLOW]), repo: "acme/clinic" }, steps);

    expect(result.kind === "done" && result.summary.blockers).toEqual(['the Claude token, in the "Fabrik" vault']);
  });
});

describe("What the merge waits for, read after the wizard", () => {
  const after = { repo: "acme/clinic", report: "app-installed acme/clinic\n", fabrikItems: ["Claude token"], appItems: ["Fabrik App"] };

  it("is ready once the wizard reported the App installed on this repo and 1Password holds both items", () => {
    expect(readinessOf(after)).toEqual(READY);
  });

  it("counts the App as installed when the open setup PR keeps an earlier run's confirmation for this repo", () => {
    const earlierPr = "Sets up Fabrik v1.4.2 in this repo.\n\n<!-- fabrik-setup: app-installed acme/clinic -->\n";

    expect(readinessOf({ ...after, report: "", earlierPr }).appInstalled).toBe(true);
    expect(readinessOf({ ...after, report: "", earlierPr: earlierPr.replace("acme/clinic", "acme/other") }).appInstalled).toBe(false);
  });

  it("counts the App as installed only on the repo the wizard reported", () => {
    expect(readinessOf({ ...after, report: "app-installed acme/other\n" }).appInstalled).toBe(false);
    expect(readinessOf({ ...after, report: "" }).appInstalled).toBe(false);
  });

  it("reads the App's key and the Claude token from the vaults' items, not from how the wizard ended", () => {
    expect(readinessOf({ ...after, appItems: [], fabrikItems: ["Claude token 2"] })).toEqual({ ...READY, appKeyStored: false, claudeTokenStored: false });
  });
});

describe("What a wizard stage stores that 1Password lacks", () => {
  const listing = (...names: string[]) => `${JSON.stringify({ subscriptions: names })}\n`;
  const SECOND = 'the second Subscription\'s token, "Claude token 2", in the "Fabrik" vault';
  const installed = (overrides: Partial<ProductState> = {}) =>
    aCleanProduct({ files: { ".fabrik/config.json": listing("Claude token") }, fabrikItems: ["Claude token"], ...overrides });

  it("is nothing once 1Password holds the App's key and every Subscription the Kit config lists", () => {
    const state = installed({ files: { ".fabrik/config.json": listing("Claude token", "Claude token 2") }, fabrikItems: ["Claude token", "Claude token 2"] });

    expect(wizardGaps(state, {}, ["Fabrik App"])).toEqual([]);
  });

  it("names the Claude token, and the second Subscription's token once the Kit config lists it", () => {
    const state = installed({ files: { ".fabrik/config.json": listing("Claude token", "Claude token 2") }, fabrikItems: [] });

    expect(wizardGaps(state, {}, ["Fabrik App"])).toEqual(['the Claude token, in the "Fabrik" vault', SECOND]);
  });

  it("leaves out a Subscription the Kit config lists under a name no wizard stage stores, such as a third, which the plan's note names", () => {
    for (const listed of [listing("Claude token", "Claude token 2", "Claude token 3"), listing("Claude token", "Claude backup")]) {
      const state = installed({ files: { ".fabrik/config.json": listed }, fabrikItems: ["Claude token", "Claude token 2"] });

      expect(wizardGaps(state, {}, ["Fabrik App"])).toEqual([]);
    }
  });

  it("names the second Subscription's token only on the Operator's yes", () => {
    expect(wizardGaps(installed(), { secondSubscription: true }, ["Fabrik App"])).toEqual([SECOND]);
    expect(wizardGaps(installed(), {}, ["Fabrik App"])).toEqual([]);
  });

  it("leaves it out on a yes to a Kit config listing two or more, which setup never adds to", () => {
    const state = installed({ files: { ".fabrik/config.json": listing("Claude token", "Claude backup") }, fabrikItems: ["Claude token", "Claude backup"] });

    expect(wizardGaps(state, { secondSubscription: true }, ["Fabrik App"])).toEqual([]);
  });

  it("names the Sentry token only once monitor.errors names a Sentry project", () => {
    const sentry = '{ "monitor": { "errors": { "provider": "sentry", "org": "acme", "project": "clinic" } } }\n';
    const state = aCleanProduct({ files: { ".fabrik/config.json": sentry }, fabrikItems: ["Claude token"] });
    const gap = 'the Sentry token, in the "Fabrik App" vault, which monitor.errors in .fabrik/config.json reads';

    expect(wizardGaps(state, {}, ["Fabrik App"])).toEqual([gap]);
    expect(wizardGaps(state, {}, ["Fabrik App", "Sentry token"])).toEqual([]);
    expect(wizardGaps(installed(), {}, ["Fabrik App"])).toEqual([]);
  });
});

describe("The merge rule", () => {
  it("asks for the merge once the App is installed, its key stored and the Claude token stored", () => {
    expect(mergeBlockers(READY, "acme/clinic")).toEqual([]);
  });

  it("names each of the three that isn't done", () => {
    expect(mergeBlockers({ appInstalled: false, appKeyStored: false, claudeTokenStored: false }, "acme/clinic")).toEqual([
      "the Fabrik App, installed on acme/clinic",
      'the Fabrik App\'s key, in the "Fabrik App" vault',
      'the Claude token, in the "Fabrik" vault',
    ]);
  });

  it.each([
    ["the App not installed", { appInstalled: false }, "the Fabrik App, installed on acme/clinic"],
    ["its key not stored", { appKeyStored: false }, 'the Fabrik App\'s key, in the "Fabrik App" vault'],
    ["the Claude token skipped", { claudeTokenStored: false }, 'the Claude token, in the "Fabrik" vault'],
  ])("holds the merge back with %s", (_, missing, named) => {
    expect(mergeBlockers({ ...READY, ...missing }, "acme/clinic")).toEqual([named]);
  });
});
