// The Kit's reusable workflows are wiring only. These hold the wiring to the
// files it names, since nothing runs the workflows before a release.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { kitJobOutputs } from "./jobs.ts";
import { JUDGE_JOB } from "./judge.ts";
import { PREVIEW_POLL_MINUTES } from "./previewLink.ts";
import { PROTOTYPE_JOB, RETRO_EVIDENCE_JOB } from "./pushJob.ts";
import { REPLAY_ARMS } from "./runRecord.ts";
import { RETRO_EVIDENCE_FILE } from "./retroEvidence.ts";
import { JUDGE_TIMEOUT_MINUTES } from "./runStore.ts";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import { IMPLEMENT_JOB_NAME } from "../github/snapshot.ts";
import { REPLAY_ROUTE_JOB_MINUTES } from "../loop/replayGate.ts";
import { CAPTURE_TIMEOUT_MINUTES, EVIDENCE_DIR, GALLERY_FILE, PROTOTYPE_GALLERY_FILE } from "../evidence/capture.ts";
import { MAP_INPUTS_FILE } from "../agent/inputs.ts";
import { AGENT_BUNDLE_FILE, AGENT_RESULT_FILE } from "../agent/result.ts";
import { prototypeBranchFor } from "../loop/designOutput.ts";

const root = new URL("../../", import.meta.url);
const workflows = [".github/workflows/loop.yml", ".github/workflows/schedule.yml", ".github/workflows/weekly-summary.yml"].map((path) => ({
  path,
  text: readFileSync(new URL(path, root), "utf8"),
}));
const loop = workflows.find((workflow) => workflow.path.endsWith("loop.yml"))!.text;
const schedule = workflows.find((workflow) => workflow.path.endsWith("schedule.yml"))!.text;
const prepareAgent = readFileSync(new URL(".github/actions/prepare-agent/action.yml", root), "utf8");
const actions = readdirSync(new URL(".github/actions/", root)).map((name) => ({
  name,
  text: readFileSync(new URL(`.github/actions/${name}/action.yml`, root), "utf8"),
}));

/** A workflow's job, from its key line to the next job's. */
function jobIn(workflow: string, job: string): string {
  const body = workflow.split(/\n(?=  [a-z-]+:\n)/).find((section) => section.startsWith(`  ${job}:\n`));
  if (body === undefined) throw new Error(`no ${job} job`);
  return body;
}

/** A job's steps, each from its `- ` line to the next one's. */
function stepsOf(job: string): readonly string[] {
  return job.split(/\n(?=      - )/).slice(1);
}

/** A composite action's text and its steps, each from its `- ` line to the next one's. */
function actionNamed(name: string): { readonly text: string; readonly steps: readonly string[] } {
  const text = readFileSync(new URL(`.github/actions/${name}/action.yml`, root), "utf8");
  return { text, steps: text.split(/\n(?=    - )/).slice(1) };
}

/** Each `permission-<name>: <level>` a token step asks for, in name order. */
function permissionsOf(step: string | undefined): string[] {
  return [...(step ?? "").matchAll(/permission-([a-z-]+): (\S+)/g)].map((m) => `${m[1]}: ${m[2]}`).sort();
}

describe("The Kit's workflows", () => {
  it.each(workflows)("$path checks the Kit out at kit/ in every job", ({ text }) => {
    const kitCheckouts = [...text.matchAll(/repository: jrey8343\/fabrik\n(?:.*\n){1,2}?\s+path: (\S+)/g)].map((match) => match[1]);

    expect(kitCheckouts.length).toBeGreaterThan(0);
    expect(new Set(kitCheckouts)).toEqual(new Set(["kit"]));
  });

  it.each(workflows)("$path uses only composite actions the Kit ships", ({ text }) => {
    const local = [...text.matchAll(/uses: \.\/kit\/(\S+)/g)].map((match) => match[1]!);

    expect(local.length).toBeGreaterThan(0);
    for (const action of local) expect(existsSync(new URL(`${action}/action.yml`, root)), action).toBe(true);
  });

  it.each(workflows)("$path leaves reading GitHub to the Kit's Node program, never inline gh calls", ({ text }) => {
    expect(text).not.toMatch(/\bgh (api|issue|pr|repo|release|run|workflow) /);
  });

  // Kept for reading a failed or timed-out run. Never fabrik-agent-*: the push job
  // downloads those, and reads an empty download as a timeout.
  it.each(["triage", "design", "implement", "review", "audit", "research"])(
    "loop.yml's %s job always uploads its gzipped transcript, apart from the push job's artifacts",
    (job) => {
      const body = loop.split(/\n(?=  [a-z-]+:\n)/).find((section) => section.startsWith(`  ${job}:\n`))!;
      const upload = body.split(/\n(?=      - )/).find((step) => step.includes(`name: fabrik-transcript-${job}`));

      expect(upload, `${job} has no transcript upload`).toBeDefined();
      expect(upload).toContain("if: always()");
      expect(upload).toContain("continue-on-error: true");
      expect(upload).toMatch(/path: .*transcript\.jsonl\.gz/);
      expect(upload).toContain("if-no-files-found: ignore");
      expect(upload).toContain("retention-days: 7");
      expect(body).toMatch(/if: always\(\)\n\s+continue-on-error: true\n\s+run: .*gzip.*transcript\.jsonl/);
    },
  );

  // What the Run record (src/kit/runRecord.ts) needs of how each run started.
  // The write the Run record action reads them from the push job's FABRIK_NEEDS.
  it("loop.yml's Kit job passes out which run it planned: its Retry number, Step-up and Request changes", () => {
    const kit = jobIn(loop, "kit");

    expect(kit).toContain("retry: ${{ steps.route.outputs.retry }}");
    expect(kit).toContain("step-up: ${{ steps.route.outputs.step-up }}");
    expect(kit).toContain("request-changes: ${{ steps.route.outputs.request-changes }}");
  });

  // For the prototype job (#155), which runs a prototype turn in the design job's place.
  it("loop.yml's Kit job passes out whether the Design run is a prototype turn, and its request", () => {
    const kit = jobIn(loop, "kit");

    expect(kit).toContain("prototype: ${{ steps.route.outputs.prototype }}");
    expect(kit).toContain("prototype_request: ${{ steps.route.outputs.prototype_request }}");
  });

  // The request's brief is the Design agent's text: in a run: script it could inject a command.
  it("loop.yml reads the prototype request only through env:, never in a run: script", () => {
    const uses = loop.split("\n").filter((line) => line.includes("outputs.prototype_request"));

    expect(uses).toContainEqual("      prototype_request: ${{ steps.route.outputs.prototype_request }}");
    for (const line of uses.filter((use) => !use.includes("steps.route.outputs"))) {
      expect(line).toMatch(/^\s+[A-Z][A-Z0-9_]*: \$\{\{ needs\.kit\.outputs\.prototype_request \}\}$/);
    }
  });

  // The preview link (#153): bounded and never failing, so a slow or broken host costs the push job nothing.
  describe("loop.yml's push job's preview step", () => {
    const push = jobIn(loop, "push");
    const steps = stepsOf(push);
    const at = (text: string) => steps.findIndex((step) => step.includes(text));
    const preview = steps[at("uses: ./kit/.github/actions/link-preview")] ?? "";

    it("runs after Run the Loop and before the Run record, only when the Loop's plan asked to link a UI PR's preview", () => {
      expect(at("uses: ./kit/.github/actions/link-preview"), "the push job has no preview step").toBeGreaterThan(at("name: Run the Loop"));
      expect(at("uses: ./kit/.github/actions/link-preview")).toBeLessThan(at("uses: ./kit/.github/actions/write-run-record"));
      expect(preview).toContain("if: steps.loop.outputs.preview-url != ''");
    });

    it("can't fail the push job: it goes on past any error, and its own timeout outlasts the Kit's poll budget but leaves the job time for the Run record", () => {
      const stepTimeout = Number(/timeout-minutes: (\d+)\n/.exec(preview)?.[1]);
      const jobTimeout = Number(/\n    timeout-minutes: (\d+)\n/.exec(push)?.[1]);

      expect(preview).toContain("continue-on-error: true");
      expect(stepTimeout).toBeGreaterThan(PREVIEW_POLL_MINUTES);
      expect(stepTimeout).toBeLessThan(jobTimeout);
      expect(jobTimeout).toBe(10);
    });

    it("polls the URL Run the Loop filled in for the PR it named, as the Fabrik App through the push service account", () => {
      expect(preview).toContain("url: ${{ steps.loop.outputs.preview-url }}");
      expect(preview).toContain("pull-request: ${{ steps.loop.outputs.preview-pull-request }}");
      expect(preview).toContain("op-push-token: ${{ secrets.OP_PUSH_TOKEN }}");
    });
  });

  // A prototype round's preview (#155), linked as a UI PR's is, in a step of its own whose token edits only issues.
  describe("loop.yml's push job's prototype preview step", () => {
    const push = jobIn(loop, "push");
    const steps = stepsOf(push);
    const at = (text: string) => steps.findIndex((step) => step.includes(text));
    const preview = steps[at("uses: ./kit/.github/actions/link-prototype-preview")] ?? "";

    it("runs after Run the Loop and before the Run record, only when the Loop's plan asked to link a prototype round's preview", () => {
      expect(at("uses: ./kit/.github/actions/link-prototype-preview"), "the push job has no prototype preview step").toBeGreaterThan(at("name: Run the Loop"));
      expect(at("uses: ./kit/.github/actions/link-prototype-preview")).toBeLessThan(at("uses: ./kit/.github/actions/write-run-record"));
      expect(preview).toContain("if: steps.loop.outputs.prototype-preview-url != ''");
    });

    it("can't fail the push job: it goes on past any error, and its own timeout outlasts the Kit's poll budget but leaves the job time for the Run record", () => {
      const stepTimeout = Number(/timeout-minutes: (\d+)\n/.exec(preview)?.[1]);
      const jobTimeout = Number(/\n    timeout-minutes: (\d+)\n/.exec(push)?.[1]);

      expect(preview).toContain("continue-on-error: true");
      expect(stepTimeout).toBeGreaterThan(PREVIEW_POLL_MINUTES);
      expect(stepTimeout).toBeLessThan(jobTimeout);
    });

    it("polls the URL Run the Loop filled in for the round it posted, as the Fabrik App through the push service account", () => {
      expect(preview).toContain("url: ${{ steps.loop.outputs.prototype-preview-url }}");
      expect(preview).toContain("round: ${{ steps.loop.outputs.prototype-preview-round }}");
      expect(preview).toContain("op-push-token: ${{ secrets.OP_PUSH_TOKEN }}");
    });

    // One plan lands one run, a UI PR or a prototype turn, so one poll fits in the push job's 10 minutes.
    it("never runs beside the UI PR's preview step: each waits on its own output of Run the Loop", () => {
      expect(preview).not.toContain("steps.loop.outputs.preview-url");
      expect(steps[at("uses: ./kit/.github/actions/link-preview\n")]).not.toContain("prototype-preview");
    });
  });

  it.each(["triage", "design", "implement", "review", "audit", "research"])(
    "loop.yml's %s job passes out the model and effort it ran and the commit it started from",
    (job) => {
      const body = jobIn(loop, job);

      expect(body).toMatch(/model: \$\{\{ steps\.agent\.outputs\.model \}\}/);
      expect(body).toMatch(/effort: \$\{\{ steps\.agent\.outputs\.effort \}\}/);
      expect(body).toMatch(/base-sha: \$\{\{ steps\.base\.outputs\.sha \}\}/);
      expect(body).toMatch(/id: agent\n\s+working-directory: product\n(?:.*\n)*?\s+run: node \.\.\/kit\/src\/agent\/run\.ts /);
      // Before the secrets load, so a run whose agent never started still names its commit.
      expect(body.indexOf("id: base")).toBeLessThan(body.indexOf("id: op"));
    },
  );

  // Run records (ADR-0009): written after the Loop has applied its plan, whatever
  // happened to it, and never able to fail or stall the push job.
  it("loop.yml's push job writes the Run record after Run the Loop, always, and never fails on it", () => {
    const steps = jobIn(loop, "push").split(/\n(?=      - )/);
    const loopStep = steps.findIndex((step) => step.includes("name: Run the Loop"));
    const recordStep = steps.findIndex((step) => step.includes("uses: ./kit/.github/actions/write-run-record"));
    const record = steps[recordStep] ?? "";

    expect(recordStep, "the push job has no write the Run record step").toBeGreaterThan(-1);
    expect(recordStep).toBeGreaterThan(loopStep);
    expect(loopStep).toBeGreaterThan(-1);
    expect(record).toContain("if: always()");
    expect(record).toContain("continue-on-error: true");
    expect(record).toContain("op-push-token: ${{ secrets.OP_PUSH_TOKEN }}");
    expect(record).toContain("role: ${{ needs.kit.outputs.route }}");
  });

  // Scoring (#149) is planned inside that same step, so it can't fail or stall the push job either.
  it("loop.yml's push job passes out its record step's ask for a score, and the scored record's path", () => {
    const push = jobIn(loop, "push");
    const record = stepsOf(push).find((step) => step.includes("uses: ./kit/.github/actions/write-run-record"));

    expect(record).toContain("id: record");
    expect(push).toContain("score: ${{ steps.record.outputs.score }}");
    expect(push).toContain("record: ${{ steps.record.outputs.record }}");
  });

  // A Step-up run is an Implement run on a stronger model, so it gets implement's Extra skills.
  it.each(["triage", "design", "implement", "review", "audit", "research"])(
    "loop.yml's %s job passes its role to prepare-agent, which fetches the skills before any secret loads",
    (role) => {
      const steps = stepsOf(jobIn(loop, role));
      const prepare = steps.findIndex((step) => step.includes("uses: ./kit/.github/actions/prepare-agent"));
      const firstSecret = steps.findIndex((step) => step.includes("1password/load-secrets-action"));

      expect(prepare).toBeGreaterThanOrEqual(0);
      expect(steps[prepare]).toMatch(new RegExp(`\\n\\s+role: ${role}\\n`));
      expect(firstSecret).toBeGreaterThan(prepare);
    },
  );

  it("prepare-agent hands an Auditor run's marked commit to the agent-inputs step, which reads its inputs for it", () => {
    const inputs = prepareAgent.split(/\n(?=    - )/).find((step) => step.includes("src/agent/inputs.ts"));

    expect(prepareAgent).toMatch(/\n  audit-commit:\n\s+description: .*\n\s+required: false\n\s+default: ""\n/);
    expect(inputs).toContain("FABRIK_AUDIT_COMMIT: ${{ inputs.audit-commit }}");
  });

  it("prepare-agent hands its role to the agent-inputs step, which reads a Design turn's Map inputs, and the Design job gives the agent that file", () => {
    const inputs = prepareAgent.split(/\n(?=    - )/).find((step) => step.includes("src/agent/inputs.ts"));
    const agent = stepsOf(jobIn(loop, "design")).find((step) => step.includes("src/agent/run.ts design"));

    expect(inputs).toContain("FABRIK_ROLE: ${{ inputs.role }}");
    expect(agent).toContain(`FABRIK_MAP_FILE: \${{ runner.temp }}/${MAP_INPUTS_FILE}`);
  });

  it("prepare-agent installs the Base skills plus its role's Extra skills, and holds no secret", () => {
    expect(prepareAgent).toMatch(/\n  role:\n\s+description: .*\n\s+required: true\n/);
    const fetch = prepareAgent.split(/\n(?=    - )/).find((step) => step.includes("src/skills/fetch.ts"));

    expect(fetch).toBeDefined();
    expect(fetch).toContain("FABRIK_ROLE: ${{ inputs.role }}");
    expect(fetch).toContain('node kit/src/skills/fetch.ts product "$FABRIK_ROLE"');
    expect(prepareAgent).not.toContain("load-secrets-action");
  });

  it("prepare-agent lays a replay arm's candidate Kit sha over the Kit through its read-only token, before it fetches the skills, and only when given one", () => {
    const steps = prepareAgent.split(/\n(?=    - )/);
    const overlay = steps.findIndex((step) => step.includes("src/kit/overlay-main.ts"));
    const fetch = steps.findIndex((step) => step.includes("src/skills/fetch.ts"));

    expect(prepareAgent).toMatch(/\n  kit-candidate:\n\s+description: .*\n\s+required: false\n\s+default: ""\n/);
    expect(overlay).toBeGreaterThan(steps.findIndex((step) => step.includes("npm ci")));
    expect(overlay).toBeLessThan(fetch);
    expect(steps[overlay]).toContain("if: inputs.kit-candidate != ''");
    expect(steps[overlay]).toContain("GH_TOKEN: ${{ inputs.github-token }}");
    expect(steps[overlay]).toContain('run: node kit/src/kit/overlay-main.ts kit "$FABRIK_KIT_CANDIDATE"');
  });

  it("no live job lays a candidate Kit sha over its Kit", () => {
    for (const { text } of workflows) expect(text).not.toContain("kit-candidate");
  });

  describe("schedule.yml's weekly skills bump job", () => {
    const bump = jobIn(schedule, "skills-bump");
    const steps = stepsOf(bump);
    const step = (pattern: string) => steps.findIndex((candidate) => candidate.includes(pattern));

    it("checks out only the Kit, at its pinned commit, and never the Product repo", () => {
      const checkouts = steps.filter((candidate) => candidate.includes("uses: actions/checkout@"));

      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]).toContain("repository: jrey8343/fabrik");
      expect(checkouts[0]).toContain("ref: ${{ needs.kit.outputs.sha }}");
      expect(checkouts[0]).toContain("persist-credentials: false");
      expect(bump).toContain("permissions: {}");
    });

    it("acts only on the weekly tick, checked before any secret loads", () => {
      const gate = step("src/skills/source-bumps-due.ts");

      expect(gate).toBeGreaterThanOrEqual(0);
      expect(steps[gate]).toContain("id: due");
      expect(step("1password/load-secrets-action")).toBeGreaterThan(gate);
      for (const later of steps.slice(gate + 1)) expect(later).toContain("if: steps.due.outputs.due == 'true'");
    });

    it("gates on the tick the run was scheduled for, from the caller's cron and when the run's first job started", () => {
      const gate = steps[step("src/skills/source-bumps-due.ts")]!;

      expect(gate).toContain("FABRIK_TICK_SCHEDULE: ${{ github.event.schedule }}");
      expect(gate).toContain("FABRIK_TICK_SEEN_AT: ${{ needs.kit.outputs.started-at }}");
      expect(jobIn(schedule, "kit")).toContain("started-at: ${{ steps.kit.outputs.started-at }}");
    });

    it("mints a Fabrik App token through the push service account, and bumps with it", () => {
      const secrets = steps[step("1password/load-secrets-action")]!;
      const mint = steps[step("actions/create-github-app-token@")]!;
      const push = steps[step("src/skills/source-bumps-main.ts")]!;

      expect(secrets).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_PUSH_TOKEN }}");
      expect(mint).toContain("id: app");
      expect(push).toContain("GH_TOKEN: ${{ steps.app.outputs.token }}");
      expect(push).toContain("run: node kit/src/skills/source-bumps-main.ts");
    });
  });

  // The Monitor (#148): plain Kit code on the hourly tick, reading GitHub and Sentry through their APIs alone.
  describe("schedule.yml's Monitor job", () => {
    const monitor = jobIn(schedule, "monitor");
    const steps = stepsOf(monitor);
    const step = (pattern: string) => steps.findIndex((candidate) => candidate.includes(pattern));
    const programOf = (run: string | undefined) => /run: node kit\/(src\/\S+)/.exec(run ?? "")?.[1];
    const gate = step("run: node kit/src/monitor/errors-set.ts");
    const sentry = step("op://Fabrik App/Sentry token/credential");
    const run = step("run: node kit/src/monitor/main.ts");

    it("checks out only the Kit, at its pinned commit, and holds no GITHUB_TOKEN permissions", () => {
      const checkouts = steps.filter((candidate) => candidate.includes("uses: actions/checkout@"));

      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]).toContain("repository: jrey8343/fabrik");
      expect(checkouts[0]).toContain("ref: ${{ needs.kit.outputs.sha }}");
      expect(checkouts[0]).toContain("persist-credentials: false");
      expect(monitor).toMatch(/\n {4}permissions: \{\}\n/);
    });

    // So the weekly-limit issue being open, or the tick failing, never stops it, and a Sentry outage never stops the tick.
    it("runs on every tick in its own concurrency group, needing only the Kit job", () => {
      expect(monitor).toMatch(/concurrency:\n\s+group: fabrik-monitor\n\s+cancel-in-progress: false\n/);
      expect(monitor).toMatch(/\n {4}needs: kit\n/);
      expect(monitor.slice(0, monitor.indexOf("\n    steps:"))).not.toMatch(/\n {4}if:/);
      expect(jobIn(schedule, "tick")).not.toContain("monitor");
    });

    it("mints a Fabrik App token through the push service account, and runs the Monitor with it and the App's slug", () => {
      const key = steps[step("op://Fabrik App/Fabrik App/private-key")]!;
      const mint = steps[step("actions/create-github-app-token@")]!;

      expect(key).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_PUSH_TOKEN }}");
      expect(mint).toContain("id: app");
      // An unaccepted Checks: read would fail the mint, so it asks for whatever the installation has.
      expect(mint).not.toMatch(/permission-/);
      expect(steps[run]).toContain("FABRIK_APP_TOKEN: ${{ steps.app.outputs.token }}");
      expect(steps[run]).toContain("FABRIK_APP_SLUG: ${{ steps.app.outputs.app-slug }}");
      expect(existsSync(new URL(programOf(steps[run])!, root))).toBe(true);
    });

    it("reads whether the default branch's Kit config sets monitor.errors through the API, before any Sentry token loads", () => {
      expect(gate).toBeGreaterThan(step("actions/create-github-app-token@"));
      expect(steps[gate]).toContain("id: config");
      expect(steps[gate]).toContain("FABRIK_APP_TOKEN: ${{ steps.app.outputs.token }}");
      expect(existsSync(new URL(programOf(steps[gate])!, root))).toBe(true);
      expect(sentry).toBeGreaterThan(gate);
    });

    it("loads the Sentry token only when monitor.errors is set, in a step that can't fail the job, and hands it to the Monitor", () => {
      expect(steps[sentry]).toContain("id: sentry");
      expect(steps[sentry]).toContain("if: steps.config.outputs.errors == 'true'");
      expect(steps[sentry]).toContain("continue-on-error: true");
      expect(steps[sentry]).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_PUSH_TOKEN }}");
      expect(run).toBeGreaterThan(sentry);
      expect(steps[run]).toContain("FABRIK_SENTRY_TOKEN: ${{ steps.sentry.outputs.SENTRY_TOKEN }}");
    });

    it("makes no model call and writes no Run record: no Claude token, no agent and no Run record action", () => {
      expect(monitor).not.toContain("op://Fabrik/");
      expect(monitor).not.toContain("./kit/.github/actions/");
    });
  });
});

