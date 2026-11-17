// A Review whose checks wait stopped because the PR conflicts with main
// (#704, ADR-0028): GitHub never starts a `pull_request` check on a PR it
// can't merge, so the Kit brings the draft up to date at once, as for a draft
// whose push GitHub never reviewed (ADR-0016), with no grace period, since the
// Review it would have waited on has ended. It hands nothing back unless the
// Operator has to act.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { handBackMarkIn } from "./markers.ts";
import { planFor } from "./rules.ts";
import type { Action, FailureReport, LoopEvent, MergeableSnapshot, Plan, PullRequestSnapshot, VerdictRecord } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const MAIN = "abc1234".padEnd(40, "9");
const HEAD = "a".repeat(40);

/** Review's wait on #50's head stopped a minute in: it conflicts with main, and `gate` and `e2e` never started. */
const STOPPED: FailureReport = { failure: "merge-conflict", detail: "", checks: ["gate", "e2e"], headSha: HEAD, waitedMinutes: 1, mergeable: false };

function failedReview(report: FailureReport = STOPPED): LoopEvent {
  return { kind: "agent-run-failed", role: "review", issue: 7, runUrl: RUN, jobResult: "failure", secretsStep: "success", report };
}

/** Agent draft PR #50 for Ticket #7, pushed a minute ago (well inside the unreviewed-draft grace period), no Verdict on its head. */
function draft(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return aPullRequest({ number: 50, ticket: 7, draft: true, verdicts: [], headSha: HEAD, headPushedAt: new Date().toISOString(), ...overrides });
}

function plan(pullRequest: PullRequestSnapshot = draft(), mergeable: MergeableSnapshot = { main: MAIN, mergeable: false }, report?: FailureReport): Plan {
  return planFor(failedReview(report), snapshotOf(anIssue({ number: 7, openPullRequests: [50] }), { pullRequest, mergeable }), kitConfig());
}

function actionsOf(planned: Plan): readonly Action[] {
  if (planned.kind !== "act") throw new Error(`expected a plan that acts, got ${planned.kind}`);
  return planned.actions;
}

function rebaseIn(planned: Plan): Extract<Action, { kind: "rebase-onto-main" }> {
  const rebase = actionsOf(planned).find((action) => action.kind === "rebase-onto-main");
  if (rebase?.kind !== "rebase-onto-main") throw new Error("No rebase planned");
  return rebase;
}

function commentOn(actions: readonly Action[]): string {
  const comments = actions.filter((action) => action.kind === "comment");
  expect(comments).toHaveLength(1);
  const [comment] = comments;
  if (comment?.kind !== "comment") throw new Error("No comment");
  expect(comment.issue).toBe(50);
  return comment.body;
}

const OPENING = "Review couldn't start on #50: it conflicts with `main` at abc1234, and GitHub doesn't run `gate` or `e2e` on a PR it can't merge. Your workflows are fine.";

