import { describe, expect, it, vi } from "vitest";
import { GitHubError, type ReadClient } from "../github/client.ts";
import { readProductTicks } from "../github/tickFacts.ts";
import { anOpenPullRequest, factsOf, standingFactsOf } from "./builders.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { standingsOf } from "../kit/standing.ts";
import { foldNamedRuns, type NamedRunsRead, readNamedRuns, readRuns, type RunInFlight, type RunsRead, runsInFlightFactOf } from "./runs.ts";

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

/**
 * A made-up `owner/product` whose Actions holds these workflow runs, each with
 * its jobs, and these scheduled runs of `fabrik.yml`, newest first. Its
 * listing honours its `created` bound, as GitHub's does, and it answers a
 * read of one run by its id.
 */
function actionsOf(
  runs: readonly CannedRun[],
  ticks: readonly CannedTick[] = [],
  refuse: { runs?: boolean; tick?: boolean } = {},
): Pick<ReadClient, "rest"> & { readonly calls: string[] } {
  const calls: string[] = [];
  const refusal = (path: string, status = 403) =>
    new GitHubError(`GitHub GET ${path} failed: ${status}`, status, { body: JSON.stringify({ message: "Resource not accessible by integration" }), request: `GET ${path}` });
  const createdAt = (run: CannedRun) => run.createdAt ?? "2026-11-12T09:00:00Z";
  const listedRun = (run: CannedRun) => ({ id: run.id, run_attempt: run.attempt ?? 1, status: run.status, created_at: createdAt(run), html_url: RUN_PAGE(run.id) });
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
      // The runs read keeps the unfinished ones by their status, of those its listing gives.
      const listed = new RegExp(`^${base}/runs\\?created=([^&]+)&exclude_pull_requests=true&per_page=100&page=(\\d+)$`).exec(path);
      if (listed !== null) {
        const since = Date.parse(decodeURIComponent(listed[1] ?? "").replace(/^>=/, ""));
        return {
          workflow_runs: runs
            .filter((run) => Date.parse(createdAt(run)) >= since)
            .slice((Number(listed[2]) - 1) * 100, Number(listed[2]) * 100)
            .map(listedRun),
        };
      }
      const one = new RegExp(`^${base}/runs/(\\d+)$`).exec(path);
      if (one !== null) {
        const run = runs.find(({ id }) => id === Number(one[1]));
        if (run === undefined) throw refusal(path, 404);
        return { ...listedRun(run), name: "fabrik", event: "issues" };
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

  describe("a Digest run (#655)", () => {
    const DIGEST_OF_50 = routed({ role: "digest", issue: 12, pullRequest: 50, kind: null, retry: 0, model: "claude-sonnet-4-5" });

    it("is read exactly from the closing line, with role digest, its Ticket and its pull request, running at its Digest job's page", async () => {
      const actions = actionsOf([
        {
          id: 9,
          status: "in_progress",
          createdAt: "2026-11-12T09:40:00Z",
          jobs: [
            kitJob(DIGEST_OF_50),
            { name: "fabrik / Review PR #${{ needs.kit.outputs.pull-request }}", status: "completed", conclusion: "skipped" },
            { id: 6, name: "fabrik / Digest PR #50", status: "in_progress", startedAt: "2026-11-12T09:41:00Z" },
          ],
        },
      ]);

      expect((await readRuns(actions, "owner/product", NOW)).runs).toEqual([
        {
          run: 9,
          attempt: 1,
          exact: true,
          role: "digest",
          issue: 12,
          pullRequest: 50,
          kind: null,
          retry: null,
          model: "claude-sonnet-4-5",
          job: "running",
          createdAt: "2026-11-12T09:40:00Z",
          startedAt: "2026-11-12T09:41:00Z",
          url: JOB_PAGE(9, 6),
        },
      ]);
    });

    it("is waiting for a runner, at the run's page, until its Digest job is listed, and landing once that job is done and its push job is not", async () => {
      const waiting = actionsOf([{ id: 9, status: "in_progress", jobs: [kitJob(DIGEST_OF_50)] }]);
      const landing = actionsOf([
        {
          id: 9,
          status: "in_progress",
          jobs: [kitJob(DIGEST_OF_50), { id: 6, name: "fabrik / Digest PR #50", status: "completed", conclusion: "success", startedAt: "2026-11-12T09:41:00Z" }, { name: "fabrik / Push", status: "in_progress" }],
        },
      ]);

      expect((await readRuns(waiting, "owner/product", NOW)).runs).toMatchObject([{ role: "digest", pullRequest: 50, job: "waiting-for-runner", startedAt: null, url: RUN_PAGE(9) }]);
      expect((await readRuns(landing, "owner/product", NOW)).runs).toMatchObject([{ role: "digest", pullRequest: 50, job: "landing", url: JOB_PAGE(9, 6) }]);
    });

    it("is told by its job's name, Digest PR and the number, for a run with no closing line: not exact, with its pull request, no Ticket and no model", async () => {
      const actions = actionsOf([
        {
          id: 9,
          status: "in_progress",
          createdAt: "2026-11-12T09:40:00Z",
          jobs: [
            { name: "fabrik / Kit", status: "completed", conclusion: "success", steps: [{ name: "Route", status: "completed", conclusion: "success" }] },
            { id: 6, name: "fabrik / Digest PR #50", status: "in_progress", startedAt: "2026-11-12T09:41:00Z" },
          ],
        },
      ]);

      expect((await readRuns(actions, "owner/product", NOW)).runs).toEqual([
        {
          run: 9,
          attempt: 1,
          exact: false,
          role: "digest",
          issue: null,
          pullRequest: 50,
          kind: null,
          retry: null,
          model: null,
          job: "running",
          createdAt: "2026-11-12T09:40:00Z",
          startedAt: "2026-11-12T09:41:00Z",
          url: JOB_PAGE(9, 6),
        },
      ]);
    });

    it("takes no skipped Digest job for a run, its name never worked out", async () => {
      const actions = actionsOf([
        {
          id: 9,
          status: "in_progress",
          jobs: [
            { name: "fabrik / Kit", status: "completed", conclusion: "success", steps: [{ name: "Route", status: "completed", conclusion: "success" }] },
            { name: "fabrik / Digest PR #${{ needs.kit.outputs.pull-request }}", status: "completed", conclusion: "skipped" },
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

  describe("a run with no closing line", () => {
    const releasedKit = (conclusion = "success"): CannedJob => ({
      name: "fabrik / Kit",
      status: "completed",
      conclusion,
      steps: [
        { name: "Set up job", status: "completed", conclusion: "success" },
        { name: "Route", status: "completed", conclusion },
      ],
    });

    it("is told by its job's name, as a release before the closing step names it, not exact, with no model", async () => {
      const actions = actionsOf([
        {
          id: 7,
          status: "in_progress",
          createdAt: "2026-11-12T09:00:00Z",
          jobs: [releasedKit(), { id: 3, name: "fabrik / Implement #12 (Retry 1)", status: "in_progress", startedAt: "2026-11-12T09:02:00Z" }],
        },
        { id: 8, status: "in_progress", createdAt: "2026-11-12T09:10:00Z", jobs: [releasedKit(), { name: "fabrik / Review checks", status: "in_progress" }] },
      ]);

      expect((await readRuns(actions, "owner/product", NOW)).runs).toEqual([
        {
          run: 7,
          attempt: 1,
          exact: false,
          role: "implement",
          issue: 12,
          pullRequest: null,
          kind: "retry",
          retry: 1,
          model: null,
          job: "running",
          createdAt: "2026-11-12T09:00:00Z",
          startedAt: "2026-11-12T09:02:00Z",
          url: JOB_PAGE(7, 3),
        },
        {
          run: 8,
          attempt: 1,
          exact: false,
          role: "review",
          issue: null,
          pullRequest: null,
          kind: null,
          retry: null,
          model: null,
          job: "waiting-on-checks",
          createdAt: "2026-11-12T09:10:00Z",
          startedAt: null,
          url: RUN_PAGE(8),
        },
      ]);
    });

    it("takes no skipped job, whatever its name, for a run", async () => {
      const actions = actionsOf([
        {
          id: 7,
          status: "in_progress",
          jobs: [
            releasedKit(),
            { name: "fabrik / Implement #12", status: "completed", conclusion: "skipped" },
            { name: "fabrik / Triage", status: "completed", conclusion: "skipped" },
            { name: "fabrik / Review PR #${{ needs.kit.outputs.pull-request }}", status: "completed", conclusion: "skipped" },
          ],
        },
      ]);

      expect((await readRuns(actions, "owner/product", NOW)).runs).toEqual([]);
    });
  });

  describe("when the Tick last started", () => {
    it("is the newest scheduled run of the caller workflow that started its jobs, one GitHub refused at startup or still waiting to begin aside", async () => {
      const actions = actionsOf(
        [],
        [
          { id: 45, status: "queued", conclusion: null, startedAt: "2026-11-12T09:55:00Z" },
          { id: 44, status: "completed", conclusion: "startup_failure", startedAt: "2026-11-12T09:50:00Z" },
          { id: 43, status: "in_progress", conclusion: null, startedAt: "2026-11-12T09:45:00Z" },
          { id: 42, status: "completed", conclusion: "success", startedAt: "2026-11-12T09:40:00Z" },
        ],
      );

      expect((await readRuns(actions, "owner/product", NOW)).tick).toEqual({ lastStartedAt: "2026-11-12T09:45:00Z" });
    });

    it("names the same Tick as the daily Tick check's reader of the same repo", async () => {
      // A made-up repo's scheduled runs, newest first: each started one ran its `tick / …` jobs on main's head of the time.
      const ticks = [
        { id: 44, commit: "c3", status: "completed", conclusion: "startup_failure", startedAt: "2026-11-12T09:50:00Z" },
        { id: 43, commit: "c3", status: "queued", conclusion: null, startedAt: "2026-11-12T09:45:00Z" },
        { id: 42, commit: "c2", status: "completed", conclusion: "success", startedAt: "2026-11-12T09:40:00Z" },
        { id: 41, commit: "c1", status: "completed", conclusion: "success", startedAt: "2026-11-12T09:35:00Z" },
      ] as const;
      const main = ["c3", "c2", "c1"];
      const started = ticks.filter(({ status, conclusion }) => status === "completed" && conclusion !== "startup_failure");
      const actions = actionsOf([], ticks);
      const repo = {
        async rest(method: string, path: string): Promise<unknown> {
          if (path === "/repos/owner/product") return { default_branch: "main" };
          if (path.startsWith("/repos/owner/product/commits?sha=main&")) return main.map((sha) => ({ sha, commit: { committer: { date: "2026-11-12T08:00:00Z" } } }));
          const checks = /^\/repos\/owner\/product\/commits\/(\w+)\/check-runs\?/.exec(path);
          if (checks !== null) {
            const runs = started
              .filter(({ commit }) => commit === checks[1])
              .flatMap(({ id, startedAt }) => [
                { name: "tick / Kit", started_at: new Date(Date.parse(startedAt) + 5_000).toISOString(), details_url: JOB_PAGE(id, 1) },
                { name: "tick / Tick", started_at: new Date(Date.parse(startedAt) + 9_000).toISOString(), details_url: JOB_PAGE(id, 2) },
              ]);
            return { total_count: runs.length, check_runs: runs };
          }
          if (path.startsWith("/repos/owner/product/issues?")) return [];
          return actions.rest(method, path);
        },
        fileText: () => Promise.resolve(null),
      };

      const read = await readRuns(repo, "owner/product", NOW);
      const daily = await readProductTicks(repo, { owner: "owner", name: "product" }, "fabrik-app[bot]");

      expect(read.tick).toEqual({ lastStartedAt: "2026-11-12T09:40:00Z" });
      expect(daily.kind === "read" ? daily.facts.lastTick?.url : null).toMatch(new RegExp(`^${RUN_PAGE(42)}/`));
    });

    it("is null for a repo whose Tick never started", async () => {
      const refusedOnly = actionsOf([], [{ id: 44, status: "completed", conclusion: "startup_failure", startedAt: "2026-11-12T09:50:00Z" }]);

      expect((await readRuns(actionsOf([]), "owner/product", NOW)).tick).toEqual({ lastStartedAt: null });
      expect((await readRuns(refusedOnly, "owner/product", NOW)).tick).toEqual({ lastStartedAt: null });
    });
  });

  it("makes 5 REST requests for a repo with three runs in flight: one listing of the window's runs (#725), one of each run's jobs, and the Tick's", async () => {
    const running = (id: number): CannedRun => ({ id, status: "in_progress", jobs: [kitJob(IMPLEMENT_ON_12), { name: "fabrik / Implement #12 (Retry 2)", status: "in_progress" }] });
    const actions = actionsOf([running(7), running(8), { ...running(9), status: "queued" }]);

    const read = await readRuns(actions, "owner/product", NOW);

    expect(read.runs).toHaveLength(3);
    expect(actions.calls).toHaveLength(5);
  });

  describe("unread", () => {
    it("gives the runs unread when GitHub refuses their listing, with the Tick still read", async () => {
      const actions = actionsOf([], [{ id: 42, status: "completed", conclusion: "success", startedAt: "2026-11-12T09:40:00Z" }], { runs: true });

      expect(await readRuns(actions, "owner/product", NOW)).toEqual({ repo: "owner/product", readAt: NOW, runs: "unread", tick: { lastStartedAt: "2026-11-12T09:40:00Z" } });
    });

    it("gives the Tick unread when GitHub refuses its listing, with the runs still read", async () => {
      const actions = actionsOf([{ id: 7, status: "in_progress", jobs: [kitJob(IMPLEMENT_ON_12), { name: "fabrik / Implement #12 (Retry 2)", status: "queued" }] }], [], { tick: true });

      const read = await readRuns(actions, "owner/product", NOW);

      expect(read.tick).toBe("unread");
      expect(read.runs).toMatchObject([{ run: 7, issue: 12 }]);
    });

    // The runs read asks for the pages after the first, and the unfinished runs' jobs, side by side (#836).
    it.each([
      ["refuses", "a page after the first", 403, (path: string) => path.endsWith("&page=2")],
      ["never answers", "a page after the first", 0, (path: string) => path.endsWith("&page=2")],
      ["refuses", "an unfinished run's jobs", 403, (path: string) => path.includes("/runs/7/jobs")],
      ["never answers", "an unfinished run's jobs", 0, (path: string) => path.includes("/runs/7/jobs")],
    ])("gives the runs unread when GitHub %s %s", async (_, __, status, refused) => {
      const listed = (page: number) =>
        Array.from({ length: page === 1 ? 100 : 30 }, (__, i) => ({ id: page === 1 && i === 0 ? 7 : page * 1000 + i, status: page === 1 && i === 0 ? "queued" : "completed", created_at: "2026-11-12T09:00:00Z" }));
      const actions = {
        async rest(_method: string, path: string): Promise<unknown> {
          if (refused(path)) throw new GitHubError(`GitHub GET ${path} failed: ${status}`, status, { request: `GET ${path}` });
          if (path.includes("/workflows/fabrik.yml/runs")) return { workflow_runs: [] };
          const page = /&page=(\d+)$/.exec(path);
          if (page !== null) return { total_count: 130, workflow_runs: listed(Number(page[1])) };
          return { jobs: [kitJob(IMPLEMENT_ON_12)] };
        },
      };

      expect((await readRuns(actions, "owner/product", NOW)).runs).toBe("unread");
    });

    it("never throws, though GitHub fails some other way than refusing", async () => {
      const failing = { rest: () => Promise.reject(new TypeError("fetch failed")) };

      expect(await readRuns(failing, "owner/product", NOW)).toEqual({ repo: "owner/product", readAt: NOW, runs: "unread", tick: "unread" });
    });
  });

  describe("as the Standing's runs-in-flight fact", () => {
    it("gives each run as the fact, with the run, its attempt, whether it is exact and its start, and keeps unread unread", () => {
      const read: RunsRead = {
        repo: "owner/product",
        readAt: NOW,
        runs: [
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
          },
        ],
        tick: "unread",
      };

      expect(runsInFlightFactOf(read)).toEqual([
        {
          role: "implement",
          issue: 12,
          pullRequest: 40,
          retry: 2,
          kind: "retry",
          job: "running",
          createdAt: "2026-11-12T09:00:00Z",
          exact: true,
          run: 7,
          attempt: 2,
          startedAt: "2026-11-12T09:02:00Z",
        },
      ]);
      expect(runsInFlightFactOf({ ...read, runs: "unread" })).toBe("unread");
    });

    it("makes a Review run waiting on checks the Standing's Review waiting for its Required checks, on the pull request it names alone", async () => {
      const actions = actionsOf([
        {
          id: 8,
          status: "in_progress",
          createdAt: "2026-11-12T09:10:00Z",
          jobs: [
            kitJob(routed({ role: "review", issue: 7, pullRequest: 50, kind: null, retry: 0, model: "claude-sonnet-4-5" })),
            { name: "fabrik / Review checks", status: "in_progress", startedAt: "2026-11-12T09:11:00Z" },
          ],
        },
      ]);
      const runsInFlight = runsInFlightFactOf(await readRuns(actions, "owner/product", NOW));
      const kit = { repo: "owner/product", branch: "main", config: { ok: true, config: DEFAULT_KIT_CONFIG }, dispatch: null, runsInFlight, headChecks: {} } as const;
      const github = factsOf({ openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 }), anOpenPullRequest({ number: 51, ticket: 8 })] });

      const standings = standingsOf(standingFactsOf({ github, kit }), NOW);

      expect(standings.filter(({ name }) => name === "waiting-on-checks").map(({ pullRequest, since }) => ({ pullRequest, since }))).toEqual([{ pullRequest: 50, since: "2026-11-12T09:10:00Z" }]);
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

/** The paths a canned client was asked, each without its method. */
const pathsOf = (calls: readonly string[]) => calls.map((call) => call.replace(/^GET /, ""));

/** The address of the runs listing a read asked for, by its first page. */
const listingsOf = (calls: readonly string[]) => pathsOf(calls).filter((path) => /\/actions\/runs\?created=/.test(path) && path.endsWith("&page=1"));

describe("The whole runs read's listing (#898)", () => {
  const running = (id: number, createdAt: string): CannedRun => ({ id, status: "in_progress", createdAt, jobs: [kitJob(IMPLEMENT_ON_12), { name: "fabrik / Implement #12 (Retry 2)", status: "in_progress" }] });

  it("is asked at one address within the hour, its bound the hour a day before, and at another in the next hour", async () => {
    const actions = actionsOf([]);

    await readRuns(actions, "owner/product", "2026-11-12T10:05:00Z");
    await readRuns(actions, "owner/product", "2026-11-12T10:59:59Z");
    await readRuns(actions, "owner/product", "2026-11-12T11:00:00Z");

    const [first, second, third] = listingsOf(actions.calls);
    expect(first).toBe(second);
    expect(third).not.toBe(first);
    expect(decodeURIComponent(first ?? "")).toContain("created=>=2026-11-11T10:00:00Z&");
    expect(decodeURIComponent(third ?? "")).toContain("created=>=2026-11-11T11:00:00Z&");
  });

  it("leaves out a run created before the window, a day to the second, though after the listing's bound", async () => {
    const actions = actionsOf([running(7, "2026-11-11T10:15:00Z"), running(8, "2026-11-11T10:30:00Z"), running(9, "2026-11-12T09:00:00Z")]);

    const read = await readRuns(actions, "owner/product", "2026-11-12T10:30:00Z");

    expect(decodeURIComponent(listingsOf(actions.calls)[0] ?? "")).toContain("created=>=2026-11-11T10:00:00Z&");
    expect(read.runs).toMatchObject([{ run: 8 }, { run: 9 }]);
    // A run left out is not read further.
    expect(pathsOf(actions.calls).filter((path) => path.includes("/runs/7/"))).toEqual([]);
  });

  it("is bounded by the clock, as it was before, when the time it is handed is no time, and the runs are still read", async () => {
    const actions = actionsOf([running(7, "2026-11-12T09:00:00Z")]);
    vi.useFakeTimers({ now: Date.parse("2026-11-12T10:30:00Z"), toFake: ["Date"] });
    try {
      const read = await readRuns(actions, "owner/product", "not a time");

      expect(read).toMatchObject({ readAt: "not a time", runs: [{ run: 7, issue: 12 }] });
      expect(decodeURIComponent(listingsOf(actions.calls)[0] ?? "")).toContain("created=>=2026-11-11T10:00:00Z&");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("The named runs read (#898)", () => {
  const implementRun: CannedRun = {
    id: 7,
    status: "in_progress",
    attempt: 2,
    createdAt: "2026-11-12T09:00:00Z",
    jobs: [
      kitJob(IMPLEMENT_ON_12),
      { id: 2, name: "fabrik / Claim the work", status: "completed", conclusion: "success", startedAt: "2026-11-12T09:01:00Z" },
      { id: 3, name: "fabrik / Implement #12 (Retry 2)", status: "in_progress", startedAt: "2026-11-12T09:02:00Z" },
    ],
  };
  const reviewRun: CannedRun = {
    id: 8,
    status: "in_progress",
    createdAt: "2026-11-12T09:10:00Z",
    jobs: [kitJob(routed({ role: "review", issue: 12, pullRequest: 50, kind: null, retry: 0, model: "claude-sonnet-4-5" })), { name: "fabrik / Review checks", status: "in_progress" }],
  };

  it("gives a run with an agent job in flight as the whole read gives it", async () => {
    const actions = actionsOf([implementRun, reviewRun]);

    const whole = await readRuns(actions, "owner/product", NOW);
    const named = await readNamedRuns(actions, "owner/product", [7], NOW);

    expect(named).toEqual({
      repo: "owner/product",
      readAt: NOW,
      named: [
        {
          run: 7,
          inFlight: [
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
            },
          ],
        },
      ],
    } satisfies NamedRunsRead);
    expect(whole.runs).not.toBe("unread");
    expect(named.named[0]?.inFlight).toEqual((whole.runs as readonly RunInFlight[]).filter(({ run }) => run === 7));
  });

  it.each([
    ["that has ended", { ...implementRun, status: "completed" }],
    ["whose push job has finished", { ...implementRun, jobs: [...implementRun.jobs, { name: "fabrik / Push", status: "completed", conclusion: "success" }] }],
    ["with no agent job, the Kit having declined", { ...implementRun, jobs: [kitJob({ fabrik: 1, route: "none", run: null, held: [], replay: null })] }],
    ["created before the window, a day to the second", { ...implementRun, createdAt: "2026-11-11T09:59:59Z" }],
  ])("gives a run %s no run in flight", async (_, run) => {
    const actions = actionsOf([run]);

    expect(await readNamedRuns(actions, "owner/product", [7], NOW)).toEqual({ repo: "owner/product", readAt: NOW, named: [{ run: 7, inFlight: [] }] });
  });

  it("reads no jobs of a run that has ended or is older than the window: one request for it", async () => {
    const ended = actionsOf([{ ...implementRun, status: "completed" }]);
    const old = actionsOf([{ ...implementRun, createdAt: "2026-11-11T09:00:00Z" }]);

    await readNamedRuns(ended, "owner/product", [7], NOW);
    await readNamedRuns(old, "owner/product", [7], NOW);

    expect(pathsOf(ended.calls)).toEqual(["/repos/owner/product/actions/runs/7"]);
    expect(pathsOf(old.calls)).toEqual(["/repos/owner/product/actions/runs/7"]);
  });

  it.each([
    ["the run", (path: string) => path.endsWith("/runs/8")],
    ["its jobs", (path: string) => path.includes("/runs/8/jobs")],
  ])("gives a run unread when GitHub refuses %s, that run alone, and throws nothing", async (_, refused) => {
    const base = actionsOf([implementRun, reviewRun]);
    const actions = {
      rest: async (method: string, path: string) => {
        if (refused(path)) throw new GitHubError(`GitHub GET ${path} failed: 403`, 403, { request: `GET ${path}` });
        return base.rest(method, path);
      },
    };

    const named = await readNamedRuns(actions, "owner/product", [7, 8], NOW);

    expect(named.named.map(({ run, inFlight }) => [run, inFlight === "unread" ? "unread" : inFlight.length])).toEqual([
      [7, 1],
      [8, "unread"],
    ]);
  });

  it("gives a run GitHub no longer holds unread, and every run unread when GitHub fails some other way, never throwing", async () => {
    const failing = { rest: () => Promise.reject(new TypeError("fetch failed")) };

    expect((await readNamedRuns(actionsOf([implementRun]), "owner/product", [99], NOW)).named).toEqual([{ run: 99, inFlight: "unread" }]);
    expect((await readNamedRuns(failing, "owner/product", [7, 8], NOW)).named).toEqual([
      { run: 7, inFlight: "unread" },
      { run: 8, inFlight: "unread" },
    ]);
  });

  it("asks at most two requests for each run named, and none for a run not named, the Tick, or the listing", async () => {
    const actions = actionsOf([implementRun, reviewRun, { ...implementRun, id: 9 }, { ...implementRun, id: 10, status: "completed" }]);

    const named = await readNamedRuns(actions, "owner/product", [7, 10, 9, 7], NOW);

    expect(named.named.map(({ run }) => run)).toEqual([7, 10, 9]);
    expect(pathsOf(actions.calls).toSorted()).toEqual([
      "/repos/owner/product/actions/runs/10",
      "/repos/owner/product/actions/runs/7",
      "/repos/owner/product/actions/runs/7/jobs?filter=latest&per_page=100",
      "/repos/owner/product/actions/runs/9",
      "/repos/owner/product/actions/runs/9/jobs?filter=latest&per_page=100",
    ]);
  });

  it("gives every run unread, asking nothing, when the time it is handed is no time", async () => {
    const actions = actionsOf([implementRun]);

    expect((await readNamedRuns(actions, "owner/product", [7], "not a time")).named).toEqual([{ run: 7, inFlight: "unread" }]);
    expect(actions.calls).toEqual([]);
  });

  it("asks nothing when named no run", async () => {
    const actions = actionsOf([implementRun]);

    expect(await readNamedRuns(actions, "owner/product", [], NOW)).toEqual({ repo: "owner/product", readAt: NOW, named: [] });
    expect(actions.calls).toEqual([]);
  });

  it("folded, of every unfinished run, into a runs read kept with no runs, gives the whole read's runs", async () => {
    const releasedKit: CannedJob = { name: "fabrik / Kit", status: "completed", conclusion: "success", steps: [{ name: "Route", status: "completed", conclusion: "success" }] };
    const REPLAY = { fabrik: 1, route: "replay", run: null, held: [], replay: { issue: 30, ticket: 12 } };
    const DIGEST = routed({ role: "digest", issue: 12, pullRequest: 50, kind: null, retry: 0, model: "claude-sonnet-4-5" });
    const runs: CannedRun[] = [
      implementRun,
      reviewRun,
      { id: 9, status: "queued", createdAt: "2026-11-12T09:20:00Z", jobs: [kitJob(DIGEST)] },
      { id: 10, status: "in_progress", jobs: [kitJob(DIGEST), { id: 6, name: "fabrik / Digest PR #50", status: "completed", conclusion: "success" }, { name: "fabrik / Push", status: "in_progress" }] },
      { id: 11, status: "in_progress", createdAt: "2026-11-12T08:00:00Z", jobs: [kitJob(REPLAY), { name: "fabrik / Replay implement (baseline)", status: "in_progress", startedAt: "2026-11-12T08:02:00Z" }] },
      { id: 12, status: "in_progress", jobs: [releasedKit, { id: 3, name: "fabrik / Implement #14 (Retry 1)", status: "in_progress", startedAt: "2026-11-12T09:02:00Z" }] },
      { id: 13, status: "in_progress", jobs: [releasedKit, { name: "fabrik / Review checks", status: "in_progress" }] },
      { id: 14, status: "in_progress", jobs: [kitJob({ fabrik: 1, route: "none", run: null, held: [], replay: null })] },
      { id: 15, status: "in_progress", jobs: [kitJob(IMPLEMENT_ON_12), { name: "fabrik / Implement #12 (Retry 2)", status: "completed", conclusion: "success" }, { name: "fabrik / Push", status: "completed", conclusion: "success" }] },
      { id: 16, status: "in_progress", jobs: [{ name: "fabrik / Kit", status: "in_progress", steps: [{ name: "Route", status: "in_progress" }] }] },
      { id: 17, status: "completed", jobs: [kitJob(IMPLEMENT_ON_12), { name: "fabrik / Implement #12 (Retry 2)", status: "in_progress" }] },
      { id: 18, status: "in_progress", createdAt: "2026-11-11T09:30:00Z", jobs: [kitJob(IMPLEMENT_ON_12), { name: "fabrik / Implement #12 (Retry 2)", status: "in_progress" }] },
      { id: 19, status: "waiting", jobs: [] },
    ];
    const actions = actionsOf(runs);
    const kept: RunsRead = { repo: "owner/product", readAt: "2026-11-12T09:00:00Z", runs: [], tick: { lastStartedAt: "2026-11-12T09:00:00Z" } };

    const whole = await readRuns(actions, "owner/product", NOW);
    const named = await readNamedRuns(
      actions,
      "owner/product",
      runs.filter(({ status }) => status !== "completed").map(({ id }) => id),
      NOW,
    );

    expect(whole.runs).toHaveLength(7);
    expect(foldNamedRuns(kept, named).runs).toEqual(whole.runs);
  });
});

describe("The fold of a named runs read into the runs read kept (#898)", () => {
  const run = (id: number, overrides: Partial<RunInFlight> = {}): RunInFlight => ({
    run: id,
    attempt: 1,
    exact: true,
    role: "implement",
    issue: id,
    pullRequest: null,
    kind: "first",
    retry: null,
    model: "claude-opus-4-1",
    job: "waiting-for-runner",
    createdAt: "2026-11-12T09:00:00Z",
    startedAt: null,
    url: RUN_PAGE(id),
    ...overrides,
  });
  const kept: RunsRead = Object.freeze({
    repo: "owner/product",
    readAt: "2026-11-12T09:30:00Z",
    runs: Object.freeze([run(5), run(7), run(9)]),
    tick: Object.freeze({ lastStartedAt: "2026-11-12T09:00:00Z" }),
  });
  const namedOf = (named: NamedRunsRead["named"]): NamedRunsRead => ({ repo: "owner/product", readAt: NOW, named });

  it("replaces a named run's entries with the answer's, leaving every other run's entries, the Tick and when it was read as kept", () => {
    const running = run(7, { job: "running", startedAt: "2026-11-12T09:35:00Z", url: JOB_PAGE(7, 3) });

    expect(foldNamedRuns(kept, namedOf([{ run: 7, inFlight: [running] }]))).toEqual({ ...kept, runs: [run(5), running, run(9)] });
  });

  it("removes the entries of a run that ended", () => {
    expect(foldNamedRuns(kept, namedOf([{ run: 7, inFlight: [] }])).runs).toEqual([run(5), run(9)]);
  });

  it("leaves an unread run's entries as kept", () => {
    expect(foldNamedRuns(kept, namedOf([{ run: 7, inFlight: "unread" }, { run: 9, inFlight: [] }])).runs).toEqual([run(5), run(7)]);
  });

  it("adds a run never kept in its place by run, and adds nothing for a run never kept that is not in flight", () => {
    expect(foldNamedRuns(kept, namedOf([{ run: 8, inFlight: [run(8)] }, { run: 20, inFlight: [] }, { run: 3, inFlight: [run(3)] }])).runs).toEqual([run(3), run(5), run(7), run(8), run(9)]);
  });

  it("changes nothing for a named read of no runs", () => {
    expect(foldNamedRuns(kept, namedOf([]))).toEqual(kept);
  });

  it("keeps runs kept unread unread, since a named read never says which other runs are in flight", () => {
    const unread: RunsRead = { ...kept, runs: "unread" };

    expect(foldNamedRuns(unread, namedOf([{ run: 7, inFlight: [run(7)] }]))).toEqual(unread);
  });

  it("refuses a named read of another repo", () => {
    expect(() => foldNamedRuns(kept, { ...namedOf([]), repo: "owner/other" })).toThrow(/owner\/other.*owner\/product|owner\/product.*owner\/other/);
  });
});
