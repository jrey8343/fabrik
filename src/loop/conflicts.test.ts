// When main moves under an agent PR waiting at the Merge gate and leaves it
// conflicting, the Kit brings it up to date itself (#304): a mechanical rebase
// when that's clean, else one conflict-only Implementer run. One attempt per
// PR per main head.
import { describe, expect, it } from "vitest";
import { aPullRequest, kitConfig, snapshotOfPullRequest, tickSnapshot } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, ConflictCandidate, LoopEvent, Plan, PullRequestSnapshot, Snapshot, VerdictRecord } from "./types.ts";

const MAIN = "9".repeat(40);
const OLDER_MAIN = "8".repeat(40);
const HEAD = "a".repeat(40);

const PASSED: VerdictRecord = { verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD };

/** Agent PR #50 for Ticket #7 at the Merge gate: out of draft, its latest Verdict a pass, nothing in flight. */
function atMergeGate(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return aPullRequest({ draft: false, verdicts: [PASSED], ...overrides });
}

function conflictsSnapshot(candidates: readonly ConflictCandidate[], main: string | null = MAIN): Snapshot {
  return { ...snapshotOfPullRequest(aPullRequest()), pullRequest: null, conflicts: { main, now: "2026-01-01T00:00:00Z", implementJobUnderWay: null, pullRequests: candidates } };
}

const MAIN_PUSHED: LoopEvent = { kind: "main-pushed", head: MAIN };
const TICK: LoopEvent = { kind: "scheduled-tick", now: "2026-11-07T10:17:00Z" };

function rebasesIn(plan: Plan): Extract<Action, { kind: "rebase-onto-main" }>[] {
  return plan.kind === "act"
    ? plan.actions.filter((action): action is Extract<Action, { kind: "rebase-onto-main" }> => action.kind === "rebase-onto-main")
    : [];
}

function commentOn(actions: readonly Action[], issue: number): string {
  const comment = actions.find((action) => action.kind === "comment" && action.issue === issue);
  if (comment?.kind !== "comment") throw new Error(`No comment on #${issue}`);
  return comment.body;
}