/** A job's section of loop.yml, from its key to the next job's. */
function job(name: string): string {
  const body = loop.split(/\n(?=  [a-z-]+:\n)/).find((section) => section.startsWith(`  ${name}:\n`));
  if (body === undefined) throw new Error(`loop.yml has no ${name} job`);
  return body;
}

describe("The run the Loop action", () => {
  const action = readFileSync(new URL(".github/actions/run-loop/action.yml", root), "utf8");
  const steps = action.split(/\n(?=    - )/).slice(1);

  it("runs the Loop with the token it mints and the Fabrik App's slug, so only the App's own issues count as its", () => {
    const mint = steps.find((step) => step.includes("uses: actions/create-github-app-token@"))!;
    const run = steps.find((step) => step.includes("run: node src/main.ts"))!;

    expect(mint).toContain("id: app");
    expect(run).toContain("FABRIK_APP_TOKEN: ${{ steps.app.outputs.token }}");
    expect(run).toContain("FABRIK_APP_SLUG: ${{ steps.app.outputs.app-slug }}");
  });

  it("passes out the preview its plan asked to link, for the push job's preview step", () => {
    const run = steps.find((step) => step.includes("run: node src/main.ts"))!;

    expect(run).toContain("id: loop");
    expect(action).toMatch(/\n  preview-url:\n.*\n\s+value: \$\{\{ steps\.loop\.outputs\.preview-url \}\}\n/);
    expect(action).toMatch(/\n  preview-pull-request:\n.*\n\s+value: \$\{\{ steps\.loop\.outputs\.preview-pull-request \}\}\n/);
  });

  it("passes out the prototype round's preview its plan asked to link, for the push job's prototype preview step", () => {
    expect(action).toMatch(/\n  prototype-preview-url:\n.*\n\s+value: \$\{\{ steps\.loop\.outputs\.prototype-preview-url \}\}\n/);
    expect(action).toMatch(/\n  prototype-preview-round:\n.*\n\s+value: \$\{\{ steps\.loop\.outputs\.prototype-preview-round \}\}\n/);
  });

  describe("asked to find the fabrik-runs store, as the scheduled tick asks for the retro gate", () => {
    const find = steps.find((step) => step.includes("id: find-store\n"));
    const store = steps.find((step) => step.includes("id: store-metadata\n"));
    const run = steps.find((step) => step.includes("run: node src/main.ts"))!;

    it("finds it only when asked, with the record action's store finder, and goes on when that fails", () => {
      expect(action).toMatch(/\n  find-store:\n(?:.*\n)*?\s+default: "false"\n/);
      expect(find).toContain("if: inputs.find-store == 'true'");
      expect(find).toContain("run: node src/kit/find-store-main.ts");
      expect(find).toContain("continue-on-error: true");
    });

    it("mints a token for fabrik-runs alone that reads only its metadata, once it has found the Fabrik App on it", () => {
      expect(store).toContain("uses: actions/create-github-app-token@");
      expect(store).toContain("if: steps.find-store.outputs.installed == 'true'");
      expect(store).toMatch(/owner: jrey8343\n/);
      expect(store).toMatch(/repositories: fabrik-runs\n/);
      expect(permissionsOf(store)).toEqual(["metadata: read"]);
      expect(store).toContain("continue-on-error: true");
      expect(steps.indexOf(find!)).toBeLessThan(steps.indexOf(store!));
    });

    it("hands the Loop that token, so its snapshot can say whether the store is private", () => {
      expect(run).toContain("FABRIK_STORE_METADATA_TOKEN: ${{ steps.store-metadata.outputs.token }}");
      expect(steps.indexOf(store!)).toBeLessThan(steps.indexOf(run));
    });

    it("loads the Fabrik App key once, for every token it mints", () => {
      expect(steps.filter((step) => step.includes("1password/load-secrets-action@"))).toHaveLength(1);
    });
  });
});

describe("The link-preview action, which the push job's preview step runs", () => {
  const { text: action, steps } = actionNamed("link-preview");
  const mint = steps.find((step) => step.includes("uses: actions/create-github-app-token@"));
  const program = steps.find((step) => step.includes("run: node src/kit/preview-main.ts"));

  it("loads the Fabrik App key through the push service account, and nothing else", () => {
    const secrets = steps.filter((step) => step.includes("1password/load-secrets-action@"));

    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ inputs.op-push-token }}");
    expect([...secrets[0]!.matchAll(/: (op:\/\/\S.*)$/gm)].map((match) => match[1])).toEqual([
      "op://Fabrik App/Fabrik App/client-id",
      "op://Fabrik App/Fabrik App/private-key",
    ]);
  });

  it("mints a Fabrik App token for the Product repo alone that can edit a PR's body and do nothing else", () => {
    expect(steps.filter((step) => step.includes("uses: actions/create-github-app-token@"))).toHaveLength(1);
    expect(mint).toContain("id: app");
    expect(mint).not.toMatch(/owner:|repositories:/);
    expect(permissionsOf(mint)).toEqual(["pull-requests: write"]);
  });

  it("polls and edits with the Kit's Node program, given the URL and the PR through its env, never in its command line", () => {
    expect(program, "no step runs src/kit/preview-main.ts").toBeDefined();
    expect(program).toContain("FABRIK_APP_TOKEN: ${{ steps.app.outputs.token }}");
    expect(program).toContain("FABRIK_PREVIEW_URL: ${{ inputs.url }}");
    expect(program).toContain("FABRIK_PREVIEW_PULL_REQUEST: ${{ inputs.pull-request }}");
    expect(/run: (.*)/.exec(program ?? "")?.[1]).toBe("node src/kit/preview-main.ts");
    expect(steps.indexOf(mint!)).toBeLessThan(steps.indexOf(program!));
  });

  it("checks nothing out, so it runs no Product code", () => {
    expect(action).not.toContain("actions/checkout@");
  });
});

describe("The link-prototype-preview action, which the push job's prototype preview step runs", () => {
  const { text: action, steps } = actionNamed("link-prototype-preview");
  const mint = steps.find((step) => step.includes("uses: actions/create-github-app-token@"));
  const program = steps.find((step) => step.includes("run: node src/kit/preview-main.ts"));

  it("loads the Fabrik App key through the push service account, and nothing else", () => {
    const secrets = steps.filter((step) => step.includes("1password/load-secrets-action@"));

    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ inputs.op-push-token }}");
    expect([...secrets[0]!.matchAll(/: (op:\/\/\S.*)$/gm)].map((match) => match[1])).toEqual([
      "op://Fabrik App/Fabrik App/client-id",
      "op://Fabrik App/Fabrik App/private-key",
    ]);
  });

  // The round is an issue comment: editing it takes issues: write, which the UI PR's preview step never holds.
  it("mints a Fabrik App token for the Product repo alone that can edit an issue's comments and do nothing else", () => {
    expect(steps.filter((step) => step.includes("uses: actions/create-github-app-token@"))).toHaveLength(1);
    expect(mint).toContain("id: app");
    expect(mint).not.toMatch(/owner:|repositories:/);
    expect(permissionsOf(mint)).toEqual(["issues: write"]);
  });

  it("polls and edits with the Kit's Node program, given the URL and the round through its env, never in its command line", () => {
    expect(program, "no step runs src/kit/preview-main.ts").toBeDefined();
    expect(program).toContain("FABRIK_APP_TOKEN: ${{ steps.app.outputs.token }}");
    expect(program).toContain("FABRIK_PREVIEW_URL: ${{ inputs.url }}");
    expect(program).toContain("FABRIK_PREVIEW_ROUND: ${{ inputs.round }}");
    expect(program).not.toContain("FABRIK_PREVIEW_PULL_REQUEST");
    expect(/run: (.*)/.exec(program ?? "")?.[1]).toBe("node src/kit/preview-main.ts");
    expect(steps.indexOf(mint!)).toBeLessThan(steps.indexOf(program!));
  });

  it("checks nothing out, so it runs no Product code", () => {
    expect(action).not.toContain("actions/checkout@");
  });
});

describe("loop.yml's Audit job", () => {
  const audit = (): string => job("audit");
  const checkout = (): string => stepsOf(audit()).find((step) => step.includes("uses: actions/checkout@") && !step.includes("repository:"))!;

  it("holds only read permissions", () => {
    const permissions = /\n    permissions:\n((?: {6}.*\n)+)/.exec(audit())?.[1] ?? "";

    expect(permissions.trim().split("\n").map((line) => line.trim())).toEqual(["contents: read", "issues: read", "pull-requests: read"]);
  });

  it("holds only the agent service account, which loads the Claude token, and no GitHub write credential", () => {
    expect(audit()).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_AGENT_TOKEN }}");
    expect(audit()).not.toContain("OP_PUSH_TOKEN");
    expect(audit()).not.toContain("OP_IMPLEMENT_TOKEN");
    expect(audit()).not.toContain("id-token");
    expect(audit()).not.toMatch(/GH_TOKEN|create-github-app-token/);
  });

  it("checks out the Product repo at the pending Audit's marked commit, with its full history and no credential left behind", () => {
    expect(checkout()).toContain("path: product");
    expect(checkout()).toContain("ref: ${{ needs.kit.outputs.audit-commit }}");
    expect(checkout()).toContain("fetch-depth: 0");
    expect(checkout()).toContain("persist-credentials: false");
    expect(job("kit")).toContain("audit-commit: ${{ steps.route.outputs.audit-commit }}");
  });

  it("runs only when the Kit job routed to it, within the Auditor's timeout", () => {
    expect(audit()).toContain("if: needs.kit.outputs.route == 'audit'");
    expect(audit()).toContain("timeout-minutes: ${{ fromJSON(needs.kit.outputs.audit-timeout-minutes) }}");
    expect(job("kit")).toContain("audit-timeout-minutes: ${{ steps.route.outputs.audit-timeout-minutes }}");
  });

  it("is in the push job's needs, so the push job fills in or fails the Audit once it has ended", () => {
    const needs = /\n    needs: \[(.*)\]\n/.exec(job("push"))?.[1]?.split(", ");

    expect(needs).toContain("audit");
  });
});

