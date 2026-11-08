// A Retry a Verdict announced that never started (#416): the Ticket left the
// Loop during the Review, or what followed the Verdict comment failed, or a
// conflict-only run's note was left in flight by a Request-changes run's push.
// Each left the PR reading a run in flight with nothing running, so every later
// push got no Verdict. These tests replay the PR's thread: each plan's comments
// land at the time it ran, and the next snapshot reads them back as the
// adapter does.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, kitConfig, snapshotOf, snapshotOfPullRequest, tickSnapshot } from "../__fixtures__/snapshots.ts";
import { implementJobTimeoutMinutes } from "../evidence/capture.ts";
import {
  conflictRunInFlightIn,
  leftDraftSinceVerdictIn,
  type PullRequestHistoryItem,
  pushedSinceVerdictIn,
  requestChangesRunIn,
  requestChangesSinceRunIn,
  retryEndedSinceVerdictIn,
  standingIn,
  verdictPostedAtIn,
  verdictsIn,
} from "../github/threads.ts";
import { conflictAttemptMarker, REQUEST_CHANGES_RUN_MARKER, verdictMarker } from "./markers.ts";
import { runInFlight } from "./retry.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, PullRequestSnapshot, Snapshot } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const MAIN = "9".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);

/** Minutes after 05:00, as an ISO 8601 time. */
function at(minutes: number): string {
  return new Date(Date.UTC(2026, 10, 7, 5, minutes)).toISOString();
}

/** How long an Implement job may run, which a Retry is given before the check counts it as stalled. */
const RUN_MINUTES = implementJobTimeoutMinutes(kitConfig().roles.implement.timeoutMinutes);

/** Agent draft PR #50 for Ticket #7, at A, with its Review under way. */
class Thread {
  readonly history: PullRequestHistoryItem[] = [];
  headSha = A;
  draft = true;
  ticketLabels: string[] = ["enhancement", "ready-for-agent"];
  now = at(0);
  implementJobUnderWay: boolean | null = false;
  /** When set, this action fails as the adapter applies it, and every action after it is never applied. */
  failsAt: Action["kind"] | null = null;

  private comments(): string[] {
    return this.history.flatMap((item) => (item.kind === "bot-comment" ? [item.body] : []));
  }

  pullRequest(): PullRequestSnapshot {
    const comments = this.comments();
    return aPullRequest({
      headSha: this.headSha,
      draft: this.draft,
      ticketLabels: this.ticketLabels,
      verdicts: verdictsIn(comments),
      verdictPostedAt: verdictPostedAtIn(this.history),
      requestChangesRun: requestChangesRunIn(comments),
      conflictRunInFlight: conflictRunInFlightIn(comments),
      pushedSinceVerdict: pushedSinceVerdictIn(comments),
      retryEndedSinceVerdict: retryEndedSinceVerdictIn(comments),
      ...requestChangesSinceRunIn(this.history, standingIn(this.history), "operator"),
      leftDraftSinceVerdict: leftDraftSinceVerdictIn(this.history),
    });
  }

  land(actions: readonly Action[]): void {
    for (const action of actions) {
      if (action.kind === this.failsAt) return;
      if (action.kind === "comment" && action.issue === 50) this.history.push({ kind: "bot-comment", at: this.now, body: action.body });
    }
  }

  plan(event: LoopEvent, snapshot: Snapshot): Plan {
    const plan = planFor(event, snapshot, kitConfig());
    if (plan.kind === "act") this.land(plan.actions);
    return plan;
  }

  /** The Kit's own comment on the PR at `minutes`, as a plan elsewhere posted it. */
  posted(body: string, minutes: number): void {
    this.history.push({ kind: "bot-comment", at: at(minutes), body });
  }

  /** The Reviewer's Execution flaw on the PR's head, at `minutes`. */
  flaw(minutes: number): Plan {
    this.now = at(minutes);
    return this.plan(
      {
        kind: "review-run-finished",
        pullRequest: 50,
        headSha: this.headSha,
        runUrl: RUN,
        output: "verdict: execution-flaw\n\nThe empty-cart case throws.",
        repoUrl: "https://github.com/acme/shop",
      },
      snapshotOfPullRequest(this.pullRequest()),
    );
  }

