import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { GitHub } from "./client.ts";
import { anIssue, aPullRequest, AUDITED_SHA, auditBody, designQueueSnapshotOf, HEAD_SHA, kitConfig, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { DEFAULT_KIT_CONFIG, resolveKitConfig } from "../kit/config.ts";
import { JUDGE_JOB } from "../kit/judge.ts";
import { holdsSlot } from "../loop/designQueue.ts";
import { DESIGN_TURN_FAILED_MARKER } from "../loop/markers.ts";
import { planFor } from "../loop/rules.ts";
import type { DesignQueueSnapshot, LoopEvent, Plan } from "../loop/types.ts";
import { countImplementRuns, DESIGN_JOB_NAME, designTurnsInProgress, gatherSnapshot, IMPLEMENT_JOB_NAME, readKitConfigSources } from "./snapshot.ts";

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

describe("The judge job's name", () => {
  // #149: scoring never takes a Dispatch slot, nor a Design session slot.
  it("is never counted as an Implement run or a Design-session turn in flight while it scores a run", async () => {
    const workflow = await readFile(new URL("../../.github/workflows/loop.yml", import.meta.url), "utf8");
    const judgeJob = new RegExp(`^ {2}${JUDGE_JOB}:\n {4}name: (.+)$`, "m").exec(workflow)?.[1];
    expect(judgeJob).toBeDefined();
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "completed" }, { name: `fabrik / ${judgeJob}`, status: "in_progress" }] },
      { id: 2, status: "queued", jobs: [{ name: `fabrik / ${judgeJob}`, status: "queued" }] },
    ]);

    expect(await countImplementRuns(actions, repo)).toBe(0);
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

/** The issue a Loop event is about, as GitHub holds it: opened by `author`, with this body and these labels. */
function issueGitHub({
  author = { login: "someone", __typename: "User" },
  body = "",
  labels = ["needs-design"],
}: { author?: { login: string; __typename: string } | null; body?: string; labels?: string[] } = {}): GitHub {
  return {
    async graphql(query: string): Promise<unknown> {
      if (!query.includes("issue(number: $number)")) return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      // GitHub answers only the fields the query selects.
      const issueQuery = query.slice(query.indexOf("issue(number: $number)"));
      const selectsType = /^\s*author \{[^}]*__typename/m.test(issueQuery);
      return {
        repository: {
          owner: { login: "acme" },
          issue: {
            number: 98,
            state: "OPEN",
            author: author === null || selectsType ? author : { login: author.login },
            ...(/^\s*body$/m.test(issueQuery) ? { body } : {}),
            labels: { nodes: labels.map((name) => ({ name })) },
            parent: null,
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

describe("Gathering an issue's body", () => {
  it("holds the body as it stands, so a Design session's rewrite can keep its Monitor marker and carry its marker lines forward", async () => {
    const body = "<!-- fabrik:monitor sentry:4504 -->\n## Production error\n\nFrom audit #40\n<!-- fabrik:escape strong #31 -->";
    const event = { kind: "label-added", issue: 98, label: "needs-design" } as const;

    const snapshot = await gatherSnapshot(issueGitHub({ author: APP_BOT, body }), repo, event, null, APP_LOGIN);

    expect(snapshot.issue?.body).toBe(body);
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

    const snapshot = await gatherSnapshot(github, repo, { kind: "dispatch-check" }, null, null, actionsWith([]) as unknown as GitHub);

    expect(snapshot.dispatch?.tickets).toMatchObject([{ number: 6, openBlockers: [10], notPlannedBlockers: [9] }]);
  });
});

describe("Gathering a scheduled tick's audit slice", () => {
  const HEAD = "c".repeat(40);

  /** The read-only API, holding this default branch head and these `fabrik:audit` issues, newest first. */
  function githubWith(defaultBranchRef: { target: { oid: string } } | null, nodes: unknown[]) {
    return {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        if (query.includes("defaultBranchRef")) {
          expect(variables["label"]).toBe("fabrik:audit");
          return { repository: { defaultBranchRef, issues: { nodes } } };
        }
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
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

const APP = { login: "fabrik-app", __typename: "Bot" };

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
