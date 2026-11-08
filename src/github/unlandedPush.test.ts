// A run's push note is posted before its push (#420), so the Review the push
// starts sees the run's outcome. The note names the head it announces, and
// the snapshot reads a note whose head never reached the branch as no push at
// all: the run stays in flight, a re-run of the push job lands its work, and
// a Review of a push of the Operator's meanwhile is never taken for the run's.
// These tests replay a PR's thread: each plan's note is posted on the fake
// GitHub, the push lands or fails, and the next snapshot reads it all back.
import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { conflictAttemptMarker, requestChangesRunStartedMarker, verdictMarker } from "../loop/markers.ts";
import { runInFlight } from "../loop/retry.ts";
import { planFor } from "../loop/rules.ts";
import type { Action, LoopEvent, Plan, PullRequestSnapshot, Snapshot } from "../loop/types.ts";
import type { GitHub } from "./client.ts";
import { gatherSnapshot } from "./snapshot.ts";

const repo = { owner: "acme", name: "shop" };
const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const MAIN = "9".repeat(40);
const OPERATOR = "jrey";

type ImplementRunFinished = Extract<LoopEvent, { kind: "implement-run-finished" }>;
type Fixes = NonNullable<ImplementRunFinished["fixes"]>;

/** PR #50 for Ticket #7, on GitHub: its branch's commits, oldest first, and its thread. */
class PullRequestOnGitHub {
  commits: string[] = [A];
  draft = true;
  readonly comments: { body: string; createdAt: string; author: { __typename: string } }[] = [];
  readonly changesRequests: { databaseId: number; submittedAt: string; author: { login: string; __typename: string } }[] = [];
  readonly draftEvents: { __typename: string; createdAt: string }[] = [];
  private minute = 0;

  /** The next moment in the thread. */
  at(): string {
    this.minute += 1;
    return new Date(Date.UTC(2026, 10, 1, 9, this.minute)).toISOString();
  }

  kitSays(body: string): void {
    this.comments.push({ body, createdAt: this.at(), author: { __typename: "Bot" } });
  }

  /** Posts the plan's comments, and pushes its branch only if `pushLands`: a lease that refuses it, or a dropped connection, leaves the branch as it was. */
  apply(plan: Plan, { pushLands, tip }: { pushLands: boolean; tip: string }): void {
    for (const action of actionsOf(plan)) {
      if (action.kind === "comment" && action.issue === 50) this.kitSays(action.body);
      if (action.kind === "push-branch" && pushLands) this.commits = [...this.commits, tip];
    }
  }

  readonly github = {
    graphql: async (query: string): Promise<unknown> => {
      if (/\bmergeable\b/.test(query)) return { repository: { defaultBranchRef: null, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
      if (!query.includes("pullRequest(number: $number)")) return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      return {
        repository: {
          owner: { login: "acme" },
          pullRequest: {
            number: 50,
            state: "OPEN",
            isDraft: this.draft,
            headRefName: "fabrik/ticket-7",
            headRefOid: this.commits.at(-1),
            author: { login: "fabrik-app[bot]", __typename: "Bot" },
            body: "",
            url: "https://github.com/acme/shop/pull/50",
            labels: { nodes: [] },
            comments: { pageInfo: { hasPreviousPage: false }, nodes: this.comments },
            changesRequests: { nodes: this.changesRequests },
            draftEvents: { pageInfo: { hasPreviousPage: false }, nodes: this.draftEvents },
            createdAt: "2026-11-01T09:00:00Z",
            forcePushes: { nodes: [] },
            commits: {
              pageInfo: { hasPreviousPage: false },
              nodes: this.commits.map((oid) => ({ commit: { oid, committedDate: "2026-11-01T09:00:00Z" } })),
            },
            closingIssuesReferences: { nodes: [{ number: 7, labels: { nodes: [{ name: "ready-for-agent" }] }, comments: { nodes: [] } }] },
          },
        },
      };
    },
  } as unknown as GitHub;

  async pullRequest(): Promise<PullRequestSnapshot> {
    const { pullRequest } = await gatherSnapshot(this.github, repo, { kind: "pull-request-pushed", pullRequest: 50 }, OPERATOR, "fabrik-app[bot]");
    if (pullRequest === null) throw new Error("expected the PR in the snapshot");
    return pullRequest;
  }

  /** The push job's snapshot: the Ticket, and the PR as the adapter reads it. */
  async pushJobSnapshot(): Promise<Snapshot> {
    return snapshotOf(anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }), {
      pullRequest: await this.pullRequest(),
      operator: OPERATOR,
    });
  }
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** The run's push job, its run's commits landing as `tip` on the head the run built on. */
function finished(tip: string, fixes: Partial<Fixes> = {}, base = A): ImplementRunFinished {
  return {
    kind: "implement-run-finished",
    runUrl: "https://github.com/acme/shop/actions/runs/1/attempts/1",
    issue: 7,
    output: JSON.stringify({
      title: "Handle the empty cart",
      summary: "Shows the empty state for an empty cart.",
      fix: "Guards the empty-cart case.",
      reviewMiss: false,
      amendsTicket: false,
    }),
    branch: "fabrik/ticket-7",
    base: "fabrik/ticket-7",
    changes: { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }], pushedHead: tip },
    fixes: { pullRequest: 50, headSha: base, runUrl: RUN, ...fixes },
  };
}

const pushes = (plan: Plan): boolean => plan.kind === "act" && plan.actions.some((action) => action.kind === "push-branch");

/** A PR whose Review on A found an Execution flaw, which started Retry 1. */
function flawedOnA(): PullRequestOnGitHub {
  const thread = new PullRequestOnGitHub();
  thread.kitSays(verdictMarker({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: A }));
  return thread;
}

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
  /** A PR the Operator took out of draft, then requested changes on with review 101, which started its Request-changes run. */
  function requestedChanges(): PullRequestOnGitHub {
    const thread = new PullRequestOnGitHub();
    thread.kitSays(verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: A }));
    thread.draftEvents.push({ __typename: "ReadyForReviewEvent", createdAt: thread.at() });
    thread.draft = false;
    thread.changesRequests.push({ databaseId: 101, submittedAt: thread.at(), author: { login: OPERATOR, __typename: "User" } });
    thread.kitSays(`${requestChangesRunStartedMarker([101])}\nThe Kit is starting the Request-changes run.`);
    thread.draftEvents.push({ __typename: "ConvertToDraftEvent", createdAt: thread.at() });
    thread.draft = true;
    return thread;
  }

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
  /** A PR at the Merge gate whose rebase onto main conflicted, which started a conflict-only run and put it in draft. */
  function conflicted(): PullRequestOnGitHub {
    const thread = new PullRequestOnGitHub();
    thread.kitSays(verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: A }));
    thread.draft = false;
    thread.kitSays(`${conflictAttemptMarker({ main: MAIN, outcome: "conflict-run" })}\nThe rebase conflicted.`);
    thread.draft = true;
    return thread;
  }

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
