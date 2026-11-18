// A head whose Required checks are still red after everything the Kit could
// do goes to the Reviewer (#779). One Verdict, from the Reviewer, holds the
// code's findings and the red checks together. A red check the Reviewer gives
// no judgment of counts as the pull request's own (#780), as each does here:
// anything short of a Design flaw is an Execution flaw that calls for a Retry,
// never a Touch-up. src/loop/unrelatedFailure.test.ts covers the judgments.
import { describe, expect, it } from "vitest";
import { aPullRequest, HEAD_SHA, kitConfig, notificationsOf, snapshotOfPullRequest, verdictsPostedIn } from "../__fixtures__/snapshots.ts";
import type { CheckExcerpt } from "../review/failureExcerpt.ts";
import type { ChangeFingerprint } from "./changeFingerprint.ts";
import { DISPATCH_LABEL, READY_FOR_AGENT } from "./labels.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, PullRequestSnapshot, RedRequiredChecks, VerdictRecord } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const JOB = "https://github.com/acme/shop/actions/runs/7/job/8";
const FIRST_JOB = "https://github.com/acme/shop/actions/runs/7/job/6";
const CHANGE: ChangeFingerprint = { v: 1, all: "0123456789ab", product: "ba9876543210", files: { "src/cart.ts": "aaaaaaaaaaaa" } };

const excerpt: CheckExcerpt = {
  kind: "actions",
  check: "build",
  link: JOB,
  steps: [{ name: "Run pnpm test", earlier: 0, lines: ["FAIL src/a.test.ts > adds", "##[error]Process completed with exit code 1."] }],
  annotations: [{ path: "src/a.test.ts", line: 12, message: "AssertionError: expected 3 to be 4" }],
  firstAttempt: {
    kind: "actions",
    check: "build",
    link: FIRST_JOB,
    steps: [{ name: "Run pnpm test", earlier: 0, lines: ["FAIL src/a.test.ts > adds"] }],
    annotations: [],
  },
};

/** `build` failed again on the Kit's re-run, and `Vercel`, an outside check, couldn't be re-run. */
const RED: RedRequiredChecks = {
  failed: ["build", "Vercel"],
  rerun: { outside: ["Vercel"], failedAgain: ["build"], flaky: [], refused: null },
  excerpts: [excerpt],
};

