import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { GitHub } from "./client.ts";
import { anIssue, aPullRequest, designQueueSnapshotOf, HEAD_SHA, kitConfig, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { holdsSlot } from "../loop/designQueue.ts";
import { DESIGN_TURN_FAILED_MARKER } from "../loop/markers.ts";
import { planFor } from "../loop/rules.ts";
import type { DesignQueueSnapshot, LoopEvent, Plan } from "../loop/types.ts";
import { countImplementRuns, DESIGN_JOB_NAME, designTurnsInProgress, gatherSnapshot, IMPLEMENT_JOB_NAME } from "./snapshot.ts";

const repo = { owner: "acme", name: "shop" };

/** A read-only Actions API holding these workflow runs, each with its jobs. */
function actionsWith(runs: { id: number; status: string; jobs: { name: string; status: string; conclusion?: string }[] }[]) {
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

describe("Reading the Design-session turns a Design queue check sees in progress", () => {
  it("reads the issue of each Design-session turn running, queued or waiting, from its job's name", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Design-session turn #7", status: "in_progress" }] },
      { id: 2, status: "queued", jobs: [{ name: "fabrik / Design-session turn #9", status: "queued" }] },
      { id: 3, status: "waiting", jobs: [{ name: "Design-session turn #4", status: "waiting" }] },
    ]);

    expect(await designTurnsInProgress(actions, repo)).toEqual([4, 7, 9]);
  });

  it("reads a Design-session turn whose job is done while its run is still posting the round", async () => {
    const actions = actionsWith([
      {
        id: 1,
        status: "in_progress",
        jobs: [
          { name: "fabrik / Design-session turn #7", status: "completed", conclusion: "success" },
          { name: "fabrik / Push", status: "in_progress" },
        ],
      },
    ]);

    expect(await designTurnsInProgress(actions, repo)).toEqual([7]);
  });

  it("doesn't read a Design job skipped because its run went another way, or any other job", async () => {
    const actions = actionsWith([
      {
        id: 1,
        status: "in_progress",
        jobs: [
          { name: "fabrik / Design-session turn #7", status: "completed", conclusion: "skipped" },
          { name: "fabrik / Implement", status: "in_progress" },
          { name: "fabrik / Design-session turn #", status: "in_progress" },
        ],
      },
    ]);

    expect(await designTurnsInProgress(actions, repo)).toEqual([]);
  });
});

describe("The Design-session turn job's name", () => {
  it("is the name loop.yml gives the Design job, followed by its issue, which a Design queue check reads", async () => {
    const workflow = await readFile(new URL("../../.github/workflows/loop.yml", import.meta.url), "utf8");
    const designJob = /^ {2}design:\n {4}name: (.+)$/m.exec(workflow)?.[1];

    // Quoted, since an unquoted ` #` starts a YAML comment.
    expect(designJob).toBe(`"${DESIGN_JOB_NAME} #\${{ github.event.issue.number }}"`);
  });
});

