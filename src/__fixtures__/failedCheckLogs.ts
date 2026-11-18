// What GitHub holds for a red GitHub Actions check, as the #710 research note
// read it: the Kit's own CI, workflow run 42449956659, job 128636834592, a
// `Typecheck and test` job that failed at its Typecheck step (step 5). The
// repo is public. The step's log is as `GET …/actions/jobs/{job}/steps/5/logs`
// returned it: a byte-order mark, a timestamp on each line, ANSI colour
// sequences, the runner's `##[group]` lines, and its `##[error]` lines.

export const SAMPLE_JOB_ID = 128636834592;
export const SAMPLE_JOB_LINK = "https://github.com/jrey8343/fabrik/actions/runs/42449956659/job/128636834592";

/** The job, as `GET …/actions/jobs/{job}` returns it, cut to the fields the Kit reads. */
export const SAMPLE_JOB = {
  id: SAMPLE_JOB_ID,
  run_attempt: 1,
  status: "completed",
  conclusion: "failure",
  html_url: SAMPLE_JOB_LINK,
  check_run_url: `https://api.github.com/repos/jrey8343/fabrik/check-runs/${SAMPLE_JOB_ID}`,
  steps: [
    { name: "Set up job", number: 1, status: "completed", conclusion: "success" },
    { name: "Check out Fabrik", number: 2, status: "completed", conclusion: "success" },
    { name: "Set up Node", number: 3, status: "completed", conclusion: "success" },
    { name: "Install", number: 4, status: "completed", conclusion: "success" },
    { name: "Typecheck", number: 5, status: "completed", conclusion: "failure" },
    { name: "Test", number: 6, status: "completed", conclusion: "skipped" },
    { name: "Post Set up Node", number: 12, status: "completed", conclusion: "success" },
    { name: "Complete job", number: 13, status: "completed", conclusion: "success" },
  ],
};

/** Step 5's log, byte for byte. */
export const SAMPLE_STEP_LOG = [
  "﻿2026-11-08T05:14:12.6748036Z ##[group]Run npm run typecheck",
  "2026-11-08T05:14:12.6748244Z \u001b[36;1mnpm run typecheck\u001b[0m",
  "2026-11-08T05:14:12.6765523Z shell: /usr/bin/bash -e {0}",
  "2026-11-08T05:14:12.6765689Z ##[endgroup]",
  "2026-11-08T05:14:12.7422653Z ",
  "2026-11-08T05:14:12.7423438Z > fabrik@0.0.0 typecheck",
  "2026-11-08T05:14:12.7423800Z > tsc --noEmit",
  "2026-11-08T05:14:12.7423955Z ",
  "2026-11-08T05:14:13.5242087Z ##[error]src/loop/conflicts.test.ts(211,47): error TS2741: Property 'implementJobUnderWay' is missing in type '{ main: string; now: string; pullRequests: { pullRequest: PullRequestSnapshot; mergeable: false; }[]; }' but required in type 'ConflictSnapshot'.",
  "2026-11-08T05:14:13.5631701Z ##[error]Process completed with exit code 1.",
  "",
].join("\n");

/** The check run's annotations, as `GET …/check-runs/{id}/annotations` returns them. Its level for an error is `failure`. */
export const SAMPLE_ANNOTATIONS = [
  {
    path: ".github",
    start_line: 10,
    end_line: 10,
    annotation_level: "failure",
    title: "",
    message: "Process completed with exit code 1.",
    raw_details: "",
  },
  {
    path: "src/loop/conflicts.test.ts",
    start_line: 211,
    end_line: 211,
    annotation_level: "failure",
    title: "",
    message:
      "Property 'implementJobUnderWay' is missing in type '{ main: string; now: string; pullRequests: { pullRequest: PullRequestSnapshot; mergeable: false; }[]; }' but required in type 'ConflictSnapshot'.",
    raw_details: "",
  },
  {
    path: ".github",
    start_line: 1,
    end_line: 1,
    annotation_level: "notice",
    title: "",
    message:
      '"The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026. For more information, see https://github.com/actions/runner-images/issues/14748"',
    raw_details: "",
  },
];
