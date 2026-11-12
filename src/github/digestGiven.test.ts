import { describe, expect, it } from "vitest";
import { aDigestReply, aRequestChanges } from "../__fixtures__/digests.ts";
import { type DigestReply, digestCommentOf } from "../loop/digestContract.ts";
import { handBackMarker, RETRY_PUSH_MARKER, verdictMarker } from "../loop/markers.ts";
import type { ReadClient } from "./client.ts";
import { readDigestGiven, readDigestThread } from "./digestGiven.ts";

const HEAD = "a".repeat(40);
const EARLIER = "b".repeat(40);
const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const repo = { owner: "acme", name: "shop" };

const BOT = { login: "fabrik-app[bot]", type: "Bot" };
const OPERATOR = { login: "olive", type: "User" };
const STRANGER = { login: "stranger", type: "User" };
const at = (minute: number) => `2026-11-02T10:${String(minute).padStart(2, "0")}:00Z`;

const FLAW = `${verdictMarker({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: EARLIER })}\n## Verdict: Execution flaw`;
const PASS = `${verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD })}\n## Verdict: Pass`;
const RETRY_PUSH = `${RETRY_PUSH_MARKER}\nThe Implementer pushed a fix for the Execution flaw to \`fabrik/ticket-7\`; Review runs again on it.`;
const EMPTY_DIFF = "<!-- fabrik:empty-diff -->\nThe Implement run on #7 changed nothing.";

interface User {
  readonly login: string;
  readonly type: string;
}

interface Thread {
  readonly comments?: readonly { user: User | null; body: string; created_at: string }[];
  /** Its reviews. One given no text of its own says "Call it a basket.", as aRequestChanges does. */
  readonly reviews?: readonly { id: number; user: User | null; state: string; submitted_at?: string | null; body?: string | null }[];
  /** The line comments on its diff, each in the review that holds it. */
  readonly lineComments?: readonly {
    id: number;
    user: User | null;
    pull_request_review_id: number | null;
    path: string;
    line: number | null;
    original_line?: number | null;
    created_at: string;
  }[];
  readonly headRefName?: string;
  /** The issues the pull request closes, each with its comments as GraphQL gives them. */
  readonly closes?: readonly { number: number; comments: readonly { body: string; author: { login: string; __typename: string } | null }[] }[];
  /** The pull request's files, as GitHub's REST API lists them. Left out, the read of them is unexpected. */
  readonly files?: readonly { filename: string; status: string; patch?: string }[];
  /** Each file's text at the head, by its path. Left out, a read of any file is unexpected. */
  readonly texts?: Readonly<Record<string, string>>;
}

const REVIEW_URL = (id: number) => `https://github.com/acme/shop/pull/50#pullrequestreview-${id}`;
const LINE_URL = (id: number) => `https://github.com/acme/shop/pull/50#discussion_r${id}`;

/**
 * #50 of acme/shop, a draft, as GitHub answers for it, and every call the
 * read made, in order. Its one GraphQL answer holds what both of the reads'
 * queries select: the thread's opening, and the pull request as the Loop's
 * snapshot reads it.
 */
