// What the Loop reads when an agent pull request closes, so each Roll-in
// left unsent on it has its issue reopened for Triage (#663): from what
// GitHub holds, through the snapshot, to the plan.
import { describe, expect, it } from "vitest";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import { planFor } from "../loop/rules.ts";
import type { LoopEvent, Plan } from "../loop/types.ts";
import type { GitHub } from "./client.ts";
import { gatherSnapshot } from "./snapshot.ts";

const repo = { owner: "acme", name: "shop" };
const APP_LOGIN = "fabrik-app[bot]";
const APP = { login: "fabrik-app", __typename: "Bot" };
const OPERATOR = { login: "operator", __typename: "User" };

const merged: LoopEvent = { kind: "pull-request-closed", pullRequest: 42, merged: true, closedByBot: false };

/** A comment on an issue, as GitHub holds it. */
interface HeldComment {
  readonly body: string;
  readonly author: { readonly login: string; readonly __typename: string } | null;
  readonly createdAt?: string;
}

/** An issue as GitHub holds it: closed as not planned in acme/shop, unless a test says otherwise. */
interface HeldIssue {
  readonly number: number;
  readonly title?: string;
  readonly state?: "OPEN" | "CLOSED";
  readonly stateReason?: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED" | null;
  readonly repo?: string;
  readonly comments?: readonly HeldComment[];
}

/** A review of #42, as GitHub's REST API lists it. */
interface HeldReview {
  readonly id: number;
  readonly user: { readonly login: string; readonly type: string };
  readonly state: string;
  readonly body: string;
  readonly submitted_at?: string;
}

/** A comment pinned to a line of #42's diff, as GitHub's REST API lists it. */
interface HeldLineComment {
  readonly id: number;
  readonly user: { readonly login: string; readonly type: string };
  readonly body: string;
  readonly pull_request_review_id: number;
}

/** What GitHub holds of #42, merged, and around it. */
interface Held {
  /** The branch #42 was opened from, an agent branch unless a test says otherwise. */
  readonly headRefName?: string;
  /** What #42 is cross-referenced from, in GitHub's order: issues, or a pull request (`pullRequest: true`). */
  readonly crossReferences?: readonly (HeldIssue | { readonly pullRequest: true })[];
  /** How many cross-references GitHub gives to a page. */
  readonly pageSize?: number;
  readonly reviews?: readonly HeldReview[];
  readonly lineComments?: readonly HeldLineComment[];
}

/** The closing comment of a Design session that settled a Roll-in onto `pullRequest`, as the Kit writes it. */
const settledOnto = (pullRequest: number, author: HeldComment["author"] = APP): HeldComment => ({
  body: [
    `<!-- fabrik:roll-in ${pullRequest} -->`,
    '<!-- fabrik:roll-in-data {"v":1,"summary":"Show the cart\'s total beside its heading.","acceptanceCriteria":["The cart page shows the total beside its heading."]} -->',
    `**Design session finished.** The Operator settled a Roll-in onto #${pullRequest}, so the Kit closes this issue as not planned.`,
    "",
    `### What to build on #${pullRequest}`,
  ].join("\n"),
  author,
  createdAt: "2026-11-10T09:00:00Z",
});

/** #7, closed as not planned under a Roll-in settled onto #42. */
const settled = (overrides: Partial<HeldIssue> = {}): HeldIssue => ({ number: 7, title: "Show the cart's total", comments: [settledOnto(42)], ...overrides });

/** The Operator's Request changes on #42 with this text. */
const requestChanges = (body: string, overrides: Partial<HeldReview> = {}): HeldReview => ({
  id: 900,
  user: { login: "operator", type: "User" },
  state: "CHANGES_REQUESTED",
  body,
  submitted_at: "2026-11-10T10:00:00Z",
  ...overrides,
});

