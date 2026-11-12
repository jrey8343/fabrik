// The Operator's Request changes on a passed draft waiting on its Digest
// (ADR-0022), as the adapter reads it: the snapshot counts it as one given at
// the Merge gate, by the pass's head against the head GitHub has now.
import { describe, expect, it } from "vitest";
import { kitConfig, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { verdictMarker } from "../loop/markers.ts";
import { planFor } from "../loop/rules.ts";
import type { PullRequestSnapshot } from "../loop/types.ts";
import type { GitHub } from "./client.ts";
import { gatherSnapshot } from "./snapshot.ts";

const repo = { owner: "acme", name: "shop" };
const A = "a".repeat(40);
const B = "b".repeat(40);
const OPERATOR = "jrey";

/** PR #50 for Ticket #7 on GitHub: a draft at `head`, with a pass on A at 09:01 and the Operator's Request changes at 09:05. */
function pullRequestAt(head: string, draftEvents: { __typename: string; createdAt: string }[] = []): Promise<PullRequestSnapshot> {
  const pullRequest = {
    number: 50,
    state: "OPEN",
    isDraft: true,
    headRefName: "fabrik/ticket-7",
    headRefOid: head,
    author: { login: "fabrik-app[bot]", __typename: "Bot" },
    body: "",
    url: "https://github.com/acme/shop/pull/50",
    labels: { nodes: [{ name: "agent:digest" }] },
    comments: {
      pageInfo: { hasPreviousPage: false },
      nodes: [
        {
          body: verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: A }),
          createdAt: "2026-11-01T09:01:00Z",
          author: { __typename: "Bot" },
        },
      ],
    },
    changesRequests: { nodes: [{ databaseId: 900, submittedAt: "2026-11-01T09:05:00Z", author: { login: OPERATOR, __typename: "User" } }] },
    draftEvents: { pageInfo: { hasPreviousPage: false }, nodes: draftEvents },
    createdAt: "2026-11-01T09:00:00Z",
    forcePushes: { nodes: [] },
    commits: { pageInfo: { hasPreviousPage: false }, nodes: [{ commit: { oid: head, committedDate: "2026-11-01T09:00:00Z" } }] },
    closingIssuesReferences: { nodes: [{ number: 7, labels: { nodes: [{ name: "ready-for-agent" }] }, comments: { nodes: [] } }] },
  };
  const github = {
    graphql: async (query: string): Promise<unknown> => {
      if (/\bmergeable\b/.test(query)) return { repository: { defaultBranchRef: null, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
      if (!query.includes("pullRequest(number: $number)")) return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      return { repository: { owner: { login: "acme" }, pullRequest } };
    },
  } as unknown as GitHub;
  return gatherSnapshot(github, repo, { kind: "pull-request-pushed", pullRequest: 50 }, OPERATOR, "fabrik-app[bot]").then(({ pullRequest }) => {
    if (pullRequest === null) throw new Error("expected the PR in the snapshot");
    return pullRequest;
  });
}

const changesRequested = { kind: "pull-request-changes-requested", pullRequest: 50, review: 900, reviewer: OPERATOR, reviewerIsBot: false } as const;

describe("The snapshot of a passed draft waiting on its Digest", () => {
  it("counts the Operator's Request changes on it as unbuilt, with no run started for it, and the Loop acts on it at once", async () => {
    const pullRequest = await pullRequestAt(A);

    expect(pullRequest.unbuiltChangesRequests).toEqual([{ review: 900, reviewer: OPERATOR, reviewerIsBot: false, submittedAt: "2026-11-01T09:05:00Z" }]);
    expect(pullRequest.notedChangesRequests).toEqual([]);
    const plan = planFor(changesRequested, snapshotOfPullRequest(pullRequest, { operator: OPERATOR }), kitConfig());
    expect(plan.kind === "act" ? plan.actions.map(({ kind }) => kind) : plan).toEqual(["comment", "remove-label", "start-agent-run"]);
  });

  it("counts none on a draft whose head has moved on from its pass: such a review does what it does today", async () => {
    const pullRequest = await pullRequestAt(B);

    expect(pullRequest.unbuiltChangesRequests).toEqual([]);
    expect(planFor(changesRequested, snapshotOfPullRequest(pullRequest, { operator: OPERATOR }), kitConfig())).toEqual({
      kind: "nothing",
      reason: "#50 is still a draft in the Loop, not at the Merge gate",
    });
  });

  it("counts none on a draft the Operator put back in draft after the gate opened", async () => {
    const pullRequest = await pullRequestAt(A, [
      { __typename: "ReadyForReviewEvent", createdAt: "2026-11-01T09:02:00Z" },
      { __typename: "ConvertToDraftEvent", createdAt: "2026-11-01T09:03:00Z" },
    ]);

    expect(pullRequest.unbuiltChangesRequests).toEqual([]);
  });
});