// The Researcher (#154): read-only like the Auditor, but it hands the push job
// a branch, its findings, as a bundle beside its result, as the Implementer does.
describe("loop.yml's Research job", () => {
  const research = (): string => job("research");
  const steps = (): readonly string[] => stepsOf(research());
  const stepWith = (text: string): string => steps().find((step) => step.includes(text)) ?? "";
  const checkout = (): string => steps().find((step) => step.includes("uses: actions/checkout@") && !step.includes("repository:"))!;

  it("holds only read permissions, on the Product repo's contents and its issues", () => {
    const permissions = /\n    permissions:\n((?: {6}.*\n)+)/.exec(research())?.[1] ?? "";

    expect(permissions.trim().split("\n").map((line) => line.trim())).toEqual(["contents: read", "issues: read"]);
  });

  it("holds only the agent service account, which loads the Claude token: no GitHub credential and no production secrets", () => {
    expect(research()).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_AGENT_TOKEN }}");
    expect(research()).not.toMatch(/OP_PUSH_TOKEN|OP_IMPLEMENT_TOKEN|id-token|GH_TOKEN|create-github-app-token/);
    // The Sandbox's test secrets: neither listed nor handed to the runner, as only the Implement job's are.
    expect(research()).not.toMatch(/secrets-main\.ts|OP_ENV_FILE|FABRIK_SECRETS/);
  });

  it("checks out the Product repo's default branch, with its full history for the bundle, and no credential left behind", () => {
    expect(checkout()).toContain("path: product");
    expect(checkout()).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(checkout()).toContain("fetch-depth: 0");
    expect(checkout()).toContain("persist-credentials: false");
  });

  it("runs only when the Kit job routed to it, within the Researcher's timeout", () => {
    expect(research()).toMatch(/\n    needs: kit\n/);
    expect(research()).toContain("\n    if: needs.kit.outputs.route == 'research'\n");
    expect(research()).toContain("timeout-minutes: ${{ fromJSON(needs.kit.outputs.research-timeout-minutes) }}");
    expect(job("kit")).toContain("research-timeout-minutes: ${{ steps.route.outputs.research-timeout-minutes }}");
  });

  it("runs one Researcher run per Decision at a time, queueing the next", () => {
    expect(research()).toMatch(
      /\n    concurrency:\n {6}group: fabrik-research-\$\{\{ github\.event\.issue\.number \}\}\n {6}cancel-in-progress: false\n {6}queue: max\n/,
    );
  });

  it("readies the agent for the research Decision the label went on, which reads its Map as the issue's parent", () => {
    const prepare = stepWith("uses: ./kit/.github/actions/prepare-agent");

    expect(prepare).toContain("github-token: ${{ github.token }}");
    expect(prepare).toContain("issue: ${{ github.event.issue.number }}");
  });

  it("runs the Researcher from the Product checkout on the Decision and its Map, on the model and effort the Kit job's plan chose", () => {
    const agent = stepWith("run: node ../kit/src/agent/run.ts research");

    expect(agent).toContain("CLAUDE_CODE_OAUTH_TOKEN: ${{ steps.op.outputs.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(agent).toContain("FABRIK_ISSUE_FILE: ${{ runner.temp }}/issue.json");
    expect(agent).toContain("FABRIK_SPEC_FILE: ${{ runner.temp }}/spec.json");
    expect(agent).toContain("FABRIK_OUT_DIR: ${{ runner.temp }}/fabrik-out");
    expect(agent).toContain("FABRIK_MODEL: ${{ needs.kit.outputs.model }}");
    expect(agent).toContain("FABRIK_EFFORT: ${{ needs.kit.outputs.effort }}");
  });

  it("passes its result and the bundle of its findings branch to the push job, as the Implement job passes its commits", () => {
    const upload = stepWith("name: fabrik-agent-result\n");

    expect(upload).toContain("uses: actions/upload-artifact@");
    expect(upload).toContain("${{ runner.temp }}/fabrik-out/agent-result.json");
    expect(upload).toContain("${{ runner.temp }}/fabrik-out/agent-branch.bundle");
    expect(upload).toContain("if-no-files-found: error");
  });

  it("passes the push job its failure report when it fails, and how its secrets loaded", () => {
    const failure = stepWith("name: fabrik-agent-failure\n");

    expect(failure).toContain("if: failure()");
    expect(failure).toContain("${{ runner.temp }}/fabrik-out/agent-failure.json");
    expect(research()).toContain("secrets-step: ${{ steps.op.outcome }}");
  });

  it("keeps fabrik-transcript-research, which the push job's record step takes on the research route", () => {
    expect(stepWith("name: fabrik-transcript-research\n")).toContain("if: always()");
    expect(stepsOf(job("push")).find((step) => step.includes("uses: ./kit/.github/actions/write-run-record"))).toContain(
      "role: ${{ needs.kit.outputs.route }}",
    );
  });

  it("is in the push job's needs, so the push job lands the findings or posts the failure notice once it has ended", () => {
    const needs = /\n    needs: \[(.*)\]\n/.exec(job("push"))?.[1]?.split(", ");

    expect(needs).toContain("research");
  });
});

// A Design session's prototype turn (#155): the Kit job's plan says whether the
// Design run is one, and the prototype job runs it in the design job's place.
// #328: a turn of a Design session on a Ticket sent back from an agent PR
// reads that closed PR in its input step (readSentBack in src/agent/inputs.ts),
// which takes pull-requests: read. Without it the turn fails before its agent
// starts. Triage reads it too, should the Operator add needs-triage to such a
// Ticket. None of them holds a write permission (ADR-0002).
describe("The agent jobs whose input step may read a sent-back Ticket's PR", () => {
  const permissionsOfJob = (name: string): string[] =>
    (/\n    permissions:\n((?: {6}.*\n)+)/.exec(job(name))?.[1] ?? "")
      .trim()
      .split("\n")
      .map((line) => line.trim());

  it.each(["design", "prototype", "triage"])("the %s job holds exactly contents, issues and pull-requests read, and no write", (name) => {
    expect(permissionsOfJob(name)).toEqual(["contents: read", "issues: read", "pull-requests: read"]);
    expect(job(name)).not.toMatch(/: write\b|id-token|create-github-app-token/);
  });

  it("the input step leaves its failure report where the job's failure upload looks for it", () => {
    const read = actionNamed("prepare-agent").steps.find((step) => step.includes("run: node kit/src/agent/inputs.ts")) ?? "";

    expect(read).toContain("FABRIK_OUT_DIR: ${{ runner.temp }}/fabrik-out\n");
    for (const name of ["design", "prototype", "triage"]) {
      expect(stepsOf(job(name)).find((step) => step.includes("name: fabrik-agent-failure"))).toContain(
        "path: ${{ runner.temp }}/fabrik-out/agent-failure.json",
      );
    }
  });
});

describe("loop.yml's prototype job", () => {
  // Keyed as the push job and the Run record pick it by (src/kit/pushJob.ts).
  const prototype = (): string => job(PROTOTYPE_JOB);
  // A step's lines past its `- name:` line, without the comments over the next step or job.
  const unnamed = (step: string | undefined) =>
    step
      ?.split("\n")
      .slice(1)
      .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
      .join("\n");

  it("runs a Design run only when the Kit job's plan made it a prototype turn, and the design job only when it didn't", () => {
    expect(prototype()).toMatch(/\n    needs: kit\n/);
    expect(prototype()).toContain("\n    if: needs.kit.outputs.route == 'design' && needs.kit.outputs.prototype == 'true'\n");
    expect(job("design")).toContain("\n    if: needs.kit.outputs.route == 'design' && needs.kit.outputs.prototype != 'true'\n");
  });

  it("is named for the issue's prototype turn", () => {
    expect(prototype()).toMatch(/^ {2}prototype:\n {4}name: "Prototype turn #\$\{\{ github\.event\.issue\.number \}\}"\n/);
  });

  it("shares the Design session's concurrency group, so one turn of the session runs at a time, queueing the next", () => {
    const group = /\n    concurrency:\n((?: {6}.*\n)+)/;

    expect(group.exec(prototype())?.[1]).toBe(group.exec(job("design"))?.[1]);
    expect(prototype()).toMatch(
      /\n    concurrency:\n {6}group: fabrik-design-\$\{\{ github\.event\.issue\.number \}\}\n {6}cancel-in-progress: false\n {6}queue: max\n/,
    );
  });

  // Its permissions are pinned with the other jobs that may read a sent-back Ticket's PR, above (#328).
  it("holds no GitHub credential beyond its read-only token", () => {
    expect(prototype()).not.toMatch(/OP_PUSH_TOKEN|id-token|GH_TOKEN|create-github-app-token/);
  });

  // It builds and serves the Product, as the Implement job does.
  it("loads the Claude token and the Sandbox's test secrets through the implement service account, exactly as the Implement job does", () => {
    const listing = (text: string) => stepsOf(text).find((step) => step.includes("secrets-main.ts")) ?? "";
    const loading = (text: string) => stepsOf(text).find((step) => step.includes("uses: 1password/load-secrets-action@")) ?? "";
    const agent = stepsOf(prototype()).find((step) => step.includes("id: agent\n")) ?? "";

    expect(listing(prototype())).toBe(listing(job("implement")));
    expect(loading(prototype())).toBe(loading(job("implement")));
    expect(loading(prototype())).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_IMPLEMENT_TOKEN }}");
    expect(prototype()).not.toContain("OP_AGENT_TOKEN");
    // Every value the 1Password step resolved, in the agent step's env only.
    expect(agent).toContain("FABRIK_SECRETS: ${{ toJSON(steps.op.outputs) }}");
    expect(prototype().split("steps.op.outputs")).toHaveLength(2);
  });

  it("stops its agent step at the Implement role's timeout, and the job at the Implement job's, which leaves capture its time after it", () => {
    const agent = stepsOf(prototype()).find((step) => step.includes("id: agent\n")) ?? "";

    expect(agent).toContain("timeout-minutes: ${{ fromJSON(needs.kit.outputs.implement-timeout-minutes) }}\n");
    expect(prototype()).toMatch(/\n    timeout-minutes: \$\{\{ fromJSON\(needs\.kit\.outputs\.implement-job-timeout-minutes\) \}\}\n/);
  });

  // The agent step's own timeout fails the job, so the job notes it, as the Implement job does, for the push job to read as a timeout.
  it("notes an agent step its timeout stopped, and leaves that run no failure report", () => {
    const steps = stepsOf(prototype());
    const at = (text: string) => steps.findIndex((step) => step.includes(text));
    expect(at("id: started\n")).toBeGreaterThan(-1);
    expect(at("id: started\n")).toBeLessThan(at("id: agent\n"));
    expect(at("id: agent-time\n")).toBeGreaterThan(at("id: agent\n"));
    expect(unnamed(steps[at("id: agent-time\n")])).toBe(unnamed(stepsOf(job("implement")).find((step) => step.includes("id: agent-time\n"))));
    expect(unnamed(steps[at("id: started\n")])).toBe(unnamed(stepsOf(job("implement")).find((step) => step.includes("id: started\n"))));
    expect(prototype()).toContain("agent-timed-out: ${{ steps.agent-time.outputs.timed-out }}");
    expect(steps[at("name: fabrik-agent-failure")]).toContain("if: failure() && steps.agent-time.outputs.timed-out != 'true'\n");
  });

  it("checks out the default branch with every branch's history, for the bundle and the guard, and no credential left behind", () => {
    const checkout = stepsOf(prototype()).find((step) => step.includes("uses: actions/checkout@") && !step.includes("repository:")) ?? "";

    expect(checkout).toContain("path: product");
    expect(checkout).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(checkout).toContain("fetch-depth: 0");
    expect(checkout).toContain("persist-credentials: false");
  });

  // A first round's runner cuts the branch from the default branch (src/agent/prototype.ts).
  it("builds a later round on the issue's prototype branch when an earlier round pushed it, before it notes the commit the run starts from", () => {
    const steps = stepsOf(prototype());
    const at = (text: string) => steps.findIndex((step) => step.includes(text));
    const branch = steps[at("name: Check out the issue's prototype branch")] ?? "";

    expect(at("name: Check out the issue's prototype branch")).toBeGreaterThan(at("path: product\n"));
    expect(at("name: Check out the issue's prototype branch")).toBeLessThan(at("id: base\n"));
    expect(branch).toContain(`BRANCH: ${prototypeBranchFor(7).replace("7", "${{ github.event.issue.number }}")}\n`);
    expect(branch).toContain('if git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null; then');
    expect(branch).toContain('git checkout --quiet -B "$BRANCH" "refs/remotes/origin/$BRANCH"');
  });

  it("readies the agent as a Design-session turn on the issue the label went on, with the Design role's skills", () => {
    const prepare = stepsOf(prototype()).find((step) => step.includes("uses: ./kit/.github/actions/prepare-agent")) ?? "";

    expect(prepare).toContain("role: design\n");
    expect(prepare).toContain("github-token: ${{ github.token }}");
    expect(prepare).toContain("issue: ${{ github.event.issue.number }}");
  });

  // The request's brief is the Design agent's text, so it reaches the runner through env: only.
  it("runs the prototype turn from the Product checkout on the issue thread and the approved request, on the model and effort the Kit job's plan chose", () => {
    const agent = stepsOf(prototype()).find((step) => step.includes("id: agent\n")) ?? "";

    expect(agent).toContain("working-directory: product\n");
    expect(agent).toContain("run: node ../kit/src/agent/run.ts prototype\n");
    expect(agent).toContain("FABRIK_ISSUE_FILE: ${{ runner.temp }}/issue.json");
    expect(agent).toContain("FABRIK_PROTOTYPE_REQUEST: ${{ needs.kit.outputs.prototype_request }}");
    expect(agent).toContain("FABRIK_OUT_DIR: ${{ runner.temp }}/fabrik-out");
    expect(agent).toContain("FABRIK_MODEL: ${{ needs.kit.outputs.model }}");
    expect(agent).toContain("FABRIK_EFFORT: ${{ needs.kit.outputs.effort }}");
  });

  it("passes its result and the bundle of the variants' commits to the push job, as the Implement job passes its commits", () => {
    const upload = stepsOf(prototype()).find((step) => step.includes("name: fabrik-agent-result\n")) ?? "";

    expect(upload).toContain("uses: actions/upload-artifact@");
    expect(upload).toContain(`\${{ runner.temp }}/fabrik-out/${AGENT_RESULT_FILE}`);
    expect(upload).toContain(`\${{ runner.temp }}/fabrik-out/${AGENT_BUNDLE_FILE}`);
    expect(upload).toContain("if-no-files-found: error");
  });

  it("passes the push job its failure report when it fails, and how its secrets loaded", () => {
    const failure = stepsOf(prototype()).find((step) => step.includes("name: fabrik-agent-failure\n")) ?? "";

    expect(failure).toContain("${{ runner.temp }}/fabrik-out/agent-failure.json");
    expect(failure).toContain("if-no-files-found: ignore");
    expect(prototype()).toContain("secrets-step: ${{ steps.op.outcome }}");
  });

  // The push job's record step takes the transcript by route, and a prototype turn's route is design.
  it("keeps its transcript as fabrik-transcript-design, the Design job's, whether it passed, failed or timed out", () => {
    const keep = stepsOf(prototype()).find((step) => step.includes("name: Keep the agent's transcript")) ?? "";

    expect(unnamed(keep)).toBe(unnamed(stepsOf(job("design")).find((step) => step.includes("name: Keep the agent's transcript"))));
    expect(keep).toContain("name: fabrik-transcript-design\n");
    expect(prototype()).toMatch(/if: always\(\)\n\s+continue-on-error: true\n\s+run: .*gzip.*transcript\.jsonl/);
  });

  describe("capture of the variants", () => {
    const steps = () => stepsOf(prototype());
    const stepAt = (pattern: string) => steps().findIndex((step) => step.includes(pattern));
    const step = (pattern: string) => steps()[stepAt(pattern)] ?? "";
    const capture = () => step("id: capture\n");
    const gallery = () => step("id: gallery\n");

    it("captures after the agent step has ended and before its result goes to the push job, from the Kit's program in its prototype mode", () => {
      expect(stepAt("id: capture\n")).toBeGreaterThan(stepAt("id: agent\n"));
      expect(stepAt("id: capture\n")).toBeLessThan(stepAt("name: fabrik-agent-result"));
      expect(capture()).toContain("if: success()\n");
      expect(capture()).toMatch(/working-directory: product\n(?:.*\n)*?\s+run: node \.\.\/kit\/src\/evidence\/capture-main\.ts prototype\n/);
    });

    it("can't fail the job: it goes on when capture fails, and stops at the Kit's capture timeout", () => {
      expect(capture()).toContain("continue-on-error: true");
      expect(capture()).toContain(`timeout-minutes: ${CAPTURE_TIMEOUT_MINUTES}\n`);
    });

    it("hands capture the route it captures through env:, and no secret: neither the 1Password step's outputs nor any GitHub token", () => {
      expect(capture()).toContain("FABRIK_OUT_DIR: ${{ runner.temp }}/fabrik-out");
      expect(capture()).toContain("FABRIK_DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}");
      expect(capture()).toContain("FABRIK_PROTOTYPE_REQUEST: ${{ needs.kit.outputs.prototype_request }}");
      expect(capture()).not.toMatch(/FABRIK_SECRETS|steps\.op\.|secrets\.|github\.token|GH_TOKEN|GITHUB_TOKEN/);
    });

    it("keeps the gallery unzipped, so it opens in one click, for 30 days, apart from the push job's artifacts", () => {
      expect(stepAt("id: gallery\n")).toBeGreaterThan(stepAt("id: capture\n"));
      expect(gallery()).toContain("uses: actions/upload-artifact@");
      expect(gallery()).toContain(`path: \${{ runner.temp }}/fabrik-out/${PROTOTYPE_GALLERY_FILE}\n`);
      expect(gallery()).toContain("archive: false\n");
      expect(gallery()).toContain("retention-days: 30\n");
      expect(gallery()).not.toMatch(/name: fabrik-agent-/);
      expect(PROTOTYPE_GALLERY_FILE).not.toMatch(/^fabrik-agent-/);
    });

    it("keeps the gallery only when capture recorded a result, never failing the job, and a capture that took no screenshot leaves none", () => {
      expect(gallery()).toContain("if: steps.capture.outputs.ui-capture-result != ''\n");
      expect(gallery()).toContain("continue-on-error: true");
      expect(gallery()).toContain("if-no-files-found: ignore");
    });

    // The push job links the gallery from its own run by this id, never from an address the agent's runner passed out (src/github/events.ts).
    it("passes out the capture result and the gallery's artifact id, under the names the Implement job passes them out by, for the push job", () => {
      expect(prototype()).toContain("ui-capture-result: ${{ steps.capture.outputs.ui-capture-result }}");
      expect(prototype()).toContain("ui-gallery-artifact: ${{ steps.gallery.outputs.artifact-id }}");
      expect(job("implement")).toContain("ui-gallery-artifact: ${{ steps.gallery.outputs.artifact-id }}");
    });
  });

  it("passes out what its Run record needs: the model and effort the runner passed, and the commit it started from", () => {
    expect(prototype()).toContain("model: ${{ steps.agent.outputs.model }}");
    expect(prototype()).toContain("effort: ${{ steps.agent.outputs.effort }}");
    expect(prototype()).toContain("base-sha: ${{ steps.base.outputs.sha }}");
  });

  it("is in the push job's needs, so the push job lands the prototype round or posts the failure notice once it has ended", () => {
    const needs = /\n    needs: \[(.*)\]\n/.exec(job("push"))?.[1]?.split(", ");

    expect(needs).toContain(PROTOTYPE_JOB);
  });
});