  /** Someone pushes `to` to the PR at `minutes`, which starts a Review unless a run is in flight. */
  pushed(to: string, minutes: number): Plan {
    this.now = at(minutes);
    this.headSha = to;
    return this.plan({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(this.pullRequest()));
  }

  /** The scheduled tick at `minutes`. */
  tick(minutes: number): Plan {
    this.now = at(minutes);
    const conflicts = { main: MAIN, now: this.now, implementJobUnderWay: this.implementJobUnderWay, pullRequests: [{ pullRequest: this.pullRequest(), mergeable: true }] };
    return this.plan({ kind: "scheduled-tick", now: this.now }, tickSnapshot({ conflicts }));
  }

  /** agent:implement added to the Ticket. */
  implement(): Plan {
    const ticket = anIssue({ number: 7, labels: this.ticketLabels, openPullRequests: [50] });
    return this.plan({ kind: "label-added", issue: 7, label: "agent:implement" }, snapshotOf(ticket, { pullRequest: this.pullRequest() }));
  }
}

function actionsOf(plan: Plan): readonly Action[] {
  return plan.kind === "act" ? plan.actions : [];
}

function commentsOn(plan: Plan, issue: number): string[] {
  return actionsOf(plan).flatMap((action) => (action.kind === "comment" && action.issue === issue ? [action.body] : []));
}

const addsImplement = (plan: Plan): boolean => actionsOf(plan).some((action) => action.kind === "add-labels" && action.issue === 7);
const startsReview = (plan: Plan): boolean => actionsOf(plan).some((action) => action.kind === "start-agent-run" && action.role === "review");

describe("An Execution flaw on a Ticket that left ready-for-agent during its Review", () => {
  it("says the Ticket has left the Loop and starts no Retry", () => {
    const thread = new Thread();
    thread.ticketLabels = ["enhancement", "ready-for-human"];

    const plan = thread.flaw(10);

    expect(addsImplement(plan)).toBe(false);
    const [verdict] = commentsOn(plan, 50);
    expect(verdict).not.toContain("starts now");
    expect(verdict).toContain("#7 is no longer `ready-for-agent`, so it has left the Loop and no Retry starts");
    expect(runInFlight(thread.pullRequest())).toBeNull();
  });

  it("leaves a later push to the PR its Review, and uses no retry", () => {
    const thread = new Thread();
    thread.ticketLabels = ["enhancement", "ready-for-human"];
    thread.flaw(10);
    thread.ticketLabels = ["enhancement", "ready-for-agent"];

    expect(startsReview(thread.pushed(B, 30))).toBe(true);
    expect(commentsOn(thread.flaw(40), 50)[0]).toContain("Retry 1 of 2 starts now");
  });
});

describe("A Retry announced by its Verdict that never started", () => {
  /** A Verdict at 05:10 whose agent:implement never reached the Ticket: the Verdict comment landed, the label add failed. */
  function stalled(): Thread {
    const thread = new Thread();
    thread.failsAt = "add-labels";
    expect(commentsOn(thread.flaw(10), 50)[0]).toContain("Retry 1 of 2 starts now");
    thread.failsAt = null;
    return thread;
  }

  it("leaves a later push without a Review while it reads as in flight, as the bug did", () => {
    const thread = stalled();

    expect(startsReview(thread.pushed(B, 20))).toBe(false);
  });

  it("is restarted by the tick once the Implement job's timeout has passed with no Implement job under way: one agent:implement on the Ticket, which resumes the Retry", () => {
    const thread = stalled();

    const plan = thread.tick(10 + RUN_MINUTES + 1);

    expect(actionsOf(plan)).toContainEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
    expect(commentsOn(plan, 50)).toEqual([]);
    expect(actionsOf(thread.implement())).toContainEqual(expect.objectContaining({ kind: "start-agent-run", role: "implement", retry: 1, retryFlaw: A }));
  });

  it("isn't restarted within the Implement job's timeout of its Verdict", () => {
    expect(addsImplement(stalled().tick(10 + RUN_MINUTES - 1))).toBe(false);
  });

  it.each([true, null])("isn't restarted while an Implement job may be under way (read as %s)", (underWay) => {
    const thread = stalled();
    thread.implementJobUnderWay = underWay;

    expect(addsImplement(thread.tick(10 + RUN_MINUTES + 1))).toBe(false);
  });

  it("isn't restarted once its push has landed", () => {
    const thread = stalled();
    thread.posted("<!-- fabrik:retry-push -->\nThe Implementer pushed a fix.", 30);

    expect(addsImplement(thread.tick(10 + RUN_MINUTES + 1))).toBe(false);
  });

  it("on a Ticket that has since left ready-for-agent: the tick says so once, starts nothing, and a later push gets its Review", () => {
    const thread = stalled();
    thread.ticketLabels = ["enhancement", "ready-for-human"];

    const plan = thread.tick(10 + RUN_MINUTES + 1);

    expect(addsImplement(plan)).toBe(false);
    const [note, ...more] = commentsOn(plan, 50);
    expect(more).toEqual([]);
    expect(note).toContain("@operator Retry 1 of 2 on #50 never started");
    expect(note).toContain("#7 is no longer `ready-for-agent`, so it has left the Loop and no Retry starts");
    expect(commentsOn(thread.tick(10 + RUN_MINUTES + 61), 50)).toEqual([]);
    expect(startsReview(thread.pushed(B, 10 + RUN_MINUTES + 70))).toBe(true);
  });
});

describe("A conflict-only run's note that a Request-changes run's push got ahead of", () => {
  /** The Kit started a conflict-only run at 05:00, but agent:implement resumed the Request-changes run owed first, which pushed B. */
  function orphaned(): Thread {
    const thread = new Thread();
    thread.posted(`${conflictAttemptMarker({ main: MAIN, outcome: "conflict-run" })}\nA conflict-only Implementer run starts now.`, 0);
    thread.posted(`${REQUEST_CHANGES_RUN_MARKER}\nThe Request-changes run pushed.`, 5);
    thread.headSha = B;
    return thread;
  }

  it("is no longer in flight once that push has landed", () => {
    expect(runInFlight(orphaned().pullRequest())).toBeNull();
  });

  it("is no longer in flight once a Verdict has landed, so the flaw's own Retry is what's in flight", () => {
    const thread = new Thread();
    thread.posted(`${conflictAttemptMarker({ main: MAIN, outcome: "conflict-run" })}\nA conflict-only Implementer run starts now.`, 0);
    thread.posted(`${verdictMarker({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: A })}\n## Verdict: Execution flaw`, 10);

    expect(runInFlight(thread.pullRequest())).toMatchObject({ kind: "retry", retry: 1 });
  });

  it("leaves the next push its Review", () => {
    expect(startsReview(orphaned().pushed("c".repeat(40), 20))).toBe(true);
  });
});