function gitHub({ comments = [], reviews = [], lineComments = [], headRefName = "fabrik/ticket-7", closes = [], files, texts }: Thread = {}): { client: ReadClient; calls: string[] } {
  const calls: string[] = [];
  const author = (user: User | null) => (user === null ? null : { login: user.login, __typename: user.type });
  const client: ReadClient = {
    graphql: async <T>(_query: string, variables: Record<string, unknown>) => {
      calls.push(`graphql ${JSON.stringify(variables)}`);
      const closingIssuesReferences = { nodes: closes.map(({ number, comments: nodes }) => ({ number, state: "OPEN", labels: { nodes: [] }, comments: { nodes } })) };
      return {
        repository: {
          owner: { login: "acme" },
          pullRequest: {
            number: 50,
            url: "https://github.com/acme/shop/pull/50",
            state: "OPEN",
            isDraft: true,
            headRefName,
            headRefOid: HEAD,
            author: { login: BOT.login, __typename: "Bot" },
            body: "",
            labels: { nodes: [] },
            comments: { pageInfo: { hasPreviousPage: false }, nodes: comments.map(({ user, body, created_at }) => ({ body, createdAt: created_at, author: author(user) })) },
            changesRequests: {
              nodes: reviews
                .filter(({ state }) => state === "CHANGES_REQUESTED")
                .map(({ id, user, submitted_at }) => ({ databaseId: id, submittedAt: submitted_at ?? null, author: author(user) })),
            },
            draftEvents: { pageInfo: { hasPreviousPage: false }, nodes: [] },
            createdAt: at(0),
            forcePushes: { nodes: [] },
            commits: { pageInfo: { hasPreviousPage: false }, nodes: [{ commit: { oid: HEAD, committedDate: at(0) } }] },
            closingIssuesReferences,
          },
        },
      } as T;
    },
    rest: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      const [route, query] = path.split("?");
      if (!/(^|&)page=1(&|$)/.test(query ?? "")) return [];
      if (route === "/repos/acme/shop/issues/50/comments") return comments;
      if (route === "/repos/acme/shop/pulls/50/comments") return lineComments.map((comment) => ({ body: "Here.", html_url: LINE_URL(comment.id), ...comment }));
      if (route === "/repos/acme/shop/pulls/50/reviews") {
        return reviews.map((review) => ({ html_url: REVIEW_URL(review.id), ...review, body: review.body === undefined ? "Call it a basket." : review.body }));
      }
      if (route === "/repos/acme/shop/pulls/50/files" && files !== undefined) return files;
      throw new Error(`unexpected REST call ${path}`);
    },
    fileText: async (_repo, path, ref) => {
      if (texts === undefined) throw new Error("the thread's read read a file");
      calls.push(`text ${path}@${ref}`);
      return texts[path] ?? null;
    },
  };
  return { client, calls };
}

/** No Request changes of the Operator's is deferred. */
const NONE_DEFERRED: readonly number[] = [];

