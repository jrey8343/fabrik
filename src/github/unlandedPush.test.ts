// A run's push note is posted before its push (#420), so the Review the push
// starts sees the run's outcome. The note names the head it announces, and
// the snapshot reads a note whose head never reached the branch as no push at
// all: the run stays in flight, a re-run of the push job lands its work, and
// a Review of a push of the Operator's meanwhile is never taken for the run's.
// These tests replay a PR's thread: each plan's note is posted on the fake
// GitHub, the push lands or fails, and the next snapshot reads it all back.
import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import {
  A,
  actionsOf,
  B,
  C,
  conflicted,
  D,
  finished,
  flawedOnA,
  type ImplementRunFinished,
  MAIN,
  pushes,
  RUN,
  requestedChanges,
} from "../__fixtures__/pullRequestThread.ts";
import { runInFlight } from "../loop/retry.ts";
import { planFor } from "../loop/rules.ts";

describe("A Retry whose push failed after its note (#420)", () => {
  it("stays in flight, so a re-run of its push job lands its work rather than dropping it", async () => {
    const thread = flawedOnA();
    const retry = finished(B, { retry: 1, retryFlaw: A });

    thread.apply(planFor(retry, await thread.pushJobSnapshot(), kitConfig()), { pushLands: false, tip: B });

    expect(runInFlight(await thread.pullRequest())).toEqual({ kind: "retry", retry: 1, flaw: A });
    const rerun = planFor(retry, await thread.pushJobSnapshot(), kitConfig());
    expect(pushes(rerun)).toBe(true);
    thread.apply(rerun, { pushLands: true, tip: B });
    expect(runInFlight(await thread.pullRequest())).toBeNull();
  });

  it("gives a push of the Operator's that its lease refused for no Verdict, so the Review isn't taken for the Retry's and uses up no retry", async () => {
    const thread = flawedOnA();
    const retry = finished(B, { retry: 1, retryFlaw: A });
    const plan = planFor(retry, await thread.pushJobSnapshot(), kitConfig());
    // The Operator pushes C while the push job runs, so the lease refuses the Retry's push.
    thread.commits = [A, C];
    thread.apply(plan, { pushLands: false, tip: B });

    const operatorsPush = await thread.pullRequest();
    const review = { kind: "review-run-finished", pullRequest: 50, headSha: C, output: "verdict: execution-flaw\n\nStill throws.", runUrl: RUN, repoUrl: "https://github.com/acme/shop" } as const;
    expect(planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOf(anIssue(), { pullRequest: operatorsPush }), kitConfig()).kind).toBe("nothing");
    expect(planFor(review, snapshotOf(anIssue(), { pullRequest: operatorsPush }), kitConfig()).kind).toBe("nothing");
    // The re-run rebases the Retry's commits onto C and lands them.
    const rerun = planFor(finished(D, { retry: 1, retryFlaw: A }), await thread.pushJobSnapshot(), kitConfig());
    expect(pushes(rerun)).toBe(true);
  });

  it("reads as pushed once its head is on the branch, so the Review its push started gives a Verdict", async () => {
    const thread = flawedOnA();

    thread.apply(planFor(finished(B, { retry: 1, retryFlaw: A }), await thread.pushJobSnapshot(), kitConfig()), { pushLands: true, tip: B });

    const pullRequest = await thread.pullRequest();
    expect(pullRequest).toMatchObject({ headSha: B, pushedSinceVerdict: true });
    expect(actionsOf(planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOf(anIssue(), { pullRequest }), kitConfig()))).toContainEqual(
      expect.objectContaining({ kind: "start-agent-run", role: "review" }),
    );
  });

  it("still reads as pushed once the Operator pushes on top of it", async () => {
    const thread = flawedOnA();
    thread.apply(planFor(finished(B, { retry: 1, retryFlaw: A }), await thread.pushJobSnapshot(), kitConfig()), { pushLands: true, tip: B });

    thread.commits = [A, B, C];

    expect(await thread.pullRequest()).toMatchObject({ pushedSinceVerdict: true });
    expect(runInFlight(await thread.pullRequest())).toBeNull();
  });

  it("dates no push of the branch by its note, as the Kit never pushed", async () => {
    const thread = flawedOnA();

    thread.apply(planFor(finished(B, { retry: 1, retryFlaw: A }), await thread.pushJobSnapshot(), kitConfig()), { pushLands: false, tip: B });

    expect((await thread.pullRequest()).headPushedAt).toBe("2026-11-01T09:00:00Z");
  });
});

describe("A Request-changes run whose push failed after its note (#420)", () => {
  it("leaves the Operator's review unbuilt and the run in flight, so a re-run of its push job lands its work", async () => {
    const thread = requestedChanges();
    const run = finished(B, { review: 101 });

    thread.apply(planFor(run, await thread.pushJobSnapshot(), kitConfig()), { pushLands: false, tip: B });

    const pullRequest = await thread.pullRequest();
    expect(pullRequest.requestChangesRunInFlight).toBe(101);
    expect(pullRequest.unbuiltChangesRequests.map(({ review }) => review)).toEqual([101]);
    expect(pushes(planFor(run, await thread.pushJobSnapshot(), kitConfig()))).toBe(true);
  });

  it("settles the Operator's review once its push lands", async () => {
    const thread = requestedChanges();

    thread.apply(planFor(finished(B, { review: 101 }), await thread.pushJobSnapshot(), kitConfig()), { pushLands: true, tip: B });

    const pullRequest = await thread.pullRequest();
    expect(pullRequest.requestChangesRunInFlight).toBeNull();
    expect(pullRequest.unbuiltChangesRequests).toEqual([]);
  });
});

describe("A conflict-only run whose push failed after its note (#420)", () => {
  const rebased = (tip: string): ImplementRunFinished => {
    const run = finished(tip, { conflict: MAIN });
    return { ...run, changes: { ...run.changes, updatedFromMain: true } };
  };

  it("stays in flight, so a re-run of its push job lands its work", async () => {
    const thread = conflicted();

    thread.apply(planFor(rebased(B), await thread.pushJobSnapshot(), kitConfig()), { pushLands: false, tip: B });

    expect((await thread.pullRequest()).conflictRunInFlight).toBe(MAIN);
    expect(pushes(planFor(rebased(B), await thread.pushJobSnapshot(), kitConfig()))).toBe(true);
  });

  it("ends once its push lands, though its rebase left the earlier head off the branch", async () => {
    const thread = conflicted();

    thread.apply(planFor(rebased(B), await thread.pushJobSnapshot(), kitConfig()), { pushLands: true, tip: B });
    thread.commits = [MAIN, B];

    expect((await thread.pullRequest()).conflictRunInFlight).toBeNull();
  });
});
