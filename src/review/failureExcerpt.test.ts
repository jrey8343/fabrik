import { describe, expect, it } from "vitest";
import { SAMPLE_ANNOTATIONS, SAMPLE_JOB, SAMPLE_JOB_LINK, SAMPLE_STEP_LOG } from "../__fixtures__/failedCheckLogs.ts";
import { GitHubError } from "../github/client.ts";
import {
  type ActionsJob,
  type CheckAnnotation,
  type CheckRun,
  type CommitStatus,
  type ExcerptAnnotation,
  type FailedStep,
  type FailureExcerpt,
  type FailureReader,
  excerptsPassedOut,
  failureReaderOf,
  readFailureExcerpt,
  renderFailureExcerpts,
} from "./failureExcerpt.ts";

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

});

describe("A red check from an outside service's Failure excerpt (#777)", () => {
  const VERCEL = "https://vercel.com/acme/shop/abc";
  const status = (overrides: Partial<CommitStatus> = {}): CommitStatus => ({
    context: "Vercel",
    state: "failure",
    description: "Deployment has failed",
    target_url: "https://vercel.com/acme/shop/abc/logs",
    ...overrides,
  });
  /** A GitHub that holds these check runs and commit statuses on the head, and no GitHub Actions job. */
  const outside = ({ checkRuns = [], statuses = [] }: { checkRuns?: readonly CheckRun[]; statuses?: readonly CommitStatus[] }): FailureReader => ({
    ...reader(),
    job: async () => Promise.reject(new Error("an outside check has no job")),
    checkRuns: async (sha, name) => (sha === SHA ? checkRuns.filter((run) => run.name === name) : []),
    statuses: async (sha) => (sha === SHA ? statuses : []),
  });

  it("reads a red commit status's description and target link", async () => {
    const github = outside({ statuses: [status(), status({ context: "codecov/patch", description: "60% of diff hit" })] });

    expect(await readFailureExcerpt({ name: "Vercel", link: VERCEL, sha: SHA }, github)).toEqual({
      kind: "commit-status",
      check: "Vercel",
      link: "https://vercel.com/acme/shop/abc/logs",
      description: "Deployment has failed",
    });
  });

  const BUILDKITE = "https://buildkite.com/acme/shop/builds/812";
  const run = (overrides: Partial<CheckRun> = {}): CheckRun => ({
    id: 4242,
    name: "buildkite/shop",
    app: { slug: "buildkite" },
    details_url: BUILDKITE,
    html_url: "https://github.com/acme/shop/runs/4242",
    output: { title: "Build #812 failed", summary: "3 of 412 specs failed:\n- spec/cart_spec.rb:12" },
    ...overrides,
  });

  it("reads a red outside check run's title, summary, error annotations and details link", async () => {
    const annotations: CheckAnnotation[] = [
      { path: "spec/cart_spec.rb", start_line: 12, annotation_level: "failure", message: "expected 3, got 4" },
      { path: "spec/cart_spec.rb", start_line: 30, annotation_level: "warning", message: "slow spec" },
    ];
    const checked: number[] = [];
    const github: FailureReader = { ...outside({ checkRuns: [run()] }), annotations: async (id) => (checked.push(id), annotations) };

    expect(await readFailureExcerpt({ name: "buildkite/shop", link: BUILDKITE, sha: SHA }, github)).toEqual({
      kind: "outside-check-run",
      check: "buildkite/shop",
      link: BUILDKITE,
      title: "Build #812 failed",
      summary: "3 of 412 specs failed:\n- spec/cart_spec.rb:12",
      annotations: [{ path: "spec/cart_spec.rb", line: 12, message: "expected 3, got 4" }],
    });
    expect(checked).toEqual([4242]);
  });

  it("reads a check run's empty output as empty, keeping its link", async () => {
    const github: FailureReader = { ...outside({ checkRuns: [run({ output: { title: null, summary: null } })] }), annotations: async () => [] };

    expect(await readFailureExcerpt({ name: "buildkite/shop", link: BUILDKITE, sha: SHA }, github)).toEqual({
      kind: "outside-check-run",
      check: "buildkite/shop",
      link: BUILDKITE,
      title: "",
      summary: "",
      annotations: [],
    });
  });

  it("reads a commit status's missing description as empty, and keeps the check's link where it gave none", async () => {
    const github = outside({ statuses: [status({ description: null, target_url: null })] });

    expect(await readFailureExcerpt({ name: "Vercel", link: VERCEL, sha: SHA }, github)).toEqual({ kind: "commit-status", check: "Vercel", link: VERCEL, description: "" });
  });

  it("reads no GitHub Actions check run as an outside one", async () => {
    const github = outside({ checkRuns: [run({ app: { slug: "github-actions" } })], statuses: [status({ context: "buildkite/shop" })] });

    expect(await readFailureExcerpt({ name: "buildkite/shop", link: BUILDKITE, sha: SHA }, github)).toMatchObject({ kind: "commit-status" });
  });

  it("says why when GitHub refuses a read, and never throws", async () => {
    const refused = new GitHubError("GitHub GET /repos/acme/shop/commits/b/status failed: 403", 403, {
      body: '{"message":"Resource not accessible by integration"}',
      request: "GET /repos/acme/shop/commits/b/status",
    });
    const github: FailureReader = { ...outside({}), statuses: async () => Promise.reject(refused) };

    expect(await readFailureExcerpt({ name: "Vercel", link: VERCEL, sha: SHA }, github)).toEqual({
      kind: "unread",
      check: "Vercel",
      link: VERCEL,
      why: expect.stringMatching(/^GitHub refused the read: .*Resource not accessible by integration/),
    });
  });

  it("keeps a check run whose annotations GitHub refused, saying why", async () => {
    const github: FailureReader = { ...outside({ checkRuns: [run()] }), annotations: async () => Promise.reject(new TypeError("fetch failed")) };

    expect(await readFailureExcerpt({ name: "buildkite/shop", link: BUILDKITE, sha: SHA }, github)).toMatchObject({
      kind: "outside-check-run",
      title: "Build #812 failed",
      annotations: [],
      annotationsUnread: "GitHub refused the read: fetch failed",
    });
  });

  it("says GitHub holds nothing by the check's name on the head when it holds neither", async () => {
    expect(await readFailureExcerpt({ name: "Vercel", link: VERCEL, sha: SHA }, outside({}))).toEqual({
      kind: "unread",
      check: "Vercel",
      link: VERCEL,
      why: "GitHub holds no check run or commit status by that name on the head",
    });
  });
});