describe("main moving under a conflicting agent PR at the Merge gate", () => {
  it("rebases its branch onto main's new head with no agent", () => {
    const plan = planFor(MAIN_PUSHED, conflictsSnapshot([{ pullRequest: atMergeGate(), mergeable: false }]), kitConfig());

    const [rebase] = rebasesIn(plan);
    expect(rebase).toMatchObject({ pullRequest: 50, branch: "fabrik/ticket-7", onto: MAIN });
  });

  it("when the rebase is clean, puts the PR back in draft before the push, so the push starts a full Review, and records the attempt once it lands, using no retry", () => {
    const [rebase] = rebasesIn(planFor(MAIN_PUSHED, conflictsSnapshot([{ pullRequest: atMergeGate(), mergeable: false }]), kitConfig()));

    expect(rebase?.clean).toEqual([{ kind: "convert-to-draft", pullRequest: 50 }]);
    expect(commentOn(rebase?.pushed ?? [], 50)).toMatch(new RegExp(`^<!-- fabrik:conflict-attempt ${MAIN} rebased -->`));
    expect([...(rebase?.clean ?? []), ...(rebase?.pushed ?? [])].some((action) => action.kind === "start-agent-run" || action.kind === "add-labels")).toBe(false);
  });

  it("when the push's lease refuses it, brings the PR back out of draft and records no attempt, so the next check tries again", () => {
    const [rebase] = rebasesIn(planFor(MAIN_PUSHED, conflictsSnapshot([{ pullRequest: atMergeGate(), mergeable: false }]), kitConfig()));

    expect(rebase?.refused).toEqual([{ kind: "mark-ready-for-review", pullRequest: 50 }]);
  });

  it("when the rebase conflicts, records the attempt, puts the PR back in draft and starts the conflict-only run through agent:implement", () => {
    const [rebase] = rebasesIn(planFor(MAIN_PUSHED, conflictsSnapshot([{ pullRequest: atMergeGate(), mergeable: false }]), kitConfig()));

    expect(commentOn(rebase?.conflicted ?? [], 50)).toMatch(new RegExp(`^<!-- fabrik:conflict-attempt ${MAIN} conflict-run -->`));
    expect(rebase?.conflicted).toContainEqual({ kind: "convert-to-draft", pullRequest: 50 });
    expect(rebase?.conflicted.at(-1)).toEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
  });

  it("weighs every open agent PR: each conflicting one gets its own attempt", () => {
    const plan = planFor(
      MAIN_PUSHED,
      conflictsSnapshot([
        { pullRequest: atMergeGate(), mergeable: false },
        { pullRequest: atMergeGate({ number: 51, ticket: 8 }), mergeable: false },
      ]),
      kitConfig(),
    );

    expect(rebasesIn(plan).map(({ pullRequest, branch }) => [pullRequest, branch])).toEqual([
      [50, "fabrik/ticket-7"],
      [51, "fabrik/ticket-8"],
    ]);
  });

  it("leaves a PR that's only behind main alone, with no push", () => {
    const plan = planFor(MAIN_PUSHED, conflictsSnapshot([{ pullRequest: atMergeGate(), mergeable: true }]), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: expect.stringContaining("#50 doesn't conflict with main") });
  });

  it("skips a draft PR, which is still in the Loop or which the Operator parked", () => {
    const plan = planFor(MAIN_PUSHED, conflictsSnapshot([{ pullRequest: atMergeGate({ draft: true }), mergeable: false }]), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: expect.stringContaining("#50 is a draft") });
  });

  it("doesn't rebase a PR with a Request-changes run in flight that never went back to draft: it starts that run, which brings main in", () => {
    const pullRequest = atMergeGate({
      notedChangesRequests: [9],
      requestChangesRunInFlight: 9,
      requestChangesRunReviews: [9],
      requestChangesRunSince: "2025-12-31T00:00:00Z",
    });

    const plan = planFor(MAIN_PUSHED, conflictsSnapshot([{ pullRequest, mergeable: false }]), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "add-labels", issue: 7, labels: ["agent:implement"] }] });
  });

  it("skips a PR with a Retry in flight, which is a draft", () => {
    const flaw: VerdictRecord = { verdict: "execution-flaw", source: "ci", requestChanges: false, headSha: HEAD };

    const plan = planFor(MAIN_PUSHED, conflictsSnapshot([{ pullRequest: atMergeGate({ verdicts: [flaw], draft: true }), mergeable: false }]), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: expect.stringContaining("#50 is a draft") });
  });

  it("isn't held by an Execution flaw on a PR that has since left draft: no Retry works on it", () => {
    const flaw: VerdictRecord = { verdict: "execution-flaw", source: "ci", requestChanges: false, headSha: HEAD };

    const plan = planFor(MAIN_PUSHED, conflictsSnapshot([{ pullRequest: atMergeGate({ verdicts: [flaw] }), mergeable: false }]), kitConfig());

    expect(plan.kind === "act" && plan.actions.some((action) => action.kind === "rebase-onto-main")).toBe(true);
  });

  it("skips a PR with a conflict-only run in flight", () => {
    const pullRequest = atMergeGate({ conflictAttempts: [OLDER_MAIN], conflictRunInFlight: OLDER_MAIN });

    const plan = planFor(MAIN_PUSHED, conflictsSnapshot([{ pullRequest, mergeable: false }]), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: expect.stringContaining("conflict-only run on #50 is still in flight") });
  });

  it("tries a PR once per main head: an attempt on this head already made is the bound", () => {
    const plan = planFor(MAIN_PUSHED, conflictsSnapshot([{ pullRequest: atMergeGate({ conflictAttempts: [MAIN] }), mergeable: false }]), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: expect.stringContaining(`#50 was already tried against main at ${MAIN.slice(0, 7)}`) });
  });

  it("tries it again once main has moved to a new head", () => {
    const plan = planFor(
      MAIN_PUSHED,
      conflictsSnapshot([{ pullRequest: atMergeGate({ conflictAttempts: [OLDER_MAIN] }), mergeable: false }]),
      kitConfig(),
    );

    expect(rebasesIn(plan)).toHaveLength(1);
  });

  it("leaves a PR whose mergeable state GitHub hadn't worked out for the scheduled tick", () => {
    const plan = planFor(MAIN_PUSHED, conflictsSnapshot([{ pullRequest: atMergeGate(), mergeable: null }]), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: expect.stringContaining("left for the scheduled tick") });
  });

  it("is the scheduled tick's to catch too, so a PR the push missed is acted on within the hour", () => {
    const plan = planFor(TICK, tickSnapshot({ conflicts: { main: MAIN, now: "2026-01-01T00:00:00Z", implementJobUnderWay: null, pullRequests: [{ pullRequest: atMergeGate(), mergeable: false }] } }), kitConfig());

    expect(rebasesIn(plan)).toEqual([expect.objectContaining({ pullRequest: 50, onto: MAIN })]);
  });

  it("fails a tick whose snapshot is missing the open agent PRs, rather than guess", () => {
    const plan = planFor(TICK, tickSnapshot({ conflicts: null }), kitConfig());

    expect(plan).toEqual({ kind: "fail", failure: "infrastructure", reason: expect.stringContaining("conflict check") });
  });

  it("does nothing on a repo whose default branch has no head", () => {
    const plan = planFor(MAIN_PUSHED, conflictsSnapshot([{ pullRequest: atMergeGate(), mergeable: false }], null), kitConfig());

    expect(rebasesIn(plan)).toEqual([]);
  });

  it("runs on a Kit config change too, beside its Dispatch and Design queue checks", () => {
    const plan = planFor({ kind: "kit-config-changed", head: MAIN }, conflictsSnapshot([{ pullRequest: atMergeGate(), mergeable: false }]), kitConfig());

    expect(plan.kind === "act" ? plan.actions.map((action) => action.kind) : []).toEqual([
      "check-dispatch",
      "check-design-queue",
      "rebase-onto-main",
    ]);
  });

  it("still runs a Kit config change's checks when no PR conflicts", () => {
    const plan = planFor({ kind: "kit-config-changed", head: MAIN }, conflictsSnapshot([]), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }] });
  });
});

