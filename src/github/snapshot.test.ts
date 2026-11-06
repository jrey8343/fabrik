import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { GitHub } from "./client.ts";
import { anIssue, aPullRequest, AUDITED_SHA, auditBody, designQueueSnapshotOf, HEAD_SHA, kitConfig, RETRO_WINDOW_END, retroBody, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { type CaptureResult, evidenceSection } from "../evidence/uiEvidence.ts";
import { DEFAULT_KIT_CONFIG, resolveKitConfig } from "../kit/config.ts";
import { JUDGE_JOB } from "../kit/judge.ts";
import { holdsSlot } from "../loop/designQueue.ts";
import { DESIGN_TURN_FAILED_MARKER, RESEARCH_RUN_FAILED_MARKER } from "../loop/markers.ts";
import { planFor } from "../loop/rules.ts";
import type { DesignQueueSnapshot, LoopEvent, Plan } from "../loop/types.ts";
import { countDispatchedRuns, DESIGN_JOB_NAME, designTurnsInProgress, gatherSnapshot, IMPLEMENT_JOB_NAME, readKitConfigSources, RESEARCH_JOB_NAME } from "./snapshot.ts";

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

    expect(await countDispatchedRuns(actions, repo)).toEqual({ implement: 1, research: 0 });
  });

  it("counts an Implement job still queued or waiting after its claim took agent:implement off the Ticket", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Claim the Ticket", status: "completed" }, { name: "fabrik / Implement", status: "queued" }] },
      { id: 2, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "waiting" }] },
      { id: 3, status: "queued", jobs: [{ name: "fabrik / Implement", status: "queued" }] },
      { id: 4, status: "waiting", jobs: [{ name: "fabrik / Implement", status: "pending" }] },
    ]);

    expect(await countDispatchedRuns(actions, repo)).toEqual({ implement: 4, research: 0 });
  });

  it("doesn't count a finished Implement job, or any other job", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "completed" }, { name: "fabrik / Review", status: "in_progress" }] },
      { id: 2, status: "in_progress", jobs: [{ name: "fabrik / Implement failed", status: "in_progress" }] },
    ]);

    expect(await countDispatchedRuns(actions, repo)).toEqual({ implement: 0, research: 0 });
  });
});

describe("Counting the Research runs a Dispatch check sees in flight", () => {
  it("counts a Research job running, queued or waiting, called from a Product repo's caller workflow or not, beside the Implement jobs", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Research", status: "in_progress" }, { name: "fabrik / Implement", status: "in_progress" }] },
      { id: 2, status: "queued", jobs: [{ name: "fabrik / Research", status: "queued" }] },
      { id: 3, status: "waiting", jobs: [{ name: "Research", status: "waiting" }] },
    ]);

    expect(await countDispatchedRuns(actions, repo)).toEqual({ implement: 1, research: 3 });
  });

  it("doesn't count a finished Research job, or any other job", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Research", status: "completed" }, { name: "fabrik / Push", status: "in_progress" }] },
      { id: 2, status: "in_progress", jobs: [{ name: "fabrik / Retro evidence", status: "in_progress" }, { name: "fabrik / Research failed", status: "in_progress" }] },
    ]);

    expect(await countDispatchedRuns(actions, repo)).toEqual({ implement: 0, research: 0 });
  });
});

describe("The Implement job's name", () => {
  it("is the name loop.yml gives the Implement job, which Dispatch counts by", async () => {
    const workflow = await readFile(new URL("../../.github/workflows/loop.yml", import.meta.url), "utf8");
    const implementJob = /^ {2}implement:\n {4}name: (.+)$/m.exec(workflow)?.[1];

    expect(implementJob).toBe(IMPLEMENT_JOB_NAME);
  });
});

describe("The Research job's name", () => {
  it("is the name loop.yml gives the Research job, which Dispatch counts Research runs by", async () => {
    const workflow = await readFile(new URL("../../.github/workflows/loop.yml", import.meta.url), "utf8");
    const researchJob = /^ {2}research:\n {4}name: (.+)$/m.exec(workflow)?.[1];

    expect(researchJob).toBe(RESEARCH_JOB_NAME);
  });
});

describe("The judge job's name", () => {
  // #149: scoring never takes a Dispatch slot, nor a Design session slot.
  it("is never counted as an Implement run, a Research run or a Design-session turn in flight while it scores a run", async () => {
    const workflow = await readFile(new URL("../../.github/workflows/loop.yml", import.meta.url), "utf8");
    const judgeJob = new RegExp(`^ {2}${JUDGE_JOB}:\n {4}name: (.+)$`, "m").exec(workflow)?.[1];
    expect(judgeJob).toBeDefined();
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "completed" }, { name: `fabrik / ${judgeJob}`, status: "in_progress" }] },
      { id: 2, status: "queued", jobs: [{ name: `fabrik / ${judgeJob}`, status: "queued" }] },
    ]);

    expect(await countDispatchedRuns(actions, repo)).toEqual({ implement: 0, research: 0 });
    expect(await designTurnsInProgress(actions, repo)).toEqual([]);
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
    const snapshot = await gatherSnapshot(github, repo, { kind: "design-queue-check" }, null, null, actions);
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
      expect(planFor({ kind: "design-queue-check" }, designQueueSnapshotOf(queue.issues, { designTurnsInProgress: queue.designTurnsInProgress }), kitConfig({ caps: { ...DEFAULT_KIT_CONFIG.caps, designSessions: 1 } }))).toEqual({
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

    const snapshot = await gatherSnapshot(github, repo, { kind: "label-added", issue: 6, label: "needs-design" }, null, null);

    expect(snapshot.issue).toMatchObject({ openBlockers: [10], openBlocking: [7] });
  });
});

/** An issue's parent, as GitHub holds it. */
interface GitHubParent {
  number: number;
  state: "OPEN" | "CLOSED";
  labels: string[];
}