// A Design session's prototype turn builds the issue's prototype branch (#155),
// but only the push job writes it, after the trust-root guard (ADR-0005).
describe("prototype/<issue>, which only the push job writes", () => {
  const kitFiles = [...workflows, ...actions.map(({ name, text }) => ({ path: `.github/actions/${name}/action.yml`, text }))];
  /** Every line of the Kit's workflows and actions that names a prototype branch, past their comments. */
  const naming = kitFiles.flatMap(({ path, text }) =>
    text
      .split("\n")
      .filter((line) => line.includes("prototype/") && !line.trimStart().startsWith("#"))
      .map((line) => `${path}: ${line.trim()}`),
  );

  it("is pushed by no step of the Kit's workflows or actions: they run no git push, leaving every branch to the Loop's push job", () => {
    for (const { text } of kitFiles) expect(text).not.toMatch(/git push/);
  });

  it("is named only where the prototype job checks it out, to read an earlier round's branch", () => {
    const step = stepsOf(job(PROTOTYPE_JOB)).find((text) => text.includes("BRANCH: prototype/")) ?? "";

    expect(naming).toEqual([`.github/workflows/loop.yml: BRANCH: ${prototypeBranchFor(7).replace("7", "${{ github.event.issue.number }}")}`]);
    expect(step).toContain('git checkout --quiet -B "$BRANCH" "refs/remotes/origin/$BRANCH"');
  });

  it("is written by the push job alone: the only job that runs the Loop as the Fabrik App on what an agent job left", () => {
    const loopJobs = loop.split(/\n(?=  [a-z-]+:\n)/).filter((section) => section.includes("uses: ./kit/.github/actions/run-loop"));
    const onAgentResults = loopJobs.filter((section) => section.includes("FABRIK_NEEDS: ${{ toJSON(needs) }}"));

    expect(onAgentResults.map((section) => /^ {2}([a-z-]+):\n/.exec(section)?.[1])).toEqual(["push"]);
    expect(schedule).not.toContain("FABRIK_NEEDS");
  });

  it("can't be written by the prototype job that builds it: read-only permissions, no Fabrik App token, and no credential left in its checkout", () => {
    const permissions = /\n    permissions:\n((?: {6}.*\n)+)/.exec(job(PROTOTYPE_JOB))?.[1] ?? "";
    const checkouts = stepsOf(job(PROTOTYPE_JOB)).filter((step) => step.includes("uses: actions/checkout@"));

    expect(permissions).not.toMatch(/write/);
    expect(job(PROTOTYPE_JOB)).not.toMatch(/OP_PUSH_TOKEN|create-github-app-token|run-loop/);
    expect(checkouts.length).toBeGreaterThan(0);
    for (const checkout of checkouts) expect(checkout).toContain("persist-credentials: false");
  });
});

// A UI PR's Review (#153): the Kit job passes out where its marker says the
// UI evidence is kept, and the Review job downloads it for the Reviewer.
describe("loop.yml's Review job on a UI PR", () => {
  const review = (): string => job("review");
  const steps = (): readonly string[] => stepsOf(review());
  const stepAt = (pattern: string): number => steps().findIndex((step) => step.includes(pattern));
  const download = (): string => steps()[stepAt("uses: actions/download-artifact@")] ?? "";
  const reviewer = (): string => steps()[stepAt("id: agent\n")] ?? "";

  it("gets where a UI PR's evidence is kept from the Kit job: the Implement run that captured it, its artifact, and why its capture failed", () => {
    expect(job("kit")).toContain("ui-evidence-run: ${{ steps.route.outputs.ui-evidence-run }}");
    expect(job("kit")).toContain("ui-evidence-artifact: ${{ steps.route.outputs.ui-evidence-artifact }}");
    expect(job("kit")).toContain("ui-evidence-failure: ${{ steps.route.outputs.ui-evidence-failure }}");
  });

  it("can read Actions artifacts, and holds only read permissions", () => {
    const permissions = /\n    permissions:\n((?: {6}.*\n)+)/.exec(review())?.[1] ?? "";

    expect(
      permissions
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => !line.startsWith("#")),
    ).toEqual(["contents: read", "issues: read", "pull-requests: read", "actions: read"]);
  });

  it("downloads the evidence only when given an artifact, from the run that kept it, with its own read-only token", () => {
    expect(download()).toContain("uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2");
    expect(download()).toContain("if: needs.kit.outputs.ui-evidence-artifact != ''\n");
    expect(download()).toContain("run-id: ${{ needs.kit.outputs.ui-evidence-run }}\n");
    expect(download()).toContain("artifact-ids: ${{ needs.kit.outputs.ui-evidence-artifact }}\n");
    expect(download()).toContain("github-token: ${{ github.token }}\n");
  });

  // Retention can lapse before a late Review; the Reviewer is then told capture left no result.
  it("never fails the Review on the download, which comes before any secret loads and lands outside the working directory", () => {
    expect(download()).toContain("continue-on-error: true\n");
    expect(download()).toContain("path: ${{ runner.temp }}/fabrik-ui-evidence\n");
    expect(stepAt("uses: actions/download-artifact@")).toBeGreaterThan(stepAt("uses: ./kit/.github/actions/prepare-agent"));
    expect(stepAt("uses: actions/download-artifact@")).toBeLessThan(stepAt("id: op\n"));
  });

  it("tells the Reviewer where the evidence was downloaded only on a UI PR, so any other PR's prompt says nothing of it", () => {
    expect(reviewer()).toContain(
      "FABRIK_UI_EVIDENCE_DIR: ${{ needs.kit.outputs.ui-evidence-run != '' && format('{0}/fabrik-ui-evidence', runner.temp) || '' }}\n",
    );
  });

  // The download is skipped when the marker names no artifact, so the PR body's reason is the Reviewer's only one.
  it("tells the Reviewer why the PR's capture failed, as its marker records it, for when there's no capture result to read", () => {
    expect(reviewer()).toContain("FABRIK_UI_EVIDENCE_FAILURE: ${{ needs.kit.outputs.ui-evidence-failure }}\n");
  });
});

describe("schedule.yml's tick, which opens the pending Audit and the pending Retro", () => {
  it("asks the run the Loop action to find the fabrik-runs store, which the retro gate weighs, and is the only job that does", () => {
    const tick = jobIn(schedule, "tick");

    expect(tick).toMatch(/uses: \.\/kit\/\.github\/actions\/run-loop\n\s+with:\n(?:\s+.*\n)*?\s+find-store: "true"\n/);
    expect(schedule.split("find-store:")).toHaveLength(2);
    expect(loop).not.toContain("find-store:");
  });

  it("holds only the push service account, so neither the Auditor's run nor the Retro's needs a change to the shim", () => {
    expect(schedule).toMatch(/on:\n {2}workflow_call:\n {4}secrets:\n {6}OP_PUSH_TOKEN:\n(?: {8}.*\n)+\n/);
    expect(schedule).not.toContain("OP_AGENT_TOKEN");
    expect(schedule).not.toContain("OP_IMPLEMENT_TOKEN");
  });
});

describe("loop.yml's Design queue job", () => {
  const queue = (): string => job("design-queue");

  it("runs a Design queue check when the push job's plan asked for one", () => {
    expect(queue()).toContain("needs.push.outputs.design-queue == 'true'");
    expect(job("push")).toContain("design-queue: ${{ steps.loop.outputs.design-queue }}");
    expect(queue()).toContain('FABRIK_DESIGN_QUEUE_CHECK: "true"');
  });

  it("runs queue checks one at a time in a per-repo concurrency group, so two can't fill the same free slot", () => {
    expect(queue()).toMatch(/concurrency:\n\s+group: fabrik-design-queue\n\s+cancel-in-progress: false\n/);
  });

  it("reads Design-session turns in progress with its own read-only token", () => {
    expect(queue()).toMatch(/permissions:\n(?:\s+#.*\n)*\s+actions: read\n/);
    expect(queue()).toContain("actions-token: ${{ github.token }}");
  });
});

describe("loop.yml's judge job", () => {
  const judge = (): string => job(JUDGE_JOB);

  it("runs after the push job, only when its scoring plan asked for a score, unless the run was cancelled", () => {
    expect(judge()).toMatch(/\n    needs: \[kit, push\]\n/);
    expect(judge()).toMatch(/\n    if: \$\{\{ !cancelled\(\) && needs\.push\.outputs\.score == 'true' \}\}\n/);
  });

  // The judge run action checks nothing out itself, so this checkout is all the job has.
  it("checks out only the Kit, at its pinned commit, before running the judge, and never the Product repo", () => {
    const steps = stepsOf(judge());
    const checkouts = steps.filter((step) => step.includes("uses: actions/checkout@"));
    const run = steps.findIndex((step) => step.includes("uses: ./kit/.github/actions/run-judge"));

    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toContain("repository: jrey8343/fabrik");
    expect(checkouts[0]).toContain("ref: ${{ needs.kit.outputs.sha }}");
    expect(checkouts[0]).toContain("path: kit");
    expect(checkouts[0]).toContain("persist-credentials: false");
    expect(steps.indexOf(checkouts[0]!)).toBeLessThan(run);
  });

  // ADR-0002: the job running an agent holds no write credential.
  it("holds no write credential: read-only access to the Ticket, and only the agent service account", () => {
    const permissions = /\n    permissions:\n((?: {6}.*\n)+)/.exec(judge())?.[1] ?? "";

    expect(permissions.split("\n").filter((line) => line !== "" && !line.trimStart().startsWith("#"))).toEqual(["      issues: read"]);
    expect([...judge().matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1])).toEqual(["OP_AGENT_TOKEN"]);
    expect(judge()).not.toMatch(/create-github-app-token|id-token|: write\b/);
  });

  it("stops at the Kit's judge timeout, never Kit config's", () => {
    expect(judge()).toMatch(new RegExp(`\\n    timeout-minutes: ${JUDGE_TIMEOUT_MINUTES}\\n`));
  });

  it("passes out how its secrets loaded, and the model and effort it ran, for the judge's Run record", () => {
    expect(judge()).toContain("secrets-step: ${{ steps.judge.outputs.secrets-step }}");
    expect(judge()).toContain("model: ${{ steps.judge.outputs.model }}");
    expect(judge()).toContain("effort: ${{ steps.judge.outputs.effort }}");
    expect(stepsOf(judge()).find((step) => step.includes("uses: ./kit/.github/actions/run-judge"))).toContain("id: judge");
  });
});

describe("loop.yml's score-record job", () => {
  const scoreRecord = (): string => job("score-record");

  it("runs after the judge job, whether it succeeded or failed, unless the run was cancelled, and never fails the run", () => {
    expect(scoreRecord()).toMatch(new RegExp(`\\n    needs: \\[kit, push, ${JUDGE_JOB}\\]\\n`));
    expect(scoreRecord()).toContain(`\n    if: \${{ !cancelled() && needs.${JUDGE_JOB}.result != 'skipped' }}\n`);
    expect(scoreRecord()).toContain("\n    continue-on-error: true\n");
  });

  // Its action mints that one token, for fabrik-runs alone with Contents write (see its tests below).
  it("holds no token but the store's: no job permissions, and only the push service account, for the score-record action", () => {
    const write = stepsOf(scoreRecord()).find((step) => step.includes("uses: ./kit/.github/actions/write-score-record"));

    expect(scoreRecord()).toContain("\n    permissions: {}\n");
    expect([...scoreRecord().matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1])).toEqual(["OP_PUSH_TOKEN"]);
    expect(write).toContain("op-push-token: ${{ secrets.OP_PUSH_TOKEN }}");
    expect(scoreRecord()).not.toMatch(/create-github-app-token|id-token/);
  });

  it("runs no Product code: it checks out only the Kit, and reads how the judge ended from FABRIK_NEEDS", () => {
    const steps = stepsOf(scoreRecord());
    const checkouts = steps.filter((step) => step.includes("uses: actions/checkout@"));
    const write = steps.findIndex((step) => step.includes("uses: ./kit/.github/actions/write-score-record"));

    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toContain("repository: jrey8343/fabrik");
    expect(checkouts[0]).toContain("ref: ${{ needs.kit.outputs.sha }}");
    expect(checkouts[0]).toContain("path: kit");
    expect(checkouts[0]).toContain("persist-credentials: false");
    expect(steps.indexOf(checkouts[0]!)).toBeLessThan(write);
    expect(scoreRecord()).toContain("FABRIK_NEEDS: ${{ toJSON(needs) }}");
    expect(steps[write]).toContain("record: ${{ needs.push.outputs.record }}");
  });
});

describe("loop.yml's scoring jobs", () => {
  it.each([JUDGE_JOB, "score-record"])("%s leaves reading and writing GitHub to the Kit's actions, never inline gh calls or shell steps", (name) => {
    expect(job(name)).not.toMatch(/\bgh (api|issue|pr|repo|release|run|workflow) /);
    expect(job(name)).not.toMatch(/\n\s+run: /);
  });
});

