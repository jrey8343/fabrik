import { describe, expect, it } from "vitest";
import { gatherGitHubFacts, productReposOf } from "./facts.ts";

const CALLER = "jobs:\n  fabrik:\n    uses: jrey8343/fabrik/.github/workflows/loop.yml@v1.2.0\n";

/** A read-only installation holding these repos, each with its files on its default branch. */
function installationWith(repos: { fullName: string; files?: Record<string, string> }[], pageSize = 100) {
  return {
    async rest(method: string, path: string): Promise<unknown> {
      expect(method).toBe("GET");
      const listed = /^\/installation\/repositories\?per_page=100&page=(\d+)$/.exec(path);
      if (listed === null) throw new Error(`Unexpected call: ${path}`);
      const page = Number(listed[1]);
      return {
        total_count: repos.length,
        repositories: repos.slice((page - 1) * pageSize, page * pageSize).map(({ fullName }) => ({
          full_name: fullName,
          name: fullName.split("/")[1],
          owner: { login: fullName.split("/")[0] },
          default_branch: "main",
        })),
      };
    },
    async fileText(repo: { owner: string; name: string }, path: string, ref: string): Promise<string | null> {
      expect(ref).toBe("main");
      return repos.find((r) => r.fullName === `${repo.owner}/${repo.name}`)?.files?.[path] ?? null;
    },
  };
}

describe("Finding the Product repos the Weekly summary covers", () => {
  it("is every repo in the Fabrik App's installation with the Kit's caller workflow", async () => {
    const github = installationWith([
      { fullName: "jrey8343/shop", files: { ".github/workflows/fabrik.yml": CALLER } },
      { fullName: "jrey8343/notes" },
      { fullName: "jrey8343/blog", files: { ".github/workflows/fabrik.yml": "name: Something else\n" } },
    ]);

    expect(await productReposOf(github)).toEqual([{ owner: "jrey8343", name: "shop" }]);
  });

  it("leaves out fabrik-runs, the store itself", async () => {
    const github = installationWith([
      { fullName: "jrey8343/fabrik-runs", files: { ".github/workflows/fabrik.yml": CALLER } },
      { fullName: "jrey8343/shop", files: { ".github/workflows/fabrik.yml": CALLER } },
    ]);

    expect(await productReposOf(github)).toEqual([{ owner: "jrey8343", name: "shop" }]);
  });

  it("reads every page of the installation's repos", async () => {
    const github = installationWith(
      [
        { fullName: "jrey8343/a", files: { ".github/workflows/fabrik.yml": CALLER } },
        { fullName: "jrey8343/b" },
        { fullName: "jrey8343/c", files: { ".github/workflows/fabrik.yml": CALLER } },
      ],
      2,
    );

    expect(await productReposOf(github)).toEqual([
      { owner: "jrey8343", name: "a" },
      { owner: "jrey8343", name: "c" },
    ]);
  });
});

const repo = { owner: "jrey8343", name: "shop" };
const NOW = Date.parse("2026-11-08T20:00:00Z");
const APP = { __typename: "Bot", login: "fabrik-app" };
const OPERATOR = { __typename: "User", login: "jrey8343" };

/** What a repo holds on GitHub, as the facts queries read it, with nothing unless a test says so. */
interface RawRepo {
  closedPullRequests?: unknown[];
  openPullRequests?: unknown[];
  updatedIssues?: unknown[];
  openIssues?: unknown[];
  defaultBranchCommits?: unknown[];
  needsDesignIssues?: unknown[];
}

/** A read-only GraphQL API over `raw`, answering each facts query with one page. */
function repoWith(raw: RawRepo) {
  const page = (nodes: unknown[] = []) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
  return {
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      expect(variables).toMatchObject({ owner: "jrey8343", name: "shop" });
      const answer = (data: unknown) => data as T;
      if (query.includes("history(")) return answer({ repository: { defaultBranchRef: { target: { history: page(raw.defaultBranchCommits) } } } });
      if (query.includes("pullRequests(states: [MERGED, CLOSED]")) return answer({ repository: { pullRequests: page(raw.closedPullRequests) } });
      if (query.includes("pullRequests(states: OPEN")) return answer({ repository: { pullRequests: page(raw.openPullRequests) } });
      if (query.includes("labels: [$needsDesign]")) {
        expect(variables["needsDesign"]).toBe("needs-design");
        return answer({ repository: { owner: { login: "jrey8343" }, issues: page(raw.needsDesignIssues) } });
      }
      if (query.includes("filterBy: { since: $since }")) return answer({ repository: { issues: page(raw.updatedIssues) } });
      if (query.includes("issues(states: OPEN")) return answer({ repository: { issues: page(raw.openIssues) } });
      throw new Error(`Unexpected query: ${query}`);
    },
  };
}