/** The issue a Loop event is about, as GitHub holds it: opened by `author`, with this title, body, these labels and this parent. */
function issueGitHub({
  author = { login: "someone", __typename: "User" },
  title = "An issue",
  body = "",
  labels = ["needs-design"],
  parent = null,
}: {
  author?: { login: string; __typename: string } | null;
  title?: string;
  body?: string;
  labels?: string[];
  parent?: GitHubParent | null;
} = {}): GitHub {
  return {
    async graphql(query: string): Promise<unknown> {
      if (!query.includes("issue(number: $number)")) return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      // GitHub answers only the fields the query selects.
      const issueQuery = query.slice(query.indexOf("issue(number: $number)"));
      const selectsType = /^\s*author \{[^}]*__typename/m.test(issueQuery);
      const parentSelection = /^\s*parent \{[^}]*/m.exec(issueQuery)?.[0] ?? "";
      return {
        repository: {
          owner: { login: "acme" },
          issue: {
            number: 98,
            state: "OPEN",
            author: author === null || selectsType ? author : { login: author.login },
            ...(/^\s*title$/m.test(issueQuery) ? { title } : {}),
            ...(/^\s*body$/m.test(issueQuery) ? { body } : {}),
            labels: { nodes: labels.map((name) => ({ name })) },
            parent:
              parent === null
                ? null
                : {
                    number: parent.number,
                    ...(/\bstate\b/.test(parentSelection) ? { state: parent.state } : {}),
                    ...(/\blabels\(/.test(parentSelection) ? { labels: { nodes: parent.labels.map((name) => ({ name })) } } : {}),
                  },
            comments: { nodes: [] },
            timelineItems: { nodes: [] },
            closedByPullRequestsReferences: { nodes: [] },
            blockedBy: { nodes: [] },
            blocking: { nodes: [] },
          },
        },
      };
    },
  } as unknown as GitHub;
}

/** The Fabrik App's bot login, its slug with `[bot]`, as a run that knows it has it. */
const APP_LOGIN = "fabrik-app[bot]";

/** The Fabrik App's bot, as GraphQL names it: without its [bot] suffix. */
const APP_BOT = { login: "fabrik-app", __typename: "Bot" };

/** An open needs-design issue with nothing else on it, as the issue query answers for it. */
const issueData = (number: number) => ({
  repository: {
    owner: { login: "acme" },
    issue: {
      number,
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
});

/** A Design-session turn's map outcome, with one research Decision. */
const aMap = {
  kind: "map",
  comment: "Too foggy for one session.",
  destination: "Patients book group classes online.",
  notes: "",
  notYetSpecified: "",
  outOfScope: "",
  decisions: [{ key: "provider", title: "Which provider?", body: "Which one?", type: "research", blockedBy: [] }],
};

describe("Gathering an issue's body", () => {
  it("holds the body as it stands, so a Design session's rewrite can keep its Monitor marker and carry its marker lines forward", async () => {
    const body = "<!-- fabrik:monitor sentry:4504 -->\n## Production error\n\nFrom audit #40\n<!-- fabrik:escape strong #31 -->";
    const event = { kind: "label-added", issue: 98, label: "needs-design" } as const;

    const snapshot = await gatherSnapshot(issueGitHub({ author: APP_BOT, body }), repo, event, null, APP_LOGIN);

    expect(snapshot.issue?.body).toBe(body);
  });
});

describe("Gathering an issue's title", () => {
  it("holds the title as it stands, so a resolved research Decision's line in its Map names it", async () => {
    const event = { kind: "issue-opened", issue: 98 } as const;

    const snapshot = await gatherSnapshot(issueGitHub({ title: "Which payment provider fits group classes?" }), repo, event, null, APP_LOGIN);

    expect(snapshot.issue?.title).toBe("Which payment provider fits group classes?");
  });
});

describe("Gathering an issue's parent", () => {
  const labelled = { kind: "label-added", issue: 98, label: "agent:research" } as const;

  it("holds the parent's number, whether it's open and its labels, so the core can tell a research Decision's Map is open", async () => {
    const github = issueGitHub({
      labels: ["wayfinder:research", "agent:research"],
      parent: { number: 3, state: "OPEN", labels: ["enhancement", "wayfinder:map"] },
    });

    const snapshot = await gatherSnapshot(github, repo, labelled, null, APP_LOGIN);

    expect(snapshot.issue).toMatchObject({ parent: 3, parentIssue: { number: 3, open: true, labels: ["enhancement", "wayfinder:map"] } });
  });

  it("holds a closed parent as closed", async () => {
    const github = issueGitHub({ labels: ["wayfinder:research"], parent: { number: 3, state: "CLOSED", labels: ["wayfinder:map"] } });

    const snapshot = await gatherSnapshot(github, repo, labelled, null, APP_LOGIN);

    expect(snapshot.issue?.parentIssue).toEqual({ number: 3, open: false, labels: ["wayfinder:map"] });
  });

  it("holds no parent for an issue that isn't a sub-issue", async () => {
    const snapshot = await gatherSnapshot(issueGitHub({ labels: ["wayfinder:research"] }), repo, labelled, null, APP_LOGIN);

    expect(snapshot.issue).toMatchObject({ parent: null, parentIssue: null });
  });
});

describe("Gathering who opened an issue", () => {
  const opened = { kind: "issue-opened", issue: 98 } as const;

  /** The issue as gathered, opened by this account, by a run that knows the App's login, or that doesn't (null). */
  async function openedBy(author: { login: string; __typename: string } | null, appLogin: string | null = APP_LOGIN) {
    return (await gatherSnapshot(issueGitHub({ author, labels: ["fabrik:audit"] }), repo, opened, null, appLogin)).issue;
  }

  it("says the Fabrik App opened it when its bot did, so its Audit markers are read and a Design session keeps its Monitor marker", async () => {
    expect(await openedBy(APP_BOT)).toMatchObject({ author: "fabrik-app", byApp: true });
  });

  it("says the App didn't when a person did, whatever their login", async () => {
    expect(await openedBy({ login: "fabrik-app", __typename: "User" })).toMatchObject({ author: "fabrik-app", byApp: false });
  });

  it.each([
    ["another bot", { login: "other-app", __typename: "Bot" }],
    ["a deleted account", null],
  ])("says the App didn't when %s did, so its issue is never read for Audit markers", async (_, author) => {
    expect(await openedBy(author)).toMatchObject({ byApp: false });
  });

  it("keeps no Monitor marker in the Spec a Design session writes from an issue another bot opened", async () => {
    const finished = {
      kind: "agent-run-finished",
      role: "design",
      issue: 98,
      output: JSON.stringify({
        kind: "spec",
        comment: "Too big for one PR.",
        spec: { title: "Spec: Booking form errors", body: "## Problem Statement\n\nThe booking form throws." },
        tickets: [{ key: "fix", title: "Fix the form", body: "## What to build\n\nThe fix.", blockedBy: [] }],
      }),
    } as const;
    const github = issueGitHub({
      author: { login: "dependabot", __typename: "Bot" },
      body: "<!-- fabrik:monitor sentry:4504 -->\n## Production error",
      labels: ["fabrik:monitor", "needs-design"],
    });

    const plan = planFor(finished, await gatherSnapshot(github, repo, finished, null, APP_LOGIN), kitConfig());

    const spec = plan.kind === "act" ? plan.actions.find((action) => action.kind === "create-issue" && action.key === "spec") : undefined;
    expect(spec?.kind).toBe("create-issue");
    expect(spec?.kind === "create-issue" ? spec.body : "").not.toContain("fabrik:monitor");
    expect(spec?.kind === "create-issue" ? spec.labels : []).not.toContain("fabrik:monitor");
  });

  // The Kit job routes the App's pending Audit to its Auditor run, which it couldn't if no issue were the App's.
  it("takes any bot, but never a person, for the Fabrik App when the run doesn't know the App's login, as the Kit job, which only routes, doesn't", async () => {
    expect(await openedBy(APP_BOT, null)).toMatchObject({ byApp: true });
    expect(await openedBy({ login: "fabrik-app", __typename: "User" }, null)).toMatchObject({ byApp: false });
  });

  // The Kit job routes the event with no Fabrik App token, so it gathers with no App login.
  it("lets the Kit job, which doesn't know the App's login, route the App's pending Audit to its Auditor run", async () => {
    const github = issueGitHub({ author: APP_BOT, body: auditBody(AUDITED_SHA, "pending"), labels: ["fabrik:audit"] });

    const plan = planFor(opened, await gatherSnapshot(github, repo, opened, null, null), kitConfig());

    expect(plan).toMatchObject({ kind: "act", actions: [{ kind: "start-agent-run", role: "audit", issue: 98, commit: AUDITED_SHA }] });
  });

  it("lets the Kit job, which doesn't know the App's login, route the App's pending Retro to its Retro run", async () => {
    const github = issueGitHub({ author: APP_BOT, body: retroBody(RETRO_WINDOW_END, "pending"), labels: ["fabrik:retro"] });

    const plan = planFor(opened, await gatherSnapshot(github, repo, opened, null, null), kitConfig());

    expect(plan).toMatchObject({ kind: "act", actions: [{ kind: "start-agent-run", role: "retro", issue: 98 }] });
  });

  // The Kit job can't tell the App's bot from another, and telling it would take a setup step (#150 rules one out).
  it("takes another bot's pending Audit for the App's only where the login isn't known: the Kit job starts its Auditor run, whose result the push job drops", async () => {
    const github = issueGitHub({ author: { login: "other-app", __typename: "Bot" }, body: auditBody(AUDITED_SHA, "pending"), labels: ["fabrik:audit"] });
    const finished = {
      kind: "audit-run-finished",
      issue: 98,
      output: JSON.stringify({ candidates: [], topRecommendation: null }),
      window: { kind: "last-days", days: 30 },
      runUrl: "https://github.com/acme/shop/actions/runs/1",
      repoUrl: "https://github.com/acme/shop",
    } as const;

    const kitJob = await gatherSnapshot(github, repo, opened, null, null);
    const pushJob = await gatherSnapshot(github, repo, finished, null, APP_LOGIN);

    expect([kitJob.issue?.byApp, pushJob.issue?.byApp]).toEqual([true, false]);
    expect(planFor(opened, kitJob, kitConfig())).toMatchObject({ kind: "act", actions: [{ kind: "start-agent-run", role: "audit", issue: 98 }] });
    expect(planFor(finished, pushJob, kitConfig())).toEqual({
      kind: "nothing",
      reason: "#98 is no longer a pending Audit, so its Auditor's result is stale",
    });
  });

  it("takes another bot's pending Retro for the App's only where the login isn't known: the Kit job starts its Retro run, whose result the push job drops", async () => {
    const github = issueGitHub({ author: { login: "other-app", __typename: "Bot" }, body: retroBody(RETRO_WINDOW_END, "pending"), labels: ["fabrik:retro"] });
    const finished = {
      kind: "retro-run-finished",
      issue: 98,
      output: JSON.stringify({ proposals: [] }),
      evidence: { window: { start: "2026-10-24T06:00:00.000Z", end: RETRO_WINDOW_END }, refs: [], streakTable: [], transcripts: {} },
      runUrl: "https://github.com/acme/shop/actions/runs/1",
      repoUrl: "https://github.com/acme/shop",
    } as const;

    const kitJob = await gatherSnapshot(github, repo, opened, null, null);
    const pushJob = await gatherSnapshot(github, repo, finished, null, APP_LOGIN);

    expect([kitJob.issue?.byApp, pushJob.issue?.byApp]).toEqual([true, false]);
    expect(planFor(opened, kitJob, kitConfig())).toMatchObject({ kind: "act", actions: [{ kind: "start-agent-run", role: "retro", issue: 98 }] });
    expect(planFor(finished, pushJob, kitConfig())).toEqual({
      kind: "nothing",
      reason: "#98 is no longer a pending Retro, so its Retro run's result is stale",
    });
  });
});

/** The pull request a Loop event is about, as GitHub holds it: opened by `author`, with this body. */
function pullRequestGitHub({
  author = APP_BOT,
  body = "",
}: { author?: { login: string; __typename: string } | null; body?: string } = {}): GitHub {
  return {
    async graphql(query: string): Promise<unknown> {
      if (!query.includes("pullRequest(number: $number)")) return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      // GitHub answers only the fields the query selects.
      const pullRequestQuery = query.slice(query.indexOf("pullRequest(number: $number)"));
      const selectsLogin = /^\s*author \{[^}]*login/m.test(pullRequestQuery);
      return {
        repository: {
          owner: { login: "acme" },
          pullRequest: {
            number: 50,
            state: "OPEN",
            isDraft: true,
            headRefName: "fabrik/ticket-7",
            headRefOid: HEAD_SHA,
            author: author === null || selectsLogin ? author : { __typename: author.__typename },
            ...(/^\s*body$/m.test(pullRequestQuery) ? { body } : {}),
            labels: { nodes: [] },
            comments: { nodes: [] },
            reviews: { nodes: [] },
          },
        },
      };
    },
  } as unknown as GitHub;
}

describe("Gathering a pull request's UI evidence marker", () => {
  const pushed = { kind: "pull-request-pushed", pullRequest: 50 } as const;
  const captured: CaptureResult = {
    outcome: "captured",
    headSha: HEAD_SHA,
    captures: [{ route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-book.png" }],
  };
  /** A UI PR's body as the push job writes it: the summary, the evidence section and its marker, then Closes. */
  const uiBody = (run: number, artifact: number | null) =>
    [
      "Adds a waitlist to full days.",
      evidenceSection({ result: captured, run, artifact, gallery: "https://github.com/acme/shop/actions/runs/9100/artifacts/9201", preview: { kind: "none" } }),
      "Closes #7",
    ].join("\n\n");

  /** The pull request as gathered, opened by this account, by a run that knows the App's login, or that doesn't (null). */
  async function gathered(body: string, author: { login: string; __typename: string } | null = APP_BOT, appLogin: string | null = APP_LOGIN) {
    return (await gatherSnapshot(pullRequestGitHub({ author, body }), repo, pushed, null, appLogin)).pullRequest;
  }

  it("reads back where the evidence section's marker says the UI evidence is kept, in a body the Fabrik App wrote", async () => {
    expect(await gathered(uiBody(9100, 9202))).toMatchObject({ uiEvidenceMarker: { run: 9100, artifact: 9202 } });
  });

  it("reads back a marker naming no artifact, as when capture left no result", async () => {
    expect(await gathered(uiBody(9100, null))).toMatchObject({ uiEvidenceMarker: { run: 9100, artifact: null } });
  });

  it("reads back the capture's outcome the marker records: null for a capture that captured, else why it failed", async () => {
    const failed: CaptureResult = { outcome: "failed", reason: "build-failed", headSha: HEAD_SHA, captures: [] };
    const failedBody = evidenceSection({ result: failed, run: 9100, artifact: null, gallery: null, preview: { kind: "none" } });

    expect((await gathered(uiBody(9100, 9202)))?.uiEvidenceMarker).toEqual({ run: 9100, artifact: 9202, failure: null });
    expect((await gathered(`Adds a waitlist.\n\n${failedBody}\n\nCloses #7`))?.uiEvidenceMarker).toEqual({
      run: 9100,
      artifact: null,
      failure: "build-failed",
    });
  });

  it.each([
    ["from before markers recorded it", `<!-- fabrik:ui-evidence {"run":9100,"artifact":null} -->`],
    ["that names no capture failure the Kit knows", `<!-- fabrik:ui-evidence {"run":9100,"artifact":null,"failure":"on-fire"} -->`],
  ])("reads a marker %s as recording no capture outcome, and still marks the PR UI", async (_, marker) => {
    expect((await gathered(`Adds a waitlist.\n\n${marker}\n\nCloses #7`))?.uiEvidenceMarker).toEqual({ run: 9100, artifact: null });
  });

  it("finds no UI evidence on a PR whose body has no marker: not a UI PR", async () => {
    expect(await gathered("Adds a retry to the booking API.\n\nCloses #7")).toMatchObject({ uiEvidenceMarker: null });
  });

  it.each([
    ["a person", { login: "fabrik-app", __typename: "User" }],
    ["another bot", { login: "other-app", __typename: "Bot" }],
    ["a deleted account", null],
  ])("ignores a marker in the body of a PR %s opened, so nobody can fake one", async (_, author) => {
    expect(await gathered(uiBody(9100, 9202), author)).toMatchObject({ uiEvidenceMarker: null });
  });

  it("takes any bot's body for the App's when the run doesn't know the App's login, as the Kit job, which only routes, doesn't", async () => {
    expect(await gathered(uiBody(9100, 9202), APP_BOT, null)).toMatchObject({ uiEvidenceMarker: { run: 9100, artifact: 9202 } });
    expect(await gathered(uiBody(9100, 9202), { login: "fabrik-app", __typename: "User" }, null)).toMatchObject({ uiEvidenceMarker: null });
  });

  it.each([
    ["isn't JSON", "<!-- fabrik:ui-evidence {run:9100} -->"],
    ["names no run", `<!-- fabrik:ui-evidence {"artifact":9202} -->`],
    ["names a run that isn't an id", `<!-- fabrik:ui-evidence {"run":"9100","artifact":9202} -->`],
    ["names an artifact that isn't an id", `<!-- fabrik:ui-evidence {"run":9100,"artifact":-1} -->`],
    ["shares its line", `See <!-- fabrik:ui-evidence {"run":9100,"artifact":9202} -->`],
  ])("finds no UI evidence where the marker %s", async (_, marker) => {
    expect(await gathered(`Adds a waitlist.\n\n${marker}\n\nCloses #7`)).toMatchObject({ uiEvidenceMarker: null });
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
    return (await gatherSnapshot(github, repo, event, null, null)).issue;
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

  it("reads the Kit's refusal of a Map past the Map cap as the Operator's move, so the session keeps its slot and their reply starts its next turn", async () => {
    const refused = planFor(
      { kind: "agent-run-finished", role: "design", issue: 6, output: JSON.stringify(aMap) },
      snapshotOf(anIssue({ number: 6, labels: ["needs-design"] }), { openMaps: [12] }),
      kitConfig(),
    );
    const refusal = refused.kind === "act" && refused.actions[0]?.kind === "comment" ? refused.actions[0].body : "";

    const issue = await gatheredIssue([{ body: refusal, author: { __typename: "Bot" } }]);

    expect(issue).toMatchObject({ designRounds: 0, turnFailed: true });
    const reply = { kind: "issue-comment-created", issue: 6, commenter: "operator", commenterIsBot: false, body: "Make it a Spec then", comment: 9 } as const;
    expect(planFor(reply, snapshotOf(issue ?? anIssue()), kitConfig())).toMatchObject({
      kind: "act",
      actions: [{ kind: "start-agent-run", role: "design", issue: 6 }],
    });
  });
});

describe("Gathering the open Maps a Design-session turn's Map is weighed against", () => {
  /** GitHub holding these open wayfinder:map issues, oldest first; the open Maps query is answered from them alone. */
  function githubWithMaps(maps: { number: number; title: string; author: { login: string; __typename: string } }[]) {
    const asked: Record<string, unknown>[] = [];
    const github = {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        if (query.includes("labels: [$map]")) {
          asked.push(variables);
          expect(query).toContain("states: OPEN");
          return { repository: { issues: { nodes: maps } } };
        }
        if (query.includes("issue(number: $number)")) return issueData(7);
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
    } as unknown as GitHub;
    return { github, asked };
  }

  const designTurn = { kind: "agent-run-finished", role: "design", issue: 7, output: "{}" } as const;

  it("holds every open wayfinder:map issue, whoever made it, the Kit or the Operator by hand", async () => {
    const { github, asked } = githubWithMaps([
      { number: 12, title: "Group classes", author: { login: "jrey", __typename: "User" } },
      { number: 14, title: "Online intake", author: { login: "fabrik-app", __typename: "Bot" } },
    ]);

    const snapshot = await gatherSnapshot(github, repo, designTurn, null, APP_LOGIN);

    expect(snapshot.openMaps).toEqual([12, 14]);
    expect(asked).toEqual([expect.objectContaining({ owner: "acme", name: "shop", map: "wayfinder:map" })]);
  });

  it("holds none when no Map is open", async () => {
    const { github } = githubWithMaps([]);

    expect((await gatherSnapshot(github, repo, designTurn, null, APP_LOGIN)).openMaps).toEqual([]);
  });

  it.each([
    ["a Triage run finishing", { kind: "agent-run-finished", role: "triage", issue: 7, output: "{}" }],
    ["a reply in a Design session", { kind: "issue-comment-created", issue: 7, commenter: "operator", commenterIsBot: false, body: "Yes", comment: 9 }],
  ] as const)("isn't gathered for %s", async (_, event) => {
    const { github, asked } = githubWithMaps([{ number: 12, title: "Group classes", author: { login: "jrey", __typename: "User" } }]);

    expect((await gatherSnapshot(github, repo, event, null, APP_LOGIN)).openMaps).toBeNull();
    expect(asked).toEqual([]);
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
        return { repository: { owner: { login: "acme" }, issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
      },
    } as unknown as GitHub;

    const snapshot = await gatherSnapshot(github, repo, { kind: "dispatch-check" }, null, null, actionsWith([]) as unknown as GitHub);

    expect(snapshot.dispatch?.tickets).toMatchObject([{ number: 6, openBlockers: [10], notPlannedBlockers: [9] }]);
  });
});

/** An open `wayfinder:research` issue as GitHub holds it, by default unassigned, unblocked, under the open Map #3, and with no comments. */
function aResearchNode(
  number: number,
  {
    labels = ["wayfinder:research"],
    assignees = [],
    blockedBy = [],
    parent = { number: 3, state: "OPEN", labels: ["enhancement", "wayfinder:map"] },
    comments = [],
  }: {
    labels?: string[];
    assignees?: string[];
    blockedBy?: { number: number; state: "OPEN" | "CLOSED" }[];
    parent?: GitHubParent | null;
    comments?: { body: string; author: { __typename: string } | null }[];
  } = {},
) {
  return {
    number,
    state: "OPEN",
    labels: { nodes: labels.map((name) => ({ name })) },
    assignees: { nodes: assignees.map((login) => ({ login })) },
    blockedBy: { nodes: blockedBy },
    parent: parent === null ? null : { number: parent.number, state: parent.state, labels: { nodes: parent.labels.map((name) => ({ name })) } },
    comments: { nodes: comments },
  };
}

describe("Gathering a Dispatch check's research Decisions", () => {
  /** The read-only API, holding no ready-for-agent Ticket and these pages of open `wayfinder:research` issues. */
  function researchGitHub(pages: ReturnType<typeof aResearchNode>[][]): GitHub {
    return {
      async graphql(query: string, variables: { after: string | null; research?: string }): Promise<unknown> {
        if (query.includes("labels: [$ready]")) {
          return { repository: { owner: { login: "acme" }, issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, pullRequests: { nodes: [] } } };
        }
        if (query.includes("labels: [$research]")) {
          expect(variables.research).toBe("wayfinder:research");
          const page = variables.after === null ? 0 : Number(variables.after);
          const hasNextPage = page + 1 < pages.length;
          return {
            repository: {
              issues: { pageInfo: { hasNextPage, endCursor: hasNextPage ? String(page + 1) : null }, nodes: pages[page] ?? [] },
            },
          };
        }
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
    } as unknown as GitHub;
  }

  async function gathered(pages: ReturnType<typeof aResearchNode>[][]) {
    const snapshot = await gatherSnapshot(researchGitHub(pages), repo, { kind: "dispatch-check" }, null, null, actionsWith([]) as unknown as GitHub);
    return snapshot.dispatch?.researchDecisions;
  }

  it("holds each one, on every page, with its labels, assignees, open blockers and parent Map's state", async () => {
    const decisions = await gathered([
      [
        aResearchNode(12, {
          labels: ["wayfinder:research", "agent:research"],
          assignees: ["jrey"],
          blockedBy: [
            { number: 10, state: "OPEN" },
            { number: 9, state: "CLOSED" },
          ],
        }),
      ],
      [
        aResearchNode(14, { parent: { number: 5, state: "CLOSED", labels: ["wayfinder:map"] } }),
        aResearchNode(15, { parent: null }),
      ],
    ]);

    expect(decisions).toEqual([
      {
        number: 12,
        open: true,
        labels: ["wayfinder:research", "agent:research"],
        assignees: ["jrey"],
        openBlockers: [10],
        parentIssue: { number: 3, open: true, labels: ["enhancement", "wayfinder:map"] },
        lastRunFailed: false,
      },
      { number: 14, open: true, labels: ["wayfinder:research"], assignees: [], openBlockers: [], parentIssue: { number: 5, open: false, labels: ["wayfinder:map"] }, lastRunFailed: false },
      { number: 15, open: true, labels: ["wayfinder:research"], assignees: [], openBlockers: [], parentIssue: null, lastRunFailed: false },
    ]);
  });

  it("holds the Research runs in flight beside the Implement runs, read through the Actions token", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Research", status: "in_progress" }] },
      { id: 2, status: "queued", jobs: [{ name: "fabrik / Implement", status: "queued" }, { name: "fabrik / Research", status: "queued" }] },
    ]);

    const snapshot = await gatherSnapshot(researchGitHub([]), repo, { kind: "dispatch-check" }, null, null, actions as unknown as GitHub);

    expect(snapshot.dispatch).toMatchObject({ implementRunsInProgress: 1, researchRunsInProgress: 2 });
  });

  const BOT = { __typename: "Bot" };
  const PERSON = { __typename: "User" };
  const NOTICE = `${RESEARCH_RUN_FAILED_MARKER}\n@operator The Research run on #12 failed: it crashed.`;

  it.each([
    ["the Kit's failure notice is its last comment", [{ body: NOTICE, author: BOT }], true],
    ["the Operator has only replied since the Kit's failure notice", [{ body: NOTICE, author: BOT }, { body: "Looking into it", author: PERSON }], true],
    ["the Kit has commented since its failure notice, as a later run's resolution does", [{ body: NOTICE, author: BOT }, { body: "**Resolved.** The gist.", author: BOT }], false],
    ["a person quoted the failure notice", [{ body: NOTICE, author: PERSON }], false],
    ["it has no comments", [], false],
  ])("reads its last run as failed only when the Kit's failure notice is its latest run's word: %s", async (_case, comments, failed) => {
    const decisions = await gathered([[aResearchNode(12, { comments })]]);

    expect(decisions?.[0]?.lastRunFailed).toBe(failed);
  });
});

describe("Gathering a scheduled tick's audit slice", () => {
  const HEAD = "c".repeat(40);

  /** The read-only API, holding this default branch head and these `fabrik:audit` issues, newest first, and no other issue or PR. */
  function githubWith(defaultBranchRef: { target: { oid: string } } | null, nodes: unknown[]) {
    return {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        if (query.includes("defaultBranchRef")) {
          return { repository: { defaultBranchRef, issues: { nodes: variables["label"] === "fabrik:audit" ? nodes : [] } } };
        }
        const none = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
        return { repository: { owner: { login: "acme" }, issues: none, pullRequests: none } };
      },
    } as unknown as GitHub;
  }

  const tick = { kind: "scheduled-tick", now: "2026-11-08T04:00:00.000Z" } as const;

  it("holds the default branch's head and each Audit issue, open or closed, with its title, telling the Fabrik App's from a person's or another bot's", async () => {
    const github = githubWith({ target: { oid: HEAD } }, [
      { number: 97, title: "My audit", state: "OPEN", stateReason: null, createdAt: "2026-11-08T00:05:00Z", body: "Quoting <!-- fabrik:audit-pending -->", author: { login: "jrey8343", __typename: "User" } },
      { number: 96, title: "Audit: week of 2026-11-02", state: "OPEN", stateReason: null, createdAt: "2026-11-08T00:04:30Z", body: "<!-- fabrik:audit-pending -->", author: { login: "other-app", __typename: "Bot" } },
      { number: 95, title: "Audit: week of 2026-11-02", state: "CLOSED", stateReason: "NOT_PLANNED", createdAt: "2026-11-08T00:04:00Z", body: "failed", author: { login: "fabrik-app", __typename: "Bot" } },
      { number: 90, title: "Audit: week of 2026-10-26", state: "CLOSED", stateReason: "COMPLETED", createdAt: "2026-11-01T00:05:00Z", body: "filled", author: { login: "fabrik-app", __typename: "Bot" } },
      { number: 85, title: "Audit: week of 2026-10-19", state: "OPEN", stateReason: "REOPENED", createdAt: "2026-10-25T00:05:00Z", body: "", author: null },
    ]);

    const snapshot = await gatherSnapshot(github, repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.audit).toEqual({
      head: HEAD,
      issues: [
        { number: 97, title: "My audit", open: true, stateReason: null, createdAt: "2026-11-08T00:05:00Z", byApp: false, body: "Quoting <!-- fabrik:audit-pending -->" },
        { number: 96, title: "Audit: week of 2026-11-02", open: true, stateReason: null, createdAt: "2026-11-08T00:04:30Z", byApp: false, body: "<!-- fabrik:audit-pending -->" },
        { number: 95, title: "Audit: week of 2026-11-02", open: false, stateReason: "not_planned", createdAt: "2026-11-08T00:04:00Z", byApp: true, body: "failed" },
        { number: 90, title: "Audit: week of 2026-10-26", open: false, stateReason: "completed", createdAt: "2026-11-01T00:05:00Z", byApp: true, body: "filled" },
        { number: 85, title: "Audit: week of 2026-10-19", open: true, stateReason: "reopened", createdAt: "2026-10-25T00:05:00Z", byApp: false, body: "" },
      ],
    });
  });

  it("holds no head for a repo whose default branch has no commits", async () => {
    const snapshot = await gatherSnapshot(githubWith(null, []), repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.audit).toEqual({ head: null, issues: [] });
  });

  it("isn't gathered for any other event", async () => {
    const snapshot = await gatherSnapshot(githubWith({ target: { oid: HEAD } }, []), repo, { kind: "kit-config-changed" }, null, "fabrik-app[bot]");

    expect(snapshot.audit).toBeNull();
  });
});

describe("Gathering a scheduled tick's retro slice", () => {
  /** Saturday 2026-11-07 04:00 UTC. A first Retro's window starts 7 days before: 2026-10-31 04:00 UTC. */
  const tick = { kind: "scheduled-tick", now: "2026-11-07T04:00:00.000Z" } as const;

  /** A `fabrik:retro` issue node as the query returns it: by default the App's last Retro, whose window ended 2026-11-04 04:00 UTC. */
  function aRetroNode(overrides: Record<string, unknown> = {}) {
    return {
      number: 80,
      title: "Retro: week of 2026-11-02",
      state: "CLOSED",
      stateReason: "COMPLETED",
      createdAt: "2026-11-04T04:00:04Z",
      body: retroBody("2026-11-04T04:00:00.000Z"),
      author: { login: "fabrik-app", __typename: "Bot" },
      ...overrides,
    };
  }

  /** A merged or closed PR node: by default an agent PR the Fabrik App opened, merged at `closedAt`. */
  function aClosedPullRequest(closedAt: string, overrides: Record<string, unknown> = {}) {
    return { headRefName: "fabrik/ticket-7", closedAt, updatedAt: closedAt, author: { __typename: "Bot" }, ...overrides };
  }

  /** An issue node the Operator opened, by default with an escape marker. */
  function anOperatorIssue(createdAt: string, body = "Make the cart module deeper\n\n<!-- fabrik:escape strong #31 -->") {
    return { createdAt, body };
  }

  /**
   * The read-only API, holding these `fabrik:retro` issues, these pages of
   * merged and closed PRs, newest-updated first, and the issues the Operator
   * opened, newest first. The queries it was asked are in `asked`.
   */
  function githubWith({
    retros = [],
    pullRequestPages = [[]],
    operatorIssues = [],
  }: { retros?: unknown[]; pullRequestPages?: unknown[][]; operatorIssues?: unknown[] } = {}) {
    const asked: { query: string; variables: Record<string, unknown> }[] = [];
    const github = {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        asked.push({ query, variables });
        if (query.includes("labels: [$label]")) {
          return { repository: { defaultBranchRef: null, issues: { nodes: variables["label"] === "fabrik:retro" ? retros : [] } } };
        }
        if (query.includes("states: [MERGED, CLOSED]")) {
          const at = typeof variables["after"] === "string" ? Number(variables["after"]) : 0;
          const hasNextPage = at + 1 < pullRequestPages.length;
          return { repository: { pullRequests: { pageInfo: { hasNextPage, endCursor: hasNextPage ? String(at + 1) : null }, nodes: pullRequestPages[at] } } };
        }
        if (query.includes("createdBy: $operator")) {
          return { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: operatorIssues } } };
        }
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
    } as unknown as GitHub;
    return { github, asked };
  }

  /** The store's metadata as a token scoped to it reads it. */
  function storeThatIs(visibility: "private" | "public") {
    return {
      async rest(method: string, path: string): Promise<unknown> {
        expect([method, path]).toEqual(["GET", "/repos/jrey8343/fabrik-runs"]);
        return { full_name: "jrey8343/fabrik-runs", private: visibility === "private" };
      },
    } as unknown as GitHub;
  }

  const gather = (github: GitHub, store: GitHub | null = storeThatIs("private"), operator: string | null = null) =>
    gatherSnapshot(github, repo, tick, operator, "fabrik-app[bot]", null, store);

  it("holds each Retro issue, open or closed, with its title, telling the Fabrik App's from a person's or another bot's", async () => {
    const { github } = githubWith({
      retros: [
        aRetroNode({ number: 97, title: "My retro", state: "OPEN", stateReason: null, createdAt: "2026-11-07T00:05:00Z", body: "Quoting <!-- fabrik:retro-pending -->", author: { login: "jrey8343", __typename: "User" } }),
        aRetroNode({ number: 96, state: "OPEN", stateReason: null, body: "<!-- fabrik:retro-pending -->", author: { login: "other-app", __typename: "Bot" } }),
        aRetroNode({ number: 95, stateReason: "NOT_PLANNED", body: "failed" }),
        aRetroNode({ number: 85, state: "OPEN", stateReason: "REOPENED", body: "", author: null }),
      ],
    });

    const snapshot = await gather(github);

    expect(snapshot.retro?.issues).toEqual([
      { number: 97, title: "My retro", open: true, stateReason: null, createdAt: "2026-11-07T00:05:00Z", byApp: false, body: "Quoting <!-- fabrik:retro-pending -->" },
      { number: 96, title: "Retro: week of 2026-11-02", open: true, stateReason: null, createdAt: "2026-11-04T04:00:04Z", byApp: false, body: "<!-- fabrik:retro-pending -->" },
      { number: 95, title: "Retro: week of 2026-11-02", open: false, stateReason: "not_planned", createdAt: "2026-11-04T04:00:04Z", byApp: true, body: "failed" },
      { number: 85, title: "Retro: week of 2026-11-02", open: true, stateReason: "reopened", createdAt: "2026-11-04T04:00:04Z", byApp: false, body: "" },
    ]);
  });

  describe("holds the store as ready", () => {
    it("when the Fabrik App is on fabrik-runs and it's private", async () => {
      expect((await gather(githubWith().github, storeThatIs("private"))).retro?.storeReady).toBe(true);
    });

    it("never when it's public, since a Retro's evidence holds Product repos' issues and code", async () => {
      expect((await gather(githubWith().github, storeThatIs("public"))).retro?.storeReady).toBe(false);
    });

    it("never when the run found no Fabrik App on fabrik-runs, and so has no token to read it with", async () => {
      expect((await gather(githubWith().github, null)).retro?.storeReady).toBe(false);
    });
  });

  describe("holds whether an agent PR merged or closed since the window a Retro opened now would start", () => {
    const closed = async (options: Parameters<typeof githubWith>[0]) => (await gather(githubWith(options).github)).retro?.agentPullRequestClosed;

    it("over the 7 days before the tick on a first Retro", async () => {
      expect(await closed({ pullRequestPages: [[aClosedPullRequest("2026-10-31T04:30:00Z")]] })).toBe(true);
      expect(await closed({ pullRequestPages: [[aClosedPullRequest("2026-10-31T03:30:00Z")]] })).toBe(false);
    });

    it("since the last Retro's window end", async () => {
      expect(await closed({ retros: [aRetroNode()], pullRequestPages: [[aClosedPullRequest("2026-11-04T04:30:00Z")]] })).toBe(true);
      expect(await closed({ retros: [aRetroNode()], pullRequestPages: [[aClosedPullRequest("2026-11-04T03:30:00Z")]] })).toBe(false);
    });

    it("since the window end of the Retro before a failed one, which is never the last Retro", async () => {
      const failed = aRetroNode({ number: 85, stateReason: "NOT_PLANNED", createdAt: "2026-11-06T04:00:04Z", body: retroBody("2026-11-06T04:00:00.000Z", "failed") });

      expect(await closed({ retros: [failed, aRetroNode()], pullRequestPages: [[aClosedPullRequest("2026-11-05T04:00:00Z")]] })).toBe(true);
    });

    it("since the window end of the Fabrik App's last Retro, never a person's", async () => {
      const person = aRetroNode({ number: 86, createdAt: "2026-11-06T04:00:04Z", body: retroBody("2026-11-06T04:00:00.000Z"), author: { login: "jrey8343", __typename: "User" } });

      expect(await closed({ retros: [person, aRetroNode()], pullRequestPages: [[aClosedPullRequest("2026-11-05T04:00:00Z")]] })).toBe(true);
    });

    it("counting only agent PRs, by when they closed rather than when they were last touched", async () => {
      const window = "2026-11-02T04:00:00Z";
      const person = aClosedPullRequest(window, { headRefName: "fix-cart", author: { __typename: "User" } });
      const dependabot = aClosedPullRequest(window, { headRefName: "dependabot/npm_and_yarn/vite-7.1.0" });
      const commentedOnSince = aClosedPullRequest("2026-10-20T04:00:00Z", { updatedAt: window });

      expect(await closed({ pullRequestPages: [[person, dependabot, commentedOnSince]] })).toBe(false);
    });

    it("reading on to older pages until one reaches back past the window start", async () => {
      const others = Array.from({ length: 3 }, () => aClosedPullRequest("2026-11-06T04:00:00Z", { headRefName: "fix-cart", author: { __typename: "User" } }));

      expect(await closed({ pullRequestPages: [others, [aClosedPullRequest("2026-11-01T04:00:00Z")]] })).toBe(true);
    });
  });

  describe("holds whether the Operator filed an escape since the window a Retro opened now would start", () => {
    const filed = async (options: Parameters<typeof githubWith>[0], operator: string | null = null) =>
      (await gather(githubWith(options).github, storeThatIs("private"), operator)).retro?.escapeFiled;

    it("when an issue the Operator opened in the window has an escape marker", async () => {
      expect(await filed({ retros: [aRetroNode()], operatorIssues: [anOperatorIssue("2026-11-05T04:00:00Z")] })).toBe(true);
    });

    it("not for one with no escape marker, or opened before the window start", async () => {
      expect(await filed({ retros: [aRetroNode()], operatorIssues: [anOperatorIssue("2026-11-05T04:00:00Z", "The cart rounds wrong")] })).toBe(false);
      expect(await filed({ retros: [aRetroNode()], operatorIssues: [anOperatorIssue("2026-11-03T04:00:00Z")] })).toBe(false);
    });

    it.each([
      ["the Kit config's operator", "jrey8343", "jrey8343"],
      ["the repo's owner by default", null, "acme"],
    ])("reading only the issues %s opened", async (_, operator, login) => {
      const { github, asked } = githubWith();

      await gather(github, storeThatIs("private"), operator);

      expect(asked.filter(({ query }) => query.includes("createdBy: $operator")).map(({ variables }) => variables["operator"])).toEqual([login]);
    });
  });

  it("isn't gathered for any other event", async () => {
    const snapshot = await gatherSnapshot(githubWith().github, repo, { kind: "kit-config-changed" }, null, "fabrik-app[bot]", null, storeThatIs("private"));

    expect(snapshot.retro).toBeNull();
  });
});

const APP = { login: "fabrik-app", __typename: "Bot" };

/**
 * The answer to the retro slice's queries, which every scheduled tick asks
 * (gatherRetroSlice): no PR merged or closed, and no issue the Operator
 * opened. Undefined for any other query.
 */
function nothingNewForTheRetro(query: string): unknown {
  const none = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  if (query.includes("states: [MERGED, CLOSED]")) return { repository: { pullRequests: none } };
  if (query.includes("createdBy: $operator")) return { repository: { issues: none } };
  return undefined;
}

describe("Gathering the issues and PRs held runs are on, for a scheduled tick", () => {
  const tick = { kind: "scheduled-tick", now: "2026-11-08T04:00:00.000Z" } as const;
  const heldMarker = (issue: number, role: string, label: string | null) =>
    `<!-- fabrik:held ${JSON.stringify({ issue, role, label })} -->`;

  /** The read-only API, holding one weekly-limit issue with these comments, and these issues and PRs by number. */
  function githubWith(comments: string[], targets: Record<number, unknown>) {
    const asked: number[][] = [];
    const github = {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        if (query.includes("issueOrPullRequest")) {
          const numbers = Object.entries(variables).filter(([name]) => /^n\d+$/.test(name)).map(([, value]) => value as number);
          asked.push(numbers);
          return {
            repository: Object.fromEntries(
              Object.entries(variables)
                .filter(([name]) => /^n\d+$/.test(name))
                .map(([name, number]) => [`t${name.slice(1)}`, targets[number as number] ?? null]),
            ),
          };
        }
        if (query.includes("defaultBranchRef")) return { repository: { defaultBranchRef: null, issues: { nodes: [] } } };
        const retro = nothingNewForTheRetro(query);
        if (retro !== undefined) return retro;
        return {
          repository: {
            owner: { login: "acme" },
            issues: {
              nodes: [
                {
                  number: 41,
                  body: "<!-- fabrik:notified -->",
                  author: APP,
                  labels: { nodes: [{ name: "fabrik:weekly-limit" }] },
                  comments: { nodes: comments.map((body) => ({ body, author: APP })) },
                },
              ],
            },
          },
        };
      },
    } as unknown as GitHub;
    return { github, asked };
  }

  it("holds each issue or PR a held marker names, once, with its state, labels and whether it's a draft", async () => {
    const { github } = githubWith(
      [heldMarker(7, "triage", "needs-triage"), `${heldMarker(50, "review", "agent:review")}\n${heldMarker(7, "triage", "needs-triage")}`, heldMarker(9, "implement", "agent:implement")],
      {
        7: { __typename: "Issue", number: 7, state: "OPEN", body: "", author: { login: "jrey", __typename: "User" }, labels: { nodes: [{ name: "bug" }] } },
        50: { __typename: "PullRequest", number: 50, state: "OPEN", isDraft: true, body: "Closes #7", author: { login: "fabrik-app", __typename: "Bot" }, labels: { nodes: [] } },
      },
    );

    const snapshot = await gatherSnapshot(github, repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.held).toEqual([
      { number: 7, open: true, labels: ["bug"], draft: null, byApp: false, body: "" },
      { number: 50, open: true, labels: [], draft: true, byApp: true, body: "Closes #7" },
    ]);
  });

  it("asks nothing when no run is held", async () => {
    const { github, asked } = githubWith([], {});

    const snapshot = await gatherSnapshot(github, repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.held).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("isn't gathered for any other event", async () => {
    const { github } = githubWith([heldMarker(7, "triage", "needs-triage")], {});

    const snapshot = await gatherSnapshot(github, repo, { kind: "kit-config-changed" }, null, "fabrik-app[bot]");

    expect(snapshot.held).toBeNull();
  });
});

describe("Gathering the PRs an Auditor named", () => {
  /** The read-only API, holding Audit #97 and these PRs by number; any other number is no PR, which GitHub answers with a 404. */
  function githubWith(pulls: Record<number, unknown>) {
    return {
      async graphql(query: string): Promise<unknown> {
        if (query.includes("issue(number: $number)")) {
          return {
            repository: {
              owner: { login: "acme" },
              issue: {
                number: 97,
                state: "OPEN",
                author: { login: "fabrik-app", __typename: "Bot" },
                body: "Reading.\n\n<!-- fabrik:audit-pending -->",
                labels: { nodes: [{ name: "fabrik:audit" }] },
                parent: null,
                comments: { nodes: [] },
                timelineItems: { nodes: [] },
                closedByPullRequestsReferences: { nodes: [] },
                blockedBy: { nodes: [] },
                blocking: { nodes: [] },
              },
            },
          };
        }
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
      async rest(method: string, path: string, _body?: unknown, options: { allowNotFound?: boolean } = {}): Promise<unknown> {
        const pull = /^\/repos\/acme\/shop\/pulls\/(\d+)$/.exec(path);
        if (method !== "GET" || pull === null) throw new Error(`Unexpected call: ${method} ${path}`);
        const found = pulls[Number(pull[1])];
        if (found !== undefined) return found;
        // As the real client does: a 404 is null only when the call allows it.
        if (options.allowNotFound === true) return null;
        throw new Error(`GitHub GET ${path} failed: 404`);
      },
    } as unknown as GitHub;
  }

  const pull = (number: number, merged: boolean, ref: string, type: string) => ({ number, merged, head: { ref }, user: { type } });

  function finished(output: unknown): LoopEvent {
    return {
      kind: "audit-run-finished",
      issue: 97,
      output: typeof output === "string" ? output : JSON.stringify(output),
      window: { kind: "last-days", days: 30 },
      runUrl: "https://github.com/acme/shop/actions/runs/42/attempts/1",
      repoUrl: "https://github.com/acme/shop",
    };
  }

  const candidate = (introducedBy: number[]) => ({
    title: "Make the cart module deeper",
    files: ["src/cart.ts"],
    problem: "p",
    solution: "s",
    benefits: "b",
    before: "flowchart LR\n  a",
    after: "flowchart LR\n  b",
    strength: "strong",
    introducedBy,
  });

  it("holds each PR the reply names once, telling a merged agent PR from the rest and leaving out a number that's no PR, beside the Audit", async () => {
    const github = githubWith({
      31: pull(31, true, "fabrik/ticket-7", "Bot"),
      40: pull(40, false, "fabrik/ticket-8", "Bot"),
      41: pull(41, true, "feature/cart", "User"),
      42: pull(42, true, "fabrik/ticket-9", "User"),
    });

    const snapshot = await gatherSnapshot(
      github,
      repo,
      finished({ candidates: [candidate([31, 40, 404]), candidate([41, 42, 31])], topRecommendation: "Make the cart module deeper" }),
      null,
      "fabrik-app[bot]",
    );

    expect(snapshot.namedPullRequests).toEqual([
      { number: 31, merged: true, headRef: "fabrik/ticket-7", isAgent: true },
      { number: 40, merged: false, headRef: "fabrik/ticket-8", isAgent: true },
      { number: 41, merged: true, headRef: "feature/cart", isAgent: false },
      { number: 42, merged: true, headRef: "fabrik/ticket-9", isAgent: false },
    ]);
    expect(snapshot.issue).toMatchObject({ number: 97, byApp: true, labels: ["fabrik:audit"] });
  });

  it("holds no PRs for a reply that breaks its contract, whose Audit the core then fails", async () => {
    const github = githubWith({ 31: pull(31, true, "fabrik/ticket-7", "Bot") });

    const snapshot = await gatherSnapshot(github, repo, finished("not JSON, though it names #31"), null, "fabrik-app[bot]");

    expect(snapshot.namedPullRequests).toEqual([]);
  });

  it("isn't gathered for any other event", async () => {
    const snapshot = await gatherSnapshot(githubWith({}), repo, { kind: "kit-config-changed" }, null, "fabrik-app[bot]");

    expect(snapshot.namedPullRequests).toBeNull();
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

    const snapshot = await gatherSnapshot(github, repo, turn(7003), null, null);

    expect(snapshot.startingComment).toEqual({ id: 7003, exists: true });
    expect(reads).toEqual(["GET /repos/acme/shop/issues/comments/7003"]);
  });

  it("finds the reply gone when GitHub no longer has it", async () => {
    const { github } = githubWhere((options) => {
      expect(options.allowNotFound).toBe(true);
      return null;
    });

    const snapshot = await gatherSnapshot(github, repo, turn(7003), null, null);

    expect(snapshot.startingComment).toEqual({ id: 7003, exists: false });
  });

  it("fails, rather than calling the reply deleted, when the read itself fails", async () => {
    const { github } = githubWhere(() => {
      throw new Error("GitHub GET /repos/acme/shop/issues/comments/7003 failed: 502");
    });

    await expect(gatherSnapshot(github, repo, turn(7003), null, null)).rejects.toThrow("502");
  });

  it("reads no reply for a turn adding needs-design started", async () => {
    const { github, reads } = githubWhere(() => ({ id: 1 }));

    const snapshot = await gatherSnapshot(github, repo, turn(), null, null);

    expect(snapshot.startingComment).toBeNull();
    expect(reads).toEqual([]);
  });
});

describe("Reading the Kit config folder through the API", () => {
  it("reads the Skills sources lockfile beside config.json and each role's instructions, the Auditor's too, at the ref", async () => {
    const files: Record<string, string> = {
      ".fabrik/config.json": `{ "roles": { "review": { "skills": ["jrey8343/skills/event-storming"] } } }`,
      ".fabrik/skills.lock.json": `[{ "repository": "jrey8343/skills", "sha": "${"a".repeat(40)}" }]`,
      ".fabrik/review.md": "Check the deciders.\n",
      ".fabrik/audit.md": "Booking first.\n",
    };
    const github = {
      async fileText(at: typeof repo, path: string, ref: string): Promise<string | null> {
        expect([at, ref]).toEqual([repo, "abc123"]);
        return files[path] ?? null;
      },
    };

    const sources = await readKitConfigSources(github, repo, "abc123");

    expect(sources.skillsLock).toBe(files[".fabrik/skills.lock.json"]);
    const result = resolveKitConfig(sources);
    expect(result.ok && result.config.extraSkills.review).toEqual([{ source: "jrey8343/skills", name: "event-storming" }]);
    expect(result.ok && result.config.instructions.review).toBe("Check the deciders.\n");
    expect(result.ok && result.config.instructions.audit).toBe("Booking first.\n");
  });

  it("gives no lockfile when the Product repo has none", async () => {
    const sources = await readKitConfigSources({ fileText: async () => null }, repo, "abc123");

    expect(sources.skillsLock).toBeNull();
  });
});

describe("Gathering the Kit-owned issues, whose markers steer agent runs (ADR-0007)", () => {
  const PERSON = { login: "mallory", __typename: "User" };
  const OTHER_BOT = { login: "other-app", __typename: "Bot" };
  const tick = { kind: "scheduled-tick", now: "2026-11-08T04:00:00.000Z" } as const;
  const heldMarker = (issue: number) => `<!-- fabrik:held ${JSON.stringify({ issue, role: "implement", label: "agent:implement" })} -->`;
  type Author = { login: string; __typename: string } | null;
  interface Comment {
    body: string;
    author: Author;
  }

  /**
   * The read-only API, holding one weekly-limit issue opened by `author` with
   * these comments, which it serves 100 at a time, newest page first, as
   * GitHub's `comments(last:, before:)` does.
   */
  function githubWith(author: Author, comments: readonly Comment[]) {
    const asked: number[] = [];
    const page = (before: number) => {
      const start = Math.max(0, before - 100);
      return {
        pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
        nodes: comments.slice(start, before),
      };
    };
    const github = {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        if (query.includes("issueOrPullRequest")) {
          const numbers = Object.entries(variables).filter(([name]) => /^n\d+$/.test(name)).map(([, value]) => value as number);
          asked.push(...numbers);
          return { repository: {} };
        }
        if (query.includes("defaultBranchRef")) return { repository: { defaultBranchRef: null, issues: { nodes: [] } } };
        if (query.includes("before: $before")) {
          return { repository: { issue: { comments: page(Number(variables["before"])) } } };
        }
        const retro = nothingNewForTheRetro(query);
        if (retro !== undefined) return retro;
        return {
          repository: {
            owner: { login: "acme" },
            issues: {
              nodes: [
                {
                  number: 41,
                  body: "@jrey The weekly usage limit is reached.\n\n<!-- fabrik:notified -->",
                  author,
                  labels: { nodes: [{ name: "fabrik:weekly-limit" }] },
                  comments: page(comments.length),
                },
              ],
            },
          },
        };
      },
    } as unknown as GitHub;
    return { github, asked };
  }

  it("reads only the App's own comments, so a held marker someone else posts holds no run", async () => {
    const { github, asked } = githubWith(APP, [
      { body: heldMarker(7), author: APP },
      { body: heldMarker(8), author: PERSON },
      { body: heldMarker(9), author: OTHER_BOT },
      { body: heldMarker(10), author: null },
    ]);

    const snapshot = await gatherSnapshot(github, repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.kitIssues.map((issue) => issue.comments)).toEqual([[heldMarker(7)]]);
    expect(asked).toEqual([7]);
  });

  it("reads no body from a Kit-labelled issue the App didn't open", async () => {
    const { github } = githubWith(PERSON, []);

    const snapshot = await gatherSnapshot(github, repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.kitIssues).toEqual([{ number: 41, labels: ["fabrik:weekly-limit"], body: "", comments: [] }]);
  });

  it("reads every comment, however many there are, so the oldest held markers aren't cut off", async () => {
    const comments = Array.from({ length: 250 }, (_, at) => ({ body: heldMarker(at + 1), author: APP }));
    const { github } = githubWith(APP, comments);

    const snapshot = await gatherSnapshot(github, repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.kitIssues[0]?.comments).toEqual(comments.map((comment) => comment.body));
  });
});
