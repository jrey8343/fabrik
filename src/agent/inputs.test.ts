import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubError } from "../github/client.ts";
import { type ShotsMarker, waitingShotsMarker } from "../evidence/shotsEvidence.ts";
import { markerLine } from "../evidence/uiEvidence.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import {
  designRoundMarker,
  flakyCheckIssueMarker,
  followUpMarker,
  PROTOTYPE_FAILURE_ROUND_MARKER,
  PROTOTYPE_ROUND_MARKER,
  spinOffMarker,
  trialProblemLine,
  trialStepsMarker,
} from "../loop/markers.ts";
import { roundLineIn, roundLineOf, withoutRoundLines } from "../loop/roundLine.ts";
import { planFor } from "../loop/rules.ts";
import { AGENT_FAILURE_FILE } from "./failure.ts";
import {
  readIssue,
  readMapOffer,
  readOperatorComments,
  readPullRequest,
  type Reader,
  reportFailure,
  SENT_BACK_DIFF_LIMIT,
  stagingTrialFor,
} from "./inputs.ts";

const repo = { owner: "acme", name: "shop" };

function graphqlReturning(...pages: unknown[]): Reader {
  let call = 0;
  return {
    graphql: async <T>() => pages[call++] as T,
    rest: async () => {
      throw new Error("unexpected REST call");
    },
  };
}

const issuePage = (comments: string[], next: string | null) => ({
  repository: {
    issue: {
      number: 7,
      title: "Add a waitlist",
      body: "As a patient…",
      author: { login: "someone" },
      labels: { nodes: [{ name: "ready-for-agent" }] },
      parent: { number: 3, title: "Bookings", body: "The Spec", subIssues: { nodes: [] } },
      comments: {
        pageInfo: { hasNextPage: next !== null, endCursor: next },
        nodes: comments.map((body) => ({ author: { login: "operator" }, body, createdAt: "2026-11-01T00:00:00Z" })),
      },
    },
  },
});