describe("Rendering Failure excerpts", () => {
  const LINK = "https://github.com/acme/shop/actions/runs/7/job/8";
  const actions = (check: string, steps: FailedStep[], annotations: ExcerptAnnotation[] = []): Extract<FailureExcerpt, { kind: "actions" }> => ({
    kind: "actions",
    check,
    link: LINK,
    steps,
    annotations,
  });

  it("puts a check's failed step, its log lines in a block of their own, and its error annotations under its name, with the job link", () => {
    const [block] = renderFailureExcerpts([
      actions(
        "Typecheck and test",
        [{ name: "Typecheck", earlier: 0, lines: ["> tsc --noEmit", "##[error]src/a.ts(2,3): error TS2741: nope", "##[error]Process completed with exit code 1."] }],
        [{ path: "src/a.ts", line: 2, message: "Property 'x' is missing" }],
      ),
    ]);

    expect(block).toBe(
      [
        `- \`Typecheck and test\` ([the job](${LINK}))`,
        "",
        "  The step `Typecheck` failed. The end of its log:",
        "",
        "  ```text",
        "  > tsc --noEmit",
        "  ##[error]src/a.ts(2,3): error TS2741: nope",
        "  ##[error]Process completed with exit code 1.",
        "  ```",
        "",
        "  Its error annotations:",
        "",
        "  - `src/a.ts`, line 2:",
        "",
        "    ```text",
        "    Property 'x' is missing",
        "    ```",
      ].join("\n"),
    );
  });

  it("says how many earlier lines were left out, linking the job, above the lines it kept", () => {
    const [block] = renderFailureExcerpts([actions("gate", [{ name: "Run pnpm test", earlier: 884, lines: ["FAIL a.test.ts"] }])]);

    expect(block).toContain(`  _884 earlier lines left out: [the whole log](${LINK})._\n\n  \`\`\`text\n  FAIL a.test.ts\n  \`\`\``);
  });

  it("shows each failed step of a job that has two", () => {
    const [block] = renderFailureExcerpts([
      actions("gate", [
        { name: "Lint", earlier: 0, lines: ["lint failed"] },
        { name: "Test", earlier: 0, lines: ["test failed"] },
      ]),
    ]);

    expect(block).toContain("The step `Lint` failed. The end of its log:\n\n  ```text\n  lint failed\n  ```");
    expect(block).toContain("The step `Test` failed. The end of its log:\n\n  ```text\n  test failed\n  ```");
  });

  it("says no step failed when none did, and gives the annotations alone", () => {
    const [block] = renderFailureExcerpts([actions("gate", [], [{ path: ".github", line: 1, message: "Canceling since a higher priority waiting request for gate-447 exists" }])]);

    expect(block).toContain("  No step failed. Its error annotations:");
    expect(block).toContain("Canceling since a higher priority waiting request for gate-447 exists");
  });

  it("says why under the check's name when its failure couldn't be read, with the job link", () => {
    const [block] = renderFailureExcerpts([{ kind: "unread", check: "gate", link: LINK, why: "the job hadn't finished when the Kit read it" }]);

    expect(block).toBe(`- \`gate\` ([the job](${LINK}))\n\n  Its failure couldn't be read: the job hadn't finished when the Kit read it.`);
  });

  it("says why under a step whose log couldn't be read, and under annotations that couldn't", () => {
    const [block] = renderFailureExcerpts([
      { ...actions("gate", [{ name: "Test", earlier: 0, lines: [], why: "the runner left no log lines for this step" }]), annotationsUnread: "GitHub refused the read: 403" },
    ]);

    expect(block).toContain("The step `Test` failed, and its log couldn't be read: the runner left no log lines for this step.");
    expect(block).toContain("Its annotations couldn't be read: GitHub refused the read: 403.");
  });

  it("fences the failure text in more backticks than it holds, so the text can't end its block", () => {
    const [block] = renderFailureExcerpts([actions("gate", [{ name: "Test", earlier: 0, lines: ["```", "@octocat broke ````it````"] }])]);

    expect(block).toContain("  `````text\n  ```\n  @octocat broke ````it````\n  `````");
  });
});