describe("loop.yml's UI evidence capture in the Implement job (#153)", () => {
  const implement = () => job("implement");
  const steps = () => stepsOf(implement());
  const stepAt = (pattern: string) => steps().findIndex((step) => step.includes(pattern));
  const step = (pattern: string) => steps()[stepAt(pattern)] ?? "";
  const capture = () => step("name: Capture UI evidence");
  const evidence = () => step("name: Keep the UI evidence\n");
  const gallery = () => step("name: Keep the UI evidence gallery");

  it("captures after the Implementer's agent has ended and before its result goes to the push job, from the Kit's program", () => {
    expect(stepAt("name: Capture UI evidence")).toBeGreaterThan(stepAt("id: agent\n"));
    expect(stepAt("name: Capture UI evidence")).toBeLessThan(stepAt("name: fabrik-agent-result"));
    expect(stepAt("id: agent\n")).toBeGreaterThan(-1);
    expect(capture()).toContain("id: capture\n");
    expect(capture()).toMatch(/working-directory: product\n(?:.*\n)*?\s+run: node \.\.\/kit\/src\/evidence\/capture-main\.ts\n/);
  });

  it("can't fail the job: it goes on when capture fails, and stops at the Kit's capture timeout", () => {
    expect(capture()).toContain("continue-on-error: true");
    expect(capture()).toContain(`timeout-minutes: ${CAPTURE_TIMEOUT_MINUTES}\n`);
  });

  it("hands capture no secret: neither the 1Password step's outputs nor any GitHub token", () => {
    expect(capture()).not.toMatch(/FABRIK_SECRETS|steps\.op\.|secrets\.|github\.token|GH_TOKEN|GITHUB_TOKEN/);
  });

  it("keeps the gallery unzipped, so it opens in one click, and the screenshots and capture result zipped, both for 30 days", () => {
    expect(gallery()).toContain("uses: actions/upload-artifact@");
    expect(gallery()).toContain("id: gallery\n");
    expect(gallery()).toContain(`path: \${{ runner.temp }}/fabrik-out/${GALLERY_FILE}\n`);
    expect(gallery()).toContain("archive: false\n");
    expect(gallery()).toContain("retention-days: 30\n");

    expect(evidence()).toContain("uses: actions/upload-artifact@");
    expect(evidence()).toContain("id: evidence\n");
    expect(evidence()).toContain("name: fabrik-ui-evidence\n");
    expect(evidence()).toContain(`path: \${{ runner.temp }}/fabrik-out/${EVIDENCE_DIR}/\n`);
    expect(evidence()).not.toContain("archive:");
    expect(evidence()).toContain("retention-days: 30\n");
  });

  // The push job downloads fabrik-agent-* and reads an empty download as a timeout.
  it("keeps the evidence only when capture recorded a result, apart from the push job's artifacts, never failing the job", () => {
    for (const upload of [evidence(), gallery()]) {
      expect(upload).toContain("if: steps.capture.outputs.ui-capture-result != ''\n");
      expect(upload).toContain("continue-on-error: true");
      expect(upload).toContain("if-no-files-found: ignore");
      expect(upload).not.toMatch(/name: fabrik-agent-/);
    }
    expect(GALLERY_FILE).not.toMatch(/^fabrik-agent-/);
    expect(stepAt("name: Keep the UI evidence\n")).toBeGreaterThan(stepAt("name: Capture UI evidence"));
    expect(stepAt("name: Keep the UI evidence gallery")).toBeGreaterThan(stepAt("name: Capture UI evidence"));
  });

  it("passes out the capture result and the ids of both evidence artifacts, for the push job", () => {
    expect(implement()).toContain("ui-capture-result: ${{ steps.capture.outputs.ui-capture-result }}");
    expect(implement()).toContain("ui-evidence-artifact: ${{ steps.evidence.outputs.artifact-id }}");
    expect(implement()).toContain("ui-gallery-artifact: ${{ steps.gallery.outputs.artifact-id }}");
  });

  // Switched on (#239): no gate is left, so every UI PR in a repo with a ui block captures evidence.
  it("is active: capture runs on every Implement run whose agent ended well, and both uploads whenever it recorded a result", () => {
    expect(capture()).toContain("if: success()\n");
    expect(evidence()).toContain("if: steps.capture.outputs.ui-capture-result != ''\n");
    expect(gallery()).toContain("if: steps.capture.outputs.ui-capture-result != ''\n");
    expect(implement()).not.toMatch(/if: false\b/);
  });

  it("stops the job at the Kit job's Implement job timeout, and its agent step at the Implement role's own", () => {
    expect(job("kit")).toContain("implement-job-timeout-minutes: ${{ steps.route.outputs.implement-job-timeout-minutes }}");
    expect(implement()).toMatch(/\n    timeout-minutes: \$\{\{ fromJSON\(needs\.kit\.outputs\.implement-job-timeout-minutes\) \}\}\n/);
    expect(step("id: agent\n")).toContain("timeout-minutes: ${{ fromJSON(needs.kit.outputs.implement-timeout-minutes) }}\n");
  });

  // V1's job timeout cancelled the job; the agent step's own fails it, so the job notes it for the push job (src/kit/pushJob.ts).
  it("notes an agent step its timeout stopped, and leaves that run no failure report, so the push job reads it as a timeout", () => {
    const started = stepAt("id: started\n");
    const timedOut = step("id: agent-time\n");

    expect(started).toBeGreaterThan(-1);
    expect(started).toBeLessThan(stepAt("id: agent\n"));
    expect(stepAt("id: agent-time\n")).toBeGreaterThan(stepAt("id: agent\n"));
    expect(timedOut).toContain("if: failure() && steps.agent.outcome == 'failure'\n");
    expect(timedOut).toContain("STARTED_AT: ${{ steps.started.outputs.at }}");
    expect(timedOut).toContain("TIMEOUT_MINUTES: ${{ needs.kit.outputs.implement-timeout-minutes }}");
    expect(implement()).toContain("agent-timed-out: ${{ steps.agent-time.outputs.timed-out }}");
    expect(step("name: fabrik-agent-failure")).toContain("if: failure() && steps.agent-time.outputs.timed-out != 'true'\n");
  });

  // The Kit job installs nothing, so its program, which reads capture's timeout, may import no package.
  it("leaves the Kit job's program importing no package at run time", () => {
    expect(job("kit")).toContain("run: node kit/src/kit/jobs.ts product");
    expect(packagesReachedBy("src/kit/jobs.ts")).toEqual([]);
  });

  // Only the capture program imports Playwright, and it runs after prepare-agent's npm ci.
  it("runs capture after the Kit is installed, the only program that imports Playwright", () => {
    expect(stepAt("name: Capture UI evidence")).toBeGreaterThan(stepAt("uses: ./kit/.github/actions/prepare-agent"));
    expect(packagesReachedBy("src/evidence/capture-main.ts")).toContain("src/evidence/capture-main.ts imports playwright-core");
    expect(packagesReachedBy("src/evidence/capture.ts")).toEqual([]);
  });
});

describe("loop.yml's claim job", () => {
  it("is named for what it claims of any run, a Ticket's, a research Decision's, a Design session's or a replay Ticket's, keeping its job id", () => {
    expect(job("implement-claim")).toMatch(/^ {2}implement-claim:\n {4}name: Claim the work\n/);
  });

  it("takes agent:design off as the Design session's first turn starts, agent:research as a Research run starts and agent:replay as a replay Ticket's run starts, as it takes agent:implement off", () => {
    expect(job("implement-claim")).toContain(
      "if: needs.kit.outputs.route == 'implement' || needs.kit.outputs.route == 'research' || needs.kit.outputs.route == 'replay' || (needs.kit.outputs.route == 'design' && github.event.label.name == 'agent:design')",
    );
  });
});

describe("schedule.yml's Design queue job", () => {
  const schedule = workflows.find((workflow) => workflow.path.endsWith("schedule.yml"))!.text;
  const scheduleJob = (name: string): string => {
    const body = schedule.split(/\n(?=  [a-z-]+:\n)/).find((section) => section.startsWith(`  ${name}:\n`));
    if (body === undefined) throw new Error(`schedule.yml has no ${name} job`);
    return body;
  };

  it("runs a Design queue check when the tick's plan asked for one", () => {
    expect(scheduleJob("tick")).toContain("design-queue: ${{ steps.loop.outputs.design-queue }}");
    expect(scheduleJob("tick")).toMatch(/id: loop\n\s+uses: \.\/kit\/\.github\/actions\/run-loop/);
    expect(scheduleJob("design-queue")).toContain("needs.tick.outputs.design-queue == 'true'");
    expect(scheduleJob("design-queue")).toContain('FABRIK_DESIGN_QUEUE_CHECK: "true"');
  });

  it("shares loop.yml's per-repo concurrency group, so a tick's check and an event's can't fill the same free slot", () => {
    expect(scheduleJob("design-queue")).toMatch(/concurrency:\n\s+group: fabrik-design-queue\n\s+cancel-in-progress: false\n/);
  });

  it("asks for no permission the caller's tick job doesn't grant, so taking it needs no change to the shim", () => {
    expect(scheduleJob("design-queue")).toContain("permissions: {}");
    expect(scheduleJob("design-queue")).not.toContain("actions-token");
  });
});

describe("The conflict check's turns (#341)", () => {
  const schedule = workflows.find((workflow) => workflow.path.endsWith("schedule.yml"))!.text;
  const tick = schedule.split(/\n(?=  [a-z-]+:\n)/).find((section) => section.startsWith("  tick:\n")) ?? "";

  it("runs a push to the default branch's check in the tick's group, queueing, so the two never note the same Request changes; every other push job runs at once", () => {
    expect(jobIn(loop, "push")).toContain(
      "\n    concurrency:\n      group: ${{ github.event_name == 'push' && 'fabrik-tick' || format('fabrik-push-{0}', github.run_id) }}\n      cancel-in-progress: false\n      queue: max\n",
    );
    expect(tick).toMatch(/\n    concurrency:\n {6}group: fabrik-tick\n {6}cancel-in-progress: false\n {6}queue: max\n/);
  });

  it("gives the Implementer the Product repo's default branch, which a Request-changes run on a conflicting PR merges in", () => {
    // On the agent step itself: the capture step after it has the same line.
    const agent = stepsOf(jobIn(loop, "implement")).find((step) => step.includes("name: Run the Implementer"));
    expect(agent).toContain("FABRIK_DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}");
  });

  it("passes the push job main's head as the Kit job read it, from the Kit job, which no agent runs in", () => {
    expect(jobIn(loop, "kit")).toContain("\n      main-at-start: ${{ steps.route.outputs.main-at-start }}\n");
  });
});

describe("The store-token action, which the record actions share", () => {
  const action = readFileSync(new URL(".github/actions/store-token/action.yml", root), "utf8");
  const steps = action.split(/\n(?=    - )/);
  const storeToken = steps.find((step) => step.includes("id: store\n"));
  const kitConfigToken = steps.find((step) => step.includes("id: kit-config\n"));

  it("loads the Fabrik App key through the push service account, and nothing else", () => {
    const secrets = steps.filter((step) => step.includes("1password/load-secrets-action@"));

    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ inputs.op-push-token }}");
    expect([...secrets[0]!.matchAll(/: (op:\/\/\S.*)$/gm)].map((match) => match[1])).toEqual([
      "op://Fabrik App/Fabrik App/client-id",
      "op://Fabrik App/Fabrik App/private-key",
    ]);
  });

  it("mints the store's token for fabrik-runs alone, with Contents write and nothing else", () => {
    expect(storeToken).toContain("uses: actions/create-github-app-token@");
    expect(storeToken).toMatch(/owner: jrey8343\n/);
    expect(storeToken).toMatch(/repositories: fabrik-runs\n/);
    expect(permissionsOf(storeToken)).toEqual(["contents: write"]);
  });

  it("goes on when the store's token can't be minted, so the program can name the missing setup step", () => {
    expect(storeToken).toContain("continue-on-error: true");
  });

  // A missing store is setup not done: one quiet line, and no step's error annotation on every run.
  it("mints the store's token only once the program has found the Fabrik App on fabrik-runs", () => {
    const find = steps.find((step) => step.includes("id: find-store"));
    const program = /run: node (src\/\S+)/.exec(find ?? "")?.[1];

    expect(find, "no step finds the store").toBeDefined();
    expect(existsSync(new URL(program!, root))).toBe(true);
    expect(steps.indexOf(find!)).toBeLessThan(steps.indexOf(storeToken!));
    expect(storeToken).toContain("if: steps.find-store.outputs.installed == 'true'");
  });

  it("mints a token that reads the Product's Kit config only when asked, with Contents read and nothing else", () => {
    expect(kitConfigToken).toContain("uses: actions/create-github-app-token@");
    expect(kitConfigToken).toContain("if: inputs.kit-config-token == 'true'");
    expect(kitConfigToken).not.toContain("repositories:");
    expect(permissionsOf(kitConfigToken)).toEqual(["contents: read"]);
    expect(action).toMatch(/\n  kit-config-token:\n(?:.*\n)*?\s+default: "false"\n/);
  });

  it("passes out the tokens it minted, empty for one it didn't", () => {
    expect(action).toMatch(/\n  store-token:\n.*\n\s+value: \$\{\{ steps\.store\.outputs\.token \}\}\n/);
    expect(action).toMatch(/\n  kit-config-token:\n.*\n\s+value: \$\{\{ steps\.kit-config\.outputs\.token \}\}\n/);
  });
});

describe("The write the Run record action", () => {
  const action = readFileSync(new URL(".github/actions/write-run-record/action.yml", root), "utf8");
  const steps = action.split(/\n(?=    - )/);
  const tokens = steps.find((step) => step.includes("uses: ./kit/.github/actions/store-token"));

  it("builds and writes the record with the Kit's Node program, never inline gh calls", () => {
    const program = /run: node (src\/\S+)/.exec(action)?.[1];

    expect(program).toBeDefined();
    expect(existsSync(new URL(program!, root))).toBe(true);
    expect(action).not.toMatch(/\bgh (api|issue|pr|repo) /);
  });

  it("gets the store's token, and one that reads the Kit config, from the store-token action, holding the App key nowhere else", () => {
    expect(tokens).toContain("id: tokens");
    expect(tokens).toContain("op-push-token: ${{ inputs.op-push-token }}");
    expect(tokens).toContain('kit-config-token: "true"');
    expect(action).not.toMatch(/create-github-app-token|load-secrets-action/);
  });

  it("writes the record with those tokens", () => {
    const write = steps.find((step) => step.includes("run: node src/kit/record-main.ts"));

    expect(write).toContain("FABRIK_PRODUCT_TOKEN: ${{ steps.tokens.outputs.kit-config-token }}");
    expect(write).toContain("FABRIK_STORE_TOKEN: ${{ steps.tokens.outputs.store-token }}");
    expect(steps.indexOf(tokens!)).toBeLessThan(steps.indexOf(write!));
  });

  it("takes the role's transcript, and a missing one is fine", () => {
    const download = steps.find((step) => step.includes("actions/download-artifact@"));

    expect(download).toContain("fabrik-transcript-");
    expect(download).toContain("continue-on-error: true");
  });

  // The scoring plan runs inside the record step (#149), on the record it just wrote.
  it("passes out the scoring plan's ask for a score, and the scored record's path, from its program's step", () => {
    const write = steps.find((step) => step.includes("run: node src/kit/record-main.ts"));

    expect(write).toContain("id: record");
    expect(action).toMatch(/\n  score:\n.*\n\s+value: \$\{\{ steps\.record\.outputs\.score \}\}\n/);
    expect(action).toMatch(/\n  record:\n.*\n\s+value: \$\{\{ steps\.record\.outputs\.record \}\}\n/);
  });
});

describe("The weekly summary workflow", () => {
  const weekly = workflows.find((workflow) => workflow.path.endsWith("weekly-summary.yml"))!.text;
  const action = readFileSync(new URL(".github/actions/file-weekly-summary/action.yml", root), "utf8");
  const steps = action.split(/\n(?=    - )/);
  const tokens = steps.filter((step) => step.includes("uses: actions/create-github-app-token@"));

  it("is called from the fabrik-runs caller with its push service account, and runs the Kit's composite action", () => {
    expect(weekly).toMatch(/on:\n {2}workflow_call:\n {4}secrets:\n {6}OP_PUSH_TOKEN:/);
    expect(weekly).toContain("jrey8343/fabrik/.github/workflows/weekly-summary.yml@*)");
    expect(weekly).toContain("uses: ./kit/.github/actions/file-weekly-summary");
  });

  it("leaves reading and filing to the Kit's Node program, never inline gh calls", () => {
    const program = /run: node (src\/\S+)/.exec(action)?.[1];

    expect(program).toBeDefined();
    expect(existsSync(new URL(program!, root))).toBe(true);
    for (const text of [weekly, action]) expect(text).not.toMatch(/\bgh (api|issue|pr|repo) /);
  });

  it("holds only two Fabrik App tokens: Issues write and Contents read on fabrik-runs, and read-only on the Product repos", () => {
    const store = tokens.find((step) => step.includes("repositories: fabrik-runs"));
    const products = tokens.find((step) => step !== store);

    expect(tokens).toHaveLength(2);
    expect(store).toMatch(/owner: jrey8343\n/);
    expect(permissionsOf(store)).toEqual(["contents: read", "issues: write"]);
    expect(products).toMatch(/owner: jrey8343\n/);
    expect(products).not.toContain("repositories:");
    expect(permissionsOf(products)).toEqual(["contents: read", "issues: read", "pull-requests: read"]);
  });

  it("tells the program the Fabrik App's slug, from the token it minted, to tell its label events from other Apps'", () => {
    const run = steps.find((step) => step.includes("run: node src/kit/weekly-main.ts"));

    expect(run).toContain("FABRIK_APP_SLUG: ${{ steps.store.outputs.app-slug }}");
  });

  it("reads the store's records and score files from a sparse checkout of runs/ and scores/, never its transcripts", () => {
    const checkout = steps.find((step) => step.includes("uses: actions/checkout@"));

    expect(checkout).toContain("repository: jrey8343/fabrik-runs");
    expect(checkout).toMatch(/sparse-checkout: \|\n {10}runs\n {10}scores\n {8}\S/);
    expect(checkout).toContain("sparse-checkout-cone-mode: true");
    expect(checkout).toContain("persist-credentials: false");
    expect(action).not.toContain("transcripts/");
  });
});


/**
 * What a Kit source file imports at run time: every import and re-export but
 * `import type` and `export type`, the only ones Node strips whole.
 */