/** A GitHub holding `held`, which records what it is asked. */
function gitHubHolding(held: Held = {}) {
  const queries: string[] = [];
  const paths: string[] = [];
  const references = held.crossReferences ?? [];
  const issues = references.filter((reference): reference is HeldIssue => !("pullRequest" in reference));
  const pageSize = held.pageSize ?? 100;
  const stateOf = (issue: HeldIssue) => ({ state: issue.state ?? "CLOSED", stateReason: issue.stateReason === undefined ? "NOT_PLANNED" : issue.stateReason });
  const github = {
    async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
      queries.push(query);
      if (query.includes("CROSS_REFERENCED_EVENT")) {
        const from = variables["after"] === null || variables["after"] === undefined ? 0 : Number(variables["after"]);
        const page = references.slice(from, from + pageSize);
        return {
          repository: {
            pullRequest: {
              crossReferences: {
                pageInfo: { hasNextPage: from + pageSize < references.length, endCursor: String(from + pageSize) },
                nodes: page.map((reference) => ({
                  __typename: "CrossReferencedEvent",
                  source:
                    "pullRequest" in reference
                      ? { __typename: "PullRequest" }
                      : { __typename: "Issue", number: reference.number, ...stateOf(reference), repository: { nameWithOwner: reference.repo ?? "acme/shop" } },
                })),
              },
            },
          },
        };
      }
      const asked = [...query.matchAll(/issue(\d+): issue\(number: \1\)/g)].map((match) => Number(match[1]));
      if (asked.length > 0) {
        return {
          repository: Object.fromEntries(
            asked.map((number) => {
              const issue = issues.find((held) => held.number === number && (held.repo ?? "acme/shop").toLowerCase() === "acme/shop");
              if (issue === undefined) return [`issue${number}`, null];
              const comments = (issue.comments ?? []).map(({ body, author, createdAt }, index) => ({
                body,
                author,
                createdAt: createdAt ?? "2026-11-10T09:00:00Z",
                url: `https://github.com/acme/shop/issues/${number}#issuecomment-${index + 1}`,
              }));
              return [`issue${number}`, { number, title: issue.title ?? "An issue", ...stateOf(issue), comments: { nodes: comments } }];
            }),
          ),
        };
      }
      if (!query.includes("pullRequest(number: $number)")) return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      return {
        repository: {
          owner: { login: "acme" },
          pullRequest: {
            number: 42,
            state: "MERGED",
            isDraft: false,
            headRefName: held.headRefName ?? "fabrik/ticket-30",
            headRefOid: "a".repeat(40),
            author: APP,
            body: "Closes #30",
            url: "https://github.com/acme/shop/pull/42",
            labels: { nodes: [] },
            comments: { pageInfo: { hasPreviousPage: false }, nodes: [] },
            changesRequests: { nodes: [] },
            draftEvents: { pageInfo: { hasPreviousPage: false }, nodes: [] },
            createdAt: "2026-11-01T09:00:00Z",
            forcePushes: { nodes: [] },
            commits: { pageInfo: { hasPreviousPage: false }, nodes: [] },
            closingIssuesReferences: { nodes: [{ number: 30, state: "CLOSED", labels: { nodes: [] }, comments: { nodes: [] } }] },
          },
        },
      };
    },
    async rest(method: string, path: string): Promise<unknown> {
      paths.push(`${method} ${path}`);
      if (path.startsWith("/repos/acme/shop/pulls/42/reviews?")) return path.endsWith("page=1") ? (held.reviews ?? []) : [];
      if (path.startsWith("/repos/acme/shop/pulls/42/comments?")) return path.endsWith("page=1") ? (held.lineComments ?? []) : [];
      throw new Error(`Unexpected REST call: ${method} ${path}`);
    },
  };
  return { github: github as unknown as GitHub, queries, paths };
}

/** What the Kit would do about #42 merging, as the push job reads GitHub, which knows the Fabrik App's login. */
async function planOn(held: Held, event: LoopEvent = merged, appLogin: string | null = APP_LOGIN): Promise<Plan> {
  const snapshot = await gatherSnapshot(gitHubHolding(held).github, repo, event, "operator", appLogin);
  return planFor(event, snapshot, kitConfig());
}

/** The issues a plan reopens, in its order. */
const reopenedBy = (plan: Plan): number[] => (plan.kind === "act" ? plan.actions.flatMap((action) => (action.kind === "reopen" ? [action.issue] : [])) : []);