describe("A Review that stopped because its PR conflicts with main (#704)", () => {
  it("brings the draft up to date with main at once, as for a draft GitHub never reviewed, with no grace period, no hand-back and no mention", () => {
    const planned = plan();

    expect(actionsOf(planned)).toEqual([
      { kind: "remove-label", issue: 50, label: "agent:review" },
      expect.objectContaining({ kind: "rebase-onto-main", pullRequest: 50, branch: "fabrik/ticket-7", onto: MAIN, clean: [] }),
    ]);
    const rebase = rebaseIn(planned);
    expect(rebase.conflicted.at(-1)).toEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
    for (const body of [...rebase.pushed, ...rebase.conflicted, ...rebase.refused].flatMap((action) => (action.kind === "comment" ? [action.body] : []))) {
      expect(body).not.toContain("@");
      expect(handBackMarkIn(body)).toBeNull();
      expect(body).not.toContain("Infrastructure failure");
    }
  });

  it("says plainly, once the clean rebase is pushed, that the Operator needn't act, recording the attempt as an unreviewed draft's", () => {
    expect(commentOn(rebaseIn(plan()).pushed)).toBe(
      [
        `<!-- fabrik:conflict-attempt ${MAIN} rebased unreviewed-draft -->`,
        OPENING,
        "",
        "**You don't need to do anything.** The Kit rebased `fabrik/ticket-7` onto `main` cleanly and pushed it, so no agent ran and no retry was used. Review starts on the rebased head.",
      ].join("\n"),
    );
  });

  it("says plainly, once a rebase conflicts, that a conflict-only run has started and the Operator needn't act", () => {
    expect(commentOn(rebaseIn(plan()).conflicted)).toBe(
      [
        `<!-- fabrik:conflict-attempt ${MAIN} conflict-run unreviewed-draft -->`,
        OPENING,
        "",
        "**You don't need to do anything.** Rebasing `fabrik/ticket-7` onto `main` conflicts too, so a conflict-only Implementer run starts now, on the Step-up model: it rebases the branch onto `main`, resolves the conflicts and changes nothing else. It uses no retry, and the Verdict on its push counts as one on the unreviewed push would have. Review starts on the run's push.",
      ].join("\n"),
    );
  });

  it("says the rebase didn't land when the branch moved before its push, recording no attempt", () => {
    const body = commentOn(rebaseIn(plan()).refused);

    expect(body).not.toContain("fabrik:conflict-attempt");
    expect(body).toBe(
      [
        OPENING,
        "",
        "**You don't need to do anything.** The Kit rebased `fabrik/ticket-7` onto `main`, but the branch moved before the rebase could be pushed, so nothing landed. Review starts on that push if it merges cleanly with `main`; if it still conflicts, a later conflict check brings it up to date.",
      ].join("\n"),
    );
  });

  describe("when the Kit can't bring it up to date from here", () => {
    const SOONER = "To move sooner, merge `main` into `fabrik/ticket-7` yourself and push.";

    it("already tried against this main head: starts no rebase, says main moving moves it on and how to move sooner, and mentions nobody", () => {
      const actions = actionsOf(plan(draft({ conflictAttempts: [MAIN] })));

      expect(actions.some((action) => action.kind === "rebase-onto-main")).toBe(false);
      expect(commentOn(actions)).toBe(
        [OPENING, "", `**You don't need to do anything.** The Kit already tried to bring #50 up to date with \`main\` at abc1234, so it tries again once \`main\` moves. ${SOONER}`].join("\n"),
      );
    });

    it("a run in flight: starts no rebase, says its push is rebased when it lands, and mentions nobody", () => {
      const flaw: VerdictRecord = { verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "b".repeat(40) };
      const actions = actionsOf(plan(draft({ verdicts: [flaw] })));

      expect(actions.some((action) => action.kind === "rebase-onto-main")).toBe(false);
      expect(commentOn(actions)).toBe(
        [
          OPENING,
          "",
          `**You don't need to do anything.** Retry 1 of 2 on #50 is still in flight, so the Kit isn't bringing the branch up to date now: its push is rebased when it lands. ${SOONER}`,
        ].join("\n"),
      );
    });

    it("an undelivered Request changes: starts no rebase, says its run brings main in, and mentions nobody", () => {
      const actions = actionsOf(plan(draft({ unbuiltChangesRequests: [{ review: 9, reviewer: "operator", reviewerIsBot: false, submittedAt: "2025-12-31T00:00:00Z" }] })));

      expect(actions.some((action) => action.kind === "rebase-onto-main")).toBe(false);
      expect(commentOn(actions)).toBe(
        [
          OPENING,
          "",
          `**You don't need to do anything.** #50 has a Request changes from you that no run has started for yet, and the Request-changes run brings \`main\` in when it starts. ${SOONER}`,
        ].join("\n"),
      );
    });

    it("GitHub hadn't worked out whether it still conflicts: starts no rebase, leaves it to a later conflict check, and mentions nobody", () => {
      const body = commentOn(actionsOf(plan(draft(), { main: MAIN, mergeable: null })));

      expect(body).toContain("**You don't need to do anything yet.** GitHub hadn't worked out whether #50 still conflicts with `main`");
      expect(body).toContain(SOONER);
      expect(body).not.toContain("@");
      expect(handBackMarkIn(body)).toBeNull();
    });
  });

  it("no longer conflicting by the Loop's own read: says it conflicted while Review waited and that only a push starts the checks", () => {
    const actions = actionsOf(plan(draft(), { main: MAIN, mergeable: true }));

    expect(actions.some((action) => action.kind === "rebase-onto-main")).toBe(false);
    expect(commentOn(actions)).toBe(
      [
        "@operator Review couldn't start on #50: it conflicted with `main` while Review waited, and GitHub doesn't run `gate` or `e2e` on a PR it can't merge. Your workflows are fine.",
        "",
        "**This needs you.** #50 merges cleanly with `main` at abc1234 now, but GitHub won't start the checks on `aaaaaaa` until something is pushed to `fabrik/ticket-7`. Merge `main` into `fabrik/ticket-7` and push, and Review starts on the push.",
        '<!-- fabrik:hand-back {"kind":"conflicted-review","role":"review"} -->',
      ].join("\n"),
    );
  });

  it("names the conflict, not a check, when the report lost the checks' names", () => {
    const body = commentOn(rebaseIn(plan(draft(), { main: MAIN, mergeable: false }, { ...STOPPED, checks: [] })).pushed);

    expect(body).toContain("and GitHub doesn't run its Required checks on a PR it can't merge.");
  });

  it("leaves a PR that merges cleanly to a run in flight, whose push starts the checks", () => {
    const flaw: VerdictRecord = { verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "b".repeat(40) };
    const body = commentOn(actionsOf(plan(draft({ verdicts: [flaw] }), { main: MAIN, mergeable: true })));

    expect(body).toContain("**You don't need to do anything.** Retry 1 of 2 on #50 is still in flight");
    expect(body).not.toContain("@");
  });

  it("plans nothing, and never an Infrastructure-failure notice, for a PR that's no longer an open agent draft", () => {
    expect(plan(draft({ draft: false }))).toEqual({ kind: "nothing", reason: expect.stringContaining("no open agent draft PR to bring up to date") });
  });

  it("plans the very rebase the conflict check plans for a draft past its grace period, but for what its notes say", () => {
    const pullRequest = draft({ headPushedAt: "2025-12-31T22:50:00Z" });
    const tick = planFor(
      { kind: "main-pushed", head: MAIN },
      { ...snapshotOf(anIssue({ number: 7 })), conflicts: { main: MAIN, now: "2026-01-01T00:00:00Z", implementJobUnderWay: null, pullRequests: [{ pullRequest, mergeable: false }] } },
      kitConfig(),
    );
    const withoutWords = (action: Extract<Action, { kind: "rebase-onto-main" }>) => {
      const markersOnly = (actions: readonly Action[]) =>
        actions.map((each) => (each.kind === "comment" ? { ...each, body: each.body.split("\n")[0]?.startsWith("<!-- fabrik:conflict-attempt") ? each.body.split("\n")[0] : "" } : each));
      return { ...action, pushed: markersOnly(action.pushed), refused: [], conflicted: markersOnly(action.conflicted) };
    };

    expect(withoutWords(rebaseIn(plan(pullRequest)))).toEqual(withoutWords(rebaseIn(tick)));
  });
});
