import { describe, expect, it } from "vitest";
import { SAMPLE_ANNOTATIONS, SAMPLE_JOB, SAMPLE_JOB_LINK, SAMPLE_STEP_LOG } from "../__fixtures__/failedCheckLogs.ts";
import { GitHubError } from "../github/client.ts";
import { type ActionsJob, type CheckAnnotation, type FailureReader, readFailureExcerpt } from "./failureExcerpt.ts";

const SHA = "b".repeat(40);

/** A GitHub that holds one job, its steps' logs by number, and its check run's annotations. */
function reader(
  job: ActionsJob = SAMPLE_JOB,
  logs: Readonly<Record<number, string>> = { 5: SAMPLE_STEP_LOG },
  annotations: readonly CheckAnnotation[] = SAMPLE_ANNOTATIONS,
): FailureReader {
  return {
    job: async () => job,
    stepLog: async (_job, step) => {
      const log = logs[step];
      if (log === undefined) throw new Error(`no log for step ${step}`);
      return log;
    },
    annotations: async () => annotations,
  };
}

describe("Reading a red GitHub Actions check's Failure excerpt", () => {
  it("takes the failed step's name, its log cleaned of the runner's format, the error annotations as file, line and message, and the job link", async () => {
    const excerpt = await readFailureExcerpt({ name: "Typecheck and test", link: SAMPLE_JOB_LINK, sha: SHA }, reader());

    expect(excerpt).toEqual({
      kind: "actions",
      check: "Typecheck and test",
      link: SAMPLE_JOB_LINK,
      steps: [
        {
          name: "Typecheck",
          earlier: 0,
          lines: [
            "npm run typecheck",
            "shell: /usr/bin/bash -e {0}",
            "",
            "> fabrik@0.0.0 typecheck",
            "> tsc --noEmit",
            "",
            "##[error]src/loop/conflicts.test.ts(211,47): error TS2741: Property 'implementJobUnderWay' is missing in type '{ main: string; now: string; pullRequests: { pullRequest: PullRequestSnapshot; mergeable: false; }[]; }' but required in type 'ConflictSnapshot'.",
            "##[error]Process completed with exit code 1.",
          ],
        },
      ],
      annotations: [
        { path: ".github", line: 10, message: "Process completed with exit code 1." },
        {
          path: "src/loop/conflicts.test.ts",
          line: 211,
          message:
            "Property 'implementJobUnderWay' is missing in type '{ main: string; now: string; pullRequests: { pullRequest: PullRequestSnapshot; mergeable: false; }[]; }' but required in type 'ConflictSnapshot'.",
        },
      ],
    });
  });

  it("keeps the last 150 lines of a long step, counting those before them, and a line the runner wrote without a timestamp", async () => {
    const stamped = (n: number) => `2026-11-17T08:32:13.${String(n).padStart(7, "0")}Z line ${n}`;
    const log = [
      "\uFEFF2026-11-17T08:26:08.5450517Z ##[group]Run pnpm test",
      "2026-11-17T08:26:08.5451000Z pnpm test",
      "2026-11-17T08:26:08.5452000Z ##[endgroup]",
      ...Array.from({ length: 200 }, (_, i) => stamped(i + 1)),
      // An error's message runs on over lines the runner gave no timestamp, as GitHub's own logs show.
      "2026-11-17T08:32:13.0445694Z ##[error]AssertionError: expected 2 to be 1",
      "",
      "- Expected",
      "+ Received",
      "2026-11-17T08:32:13.1123979Z ##[error]Process completed with exit code 1.",
      "",
    ].join("\n");
    const job: ActionsJob = { ...SAMPLE_JOB, steps: [{ name: "Run pnpm test", number: 9, conclusion: "failure" }] };

    const excerpt = await readFailureExcerpt({ name: "gate", link: SAMPLE_JOB_LINK, sha: SHA }, reader(job, { 9: log }));

    const [step] = excerpt.kind === "actions" ? excerpt.steps : [];
    expect(step?.lines).toHaveLength(150);
    expect(step?.earlier).toBe(56);
    expect(step?.lines[0]).toBe("line 56");
    expect(step?.lines.slice(-5)).toEqual(["##[error]AssertionError: expected 2 to be 1", "", "- Expected", "+ Received", "##[error]Process completed with exit code 1."]);
  });

  it("reads each failed step of a job that has two, in order", async () => {
    const job: ActionsJob = {
      ...SAMPLE_JOB,
      steps: [
        { name: "Lint", number: 4, conclusion: "failure" },
        { name: "Typecheck", number: 5, conclusion: "failure" },
        { name: "Test", number: 6, conclusion: "skipped" },
      ],
    };

    const excerpt = await readFailureExcerpt({ name: "gate", link: SAMPLE_JOB_LINK, sha: SHA }, reader(job, { 4: "##[error]lint failed\n", 5: SAMPLE_STEP_LOG }));

    expect(excerpt.kind === "actions" ? excerpt.steps.map(({ name, lines }) => [name, lines.at(-1)]) : []).toEqual([
      ["Lint", "##[error]lint failed"],
      ["Typecheck", "##[error]Process completed with exit code 1."],
    ]);
  });

  it.each([
    ["no failed step, as a job cancelled mid-step", [{ name: "Run pnpm test", number: 9, conclusion: "cancelled" }]],
    ["no steps, as a job cancelled before it started", []],
  ])("gives a job that failed with %s its annotations alone", async (_, steps) => {
    const job: ActionsJob = { status: "completed", conclusion: "cancelled", steps };
    const annotations: CheckAnnotation[] = [
      { path: ".github", start_line: 1, annotation_level: "failure", message: "Canceling since a higher priority waiting request for gate-447 exists" },
    ];

    const excerpt = await readFailureExcerpt({ name: "gate", link: SAMPLE_JOB_LINK, sha: SHA }, reader(job, {}, annotations));

    expect(excerpt).toEqual({
      kind: "actions",
      check: "gate",
      link: SAMPLE_JOB_LINK,
      steps: [],
      annotations: [{ path: ".github", line: 1, message: "Canceling since a higher priority waiting request for gate-447 exists" }],
    });
  });
});

