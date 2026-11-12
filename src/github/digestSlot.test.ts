import { describe, expect, it } from "vitest";
import type { GitHub } from "./client.ts";
import { gatherSnapshot } from "./snapshot.ts";

const repo = { owner: "acme", name: "shop" };

/** The read-only API as a Dispatch check reads it: no ready Ticket, no research Decision, and these open pull requests. */
function gitHubWith(pullRequests: { isDraft: boolean; headRefName: string; author: { __typename: string } | null }[]): GitHub {
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

/** How many slots under max_in_flight a Dispatch check counts as taken by open agent drafts. */
async function draftsCounted(pullRequests: Parameters<typeof gitHubWith>[0]): Promise<number | undefined> {
  const snapshot = await gatherSnapshot(gitHubWith(pullRequests), repo, { kind: "dispatch-check" }, null, null, NO_RUNS);
  return snapshot.dispatch?.openAgentDraftPullRequests;
}

// A pass with the Digest on leaves its pull request in draft with `agent:digest` on, until the gate opens (src/loop/digest.ts).
describe("The slot of a passed draft waiting on its Digest", () => {
  const anAgents = { headRefName: "fabrik/ticket-7", author: { __typename: "Bot" } };

  it("an agent pull request holds its max_in_flight slot for as long as it is a draft, whatever its Verdict or its labels, which the count never reads", async () => {
    expect(await draftsCounted([{ ...anAgents, isDraft: true }])).toBe(1);
  });

  it("it stops counting once it is out of draft, as it is when the Merge gate opens", async () => {
    expect(await draftsCounted([{ ...anAgents, isDraft: false }])).toBe(0);
  });
});