function runtimeImportsOf(source: string): string[] {
  const statements = source.matchAll(/^(?:import|export)\s+(type\s+)?(?:[\w*{}\s,]+?\s+from\s+)?["']([^"']+)["'];?$/gm);
  return [...statements].filter((match) => match[1] === undefined).map((match) => match[2]!);
}

/** Each package a Kit program reaches through its imports at run time, as `<file> imports <package>`. */
function packagesReachedBy(program: string): string[] {
  const seen = new Set<string>();
  const reached: string[] = [];
  const visit = (file: URL) => {
    if (seen.has(file.href)) return;
    seen.add(file.href);
    for (const specifier of runtimeImportsOf(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) visit(new URL(specifier, file));
      else if (!specifier.startsWith("node:")) reached.push(`${file.href.slice(root.href.length)} imports ${specifier}`);
    }
  };
  visit(new URL(program, root));
  return reached;
}

describe("The Kit's composite actions", () => {
  it.each(actions)("$name leaves reading and writing GitHub to the Kit's Node programs, never inline gh calls", ({ text }) => {
    expect(text).not.toMatch(/\bgh (api|issue|pr|repo|release|run|workflow) /);
  });

  // A composite action's `uses: ./` path starts at the workspace, where every workflow checks the Kit out at kit/.
  it.each(actions)("$name uses only composite actions the Kit ships, through its kit/ checkout", ({ text }) => {
    for (const [, path] of text.matchAll(/uses: (\.\/\S+)/g)) {
      expect(path).toMatch(/^\.\/kit\/\.github\/actions\/[a-z-]+$/);
      expect(existsSync(new URL(`${path!.slice("./kit/".length)}/action.yml`, root)), path).toBe(true);
    }
  });

  it.each(actions)("$name runs only Node programs the Kit ships", ({ text }) => {
    const programs = [...text.matchAll(/run: node (?:kit\/)?(src\/\S+)/g)].map((match) => match[1]!);

    for (const program of programs) expect(existsSync(new URL(program, root)), program).toBe(true);
  });

  // Push-job-shaped programs (src/main.ts, the record writers) run without `npm ci`: only the agent's actions install
  // Sandcastle, themselves or through prepare-agent.
  it.each(actions.filter(({ text }) => !text.includes("run: npm ci") && !text.includes("uses: ./kit/.github/actions/prepare-agent")))(
    "$name, which installs nothing, runs only programs that import no package at run time",
    ({ text }) => {
      const programs = [...text.matchAll(/run: node (?:kit\/)?(src\/\S+)/g)].map((match) => match[1]!);

      expect(programs.length).toBeGreaterThan(0);
      for (const program of programs) expect(packagesReachedBy(program), program).toEqual([]);
    },
  );

  it("can tell a program that imports a package at run time", () => {
    expect(packagesReachedBy("src/kit/judge-main.ts")).toEqual(expect.arrayContaining(["src/kit/judge-main.ts imports @ai-hero/sandcastle"]));
  });
});

describe("The judge action", () => {
  const action = readFileSync(new URL(".github/actions/run-judge/action.yml", root), "utf8");
  const steps = action.split(/\n(?=    - )/);
  const step = (pattern: string) => steps.findIndex((candidate) => candidate.includes(pattern));

  it("checks nothing out, so the judge job's Kit checkout is all it has: never the Product repo", () => {
    expect(action).not.toContain("actions/checkout@");
  });

  it("holds no write credential: no Fabrik App token, and only the Claude token, through the agent service account", () => {
    const secrets = steps.filter((candidate) => candidate.includes("1password/load-secrets-action@"));

    expect(action).not.toContain("create-github-app-token");
    expect(action).not.toMatch(/OP_PUSH_TOKEN|OP_IMPLEMENT_TOKEN|op-push-token|id-token/);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ inputs.op-agent-token }}");
    expect([...secrets[0]!.matchAll(/: (op:\/\/\S.*)$/gm)].map((match) => match[1])).toEqual(["op://Fabrik/${{ inputs.subscription }}/credential"]);
  });

  it("reads the Ticket with the read-only token before the Claude token loads, and never gives the judge that token", () => {
    const ticket = step("run: node src/kit/judge-ticket-main.ts");
    const judge = steps[step("run: node src/kit/judge-main.ts")]!;

    expect(ticket).toBeGreaterThan(-1);
    expect(steps[ticket]).toContain("GH_TOKEN: ${{ inputs.github-token }}");
    expect(ticket).toBeLessThan(step("1password/load-secrets-action@"));
    expect(judge).toContain("id: judge");
    expect(judge).not.toContain("inputs.github-token");
  });

  it("judges the Implement run's transcript, and a missing one is the judge's failure, not the step's", () => {
    const download = steps[step("actions/download-artifact@")]!;

    expect(download).toContain("name: fabrik-transcript-implement");
    expect(download).toContain("continue-on-error: true");
  });

  it("leaves its answer or failure report for the score-record job, and its own transcript apart from them", () => {
    const result = steps[step("name: fabrik-judge-result")]!;
    const failure = steps[step("name: fabrik-judge-failure")]!;
    const transcript = steps[step("name: fabrik-transcript-score")]!;

    expect(result).toMatch(/path: .*\/judge-result\.json\n/);
    expect(failure).toContain("if: failure()");
    expect(failure).toMatch(/path: .*\/judge-failure\.json\n/);
    expect(transcript).toContain("if: always()");
    expect(transcript).toContain("continue-on-error: true");
    expect(transcript).toMatch(/path: .*transcript\.jsonl\.gz/);
    expect(action).toMatch(/if: always\(\)\n\s+continue-on-error: true\n\s+shell: bash\n\s+run: .*gzip.*transcript\.jsonl/);
  });

  it("passes out how its secrets loaded, its model and its effort, for the judge's Run record", () => {
    expect(action).toMatch(/\n  secrets-step:\n.*\n\s+value: \$\{\{ steps\.op\.outcome \}\}\n/);
    expect(action).toMatch(/\n  model:\n.*\n\s+value: \$\{\{ steps\.judge\.outputs\.model \}\}\n/);
    expect(action).toMatch(/\n  effort:\n.*\n\s+value: \$\{\{ steps\.judge\.outputs\.effort \}\}\n/);
  });
});

describe("The score-record action", () => {
  const action = readFileSync(new URL(".github/actions/write-score-record/action.yml", root), "utf8");
  const steps = action.split(/\n(?=    - )/);
  const tokens = steps.find((step) => step.includes("uses: ./kit/.github/actions/store-token"));

  // The store-token action mints it for fabrik-runs alone, with Contents write (see its tests above).
  it("gets one token, the store's, from the store-token action, and none that reads the Product repo", () => {
    expect(tokens).toContain("id: tokens");
    expect(tokens).toContain("op-push-token: ${{ inputs.op-push-token }}");
    expect(tokens).not.toContain("kit-config-token");
    expect(action).not.toMatch(/create-github-app-token|load-secrets-action/);
  });

  it("runs no agent and no Product code: no checkout, no Claude token", () => {
    expect(action).not.toContain("actions/checkout@");
    expect(action).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("takes the judge's answer or failure report and its transcript, and missing ones are fine", () => {
    const downloads = steps.filter((step) => step.includes("actions/download-artifact@"));

    expect(downloads.find((step) => step.includes("pattern: fabrik-judge-*"))).toContain("continue-on-error: true");
    expect(downloads.find((step) => step.includes("name: fabrik-transcript-score"))).toContain("continue-on-error: true");
  });

  it("writes with the store's token, and the scored run's record path it was given", () => {
    const write = steps.find((step) => step.includes("run: node src/kit/score-record-main.ts"));

    expect(write).toContain("FABRIK_STORE_TOKEN: ${{ steps.tokens.outputs.store-token }}");
    expect(write).toContain("FABRIK_SCORED_RECORD: ${{ inputs.record }}");
  });
});

// The Retro evidence job's (#151), the first of a Retro run. Kit-only like the push job, and read-only: ADR-0009's addendum.
describe("The Retro evidence action", () => {
  const { text, steps } = actionNamed("gather-retro-evidence");
  const tokens = steps.filter((step) => step.includes("uses: actions/create-github-app-token@"));
  const checkout = steps.find((step) => step.includes("uses: actions/checkout@"));
  const gather = steps.find((step) => step.includes("run: node src/kit/retro-evidence-main.ts"));
  const upload = steps.find((step) => step.includes("uses: actions/upload-artifact@"));

  it("runs no agent and no Product code: it checks out only the store, loads no Claude token and installs nothing", () => {
    expect(steps.filter((step) => step.includes("uses: actions/checkout@"))).toEqual([checkout]);
    expect(checkout).toContain("repository: jrey8343/fabrik-runs");
    expect(text).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN|OP_AGENT_TOKEN|op-agent-token|prepare-agent|npm ci|src\/agent\/run\.ts/);
  });

  it("loads the Fabrik App key through the push service account, and nothing else", () => {
    const secrets = steps.filter((step) => step.includes("1password/load-secrets-action@"));

    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toContain("id: op\n");
    expect(secrets[0]).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ inputs.op-push-token }}");
    expect([...secrets[0]!.matchAll(/: (op:\/\/\S.*)$/gm)].map((match) => match[1])).toEqual([
      "op://Fabrik App/Fabrik App/client-id",
      "op://Fabrik App/Fabrik App/private-key",
    ]);
  });

  it("holds no write credential: one token with Contents read on fabrik-runs alone, and one read-only on this Product repo", () => {
    const store = tokens.find((step) => step.includes("repositories: fabrik-runs"));
    const product = tokens.find((step) => step !== store);

    expect(tokens).toHaveLength(2);
    expect(store).toMatch(/owner: jrey8343\n/);
    expect(permissionsOf(store)).toEqual(["contents: read"]);
    // With no owner or repositories, the token is for the repository the workflow runs in.
    expect(product).not.toMatch(/owner:|repositories:/);
    expect(permissionsOf(product)).toEqual(["contents: read", "issues: read", "pull-requests: read"]);
    expect(text).not.toMatch(/: write\b/);
    expect(text).not.toMatch(/uses: \.\/kit\/\.github\/actions\/store-token|id-token/);
  });

  it("reads only this repo's Run records, score files and transcripts, from a sparse checkout of the store with no credential left behind", () => {
    const store = tokens.find((step) => step.includes("repositories: fabrik-runs"))!;

    expect(checkout).toContain(`token: \${{ steps.${/id: (\S+)/.exec(store)?.[1]}.outputs.token }}`);
    expect(checkout).toMatch(
      /sparse-checkout: \|\n {10}runs\/\$\{\{ github\.repository \}\}\n {10}scores\/\$\{\{ github\.repository \}\}\n {10}transcripts\/\$\{\{ github\.repository \}\}\n {8}\S/,
    );
    expect(checkout).toContain("sparse-checkout-cone-mode: true");
    expect(checkout).toContain("persist-credentials: false");
  });

  it("builds the bundle with the Kit's program, from those tokens, the Fabrik App's slug and the store's checkout", () => {
    const store = /id: (\S+)/.exec(tokens.find((step) => step.includes("repositories: fabrik-runs"))!)?.[1];
    const product = /id: (\S+)/.exec(tokens.find((step) => !step.includes("repositories: fabrik-runs"))!)?.[1];

    expect(gather).toContain(`FABRIK_STORE_TOKEN: \${{ steps.${store}.outputs.token }}`);
    expect(gather).toContain(`FABRIK_PRODUCT_TOKEN: \${{ steps.${product}.outputs.token }}`);
    expect(gather).toContain(`FABRIK_APP_SLUG: \${{ steps.${product}.outputs.app-slug }}`);
    expect(gather).toContain("FABRIK_STORE_DIR: ${{ github.workspace }}/store");
    expect(checkout).toContain("path: store\n");
    expect(steps.indexOf(checkout!)).toBeLessThan(steps.indexOf(gather!));
  });

  it("leaves the bundle for the Retro job and the push job as fabrik-retro-evidence, and fails when there's none", () => {
    const outDir = /FABRIK_OUT_DIR: (.+)\n/.exec(gather ?? "")?.[1];

    expect(outDir).toBe("${{ runner.temp }}/fabrik-retro-evidence");

    expect(upload).toContain("name: fabrik-retro-evidence\n");
    expect(upload).toContain(`path: ${outDir}/${RETRO_EVIDENCE_FILE}\n`);
    expect(upload).toContain("if-no-files-found: error");
    expect(upload).toContain("retention-days: 7");
    expect(steps.indexOf(gather!)).toBeLessThan(steps.indexOf(upload!));
  });

  it("writes no Run record, and passes out how its secrets loaded, which the push job weighs when it fails", () => {
    expect(text).not.toMatch(/write-run-record|record-main/);
    expect(text).toMatch(/\n  secrets-step:\n.*\n\s+value: \$\{\{ steps\.op\.outcome \}\}\n/);
  });
});

// The Retro job's (#151), shaped like the Audit job: read-only, with only the Claude token.
describe("The Retro action", () => {
  const { text, steps } = actionNamed("run-retro");
  const step = (pattern: string) => steps.findIndex((candidate) => candidate.includes(pattern));
  const checkout = steps.find((candidate) => candidate.includes("uses: actions/checkout@"));
  const agent = steps.find((candidate) => candidate.includes("id: agent\n"));

  it("checks out only the Product repo's default branch, with its full history and no credential left behind", () => {
    expect(steps.filter((candidate) => candidate.includes("uses: actions/checkout@"))).toEqual([checkout]);
    expect(checkout).not.toContain("repository:");
    expect(checkout).toContain("path: product");
    expect(checkout).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(checkout).toContain("fetch-depth: 0");
    expect(checkout).toContain("persist-credentials: false");
  });

  // Before the secrets load, so a run whose agent never started still names it.
  it("notes the commit it checked out, before any secret loads", () => {
    expect(steps[step("id: base\n")]).toMatch(/run: echo "sha=\$\(git -C product rev-parse HEAD\)" >>"\$GITHUB_OUTPUT"/);
    expect(step("id: base\n")).toBeLessThan(step("1password/load-secrets-action@"));
  });

  it("holds no write credential: no Fabrik App token, and only the Claude token, through the agent service account", () => {
    const secrets = steps.filter((candidate) => candidate.includes("1password/load-secrets-action@"));

    expect(text).not.toMatch(/create-github-app-token|OP_PUSH_TOKEN|OP_IMPLEMENT_TOKEN|op-push-token|id-token/);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toContain("id: op\n");
    expect(secrets[0]).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ inputs.op-agent-token }}");
    expect([...secrets[0]!.matchAll(/: (op:\/\/\S.*)$/gm)].map((match) => match[1])).toEqual(["op://Fabrik/${{ inputs.subscription }}/credential"]);
  });

  // As every agent job's, the Claude token is the one of the Subscription the Kit job's routing chose.
  it("loads the Claude token of the Subscription it's given, which its job passes in from the Kit job", () => {
    expect(text).toMatch(/\n  subscription:\n\s+description: .*\n\s+required: true\n/);
    expect(text).toContain("#       subscription: ${{ needs.kit.outputs.subscription }}\n");
  });

  it("gives the agent no GitHub token: only prepare-agent reads the pending Retro, with the job's read-only token", () => {
    const prepare = steps[step("uses: ./kit/.github/actions/prepare-agent")];

    expect(prepare).toContain("github-token: ${{ inputs.github-token }}");
    expect(prepare).toContain("issue: ${{ github.event.issue.number }}");
    expect([...text.matchAll(/inputs\.github-token/g)]).toHaveLength(1);
    expect(agent).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|github-token/);
  });

  // The Base skills alone: the Retro takes no Extra skills (ADR-0008, src/skills/fetch.ts).
  it("passes its role to prepare-agent, which fetches the skills before any secret loads", () => {
    expect(steps[step("uses: ./kit/.github/actions/prepare-agent")]).toMatch(/\n\s+role: retro\n/);
    expect(step("uses: ./kit/.github/actions/prepare-agent")).toBeLessThan(step("1password/load-secrets-action@"));
  });

  it("takes the evidence job's bundle before the agent runs, where the push job takes it too, and hands it to the agent", () => {
    const download = steps[step("actions/download-artifact@")];

    expect(download).toContain("name: fabrik-retro-evidence\n");
    expect(download).toContain("path: ${{ runner.temp }}/retro-evidence\n");
    expect(download).not.toContain("continue-on-error");
    expect(agent).toContain(`FABRIK_RETRO_EVIDENCE_FILE: \${{ runner.temp }}/retro-evidence/${RETRO_EVIDENCE_FILE}`);
    expect(step("actions/download-artifact@")).toBeLessThan(steps.indexOf(agent!));
  });

  it("runs the Retro from the Product checkout, on the model and effort the Kit job's plan chose", () => {
    const program = /run: node \.\.\/kit\/(src\/\S+) retro\n?/.exec(agent ?? "")?.[1];

    expect(agent).toMatch(/\n\s+working-directory: product\n/);
    expect(program).toBe("src/agent/run.ts");
    expect(existsSync(new URL(program!, root))).toBe(true);
    expect(agent).toContain("CLAUDE_CODE_OAUTH_TOKEN: ${{ steps.op.outputs.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(agent).toContain("FABRIK_ISSUE_FILE: ${{ runner.temp }}/issue.json");
    expect(agent).toContain("FABRIK_MODEL: ${{ inputs.model }}");
    expect(agent).toContain("FABRIK_EFFORT: ${{ inputs.effort }}");
  });

  it("leaves its result or failure report for the push job, and keeps fabrik-transcript-retro apart from them, whether it passed, failed or timed out", () => {
    const result = steps[step("name: fabrik-agent-result\n")]!;
    const failure = steps[step("name: fabrik-agent-failure\n")]!;
    const transcript = steps[step("name: fabrik-transcript-retro\n")]!;

    expect(result).toMatch(/path: \$\{\{ runner\.temp \}\}\/fabrik-out\/agent-result\.json\n/);
    expect(result).toContain("if-no-files-found: error");
    expect(failure).toContain("if: failure()");
    expect(failure).toMatch(/path: \$\{\{ runner\.temp \}\}\/fabrik-out\/agent-failure\.json\n/);
    expect(failure).toContain("if-no-files-found: ignore");
    expect(transcript).toContain("if: always()");
    expect(transcript).toContain("continue-on-error: true");
    expect(transcript).toMatch(/path: .*transcript\.jsonl\.gz/);
    expect(transcript).toContain("if-no-files-found: ignore");
    expect(transcript).toContain("retention-days: 7");
    expect(text).toMatch(/if: always\(\)\n\s+continue-on-error: true\n\s+shell: bash\n\s+run: .*gzip.*transcript\.jsonl/);
    expect(agent).toContain("FABRIK_OUT_DIR: ${{ runner.temp }}/fabrik-out");
  });

  // The push job's record step takes the transcript the Kit job's route names: `retro` for a Retro run.
  it("keeps its transcript under the name the write the Run record action takes for the retro route", () => {
    const record = actionNamed("write-run-record").steps.find((candidate) => candidate.includes("actions/download-artifact@"));

    expect(record).toContain("name: fabrik-transcript-${{ inputs.role }}\n");
    expect(steps[step("name: fabrik-transcript-retro\n")]).toBeDefined();
  });

  it("passes out how its secrets loaded, the model and effort it ran and the commit it started from, for the push job and the Run record", () => {
    expect(text).toMatch(/\n  secrets-step:\n.*\n\s+value: \$\{\{ steps\.op\.outcome \}\}\n/);
    expect(text).toMatch(/\n  model:\n.*\n\s+value: \$\{\{ steps\.agent\.outputs\.model \}\}\n/);
    expect(text).toMatch(/\n  effort:\n.*\n\s+value: \$\{\{ steps\.agent\.outputs\.effort \}\}\n/);
    expect(text).toMatch(/\n  base-sha:\n.*\n\s+value: \$\{\{ steps\.base\.outputs\.sha \}\}\n/);
  });
});