describe("a draft agent PR whose push GitHub never reviewed, because it conflicts with main (#389)", () => {
  const NOW = "2026-01-01T00:00:00Z";
  /** Pushed an hour before the check: past the Review job's 30-minute timeout. */
  const AN_HOUR_AGO = "2025-12-31T23:00:00Z";

  /** Agent draft PR #50 for Ticket #7, first pushed by its Implement run an hour ago, with no Verdict on its head. */
  function stuckDraft(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
    return aPullRequest({ draft: true, verdicts: [], headPushedAt: AN_HOUR_AGO, ...overrides });
  }

  function check(pullRequest: PullRequestSnapshot, mergeable: boolean | null = false, event: LoopEvent = MAIN_PUSHED): Plan {
    return planFor(event, conflictsSnapshot([{ pullRequest, mergeable }]), kitConfig());
  }

  it("rebases its branch onto main's head, from the push-to-main check", () => {
    expect(rebasesIn(check(stuckDraft()))).toEqual([expect.objectContaining({ pullRequest: 50, branch: "fabrik/ticket-7", onto: MAIN })]);
  });

  it("is the scheduled tick's to catch too", () => {
    const plan = planFor(TICK, tickSnapshot({ conflicts: { main: MAIN, now: NOW, pullRequests: [{ pullRequest: stuckDraft(), mergeable: false }] } }), kitConfig());

    expect(rebasesIn(plan)).toEqual([expect.objectContaining({ pullRequest: 50, onto: MAIN })]);
  });

  it("doesn't matter who pushed the head: a Retry, a Request-changes run or the Operator", () => {
    const flaw: VerdictRecord = { verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "b".repeat(40) };
    const afterRetry = stuckDraft({ verdicts: [flaw], pushedSinceVerdict: true });
    const afterRequestChanges = stuckDraft({ verdicts: [{ ...PASSED, headSha: "b".repeat(40) }], requestChangesRun: true, pushedSinceVerdict: true });
    // The Operator's push onto a draft they parked after a pass: the pass is on an older head.
    const afterOperator = stuckDraft({ verdicts: [{ ...PASSED, headSha: "b".repeat(40) }] });

    for (const pullRequest of [afterRetry, afterRequestChanges, afterOperator]) expect(rebasesIn(check(pullRequest))).toHaveLength(1);
  });

  it.each<[string, Partial<PullRequestSnapshot>, boolean | null, string]>([
    ["a draft whose head has a Verdict, as one the Operator parked", { verdicts: [PASSED] }, false, `#50 is a draft with a Verdict on ${HEAD.slice(0, 7)}`],
    ["one with a Retry in flight", { verdicts: [{ verdict: "execution-flaw", source: "ci", requestChanges: false, headSha: "b".repeat(40) }] }, false, "Retry 1 of 2 on #50 is still in flight"],
    ["one with a conflict-only run in flight", { conflictAttempts: [OLDER_MAIN], conflictRunInFlight: OLDER_MAIN }, false, "conflict-only run on #50 is still in flight"],
    ["one pushed less than a Review job's timeout ago", { headPushedAt: "2025-12-31T23:45:00Z" }, false, "#50 is a draft pushed less than a Review job's timeout ago"],
    ["one with no known push time", { headPushedAt: null }, false, "when aaaaaaa was pushed isn't known"],
    ["one already tried against this main head", { conflictAttempts: [MAIN] }, false, `#50 was already tried against main at ${MAIN.slice(0, 7)}`],
    ["one whose mergeable state is unknown", {}, null, "left for the scheduled tick"],
    ["one that doesn't conflict", {}, true, "#50 doesn't conflict with main"],
  ])("leaves alone %s, with a reason", (_name, overrides, mergeable, reason) => {
    expect(check(stuckDraft(overrides), mergeable)).toEqual({ kind: "nothing", reason: expect.stringContaining(reason) });
  });

  it("when the rebase is clean, keeps the PR in draft, records the attempt once it lands, and says GitHub started no Review, mentioning nobody", () => {
    const [rebase] = rebasesIn(check(stuckDraft()));

    expect(rebase?.clean).toEqual([]);
    const note = commentOn(rebase?.pushed ?? [], 50);
    expect(note).toMatch(new RegExp(`^<!-- fabrik:conflict-attempt ${MAIN} rebased unreviewed-draft -->`));
    expect(note).toContain("GitHub started no Review");
    expect(note).not.toContain("@");
  });

  it("when the push's lease refuses it, leaves the PR in draft and records no attempt", () => {
    const [rebase] = rebasesIn(check(stuckDraft()));

    expect(rebase?.refused).toEqual([]);
  });

  it("when the rebase conflicts, records the attempt and starts the conflict-only run on the Ticket, mentioning nobody", () => {
    const [rebase] = rebasesIn(check(stuckDraft()));

    const note = commentOn(rebase?.conflicted ?? [], 50);
    expect(note).toMatch(new RegExp(`^<!-- fabrik:conflict-attempt ${MAIN} conflict-run unreviewed-draft -->`));
    expect(note).toContain("GitHub started no Review");
    expect(note).not.toContain("@");
    expect(rebase?.conflicted.at(-1)).toEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
  });

  it("acts first on an undelivered Request changes on it, as for a PR at the Merge gate", () => {
    const plan = check(stuckDraft({ unbuiltChangesRequests: [{ review: 9, reviewer: "operator", reviewerIsBot: false, submittedAt: "2025-12-31T00:00:00Z" }] }));

    expect(rebasesIn(plan)).toEqual([]);
  });
});