describe("Gathering a Design queue check's needs-design issues", () => {
  const kit = (body: string, createdAt = "2026-11-02T09:00:00Z") => ({ body, createdAt, author: { __typename: "Bot" } });
  const person = (body: string, createdAt = "2026-11-02T09:00:00Z") => ({ body, createdAt, author: { __typename: "User" } });
  const labelled = (name: string, createdAt: string) => ({ __typename: "LabeledEvent", createdAt, label: { name } });
  const unlabelled = (name: string, createdAt: string, actor = "Bot") => ({
    __typename: "UnlabeledEvent",
    createdAt,
    label: { name },
    actor: { __typename: actor },
  });

  function issue(number: number, overrides: Record<string, unknown> = {}) {
    return {
      number,
      createdAt: "2026-10-01T09:00:00Z",
      labels: { nodes: [{ name: "needs-design" }] },
      comments: { nodes: [] },
      timelineItems: { nodes: [labelled("needs-design", "2026-11-01T09:00:00Z")] },
      ...overrides,
    };
  }

  async function gathered(
    nodes: unknown[],
    runs: Parameters<typeof actionsWith>[0] | null = [],
  ): Promise<DesignQueueSnapshot> {
    const github = {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        if (query.includes("labels: [$needsDesign]")) {
          expect(variables["needsDesign"]).toBe("needs-design");
          return {
            repository: { owner: { login: "acme" }, issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
          };
        }
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
    } as unknown as GitHub;
    const actions = runs === null ? null : (actionsWith(runs) as unknown as GitHub);
    const snapshot = await gatherSnapshot(github, repo, { kind: "design-queue-check" }, null, actions);
    if (snapshot.designQueue === null) throw new Error("no Design queue slice");
    return snapshot.designQueue;
  }

  function holding(queue: DesignQueueSnapshot): Record<number, boolean> {
    return Object.fromEntries(queue.issues.map((i) => [i.number, holdsSlot(i, queue)]));
  }

  it("reads an issue with a posted round, a turn in progress or a failed turn as holding a slot, and one with none as waiting", async () => {
    const queue = await gathered(
      [
        issue(3, { comments: { nodes: [kit("<!-- fabrik:design-round 1 -->\n@jrey **Design session, round 1.**"), person("yes")] } }),
        issue(4),
        issue(5, { comments: { nodes: [kit("<!-- fabrik:design-turn-failed -->\n@jrey The Design-session turn run on #5 failed.")] } }),
        issue(6, { comments: { nodes: [person("Any news?")] } }),
      ],
      [{ id: 1, status: "in_progress", jobs: [{ name: "fabrik / Design-session turn #4", status: "in_progress" }] }],
    );

    expect(queue.designTurnsInProgress).toEqual([4]);
    expect(holding(queue)).toEqual({ 3: true, 4: true, 5: true, 6: false });
  });

  it("reads an issue that got needs-design again, after its old session was abandoned by hand, as waiting", async () => {
    const queue = await gathered([
      issue(3, {
        comments: {
          nodes: [
            kit("<!-- fabrik:design-round 1 -->\n@jrey **Design session, round 1.**", "2026-10-02T09:00:00Z"),
            person("Can we add a cart total?", "2026-11-02T09:00:00Z"),
          ],
        },
        timelineItems: {
          nodes: [
            labelled("needs-design", "2026-10-01T09:00:00Z"),
            unlabelled("needs-design", "2026-10-03T09:00:00Z", "User"),
            labelled("needs-design", "2026-11-01T09:00:00Z"),
          ],
        },
      }),
      issue(4, {
        comments: { nodes: [kit("<!-- fabrik:design-turn-failed -->\n@jrey The Design-session turn run on #4 failed.", "2026-10-02T09:00:00Z")] },
        timelineItems: {
          nodes: [
            labelled("needs-design", "2026-10-01T09:00:00Z"),
            unlabelled("needs-design", "2026-10-03T09:00:00Z", "User"),
            labelled("needs-design", "2026-11-01T09:00:00Z"),
          ],
        },
      }),
      issue(5, {
        comments: { nodes: [kit("<!-- fabrik:design-round 1 -->\n@jrey **Design session, round 1.**", "2026-11-02T09:00:00Z")] },
      }),
    ]);

    expect(holding(queue)).toEqual({ 3: false, 4: false, 5: true });
  });

  it("reads when an issue got needs-design from its label timeline: the latest time it was added", async () => {
    const queue = await gathered([
      issue(3, {
        timelineItems: {
          nodes: [
            labelled("needs-design", "2026-11-01T09:00:00Z"),
            labelled("bug", "2026-11-02T09:00:00Z"),
            labelled("needs-design", "2026-11-03T09:00:00Z"),
            {},
          ],
        },
      }),
    ]);

    expect(queue.issues).toEqual([
      { number: 3, labels: ["needs-design"], designRounds: 0, turnFailed: false, redesign: false, neededDesignAt: "2026-11-03T09:00:00Z" },
    ]);
  });

  describe("reading a re-design", () => {
    const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
    const reviewed = (output: string): LoopEvent => ({
      kind: "review-run-finished",
      pullRequest: 50,
      headSha: HEAD_SHA,
      output,
      runUrl: RUN,
      repoUrl: "https://github.com/acme/shop",
    });
    const earlier = (source: "reviewer" | "ci") => ({
      verdict: "execution-flaw" as const,
      source,
      requestChanges: false,
      headSha: "0".repeat(40),
    });
    const changedNothing: LoopEvent = {
      kind: "implement-run-finished",
      issue: 7,
      output: JSON.stringify({ title: "Handle the empty cart", summary: "Nothing to change." }),
      branch: "fabrik/ticket-7",
      base: "main",
      changes: { net: [], commits: [] },
    };

    /** The comments a plan posts on the Ticket, #7, as the Kit posts them, with any link to another comment filled in. */
    function ticketCommentsOf(plan: Plan): { body: string; author: { __typename: string } }[] {
      if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
      return plan.actions.flatMap((action) => {
        if (action.kind === "comment" && action.issue === 7) return [kit(action.body)];
        if (action.kind === "comment-linking" && action.issue === 7) {
          return [kit(action.body.map((part) => (typeof part === "string" ? part : "https://github.com/acme/shop/pull/50#issuecomment-1")).join(""))];
        }
        return [];
      });
    }

    const emptyDiff = (emptyDiffs: number): Plan =>
      planFor(changedNothing, snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"], emptyDiffs })), kitConfig());

    it.each<[string, Plan[]]>([
      ["a Design flaw", [planFor(reviewed("verdict: design-flaw\n\nWrong approach."), snapshotOfPullRequest(aPullRequest()), kitConfig())]],
      [
        "Retries used up",
        [
          planFor(
            reviewed("verdict: execution-flaw\n\nStill throws."),
            snapshotOfPullRequest(aPullRequest({ pushedSinceVerdict: true, verdicts: [earlier("reviewer"), earlier("ci")] })),
            kitConfig(),
          ),
        ],
      ],
      [
        "the Operator's needs-design at the Merge gate",
        [
          planFor(
            { kind: "pull-request-labeled", pullRequest: 50, label: "needs-design" },
            snapshotOfPullRequest(aPullRequest({ draft: false })),
            kitConfig(),
          ),
        ],
      ],
      ["a third empty diff", [emptyDiff(0), emptyDiff(1), emptyDiff(2)]],
    ])("reads a Ticket sent back by %s as a re-design, which starts before an older new issue", async (_, plans) => {
      const queue = await gathered([
        issue(4, { timelineItems: { nodes: [labelled("needs-design", "2026-10-01T09:00:00Z")] } }),
        issue(7, { comments: { nodes: [person("Can we add a cart total?"), ...plans.flatMap(ticketCommentsOf)] } }),
      ]);

      expect(queue.issues.map(({ number, redesign }) => ({ number, redesign }))).toEqual([
        { number: 4, redesign: false },
        { number: 7, redesign: true },
      ]);
      expect(planFor({ kind: "design-queue-check" }, designQueueSnapshotOf(queue.issues, { designTurnsInProgress: queue.designTurnsInProgress }), kitConfig({ caps: { designSessions: 1 } }))).toEqual({
        kind: "act",
        actions: [{ kind: "add-labels", issue: 7, labels: ["agent:design"] }],
      });
    });

    it("doesn't read an issue with neither, two empty diffs, or a person quoting the note, as a re-design", async () => {
      const note = "<!-- fabrik:back-to-design 50 operator -->\n**Back to design.**";
      const queue = await gathered([
        issue(6, { comments: { nodes: [person("Can we add a cart total?")] } }),
        issue(7, { comments: { nodes: [emptyDiff(0), emptyDiff(1)].flatMap(ticketCommentsOf) } }),
        issue(8, { comments: { nodes: [person(note)] } }),
      ]);

      expect(queue.issues.map(({ redesign }) => redesign)).toEqual([false, false, false]);
    });
  });

  it("falls back to when the issue was opened when its timeline shows no needs-design", async () => {
    const queue = await gathered([issue(3, { timelineItems: { nodes: [] } })]);

    expect(queue.issues[0]?.neededDesignAt).toBe("2026-10-01T09:00:00Z");
  });

  describe("without a token that can read workflow runs, as on the scheduled tick", () => {
    it("reads a first turn in progress from the Kit taking agent:design off since the issue last got needs-design", async () => {
      const queue = await gathered(
        [
          issue(3, {
            timelineItems: {
              nodes: [labelled("needs-design", "2026-11-01T09:00:00Z"), unlabelled("agent:design", "2026-11-01T10:00:00Z")],
            },
          }),
          issue(4, {
            timelineItems: {
              nodes: [unlabelled("agent:design", "2026-10-01T10:00:00Z"), labelled("needs-design", "2026-11-01T09:00:00Z")],
            },
          }),
          issue(5, {
            timelineItems: {
              nodes: [labelled("needs-design", "2026-11-01T09:00:00Z"), unlabelled("agent:design", "2026-11-01T10:00:00Z", "User")],
            },
          }),
          issue(6),
        ],
        null,
      );

      expect(queue.designTurnsInProgress).toEqual([3]);
      expect(holding(queue)).toEqual({ 3: true, 4: false, 5: false, 6: false });
    });

    it("doesn't take needs-design coming off for it being added", async () => {
      const queue = await gathered(
        [
          issue(3, {
            timelineItems: {
              nodes: [labelled("needs-design", "2026-11-01T09:00:00Z"), unlabelled("needs-design", "2026-11-02T09:00:00Z")],
            },
          }),
        ],
        null,
      );

      expect(queue.issues[0]?.neededDesignAt).toBe("2026-11-01T09:00:00Z");
    });
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
                timelineItems: { nodes: [] },
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

describe("Gathering an issue's Design session", () => {
  async function gatheredIssue(
    comments: { body: string; createdAt?: string; author: { __typename: string } }[],
    timeline: unknown[] = [],
  ) {
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
                comments: { nodes: comments.map((comment) => ({ createdAt: "2026-11-02T09:00:00Z", ...comment })) },
                timelineItems: { nodes: timeline },
                closedByPullRequestsReferences: { nodes: [] },
                blockedBy: { nodes: [] },
                blocking: { nodes: [] },
              },
            },
          };
        }
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
    } as unknown as GitHub;
    const event = { kind: "issue-comment-created", issue: 6, commenter: "operator", commenterIsBot: false, body: "More context", comment: 9 } as const;
    return (await gatherSnapshot(github, repo, event, null)).issue;
  }

  it("reads a Design-session turn's failure notice as a failed turn, so the session keeps its slot", async () => {
    const issue = await gatheredIssue([
      { body: `${DESIGN_TURN_FAILED_MARKER}\n@operator The Design-session turn run on #6 failed.`, author: { __typename: "Bot" } },
    ]);

    expect(issue).toMatchObject({ designRounds: 0, turnFailed: true });
  });

  it("reads an issue with no round and no failure as holding no slot", async () => {
    const issue = await gatheredIssue([{ body: "Some context while it waits", author: { __typename: "User" } }]);

    expect(issue).toMatchObject({ designRounds: 0, turnFailed: false });
  });

  it("reads the Kit taking agent:design off since the issue last got needs-design as its first turn having started", async () => {
    const labelled = { __typename: "LabeledEvent", createdAt: "2026-11-01T09:00:00Z", label: { name: "needs-design" } };
    const claimed = {
      __typename: "UnlabeledEvent",
      createdAt: "2026-11-01T10:00:00Z",
      label: { name: "agent:design" },
      actor: { __typename: "Bot" },
    };

    expect(await gatheredIssue([], [labelled, claimed])).toMatchObject({ firstTurnClaimed: true });
    expect(await gatheredIssue([], [claimed, { ...labelled, createdAt: "2026-11-02T09:00:00Z" }])).toMatchObject({ firstTurnClaimed: false });
  });

  it("counts only the rounds and failure notices posted since the issue last got needs-design", async () => {
    const issue = await gatheredIssue(
      [
        { body: "<!-- fabrik:design-round 1 -->\n@operator **Design session, round 1.**", createdAt: "2026-10-02T09:00:00Z", author: { __typename: "Bot" } },
        { body: `${DESIGN_TURN_FAILED_MARKER}\n@operator The Design-session turn run on #6 failed.`, createdAt: "2026-10-03T09:00:00Z", author: { __typename: "Bot" } },
      ],
      [{ __typename: "LabeledEvent", createdAt: "2026-11-01T09:00:00Z", label: { name: "needs-design" } }],
    );

    expect(issue).toMatchObject({ designRounds: 0, turnFailed: false });
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
        timelineItems: { nodes: [] },
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