/** A job's `permissions:` block, one `name: level` per entry, or `{}` for none. */
function permissionsIn(body: string): readonly string[] {
  if (/\n    permissions: \{\}\n/.test(body)) return ["{}"];
  const block = /\n    permissions:\n((?: {6}.*\n)+)/.exec(body)?.[1] ?? "";
  return block.trim().split("\n").map((line) => line.trim()).filter((line) => !line.startsWith("#"));
}

/** The push job's `needs`. */
const pushNeeds = (): readonly string[] => /\n    needs: \[(.*)\]\n/.exec(job("push"))?.[1]?.split(", ") ?? [];

// A Retro run's first job (#151): Kit-only like the push job, and read-only (ADR-0009's addendum).
describe("loop.yml's Retro evidence job", () => {
  const evidence = (): string => job(RETRO_EVIDENCE_JOB);
  const steps = (): readonly string[] => stepsOf(evidence());
  const gather = (): string | undefined => steps().find((step) => step.includes("uses: ./kit/.github/actions/gather-retro-evidence"));

  it("checks out only the Kit, at its pinned commit, and never the Product repo", () => {
    const checkouts = steps().filter((step) => step.includes("uses: actions/checkout@"));

    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toContain("repository: jrey8343/fabrik\n");
    expect(checkouts[0]).toContain("ref: ${{ needs.kit.outputs.sha }}");
    expect(checkouts[0]).toContain("path: kit\n");
    expect(checkouts[0]).toContain("persist-credentials: false");
  });

  it("holds no GitHub permission of its own, and only the push service account, which loads the Fabrik App key", () => {
    expect(permissionsIn(evidence())).toEqual(["{}"]);
    expect(gather()).toContain("op-push-token: ${{ secrets.OP_PUSH_TOKEN }}");
    expect(evidence()).not.toMatch(/OP_AGENT_TOKEN|OP_IMPLEMENT_TOKEN|id-token|github\.token|GH_TOKEN/);
  });

  it("mints a Contents-read token on fabrik-runs and no write token, through its action alone", () => {
    const { text, steps: actionSteps } = actionNamed("gather-retro-evidence");
    const tokens = actionSteps.filter((step) => step.includes("uses: actions/create-github-app-token@"));
    const store = tokens.filter((step) => step.includes("repositories: fabrik-runs"));

    expect(evidence()).not.toContain("create-github-app-token");
    expect(store).toHaveLength(1);
    expect(permissionsOf(store[0])).toEqual(["contents: read"]);
    expect(tokens.flatMap(permissionsOf).every((permission) => permission.endsWith(": read"))).toBe(true);
    expect(text).not.toMatch(/: write\b/);
  });

  it("inlines no gh calls, nor any other command: its action runs the Kit's program", () => {
    expect(evidence()).not.toMatch(/\n\s+run: /);
    expect(evidence()).not.toMatch(/\bgh /);
  });

  it("runs only when the Kit job routed to the Retro, within the Retro's timeout", () => {
    expect(evidence()).toContain("needs: kit\n");
    expect(evidence()).toContain("if: needs.kit.outputs.route == 'retro'");
    expect(evidence()).toContain("timeout-minutes: ${{ fromJSON(needs.kit.outputs.retro-timeout-minutes) }}");
    expect(job("kit")).toContain("retro-timeout-minutes: ${{ steps.route.outputs.retro-timeout-minutes }}");
  });

  it("passes out how its secrets loaded, which the push job weighs when it fails", () => {
    expect(gather()).toContain("id: evidence\n");
    expect(evidence()).toContain("secrets-step: ${{ steps.evidence.outputs.secrets-step }}");
  });
});

// A Retro run's second job (#151), shaped like the Audit job: read-only, with only the Claude token.
describe("loop.yml's Retro job", () => {
  const retro = (): string => job("retro");
  const steps = (): readonly string[] => stepsOf(retro());
  const run = (): string | undefined => steps().find((step) => step.includes("uses: ./kit/.github/actions/run-retro"));

  it("holds only read permissions", () => {
    expect(permissionsIn(retro())).toEqual(["contents: read", "issues: read", "pull-requests: read"]);
  });

  it("holds only the agent service account, which loads the Claude token, and no GitHub write credential", () => {
    expect(run()).toContain("op-agent-token: ${{ secrets.OP_AGENT_TOKEN }}");
    expect(run()).toContain("github-token: ${{ github.token }}");
    expect(retro()).not.toMatch(/OP_PUSH_TOKEN|OP_IMPLEMENT_TOKEN|id-token|GH_TOKEN|create-github-app-token/);
  });

  it("checks out the Kit alone, and runs the Retro through its action on the model and effort the Kit job's plan chose", () => {
    const checkouts = steps().filter((step) => step.includes("uses: actions/checkout@"));

    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toContain("repository: jrey8343/fabrik\n");
    expect(checkouts[0]).toContain("path: kit\n");
    expect(run()).toContain("id: retro\n");
    expect(run()).toContain("model: ${{ needs.kit.outputs.model }}");
    expect(run()).toContain("effort: ${{ needs.kit.outputs.effort }}");
    expect(steps().indexOf(checkouts[0]!)).toBeLessThan(steps().indexOf(run()!));
  });

  it("keeps fabrik-transcript-retro, which the push job's record step takes on the retro route", () => {
    const keep = actionNamed("run-retro").steps.find((step) => step.includes("name: fabrik-transcript-retro\n"));

    expect(keep).toContain("if: always()");
    expect(keep).toContain("continue-on-error: true");
    expect(stepsOf(job("push")).find((step) => step.includes("uses: ./kit/.github/actions/write-run-record"))).toContain(
      "role: ${{ needs.kit.outputs.route }}",
    );
  });

  it("runs only after the evidence job, when the Kit job routed to the Retro, within the Retro's timeout", () => {
    expect(retro()).toContain(`needs: [kit, ${RETRO_EVIDENCE_JOB}]\n`);
    expect(retro()).toContain("if: needs.kit.outputs.route == 'retro'");
    expect(retro()).toContain("timeout-minutes: ${{ fromJSON(needs.kit.outputs.retro-timeout-minutes) }}");
  });

  it("runs one Retro per repo at a time, queueing the next", () => {
    expect(retro()).toMatch(/\n    concurrency:\n {6}group: fabrik-retro\n {6}cancel-in-progress: false\n {6}queue: max\n/);
  });

  it("passes out how its secrets loaded, the model and effort it ran and the commit it started from, for the push job and the Run record", () => {
    for (const output of ["secrets-step", "model", "effort", "base-sha"]) {
      expect(retro()).toContain(`${output}: \${{ steps.retro.outputs.${output} }}`);
    }
  });
});

describe("loop.yml's push job, after a Retro run", () => {
  it("needs both the Retro evidence job and the Retro job, so it fills in or fails the Retro once they've ended", () => {
    expect(pushNeeds()).toEqual(expect.arrayContaining([RETRO_EVIDENCE_JOB, "retro"]));
  });

  // src/main.ts reads the evidence from $RUNNER_TEMP/retro-evidence, never from the agent's output.
  it("takes the evidence job's bundle on the retro route, before the Loop runs, and goes on without one", () => {
    const steps = stepsOf(job("push"));
    const download = steps.findIndex((step) => step.includes("name: fabrik-retro-evidence\n"));
    const loopStep = steps.findIndex((step) => step.includes("name: Run the Loop"));

    expect(download).toBeGreaterThan(-1);
    expect(steps[download]).toContain("uses: actions/download-artifact@");
    expect(steps[download]).toContain("if: needs.kit.outputs.route == 'retro'");
    expect(steps[download]).toContain("continue-on-error: true");
    expect(steps[download]).toContain("path: ${{ runner.temp }}/retro-evidence\n");
    expect(download).toBeLessThan(loopStep);
  });
});

// Which Subscription an agent run is on: the Kit job's routing chooses it, and
// every job that loads a Claude token loads that one's, and only that one.
describe("The Subscription each agent job runs on", () => {
  const SUBSCRIPTION_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN: op://Fabrik/${{ needs.kit.outputs.subscription }}/credential";
  const claudeTokensIn = (text: string) => [...text.matchAll(/CLAUDE_CODE_OAUTH_TOKEN: (op:\/\/\S.*)$/gm)].map((match) => match[1]);
  const judge = readFileSync(new URL(".github/actions/run-judge/action.yml", root), "utf8");

  it("loop.yml's Kit job passes out the Subscription its routing chose", () => {
    expect(jobIn(loop, "kit")).toContain("subscription: ${{ steps.route.outputs.subscription }}");
  });

  it.each(["triage", "design", "prototype", "implement", "review", "audit", "research"])(
    "loop.yml's %s job loads one Claude token: the Kit job's Subscription's",
    (name) => {
      const job = jobIn(loop, name);
      const loads = stepsOf(job).filter((step) => step.includes("CLAUDE_CODE_OAUTH_TOKEN: op://"));

      expect(loads).toHaveLength(1);
      expect(loads[0]).toContain("uses: 1password/load-secrets-action@");
      expect(loads[0]).toContain(SUBSCRIPTION_TOKEN);
      expect(claudeTokensIn(job)).toHaveLength(1);
    },
  );

  // The Retro job loads its token in its action, so the job's own text names none.
  it("a Retro run loads one Claude token: the Kit job's Subscription's, which its Retro job passes in, and its evidence job none", () => {
    const { text: runRetro } = actionNamed("run-retro");
    const retro = jobIn(loop, "retro");

    expect(stepsOf(retro).find((step) => step.includes("uses: ./kit/.github/actions/run-retro"))).toContain(
      "subscription: ${{ needs.kit.outputs.subscription }}",
    );
    expect(claudeTokensIn(retro)).toEqual([]);
    expect(runRetro).toMatch(/\n  subscription:\n\s+description: .*\n\s+required: true\n/);
    expect(claudeTokensIn(runRetro)).toEqual(["op://Fabrik/${{ inputs.subscription }}/credential"]);
    expect(claudeTokensIn(jobIn(loop, RETRO_EVIDENCE_JOB))).toEqual([]);
  });

  it("the judge loads one Claude token: the Kit job's Subscription's, which its Score job passes in", () => {
    expect(jobIn(loop, "score")).toContain("subscription: ${{ needs.kit.outputs.subscription }}");
    expect(judge).toMatch(/\n  subscription:\n\s+description: .*\n\s+required: true\n/);
    expect(claudeTokensIn(judge)).toEqual(["op://Fabrik/${{ inputs.subscription }}/credential"]);
  });

  it("the judge is told whether rotation is on, so its stream watch kills it on overage as an agent run's does", () => {
    expect(jobIn(loop, "kit")).toContain("rotation: ${{ steps.route.outputs.rotation }}");
    expect(jobIn(loop, "score")).toContain("rotation: ${{ needs.kit.outputs.rotation }}");
    expect(judge).toMatch(/\n  rotation:\n\s+description: .*\n\s+required: true\n/);
    expect(judge).toContain("FABRIK_ROTATION: ${{ inputs.rotation }}");
    expect(readFileSync(new URL("src/kit/judge-main.ts", root), "utf8")).toContain(
      'streamWatch(join(outDir, TRANSCRIPT_FILE), abort, { rotation: process.env["FABRIK_ROTATION"] === "true" })',
    );
  });

  it.each([...workflows, ...actions.map(({ name, text }) => ({ path: `.github/actions/${name}`, text }))])(
    "$path loads no more than one Claude token in any job, and names no Subscription itself",
    ({ text }) => {
      for (const section of text.split(/\n(?=  [a-z-]+:\n)/)) expect(claudeTokensIn(section).length).toBeLessThanOrEqual(1);
      expect(text).not.toContain("op://Fabrik/Claude token");
    },
  );

  it.each(["replay-implement", "replay-review"])("loop.yml's %s job loads no Claude token itself: its action loads the Kit job's Subscription's, which the job passes in", (name) => {
    const body = jobIn(loop, name);

    expect(claudeTokensIn(body)).toEqual([]);
    expect(body).toContain("subscription: ${{ needs.kit.outputs.subscription }}");
    expect(claudeTokensIn(actionNamed(name).text)).toEqual(["op://Fabrik/${{ inputs.subscription }}/credential"]);
  });
});

