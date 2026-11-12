import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient } from "../github/client.ts";
import { readRuns, type RunInFlight } from "./runs.ts";

const NOW = "2026-11-12T10:00:00Z";
const RUN_PAGE = (id: number) => `https://github.com/owner/product/actions/runs/${id}`;
const JOB_PAGE = (run: number, job: number) => `https://github.com/owner/product/actions/runs/${run}/job/${job}`;

interface CannedStep {
  readonly name: string;
  readonly status: string;
  readonly conclusion?: string | null;
}

interface CannedJob {
  readonly id?: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion?: string | null;
  readonly startedAt?: string | null;
  readonly steps?: readonly CannedStep[];
}

interface CannedRun {
  readonly id: number;
  readonly status: string;
  readonly attempt?: number;
  readonly createdAt?: string;
  readonly jobs: readonly CannedJob[];
}

interface CannedTick {
  readonly id: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAt: string;
}

/** A made-up `owner/product` whose Actions holds these workflow runs, each with its jobs, and these scheduled runs of `fabrik.yml`, newest first. */
function actionsOf(runs: readonly CannedRun[], ticks: readonly CannedTick[] = [], refuse: { runs?: boolean; tick?: boolean } = {}): Pick<ReadClient, "rest"> & { readonly calls: string[] } {
  const calls: string[] = [];
  const refusal = (path: string) =>
    new GitHubError(`GitHub GET ${path} failed: 403`, 403, { body: JSON.stringify({ message: "Resource not accessible by integration" }), request: `GET ${path}` });
  return {
    calls,
    async rest(method: string, path: string): Promise<unknown> {
      calls.push(`${method} ${path}`);
      const base = "/repos/owner/product/actions";
      if (path === `${base}/workflows/fabrik.yml/runs?event=schedule&per_page=100`) {
        if (refuse.tick === true) throw refusal(path);
        return {
          workflow_runs: ticks.map((tick) => ({
            id: tick.id,
            event: "schedule",
            status: tick.status,
            conclusion: tick.conclusion,
            run_started_at: tick.startedAt,
            created_at: tick.startedAt,
            html_url: RUN_PAGE(tick.id),
          })),
        };
      }
      if (refuse.runs === true) throw refusal(path);
      const listed = new RegExp(`^${base}/runs\\?status=(\\w+)&per_page=100$`).exec(path);
      if (listed !== null) {
        return {
          workflow_runs: runs
            .filter((run) => run.status === listed[1])
            .map((run) => ({
              id: run.id,
              run_attempt: run.attempt ?? 1,
              status: run.status,
              created_at: run.createdAt ?? "2026-11-12T09:00:00Z",
              html_url: RUN_PAGE(run.id),
            })),
        };
      }
      const jobs = new RegExp(`^${base}/runs/(\\d+)/jobs\\?filter=latest&per_page=100$`).exec(path);
      if (jobs !== null) {
        const run = runs.find(({ id }) => id === Number(jobs[1]));
        return {
          jobs: (run?.jobs ?? []).map((job, i) => ({
            id: job.id ?? run!.id * 100 + i,
            name: job.name,
            status: job.status,
            conclusion: job.conclusion ?? null,
            started_at: job.startedAt ?? null,
            html_url: JOB_PAGE(run!.id, job.id ?? run!.id * 100 + i),
            steps: (job.steps ?? []).map((step, number) => ({ ...step, conclusion: step.conclusion ?? null, number: number + 1 })),
          })),
        };
      }
      throw new Error(`Unexpected call: ${path}`);
    },
  };
}

/** The Kit job, completed, its closing step named for this line. */
function kitJob(line: Record<string, unknown>): CannedJob {
  return {
    id: 1,
    name: "fabrik / Kit",
    status: "completed",
    conclusion: "success",
    startedAt: "2026-11-12T09:00:05Z",
    steps: [
      { name: "Set up job", status: "completed", conclusion: "success" },
      { name: "Route", status: "completed", conclusion: "success" },
      { name: JSON.stringify(line), status: "completed", conclusion: "success" },
    ],
  };
}