describe("Rendering a check that failed both times (#776)", () => {
  const FIRST = "https://github.com/acme/shop/actions/runs/7/job/8";
  const RERUN = "https://github.com/acme/shop/actions/runs/7/job/9";
  const attempt = (link: string, steps: FailedStep[], annotations: ExcerptAnnotation[] = []): Extract<FailureExcerpt, { kind: "actions" }> => ({
    kind: "actions",
    check: "unit",
    link,
    steps,
    annotations,
  });

  it("shows the re-run's excerpt, then the first attempt's failed step and annotations with none of its log lines, then that the same step failed both times", () => {
    const [block] = renderFailureExcerpts([
      {
        ...attempt(RERUN, [{ name: "Run pnpm test", earlier: 0, lines: ["FAIL src/b.test.ts > times out"] }], [{ path: "src/b.test.ts", line: 9, message: "Test timed out in 5000ms" }]),
        firstAttempt: attempt(
          FIRST,
          [{ name: "Run pnpm test", earlier: 40, lines: ["FAIL src/a.test.ts > first attempt only"] }],
          [{ path: "src/a.test.ts", line: 3, message: "AssertionError: expected 3 to be 4" }],
        ),
      },
    ]);

    expect(block).toBe(
      [
        `- \`unit\` ([the job](${RERUN}))`,
        "",
        "  The step `Run pnpm test` failed. The end of its log:",
        "",
        "  ```text",
        "  FAIL src/b.test.ts > times out",
        "  ```",
        "",
        "  Its error annotations:",
        "",
        "  - `src/b.test.ts`, line 9:",
        "",
        "    ```text",
        "    Test timed out in 5000ms",
        "    ```",
        "",
        `  Its first attempt, before the Kit re-ran it ([the job](${FIRST})): the step \`Run pnpm test\` failed. Its error annotations:`,
        "",
        "  - `src/a.test.ts`, line 3:",
        "",
        "    ```text",
        "    AssertionError: expected 3 to be 4",
        "    ```",
        "",
        "  The same step, `Run pnpm test`, failed both times.",
      ].join("\n"),
    );
  });

  it("names both steps when different steps failed on the two attempts", () => {
    const [block] = renderFailureExcerpts([
      { ...attempt(RERUN, [{ name: "Test", earlier: 0, lines: ["test failed"] }]), firstAttempt: attempt(FIRST, [{ name: "Lint", earlier: 0, lines: ["lint failed"] }]) },
    ]);

    expect(block).toContain(`  Its first attempt, before the Kit re-ran it ([the job](${FIRST})): the step \`Lint\` failed. It has no error annotation.`);
    expect(block!.endsWith("\n\n  Different steps failed: `Lint` the first time, and `Test` on the re-run.")).toBe(true);
    expect(block).not.toContain("lint failed");
  });

  it("names a first attempt where no step failed when the re-run's did", () => {
    const [block] = renderFailureExcerpts([
      {
        ...attempt(RERUN, [{ name: "Test", earlier: 0, lines: ["test failed"] }]),
        firstAttempt: attempt(FIRST, [], [{ path: ".github", line: null, message: "The runner has received a shutdown signal." }]),
      },
    ]);

    expect(block).toContain(`([the job](${FIRST})): no step failed. Its error annotations:`);
    expect(block).toContain("The runner has received a shutdown signal.");
    expect(block).toContain("Different steps failed: no step the first time, and `Test` on the re-run.");
  });

  it("says why a first attempt couldn't be read, still shows the re-run's excerpt, and says nothing of the same step", () => {
    const [block] = renderFailureExcerpts([
      {
        ...attempt(RERUN, [{ name: "Test", earlier: 0, lines: ["test failed"] }]),
        firstAttempt: { kind: "unread", check: "unit", link: FIRST, why: "GitHub refused the read: 403 Resource not accessible by integration" },
      },
    ]);

    expect(block).toContain("  The step `Test` failed. The end of its log:\n\n  ```text\n  test failed\n  ```");
    expect(block).toContain(
      `  Its first attempt, before the Kit re-ran it ([the job](${FIRST})), couldn't be read: GitHub refused the read: 403 Resource not accessible by integration.`,
    );
    expect(block).not.toContain("both times");
    expect(block).not.toContain("Different steps");
  });

  it("gives the re-run the whole 40,000 characters, the first attempt's log lines taking none of it", () => {
    const long = (prefix: string) => Array.from({ length: 150 }, (_, i) => `${prefix} ${String(i).padStart(3, "0")} `.padEnd(400, "x"));
    const [block] = renderFailureExcerpts([
      { ...attempt(RERUN, [{ name: "Test", earlier: 0, lines: long("again") }]), firstAttempt: attempt(FIRST, [{ name: "Test", earlier: 0, lines: long("first") }]) },
    ]);

    // 40,000 characters hold 99 lines of 401, as for a check with one attempt.
    expect(block!.match(/^ {2}again \d{3} x+$/gm)).toHaveLength(99);
    expect(block).not.toMatch(/first \d{3}/);
  });

  it("shortens the first attempt's annotation messages too when the comment has no room for them", () => {
    const message = "m".repeat(20_000);
    const blocks = renderFailureExcerpts(
      [{ ...attempt(RERUN, [{ name: "Test", earlier: 0, lines: ["test failed"] }]), firstAttempt: attempt(FIRST, [{ name: "Test", earlier: 0, lines: [] }], [{ path: "a.ts", line: 1, message }]) }],
      { room: 5_000 },
    );

    expect(blocks.join("\n\n").length).toBeLessThanOrEqual(5_000);
    expect(blocks[0]).toContain("_Shortened to fit the comment._");
    // Shortened only as far as it must be: most of the room is the message's.
    expect(blocks[0]).toContain("m".repeat(4_000));
    expect(blocks[0]).toContain("The same step, `Test`, failed both times.");
  });
});

