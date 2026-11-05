import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { GitHub } from "./client.ts";
import { countImplementRuns, gatherSnapshot, IMPLEMENT_JOB_NAME } from "./snapshot.ts";

const repo = { owner: "acme", name: "shop" };

/** A read-only Actions API holding these workflow runs, each with its jobs. */
function actionsWith(runs: { id: number; status: string; jobs: { name: string; status: string }[] }[]) {
  return {
    async rest(method: string, path: string): Promise<unknown> {
      expect(method).toBe("GET");
      const listed = /^\/repos\/acme\/shop\/actions\/runs\?status=(\w+)&per_page=100$/.exec(path);
      if (listed !== null) return { workflow_runs: runs.filter((run) => run.status === listed[1]).map(({ id }) => ({ id })) };
      const jobs = /^\/repos\/acme\/shop\/actions\/runs\/(\d+)\/jobs\?filter=latest&per_page=100$/.exec(path);
      if (jobs !== null) return { jobs: runs.find((run) => run.id === Number(jobs[1]))?.jobs ?? [] };
      throw new Error(`Unexpected call: ${path}`);
    },
  };
}

describe("Counting the Implement runs a Dispatch check sees in flight", () => {
  it("counts a running Implement job, called from a Product repo's caller workflow", async () => {
    const actions = actionsWith([{ id: 1, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "in_progress" }] }]);

    expect(await countImplementRuns(actions, repo)).toBe(1);
  });

  it("counts an Implement job still queued or waiting after its claim took agent:implement off the Ticket", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Claim the Ticket", status: "completed" }, { name: "fabrik / Implement", status: "queued" }] },
      { id: 2, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "waiting" }] },
      { id: 3, status: "queued", jobs: [{ name: "fabrik / Implement", status: "queued" }] },
      { id: 4, status: "waiting", jobs: [{ name: "fabrik / Implement", status: "pending" }] },
    ]);

    expect(await countImplementRuns(actions, repo)).toBe(4);
  });

  it("doesn't count a finished Implement job, or any other job", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "completed" }, { name: "fabrik / Review", status: "in_progress" }] },
      { id: 2, status: "in_progress", jobs: [{ name: "fabrik / Implement failed", status: "in_progress" }] },
    ]);

    expect(await countImplementRuns(actions, repo)).toBe(0);
  });
});

describe("The Implement job's name", () => {
  it("is the name loop.yml gives the Implement job, which Dispatch counts by", async () => {
    const workflow = await readFile(new URL("../../.github/workflows/loop.yml", import.meta.url), "utf8");
    const implementJob = /^ {2}implement:\n {4}name: (.+)$/m.exec(workflow)?.[1];

    expect(implementJob).toBe(IMPLEMENT_JOB_NAME);
  });
});