describe("The push job's read of a pull request's thread, for Kit code's facts", () => {
  it("is when it opened, the Kit's own comments oldest first, the Operator's Request changes and what the Ticket's runs landed before it opened", async () => {
    const { client } = gitHub({
      comments: [
        { user: BOT, body: FLAW, created_at: at(5) },
        { user: BOT, body: RETRY_PUSH, created_at: at(10) },
        { user: BOT, body: PASS, created_at: at(15) },
      ],
      reviews: [{ id: 8, user: OPERATOR, state: "CHANGES_REQUESTED", submitted_at: at(20) }],
      closes: [{ number: 7, comments: [{ body: EMPTY_DIFF, author: { login: "fabrik-app", __typename: "Bot" } }] }],
    });

    expect(await readDigestThread(client, repo, 50, "olive", NONE_DEFERRED)).toEqual({
      openedAt: at(0),
      kitComments: [
        { at: at(5), body: FLAW },
        { at: at(10), body: RETRY_PUSH },
        { at: at(15), body: PASS },
      ],
      requestChanges: [aRequestChanges(8, at(20))],
      landedNothing: 1,
    });
  });

  it("takes a marker only from a bot's comment, so nobody plants a round by quoting one", async () => {
    const { client } = gitHub({
      comments: [
        { user: OPERATOR, body: PASS, created_at: at(5) },
        { user: STRANGER, body: RETRY_PUSH, created_at: at(6) },
        { user: null, body: FLAW, created_at: at(7) },
        { user: BOT, body: PASS, created_at: at(15) },
      ],
      closes: [{ number: 7, comments: [{ body: EMPTY_DIFF, author: { login: "stranger", __typename: "User" } }] }],
    });

    expect(await readDigestThread(client, repo, 50, "olive", NONE_DEFERRED)).toMatchObject({ kitComments: [{ at: at(15), body: PASS }], landedNothing: 0 });
  });

  it("takes only the Operator's reviews that requested changes: one since dismissed is marked so, and anyone else's, an approval, a comment and one still pending are left out", async () => {
    const { client } = gitHub({
      reviews: [
        { id: 1, user: OPERATOR, state: "APPROVED", submitted_at: at(1) },
        { id: 2, user: OPERATOR, state: "COMMENTED", submitted_at: at(2) },
        { id: 3, user: OPERATOR, state: "DISMISSED", submitted_at: at(3) },
        { id: 4, user: STRANGER, state: "CHANGES_REQUESTED", submitted_at: at(4) },
        { id: 5, user: { login: "olive", type: "Bot" }, state: "CHANGES_REQUESTED", submitted_at: at(5) },
        { id: 6, user: OPERATOR, state: "PENDING" },
        { id: 7, user: OPERATOR, state: "CHANGES_REQUESTED", submitted_at: at(7) },
      ],
    });

    expect((await readDigestThread(client, repo, 50, "olive", NONE_DEFERRED)).requestChanges).toEqual([
      aRequestChanges(3, at(3), { dismissed: true }),
      aRequestChanges(7, at(7)),
    ]);
  });

  it("counts what the Ticket's runs landed only on the Ticket the branch names, and only while the pull request links it", async () => {
    const landedOnAnother = [{ number: 9, comments: [{ body: EMPTY_DIFF, author: { login: "fabrik-app", __typename: "Bot" } }] }];

    expect(await readDigestThread(gitHub({ closes: landedOnAnother }).client, repo, 50, "olive", NONE_DEFERRED)).toMatchObject({ landedNothing: 0 });
    expect(await readDigestThread(gitHub({ headRefName: "feature/cart", closes: landedOnAnother }).client, repo, 50, "olive", NONE_DEFERRED)).toMatchObject({ landedNothing: 0 });
  });

  it("reads each Request changes with its own text, its place and the Operator's line comments in it, oldest first", async () => {
    const line = { user: OPERATOR, path: "src/cart.ts", line: 12 };
    const { client } = gitHub({
      reviews: [
        { id: 8, user: OPERATOR, state: "CHANGES_REQUESTED", submitted_at: at(20), body: "Two places still say cart." },
        { id: 9, user: OPERATOR, state: "CHANGES_REQUESTED", submitted_at: at(25), body: null },
      ],
      lineComments: [
        // A line GitHub no longer places is read by where it was when written, as the Reviewer's input reads it.
        { ...line, id: 13, pull_request_review_id: 8, path: "src/checkout.ts", line: null, original_line: 30, created_at: at(19) },
        { ...line, id: 12, pull_request_review_id: 8, created_at: at(18) },
        { ...line, id: 14, pull_request_review_id: 8, user: STRANGER, created_at: at(21) },
        { ...line, id: 15, pull_request_review_id: 9, path: "src/banner.ts", line: null, created_at: at(24) },
        { ...line, id: 16, pull_request_review_id: null, created_at: at(26) },
      ],
    });

    expect((await readDigestThread(client, repo, 50, "olive", NONE_DEFERRED)).requestChanges).toEqual([
      aRequestChanges(8, at(20), {
        body: "Two places still say cart.",
        lineComments: [
          { comment: 12, url: LINE_URL(12), path: "src/cart.ts", line: 12 },
          { comment: 13, url: LINE_URL(13), path: "src/checkout.ts", line: 30 },
        ],
      }),
      aRequestChanges(9, at(25), { body: "", lineComments: [{ comment: 15, url: LINE_URL(15), path: "src/banner.ts", line: null }] }),
    ]);
  });

  it("marks the Request changes it is told were deferred during a Retry", async () => {
    const { client } = gitHub({
      reviews: [
        { id: 8, user: OPERATOR, state: "CHANGES_REQUESTED", submitted_at: at(20) },
        { id: 9, user: OPERATOR, state: "CHANGES_REQUESTED", submitted_at: at(25) },
      ],
    });

    expect((await readDigestThread(client, repo, 50, "olive", [9])).requestChanges).toEqual([aRequestChanges(8, at(20)), aRequestChanges(9, at(25), { deferred: true })]);
  });

  it("reads every page of the comments, of the line comments and of the reviews", async () => {
    const { client, calls } = gitHub();

    await readDigestThread(client, repo, 50, "olive", NONE_DEFERRED);

    expect(calls.toSorted()).toEqual([
      "GET /repos/acme/shop/issues/50/comments?per_page=100&page=1",
      "GET /repos/acme/shop/pulls/50/comments?per_page=100&page=1",
      "GET /repos/acme/shop/pulls/50/reviews?per_page=100&page=1",
      'graphql {"owner":"acme","name":"shop","number":50}',
    ]);
  });
});