describe("Rendering an outside check's Failure excerpt (#777)", () => {
  const VERCEL = "https://vercel.com/acme/shop/abc/logs";
  const BUILDKITE = "https://buildkite.com/acme/shop/builds/812";
  const status = (description: string): FailureExcerpt => ({ kind: "commit-status", check: "Vercel", link: VERCEL, description });
  const run = (overrides: Partial<Extract<FailureExcerpt, { kind: "outside-check-run" }>> = {}): FailureExcerpt => ({
    kind: "outside-check-run",
    check: "buildkite/shop",
    link: BUILDKITE,
    title: "Build #812 failed",
    summary: "3 of 412 specs failed:\n- spec/cart_spec.rb:12",
    annotations: [{ path: "spec/cart_spec.rb", line: 12, message: "expected 3, got 4" }],
    ...overrides,
  });

  it("shows a commit status's description and target link under its name, and says the service's own log can't be reached", () => {
    expect(renderFailureExcerpts([status("Deployment has failed")])).toEqual([
      [
        `- \`Vercel\` ([the service's page](${VERCEL}))`,
        "",
        "  A commit status from an outside service, whose own log can't be reached from GitHub. Its description:",
        "",
        "  ```text",
        "  Deployment has failed",
        "  ```",
      ].join("\n"),
    ]);
  });

  it("shows an outside check run's title, summary, error annotations and details link, and says the same", () => {
    expect(renderFailureExcerpts([run()])).toEqual([
      [
        `- \`buildkite/shop\` ([the service's page](${BUILDKITE}))`,
        "",
        "  A check run from an outside service, whose own log can't be reached from GitHub. Its title and summary:",
        "",
        "  ```text",
        "  Build #812 failed",
        "",
        "  3 of 412 specs failed:",
        "  - spec/cart_spec.rb:12",
        "  ```",
        "",
        "  Its error annotations:",
        "",
        "  - `spec/cart_spec.rb`, line 12:",
        "",
        "    ```text",
        "    expected 3, got 4",
        "    ```",
      ].join("\n"),
    ]);
  });

  it("says a commit status with no description wrote nothing to GitHub, and keeps its link", () => {
    expect(renderFailureExcerpts([status("")])).toEqual([
      [
        `- \`Vercel\` ([the service's page](${VERCEL}))`,
        "",
        "  A commit status from an outside service, whose own log can't be reached from GitHub. It wrote nothing to GitHub but its result: no description.",
      ].join("\n"),
    ]);
  });

  it("says a check run with no output wrote nothing to GitHub, and keeps its link", () => {
    expect(renderFailureExcerpts([run({ title: "", summary: "", annotations: [] })])).toEqual([
      [
        `- \`buildkite/shop\` ([the service's page](${BUILDKITE}))`,
        "",
        "  A check run from an outside service, whose own log can't be reached from GitHub. It wrote nothing to GitHub but its result: no title, summary or error annotation.",
      ].join("\n"),
    ]);
  });

  it("shows what a check run did write: its summary alone, or its annotations alone", () => {
    const [summaryOnly] = renderFailureExcerpts([run({ title: "", annotations: [] })]);
    expect(summaryOnly).toContain("Its summary:\n\n  ```text\n  3 of 412 specs failed:");
    expect(summaryOnly).toContain("It has no error annotation.");

    const [annotationsOnly] = renderFailureExcerpts([run({ title: "", summary: "" })]);
    expect(annotationsOnly).toContain("It wrote no title or summary.\n\n  Its error annotations:");
  });

  it("says why under its name when its annotations couldn't be read", () => {
    const [block] = renderFailureExcerpts([run({ annotations: [], annotationsUnread: "GitHub refused the read: 403" })]);

    expect(block).toContain("Its annotations couldn't be read: GitHub refused the read: 403.");
  });
});