/** Agent PR 50, the Fabrik App's from Ticket 7's branch, closing #7, merged on 2026-11-04 as `c…c`. */
function aRawPullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 50,
    title: "Build the thing",
    state: "MERGED",
    mergedAt: "2026-11-04T00:00:00Z",
    closedAt: "2026-11-04T00:00:00Z",
    updatedAt: "2026-11-04T00:00:00Z",
    headRefName: "fabrik/ticket-7",
    author: APP,
    mergeCommit: { oid: "c".repeat(40) },
    closingIssuesReferences: { nodes: [{ number: 7 }] },
    commits: { nodes: [] },
    reviews: { nodes: [] },
    comments: { nodes: [] },
    timelineItems: { nodes: [] },
    ...overrides,
  };
}

function aRawLabelEvent(label: string, createdAt: string, actor: unknown = APP, kind = "LabeledEvent") {
  return { __typename: kind, createdAt, actor, label: { name: label } };
}

describe("Gathering a Product repo's GitHub facts", () => {
  it("holds each agent PR merged or closed in the window, with its Ticket from Closes #n, merge time and sha", async () => {
    const github = repoWith({
      closedPullRequests: [
        aRawPullRequest(),
        aRawPullRequest({ number: 51, state: "CLOSED", mergedAt: null, mergeCommit: null, closingIssuesReferences: { nodes: [] } }),
      ],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW);

    expect(facts.repo).toBe("jrey8343/shop");
    expect(facts.pullRequests.map(({ number, ticket, title, mergedAt, mergeSha }) => ({ number, ticket, title, mergedAt, mergeSha }))).toEqual([
      { number: 50, ticket: 7, title: "Build the thing", mergedAt: "2026-11-04T00:00:00Z", mergeSha: "c".repeat(40) },
      { number: 51, ticket: null, title: "Build the thing", mergedAt: null, mergeSha: null },
    ]);
  });

  it("leaves out a PR that isn't an agent PR, but keeps its merged title for spotting reverts", async () => {
    const github = repoWith({
      closedPullRequests: [aRawPullRequest({ number: 60, title: 'Revert "Build the thing"', headRefName: "revert-50", author: OPERATOR })],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW);

    expect(facts.pullRequests).toEqual([]);
    expect(facts.mergedPullRequestTitles).toEqual([{ title: 'Revert "Build the thing"', mergedAt: "2026-11-04T00:00:00Z" }]);
  });

  it("covers 37 days, so last week's 30-day revert window is whole", async () => {
    const github = repoWith({
      closedPullRequests: [
        aRawPullRequest({ number: 50, mergedAt: "2026-10-03T00:00:00Z", closedAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" }),
        aRawPullRequest({ number: 49, mergedAt: "2026-09-30T00:00:00Z", closedAt: "2026-09-30T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" }),
      ],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW);

    expect(facts.pullRequests.map((pr) => pr.number)).toEqual([50]);
  });

  it("tells the Implementer's commits from a person's push, and reads the PR's reviews, comments and labels", async () => {
    const github = repoWith({
      closedPullRequests: [
        aRawPullRequest({
          commits: {
            nodes: [
              { commit: { committedDate: "2026-11-02T00:00:00Z", author: { email: "fabrik-implementer@users.noreply.github.com" } } },
              { commit: { committedDate: "2026-11-03T00:00:00Z", author: { email: "jared@example.com" } } },
            ],
          },
          reviews: {
            nodes: [
              { author: OPERATOR, state: "CHANGES_REQUESTED", submittedAt: "2026-11-03T01:00:00Z" },
              { author: OPERATOR, state: "PENDING", submittedAt: null },
            ],
          },
          comments: { nodes: [{ body: "Verdict", createdAt: "2026-11-03T02:00:00Z", author: APP }] },
          timelineItems: {
            nodes: [
              aRawLabelEvent("agent:review", "2026-11-03T03:00:00Z", OPERATOR),
              aRawLabelEvent("agent:review", "2026-11-03T04:00:00Z", APP, "UnlabeledEvent"),
            ],
          },
        }),
      ],
    });

    const [pullRequest] = (await gatherGitHubFacts(github, repo, NOW)).pullRequests;

    expect(pullRequest?.commits).toEqual([
      { byApp: true, at: "2026-11-02T00:00:00Z" },
      { byApp: false, at: "2026-11-03T00:00:00Z" },
    ]);
    expect(pullRequest?.reviews).toEqual([{ author: "jrey8343", state: "changes-requested", at: "2026-11-03T01:00:00Z" }]);
    expect(pullRequest?.comments).toEqual([{ author: "fabrik-app[bot]", byBot: true, body: "Verdict", at: "2026-11-03T02:00:00Z" }]);
    expect(pullRequest?.labelEvents).toEqual([
      { label: "agent:review", action: "labeled", actor: "jrey8343", at: "2026-11-03T03:00:00Z" },
      { label: "agent:review", action: "unlabeled", actor: "fabrik-app[bot]", at: "2026-11-03T04:00:00Z" },
    ]);
  });

  it("holds every issue that moved in the window or is still open as a Ticket, and those with sub-issues as Specs", async () => {
    const github = repoWith({
      updatedIssues: [
        aRawIssue({
          number: 7,
          state: "CLOSED",
          closedAt: "2026-11-04T00:00:00Z",
          timelineItems: { nodes: [aRawLabelEvent("agent:implement", "2026-11-02T00:00:00Z")] },
          blockedBy: { nodes: [{ number: 5, labels: { nodes: [{ name: "ready-for-human" }] } }] },
        }),
        aRawIssue({ number: 3, subIssues: { nodes: [{ number: 7 }, { number: 8 }] } }),
      ],
      openIssues: [aRawIssue({ number: 3, subIssues: { nodes: [{ number: 7 }, { number: 8 }] } }), aRawIssue({ number: 1 })],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW);

    expect(facts.tickets).toEqual([
      {
        number: 7,
        labelEvents: [{ label: "agent:implement", action: "labeled", actor: "fabrik-app[bot]", at: "2026-11-02T00:00:00Z" }],
        blockedBy: [{ number: 5, labels: ["ready-for-human"] }],
        closedAt: "2026-11-04T00:00:00Z",
      },
      { number: 3, labelEvents: [], blockedBy: [], closedAt: null },
      { number: 1, labelEvents: [], blockedBy: [], closedAt: null },
    ]);
    expect(facts.specs).toEqual([{ number: 3, labelEvents: [], tickets: [7, 8] }]);
  });

  it("holds every open issue, however long it has sat, with its labels and comments", async () => {
    const github = repoWith({
      openIssues: [
        aRawIssue({
          number: 12,
          title: "Which way?",
          createdAt: "2025-01-01T00:00:00Z",
          labels: { nodes: [{ name: "needs-info" }] },
          comments: {
            nodes: [
              { body: "A question", createdAt: "2026-11-01T00:00:00Z", author: APP },
              { body: "An answer", createdAt: "2026-11-02T00:00:00Z", author: null },
            ],
          },
        }),
      ],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW);

    expect(facts.openIssues).toEqual([
      {
        number: 12,
        title: "Which way?",
        labels: ["needs-info"],
        createdAt: "2025-01-01T00:00:00Z",
        comments: [
          { author: "fabrik-app[bot]", byBot: true, body: "A question", at: "2026-11-01T00:00:00Z" },
          { author: "ghost", byBot: false, body: "An answer", at: "2026-11-02T00:00:00Z" },
        ],
        labelEvents: [],
      },
    ]);
  });

  it("holds the open agent PRs alone, with their head, draft state and activity", async () => {
    const github = repoWith({
      openPullRequests: [
        {
          number: 50,
          title: "Build the thing",
          isDraft: true,
          headRefOid: "h".repeat(40),
          headRefName: "fabrik/ticket-7",
          createdAt: "2026-11-01T00:00:00Z",
          author: APP,
          commits: { nodes: [{ commit: { committedDate: "2026-11-02T00:00:00Z" } }] },
          comments: { nodes: [] },
          timelineItems: { nodes: [] },
        },
        {
          number: 52,
          title: "A person's PR",
          isDraft: false,
          headRefOid: "a".repeat(40),
          headRefName: "fabrik/ticket-9",
          createdAt: "2026-11-01T00:00:00Z",
          author: OPERATOR,
          commits: { nodes: [] },
          comments: { nodes: [] },
          timelineItems: { nodes: [] },
        },
      ],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW);

    expect(facts.openPullRequests).toEqual([
      {
        number: 50,
        title: "Build the thing",
        draft: true,
        headSha: "h".repeat(40),
        createdAt: "2026-11-01T00:00:00Z",
        commits: [{ at: "2026-11-02T00:00:00Z" }],
        comments: [],
        labelEvents: [],
      },
    ]);
  });

  it("holds the open needs-design issues as the Design queue check reads them, so Held tells waiting from slot-holding", async () => {
    const github = repoWith({
      needsDesignIssues: [
        // Waiting: no round, no failure, no turn.
        aRawNeedsDesignIssue(3),
        // A round posted: holds a slot.
        aRawNeedsDesignIssue(4, {
          comments: { nodes: [{ body: "<!-- fabrik:design-round 1 -->\nRound 1.", createdAt: "2026-11-02T09:00:00Z", author: { __typename: "Bot" } }] },
        }),
        // Its first turn claimed: the Kit took agent:design off after needs-design.
        aRawNeedsDesignIssue(5, {
          timelineItems: {
            nodes: [
              { __typename: "LabeledEvent", createdAt: "2026-11-03T09:00:00Z", label: { name: "needs-design" } },
              { __typename: "UnlabeledEvent", createdAt: "2026-11-03T09:01:00Z", label: { name: "agent:design" }, actor: { __typename: "Bot" } },
            ],
          },
        }),
      ],
    });

    const { designQueue } = await gatherGitHubFacts(github, repo, NOW);

    expect(designQueue).toEqual({
      issues: [
        { number: 3, labels: ["needs-design"], designRounds: 0, turnFailed: false, redesign: false, neededDesignAt: "2026-11-01T09:00:00Z" },
        { number: 4, labels: ["needs-design"], designRounds: 1, turnFailed: false, redesign: false, neededDesignAt: "2026-11-01T09:00:00Z" },
        { number: 5, labels: ["needs-design"], designRounds: 0, turnFailed: false, redesign: false, neededDesignAt: "2026-11-03T09:00:00Z" },
      ],
      // Read from the issues, as the scheduled tick reads them: the summary's token can't read workflow runs.
      designTurnsInProgress: [5],
    });
  });

  it("holds the default branch's commit messages in the window", async () => {
    const github = repoWith({
      defaultBranchCommits: [{ message: `Revert "Build the thing"\n\nThis reverts commit ${"c".repeat(40)}.`, committedDate: "2026-11-05T00:00:00Z" }],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW);

    expect(facts.defaultBranchCommits).toEqual([
      { message: `Revert "Build the thing"\n\nThis reverts commit ${"c".repeat(40)}.`, at: "2026-11-05T00:00:00Z" },
    ]);
  });
});

/** Open needs-design issue `number`, opened on 2026-10-01, which got needs-design on 2026-11-01. */
function aRawNeedsDesignIssue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    createdAt: "2026-10-01T09:00:00Z",
    labels: { nodes: [{ name: "needs-design" }] },
    comments: { nodes: [] },
    timelineItems: { nodes: [{ __typename: "LabeledEvent", createdAt: "2026-11-01T09:00:00Z", label: { name: "needs-design" } }] },
    ...overrides,
  };
}

/** Issue 7, open since 2026-10-01, with nothing on it unless a test says so. */
function aRawIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: "A Ticket",
    state: "OPEN",
    createdAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    labels: { nodes: [] },
    comments: { nodes: [] },
    timelineItems: { nodes: [] },
    blockedBy: { nodes: [] },
    subIssues: { nodes: [] },
    ...overrides,
  };
}