describe("A red check's failure that can't be read", () => {
  const check = { name: "gate", link: SAMPLE_JOB_LINK, sha: SHA };
  const notFound = (request: string) => new GitHubError(`GitHub ${request} failed: 404`, 404, { body: '{"message":"Not Found"}', request });
  const refused = (request: string) =>
    new GitHubError(`GitHub ${request} failed: 403`, 403, { body: '{"message":"Resource not accessible by integration"}', request });

  it("says GitHub holds no job when the job is gone, as past the repo's retention period, and keeps the job link", async () => {
    const github = { ...reader(), job: async () => Promise.reject(notFound("GET /repos/acme/shop/actions/jobs/128636834592")) };

    expect(await readFailureExcerpt(check, github)).toEqual({
      kind: "unread",
      check: "gate",
      link: SAMPLE_JOB_LINK,
      why: "GitHub holds no such job any more, as when it is past the repo's retention period",
    });
  });

  it("says GitHub refused the read, with what it said", async () => {
    const github = { ...reader(), job: async () => Promise.reject(refused("GET /repos/acme/shop/actions/jobs/128636834592")) };

    expect(await readFailureExcerpt(check, github)).toMatchObject({
      kind: "unread",
      why: "GitHub refused the read: GET /repos/acme/shop/actions/jobs/128636834592 failed with 403: Resource not accessible by integration",
    });
  });

  it("says a job with no steps and no annotations never started", async () => {
    const github = reader({ status: "completed", conclusion: "failure", steps: [] }, {}, []);

    expect(await readFailureExcerpt(check, github)).toMatchObject({ kind: "unread", why: "the job never started, so it left no log and no annotation" });
  });

  it("says a job that hadn't finished when the Kit read it can't be read yet", async () => {
    const github = reader({ status: "in_progress", conclusion: null, steps: [{ name: "Test", number: 7, conclusion: null }] });

    expect(await readFailureExcerpt(check, github)).toMatchObject({ kind: "unread", why: "the job hadn't finished when the Kit read it" });
  });

  it("keeps the step's name and the annotations when the step's log can't be read, saying why under the step", async () => {
    const github = { ...reader(), stepLog: async () => Promise.reject(notFound("GET /repos/acme/shop/actions/jobs/128636834592/steps/5/logs")) };

    const excerpt = await readFailureExcerpt(check, github);

    expect(excerpt).toMatchObject({
      kind: "actions",
      steps: [{ name: "Typecheck", lines: [], earlier: 0, why: "GitHub holds no log for this step: the runner left none, or it is past the repo's retention period" }],
    });
    expect(excerpt.kind === "actions" ? excerpt.annotations : []).toHaveLength(2);
  });

  it("says when the runner left a failed step's log empty", async () => {
    const excerpt = await readFailureExcerpt(check, reader(SAMPLE_JOB, { 5: "﻿" }));

    expect(excerpt).toMatchObject({ kind: "actions", steps: [{ name: "Typecheck", lines: [], why: "the runner left no log lines for this step" }] });
  });

  it("keeps the steps when the annotations can't be read, saying why", async () => {
    const github = { ...reader(), annotations: async () => Promise.reject(refused("GET /repos/acme/shop/check-runs/128636834592/annotations")) };

    expect(await readFailureExcerpt(check, github)).toMatchObject({
      kind: "actions",
      steps: [{ name: "Typecheck" }],
      annotations: [],
      annotationsUnread:
        "GitHub refused the read: GET /repos/acme/shop/check-runs/128636834592/annotations failed with 403: Resource not accessible by integration",
    });
  });

  it("never throws, whatever the reader throws", async () => {
    const github = { ...reader(), job: async () => Promise.reject(new TypeError("fetch failed")) };

    expect(await readFailureExcerpt(check, github)).toMatchObject({ kind: "unread", why: "GitHub refused the read: fetch failed" });
  });

  it("says a check whose link isn't a GitHub Actions job has no log the Kit reads", async () => {
    expect(await readFailureExcerpt({ name: "Vercel", link: "https://vercel.com/acme/shop/abc", sha: SHA }, reader())).toEqual({
      kind: "unread",
      check: "Vercel",
      link: "https://vercel.com/acme/shop/abc",
      why: "it isn't a GitHub Actions check, so the Kit reads no log for it",
    });
  });
});