describe("The cap on Failure excerpts' log lines", () => {
  const link = (check: string) => `https://github.com/acme/shop/actions/runs/7/job/${check}`;
  /** `count` lines of 100 characters, each 101 with its newline, numbered from 1. */
  const lines = (count: number, width = 100) => Array.from({ length: count }, (_, i) => `${String(i + 1).padStart(5, "0")} `.padEnd(width, "x"));
  const red = (check: string, logLines: string[], annotations: ExcerptAnnotation[] = []): Extract<FailureExcerpt, { kind: "actions" }> => ({
    kind: "actions",
    check,
    link: link(check),
    steps: [{ name: "Run pnpm test", earlier: 0, lines: logLines }],
    annotations,
  });
  /** The log lines a rendered block kept: the ones inside its first fenced block. */
  const kept = (block: string) => block.split("```text\n")[1]!.split("\n  ```")[0]!.split("\n");
  const keptChars = (block: string) => kept(block).reduce((sum, line) => sum + line.trim().length + 1, 0);

  it("splits 40,000 characters equally between three red checks, each cut from the top, saying how many lines were left out and linking its job", () => {
    const blocks = renderFailureExcerpts([red("a", lines(150)), red("b", lines(150)), red("c", lines(150))]);

    for (const [i, check] of ["a", "b", "c"].entries()) {
      const block = blocks[i]!;
      // 40,000 / 3 = 13,333 characters each, so 132 lines of 101 characters, the last 132.
      expect(keptChars(block)).toBe(132 * 101);
      expect(kept(block)[0]!.trim()).toBe(lines(150)[18]);
      expect(kept(block).at(-1)!.trim()).toBe(lines(150)[149]);
      expect(block).toContain(`_18 earlier lines left out: [the whole log](${link(check)})._`);
    }
  });

  it("counts the lines the 150-line cut left out with the ones the cap did", () => {
    const [block] = renderFailureExcerpts([{ ...red("a", lines(150, 400)), steps: [{ name: "Run pnpm test", earlier: 600, lines: lines(150, 400) }] }]);

    // 40,000 characters hold 99 lines of 401.
    expect(kept(block!)).toHaveLength(99);
    expect(block).toContain("_651 earlier lines left out");
  });

  it("hands no check another's unfilled share", () => {
    const blocks = renderFailureExcerpts([red("short", lines(5)), red("b", lines(150, 400)), red("c", lines(150, 400))]);

    expect(kept(blocks[0]!)).toHaveLength(5);
    // 13,333 characters hold 33 lines of 401, though "short" left most of its share.
    expect(kept(blocks[1]!)).toHaveLength(33);
    expect(kept(blocks[2]!)).toHaveLength(33);
  });

  it("gives the whole 40,000 to the checks that have log lines, sharing nothing with one that has none", () => {
    const blocks = renderFailureExcerpts([
      { kind: "unread", check: "gone", link: link("gone"), why: "the job never started, so it left no log and no annotation" },
      red("b", lines(150, 400)),
      red("c", lines(150, 400)),
    ]);

    // 20,000 characters hold 49 lines of 401.
    expect(kept(blocks[1]!)).toHaveLength(49);
    expect(kept(blocks[2]!)).toHaveLength(49);
  });

  it("gives the whole 40,000 to a GitHub Actions check beside an outside check, which has no log lines (#777)", () => {
    const blocks = renderFailureExcerpts([
      red("b", lines(150, 400)),
      { kind: "outside-check-run", check: "buildkite/shop", link: "https://buildkite.com/acme/shop/builds/812", title: "Build failed", summary: "s".repeat(30_000), annotations: [] },
      { kind: "commit-status", check: "Vercel", link: "https://vercel.com/acme/shop/abc", description: "Deployment has failed" },
    ]);

    // 40,000 characters hold 99 lines of 401, as for a check alone.
    expect(kept(blocks[0]!)).toHaveLength(99);
    expect(blocks[1]).toContain("s".repeat(30_000));
  });

  it("shortens an outside check's summary and annotations, saying so, when the comment would pass its room (#777)", () => {
    const summary = "s".repeat(20_000);
    const message = "m".repeat(20_000);
    const excerpts: FailureExcerpt[] = [
      red("a", lines(150, 400)),
      {
        kind: "outside-check-run",
        check: "buildkite/shop",
        link: "https://buildkite.com/acme/shop/builds/812",
        title: "Build failed",
        summary,
        annotations: [{ path: "spec/a_spec.rb", line: 1, message }],
      },
    ];

    const tight = renderFailureExcerpts(excerpts, { room: 20_000 }).join("\n\n");
    expect(tight.length).toBeLessThanOrEqual(20_000);
    expect(tight).not.toContain(summary);
    expect(tight).not.toContain(message);
    // Each shortened alike, as long as both fit: a little under half the room each.
    expect(tight).toContain("s".repeat(9_000));
    expect(tight).toContain("m".repeat(9_000));
    expect(tight).toContain("_Shortened to fit the comment._");
    expect(tight).toContain("- `buildkite/shop` ([the service's page](https://buildkite.com/acme/shop/builds/812))");
  });

  it("never cuts annotations for the cap", () => {
    const long = "e".repeat(30_000);
    const [block] = renderFailureExcerpts([red("a", lines(150, 400), [{ path: "src/a.test.ts", line: 3, message: long }])]);

    expect(block).toContain(long);
    expect(kept(block!)).toHaveLength(99);
  });

  it("cuts log lines further from the top, then shortens annotation messages, saying so, until every block fits the room it's given", () => {
    const message = "m".repeat(20_000);
    const excerpts = [
      red("a", lines(150, 400), [{ path: "src/a.test.ts", line: 1, message }]),
      red("b", lines(150, 400), [{ path: "src/b.test.ts", line: 2, message }]),
    ];

    const roomy = renderFailureExcerpts(excerpts, { room: 60_000 }).join("\n\n");
    expect(roomy.length).toBeLessThanOrEqual(60_000);
    expect(roomy).toContain(message);
    expect(roomy).toMatch(/_\d+ earlier lines left out/);

    const tight = renderFailureExcerpts(excerpts, { room: 30_000 }).join("\n\n");
    expect(tight.length).toBeLessThanOrEqual(30_000);
    expect(tight).not.toContain(message);
    expect(tight).toContain("_Shortened to fit the comment._");
    expect(tight).toContain("_150 earlier lines left out");
  });

  it("still names every check, with its job link, in a room too small for any of its excerpt", () => {
    const blocks = renderFailureExcerpts([red("a", lines(150)), red("b", lines(150))], { room: 400 });

    expect(blocks.join("\n\n").length).toBeLessThanOrEqual(400);
    expect(blocks[0]).toContain(`- \`a\` ([the job](${link("a")}))`);
    expect(blocks[1]).toContain(`- \`b\` ([the job](${link("b")}))`);
  });
});