describe("What the push job hands the Digest's contract", () => {
  const written = { repoUrl: "https://github.com/acme/shop", pullRequest: 50, headSha: HEAD, runUrl: RUN, operator: "olive", output: JSON.stringify(aDigestReply()) };
  const thread: Thread = {
    comments: [
      { user: BOT, body: FLAW, created_at: at(5) },
      { user: BOT, body: RETRY_PUSH, created_at: at(10) },
      { user: BOT, body: `@olive The Review on #50 failed: it crashed.\n${handBackMarker({ kind: "infrastructure-failure", role: "review", failure: "crash" })}`, created_at: at(12) },
      { user: BOT, body: PASS, created_at: at(15) },
    ],
    reviews: [{ id: 8, user: OPERATOR, state: "CHANGES_REQUESTED", submitted_at: at(3) }],
  };

  it("is the repo's address, the pull request, the head and the run's link, as the push job knows them, with Kit code's facts from its own read of the thread", async () => {
    const given = await readDigestGiven(gitHub(thread).client, repo, written);

    expect(given).toMatchObject({ repoUrl: "https://github.com/acme/shop", pullRequest: 50, headSha: HEAD, runUrl: RUN });
    expect(Object.keys(given).toSorted()).toEqual(["facts", "head", "headSha", "pullRequest", "repoUrl", "runUrl"]);
    expect(given.facts.rounds.map(({ who, what }) => `${who}: ${what}`)).toEqual([
      "implementer: first-run",
      "operator: request-changes",
      "reviewer: execution-flaw",
      "implementer: retry",
      "kit: infrastructure-failure",
      "reviewer: pass",
    ]);
    expect(given.facts).toMatchObject({ retriesLeft: 1, followUps: [], productCode: { kind: "not-established" } });
  });

  it("takes the repo's owner for the Operator when the Kit config names none, as the Loop's snapshot does", async () => {
    const owners = { ...thread, reviews: [{ id: 8, user: { login: "acme", type: "User" }, state: "CHANGES_REQUESTED", submitted_at: at(3) }] };

    expect((await readDigestGiven(gitHub(owners).client, repo, { ...written, operator: null })).facts.counts.requestChanges).toBe(1);
    expect((await readDigestGiven(gitHub(thread).client, repo, { ...written, operator: null })).facts.counts.requestChanges).toBe(0);
  });

  it("lists the asks from its own read: each Request changes and line comment the Reviewer is given, and none the Loop's snapshot reads as deferred during a Retry", async () => {
    // The first Request changes came before any Verdict. The second came on the draft after the Execution flaw, while its Retry was in flight.
    const deferring: Thread = {
      comments: [
        { user: BOT, body: FLAW, created_at: at(5) },
        { user: BOT, body: PASS, created_at: at(15) },
      ],
      reviews: [
        { id: 8, user: OPERATOR, state: "CHANGES_REQUESTED", submitted_at: at(3) },
        { id: 9, user: OPERATOR, state: "CHANGES_REQUESTED", submitted_at: at(7) },
      ],
      lineComments: [
        { id: 12, user: OPERATOR, pull_request_review_id: 8, path: "src/cart.ts", line: 12, created_at: at(2) },
        { id: 13, user: OPERATOR, pull_request_review_id: 9, path: "src/coupon.ts", line: 4, created_at: at(6) },
      ],
    };

    const given = await readDigestGiven(gitHub(deferring).client, repo, written);

    expect(given.facts.asks).toEqual([
      { id: "review-8", what: "request-changes", url: REVIEW_URL(8) },
      { id: "inline-12", what: "line-comment", url: LINE_URL(12), path: "src/cart.ts", line: 12 },
    ]);
  });

  it("is what the contract renders a Digest from, beside the writer's reply", async () => {
    const given = await readDigestGiven(gitHub(thread).client, repo, written);
    const comment = digestCommentOf(aDigestReply({ asks: [{ id: "review-8", answer: "in-head", where: "src/basket/save.ts", checkedBy: "reading" }] }), given);

    expect(comment).toMatchObject({ ok: true, body: expect.stringContaining(`[The run](${RUN})`) });
    expect(comment).toMatchObject({ body: expect.stringContaining("| The Kit | An Infrastructure failure | |") });
    expect(comment).toMatchObject({ body: expect.stringContaining(`| Your [Request changes](${REVIEW_URL(8)}) | In the head | Reading | src/basket/save.ts |`) });
  });

  it("is what the contract refuses a reply against: one that skips an ask the push job read", async () => {
    const given = await readDigestGiven(gitHub(thread).client, repo, written);

    expect(digestCommentOf(aDigestReply(), given)).toEqual({ ok: false, refused: "the reply left an ask unanswered: `review-8`" });
  });

  describe("of the head, for the places the writer's reply names", () => {
    const PATCH = "@@ -1,2 +1,2 @@\n export const hours = 24;\n-export const day = 12;\n+export const day = hours;";
    const held: Thread = {
      ...thread,
      reviews: [],
      files: [{ filename: "src/basket/save.ts", status: "modified", patch: PATCH }],
      texts: { "src/basket/save.ts": "export const hours = 24;\nexport const day = hours;\n" },
    };
    const item = (places: DigestReply["items"][number]["places"]): DigestReply["items"][number] => ({
      kind: "yours-to-judge",
      claim: "Prices hold for 24 hours.",
      sentence: "The Ticket said for a while.",
      asks: [],
      places,
      suggestedRequest: null,
    });
    const reply = aDigestReply({
      items: [item([{ path: "src/basket/save.ts", start: 1, end: 2, as: "code" }]), item([{ path: "src/basket/gone.ts", start: 4, end: 4, as: "words" }])],
    });

    it("is each named file's text at the head the Digest is written as of, and the pull request's files", async () => {
      const { client, calls } = gitHub(held);

      const given = await readDigestGiven(client, repo, { ...written, output: JSON.stringify(reply) });

      expect(given.head).toEqual({
        files: [
          { path: "src/basket/save.ts", text: "export const hours = 24;\nexport const day = hours;\n" },
          { path: "src/basket/gone.ts", text: null },
        ],
        changed: [{ path: "src/basket/save.ts", patch: PATCH }],
      });
      expect(calls.filter((call) => call.startsWith("text ")).toSorted()).toEqual([`text src/basket/gone.ts@${HEAD}`, `text src/basket/save.ts@${HEAD}`]);
    });

    it("is what the contract checks each place against: one in the head lands with its link, and one in a file the head lacks is dropped", async () => {
      const given = await readDigestGiven(gitHub(held).client, repo, { ...written, output: JSON.stringify(reply) });
      const comment = digestCommentOf(reply, given);

      expect(comment).toMatchObject({
        ok: true,
        body: expect.stringContaining(`[\`src/basket/save.ts\`, lines 1 to 2](https://github.com/acme/shop/blob/${HEAD}/src/basket/save.ts?plain=1#L1-L2)`),
      });
      expect(comment).toMatchObject({ body: expect.not.stringContaining("gone.ts") });
    });

    it.each([
      ["names no place", JSON.stringify(aDigestReply())],
      ["breaks its shape, which Kit code refuses", JSON.stringify({ items: reply.items })],
      ["is no JSON", "<digest>"],
    ])("reads nothing of the head for a reply that %s", async (_what, output) => {
      const { client, calls } = gitHub(held);

      expect((await readDigestGiven(client, repo, { ...written, output })).head).toEqual({ files: [], changed: [] });
      expect(calls.filter((call) => call.startsWith("text ") || call.includes("/pulls/50/files"))).toEqual([]);
    });
  });
});
