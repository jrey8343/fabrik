import { describe, expect, it } from "vitest";
import { GitHubError } from "./client.ts";
import { gatherEveryRepoFacts, gatherGitHubFacts, gatherHeadChecks, gatherOpenIssuesOn, gatherRetroFacts, gatherTickets, productReposOf } from "./facts.ts";

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
  /** The open issues with the fabrik:monitor label. */
  monitorIssues?: unknown[];
  /** The issues the Operator opened, newest first. */
  operatorIssues?: unknown[];
  /** The open issues with the fabrik:audit label. */
  openAudits?: unknown[];
  /** The open issues with the fabrik:retro label. */
  openRetros?: unknown[];
  /** The newest fabrik:audit issues, open and closed, as the audit gate reads them. */
  audits?: unknown[];
  /** The newest fabrik:retro issues, open and closed, as the retro gate reads them. */
  retros?: unknown[];
  /** The open issues with the wayfinder:map label. */
  openMaps?: unknown[];
  /** The open issues with the fabrik:replay label. */
  openReplays?: unknown[];
  /** The open issues with a Kit-owned label. */
  kitIssues?: unknown[];
  /** The weekly-limit, usage-credits and token-rotation issues, open or closed, updated since the `since` the read asks for. */
  weekCarriers?: unknown[];
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
      if (query.includes("labels: [$monitor]")) {
        expect(variables["monitor"]).toBe("fabrik:monitor");
        return answer({ repository: { issues: page(raw.monitorIssues) } });
      }
      if (query.includes("labels: [$map]")) {
        expect(variables["map"]).toBe("wayfinder:map");
        return answer({ repository: { issues: page(raw.openMaps) } });
      }
      if (query.includes("labels: [$replay]")) {
        expect(variables["replay"]).toBe("fabrik:replay");
        expect(query).toContain("issues(states: OPEN, labels: [$replay]");
        return answer({ repository: { issues: page(raw.openReplays) } });
      }
      if (query.includes("issues(states: [OPEN, CLOSED], labels: $labels, filterBy: { since: $since }")) {
        expect(variables["labels"]).toEqual(["fabrik:weekly-limit", "fabrik:usage-credits", "fabrik:token-rotation"]);
        expect(variables["since"]).toBe("2026-10-25T20:00:00.000Z");
        return answer({ repository: { issues: page(raw.weekCarriers) } });
      }
      if (query.includes("labels: $labels")) {
        expect(variables["labels"]).toContain("fabrik:weekly-limit");
        return answer({ repository: { owner: { login: "jrey8343" }, issues: { nodes: raw.kitIssues ?? [] } } });
      }
      if (query.includes("issues(labels: [$label], states: [OPEN, CLOSED]")) {
        const weekly = (nodes: unknown[] = []) => answer({ repository: { defaultBranchRef: null, issues: { nodes } } });
        if (variables["label"] === "fabrik:audit") return weekly(raw.audits);
        if (variables["label"] === "fabrik:retro") return weekly(raw.retros);
        throw new Error(`Unexpected label: ${String(variables["label"])}`);
      }
      if (query.includes("labels: [$label]")) {
        if (variables["label"] === "fabrik:audit") return answer({ repository: { issues: page(raw.openAudits) } });
        if (variables["label"] === "fabrik:retro") return answer({ repository: { issues: page(raw.openRetros) } });
        throw new Error(`Unexpected label: ${String(variables["label"])}`);
      }
      if (query.includes("filterBy: { createdBy: $operator }")) {
        expect(variables["operator"]).toBe("jrey8343");
        // GitHub answers only the fields the query selects.
        const selectsTitle = /nodes \{[^}]*\btitle\b/.test(query);
        const issues = (raw.operatorIssues ?? []) as Record<string, unknown>[];
        return answer({ repository: { issues: page(issues.map(({ title, ...issue }) => (selectsTitle ? { title, ...issue } : issue))) } });
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
    files: { nodes: [] },
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

    const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(facts.repo).toBe("jrey8343/shop");
    expect(facts.pullRequests.map(({ number, ticket, title, mergedAt, mergeSha }) => ({ number, ticket, title, mergedAt, mergeSha }))).toEqual([
      { number: 50, ticket: 7, title: "Build the thing", mergedAt: "2026-11-04T00:00:00Z", mergeSha: "c".repeat(40) },
      { number: 51, ticket: null, title: "Build the thing", mergedAt: null, mergeSha: null },
    ]);
  });

  it("holds the paths each agent PR changed", async () => {
    const github = repoWith({
      closedPullRequests: [aRawPullRequest({ files: { nodes: [{ path: "src/cart.ts" }, { path: "src/cart.test.ts" }] } })],
    });

    const [pullRequest] = (await gatherGitHubFacts(github, repo, NOW, OPERATOR.login)).pullRequests;

    expect(pullRequest?.changedPaths).toEqual(["src/cart.ts", "src/cart.test.ts"]);
  });

  it("leaves out a PR that isn't an agent PR, but keeps its merged title for spotting reverts", async () => {
    const github = repoWith({
      closedPullRequests: [aRawPullRequest({ number: 60, title: 'Revert "Build the thing"', headRefName: "revert-50", author: OPERATOR })],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(facts.pullRequests).toEqual([]);
    expect(facts.mergedPullRequestTitles).toEqual([{ title: 'Revert "Build the thing"', mergedAt: "2026-11-04T00:00:00Z" }]);
  });

  it("covers 97 days of PRs, so last week's 90-day escape window is whole", async () => {
    const github = repoWith({
      closedPullRequests: [
        aRawPullRequest({ number: 50, mergedAt: "2026-08-04T00:00:00Z", closedAt: "2026-08-04T00:00:00Z", updatedAt: "2026-08-04T00:00:00Z" }),
        aRawPullRequest({ number: 49, mergedAt: "2026-08-03T00:00:00Z", closedAt: "2026-08-03T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" }),
      ],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(facts.pullRequests.map((pr) => pr.number)).toEqual([50]);
  });

  it("tells the Implementer's commits from a person's push, and reads the PR's reviews, comments and labels", async () => {
    const github = repoWith({
      closedPullRequests: [
        aRawPullRequest({
          commits: {
            nodes: [
              aRawCommit("1", "2026-11-02T00:00:00Z", "Build the thing", { email: "fabrik-implementer@users.noreply.github.com", user: null }),
              aRawCommit("2", "2026-11-03T00:00:00Z", "Move pricing out", { email: "jared@example.com", user: { login: "jrey8343" } }),
              aRawCommit("3", "2026-11-03T00:05:00Z", "From a laptop", { email: "jared@laptop.local", user: null }),
            ],
          },
          reviews: {
            nodes: [
              {
                author: OPERATOR,
                state: "CHANGES_REQUESTED",
                submittedAt: "2026-11-03T01:00:00Z",
                body: "Keep pricing out of the cart.",
                comments: {
                  nodes: [
                    { path: "src/cart.ts", line: 12, body: "This belongs in pricing." },
                    { path: "src/cart.ts", line: null, body: "On a line since changed." },
                  ],
                },
              },
              { author: OPERATOR, state: "PENDING", submittedAt: null, body: "", comments: { nodes: [] } },
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

    const [pullRequest] = (await gatherGitHubFacts(github, repo, NOW, OPERATOR.login)).pullRequests;

    expect(pullRequest?.commits).toEqual([
      { sha: "1".repeat(40), byApp: true, author: "ghost", message: "Build the thing", patch: null, at: "2026-11-02T00:00:00Z" },
      { sha: "2".repeat(40), byApp: false, author: "jrey8343", message: "Move pricing out", patch: null, at: "2026-11-03T00:00:00Z" },
      { sha: "3".repeat(40), byApp: false, author: "ghost", message: "From a laptop", patch: null, at: "2026-11-03T00:05:00Z" },
    ]);
    expect(pullRequest?.reviews).toEqual([
      {
        author: "jrey8343",
        state: "changes-requested",
        body: "Keep pricing out of the cart.",
        comments: [
          { path: "src/cart.ts", line: 12, body: "This belongs in pricing." },
          { path: "src/cart.ts", line: null, body: "On a line since changed." },
        ],
        at: "2026-11-03T01:00:00Z",
      },
    ]);
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

    const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

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

  it("holds every open issue, however long it has sat, with who opened it, its labels and comments", async () => {
    const github = repoWith({
      openIssues: [
        aRawIssue({
          number: 12,
          title: "Which way?",
          author: APP,
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

    const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(facts.openIssues).toEqual([
      {
        number: 12,
        title: "Which way?",
        author: "fabrik-app[bot]",
        labels: ["needs-info"],
        createdAt: "2025-01-01T00:00:00Z",
        comments: [
          { author: "fabrik-app[bot]", byBot: true, body: "A question", at: "2026-11-01T00:00:00Z" },
          { author: "ghost", byBot: false, body: "An answer", at: "2026-11-02T00:00:00Z" },
        ],
        labelEvents: [],
        subIssues: [],
      },
    ]);
  });

  it("holds each open issue's sub-issues, open or closed, so the summary finds a Map's Decisions", async () => {
    const github = repoWith({
      openIssues: [
        aRawIssue({ number: 30, labels: { nodes: [{ name: "wayfinder:map" }] }, subIssues: { nodes: [{ number: 31 }, { number: 32 }] } }),
        aRawIssue({ number: 31, labels: { nodes: [{ name: "wayfinder:grilling" }] } }),
      ],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(facts.openIssues.map(({ number, subIssues }) => [number, subIssues])).toEqual([
      [30, [31, 32]],
      [31, []],
    ]);
  });

  describe("an open Plain pull request", () => {
    /** Open PR `number`, on `headRefName`, by `author`, out of draft, merging cleanly, closing nothing. */
    const anOpenRawPullRequest = (number: number, headRefName: string, author: unknown, overrides: Record<string, unknown> = {}) => ({
      number,
      title: `PR ${number}`,
      isDraft: false,
      headRefOid: String(number % 10).repeat(40),
      headRefName,
      createdAt: "2026-11-01T00:00:00Z",
      mergeable: "MERGEABLE",
      author,
      closingIssuesReferences: { nodes: [] },
      commits: { nodes: [] },
      reviews: { nodes: [] },
      comments: { nodes: [] },
      timelineItems: { nodes: [] },
      draftEvents: { nodes: [] },
      ...overrides,
    });
    const DEPENDABOT = { __typename: "Bot", login: "dependabot" };

    it("is kept for every open PR that is no agent PR, whoever opened it, with who opened it, its branch and head, whether it is a draft, whether it merges cleanly, when it last went into draft or out of it, and every issue it closes", async () => {
      const github = repoWith({
        openPullRequests: [
          anOpenRawPullRequest(50, "fabrik/ticket-7", APP, { closingIssuesReferences: { nodes: [{ number: 7 }] } }),
          anOpenRawPullRequest(71, "dependabot/github_actions/fabrik-d03f57835c", DEPENDABOT, {
            mergeable: "CONFLICTING",
            commits: { nodes: [aRawCommit("8", "2026-11-02T00:00:00Z", "fabrik: bump", { email: "support@github.com", user: null }), aRawCommit("1", "2026-11-03T00:00:00Z", "fabrik: bump", { email: "support@github.com", user: null })] },
          }),
          anOpenRawPullRequest(72, "fabrik/pair-12", OPERATOR, {
            isDraft: true,
            mergeable: "UNKNOWN",
            closingIssuesReferences: { nodes: [{ number: 5 }, { number: 12 }] },
            draftEvents: {
              nodes: [
                { __typename: "ConvertToDraftEvent", createdAt: "2026-11-04T00:00:00Z", actor: OPERATOR },
                { __typename: "ReadyForReviewEvent", createdAt: "2026-11-03T00:00:00Z", actor: OPERATOR },
              ],
            },
          }),
          // The Operator's own PR from an agent branch is no agent PR: only the Fabrik App opens one.
          anOpenRawPullRequest(73, "fabrik/ticket-9", OPERATOR),
        ],
      });

      const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

      expect(facts.plainPullRequests).toEqual([
        {
          number: 71,
          title: "PR 71",
          author: "dependabot[bot]",
          headRef: "dependabot/github_actions/fabrik-d03f57835c",
          headSha: "1".repeat(40),
          headCommittedAt: "2026-11-03T00:00:00Z",
          draft: false,
          mergeable: false,
          closes: [],
          draftChangedAt: null,
          createdAt: "2026-11-01T00:00:00Z",
        },
        {
          number: 72,
          title: "PR 72",
          author: "jrey8343",
          headRef: "fabrik/pair-12",
          headSha: "2".repeat(40),
          headCommittedAt: null,
          draft: true,
          mergeable: null,
          closes: [5, 12],
          draftChangedAt: "2026-11-04T00:00:00Z",
          createdAt: "2026-11-01T00:00:00Z",
        },
        expect.objectContaining({ number: 73, author: "jrey8343", headRef: "fabrik/ticket-9", mergeable: true }),
      ]);
      // The metrics read agent PRs alone.
      expect(facts.openPullRequests.map(({ number }) => number)).toEqual([50]);
    });

    it("keeps none of its reviews, labels or comments, so a Request changes, needs-design or a comment on one changes nothing", async () => {
      const plain = anOpenRawPullRequest(74, "fix-typo", OPERATOR);
      const touched = {
        ...plain,
        reviews: { nodes: [{ author: OPERATOR, state: "CHANGES_REQUESTED", submittedAt: "2026-11-02T01:00:00Z", body: "Not yet.", comments: { nodes: [] } }] },
        comments: { nodes: [{ author: OPERATOR, body: "What about this?", createdAt: "2026-11-02T02:00:00Z" }] },
        timelineItems: { nodes: [aRawLabelEvent("needs-design", "2026-11-02T03:00:00Z", OPERATOR)] },
      };

      const [before, after] = await Promise.all([
        gatherGitHubFacts(repoWith({ openPullRequests: [plain] }), repo, NOW, OPERATOR.login),
        gatherGitHubFacts(repoWith({ openPullRequests: [touched] }), repo, NOW, OPERATOR.login),
      ]);

      expect(after.plainPullRequests).toEqual(before.plainPullRequests);
    });
  });

  it("holds the open agent PRs alone, with their Ticket from Closes #n, head, draft state, commits, reviews and activity", async () => {
    const github = repoWith({
      openPullRequests: [
        {
          number: 50,
          title: "Build the thing",
          isDraft: true,
          headRefOid: "h".repeat(40),
          headRefName: "fabrik/ticket-7",
          createdAt: "2026-11-01T00:00:00Z",
          mergeable: "MERGEABLE",
          author: APP,
          closingIssuesReferences: { nodes: [{ number: 7 }] },
          commits: { nodes: [aRawCommit("1", "2026-11-02T00:00:00Z", "A fix", { email: "jared@example.com", user: { login: "jrey8343" } })] },
          reviews: { nodes: [{ author: OPERATOR, state: "COMMENTED", submittedAt: "2026-11-02T01:00:00Z", body: "Why here?", comments: { nodes: [] } }] },
          comments: { nodes: [] },
          timelineItems: { nodes: [] },
          draftEvents: { nodes: [] },
        },
        {
          number: 52,
          title: "A person's PR",
          isDraft: false,
          headRefOid: "a".repeat(40),
          headRefName: "fabrik/ticket-9",
          createdAt: "2026-11-01T00:00:00Z",
          mergeable: "MERGEABLE",
          author: OPERATOR,
          closingIssuesReferences: { nodes: [{ number: 9 }] },
          commits: { nodes: [] },
          reviews: { nodes: [] },
          comments: { nodes: [] },
          timelineItems: { nodes: [] },
          draftEvents: { nodes: [] },
        },
      ],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(facts.openPullRequests).toEqual([
      {
        number: 50,
        ticket: 7,
        title: "Build the thing",
        draft: true,
        headSha: "h".repeat(40),
        createdAt: "2026-11-01T00:00:00Z",
        commits: [{ sha: "1".repeat(40), byApp: false, author: "jrey8343", message: "A fix", patch: null, at: "2026-11-02T00:00:00Z" }],
        reviews: [{ author: "jrey8343", state: "commented", body: "Why here?", comments: [], at: "2026-11-02T01:00:00Z" }],
        comments: [],
        labelEvents: [],
        mergeable: true,
        draftEvents: [],
      },
    ]);
  });

  describe("an open agent pull request's two Standing reads (#608)", () => {
    /** Open agent PR `number`, the Fabrik App's from Ticket `number - 43`'s branch, a draft, with `mergeable` and draft events as given. */
    const anOpenAgentPullRequest = (number: number, overrides: Record<string, unknown> = {}) => ({
      number,
      title: `PR ${number}`,
      isDraft: true,
      headRefOid: "h".repeat(40),
      headRefName: `fabrik/ticket-${number - 43}`,
      createdAt: "2026-11-01T00:00:00Z",
      mergeable: "MERGEABLE",
      author: APP,
      closingIssuesReferences: { nodes: [{ number: number - 43 }] },
      commits: { nodes: [] },
      reviews: { nodes: [] },
      comments: { nodes: [] },
      timelineItems: { nodes: [] },
      draftEvents: { nodes: [] },
      ...overrides,
    });

    it("reads whether each merges cleanly with the default branch, and one GitHub has not yet worked out as not known", async () => {
      const github = repoWith({
        openPullRequests: [anOpenAgentPullRequest(50), anOpenAgentPullRequest(51, { mergeable: "CONFLICTING" }), anOpenAgentPullRequest(52, { mergeable: "UNKNOWN" })],
      });

      const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

      expect(facts.openPullRequests.map(({ number, mergeable }) => ({ number, mergeable }))).toEqual([
        { number: 50, mergeable: true },
        { number: 51, mergeable: false },
        { number: 52, mergeable: null },
      ]);
    });

    it("reads when each went into draft and out of it, and who did it, oldest first", async () => {
      const github = repoWith({
        openPullRequests: [
          anOpenAgentPullRequest(50, {
            draftEvents: {
              nodes: [
                { __typename: "ReadyForReviewEvent", createdAt: "2026-11-02T00:00:00Z", actor: APP },
                { __typename: "ConvertToDraftEvent", createdAt: "2026-11-03T00:00:00Z", actor: OPERATOR },
                { __typename: "ConvertToDraftEvent", createdAt: "2026-11-04T00:00:00Z", actor: null },
              ],
            },
          }),
        ],
      });

      const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

      expect(facts.openPullRequests[0]?.draftEvents).toEqual([
        { kind: "ready", actor: "fabrik-app[bot]", at: "2026-11-02T00:00:00Z" },
        { kind: "draft", actor: "jrey8343", at: "2026-11-03T00:00:00Z" },
        { kind: "draft", actor: "ghost", at: "2026-11-04T00:00:00Z" },
      ]);
    });

    it("asks for both in the one read of the open pull requests, the Plain ones' merge state among them", async () => {
      const queries: string[] = [];
      const github = repoWith({ openPullRequests: [anOpenAgentPullRequest(50)] });
      await gatherGitHubFacts({ graphql: (query, variables) => (queries.push(query), github.graphql(query, variables)) }, repo, NOW, OPERATOR.login);

      const open = queries.filter((query) => query.includes("pullRequests(states: OPEN"));
      expect(open).toHaveLength(1);
      expect(open[0]).toMatch(/\bmergeable\b/);
      expect(open[0]).toMatch(/draftEvents: timelineItems\(last: 100, itemTypes: \[CONVERT_TO_DRAFT_EVENT, READY_FOR_REVIEW_EVENT\]\)/);
    });
  });

  it("holds the open Kit-owned issues as the Loop reads them, so Held names the held runs: a bot's body and comments alone", async () => {
    const held = '<!-- fabrik:held {"issue":7,"role":"implement","label":"agent:implement"} -->';
    const github = repoWith({
      kitIssues: [
        {
          number: 20,
          body: "The weekly usage limit is reached.\n<!-- fabrik:resets-at 2026-11-10T22:00:00Z -->",
          author: APP,
          labels: { nodes: [{ name: "fabrik:weekly-limit" }] },
          comments: { nodes: [{ body: held, author: APP }, { body: "Quoting it", author: OPERATOR }] },
        },
        { number: 21, body: "Faked", author: OPERATOR, labels: { nodes: [{ name: "fabrik:weekly-limit" }] }, comments: { nodes: [] } },
      ],
    });

    const { kitIssues } = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(kitIssues).toEqual([
      { number: 20, labels: ["fabrik:weekly-limit"], body: "The weekly usage limit is reached.\n<!-- fabrik:resets-at 2026-11-10T22:00:00Z -->", comments: [held] },
      { number: 21, labels: ["fabrik:weekly-limit"], body: "", comments: [] },
    ]);
  });

  it("holds the Carriers updated in the last two weeks, closed ones included, a bot's text alone, for the skipped-week line (#442)", async () => {
    const waiting = "This week's Audit waits for a free Subscription.\n\n<!-- fabrik:weekly-run-waiting audit 2026-11-02 -->";
    const github = repoWith({
      weekCarriers: [
        {
          number: 41,
          body: "The weekly usage limit is reached.",
          author: APP,
          labels: { nodes: [{ name: "fabrik:weekly-limit" }] },
          comments: { nodes: [{ body: waiting, author: APP }, { body: waiting, author: OPERATOR }] },
        },
      ],
    });

    const { weekCarriers } = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(weekCarriers).toEqual([{ number: 41, labels: ["fabrik:weekly-limit"], body: "The weekly usage limit is reached.", comments: [waiting] }]);
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

    const { designQueue } = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

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

  it("holds the open fabrik:monitor issues, who opened them and their bodies, so Held can read the Monitor's held count", async () => {
    const body = "<!-- fabrik:monitor sentry:4504 -->\n<!-- fabrik:monitor-stats -->\n- Held: 3 error groups waiting for a slot\n<!-- /fabrik:monitor-stats -->";
    const github = repoWith({
      monitorIssues: [
        { number: 41, body, author: APP },
        { number: 42, body: "Quoting it", author: OPERATOR },
        { number: 43, body: "", author: null },
      ],
    });

    const { monitorIssues } = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(monitorIssues).toEqual([
      { number: 41, author: "fabrik-app[bot]", body },
      { number: 42, author: "jrey8343", body: "Quoting it" },
      { number: 43, author: "ghost", body: "" },
    ]);
  });

  it("holds the issues the Operator opened in the 97 days whose body has an escape marker, with their title, state and body", async () => {
    const marked = "Split the parser.\n\nFrom audit #70\n<!-- fabrik:escape strong #50 -->";
    const github = repoWith({
      operatorIssues: [
        aRawOperatorIssue(81, "2026-11-05T00:00:00Z", "Just an idea."),
        aRawOperatorIssue(80, "2026-11-03T00:00:00Z", marked),
        aRawOperatorIssue(75, "2026-08-04T00:00:00Z", "<!-- fabrik:escape speculative #40 -->", { state: "CLOSED" }),
        aRawOperatorIssue(60, "2026-08-03T00:00:00Z", "<!-- fabrik:escape strong #30 -->"), // before the window
      ],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(facts.escapeMarkerIssues).toEqual([
      { number: 80, title: "Issue 80", author: "jrey8343", createdAt: "2026-11-03T00:00:00Z", state: "open", body: marked },
      { number: 75, title: "Issue 75", author: "jrey8343", createdAt: "2026-08-04T00:00:00Z", state: "closed", body: "<!-- fabrik:escape speculative #40 -->" },
    ]);
  });

  it("holds the issues the Operator opened in the 97 days whose body says From PR #n, the Follow-ups they opened, with their title and body", async () => {
    const filed = "Both modules round prices.\n\nFrom PR #50";
    const github = repoWith({
      operatorIssues: [
        aRawOperatorIssue(91, "2026-11-05T00:00:00Z", "Just an idea, from PR #50."),
        aRawOperatorIssue(90, "2026-11-04T00:00:00Z", filed),
        aRawOperatorIssue(89, "2026-11-04T00:00:00Z", "```\nFrom PR #50\n```"), // quoted as code
        aRawOperatorIssue(60, "2026-08-03T00:00:00Z", "From PR #30"), // before the window
      ],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(facts.followUpIssues).toEqual([{ number: 90, title: "Issue 90", author: "jrey8343", body: filed }]);
  });

  it("holds the open fabrik:audit issues, with who opened them and when", async () => {
    const github = repoWith({
      openAudits: [
        { number: 90, title: "Audit: week of 2026-11-02", createdAt: "2026-11-01T00:00:00Z", author: APP },
        { number: 91, title: "My own audit", createdAt: "2026-11-03T00:00:00Z", author: OPERATOR },
      ],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(facts.openAudits).toEqual([
      { number: 90, title: "Audit: week of 2026-11-02", author: "fabrik-app[bot]", createdAt: "2026-11-01T00:00:00Z" },
      { number: 91, title: "My own audit", author: "jrey8343", createdAt: "2026-11-03T00:00:00Z" },
    ]);
  });

  it("holds the open fabrik:retro issues, with who opened them and when", async () => {
    const github = repoWith({
      openRetros: [
        { number: 120, title: "Retro: week of 2026-11-02", createdAt: "2026-11-07T00:00:00Z", author: APP },
        { number: 121, title: "My own retro", createdAt: "2026-11-08T00:00:00Z", author: OPERATOR },
      ],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(facts.openRetros).toEqual([
      { number: 120, title: "Retro: week of 2026-11-02", author: "fabrik-app[bot]", createdAt: "2026-11-07T00:00:00Z" },
      { number: 121, title: "My own retro", author: "jrey8343", createdAt: "2026-11-08T00:00:00Z" },
    ]);
  });

  it("holds the fabrik:audit and fabrik:retro issues, open and closed, with who opened them, when, and their bodies, as the gates read them", async () => {
    const github = repoWith({
      audits: [
        { number: 96, title: "Audit: week of 2026-11-02", state: "CLOSED", stateReason: "NOT_PLANNED", createdAt: "2026-11-08T02:05:00Z", body: "failed", author: APP },
        { number: 95, title: "My own audit", state: "OPEN", stateReason: null, createdAt: "2026-11-08T00:05:00Z", body: "mine", author: OPERATOR },
      ],
      retros: [{ number: 120, title: "Retro: week of 2026-11-02", state: "OPEN", stateReason: null, createdAt: "2026-11-07T00:05:00Z", body: "pending", author: null }],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect([facts.audits, facts.retros]).toEqual([
      [
        { number: 96, title: "Audit: week of 2026-11-02", author: "fabrik-app[bot]", createdAt: "2026-11-08T02:05:00Z", body: "failed" },
        { number: 95, title: "My own audit", author: "jrey8343", createdAt: "2026-11-08T00:05:00Z", body: "mine" },
      ],
      [{ number: 120, title: "Retro: week of 2026-11-02", author: "ghost", createdAt: "2026-11-07T00:05:00Z", body: "pending" }],
    ]);
  });

  it("holds the open fabrik:replay issues, with who filed them, when, when their body was last edited, and the body", async () => {
    const github = repoWith({
      openReplays: [
        { number: 140, title: "Replay review.effort: high", createdAt: "2026-11-01T00:00:00Z", lastEditedAt: "2026-11-06T20:00:00Z", body: "The results", author: OPERATOR },
        { number: 141, title: "Replay kit", createdAt: "2026-11-07T00:00:00Z", lastEditedAt: null, body: "", author: null },
      ],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(facts.openReplays).toEqual([
      { number: 140, title: "Replay review.effort: high", author: "jrey8343", createdAt: "2026-11-01T00:00:00Z", lastEditedAt: "2026-11-06T20:00:00Z", body: "The results" },
      { number: 141, title: "Replay kit", author: "ghost", createdAt: "2026-11-07T00:00:00Z", lastEditedAt: null, body: "" },
    ]);
  });

  it("holds the open wayfinder:map issues, whoever opened them, by number, read as the Map cap reads them", async () => {
    const github = repoWith({
      openMaps: [
        { number: 30, title: "Let patients book group classes" },
        { number: 40, title: "Move intake online" },
      ],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(facts.openMaps).toEqual([30, 40]);
  });

  it("reads the default branch's commits from 97 days back, so a revert is seen across the streak table's 90 days", async () => {
    const github = repoWith({});
    const asked: unknown[] = [];
    const watched = {
      graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        if (query.includes("history(")) asked.push(variables["since"]);
        return github.graphql<T>(query, variables);
      },
    };

    await gatherGitHubFacts(watched, repo, NOW, OPERATOR.login);

    expect(asked).toEqual(["2026-08-03T20:00:00.000Z"]);
  });

  it("reads each issue's and PR's latest 100 label events, so when a label was last added holds on a busy issue (#481)", async () => {
    const github = repoWith({});
    const asked: string[] = [];
    const watched = {
      graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        asked.push(...(query.match(/timelineItems\([^)]*LABELED_EVENT[^)]*\)/g) ?? []));
        return github.graphql<T>(query, variables);
      },
    };

    await gatherGitHubFacts(watched, repo, NOW, OPERATOR.login);

    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter((window) => !window.includes("last: 100"))).toEqual([]);
  });

  it("holds the default branch's commit messages in the window", async () => {
    const github = repoWith({
      defaultBranchCommits: [{ message: `Revert "Build the thing"\n\nThis reverts commit ${"c".repeat(40)}.`, committedDate: "2026-11-05T00:00:00Z" }],
    });

    const facts = await gatherGitHubFacts(github, repo, NOW, OPERATOR.login);

    expect(facts.defaultBranchCommits).toEqual([
      { message: `Revert "Build the thing"\n\nThis reverts commit ${"c".repeat(40)}.`, at: "2026-11-05T00:00:00Z" },
    ]);
  });
});

describe("Gathering every Product repo's GitHub facts for the Weekly summary", () => {
  it("reads the rest when one repo's API call fails, naming that repo and why", async () => {
    const shop = repoWith({});
    const github = {
      graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        if (variables["name"] === "gone") return Promise.reject(new Error("GitHub GraphQL query failed: Bad Gateway"));
        return shop.graphql<T>(query, variables);
      },
    };

    const { facts, unread } = await gatherEveryRepoFacts(github, [{ owner: "jrey8343", name: "gone" }, repo], NOW, OPERATOR.login);

    expect(facts.map((each) => each.repo)).toEqual(["jrey8343/shop"]);
    expect(unread).toEqual([{ repo: "jrey8343/gone", why: "GitHub GraphQL query failed: Bad Gateway" }]);
  });
});

/** Commit `<digit>…<digit>`, made at `committedDate` by `author`, as a PR's commits query reads it. */
function aRawCommit(digit: string, committedDate: string, message: string, author: { email: string; user: { login: string } | null }) {
  return { commit: { oid: digit.repeat(40), message, committedDate, author } };
}

/** Issue `number`, titled "Issue <number>", which the Operator opened at `createdAt` with `body`, still open. */
function aRawOperatorIssue(number: number, createdAt: string, body: string, overrides: Record<string, unknown> = {}) {
  return { number, title: `Issue ${number}`, createdAt, state: "OPEN", body, author: OPERATOR, ...overrides };
}

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
    author: OPERATOR,
    labels: { nodes: [] },
    comments: { nodes: [] },
    timelineItems: { nodes: [] },
    blockedBy: { nodes: [] },
    subIssues: { nodes: [] },
    ...overrides,
  };
}

describe("Gathering a Product repo's GitHub facts for a Retro", () => {
  const OPERATOR_COMMIT = { email: "jared@example.com", user: { login: "jrey8343" } };
  const IMPLEMENTER = { email: "fabrik-implementer@users.noreply.github.com", user: null };

  /** The facts queries over `raw`, and the REST API's commits, each with these changed files; any other call fails. */
  function retroRepoWith(raw: RawRepo, files: Record<string, unknown[]>) {
    const read: string[] = [];
    return {
      read,
      github: {
        ...repoWith(raw),
        async rest(method: string, path: string): Promise<unknown> {
          expect(method).toBe("GET");
          const sha = /^\/repos\/jrey8343\/shop\/commits\/([0-9a-f]{40})$/.exec(path)?.[1];
          if (sha === undefined || files[sha] === undefined) throw new Error(`Unexpected call: ${path}`);
          read.push(sha);
          return { sha, files: files[sha] };
        },
      },
    };
  }

  it("reads the patch of each commit on an agent PR that the Fabrik App didn't make, file by file, and only those", async () => {
    const { github, read } = retroRepoWith(
      {
        closedPullRequests: [
          aRawPullRequest({
            commits: {
              nodes: [aRawCommit("1", "2026-11-02T00:00:00Z", "Build the thing", IMPLEMENTER), aRawCommit("2", "2026-11-03T00:00:00Z", "Move pricing out", OPERATOR_COMMIT)],
            },
          }),
        ],
        openPullRequests: [
          {
            number: 52,
            title: "Build the till",
            isDraft: true,
            headRefOid: "h".repeat(40),
            headRefName: "fabrik/ticket-9",
            createdAt: "2026-11-01T00:00:00Z",
            author: APP,
            closingIssuesReferences: { nodes: [{ number: 9 }] },
            commits: { nodes: [aRawCommit("3", "2026-11-04T00:00:00Z", "Add the logo", OPERATOR_COMMIT)] },
            reviews: { nodes: [] },
            comments: { nodes: [] },
            timelineItems: { nodes: [] },
            draftEvents: { nodes: [] },
            mergeable: "MERGEABLE",
          },
        ],
      },
      {
        ["2".repeat(40)]: [
          { filename: "src/pricing.ts", status: "added", patch: "@@ -0,0 +1 @@\n+export const price = 1;" },
          { filename: "src/cart.ts", previous_filename: "src/basket.ts", status: "renamed", patch: "@@ -1 +1 @@\n-old\n+new" },
        ],
        ["3".repeat(40)]: [{ filename: "logo.png", status: "added" }],
      },
    );

    const facts = await gatherRetroFacts(github, repo, NOW, OPERATOR.login, NOW);

    expect(facts.pullRequests[0]?.commits.map((commit) => commit.patch)).toEqual([
      null,
      [
        "diff --git a/src/pricing.ts b/src/pricing.ts",
        "@@ -0,0 +1 @@",
        "+export const price = 1;",
        "diff --git a/src/basket.ts b/src/cart.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    ]);
    expect(facts.openPullRequests[0]?.commits.map((commit) => commit.patch)).toEqual([
      "diff --git a/logo.png b/logo.png\n(No textual diff: a binary file, or too large for GitHub to show.)",
    ]);
    // Each once, in whatever order the reads went out.
    expect(read.toSorted()).toEqual(["2".repeat(40), "3".repeat(40)]);
  });

  // A Retro held back for weeks reads a window that starts more than 97 days before now.
  it("reaches back to `from` when its evidence starts before the 97 days, for its PRs, the Operator's issues and the default branch's commits", async () => {
    const from = Date.parse("2026-06-01T00:00:00Z");
    const asked: unknown[] = [];
    const { github } = retroRepoWith(
      {
        closedPullRequests: [aRawPullRequest({ number: 40, mergedAt: "2026-06-02T00:00:00Z", closedAt: "2026-06-02T00:00:00Z", updatedAt: "2026-06-02T00:00:00Z" })],
        operatorIssues: [aRawOperatorIssue(60, "2026-06-03T00:00:00Z", "<!-- fabrik:escape strong #40 -->")],
      },
      {},
    );
    const watched = {
      ...github,
      graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        if (query.includes("history(")) asked.push(variables["since"]);
        return github.graphql<T>(query, variables);
      },
    };

    const facts = await gatherRetroFacts(watched, repo, NOW, OPERATOR.login, from);

    expect(facts.pullRequests.map((pr) => pr.number)).toEqual([40]);
    expect(facts.escapeMarkerIssues.map((issue) => issue.number)).toEqual([60]);
    expect(asked).toEqual(["2026-06-01T00:00:00.000Z"]);
  });

  it("still reaches back the 97 days when its evidence starts later", async () => {
    const asked: unknown[] = [];
    const { github } = retroRepoWith({}, {});
    const watched = {
      ...github,
      graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        if (query.includes("history(")) asked.push(variables["since"]);
        return github.graphql<T>(query, variables);
      },
    };

    await gatherRetroFacts(watched, repo, NOW, OPERATOR.login, Date.parse("2026-10-01T00:00:00Z"));

    expect(asked).toEqual(["2026-08-03T20:00:00.000Z"]);
  });
});

describe("Reading the Tickets a Retro's evidence carries", () => {
  /** A REST API holding these issues by number; GitHub has no other, and any other call fails. */
  function issuesWith(issues: Record<number, { title: string; body: string | null }>) {
    const read: number[] = [];
    return {
      read,
      github: {
        async rest(method: string, path: string): Promise<unknown> {
          expect(method).toBe("GET");
          const number = Number(/^\/repos\/jrey8343\/shop\/issues\/(\d+)$/.exec(path)?.[1]);
          if (Number.isNaN(number)) throw new Error(`Unexpected call: ${path}`);
          read.push(number);
          const issue = issues[number];
          if (issue === undefined) throw new GitHubError(`GitHub GET ${path} failed: 404`, 404);
          return { number, ...issue };
        },
      },
    };
  }

  it("reads each one's title and body, once each, and leaves out one GitHub no longer has", async () => {
    const { github, read } = issuesWith({ 7: { title: "Build the cart", body: "A cart that totals its lines." }, 9: { title: "Build the till", body: null } });

    const tickets = await gatherTickets(github, repo, [7, 9, 7, 11]);

    expect(tickets).toEqual([
      { number: 7, title: "Build the cart", body: "A cart that totals its lines." },
      { number: 9, title: "Build the till", body: "" },
    ]);
    expect(read.toSorted((a, b) => a - b)).toEqual([7, 9, 11]);
  });

  it("fails on any other error, rather than give the Retro a Ticket it couldn't read", async () => {
    const github = {
      async rest(): Promise<unknown> {
        throw new GitHubError("GitHub GET failed: 502", 502);
      },
    };

    await expect(gatherTickets(github, repo, [7])).rejects.toThrow("502");
  });
});

// Proposals a Retro filed on the Kit's repo or a Skills source: the next Retro reads them there.
describe("Reading the open issues on other repos a Retro's proposals may be filed on", () => {
  /** A read-only GraphQL API over these repos' open issues, by owner/name; reading any other repo fails, as for a private one. */
  function reposWith(open: Record<string, { number: number; title: string; body: string }[]>) {
    return {
      async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        expect(query).toContain("issues(states: OPEN");
        const issues = open[`${String(variables["owner"])}/${String(variables["name"])}`];
        if (issues === undefined) throw new Error("GitHub GraphQL error: Could not resolve to a Repository");
        return { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: issues } } } as T;
      },
    };
  }

  it("reads each one's open issues with their bodies, each by the repo it's on, and names each repo it couldn't read rather than fail", async () => {
    const github = reposWith({
      "jrey8343/fabrik": [{ number: 230, title: "Check route imports in review", body: "From retro jrey8343/shop#100" }],
      "jrey8343/skills": [{ number: 12, title: "Route handlers skill", body: "From retro jrey8343/shop#99" }],
    });

    const { issues, unread } = await gatherOpenIssuesOn(github, ["jrey8343/fabrik", "jrey8343/private-skills", "jrey8343/skills"]);

    expect(issues).toEqual([
      { repo: "jrey8343/fabrik", number: 230, title: "Check route imports in review", body: "From retro jrey8343/shop#100" },
      { repo: "jrey8343/skills", number: 12, title: "Route handlers skill", body: "From retro jrey8343/shop#99" },
    ]);
    expect(unread).toEqual([{ repo: "jrey8343/private-skills", why: "GitHub GraphQL error: Could not resolve to a Repository" }]);
  });
});

describe("Reading the Required checks on each open Plain pull request's head", () => {
  const head = (digit: string) => digit.repeat(40);
  /** A check run on a head: one finished, with its conclusion, or one still `in_progress` or `queued`. */
  const aCheckRun = (name: string, status: string, conclusion: string | null = null) => ({ name, status, conclusion });

  /** The Checks API over these heads' check runs, a head given as a GitHubError failing its read; with every path it was asked. */
  function checksOn(runs: Record<string, readonly unknown[] | GitHubError>) {
    const asked: string[] = [];
    return {
      asked,
      async rest(method: string, path: string): Promise<unknown> {
        expect(method).toBe("GET");
        asked.push(path);
        const match = /^\/repos\/jrey8343\/shop\/commits\/([0-9a-f]{40})\/check-runs\?per_page=100&page=1$/.exec(path);
        if (match === null) throw new Error(`Unexpected call: ${path}`);
        const found = runs[match[1]!];
        if (found instanceof GitHubError) throw found;
        return { total_count: found?.length ?? 0, check_runs: found ?? [] };
      },
    };
  }

  it("judges each check the Kit config lists, in its order, as the Review's wait does: passed, running, failing, or never reported on the head", async () => {
    const github = checksOn({
      [head("1")]: [aCheckRun("test", "completed", "success"), aCheckRun("lint", "in_progress")],
      [head("2")]: [aCheckRun("test", "completed", "failure")],
      [head("3")]: [aCheckRun("lint", "completed", "skipped"), aCheckRun("test", "completed", "cancelled")],
      [head("4")]: [aCheckRun("test", "queued"), aCheckRun("lint", "completed", "neutral")],
    });

    expect(await gatherHeadChecks(github, repo, [head("1"), head("2"), head("3"), head("4")], ["test", "lint"])).toEqual({
      [head("1")]: [
        { name: "test", is: "passed" },
        { name: "lint", is: "running" },
      ],
      [head("2")]: [
        { name: "test", is: "failing" },
        { name: "lint", is: "never-reported" },
      ],
      // As GitHub judges a merge: a skipped or neutral check has passed, a cancelled one is failing.
      [head("3")]: [
        { name: "test", is: "failing" },
        { name: "lint", is: "passed" },
      ],
      [head("4")]: [
        { name: "test", is: "running" },
        { name: "lint", is: "passed" },
      ],
    });
  });

  it("reads no check the Kit config doesn't list, loop / Kit among them, and reads loop / Kit only when it is listed", async () => {
    const github = checksOn({ [head("1")]: [aCheckRun("loop / Kit", "completed", "failure"), aCheckRun("test", "completed", "success")] });

    expect(await gatherHeadChecks(github, repo, [head("1")], ["test"])).toEqual({ [head("1")]: [{ name: "test", is: "passed" }] });
    expect(await gatherHeadChecks(github, repo, [head("1")], ["test", "loop / Kit"])).toEqual({
      [head("1")]: [
        { name: "test", is: "passed" },
        { name: "loop / Kit", is: "failing" },
      ],
    });
  });

  it("leaves every head unread, asking nothing, when the Kit config lists no checks: it cannot tell which the branch requires", async () => {
    const github = checksOn({ [head("1")]: [aCheckRun("loop / Kit", "completed", "success")] });

    expect(await gatherHeadChecks(github, repo, [head("1")], [])).toEqual({});
    expect(github.asked).toEqual([]);
  });

  it("leaves a head whose read GitHub refused unread, and reads the rest", async () => {
    const github = checksOn({
      [head("1")]: new GitHubError("GitHub GET failed: 403", 403, { body: "Resource not accessible by integration" }),
      [head("2")]: [aCheckRun("test", "completed", "success")],
    });

    expect(await gatherHeadChecks(github, repo, [head("1"), head("2")], ["test"])).toEqual({ [head("2")]: [{ name: "test", is: "passed" }] });
  });
});