describe("Reading what an agent pull request closed with (#663)", () => {
  it("reads each issue closed as not planned that GitHub cross-references to it, with its comments and who wrote them, and the Operator's Request changes", async () => {
    const { github } = gitHubHolding({
      crossReferences: [settled({ comments: [{ body: "Could this go on the open PR?", author: OPERATOR, createdAt: "2026-11-09T09:00:00Z" }, settledOnto(42)] })],
      reviews: [requestChanges("Tighten the copy.")],
    });

    const snapshot = await gatherSnapshot(github, repo, merged, "operator", APP_LOGIN);

    expect(snapshot.rollIns).toEqual({
      repo: "acme/shop",
      requestChanges: [{ body: "Tighten the copy.", dismissed: false }],
      issues: [
        {
          number: 7,
          title: "Show the cart's total",
          repo: "acme/shop",
          closedAs: "not_planned",
          comments: [
            { body: "Could this go on the open PR?", byApp: false, at: "2026-11-09T09:00:00Z", url: "https://github.com/acme/shop/issues/7#issuecomment-1" },
            { body: settledOnto(42).body, byApp: true, at: "2026-11-10T09:00:00Z", url: "https://github.com/acme/shop/issues/7#issuecomment-2" },
          ],
        },
      ],
    });
  });

  it("so the issue of a Roll-in left unsent is reopened for Triage", async () => {
    expect(await planOn({ crossReferences: [settled()] })).toEqual({
      kind: "act",
      actions: [
        { kind: "reopen", issue: 7 },
        { kind: "remove-label", issue: 7, label: "wontfix" },
        {
          kind: "comment",
          issue: 7,
          body: "<!-- fabrik:roll-in-reopened -->\n#42 merged before this Roll-in was sent, so the Kit reopened this issue for Triage: its work can be built on `main` as its own Ticket.",
        },
        { kind: "add-labels", issue: 7, labels: ["needs-triage"] },
        { kind: "check-dispatch" },
      ],
    });
  });

  it("reads two such issues, however GitHub orders or repeats their cross-references, and reopens each once, lowest number first", async () => {
    const plan = await planOn({ crossReferences: [settled({ number: 12 }), settled({ number: 7 }), settled({ number: 12 })] });

    expect(reopenedBy(plan)).toEqual([7, 12]);
  });

  it("reads an issue of this repo however GitHub spells the repo's name", async () => {
    const { github } = gitHubHolding({ crossReferences: [settled({ repo: "Acme/Shop" })] });

    const plan = planFor(merged, await gatherSnapshot(github, { owner: "acme", name: "shop" }, merged, "operator", APP_LOGIN), kitConfig());

    expect(reopenedBy(plan)).toEqual([7]);
  });

  it("reads every page of the pull request's cross-references", async () => {
    const plan = await planOn({ crossReferences: [settled({ number: 7 }), { pullRequest: true }, settled({ number: 12 })], pageSize: 1 });

    expect(reopenedBy(plan)).toEqual([7, 12]);
  });
});

describe("Which reviews say a Roll-in was sent", () => {
  it.each([
    ["by # and its number", "Roll in #7: show the total beside the heading."],
    ["by its link", "Roll in https://github.com/acme/shop/issues/7 as its closing comment says."],
  ])("leaves the issue closed when the Operator's Request changes names it %s", async (_, body) => {
    expect(reopenedBy(await planOn({ crossReferences: [settled()], reviews: [requestChanges(body)] }))).toEqual([]);
  });

  it.each([
    ["was dismissed since", { reviews: [requestChanges("Roll in #7.", { state: "DISMISSED" })] }],
    ["is someone else's", { reviews: [requestChanges("Roll in #7.", { user: { login: "a-colleague", type: "User" } })] }],
    ["is a bot's under the Operator's name", { reviews: [requestChanges("Roll in #7.", { user: { login: "operator", type: "Bot" } })] }],
    ["only commented, requesting nothing", { reviews: [requestChanges("Roll in #7.", { state: "COMMENTED" })] }],
    [
      "names it only in a comment pinned to a line",
      {
        reviews: [requestChanges("See my note on the cart.")],
        lineComments: [{ id: 1, user: { login: "operator", type: "User" }, body: "Roll in #7 here.", pull_request_review_id: 900 }],
      },
    ],
  ])("reopens the issue when the only review naming it %s", async (_, written) => {
    expect(reopenedBy(await planOn({ crossReferences: [settled()], ...written }))).toEqual([7]);
  });

  it("reads no comment pinned to a line", async () => {
    const { github, paths } = gitHubHolding({ crossReferences: [settled()], reviews: [requestChanges("Roll in #7.")] });

    await gatherSnapshot(github, repo, merged, "operator", APP_LOGIN);

    expect(paths).toEqual(["GET /repos/acme/shop/pulls/42/reviews?per_page=100&page=1"]);
  });
});

