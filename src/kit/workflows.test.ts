// The Kit's reusable workflows are wiring only. These hold the wiring to the
// files it names, since nothing runs the workflows before a release.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JUDGE_JOB } from "./judge.ts";
import { JUDGE_TIMEOUT_MINUTES } from "./runStore.ts";

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
  it.each(["triage", "design", "implement", "review", "audit"])(
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

  it.each(["triage", "design", "implement", "review", "audit"])(
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
  it.each(["triage", "design", "implement", "review", "audit"])(
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

describe("schedule.yml's tick, which opens the pending Audit", () => {
  it("holds only the push service account, so the Auditor's run needs no change to the shim", () => {
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

describe("The store-token action, which the record actions share", () => {
  const action = readFileSync(new URL(".github/actions/store-token/action.yml", root), "utf8");
  const steps = action.split(/\n(?=    - )/);
  const storeToken = steps.find((step) => step.includes("id: store\n"));
  const kitConfigToken = steps.find((step) => step.includes("id: kit-config\n"));
  const permissionsOf = (step: string | undefined) => [...(step ?? "").matchAll(/permission-([a-z-]+): (\S+)/g)].map((m) => `${m[1]}: ${m[2]}`);

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

  // Push-job-shaped programs (src/main.ts, the record writers) run without `npm ci`: only the agent's actions install Sandcastle.
  it.each(actions.filter(({ text }) => !text.includes("run: npm ci")))(
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

// Which Subscription an agent run is on: the Kit job's routing chooses it, and
// every job that loads a Claude token loads that one's, and only that one.
describe("The Subscription each agent job runs on", () => {
  const SUBSCRIPTION_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN: op://Fabrik/${{ needs.kit.outputs.subscription }}/credential";
  const claudeTokensIn = (text: string) => [...text.matchAll(/CLAUDE_CODE_OAUTH_TOKEN: (op:\/\/\S.*)$/gm)].map((match) => match[1]);
  const judge = readFileSync(new URL(".github/actions/run-judge/action.yml", root), "utf8");

  it("loop.yml's Kit job passes out the Subscription its routing chose", () => {
    expect(jobIn(loop, "kit")).toContain("subscription: ${{ steps.route.outputs.subscription }}");
  });

  it.each(["triage", "design", "implement", "review", "audit"])(
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
});
