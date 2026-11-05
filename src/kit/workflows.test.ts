// The Kit's reusable workflows are wiring only. These hold the wiring to the
// files it names, since nothing runs the workflows before a release.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const workflows = [".github/workflows/loop.yml", ".github/workflows/schedule.yml", ".github/workflows/weekly-summary.yml"].map((path) => ({
  path,
  text: readFileSync(new URL(path, root), "utf8"),
}));
const loop = workflows.find((workflow) => workflow.path.endsWith("loop.yml"))!.text;
const schedule = workflows.find((workflow) => workflow.path.endsWith("schedule.yml"))!.text;
const prepareAgent = readFileSync(new URL(".github/actions/prepare-agent/action.yml", root), "utf8");

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
  it.each(["triage", "design", "implement", "review"])(
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

  it.each(["triage", "design", "implement", "review"])(
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

  // A Step-up run is an Implement run on a stronger model, so it gets implement's Extra skills.
  it.each(["triage", "design", "implement", "review"])(
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

  it("prepare-agent installs the Base skills plus its role's Extra skills, and holds no secret", () => {
    expect(prepareAgent).toMatch(/\n  role:\n\s+description: .*\n\s+required: true\n/);
    const fetch = prepareAgent.split(/\n(?=    - )/).find((step) => step.includes("src/skills/fetch.ts"));

    expect(fetch).toBeDefined();
    expect(fetch).toContain("FABRIK_ROLE: ${{ inputs.role }}");
    expect(fetch).toContain('node kit/src/skills/fetch.ts product "$FABRIK_ROLE"');
    expect(prepareAgent).not.toContain("load-secrets-action");
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
});

/** A job's section of loop.yml, from its key to the next job's. */
function job(name: string): string {
  const body = loop.split(/\n(?=  [a-z-]+:\n)/).find((section) => section.startsWith(`  ${name}:\n`));
  if (body === undefined) throw new Error(`loop.yml has no ${name} job`);
  return body;
}

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

describe("loop.yml's claim job", () => {
  it("takes agent:design off as the Design session's first turn starts, as it takes agent:implement off", () => {
    expect(job("implement-claim")).toContain(
      "if: needs.kit.outputs.route == 'implement' || (needs.kit.outputs.route == 'design' && github.event.label.name == 'agent:design')",
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

describe("The write the Run record action", () => {
  const action = readFileSync(new URL(".github/actions/write-run-record/action.yml", root), "utf8");
  const steps = action.split(/\n(?=    - )/);
  const storeToken = steps.find((step) => step.includes("id: store"));

  it("builds and writes the record with the Kit's Node program, never inline gh calls", () => {
    const program = /run: node (src\/\S+)/.exec(action)?.[1];

    expect(program).toBeDefined();
    expect(existsSync(new URL(program!, root))).toBe(true);
    expect(action).not.toMatch(/\bgh (api|issue|pr|repo) /);
  });

  it("mints the store's token for fabrik-runs alone, with Contents write and nothing else", () => {
    expect(storeToken).toContain("uses: actions/create-github-app-token@");
    expect(storeToken).toMatch(/owner: jrey8343\n/);
    expect(storeToken).toMatch(/repositories: fabrik-runs\n/);
    expect([...storeToken!.matchAll(/permission-([a-z-]+): (\S+)/g)].map((m) => `${m[1]}: ${m[2]}`)).toEqual(["contents: write"]);
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

  it("takes the role's transcript, and a missing one is fine", () => {
    const download = steps.find((step) => step.includes("actions/download-artifact@"));

    expect(download).toContain("fabrik-transcript-");
    expect(download).toContain("continue-on-error: true");
  });
});

describe("The weekly summary workflow", () => {
  const weekly = workflows.find((workflow) => workflow.path.endsWith("weekly-summary.yml"))!.text;
  const action = readFileSync(new URL(".github/actions/file-weekly-summary/action.yml", root), "utf8");
  const steps = action.split(/\n(?=    - )/);
  const tokens = steps.filter((step) => step.includes("uses: actions/create-github-app-token@"));
  const permissionsOf = (step: string | undefined) =>
    [...(step ?? "").matchAll(/permission-([a-z-]+): (\S+)/g)].map((m) => `${m[1]}: ${m[2]}`).sort();

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

  it("reads the store's records from a sparse checkout of runs/, never its transcripts", () => {
    const checkout = steps.find((step) => step.includes("uses: actions/checkout@"));

    expect(checkout).toContain("repository: jrey8343/fabrik-runs");
    expect(checkout).toMatch(/sparse-checkout: runs\n/);
    expect(checkout).toContain("sparse-checkout-cone-mode: true");
    expect(checkout).toContain("persist-credentials: false");
    expect(action).not.toContain("transcripts/");
  });
});