describe("The FailureReader on a job's GitHub clients", () => {
  it("reads the job and its step's log on the Actions client, and the annotations on the Checks client, every page of them", async () => {
    const calls: string[] = [];
    const actions = {
      rest: async (_method: string, path: string) => (calls.push(`actions ${path}`), SAMPLE_JOB),
      logText: async (path: string) => (calls.push(`log ${path}`), SAMPLE_STEP_LOG),
    };
    const checks = { rest: async (_method: string, path: string) => (calls.push(`checks ${path}`), path.includes("page=1") ? SAMPLE_ANNOTATIONS : []) };

    const excerpt = await readFailureExcerpt({ name: "Typecheck and test", link: SAMPLE_JOB_LINK, sha: SHA }, failureReaderOf("jrey8343/fabrik", { actions, checks }));

    expect(calls).toEqual([
      "actions /repos/jrey8343/fabrik/actions/jobs/128636834592",
      "log /repos/jrey8343/fabrik/actions/jobs/128636834592/steps/5/logs",
      "checks /repos/jrey8343/fabrik/check-runs/128636834592/annotations?per_page=100&page=1",
    ]);
    expect(excerpt).toMatchObject({ kind: "actions", steps: [{ name: "Typecheck" }], annotations: [{ line: 10 }, { line: 211 }] });
  });

  it("reads the annotations on the Actions client when given no other", async () => {
    const paths: string[] = [];
    const actions = { rest: async (_method: string, path: string) => (paths.push(path), path.includes("annotations") ? [] : SAMPLE_JOB), logText: async () => SAMPLE_STEP_LOG };

    await readFailureExcerpt({ name: "Typecheck and test", link: SAMPLE_JOB_LINK, sha: SHA }, failureReaderOf("jrey8343/fabrik", { actions }));

    expect(paths.at(-1)).toBe("/repos/jrey8343/fabrik/check-runs/128636834592/annotations?per_page=100&page=1");
  });

  it("reads an outside check's check runs on the head by name, then its commit statuses, on the Checks client (#777)", async () => {
    const calls: string[] = [];
    const actions = { rest: async (_method: string, path: string) => (calls.push(`actions ${path}`), {}), logText: async () => "" };
    const checks = {
      rest: async (_method: string, path: string) => {
        calls.push(`checks ${path}`);
        if (path.includes("/check-runs?")) return { total_count: 0, check_runs: [] };
        return { state: "failure", statuses: [{ context: "ci/circle: build", state: "failure", description: "Your tests failed on CircleCI", target_url: "https://circleci.com/gh/acme/shop/9" }] };
      },
    };

    const excerpt = await readFailureExcerpt({ name: "ci/circle: build", link: "https://circleci.com/gh/acme/shop/9", sha: SHA }, failureReaderOf("acme/shop", { actions, checks }));

    expect(calls).toEqual([
      `checks /repos/acme/shop/commits/${SHA}/check-runs?check_name=ci%2Fcircle%3A%20build&filter=latest&per_page=100&page=1`,
      `checks /repos/acme/shop/commits/${SHA}/status?per_page=100&page=1`,
    ]);
    expect(excerpt).toEqual({ kind: "commit-status", check: "ci/circle: build", link: "https://circleci.com/gh/acme/shop/9", description: "Your tests failed on CircleCI" });
  });
});