describe("Whose mark makes a Roll-in", () => {
  const quoted = (author: HeldComment["author"]): Held => ({ crossReferences: [settled({ comments: [settledOnto(42, author)] })] });

  it.each([
    ["a person", OPERATOR],
    ["another bot", { login: "some-other-app", __typename: "Bot" }],
    ["a deleted account", null],
  ])("reopens nothing for a comment quoting the mark that %s wrote", async (_, author) => {
    expect(reopenedBy(await planOn(quoted(author)))).toEqual([]);
  });

  it("takes any bot's for the Fabrik App's in the Kit job, which only routes and does not know the App's login", async () => {
    expect(reopenedBy(await planOn(quoted({ login: "some-other-app", __typename: "Bot" }), merged, null))).toEqual([7]);
    expect(reopenedBy(await planOn(quoted(OPERATOR), merged, null))).toEqual([]);
  });
});

describe("Which cross-references are read further", () => {
  it.each([
    ["an open issue", settled({ state: "OPEN", stateReason: null })],
    ["an issue the Operator reopened", settled({ state: "OPEN", stateReason: "REOPENED" })],
    ["an issue closed as completed", settled({ stateReason: "COMPLETED" })],
    ["an issue closed as a duplicate", settled({ stateReason: "DUPLICATE" })],
    ["an issue of another repo with the same number", settled({ repo: "acme/blog" })],
    ["a pull request", { pullRequest: true } as const],
  ])("reads nothing more for %s, and reopens nothing", async (_, reference) => {
    const { github, queries, paths } = gitHubHolding({ crossReferences: [reference], reviews: [requestChanges("Tighten the copy.")] });

    const snapshot = await gatherSnapshot(github, repo, merged, "operator", APP_LOGIN);

    expect(snapshot.rollIns).toEqual({ repo: "acme/shop", requestChanges: [], issues: [] });
    expect(queries.filter((query) => query.includes("issue(number:"))).toEqual([]);
    expect(paths).toEqual([]);
    expect(reopenedBy(planFor(merged, snapshot, kitConfig()))).toEqual([]);
  });

  it("leaves closed an issue an ordinary not-planned finish closed, though GitHub cross-references it to the pull request", async () => {
    const notPlanned = { body: "**Design session finished.** The Operator decided this is not planned. It came up on #42.", author: APP };

    expect(await planOn({ crossReferences: [settled({ comments: [notPlanned] })] })).toEqual({ kind: "act", actions: [{ kind: "check-dispatch" }] });
  });

  it("asks for the cross-references in one query of its own, with no connection inside the issues it names", async () => {
    const { github, queries } = gitHubHolding({ crossReferences: [settled()] });

    await gatherSnapshot(github, repo, merged, "operator", APP_LOGIN);

    const asked = queries.filter((query) => query.includes("CROSS_REFERENCED_EVENT"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toMatch(/comments|reviews/);
  });
});

describe("When nothing is read for a Roll-in", () => {
  it("reads nothing for a Plain pull request closing, whose plan is what it was", async () => {
    const { github, queries, paths } = gitHubHolding({ headRefName: "feature/cart-total", crossReferences: [settled()] });

    const snapshot = await gatherSnapshot(github, repo, merged, "operator", APP_LOGIN);

    expect(snapshot.rollIns).toBeNull();
    expect(queries.filter((query) => query.includes("CROSS_REFERENCED_EVENT"))).toEqual([]);
    expect(paths).toEqual([]);
    expect(planFor(merged, snapshot, kitConfig())).toEqual({ kind: "nothing", reason: "#42 isn't an agent PR" });
  });

  it.each([
    ["is pushed to", { kind: "pull-request-pushed", pullRequest: 42 }],
    ["leaves draft", { kind: "pull-request-left-draft", pullRequest: 42 }],
  ] as const)("reads nothing when an agent pull request %s", async (_, event) => {
    const { github, queries } = gitHubHolding({ crossReferences: [settled()] });

    const snapshot = await gatherSnapshot(github, repo, event, "operator", APP_LOGIN);

    expect(snapshot.rollIns).toBeNull();
    expect(queries.filter((query) => query.includes("CROSS_REFERENCED_EVENT"))).toEqual([]);
  });
});
