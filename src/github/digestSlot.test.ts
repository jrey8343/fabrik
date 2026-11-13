import { describe, expect, it } from "vitest";
import type { GitHub } from "./client.ts";
import { gatherSnapshot } from "./snapshot.ts";

const repo = { owner: "acme", name: "shop" };

/** The read-only API as a Dispatch check reads it: no ready Ticket, no research Decision, and these open pull requests. */
function gitHubWith(pullRequests: { number: number; isDraft: boolean; headRefName: string; author: { __typename: string } | null }[]): GitHub {
  const none = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  return {
    async graphql(query: string): Promise<unknown> {
      if (query.includes("labels: [$ready]")) return { repository: { owner: { login: "acme" }, issues: none, pullRequests: { nodes: pullRequests } } };
      return { repository: { owner: { login: "acme" }, issues: none } };
    },
  } as unknown as GitHub;
}

/** The Actions API with no run under way. */
const NO_RUNS = {
  async rest(): Promise<unknown> {
    return { workflow_runs: [] };
  },
} as unknown as GitHub;

/** The open agent PRs a Dispatch check reads: drafts, holding max_in_flight slots, and those out of draft, at the Merge gate. */
async function agentPullRequestsRead(pullRequests: Parameters<typeof gitHubWith>[0]) {
  const snapshot = await gatherSnapshot(gitHubWith(pullRequests), repo, { kind: "dispatch-check" }, null, null, NO_RUNS);
  return { drafts: snapshot.dispatch?.openAgentDraftPullRequests, atGate: snapshot.dispatch?.openAgentPullRequestsAtMergeGate };
}

// A pass with the Digest on leaves its pull request in draft with `agent:digest` on, until the gate opens (src/loop/digest.ts).
describe("The slot of a passed draft waiting on its Digest", () => {
  const anAgents = { number: 50, headRefName: "fabrik/ticket-7", author: { __typename: "Bot" } };

  it("an agent pull request holds its max_in_flight slot for as long as it is a draft, whatever its Verdict or its labels, which the count never reads", async () => {
    expect(await agentPullRequestsRead([{ ...anAgents, isDraft: true }])).toEqual({ drafts: [50], atGate: [] });
  });

  it("it moves to the Merge gate once it is out of draft, as it is when the gate opens, holding a caps.merge_gate slot instead (#459)", async () => {
    expect(await agentPullRequestsRead([{ ...anAgents, isDraft: false }])).toEqual({ drafts: [], atGate: [50] });
  });

  it("counts only the agent's pull requests at the gate, lowest number first, never the Operator's own", async () => {
    const operators = { number: 30, isDraft: false, headRefName: "fix-typo", author: { __typename: "User" } };
    const read = await agentPullRequestsRead([{ ...anAgents, number: 52, isDraft: false }, operators, { ...anAgents, number: 51, isDraft: false }]);

    expect(read).toEqual({ drafts: [], atGate: [51, 52] });
  });
});