// A Replay Ticket's run (#156): the claim, then each arm's Implement, gates, Review and judge jobs as a
// matrix, then the replay-record job, the replay's own push job (ADR-0009's addendum). The composite actions
// they run hold their own steps' wiring (src/kit/replayActions.test.ts); these hold the jobs' own.
describe("loop.yml's replay jobs", () => {
  /** Only on the Ticket this run's claim marked in progress, which the Kit job routed on. */
  const CLAIMED = "needs.kit.outputs.route == 'replay' && needs.implement-claim.outputs.replay-ticket == needs.kit.outputs.ticket";
  const ARM_JOBS = ["replay-implement", "replay-gates", "replay-review", "replay-score"];
  const REPLAY_JOBS = [...ARM_JOBS, "replay-record"];
  /** Every write credential, or way to one, a job that runs an agent or Product code must never hold (ADR-0002). */
  const WRITE_CREDENTIALS = /create-github-app-token|OP_PUSH_TOKEN|op-push-token|id-token|actions\/store-token|actions\/run-loop|actions\/replay-record|: write\b/;
  /** A job's YAML without its comments, which name other jobs' credentials. */
  const codeOf = (body: string) => body.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  const secretsIn = (body: string) => [...body.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]);
  const usesIn = (body: string) => [...body.matchAll(/uses: \.\/kit\/\.github\/actions\/([a-z-]+)/g)].map((match) => match[1]);
  const needsOf = (body: string) => /\n    needs: \[(.*)\]\n/.exec(body)?.[1]?.split(", ") ?? [];

  it("the Kit job passes out every output its routing writes, a replay's included: the replay issue, the Ticket's baseSha and each arm's settings", () => {
    const kit = jobIn(loop, "kit");

    for (const output of Object.keys(kitJobOutputs(null, null, kitConfig()))) {
      expect(kit, output).toContain(`\n      ${output}: \${{ steps.route.outputs.${output} }}\n`);
    }
  });

  // Each arm's settings hold the replay issue's model names, the Operator's text: in a run: script they could inject a command.
  it("reads each arm's settings only through an action's inputs, never in a run: script", () => {
    const lines = loop.split("\n").filter((line) => line.includes("replay-arms") && !line.trimStart().startsWith("#"));

    expect(lines).toContainEqual("      replay-arms: ${{ steps.route.outputs.replay-arms }}");
    for (const line of lines.filter((use) => !use.includes("steps.route.outputs"))) expect(line).toBe("          replay-arms: ${{ needs.kit.outputs.replay-arms }}");
  });

  it("claims the replay Ticket with the claim job, which passes out the Ticket it marked in progress in this run", () => {
    const claim = job("implement-claim");
    const loopStep = stepsOf(claim).find((step) => step.includes("uses: ./kit/.github/actions/run-loop"));

    expect(claim).toMatch(/\n    if: .*needs\.kit\.outputs\.route == 'replay'/);
    expect(claim).toContain("\n      replay-ticket: ${{ steps.claim.outputs.replay-ticket }}\n");
    expect(loopStep).toContain("id: claim\n");
    expect(actionNamed("run-loop").text).toMatch(/\n  replay-ticket:\n\s+description: .*\n\s+value: \$\{\{ steps\.loop\.outputs\.replay-ticket \}\}\n/);
    expect(readFileSync(new URL("src/main.ts", root), "utf8")).toContain("`replay-ticket=${claimed}\\n`");
  });

  it("claims one replay Ticket at a time across the repo, so two replay issues' claims can't both find none in progress, and holds back no other claim", () => {
    expect(job("implement-claim")).toContain(
      "\n    concurrency:\n      group: ${{ needs.kit.outputs.route == 'replay' && 'fabrik-replay-claim' || format('fabrik-claim-{0}', github.run_id) }}\n      cancel-in-progress: false\n      queue: max\n",
    );
  });

  it.each(REPLAY_JOBS)("%s runs only on the Ticket the claim marked in progress in this run, once the claim has", (name) => {
    expect(needsOf(job(name))).toEqual(expect.arrayContaining(["kit", "implement-claim"]));
    expect(/\n    if: (.*)\n/.exec(job(name))?.[1]).toContain(CLAIMED);
  });

  it.each(ARM_JOBS)("%s runs both arms as a matrix, neither one's failure cancelling the other's", (name) => {
    expect(job(name)).toContain(`\n    strategy:\n      fail-fast: false\n      matrix:\n        arm: [${REPLAY_ARMS.join(", ")}]\n`);
    expect(job(name)).toMatch(/\n    name: "Replay [a-z]+ \(\$\{\{ matrix\.arm \}\}\)"\n/);
    for (const step of stepsOf(job(name)).filter((one) => one.includes("uses: ./kit/.github/actions/replay-"))) {
      expect(step).toContain("arm: ${{ matrix.arm }}");
    }
  });

  it("runs the gates, Review and judge of each arm once its Implement job has ended, whatever it came to, unless the run was cancelled", () => {
    for (const name of ["replay-gates", "replay-review", "replay-score"]) {
      expect(needsOf(job(name)), name).toEqual(["kit", "implement-claim", "replay-implement"]);
      expect(job(name), name).toContain(`\n    if: \${{ !cancelled() && ${CLAIMED} }}\n`);
      // A matrix job's result covers both legs: each action sorts out its own arm.
      expect(job(name), name).not.toContain("needs.replay-implement.result");
    }
  });

  it.each(REPLAY_JOBS)("%s checks out the Kit alone into kit/, at its pinned commit, before the replay action it runs", (name) => {
    const steps = stepsOf(job(name));
    const checkouts = steps.filter((step) => step.includes("uses: actions/checkout@"));

    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toContain("repository: jrey8343/fabrik\n");
    expect(checkouts[0]).toContain("ref: ${{ needs.kit.outputs.sha }}");
    expect(checkouts[0]).toContain("path: kit");
    expect(checkouts[0]).toContain("persist-credentials: false");
    expect(steps.indexOf(checkouts[0]!)).toBe(0);
    expect(usesIn(job(name))).toEqual([name]);
  });

  it.each(REPLAY_JOBS)("%s leaves reading and writing GitHub to its action, never inline gh calls or shell steps", (name) => {
    expect(job(name)).not.toMatch(/\bgh (api|issue|pr|repo|release|run|workflow) /);
    expect(job(name)).not.toMatch(/\n\s+run: /);
  });

  it.each(REPLAY_JOBS)("%s gives its action every input the action requires, and no other", (name) => {
    const step = stepsOf(job(name)).find((one) => one.includes(`uses: ./kit/.github/actions/${name}`)) ?? "";
    const given = [...step.matchAll(/^ {10}([a-z-]+): /gm)].map((match) => match[1]);
    const required = [...actionNamed(name).text.matchAll(/^ {2}([a-z-]+):\n\s+description: .*\n\s+required: true$/gm)].map((match) => match[1]);

    expect(required.length).toBeGreaterThan(0);
    expect(given.toSorted()).toEqual(required.toSorted());
  });

  describe("replay implement", () => {
    const implement = () => job("replay-implement");

    it("is never named Implement, so Dispatch's count of Implement runs in flight passes both arms by", () => {
      const name = /\n    name: "(.*)"\n/.exec(implement())?.[1] ?? "";

      expect(name).not.toBe("");
      for (const arm of REPLAY_ARMS) {
        const shown = name.replace("${{ matrix.arm }}", arm);
        expect(shown).not.toBe(IMPLEMENT_JOB_NAME);
        expect(`fabrik / ${shown}`.endsWith(` / ${IMPLEMENT_JOB_NAME}`)).toBe(false);
      }
    });

    it("holds no write credential: read permissions, and only the implement service account", () => {
      expect(permissionsIn(implement())).toEqual(["contents: read", "issues: read"]);
      expect(secretsIn(implement())).toEqual(["OP_IMPLEMENT_TOKEN"]);
      expect(codeOf(implement())).not.toMatch(WRITE_CREDENTIALS);
    });

    it("runs within the Implement role's timeout, on the Kit job's Ticket, baseSha, arms and Subscription", () => {
      const step = stepsOf(implement()).find((one) => one.includes("uses: ./kit/.github/actions/replay-implement"));

      expect(implement()).toContain("\n    timeout-minutes: ${{ fromJSON(needs.kit.outputs.implement-timeout-minutes) }}\n");
      for (const input of ["ticket", "base-sha", "replay-arms", "subscription"]) expect(step).toContain(`${input}: \${{ needs.kit.outputs.${input} }}`);
      expect(step).toContain("op-implement-token: ${{ secrets.OP_IMPLEMENT_TOKEN }}");
      expect(step).toContain("github-token: ${{ github.token }}");
    });
  });

  describe("replay gates", () => {
    const gates = () => job("replay-gates");

    it("is never named Implement, and holds no write credential: read permissions, and only the implement service account, for the test secrets", () => {
      expect(/\n    name: "(.*)"\n/.exec(gates())?.[1]).not.toContain(IMPLEMENT_JOB_NAME);
      expect(permissionsIn(gates())).toEqual(["contents: read", "pull-requests: read"]);
      expect(secretsIn(gates())).toEqual(["OP_IMPLEMENT_TOKEN"]);
      expect(codeOf(gates())).not.toMatch(WRITE_CREDENTIALS);
    });

    it("runs within the Implement role's timeout, on the Kit job's Ticket, merged PR and baseSha", () => {
      const step = stepsOf(gates()).find((one) => one.includes("uses: ./kit/.github/actions/replay-gates"));

      expect(gates()).toContain("\n    timeout-minutes: ${{ fromJSON(needs.kit.outputs.implement-timeout-minutes) }}\n");
      for (const input of ["ticket", "pull-request", "base-sha"]) expect(step).toContain(`${input}: \${{ needs.kit.outputs.${input} }}`);
    });
  });

  describe("replay review", () => {
    const review = () => job("replay-review");

    it("holds only the agent service account, with read permissions and no write credential", () => {
      expect(permissionsIn(review())).toEqual(["contents: read", "issues: read"]);
      expect(secretsIn(review())).toEqual(["OP_AGENT_TOKEN"]);
      expect(codeOf(review())).not.toMatch(WRITE_CREDENTIALS);
    });

    it("runs within the Review role's timeout, on the Kit job's Ticket, baseSha, arms and Subscription", () => {
      const step = stepsOf(review()).find((one) => one.includes("uses: ./kit/.github/actions/replay-review"));

      expect(review()).toContain("\n    timeout-minutes: ${{ fromJSON(needs.kit.outputs.review-timeout-minutes) }}\n");
      for (const input of ["ticket", "base-sha", "replay-arms", "subscription"]) expect(step).toContain(`${input}: \${{ needs.kit.outputs.${input} }}`);
    });
  });

  it("scores each arm with only the agent service account, reading the Ticket and nothing else, within the Kit's judge timeout", () => {
    const score = job("replay-score");

    expect(permissionsIn(score)).toEqual(["issues: read"]);
    expect(secretsIn(score)).toEqual(["OP_AGENT_TOKEN"]);
    expect(codeOf(score)).not.toMatch(WRITE_CREDENTIALS);
    expect(score).toContain(`\n    timeout-minutes: ${JUDGE_TIMEOUT_MINUTES}\n`);
    expect(stepsOf(score).find((one) => one.includes("uses: ./kit/.github/actions/replay-score"))).toContain("kit-outputs: ${{ toJSON(needs.kit.outputs) }}");
  });

  // The tick releases a Ticket in progress longer than these jobs can take end to end (replayRunLimitMinutes).
  it("runs within the timeouts the tick counts a replay Ticket's run lasting at most", () => {
    const { kit, claim, record } = REPLAY_ROUTE_JOB_MINUTES;

    expect(job("kit")).toContain(`\n    timeout-minutes: ${kit}\n`);
    expect(job("implement-claim")).toContain(`\n    timeout-minutes: ${claim}\n`);
    expect(job("replay-record")).toContain(`\n    timeout-minutes: ${record}\n`);
    for (const name of ["replay-implement", "replay-gates"]) expect(job(name)).toContain("\n    timeout-minutes: ${{ fromJSON(needs.kit.outputs.implement-timeout-minutes) }}\n");
    expect(job("replay-review")).toContain("\n    timeout-minutes: ${{ fromJSON(needs.kit.outputs.review-timeout-minutes) }}\n");
  });

  describe("replay record, the replay's push job", () => {
    const record = () => job("replay-record");

    it("runs once, after every arm job, whatever they came to and even when the run was cancelled, so no Ticket stays in progress, and never fails the run", () => {
      expect(needsOf(record())).toEqual(["kit", "implement-claim", ...ARM_JOBS]);
      expect(record()).toContain(`\n    if: always() && ${CLAIMED}\n`);
      expect(record()).toContain("\n    continue-on-error: true\n");
      expect(record()).not.toContain("strategy:");
    });

    // Its action mints the store's token through store-token and the App token through run-loop (src/kit/replayActions.test.ts).
    it("checks out only the Kit and holds no permission of its own: only the push service account, which mints the store's token", () => {
      const step = stepsOf(record()).find((one) => one.includes("uses: ./kit/.github/actions/replay-record"));

      expect(permissionsIn(record())).toEqual(["{}"]);
      expect(secretsIn(record())).toEqual(["OP_PUSH_TOKEN"]);
      expect(step).toContain("op-push-token: ${{ secrets.OP_PUSH_TOKEN }}");
      expect(step).toContain("kit-outputs: ${{ toJSON(needs.kit.outputs) }}");
      expect(actionNamed("replay-record").text).toContain("uses: ./kit/.github/actions/store-token");
      expect(record()).not.toMatch(/OP_AGENT_TOKEN|OP_IMPLEMENT_TOKEN|create-github-app-token|id-token/);
    });
  });

  it("keeps the push job off the replay route, so the judge, score-record, Dispatch and Design queue jobs skip by themselves", () => {
    expect(job("push")).toContain("\n    if: always() && needs.kit.result == 'success' && needs.kit.outputs.route != 'none' && needs.kit.outputs.route != 'replay'\n");
    expect(pushNeeds().filter((need) => need.startsWith("replay-"))).toEqual([]);
  });
});

// The replay step's store reads (#156): the tick checks out the store only while a replay issue is open.
describe("schedule.yml's tick, which takes the Replays' next step", () => {
  const steps = () => stepsOf(jobIn(schedule, "tick"));

  it("checks out the store for the replay step before the Loop runs, and hands the Loop that checkout, never failing the tick on it", () => {
    const store = steps().findIndex((step) => step.includes("uses: ./kit/.github/actions/replay-store"));
    const run = steps().findIndex((step) => step.includes("uses: ./kit/.github/actions/run-loop"));

    expect(store).toBeGreaterThan(0);
    expect(store).toBeLessThan(run);
    expect(steps()[store]).toContain("id: replay-store\n");
    expect(steps()[store]).toContain("continue-on-error: true");
    expect(steps()[store]).toContain("op-push-token: ${{ secrets.OP_PUSH_TOKEN }}");
    expect(steps()[run]).toContain("store-dir: ${{ steps.replay-store.outputs.store-dir }}");
  });

  it("is the only job that checks the store out for the replay step", () => {
    expect([...workflows.map(({ text }) => text).join("\n").matchAll(/actions\/replay-store\b/g)]).toHaveLength(1);
  });
});

describe("The replay-store action, which checks out the store for the tick's replay step", () => {
  const { text, steps } = actionNamed("replay-store");
  const at = (pattern: string) => steps.findIndex((step) => step.includes(pattern));
  const open = () => steps[at("replay-store-main.ts")] ?? "";
  const checkout = () => steps[at("uses: actions/checkout@")] ?? "";

  it("loads the Fabrik App key through the push service account, and nothing else", () => {
    const loads = steps.filter((step) => step.includes("1password/load-secrets-action@"));

    expect(loads).toHaveLength(1);
    expect(loads[0]).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ inputs.op-push-token }}");
    expect([...loads[0]!.matchAll(/: (op:\/\/\S.*)$/gm)].map((match) => match[1])).toEqual([
      "op://Fabrik App/Fabrik App/client-id",
      "op://Fabrik App/Fabrik App/private-key",
    ]);
  });

  it("looks for an open replay issue with a token that only reads this repo's issues, before it finds or reads the store", () => {
    const product = steps[at("id: product\n")];

    expect(permissionsOf(product)).toEqual(["issues: read"]);
    expect(product).not.toContain("repositories:");
    expect(open()).toContain("GH_TOKEN: ${{ steps.product.outputs.token }}");
    expect(open()).toContain("id: open\n");
    expect(at("replay-store-main.ts")).toBeLessThan(at("find-store-main.ts"));
  });

  it("finds the store, and mints a token that only reads it, only while a replay issue is open, so a repo with none reads nothing new", () => {
    const store = steps[at("id: store\n")];

    expect(steps[at("find-store-main.ts")]).toContain("if: steps.open.outputs.open == 'true'");
    expect(store).toContain("if: steps.find-store.outputs.installed == 'true'");
    expect(store).toContain("repositories: fabrik-runs");
    expect(permissionsOf(store)).toEqual(["contents: read"]);
    expect(text).not.toMatch(/permission-[a-z-]+: write/);
  });

  it("checks out only the Run records the replay step reads, with that token and no credential left behind", () => {
    expect(checkout()).toContain("if: steps.store.outputs.token != ''");
    expect(checkout()).toContain("repository: jrey8343/fabrik-runs");
    expect(checkout()).toContain("token: ${{ steps.store.outputs.token }}");
    expect(checkout()).toContain("sparse-checkout: ${{ steps.open.outputs.paths }}");
    expect(checkout()).toContain("sparse-checkout-cone-mode: false");
    expect(checkout()).toContain("persist-credentials: false");
    expect(text).toMatch(/\n  store-dir:\n\s+description: .*\n\s+value: \$\{\{ steps\.checked-out\.outputs\.store-dir \}\}\n/);
    expect(steps[at("id: checked-out\n")]).toContain("if: steps.checkout.outcome == 'success'");
    expect(steps[at("id: checked-out\n")]).toContain('run: echo "store-dir=$GITHUB_WORKSPACE/store" >>"$GITHUB_OUTPUT"');
    expect(at("id: checked-out\n")).toBeGreaterThan(at("uses: actions/checkout@"));
  });

  it("never fails the tick on a store that isn't there or can't be read: each step past the key goes on", () => {
    for (const pattern of ["replay-store-main.ts", "find-store-main.ts", "id: store\n", "uses: actions/checkout@"]) {
      expect(steps[at(pattern)], pattern).toContain("continue-on-error: true");
    }
  });
});