describe("The excerpts the Review's waits pass out to the push job", () => {
  const first = (check: string, why: string): FailureExcerpt => ({ kind: "unread", check, link: `https://github.com/acme/shop/actions/runs/7/job/${check}-1`, why });
  const rerun = (check: string, why: string): FailureExcerpt => ({ kind: "unread", check, link: `https://github.com/acme/shop/actions/runs/7/job/${check}-2`, why });

  it("are each check's latest read: the re-run's for a check that failed again, with the first attempt's beside it, else the first wait's alone (#776)", () => {
    const passed = excerptsPassedOut(JSON.stringify([first("unit", "first"), first("lint", "first")]), JSON.stringify([rerun("unit", "again")]));

    expect(passed).toEqual([{ ...rerun("unit", "again"), firstAttempt: first("unit", "first") }, first("lint", "first")]);
  });

  it("are the re-run's alone for a check that failed again with no first attempt passed out", () => {
    expect(excerptsPassedOut(JSON.stringify([]), JSON.stringify([rerun("unit", "again")]))).toEqual([rerun("unit", "again")]);
  });

  it("are the first wait's alone when nothing was re-run", () => {
    expect(excerptsPassedOut(JSON.stringify([first("unit", "first")]), null)).toEqual([first("unit", "first")]);
  });

  it("are none when the artifact is missing, or doesn't read, so each check says its failure couldn't be read", () => {
    expect(excerptsPassedOut(null, null)).toEqual([]);
    expect(excerptsPassedOut("not json", "{}")).toEqual([]);
    expect(excerptsPassedOut(JSON.stringify([{ kind: "actions", check: "unit" }, first("lint", "first")]), null)).toEqual([first("lint", "first")]);
  });

  it("carry an outside check's excerpt, and drop one that doesn't read (#777)", () => {
    const status: FailureExcerpt = { kind: "commit-status", check: "Vercel", link: "https://vercel.com/acme/shop/abc", description: "Deployment has failed" };
    const run: FailureExcerpt = {
      kind: "outside-check-run",
      check: "buildkite/shop",
      link: "https://buildkite.com/acme/shop/builds/812",
      title: "Build failed",
      summary: "",
      annotations: [{ path: "spec/a_spec.rb", line: null, message: "boom" }],
      annotationsUnread: "GitHub refused the read: 403",
    };
    const broken = [
      { kind: "commit-status", check: "x", link: "" },
      { kind: "outside-check-run", check: "y", link: "", title: "t", summary: "s" },
    ];

    expect(excerptsPassedOut(JSON.stringify([status, run, ...broken]), null)).toEqual([status, run]);
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
