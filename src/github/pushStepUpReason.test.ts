// The Kit's push note for each Implement run on a PR records that run's
// Step-up reason (#746), so a later run's model can be read from the PR alone.
// These tests replay a PR's thread: each run's push note is posted on the fake
// GitHub, its push lands, and the next snapshot reads the reason back.
import { describe, expect, it } from "vitest";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import {
  A,
  actionsOf,
  B,
  C,
  conflicted,
  type Fixes,
  finished,
  flawedOnA,
  MAIN,
  PullRequestOnGitHub,
  requestedChanges,
} from "../__fixtures__/pullRequestThread.ts";
import { conflictAttemptMarker, RETRY_PUSH_MARKER, verdictMarker } from "../loop/markers.ts";
import { planFor } from "../loop/rules.ts";
import type { Plan, StepUpReason } from "../loop/types.ts";

const Z = "0".repeat(40);

const flawOn = (headSha: string): string => verdictMarker({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha });

/** A PR whose Retry 1, after a flaw on Z, pushed A with a note from before #746, and A got an Execution flaw too: Retry 2 is in flight. */
function flawedTwice(): PullRequestOnGitHub {
  const thread = new PullRequestOnGitHub();
  thread.kitSays(flawOn(Z));
  thread.kitSays(`${RETRY_PUSH_MARKER}\nThe Implementer pushed a fix for the Execution flaw to \`fabrik/ticket-7\`; Review runs again on it.`);
  thread.kitSays(flawOn(A));
  return thread;
}

/** Lands the run's push as `tip`, its note posted first. */
async function lands(thread: PullRequestOnGitHub, tip: string, fixes: Partial<Fixes>, base = A, updatedFromMain = false): Promise<void> {
  const run = finished(tip, fixes, base);
  const event = updatedFromMain ? { ...run, changes: { ...run.changes, updatedFromMain } } : run;
  thread.apply(planFor(event, await thread.pushJobSnapshot(), kitConfig()), { pushLands: true, tip });
}

describe("A push note records its run's Step-up reason, which the snapshot reads back (#746)", () => {
  it("reads a Retry 2's push as stepped up for `retry`", async () => {
    const thread = flawedTwice();

    await lands(thread, B, { retry: 2, retryFlaw: A, stepUpReason: "retry" });

    expect((await thread.pullRequest()).lastPushStepUpReason).toBe("retry");
  });

  it("reads a Retry 1's push as not stepped up", async () => {
    const thread = flawedOnA();

    await lands(thread, B, { retry: 1, retryFlaw: A });

    expect((await thread.pullRequest()).lastPushStepUpReason).toBeNull();
  });

  it("reads a Retry's push on a Ticket marked fabrik:step-up as stepped up for `marked`", async () => {
    const thread = flawedOnA();

    await lands(thread, B, { retry: 1, retryFlaw: A, stepUpReason: "marked" });

    expect((await thread.pullRequest()).lastPushStepUpReason).toBe("marked");
  });

  it("reads a Request-changes run's push as stepped up for `request-changes`", async () => {
    const thread = requestedChanges();

    await lands(thread, B, { review: 101, stepUpReason: "request-changes" });

    expect((await thread.pullRequest()).lastPushStepUpReason).toBe("request-changes");
  });

  it("reads a conflict-only run's push as stepped up for `conflict-only`", async () => {
    const thread = conflicted();

    await lands(thread, B, { conflict: MAIN, stepUpReason: "conflict-only" }, A, true);
    thread.commits = [MAIN, B];

    expect((await thread.pullRequest()).lastPushStepUpReason).toBe("conflict-only");
  });

  it("reads a PR with only its first run's push as not stepped up", async () => {
    expect((await flawedOnA().pullRequest()).lastPushStepUpReason).toBeNull();
  });

  it("reads a push note from before the reason was recorded as not stepped up", async () => {
    expect((await flawedTwice().pullRequest()).lastPushStepUpReason).toBeNull();
  });

  it("reads the latest run's push: a Retry 2 after a `marked` Retry 1 reads as `retry`", async () => {
    const thread = flawedOnA();
    await lands(thread, B, { retry: 1, retryFlaw: A, stepUpReason: "marked" });
    thread.kitSays(flawOn(B));

    await lands(thread, C, { retry: 2, retryFlaw: B, stepUpReason: "retry" }, B);

    expect((await thread.pullRequest()).lastPushStepUpReason).toBe("retry");
  });

  it.each([
    ["an Operator's push", (thread: PullRequestOnGitHub) => void (thread.commits = [A, B, C])],
    ["the Kit's clean rebase onto main", (thread: PullRequestOnGitHub) => thread.kitSays(`${conflictAttemptMarker({ main: MAIN, outcome: "rebased" })}\nThe Kit rebased it.`)],
  ])("leaves the reason as it was after %s, which is no run", async (_, push) => {
    const thread = flawedTwice();
    await lands(thread, B, { retry: 2, retryFlaw: A, stepUpReason: "retry" });

    push(thread);

    expect((await thread.pullRequest()).lastPushStepUpReason).toBe("retry");
  });
});

describe("A push note's Step-up reason changes nothing else it says or does (#746)", () => {
  /** The plan's push note, less its Step-up reason line. */
  const noteWithout = (plan: Plan): string => {
    const note = actionsOf(plan).find((action) => action.kind === "comment");
    if (note?.kind !== "comment") throw new Error("expected a push note");
    return note.body
      .split("\n")
      .filter((line) => !line.startsWith("<!-- fabrik:step-up-reason "))
      .join("\n");
  };

  it.each([
    ["a Retry's", flawedOnA, { retry: 1, retryFlaw: A }, "marked", false],
    ["a Request-changes run's", requestedChanges, { review: 101 }, "request-changes", false],
    ["a conflict-only run's", conflicted, { conflict: MAIN }, "conflict-only", true],
  ] as const)("%s", async (_, thread, fixes, reason: StepUpReason, updatedFromMain) => {
    const snapshot = await thread().pushJobSnapshot();
    const planned = (more: Partial<Fixes>): Plan => {
      const run = finished(B, { ...fixes, ...more });
      return planFor(updatedFromMain ? { ...run, changes: { ...run.changes, updatedFromMain } } : run, snapshot, kitConfig());
    };
    const plain = planned({});
    const stepped = planned({ stepUpReason: reason });

    expect(noteWithout(plain)).toBe(noteWithout(stepped));
    expect(actionsOf(stepped).filter((action) => action.kind !== "comment")).toEqual(actionsOf(plain).filter((action) => action.kind !== "comment"));
  });
});