describe("An agent job's inputs", () => {
  it("reads the issue as gh issue view shapes it, every comment across pages, and its parent Spec", async () => {
    const github = graphqlReturning(issuePage(["first"], "cursor"), issuePage(["second"], null));

    const { issue, spec } = await readIssue(github, repo, 7, "operator");

    expect(issue).toEqual({
      number: 7,
      title: "Add a waitlist",
      body: "As a patient…",
      author: { login: "someone" },
      labels: [{ name: "ready-for-agent" }],
      operator: "operator",
      comments: [
        { author: { login: "operator" }, body: "first", createdAt: "2026-11-01T00:00:00Z", byBot: false, isOperator: true },
        { author: { login: "operator" }, body: "second", createdAt: "2026-11-01T00:00:00Z", byBot: false, isOperator: true },
      ],
    });
    expect(spec).toEqual({ number: 3, title: "Bookings", body: "The Spec" });
  });

  it("reads the Spec's other Tickets, each with its state label, open or closed, and its PR, so a split can see what they cover (#475)", async () => {
    const ticket = (number: number, title: string, state: string, labels: string[], pullRequests: { number: number; state: string }[]) => ({
      number,
      title,
      state,
      labels: { nodes: labels.map((name) => ({ name })) },
      closedByPullRequestsReferences: { nodes: pullRequests },
    });
    const page = issuePage([], null);
    const underASpec = {
      repository: {
        issue: {
          ...page.repository.issue,
          parent: {
            ...page.repository.issue.parent,
            subIssues: {
              nodes: [
                ticket(5, "The booking model", "CLOSED", ["enhancement"], [{ number: 20, state: "MERGED" }]),
                ticket(6, "The booking confirmation UI", "OPEN", ["ready-for-agent", "enhancement"], [{ number: 21, state: "CLOSED" }, { number: 22, state: "OPEN" }]),
                ticket(7, "Add a waitlist", "OPEN", ["needs-design"], []),
                ticket(8, "Add the booking emails", "OPEN", ["needs-design"], []),
              ],
            },
          },
        },
      },
    };

    const { spec, otherTickets } = await readIssue(graphqlReturning(underASpec), repo, 7, "operator");

    expect(spec).toEqual({ number: 3, title: "Bookings", body: "The Spec" });
    expect(otherTickets).toEqual([
      { number: 5, title: "The booking model", stateLabel: null, open: false, pullRequest: { number: 20, state: "merged" } },
      { number: 6, title: "The booking confirmation UI", stateLabel: "ready-for-agent", open: true, pullRequest: { number: 22, state: "open" } },
      { number: 8, title: "Add the booking emails", stateLabel: "needs-design", open: true, pullRequest: null },
    ]);
  });

  it.each([
    ["the Fabrik App's Check's issue", { login: "fabrik-app", __typename: "Bot" }, "e2e"],
    ["a person's issue quoting a Check's issue's marker", { login: "someone", __typename: "User" }, null],
  ])("reads the check of %s, which the turn's Map inputs weigh (#839)", async (_, author, check) => {
    const page = issuePage([], null);
    const checksIssue = { repository: { issue: { ...page.repository.issue, parent: null, author, body: `${flakyCheckIssueMarker("e2e")}\nThe check.` } } };

    const read = await readIssue(graphqlReturning(checksIssue), repo, 7, "operator");

    expect(read.check).toBe(check);
    expect((read.issue as { author: unknown }).author).toEqual({ login: author.login });
  });

  it("marks a Spin-off the Fabrik App opened, naming the issue whose Design session it came from (#883)", async () => {
    const page = issuePage([], null);
    const body = `${spinOffMarker({ from: "design", issue: 41 })}\nText each waitlisted patient a day before.`;
    const spinOff = { repository: { issue: { ...page.repository.issue, parent: null, author: { login: "fabrik-app", __typename: "Bot" }, body } } };

    const read = await readIssue(graphqlReturning(spinOff), repo, 7, "operator");

    expect(read.issue).toMatchObject({ number: 7, body, spinOff: { from: "design", issue: 41 } });
  });

  it.each([
    ["a person's issue quoting a Spin-off's marker", { login: "someone", __typename: "User" }, `${spinOffMarker({ from: "design", issue: 41 })}\nMine.`],
    ["the Fabrik App's issue that is no Spin-off", { login: "fabrik-app", __typename: "Bot" }, "The Monitor saw an error."],
    ["the Fabrik App's issue that quotes the marker below its first line", { login: "fabrik-app", __typename: "Bot" }, `An error.\n${spinOffMarker({ from: "design", issue: 41 })}`],
  ])("marks no Spin-off on %s", async (_, author, body) => {
    const page = issuePage([], null);
    const other = { repository: { issue: { ...page.repository.issue, parent: null, author, body } } };

    const read = await readIssue(graphqlReturning(other), repo, 7, "operator");

    expect(read.issue).not.toHaveProperty("spinOff");
  });

  it("marks a Follow-up the Kit opened, naming the pull request whose pass named the fault (#885)", async () => {
    const page = issuePage([], null);
    const body = `${followUpMarker(42)}\n\`badge.ts:14\` reads a stale count.\n\nFrom PR #42`;
    const followUp = { repository: { issue: { ...page.repository.issue, parent: null, author: { login: "fabrik-app", __typename: "Bot" }, body } } };

    const read = await readIssue(graphqlReturning(followUp), repo, 7, "operator");

    expect(read.issue).toMatchObject({ number: 7, body, followUp: { pullRequest: 42 } });
    expect(read.issue).not.toHaveProperty("spinOff");
  });

  it.each([
    ["a person's issue quoting the Follow-up marker", { login: "someone", __typename: "User" }, `${followUpMarker(42)}\nMine.\n\nFrom PR #42`],
    ["the Operator's issue opened from an Open as issue link", { login: "operator", __typename: "User" }, "An idea.\n\nFrom PR #42"],
    ["the Fabrik App's issue that quotes the marker below its first line", { login: "fabrik-app", __typename: "Bot" }, `An error.\n${followUpMarker(42)}`],
  ])("marks no Follow-up the Kit opened on %s", async (_, author, body) => {
    const page = issuePage([], null);
    const other = { repository: { issue: { ...page.repository.issue, parent: null, author, body } } };

    const read = await readIssue(graphqlReturning(other), repo, 7, "operator");

    expect(read.issue).not.toHaveProperty("followUp");
  });

  it("reads no other Tickets for an issue with no parent", async () => {
    const page = issuePage([], null);
    const alone = { repository: { issue: { ...page.repository.issue, parent: null } } };

    expect(await readIssue(graphqlReturning(alone), repo, 7, "operator")).toMatchObject({ spec: null, otherTickets: [] });
  });

  it("hands the agent a thread whose Rounds carry hidden lines just as it would the same thread without them (#635)", async () => {
    const roundPosted = (n: number) => {
      const output = JSON.stringify({ kind: "round", intro: `Round ${n} asks @someone <one> thing.`, questions: [{ question: "Chart this as a Map instead?", recommendation: "No." }], asksMap: true });
      const plan = planFor({ kind: "agent-run-finished", role: "design", issue: 7, output }, snapshotOf(anIssue({ number: 7, labels: ["needs-design"], designRounds: n - 1 })), kitConfig());
      return plan.kind === "act" && plan.actions[0]?.kind === "comment" ? plan.actions[0].body : "";
    };
    const withLines = [roundPosted(1), roundPosted(2)];
    expect(withLines.map(roundLineIn)).toEqual([expect.objectContaining({ round: 1 }), expect.objectContaining({ round: 2 })]);
    const threadOf = (rounds: readonly string[]) => {
      const page = issuePage([], null);
      const bot = { login: "fabrik-app", __typename: "Bot" };
      const operator = { login: "operator", __typename: "User" };
      const nodes = [
        { author: bot, body: rounds[0], createdAt: "2026-11-01T00:00:00Z" },
        { author: operator, body: "yes", createdAt: "2026-11-02T00:00:00Z" },
        { author: bot, body: rounds[1], createdAt: "2026-11-03T00:00:00Z" },
      ];
      return { repository: { issue: { ...page.repository.issue, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } };
    };

    const carrying = await readIssue(graphqlReturning(threadOf(withLines)), repo, 7, "operator");
    const without = await readIssue(graphqlReturning(threadOf(withLines.map(withoutRoundLines))), repo, 7, "operator");

    expect(JSON.stringify(carrying)).toBe(JSON.stringify(without));
    expect(JSON.stringify(carrying)).not.toContain("fabrik:round-line");
  });

  it("hands the agent a prototype round and a prototype failure round without their hidden third lines (#636)", async () => {
    const question = (q: string) => [{ question: q, recommendation: "B." }];
    const prototype = [
      designRoundMarker(3),
      PROTOTYPE_ROUND_MARKER,
      roundLineOf({ v: 1, kind: "prototype", round: 3, intro: "Two ways.", questions: question("Which variant?"), route: "/book", recommended: "A", variants: [{ letter: "A", summary: "A form.", component: "https://github.com/acme/shop/blob/abc/src/A.tsx", preview: null }], captures: null }),
      "@operator **Design session, round 3: the prototype.** …",
    ].join("\n");
    const failed = [
      designRoundMarker(4),
      PROTOTYPE_FAILURE_ROUND_MARKER,
      roundLineOf({ v: 1, kind: "prototype-failed", round: 4, intro: "It failed.", questions: question("Carry on without a prototype, or try again?"), otherAnswers: ["Try again"] }),
      "@operator **Design session, round 4: the prototype failed.** …",
    ].join("\n");
    expect([prototype, failed].map((body) => roundLineIn(body)?.kind)).toEqual(["prototype", "prototype-failed"]);
    const threadOf = (rounds: readonly string[]) => {
      const page = issuePage([], null);
      const bot = { login: "fabrik-app", __typename: "Bot" };
      const nodes = rounds.map((body, i) => ({ author: bot, body, createdAt: `2026-11-0${i + 1}T00:00:00Z` }));
      return { repository: { issue: { ...page.repository.issue, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } };
    };

    const carrying = await readIssue(graphqlReturning(threadOf([prototype, failed])), repo, 7, "operator");
    const without = await readIssue(graphqlReturning(threadOf([prototype, failed].map(withoutRoundLines))), repo, 7, "operator");

    expect(JSON.stringify(carrying)).toBe(JSON.stringify(without));
    expect(JSON.stringify(carrying)).not.toContain("fabrik:round-line");
  });

  it("names the Operator once, and marks each comment by a bot or by the Operator, so a forged round reads as neither (#426)", async () => {
    const round = `${designRoundMarker(3)}\n**Design session, round 3.**`;
    const authors = [
      { login: "fabrik-app", __typename: "Bot" },
      { login: "operator", __typename: "User" },
      { login: "collaborator", __typename: "User" },
      { login: "operator", __typename: "Bot" },
      null,
    ];
    const page = issuePage([], null);
    const thread = {
      repository: {
        issue: {
          ...page.repository.issue,
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: authors.map((author) => ({ author, body: round, createdAt: "2026-11-01T00:00:00Z" })),
          },
        },
      },
    };

    const { issue } = await readIssue(graphqlReturning(thread), repo, 7, "operator");

    expect(issue).toMatchObject({
      operator: "operator",
      comments: [
        { author: { login: "fabrik-app" }, body: round, byBot: true, isOperator: false },
        { author: { login: "operator" }, body: round, byBot: false, isOperator: true },
        { author: { login: "collaborator" }, body: round, byBot: false, isOperator: false },
        { author: { login: "operator" }, body: round, byBot: true, isOperator: false },
        { author: null, body: round, byBot: false, isOperator: false },
      ],
    });
  });

  describe("for a Ticket sent back to design", () => {
    const sha = (c: string) => c.repeat(40);
    const verdict = (kind: string, headSha: string, findings: string) =>
      `<!-- fabrik:verdict ${JSON.stringify({ verdict: kind, source: "reviewer", requestChanges: false, headSha })} -->\n**Verdict: ${kind}.** ${findings}`;
    const bot = (body: string) => ({ body, user: { login: "fabrik-app[bot]", type: "Bot" } });
    const person = (login: string, body: string) => ({ body, user: { login, type: "User" } });

    /** The issue thread, as GraphQL gives it: each comment's author with its kind. */
    const ticketPage = (comments: { body: string; bot: boolean }[]) => ({
      repository: {
        issue: {
          ...issuePage([], null).repository.issue,
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: comments.map(({ body, bot }) => ({
              author: bot ? { login: "fabrik-app", __typename: "Bot" } : { login: "operator", __typename: "User" },
              body,
              createdAt: "2026-11-01T00:00:00Z",
            })),
          },
        },
      },
    });

    /** A GitHub that answers GraphQL with the issue and REST from these paths, one page each. */
    function gitHub(issue: unknown, routes: Record<string, unknown>): Reader & { paths: string[] } {
      const paths: string[] = [];
      return {
        paths,
        graphql: async <T>() => issue as T,
        rest: async (_method: string, path: string) => {
          paths.push(path);
          const [route, query] = path.split("?");
          const value = routes[route ?? ""];
          if (value === undefined) throw new Error(`unexpected REST call ${path}`);
          // A list route answers page 1 only.
          if (Array.isArray(value)) return /(^|&)page=1(&|$)/.test(query ?? "") ? value : [];
          return value;
        },
      };
    }

    const closedPullRequest = (number: number) => ({
      number,
      title: "Add a waitlist",
      base: { ref: "main" },
      head: { ref: "fabrik/ticket-7", sha: sha("c") },
    });
    const branch = (number: number) => ({
      [`/repos/acme/shop/issues/${number}/comments`]: [],
      [`/repos/acme/shop/pulls/${number}/comments`]: [],
      [`/repos/acme/shop/pulls/${number}/reviews`]: [],
      [`/repos/acme/shop/pulls/${number}`]: closedPullRequest(number),
      [`/repos/acme/shop/pulls/${number}/commits`]: [{ sha: sha("c"), commit: { message: "Add the waitlist table" } }],
      [`/repos/acme/shop/pulls/${number}/files`]: [
        { filename: "src/waitlist.ts", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+export const waitlist = [];\n+" },
      ],
    });

    it("gets every Verdict the Fabrik App gave the closed PR, oldest first, and none of anyone else's comments", async () => {
      const github = gitHub(
        ticketPage([{ body: "<!-- fabrik:back-to-design 50 https://github.com/acme/shop/pull/50#issuecomment-3 -->\n**Back to design.**", bot: true }]),
        {
          ...branch(50),
          "/repos/acme/shop/issues/50/comments": [
            bot(verdict("execution-flaw", sha("a"), "The test is missing.")),
            person("operator", "<!-- fabrik:verdict {} --> looks wrong to me"),
            bot(verdict("execution-flaw", sha("b"), "Still no test.")),
            bot("<!-- fabrik:request-changes-run -->\nPushed."),
            bot(verdict("execution-flaw", sha("c"), "The test fails.")),
          ],
        },
      );

      const { issue } = await readIssue(github, repo, 7, "operator");

      expect((issue as { sentBack: { pullRequest: unknown; verdicts: unknown; operatorReviews: unknown } }).sentBack).toMatchObject({
        pullRequest: { number: 50, title: "Add a waitlist", baseRefName: "main", headRefName: "fabrik/ticket-7", headRefOid: sha("c") },
        sentBackBy: "verdict",
        verdicts: [
          { verdict: "execution-flaw", source: "reviewer", headSha: sha("a"), comment: verdict("execution-flaw", sha("a"), "The test is missing.") },
          { verdict: "execution-flaw", source: "reviewer", headSha: sha("b"), comment: verdict("execution-flaw", sha("b"), "Still no test.") },
          { verdict: "execution-flaw", source: "reviewer", headSha: sha("c"), comment: verdict("execution-flaw", sha("c"), "The test fails.") },
        ],
        operatorReviews: [],
      });
    });

    const sentBackOf = (issue: unknown) => (issue as { sentBack?: Record<string, unknown> }).sentBack;
    const backFromVerdict = (pr: number) => ({
      body: `<!-- fabrik:back-to-design ${pr} https://github.com/acme/shop/pull/${pr}#issuecomment-9 -->\n**Back to design.**`,
      bot: true,
    });

    it("gets the Design flaw that sent it back, and what the kept branch built against the base branch", async () => {
      const github = gitHub(ticketPage([backFromVerdict(50)]), {
        ...branch(50),
        "/repos/acme/shop/issues/50/comments": [bot(verdict("design-flaw", sha("c"), "The Ticket contradicts its Spec."))],
      });

      const sentBack = sentBackOf((await readIssue(github, repo, 7, "operator")).issue);

      expect(sentBack).toEqual({
        pullRequest: { number: 50, title: "Add a waitlist", baseRefName: "main", headRefName: "fabrik/ticket-7", headRefOid: sha("c") },
        sentBackBy: "verdict",
        verdicts: [
          { verdict: "design-flaw", source: "reviewer", headSha: sha("c"), comment: verdict("design-flaw", sha("c"), "The Ticket contradicts its Spec.") },
        ],
        operatorReviews: [],
        operatorComments: [],
        commits: [{ sha: sha("c"), message: "Add the waitlist table" }],
        files: [{ filename: "src/waitlist.ts", status: "added", additions: 2, deletions: 0 }],
        diff: "diff --git a/src/waitlist.ts b/src/waitlist.ts\n@@ -0,0 +1,2 @@\n+export const waitlist = [];\n+",
        diffTruncated: false,
      });
    });

    it("gets the Operator's reviews and their inline comments when the Operator sent it back, and no Verdict", async () => {
      const github = gitHub(ticketPage([{ body: "<!-- fabrik:back-to-design 50 operator -->\n**Back to design.**", bot: true }]), {
        ...branch(50),
        "/repos/acme/shop/pulls/50/reviews": [
          { id: 1, user: { login: "operator", type: "User" }, state: "CHANGES_REQUESTED", body: "This isn't the waitlist we want.", commit_id: sha("c"), submitted_at: "2026-11-02T00:00:00Z" },
          { id: 2, user: { login: "someone-else", type: "User" }, state: "COMMENTED", body: "Drive-by.", commit_id: sha("c"), submitted_at: "2026-11-02T00:00:00Z" },
          { id: 3, user: { login: "operator", type: "User" }, state: "PENDING", body: "Draft.", commit_id: sha("c") },
        ],
        "/repos/acme/shop/pulls/50/reviews/1/comments": [{ path: "src/waitlist.ts", line: 1, body: "Patients, not slots." }],
      });

      const sentBack = sentBackOf((await readIssue(github, repo, 7, "operator")).issue);

      expect(sentBack).toMatchObject({
        sentBackBy: "operator",
        verdicts: [],
        operatorReviews: [
          {
            state: "CHANGES_REQUESTED",
            body: "This isn't the waitlist we want.",
            commitId: sha("c"),
            submittedAt: "2026-11-02T00:00:00Z",
            comments: [{ path: "src/waitlist.ts", line: 1, body: "Patients, not slots." }],
          },
        ],
      });
    });

    const operatorSaid = {
      id: 11,
      user: { login: "operator", type: "User" },
      body: "The waitlist is per clinic, not per slot.",
      created_at: "2026-11-01T12:00:00Z",
      html_url: "https://github.com/acme/shop/pull/50#issuecomment-11",
    };
    const driveBy = { ...operatorSaid, id: 12, user: { login: "someone-else", type: "User" }, body: "Drive-by." };
    const fedComment = {
      id: "conversation-11",
      url: "https://github.com/acme/shop/pull/50#issuecomment-11",
      where: { kind: "conversation" },
      createdAt: "2026-11-01T12:00:00Z",
      body: "The waitlist is per clinic, not per slot.",
    };

    it("gets the Operator's comments on the closed PR when a Verdict sent it back, and nobody else's", async () => {
      const github = gitHub(ticketPage([backFromVerdict(50)]), {
        ...branch(50),
        "/repos/acme/shop/issues/50/comments": [bot(verdict("design-flaw", sha("c"), "Contradicts the Spec.")), operatorSaid, driveBy],
      });

      const sentBack = sentBackOf((await readIssue(github, repo, 7, "operator")).issue);

      expect(sentBack).toMatchObject({ sentBackBy: "verdict", operatorComments: [fedComment] });
    });

    it("gets the Operator's comments on the closed PR when the Operator sent it back, and nobody else's", async () => {
      const github = gitHub(ticketPage([{ body: "<!-- fabrik:back-to-design 50 operator -->\n**Back to design.**", bot: true }]), {
        ...branch(50),
        "/repos/acme/shop/issues/50/comments": [operatorSaid, driveBy],
      });

      const sentBack = sentBackOf((await readIssue(github, repo, 7, "operator")).issue);

      expect(sentBack).toMatchObject({ sentBackBy: "operator", verdicts: [], operatorComments: [fedComment] });
    });

    it("gets only the latest closed PR when the Ticket came back more than once", async () => {
      const github = gitHub(
        ticketPage([backFromVerdict(40), { body: "**Design session finished.**", bot: true }, backFromVerdict(50)]),
        { ...branch(50), "/repos/acme/shop/issues/50/comments": [] },
      );

      const sentBack = sentBackOf((await readIssue(github, repo, 7, "operator")).issue);

      expect(sentBack).toMatchObject({ pullRequest: { number: 50 } });
      expect(github.paths.some((path) => path.includes("/40"))).toBe(false);
    });

    it("gets nothing more once the Design session after the return has finished, or from a note someone only quoted", async () => {
      for (const comments of [
        [backFromVerdict(50), { body: "**Design session finished.**", bot: true }],
        [{ ...backFromVerdict(50), bot: false }],
      ]) {
        const github = gitHub(ticketPage(comments), {});

        const { issue } = await readIssue(github, repo, 7, "operator");

        expect(issue).not.toHaveProperty("sentBack");
        expect(github.paths).toEqual([]);
      }
    });

    it("cuts a diff over the limit short with a marker, keeping every changed file in the list", async () => {
      const big = (name: string) => ({ filename: name, status: "added", additions: 1, deletions: 0, patch: `+${"x".repeat(SENT_BACK_DIFF_LIMIT)}` });
      const github = gitHub(ticketPage([backFromVerdict(50)]), {
        ...branch(50),
        "/repos/acme/shop/issues/50/comments": [],
        "/repos/acme/shop/pulls/50/files": [big("a.ts"), big("b.ts")],
      });

      const sentBack = sentBackOf((await readIssue(github, repo, 7, "operator")).issue) as { diff: string; diffTruncated: boolean; files: { filename: string }[] };

      expect(sentBack.diffTruncated).toBe(true);
      expect(sentBack.diff.length).toBeLessThan(SENT_BACK_DIFF_LIMIT + 200);
      expect(sentBack.diff).toMatch(/\[Diff truncated at \d+ of \d+ characters; every changed file is listed in files\.\]$/);
      expect(sentBack.files.map((file) => file.filename)).toEqual(["a.ts", "b.ts"]);
    });
  });

  const pullRequest = {
    repository: {
      pullRequest: {
        number: 50,
        title: "Add a waitlist",
        body: "Closes #7",
        baseRefName: "main",
        headRefName: "fabrik/ticket-7",
        headRefOid: "a".repeat(40),
        comments: { nodes: [{ body: "<!-- fabrik:verdict … -->", author: { __typename: "Bot" } }] },
      },
    },
  };

  /** The PR over GraphQL, and its comment lists over REST: a Verdict and fix comment from the Kit, and one from the Operator. */
  const withThread = (): Reader => ({
    graphql: async <T>() => pullRequest as T,
    rest: async (_method: string, path: string) => {
      const [route, query] = path.split("?");
      if (!/(^|&)page=1(&|$)/.test(query ?? "")) return [];
      switch (route) {
        case "/repos/acme/shop/issues/50/comments":
          return [
            { id: 1, user: { login: "fabrik-app[bot]", type: "Bot" }, body: "<!-- fabrik:verdict … -->", created_at: "2026-11-01T00:00:00Z", html_url: "https://github.com/acme/shop/pull/50#issuecomment-1" },
            { id: 2, user: { login: "fabrik-app[bot]", type: "Bot" }, body: "<!-- fabrik:fix -->\nFixed.", created_at: "2026-11-02T00:00:00Z", html_url: "https://github.com/acme/shop/pull/50#issuecomment-2" },
            { id: 3, user: { login: "operator", type: "User" }, body: "Keep the copy short.", created_at: "2026-11-03T00:00:00Z", html_url: "https://github.com/acme/shop/pull/50#issuecomment-3" },
          ];
        case "/repos/acme/shop/pulls/50/comments":
        case "/repos/acme/shop/pulls/50/reviews":
          return [];
        default:
          throw new Error(`unexpected REST call ${path}`);
      }
    },
  });
  const operatorComments = [
    {
      id: "conversation-3",
      url: "https://github.com/acme/shop/pull/50#issuecomment-3",
      where: { kind: "conversation" },
      createdAt: "2026-11-03T00:00:00Z",
      body: "Keep the copy short.",
    },
  ];

  it("gives the Reviewer the PR and the Operator's comments, never the Verdicts or fix comments, so earlier runs don't steer it", async () => {
    expect(await readPullRequest(withThread(), repo, 50, { withComments: false, operator: "operator" })).toEqual({
      number: 50,
      title: "Add a waitlist",
      body: "Closes #7",
      baseRefName: "main",
      headRefName: "fabrik/ticket-7",
      headRefOid: "a".repeat(40),
      operatorComments,
    });
  });

  it("gives a retry the PR's body, to refresh, its comments with their authors' kind, so only the Fabrik App's Verdicts count, and the Operator's comments apart", async () => {
    expect(await readPullRequest(withThread(), repo, 50, { withComments: true, operator: "operator" })).toEqual({
      number: 50,
      title: "Add a waitlist",
      body: "Closes #7",
      comments: [{ body: "<!-- fabrik:verdict … -->", author: { __typename: "Bot" } }],
      operatorComments,
    });
  });

  describe("for a Review in a Product repo that declares staging (#964)", () => {
    const TRIAL = {
      summary: "Patients can join a waitlist for a full day.",
      steps: [{ route: "/book", do: "Pick a day with no free slots.", expect: 'A "Join the waitlist" button shows.' }],
    };
    const UI_EVIDENCE = markerLine({ run: 9100, artifact: 9202 });
    /** The PR with this body, opened by the Fabrik App unless `author` says who else. */
    const withBody = (body: string, author: { __typename: string } | null = { __typename: "Bot" }): Reader => ({
      ...withThread(),
      graphql: async <T>() => ({ repository: { pullRequest: { ...pullRequest.repository.pullRequest, body, author } } }) as T,
    });
    const stagingTrialOf = async (github: Reader, ticket = "As a patient…") =>
      ((await readPullRequest(github, repo, 50, { withComments: false, operator: "operator", stagingTrial: { ticket } })) as { stagingTrial?: unknown }).stagingTrial;

    it("carries the pull request's Trial steps, read from the marker in the body the Fabrik App wrote, and that it will ask for a Staging trial, as a UI pull request does", async () => {
      const body = `Adds a waitlist.\n\n${UI_EVIDENCE}\n\n${trialStepsMarker(TRIAL)}\n\nCloses #7`;

      expect(await stagingTrialOf(withBody(body))).toEqual({ willAsk: true, steps: TRIAL });
    });

    it("says a pull request that keeps no Trial steps has none, and still that it will ask", async () => {
      expect(await stagingTrialOf(withBody(`Adds a waitlist.\n\n${UI_EVIDENCE}\n\nCloses #7`))).toEqual({ willAsk: true, steps: null });
    });

    it("will ask on a pull request whose UI evidence is Evidence shots, unless its Implementer said nothing visible changes", async () => {
      const shots = (names: Pick<ShotsMarker, "named" | "nothingVisible">) => markerLine(waitingShotsMarker(names, 9100, { kind: "none" }));
      const named = `Adds a waitlist.\n\n${shots({ named: [{ name: "booking: full day" }] })}\n\n${trialStepsMarker(TRIAL)}\n\nCloses #7`;
      const nothingVisible = `Retries the API call.\n\n${shots({ named: [], nothingVisible: "Only the retry timing changed." })}\n\n${trialStepsMarker(TRIAL)}\n\nCloses #7`;

      expect(await stagingTrialOf(withBody(named))).toEqual({ willAsk: true, steps: TRIAL });
      expect(await stagingTrialOf(withBody(nothingVisible))).toEqual({ willAsk: false, steps: TRIAL });
    });

    it("will ask on a pull request with no UI evidence when its Ticket is a Trial problem, by the line in the Ticket's body, and on no other", async () => {
      const plain = withBody(`Rounds the total once.\n\n${trialStepsMarker(TRIAL)}\n\nCloses #7`);

      expect(await stagingTrialOf(plain, `The cart total reads 0 on staging.\n\n${trialProblemLine(48)}`)).toEqual({ willAsk: true, steps: TRIAL });
      expect(await stagingTrialOf(plain)).toEqual({ willAsk: false, steps: TRIAL });
      expect(await stagingTrialOf(withBody("Rounds the total once.\n\nCloses #7"))).toEqual({ willAsk: false, steps: null });
    });

    it.each([
      ["a person", { __typename: "User" }],
      ["an account GitHub no longer has", null],
    ])("reads no marker from a body %s wrote, as anyone can write the lines", async (_who, author) => {
      const body = `Adds a waitlist.\n\n${UI_EVIDENCE}\n\n${trialStepsMarker(TRIAL)}\n\nCloses #7`;

      expect(await stagingTrialOf(withBody(body, author))).toEqual({ willAsk: false, steps: null });
    });

    it("is carried by no other run's pull request, whatever its body keeps, so a repo with no staging block reads as it did", async () => {
      const body = `Adds a waitlist.\n\n${UI_EVIDENCE}\n\n${trialStepsMarker(TRIAL)}\n\nCloses #7`;

      for (const withComments of [false, true]) {
        const read = await readPullRequest(withBody(body), repo, 50, { withComments, operator: "operator" });

        expect(read).not.toHaveProperty("stagingTrial");
        expect(Object.keys(read as object)).toEqual(
          withComments ? ["number", "title", "body", "comments", "operatorComments"] : ["number", "title", "body", "baseRefName", "headRefName", "headRefOid", "operatorComments"],
        );
      }
    });
  });
});

describe("Which run's pull request is read for its Staging trial (#964)", () => {
  const STAGING = { url: "https://staging.shop.example", environment: "staging" };

  it("is a Review's, in a Product repo that declares staging, read against its Ticket's body", () => {
    expect(stagingTrialFor("review", kitConfig({ staging: STAGING }), "The cart total reads 0.")).toEqual({ ticket: "The cart total reads 0." });
  });

  it("is no Review's in a repo with no staging block, nor one whose Kit config doesn't read", () => {
    expect(stagingTrialFor("review", kitConfig(), "The cart total reads 0.")).toBeUndefined();
    expect(stagingTrialFor("review", null, "The cart total reads 0.")).toBeUndefined();
  });

  it.each(["implement", "digest", undefined])("is no run's of the role %s, which reads the pull request as it did", (role) => {
    expect(stagingTrialFor(role, kitConfig({ staging: STAGING }), "The cart total reads 0.")).toBeUndefined();
  });
});

describe("The Operator's comments on a PR", () => {
  const OP = { login: "operator", type: "User" };
  const BOT = { login: "operator", type: "Bot" };
  const OTHER = { login: "someone-else", type: "User" };

  /** A GitHub answering REST list routes, paged 100 at a time, and GraphQL with `pr`. */
  function restGitHub(routes: Record<string, unknown[]>, pr: unknown = null): Reader & { paths: string[] } {
    const paths: string[] = [];
    return {
      paths,
      graphql: async <T>() => pr as T,
      rest: async (_method: string, path: string) => {
        paths.push(path);
        const [route, query] = path.split("?");
        const items = routes[route ?? ""];
        if (items === undefined) throw new Error(`unexpected REST call ${path}`);
        const page = Number(/(?:^|&)page=(\d+)/.exec(query ?? "")?.[1] ?? "1");
        return items.slice((page - 1) * 100, page * 100);
      },
    };
  }

  const conversation = (id: number, user: unknown, body: string, at = "2026-11-01T00:00:00Z") => ({
    id,
    user,
    body,
    created_at: at,
    html_url: `https://github.com/acme/shop/pull/50#issuecomment-${id}`,
  });
  const inline = (id: number, user: unknown, body: string, at = "2026-11-01T00:00:00Z") => ({
    id,
    user,
    body,
    path: "src/cart.ts",
    line: 12,
    original_line: 10,
    created_at: at,
    html_url: `https://github.com/acme/shop/pull/50#discussion_r${id}`,
  });
  const review = (id: number, user: unknown, state: string, body: string, at = "2026-11-01T00:00:00Z") => ({
    id,
    user,
    state,
    body,
    submitted_at: at,
    html_url: `https://github.com/acme/shop/pull/50#pullrequestreview-${id}`,
  });

  const routes = (parts: { conversation?: unknown[]; inline?: unknown[]; reviews?: unknown[] }) => ({
    "/repos/acme/shop/issues/50/comments": parts.conversation ?? [],
    "/repos/acme/shop/pulls/50/comments": parts.inline ?? [],
    "/repos/acme/shop/pulls/50/reviews": parts.reviews ?? [],
  });

  it("gathers the conversation, inline and non-Request-changes review comments, oldest first, each with its id, URL and place", async () => {
    const github = restGitHub(
      routes({
        conversation: [conversation(1, OP, "The parking copy is right.", "2026-11-03T00:00:00Z")],
        inline: [inline(2, OP, "Call it total.", "2026-11-01T00:00:00Z")],
        reviews: [
          review(3, OP, "COMMENTED", "Looks close.", "2026-11-02T00:00:00Z"),
          review(4, OP, "CHANGES_REQUESTED", "Rename it.", "2026-11-04T00:00:00Z"),
          review(5, OP, "PENDING", "Draft.", "2026-11-05T00:00:00Z"),
          review(6, OP, "APPROVED", "", "2026-11-06T00:00:00Z"),
        ],
      }),
    );

    expect(await readOperatorComments(github, repo, 50, "operator")).toEqual([
      {
        id: "inline-2",
        url: "https://github.com/acme/shop/pull/50#discussion_r2",
        where: { kind: "inline", path: "src/cart.ts", line: 12 },
        createdAt: "2026-11-01T00:00:00Z",
        body: "Call it total.",
      },
      {
        id: "review-3",
        url: "https://github.com/acme/shop/pull/50#pullrequestreview-3",
        where: { kind: "review", state: "COMMENTED" },
        createdAt: "2026-11-02T00:00:00Z",
        body: "Looks close.",
      },
      {
        id: "conversation-1",
        url: "https://github.com/acme/shop/pull/50#issuecomment-1",
        where: { kind: "conversation" },
        createdAt: "2026-11-03T00:00:00Z",
        body: "The parking copy is right.",
      },
    ]);
  });

  it("leaves out bots' comments and other humans', wherever they were made", async () => {
    const github = restGitHub(
      routes({
        conversation: [conversation(1, BOT, "From a bot."), conversation(2, OTHER, "Drive-by."), conversation(3, null, "Ghost.")],
        inline: [inline(4, OTHER, "Not the Operator."), inline(5, BOT, "Bot inline.")],
        reviews: [review(6, OTHER, "COMMENTED", "Not the Operator."), review(7, BOT, "APPROVED", "Bot review.")],
      }),
    );

    expect(await readOperatorComments(github, repo, 50, "operator")).toEqual([]);
  });

  it("follows every page of each list", async () => {
    const noise = (i: number) => conversation(i, OTHER, `noise ${i}`);
    const github = restGitHub(
      routes({
        conversation: [...Array.from({ length: 140 }, (_, i) => noise(i + 1)), conversation(141, OP, "On page two.")],
        inline: [...Array.from({ length: 100 }, (_, i) => inline(i + 200, OTHER, "noise")), inline(300, OP, "Inline on page two.")],
        reviews: [...Array.from({ length: 100 }, (_, i) => review(i + 400, OTHER, "COMMENTED", "noise")), review(500, OP, "COMMENTED", "Review on page two.")],
      }),
    );

    const comments = await readOperatorComments(github, repo, 50, "operator");

    expect(comments.map((comment) => comment.body).sort()).toEqual(["Inline on page two.", "On page two.", "Review on page two."]);
  });

  it("reads each comment as it stands now: its latest edit, and nothing for one since deleted", async () => {
    // GitHub's lists hold only comments that still exist, each with its current body.
    const github = restGitHub(routes({ conversation: [conversation(2, OP, "Edited: use the short copy.")] }));

    expect((await readOperatorComments(github, repo, 50, "operator")).map(({ id, body }) => ({ id, body }))).toEqual([
      { id: "conversation-2", body: "Edited: use the short copy." },
    ]);
  });

  describe("a Request changes from the Operator, which amends the Ticket (ADR-0010)", () => {
    const graph = {
      repository: {
        pullRequest: {
          number: 50,
          title: "Add a waitlist",
          body: "Closes #7",
          baseRefName: "main",
          headRefName: "fabrik/ticket-7",
          headRefOid: "a".repeat(40),
          comments: { nodes: [] },
        },
      },
    };
    const inReview = (review: number, id: number, user: unknown, body: string, at: string) => ({
      ...inline(id, user, body, at),
      pull_request_review_id: review,
    });
    const github = () =>
      restGitHub(
        routes({
          conversation: [conversation(1, OP, "Keep the copy short.", "2026-11-01T00:00:00Z")],
          inline: [
            inReview(4, 5, OP, "And drop this row.", "2026-11-04T00:00:00Z"),
            inReview(9, 10, OTHER, "Not the Operator's.", "2026-11-05T00:00:00Z"),
          ],
          reviews: [
            review(3, OP, "CHANGES_REQUESTED", "Remove Declan Price as a provider.", "2026-11-03T00:00:00Z"),
            review(4, OP, "CHANGES_REQUESTED", "", "2026-11-04T00:00:00Z"),
            review(6, OP, "PENDING", "Not sent yet.", "2026-11-06T00:00:00Z"),
            review(7, BOT, "CHANGES_REQUESTED", "A bot's.", "2026-11-07T00:00:00Z"),
            review(9, OTHER, "CHANGES_REQUESTED", "Someone else's.", "2026-11-05T00:00:00Z"),
          ],
        }),
        graph,
      );
    const requestedChanges = [
      {
        id: "review-3",
        url: "https://github.com/acme/shop/pull/50#pullrequestreview-3",
        submittedAt: "2026-11-03T00:00:00Z",
        body: "Remove Declan Price as a provider.",
        comments: [],
      },
      {
        id: "review-4",
        url: "https://github.com/acme/shop/pull/50#pullrequestreview-4",
        submittedAt: "2026-11-04T00:00:00Z",
        body: "",
        comments: [
          {
            id: "inline-5",
            url: "https://github.com/acme/shop/pull/50#discussion_r5",
            path: "src/cart.ts",
            line: 12,
            body: "And drop this row.",
          },
        ],
      },
    ];

    it.each([false, true])(
      "reaches a Review's and a retry's PR input apart from the comments, oldest first, with its inline comments, even one with an empty body (withComments: %s)",
      async (withComments) => {
        const read = (await readPullRequest(github(), repo, 50, { withComments, operator: "operator" })) as {
          requestedChanges?: unknown;
          operatorComments: { id: string }[];
        };

        expect(read.requestedChanges).toEqual(requestedChanges);
        // The plain comments stay as they were, for the Request-changes run, which names its review's inline comments from them.
        expect(read.operatorComments.map((comment) => comment.id)).toEqual(["conversation-1", "inline-5"]);
      },
    );

    it.each([false, true])(
      "leaves out one deferred while a Retry was in flight (#427), its inline comments too, so neither the Retry's Review nor a Retry is given it (withComments: %s)",
      async (withComments) => {
        const read = (await readPullRequest(github(), repo, 50, { withComments, operator: "operator", deferred: [4] })) as {
          requestedChanges?: unknown;
          operatorComments: { id: string }[];
        };

        expect(read.requestedChanges).toEqual([requestedChanges[0]]);
        expect(read.operatorComments.map((comment) => comment.id)).toEqual(["conversation-1"]);
      },
    );

    it("is left out of the PR input entirely when the Operator has requested none", async () => {
      const none = restGitHub(routes({ reviews: [review(3, OP, "COMMENTED", "Looks close.")] }), graph);

      expect(await readPullRequest(none, repo, 50, { withComments: false, operator: "operator" })).not.toHaveProperty("requestedChanges");
    });

    describe("whose points the Kit opened as Spin-offs (#884)", () => {
      const APP = { login: "fabrik-app[bot]", type: "Bot" };
      /** A Request-changes run's note as the Kit posted it, recording the Spin-offs it opened. */
      const runNote = (...opened: [issue: number, from: string, title: string][]) =>
        [
          "<!-- fabrik:request-changes-run -->",
          '<!-- fabrik:request-changes-answers {"review":4,"reviewMiss":false,"amendsTicket":false} -->',
          ...opened.map(([issue, from, title]) => `<!-- fabrik:spin-off-opened #${issue} ${JSON.stringify({ from, title })} -->`),
          "The Implementer pushed the Operator's requested changes.",
        ].join("\n");
      const withNotes = (notes: unknown[], reviews?: unknown[]) =>
        restGitHub(
          routes({
            conversation: notes,
            inline: [inReview(4, 5, OP, "And drop this row, as its own issue.", "2026-11-04T00:00:00Z")],
            reviews: reviews ?? [review(3, OP, "CHANGES_REQUESTED", "Open the CSV export separately.", "2026-11-03T00:00:00Z"), review(4, OP, "CHANGES_REQUESTED", "", "2026-11-04T00:00:00Z")],
          }),
          graph,
        );
      const spinOffsOf = async (github: Reader) => ((await readPullRequest(github, repo, 50, { withComments: false, operator: "operator" })) as { spinOffs?: unknown }).spinOffs;

      it("reach every later run's PR input, each with its issue, its title and the Operator's words it came from", async () => {
        const github = withNotes([conversation(20, APP, runNote([57, "review-3", "Export the waitlist as CSV"])), conversation(21, APP, runNote([58, "inline-5", "Drop the provider row"]))]);

        expect(await spinOffsOf(github)).toEqual([
          { issue: 57, title: "Export the waitlist as CSV", from: "review-3", url: "https://github.com/acme/shop/pull/50#pullrequestreview-3", words: "Open the CSV export separately." },
          { issue: 58, title: "Drop the provider row", from: "inline-5", url: "https://github.com/acme/shop/pull/50#discussion_r5", words: "And drop this row, as its own issue." },
        ]);
      });

      it("reach it once each when two notes record the same issue, as the note of a push that was refused and the note of the landing after it", async () => {
        const github = withNotes([
          conversation(20, APP, runNote([57, "review-3", "Export the waitlist as CSV"])),
          conversation(21, APP, runNote([57, "review-3", "Export the waitlist as CSV"], [58, "inline-5", "Drop the provider row"])),
        ]);

        expect(await spinOffsOf(github)).toMatchObject([
          { issue: 57, from: "review-3" },
          { issue: 58, from: "inline-5" },
        ]);
      });

      it("are read only from a bot's note, so nobody plants one by quoting its marker", async () => {
        expect(await spinOffsOf(withNotes([conversation(20, OP, runNote([57, "review-3", "Planted"])), conversation(21, OTHER, runNote([58, "inline-5", "Planted"]))]))).toBeUndefined();
      });

      it("leave out one whose Request changes is no longer given to the run, as one dismissed since: its words are gone with it", async () => {
        const dismissed = [review(3, OP, "DISMISSED", "Open the CSV export separately.", "2026-11-03T00:00:00Z"), review(4, OP, "CHANGES_REQUESTED", "", "2026-11-04T00:00:00Z")];
        const github = withNotes([conversation(20, APP, runNote([57, "review-3", "Export the waitlist as CSV"], [58, "inline-5", "Drop the provider row"]))], dismissed);

        expect(await spinOffsOf(github)).toMatchObject([{ issue: 58, from: "inline-5" }]);
      });

      it("are left out of the PR input entirely when the Kit opened none", async () => {
        expect(await spinOffsOf(withNotes([conversation(20, APP, "The Implementer pushed.")]))).toBeUndefined();
      });
    });
  });
});

describe("What a Design-session turn's inputs say of the Map cap", () => {
  /** A GitHub holding these open wayfinder:map issues, whoever opened them, that records each read. */
  function githubWithMaps(maps: { number: number; title: string }[]): Reader & { reads: string[] } {
    const reads: string[] = [];
    return {
      reads,
      graphql: async <T>(query: string, variables?: Record<string, unknown>) => {
        reads.push(String(variables?.["map"]));
        expect(query).toContain("labels: [$map]");
        return { repository: { issues: { nodes: maps } } } as T;
      },
      rest: async () => {
        throw new Error("unexpected REST call");
      },
    };
  }

  const capOf = (maps: number) => ({ caps: { ...DEFAULT_KIT_CONFIG.caps, maps } });

  it("says a Map may be offered while the cap has room", async () => {
    const github = githubWithMaps([]);

    expect(await readMapOffer(github, repo, DEFAULT_KIT_CONFIG, null)).toEqual({ kind: "may-offer" });
    expect(github.reads).toEqual(["wayfinder:map"]);
  });

  it("says the cap is full and which Map holds it, a Map made by hand included", async () => {
    const github = githubWithMaps([{ number: 12, title: "Group classes" }]);

    expect(await readMapOffer(github, repo, DEFAULT_KIT_CONFIG, null)).toEqual({
      kind: "cap-full",
      cap: 1,
      openMaps: [{ number: 12, title: "Group classes" }],
    });
  });

  it("says the cap is full when caps.maps is 0, with no Map open", async () => {
    expect(await readMapOffer(githubWithMaps([]), repo, capOf(0), null)).toEqual({ kind: "cap-full", cap: 0, openMaps: [] });
  });

  it.each([
    ["the cap has room", []],
    ["the cap is full", [{ number: 12, title: "Group classes" }]],
  ])("says a Ticket under a Spec can't be offered a Map, whether or not %s, and reads no open Maps", async (_cap, maps) => {
    const github = githubWithMaps(maps);

    expect(await readMapOffer(github, repo, DEFAULT_KIT_CONFIG, { number: 3 })).toEqual({ kind: "under-a-spec", spec: 3 });
    expect(github.reads).toEqual([]);
  });

  it("says a Check's issue can't be offered a Map, whatever room the cap has, and reads no open Maps (#839)", async () => {
    const github = githubWithMaps([]);

    expect(await readMapOffer(github, repo, DEFAULT_KIT_CONFIG, null, "e2e")).toEqual({ kind: "checks-issue", check: "e2e" });
    expect(github.reads).toEqual([]);
  });
});

// #328: a turn on a sent-back Ticket whose job couldn't read the closed PR
// failed with no report, so its notice said only "it crashed".
describe("The input step's failure report", () => {
  const backToDesign = {
    repository: {
      issue: {
        ...issuePage([], null).repository.issue,
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              author: { login: "fabrik-app", __typename: "Bot" },
              body: "<!-- fabrik:back-to-design 84 operator -->\n**Back to design.**",
              createdAt: "2026-11-01T00:00:00Z",
            },
          ],
        },
      },
    },
  };
  const refusing = (error: Error): Reader => ({
    graphql: async <T>() => backToDesign as T,
    rest: async () => {
      throw error;
    },
  });
  const forbidden = new GitHubError("GitHub GET /repos/acme/shop/pulls/84 failed: 403 …", 403, {
    body: JSON.stringify({ message: "Resource not accessible by integration", status: "403" }),
    request: "GET /repos/acme/shop/pulls/84",
  });

  it("names the request GitHub refused and its answer, when a token without pull-requests: read reads the sent-back PR", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabrik-inputs-"));
    const failureDir = join(dir, "fabrik-out");

    const error = await readIssue(refusing(forbidden), repo, 7, "operator").then(
      () => null,
      (caught: unknown) => caught,
    );
    await reportFailure(error, failureDir);

    expect(JSON.parse(await readFile(join(failureDir, AGENT_FAILURE_FILE), "utf8"))).toEqual({
      failure: "unread-inputs",
      detail: "GET /repos/acme/shop/pulls/84: 403 Resource not accessible by integration",
      refused: true,
    });
  });

  it("leaves no report for an error that isn't a GitHub call's, which the push job reads as a crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabrik-inputs-"));

    await reportFailure(new Error("GH_TOKEN is not set"), dir);

    expect(existsSync(join(dir, AGENT_FAILURE_FILE))).toBe(false);
  });

  it("leaves no report when the job names no place for it", async () => {
    await expect(reportFailure(forbidden, "")).resolves.toBeUndefined();
  });
});