// #710 left three points open, for a real run to settle. Each was tried on
// 2026-11-18 with read-only calls against the Kit's own and a Product repo's
// runs, and each test below holds what GitHub did.
describe("What real runs showed of reading a failure (#710)", () => {
  const RUN = "https://github.com/acme/shop/actions/runs/44046177767";

  it("a failed job's step reads while its workflow run is still going: a finished step's log is there, one still running is a 404", async () => {
    // Observed: in a running job, steps 1 to 6 (finished) read 200; step 7 (running) and step 8 (pending) read 404.
    const job: ActionsJob = {
      status: "completed",
      conclusion: "failure",
      steps: [
        { name: "Typecheck", number: 5, conclusion: "failure" },
        { name: "Test", number: 6, conclusion: "skipped" },
      ],
    };
    const github: FailureReader = {
      job: async () => job,
      stepLog: async (_job, step) => {
        if (step === 5) return SAMPLE_STEP_LOG;
        throw new GitHubError("GitHub GET …/steps/6/logs failed: 404", 404, { body: '{"message":"Not Found"}' });
      },
      annotations: async () => SAMPLE_ANNOTATIONS,
    };

    const excerpt = await readFailureExcerpt({ name: "gate", link: `${RUN}/job/1`, sha: SHA }, github);

    expect(excerpt).toMatchObject({ kind: "actions", steps: [{ name: "Typecheck", earlier: 0 }] });
    expect(excerpt.kind === "actions" ? excerpt.steps[0]?.lines.at(-1) : "").toBe("##[error]Process completed with exit code 1.");
  });

  it("a first attempt's job stays readable by its own id after the re-run, so the first attempt's link reads the first attempt", async () => {
    // Observed: run 44046177767 re-run once; attempt 1's job and attempt 2's job both read by their ids, each with its own steps, logs and annotations.
    const jobs: Record<number, ActionsJob> = {
      133912299641: { status: "completed", conclusion: "failure", steps: [{ name: "Run pnpm test", number: 9, conclusion: "failure" }] },
      133917331191: { status: "completed", conclusion: "failure", steps: [{ name: "Run pnpm lint", number: 8, conclusion: "failure" }] },
    };
    const logs: Record<string, string> = { "133912299641/9": "##[error]first attempt\n", "133917331191/8": "##[error]re-run\n" };
    const github: FailureReader = {
      job: async (id) => jobs[id]!,
      stepLog: async (id, step) => logs[`${id}/${step}`]!,
      annotations: async () => [],
    };

    const first = await readFailureExcerpt({ name: "gate", link: `${RUN}/job/133912299641`, sha: SHA }, github);
    const rerun = await readFailureExcerpt({ name: "gate", link: `${RUN}/job/133917331191`, sha: SHA }, github);

    expect(first).toMatchObject({ steps: [{ name: "Run pnpm test", lines: ["##[error]first attempt"] }] });
    expect(rerun).toMatchObject({ steps: [{ name: "Run pnpm lint", lines: ["##[error]re-run"] }] });
  });

  it("a job GitHub never gave a runner leaves no steps, no log and no annotation, and reads as never started", async () => {
    // Observed: a job that failed with no runner name, no steps, no annotation, and a job log GitHub's storage answered 404.
    const github: FailureReader = {
      job: async () => ({ status: "completed", conclusion: "failure", steps: [] }),
      stepLog: async () => Promise.reject(new GitHubError("GitHub GET …/logs failed: 404", 404)),
      annotations: async () => [],
    };

    expect(await readFailureExcerpt({ name: "tick / Tick", link: `${RUN}/job/129351397709`, sha: SHA }, github)).toEqual({
      kind: "unread",
      check: "tick / Tick",
      link: `${RUN}/job/129351397709`,
      why: "the job never started, so it left no log and no annotation",
    });
  });
});