function reviewedRed(output: string, overrides: Partial<Extract<LoopEvent, { kind: "review-run-finished" }>> = {}): LoopEvent {
  return { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output, runUrl: RUN, repoUrl: "https://github.com/acme/shop", redChecks: RED, ...overrides };
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

function verdictsOf(plan: Plan): string[] {
  return actionsOf(plan).flatMap((action) => (action.kind === "comment" && action.body.includes("## Verdict") ? [action.body] : []));
}

const land = (output: string, pullRequest: PullRequestSnapshot = aPullRequest(), overrides: Partial<Extract<LoopEvent, { kind: "review-run-finished" }>> = {}) =>
  planFor(reviewedRed(output, overrides), snapshotOfPullRequest(pullRequest), kitConfig());

const retryStarted = (plan: Plan) => actionsOf(plan).some((action) => action.kind === "add-labels" && action.issue === 7 && action.labels.includes(DISPATCH_LABEL));

describe("The Reviewer's Verdict on a head whose Required checks are still red (#779)", () => {
  it("an Execution flaw lands as one Verdict, from the Reviewer, with its findings and then the red checks, and calls for a Retry", () => {
    const plan = land("verdict: execution-flaw\n\n- `add` in `src/a.ts` returns the wrong sum.");

    const verdicts = verdictsOf(plan);
    expect(verdicts).toHaveLength(1);
    const [body] = verdicts;
    expect(verdictsPostedIn(verdicts)).toEqual([
      {
        verdict: "execution-flaw",
        source: "reviewer",
        requestChanges: false,
        checks: ["build", "Vercel"],
        tags: { small: 0, missedEarlier: 0, counted: 1, smallBody: 0 },
        headSha: HEAD_SHA,
      },
    ]);
    expect(body).toContain("From the Reviewer, on aaaaaaa.");
    // The findings, then the red checks.
    expect(body!.indexOf("- `add` in `src/a.ts` returns the wrong sum.")).toBeLessThan(body!.indexOf("### Red Required checks"));
    expect(body).toContain("Retry 1 of 2");
    expect(retryStarted(plan)).toBe(true);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("the red checks part carries each check under its name with its attempts, its excerpt and its job link", () => {
    const [body] = verdictsOf(land("verdict: execution-flaw\n\n- A bug."));

    const part = body!.split("### Red Required checks")[1]!;
    expect(part).toContain(`These failed again when the Kit re-ran them on the same head:\n\n- \`build\` ([the job](${JOB}))`);
    expect(part).toContain("  The step `Run pnpm test` failed. The end of its log:");
    expect(part).toContain("  FAIL src/a.test.ts > adds");
    expect(part).toContain("    AssertionError: expected 3 to be 4");
    expect(part).toContain(`  Its first attempt, before the Kit re-ran it ([the job](${FIRST_JOB})): the step \`Run pnpm test\` failed.`);
    expect(part).toContain("  The same step, `Run pnpm test`, failed both times.");
    expect(part).toContain("These aren't GitHub Actions, so the Kit couldn't re-run them:\n\n- `Vercel`");
  });

  it("says why the Kit didn't re-run a check, and that a check's failure couldn't be read when no excerpt came for it", () => {
    const refused: RedRequiredChecks = { failed: ["build"], rerun: { outside: [], failedAgain: [], flaky: [], refused: "they had been re-run on this head already" }, excerpts: [] };

    const [body] = verdictsOf(land("verdict: execution-flaw\n\n- A bug.", aPullRequest(), { redChecks: refused }));

    const part = body!.split("### Red Required checks")[1]!;
    expect(part).toContain("The Kit didn't re-run these: they had been re-run on this head already.\n\n- `build`");
    expect(part).toContain("Its failure couldn't be read: the Review checks job passed out no Failure excerpt for it.");
  });

  it("fits the findings and the red checks' excerpts in one comment, cutting the excerpts' log lines", () => {
    const lines = Array.from({ length: 150 }, (_, i) => `${"x".repeat(300)} line ${i}`);
    const long = (check: string): CheckExcerpt => ({ ...excerpt, check, steps: [{ name: "Run pnpm test", earlier: 0, lines }], firstAttempt: undefined });
    const red: RedRequiredChecks = { failed: ["a", "b"], excerpts: [long("a"), long("b")] };

    const [body] = verdictsOf(land(`verdict: execution-flaw\n\n- ${"y".repeat(30_000)}`, aPullRequest(), { redChecks: red }));

    expect(body!.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain("y".repeat(30_000));
    expect(body).toContain("earlier lines left out");
    expect(body).toContain("line 149");
  });

  it("a pass lands as an Execution flaw whose findings are the red checks, and calls for a Retry, keeping the pull request in draft", () => {
    const plan = land("verdict: pass\n\nChecked each acceptance criterion against the diff.\n\nfollow-ups:\n- The badge miscounts\n  Already so.");

    const verdicts = verdictsOf(plan);
    expect(verdictsPostedIn(verdicts)).toEqual([
      {
        verdict: "execution-flaw",
        source: "reviewer",
        requestChanges: false,
        checks: ["build", "Vercel"],
        tags: { small: 0, missedEarlier: 0, counted: 0, smallBody: 0 },
        headSha: HEAD_SHA,
      },
    ]);
    const [body] = verdicts;
    expect(body).toContain("## Verdict: Execution flaw");
    expect(body).toContain("### Red Required checks");
    expect(body).toContain("Checked each acceptance criterion against the diff.");
    // Only a pass carries Follow-ups.
    expect(body).not.toContain("The badge miscounts");
    expect(retryStarted(plan)).toBe(true);
    expect(actionsOf(plan).map((action) => action.kind)).not.toContain("mark-ready-for-review");
    expect(actionsOf(plan).map((action) => action.kind)).not.toContain("start-agent-run");
  });

  it("an Execution flaw whose findings are all tagged calls for a Retry, not a Touch-up, and its tags still count its findings", () => {
    const plan = land("verdict: execution-flaw\n\n- [small: body] The body names the old route.\n- [small: comment] A stale comment.");

    const [record] = verdictsPostedIn(verdictsOf(plan)) as VerdictRecord[];
    expect(record).toMatchObject({ tags: { small: 2, missedEarlier: 0, counted: 0, smallBody: 1 }, checks: ["build", "Vercel"] });
    expect(record).not.toHaveProperty("touchUp");
    expect(verdictsOf(plan)[0]).toContain("Retry 1 of 2");
    expect(verdictsOf(plan)[0]).not.toContain("Touch-up");
    expect(retryStarted(plan)).toBe(true);
  });

  it("an Execution flaw on a red head counts toward the Retries: with none left, the Ticket goes back to design", () => {
    const flaw = (headSha: string): VerdictRecord => ({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha });
    const plan = land("verdict: pass\n\nLooks right.", aPullRequest({ verdicts: [flaw("1".repeat(40)), flaw("2".repeat(40))], pushedSinceVerdict: true }));

    expect(verdictsPostedIn(verdictsOf(plan))).toEqual([expect.objectContaining({ verdict: "execution-flaw", checks: ["build", "Vercel"] })]);
    expect(verdictsOf(plan)[0]).toContain("This is the Ticket's third Execution flaw, which counts as a Design flaw.");
    expect(actionsOf(plan).map((action) => action.kind)).toContain("close-pull-request");
  });

  it("a Design flaw sends the Ticket back to design, and still names the red checks", () => {
    const plan = land("verdict: design-flaw\n\nThe Ticket asks for two contradictory things.");

    expect(verdictsPostedIn(verdictsOf(plan))).toEqual([{ verdict: "design-flaw", source: "reviewer", requestChanges: false, checks: ["build", "Vercel"], headSha: HEAD_SHA }]);
    expect(verdictsOf(plan)[0]).toContain("### Red Required checks");
    expect(actionsOf(plan).map((action) => action.kind)).toContain("close-pull-request");
    expect(retryStarted(plan)).toBe(false);
  });

  it("reports a check the Kit's re-run turned green beside one still red as a Flaky check, ahead of the Verdict", () => {
    const flaky = [{ name: "lint", red: "https://github.com/acme/shop/actions/runs/9/job/1", green: "https://github.com/acme/shop/actions/runs/9/job/2" }];

    const plan = land("verdict: execution-flaw\n\n- A bug.", aPullRequest(), { flaky, redChecks: { ...RED, rerun: { ...RED.rerun!, flaky } } });

    const kinds = actionsOf(plan).map((action) => action.kind);
    expect(kinds.indexOf("comment-linking")).toBeLessThan(kinds.indexOf("comment"));
    const line = actionsOf(plan).find((action) => action.kind === "comment-linking");
    expect(JSON.stringify(line)).toContain("`lint`");
    expect(verdictsOf(plan)).toHaveLength(1);
  });

  it("gives way to the Operator's unbuilt Request changes first (#341), as any Execution flaw does", () => {
    const pullRequest = aPullRequest({ unbuiltChangesRequests: [{ review: 9, reviewer: "operator", reviewerIsBot: false, submittedAt: "2026-11-08T05:00:00.000Z" }] });

    const plan = land("verdict: pass\n\nLooks right.", pullRequest);

    expect(verdictsPostedIn(verdictsOf(plan))).toEqual([expect.objectContaining({ verdict: "execution-flaw", requestChangesFirst: [9], checks: ["build", "Vercel"] })]);
    expect(verdictsOf(plan)[0]).toContain("This Execution flaw uses no retry.");
  });

  it("starts nothing on a Ticket no longer ready-for-agent (#416), as any Execution flaw does", () => {
    const plan = land("verdict: execution-flaw\n\n- A bug.", aPullRequest({ ticketLabels: ["needs-design"] }));

    expect(verdictsPostedIn(verdictsOf(plan))).toEqual([expect.objectContaining({ verdict: "execution-flaw", ticketNotReady: true })]);
    expect(retryStarted(plan)).toBe(false);
  });

  it("the Review of a red head with nothing settled is a Full Review, and its Verdict makes the next Review a later one judged against it", () => {
    const pullRequest = aPullRequest({ change: CHANGE, ticketLabels: [READY_FOR_AGENT] });
    const started = (pr: PullRequestSnapshot) => {
      const plan = planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(pr), kitConfig());
      return actionsOf(plan).find((action) => action.kind === "start-agent-run");
    };
    expect(started(pullRequest)).toMatchObject({ reviewKind: { kind: "full" } });

    // A Full Review has no settled code, so `[missed earlier]` counts as untagged.
    const plan = land("verdict: execution-flaw\n\n- [missed earlier] A bug.", pullRequest);
    const [record] = verdictsPostedIn(verdictsOf(plan)) as VerdictRecord[];
    expect(record).toMatchObject({ source: "reviewer", tags: { missedEarlier: 0, counted: 1 } });

    const next = aPullRequest({ headSha: "b".repeat(40), verdicts: [{ ...record!, change: CHANGE }], pushedSinceVerdict: true });
    expect(started(next)).toMatchObject({ reviewKind: { kind: "later", lastJudged: { headSha: HEAD_SHA, change: CHANGE } } });
  });
});
