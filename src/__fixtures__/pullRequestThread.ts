// An agent PR's thread on a fake GitHub (#420): each plan's comments are
// posted on it, its push lands or fails, and the next snapshot reads it all
// back through the adapter, so a test replays the Kit's notes end to end.
import { anIssue, snapshotOf } from "./snapshots.ts";
import { conflictAttemptMarker, requestChangesRunStartedMarker, verdictMarker } from "../loop/markers.ts";
import type { Action, LoopEvent, Plan, PullRequestSnapshot, Snapshot } from "../loop/types.ts";
import type { GitHub } from "../github/client.ts";
import { gatherSnapshot } from "../github/snapshot.ts";

export const repo = { owner: "acme", name: "shop" };
export const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
export const A = "a".repeat(40);
export const B = "b".repeat(40);
export const C = "c".repeat(40);
export const D = "d".repeat(40);
export const MAIN = "9".repeat(40);
export const OPERATOR = "jrey";

export type ImplementRunFinished = Extract<LoopEvent, { kind: "implement-run-finished" }>;
export type Fixes = NonNullable<ImplementRunFinished["fixes"]>;

/** PR #50 for Ticket #7, on GitHub: its branch's commits, oldest first, and its thread. */
export class PullRequestOnGitHub {
  commits: string[] = [A];
  draft = true;
  /** Its body, as the Fabrik App opened it and the Kit's plans have edited it since. */
  body = "";
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
      if (action.kind === "edit-issue-body" && action.issue === 50) this.body = action.body;
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
            body: this.body,
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

export function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** The run's push job, its run's commits landing as `tip` on the head the run built on. */
export function finished(tip: string, fixes: Partial<Fixes> = {}, base = A): ImplementRunFinished {
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

export const pushes = (plan: Plan): boolean => plan.kind === "act" && plan.actions.some((action) => action.kind === "push-branch");

/** A PR whose Review on A found an Execution flaw, which started Retry 1. */
export function flawedOnA(): PullRequestOnGitHub {
  const thread = new PullRequestOnGitHub();
  thread.kitSays(verdictMarker({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: A }));
  return thread;
}

/** A PR the Operator took out of draft, then requested changes on with review 101, which started its Request-changes run. */
export function requestedChanges(): PullRequestOnGitHub {
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

/** A PR at the Merge gate whose rebase onto main conflicted, which started a conflict-only run and put it in draft. */
export function conflicted(): PullRequestOnGitHub {
  const thread = new PullRequestOnGitHub();
  thread.kitSays(verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: A }));
  thread.draft = false;
  thread.kitSays(`${conflictAttemptMarker({ main: MAIN, outcome: "conflict-run" })}\nThe rebase conflicted.`);
  thread.draft = true;
  return thread;
}