describe("Gathering an issue's blocked-by edges", () => {
  it("holds only the open issues in this repo blocking it, and the open issues in this repo it blocks", async () => {
    const github = {
      async graphql(query: string): Promise<unknown> {
        if (query.includes("issue(number: $number)")) {
          return {
            repository: {
              owner: { login: "acme" },
              issue: {
                number: 6,
                state: "OPEN",
                author: { login: "someone" },
                labels: { nodes: [{ name: "needs-design" }] },
                parent: null,
                comments: { nodes: [] },
                closedByPullRequestsReferences: { nodes: [] },
                blockedBy: {
                  nodes: [
                    { number: 10, state: "OPEN", repository: { nameWithOwner: "acme/shop" } },
                    { number: 9, state: "CLOSED", repository: { nameWithOwner: "acme/shop" } },
                    { number: 11, state: "OPEN", repository: { nameWithOwner: "acme/api" } },
                  ],
                },
                blocking: {
                  nodes: [
                    { number: 7, state: "OPEN", repository: { nameWithOwner: "acme/shop" } },
                    { number: 8, state: "CLOSED", repository: { nameWithOwner: "acme/shop" } },
                    { number: 12, state: "OPEN", repository: { nameWithOwner: "acme/api" } },
                  ],
                },
              },
            },
          };
        }
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
    } as unknown as GitHub;

    const snapshot = await gatherSnapshot(github, repo, { kind: "label-added", issue: 6, label: "needs-design" }, null);

    expect(snapshot.issue).toMatchObject({ openBlockers: [10], openBlocking: [7] });
  });
});

describe("Gathering a Dispatch check's Tickets", () => {
  it("holds each Ticket's open blockers apart from those closed as not planned, and drops those closed any other way", async () => {
    const github = {
      async graphql(query: string): Promise<unknown> {
        if (query.includes("labels: [$ready]")) {
          return {
            repository: {
              owner: { login: "acme" },
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    number: 6,
                    state: "OPEN",
                    labels: { nodes: [{ name: "ready-for-agent" }] },
                    subIssues: { totalCount: 0 },
                    blockedBy: {
                      nodes: [
                        { number: 10, state: "OPEN", stateReason: null },
                        { number: 9, state: "CLOSED", stateReason: "NOT_PLANNED" },
                        { number: 8, state: "CLOSED", stateReason: "COMPLETED" },
                        { number: 7, state: "CLOSED", stateReason: "DUPLICATE" },
                      ],
                    },
                    closedByPullRequestsReferences: { nodes: [] },
                  },
                ],
              },
              pullRequests: { nodes: [] },
            },
          };
        }
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
    } as unknown as GitHub;

    const snapshot = await gatherSnapshot(github, repo, { kind: "dispatch-check" }, null, actionsWith([]) as unknown as GitHub);

    expect(snapshot.dispatch?.tickets).toMatchObject([{ number: 6, openBlockers: [10], notPlannedBlockers: [9] }]);
  });
});

describe("Gathering a Design-session turn's starting reply", () => {
  const issueData = {
    repository: {
      owner: { login: "acme" },
      issue: {
        number: 7,
        state: "OPEN",
        author: { login: "someone" },
        labels: { nodes: [{ name: "needs-design" }] },
        parent: null,
        comments: { nodes: [] },
        closedByPullRequestsReferences: { nodes: [] },
        blockedBy: { nodes: [] },
        blocking: { nodes: [] },
      },
    },
  };

  /** The Fabrik App's API, where GET on the reply answers as `reply` does. */
  function githubWhere(reply: (options: { allowNotFound?: boolean }) => unknown) {
    const reads: string[] = [];
    const github = {
      async graphql(query: string): Promise<unknown> {
        return query.includes("issue(number: $number)") ? issueData : { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
      async rest(method: string, path: string, _body?: unknown, options: { allowNotFound?: boolean } = {}): Promise<unknown> {
        reads.push(`${method} ${path}`);
        return reply(options);
      },
    } as unknown as GitHub;
    return { github, reads };
  }

  const turn = (startedBy?: number) =>
    ({ kind: "agent-run-finished", role: "design", issue: 7, output: "{}", ...(startedBy === undefined ? {} : { startedBy }) }) as const;

  it("finds the reply still there", async () => {
    const { github, reads } = githubWhere(() => ({ id: 7003 }));

    const snapshot = await gatherSnapshot(github, repo, turn(7003), null);

    expect(snapshot.startingComment).toEqual({ id: 7003, exists: true });
    expect(reads).toEqual(["GET /repos/acme/shop/issues/comments/7003"]);
  });

  it("finds the reply gone when GitHub no longer has it", async () => {
    const { github } = githubWhere((options) => {
      expect(options.allowNotFound).toBe(true);
      return null;
    });

    const snapshot = await gatherSnapshot(github, repo, turn(7003), null);

    expect(snapshot.startingComment).toEqual({ id: 7003, exists: false });
  });

  it("fails, rather than calling the reply deleted, when the read itself fails", async () => {
    const { github } = githubWhere(() => {
      throw new Error("GitHub GET /repos/acme/shop/issues/comments/7003 failed: 502");
    });

    await expect(gatherSnapshot(github, repo, turn(7003), null)).rejects.toThrow("502");
  });

  it("reads no reply for a turn adding needs-design started", async () => {
    const { github, reads } = githubWhere(() => ({ id: 1 }));

    const snapshot = await gatherSnapshot(github, repo, turn(), null);

    expect(snapshot.startingComment).toBeNull();
    expect(reads).toEqual([]);
  });
});