/** A closing line routing this agent run, nothing held. */
function routed(run: { role: string; issue: number | null; pullRequest: number | null; kind: string | null; retry: number; model: string }): Record<string, unknown> {
  return { fabrik: 1, route: run.role, run, held: [], replay: null };
}

const IMPLEMENT_ON_12 = routed({ role: "implement", issue: 12, pullRequest: 40, kind: "retry", retry: 2, model: "claude-opus-4-1" });

describe("The runs read", () => {
  describe("a run the Kit job's closing line names", () => {
    it("is one entry, exact, with what the line says, its agent job running, that job's start and its page", async () => {
      const actions = actionsOf([
        {
          id: 7,
          status: "in_progress",
          attempt: 2,
          createdAt: "2026-11-12T09:00:00Z",
          jobs: [
            kitJob(IMPLEMENT_ON_12),
            { id: 2, name: "fabrik / Claim the work", status: "completed", conclusion: "success", startedAt: "2026-11-12T09:01:00Z" },
            { id: 3, name: "fabrik / Implement #12 (Retry 2)", status: "in_progress", startedAt: "2026-11-12T09:02:00Z" },
            { id: 4, name: "fabrik / Triage", status: "completed", conclusion: "skipped" },
          ],
        },
      ]);

      const read = await readRuns(actions, "owner/product", NOW);

      expect(read.repo).toBe("owner/product");
      expect(read.readAt).toBe(NOW);
      expect(read.runs).toEqual([
        {
          run: 7,
          attempt: 2,
          exact: true,
          role: "implement",
          issue: 12,
          pullRequest: 40,
          kind: "retry",
          retry: 2,
          model: "claude-opus-4-1",
          job: "running",
          createdAt: "2026-11-12T09:00:00Z",
          startedAt: "2026-11-12T09:02:00Z",
          url: JOB_PAGE(7, 3),
        } satisfies RunInFlight,
      ]);
    });

    it.each([
      ["blocked behind its concurrency group", "pending", undefined, "blocked"],
      ["queued for a runner", "queued", undefined, "waiting-for-runner"],
      ["done while its push job is not", "completed", { name: "fabrik / Push", status: "in_progress" }, "landing"],
    ] as const)("reads its agent job %s", async (_, status, push, job) => {
      const actions = actionsOf([
        {
          id: 7,
          status: "in_progress",
          jobs: [
            kitJob(IMPLEMENT_ON_12),
            { id: 3, name: "fabrik / Implement #12 (Retry 2)", status, conclusion: status === "completed" ? "success" : null },
            ...(push === undefined ? [] : [push]),
          ],
        },
      ]);

      const read = await readRuns(actions, "owner/product", NOW);

      expect(read.runs).toMatchObject([{ run: 7, exact: true, job }]);
    });

    it("lists no run whose push job has finished", async () => {
      const actions = actionsOf([
        {
          id: 7,
          status: "in_progress",
          jobs: [
            kitJob(IMPLEMENT_ON_12),
            { name: "fabrik / Implement #12 (Retry 2)", status: "completed", conclusion: "success", startedAt: "2026-11-12T09:02:00Z" },
            { name: "fabrik / Push", status: "completed", conclusion: "success", startedAt: "2026-11-12T09:40:00Z" },
            { name: "fabrik / Dispatch", status: "in_progress", startedAt: "2026-11-12T09:45:00Z" },
          ],
        },
      ]);

      expect((await readRuns(actions, "owner/product", NOW)).runs).toEqual([]);
    });

    it("gives a queued or blocked agent job no start, though Actions lists one", async () => {
      const actions = actionsOf([
        {
          id: 7,
          status: "in_progress",
          jobs: [kitJob(IMPLEMENT_ON_12), { id: 3, name: "fabrik / Implement #12 (Retry 2)", status: "queued", startedAt: "2026-11-12T09:01:00Z" }],
        },
      ]);

      expect((await readRuns(actions, "owner/product", NOW)).runs).toMatchObject([{ startedAt: null, url: JOB_PAGE(7, 3) }]);
    });
  });

  describe("a Review run", () => {
    const REVIEW_OF_50 = routed({ role: "review", issue: 12, pullRequest: 50, kind: null, retry: 0, model: "claude-sonnet-4-5" });

    it("is waiting on checks on the pull request its line names, at the run's page, while its wait for the Required checks is under way", async () => {
      const actions = actionsOf([
        {
          id: 8,
          status: "in_progress",
          createdAt: "2026-11-12T09:10:00Z",
          jobs: [kitJob(REVIEW_OF_50), { name: "fabrik / Review checks", status: "in_progress", startedAt: "2026-11-12T09:11:00Z" }],
        },
      ]);

      expect((await readRuns(actions, "owner/product", NOW)).runs).toEqual([
        {
          run: 8,
          attempt: 1,
          exact: true,
          role: "review",
          issue: 12,
          pullRequest: 50,
          kind: null,
          retry: null,
          model: "claude-sonnet-4-5",
          job: "waiting-on-checks",
          createdAt: "2026-11-12T09:10:00Z",
          startedAt: null,
          url: RUN_PAGE(8),
        },
      ]);
    });

    it("is running once its Review job has a runner", async () => {
      const actions = actionsOf([
        {
          id: 8,
          status: "in_progress",
          jobs: [
            kitJob(REVIEW_OF_50),
            { name: "fabrik / Review checks", status: "completed", conclusion: "success" },
            { name: "fabrik / Re-run red checks", status: "completed", conclusion: "skipped" },
            { id: 5, name: "fabrik / Review PR #50", status: "in_progress", startedAt: "2026-11-12T09:30:00Z" },
          ],
        },
      ]);

      expect((await readRuns(actions, "owner/product", NOW)).runs).toMatchObject([
        { role: "review", pullRequest: 50, job: "running", startedAt: "2026-11-12T09:30:00Z", url: JOB_PAGE(8, 5) },
      ]);
    });

    it("reads another role's run whose agent job is not yet listed as waiting for a runner, at the run's page", async () => {
      const actions = actionsOf([
        {
          id: 9,
          status: "in_progress",
          jobs: [
            kitJob(routed({ role: "retro", issue: null, pullRequest: null, kind: null, retry: 0, model: "claude-opus-4-1" })),
            { name: "fabrik / Retro evidence", status: "in_progress", startedAt: "2026-11-12T09:11:00Z" },
          ],
        },
      ]);

      expect((await readRuns(actions, "owner/product", NOW)).runs).toMatchObject([{ role: "retro", job: "waiting-for-runner", startedAt: null, url: RUN_PAGE(9) }]);
    });

    it("is no run once its push job is listed with its Review job passed over", async () => {
      const actions = actionsOf([
        {
          id: 8,
          status: "in_progress",
          jobs: [
            kitJob(REVIEW_OF_50),
            { name: "fabrik / Review checks", status: "completed", conclusion: "failure" },
            { name: "fabrik / Review PR #${{ needs.kit.outputs.pull-request }}", status: "completed", conclusion: "skipped" },
            { name: "fabrik / Push", status: "in_progress" },
          ],
        },
      ]);

      expect((await readRuns(actions, "owner/product", NOW)).runs).toEqual([]);
    });
  });

  describe("a Replay's run", () => {
    const REPLAY_OF_12 = { fabrik: 1, route: "replay", run: null, held: [], replay: { issue: 30, ticket: 12 } };
    const replayRun = (jobs: readonly CannedJob[]): CannedRun => ({
      id: 11,
      status: "in_progress",
      createdAt: "2026-11-12T08:00:00Z",
      jobs: [kitJob(REPLAY_OF_12), { name: "fabrik / Claim the work", status: "completed", conclusion: "success", startedAt: "2026-11-12T08:01:00Z" }, ...jobs],
    });

    it("is one entry on the replay issue, waiting for a runner before any of its Arms' jobs has one, at the run's page", async () => {
      const actions = actionsOf([
        replayRun([
          { name: "fabrik / Replay implement (baseline)", status: "queued" },
          { name: "fabrik / Replay implement (candidate)", status: "pending" },
        ]),
      ]);

      expect((await readRuns(actions, "owner/product", NOW)).runs).toEqual([
        {
          run: 11,
          attempt: 1,
          exact: true,
          role: "replay",
          issue: 30,
          pullRequest: null,
          kind: null,
          retry: null,
          model: null,
          job: "waiting-for-runner",
          createdAt: "2026-11-12T08:00:00Z",
          startedAt: null,
          url: RUN_PAGE(11),
        },
      ]);
    });

    it("is running once any of its Arms' jobs has a runner, until the job that records it has finished", async () => {
      const running = actionsOf([
        replayRun([
          { name: "fabrik / Replay implement (baseline)", status: "completed", conclusion: "success", startedAt: "2026-11-12T08:02:00Z" },
          { name: "fabrik / Replay implement (candidate)", status: "in_progress", startedAt: "2026-11-12T08:03:00Z" },
          { name: "fabrik / Replay gates (baseline)", status: "queued" },
        ]),
      ]);
      const recording = actionsOf([
        replayRun([
          { name: "fabrik / Replay score (candidate)", status: "completed", conclusion: "success", startedAt: "2026-11-12T08:40:00Z" },
          { name: "fabrik / Replay record", status: "in_progress", startedAt: "2026-11-12T08:50:00Z" },
        ]),
      ]);
      const recorded = actionsOf([replayRun([{ name: "fabrik / Replay record", status: "completed", conclusion: "success", startedAt: "2026-11-12T08:50:00Z" }])]);

      expect((await readRuns(running, "owner/product", NOW)).runs).toMatchObject([{ role: "replay", issue: 30, job: "running", startedAt: "2026-11-12T08:02:00Z", url: RUN_PAGE(11) }]);
      expect((await readRuns(recording, "owner/product", NOW)).runs).toMatchObject([{ role: "replay", job: "running" }]);
      expect((await readRuns(recorded, "owner/product", NOW)).runs).toEqual([]);
    });
  });

  describe("a run the Kit routed no agent run for", () => {
    it.each([
      ["declined", { fabrik: 1, route: "none", run: null, held: [], replay: null }],
      ["holding a run", { fabrik: 1, route: "push", run: null, held: [{ role: "implement", issue: 12 }], replay: null }],
      ["only applying something", { fabrik: 1, route: "push", run: null, held: [], replay: null }],
    ])("is not listed, %s", async (_, line) => {
      const actions = actionsOf([{ id: 7, status: "in_progress", jobs: [kitJob(line), { name: "fabrik / Push", status: "in_progress" }] }]);

      expect((await readRuns(actions, "owner/product", NOW)).runs).toEqual([]);
    });

    it("is not listed while its Kit job has not completed, though its steps already name the closing step as unevaluated text", async () => {
      const actions = actionsOf([
        {
          id: 7,
          status: "in_progress",
          jobs: [
            {
              name: "fabrik / Kit",
              status: "in_progress",
              startedAt: "2026-11-12T09:00:05Z",
              steps: [
                { name: "Route", status: "in_progress" },
                { name: "${{ steps.route.outputs.kit-said }}", status: "pending" },
              ],
            },
          ],
        },
      ]);

      expect((await readRuns(actions, "owner/product", NOW)).runs).toEqual([]);
    });
  });
});
