import { describe, expect, it } from "vitest";
import { aDigestReply } from "../__fixtures__/digests.ts";
import { digestCommentOf } from "../loop/digestContract.ts";
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

interface Thread {
  readonly comments?: readonly { user: unknown; body: string; created_at: string }[];
  readonly reviews?: readonly { id: number; user: unknown; state: string; submitted_at?: string | null }[];
  readonly headRefName?: string;
  /** The issues the pull request closes, each with its comments as GraphQL gives them. */
  readonly closes?: readonly { number: number; comments: readonly { body: string; author: { login: string; __typename: string } | null }[] }[];
}

/** #50 of acme/shop as GitHub answers for it, and every call the read made, in order. */
function gitHub({ comments = [], reviews = [], headRefName = "fabrik/ticket-7", closes = [] }: Thread = {}): { client: ReadClient; calls: string[] } {
  const calls: string[] = [];
  const client: ReadClient = {
    graphql: async <T>(_query: string, variables: Record<string, unknown>) => {
      calls.push(`graphql ${JSON.stringify(variables)}`);
      const closingIssuesReferences = { nodes: closes.map(({ number, comments: nodes }) => ({ number, comments: { nodes } })) };
      return { repository: { pullRequest: { createdAt: at(0), headRefName, closingIssuesReferences } } } as T;
    },
    rest: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      const [route, query] = path.split("?");
      if (!/(^|&)page=1(&|$)/.test(query ?? "")) return [];
      if (route === "/repos/acme/shop/issues/50/comments") return comments;
      if (route === "/repos/acme/shop/pulls/50/reviews") return reviews;
      throw new Error(`unexpected REST call ${path}`);
    },
    fileText: () => Promise.reject(new Error("the thread's read read a file")),
  };
  return { client, calls };
}

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

    expect(await readDigestThread(client, repo, 50, "olive")).toEqual({
      openedAt: at(0),
      kitComments: [
        { at: at(5), body: FLAW },
        { at: at(10), body: RETRY_PUSH },
        { at: at(15), body: PASS },
      ],
      requestChanges: [{ review: 8, at: at(20), dismissed: false }],
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

    expect(await readDigestThread(client, repo, 50, "olive")).toMatchObject({ kitComments: [{ at: at(15), body: PASS }], landedNothing: 0 });
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

    expect((await readDigestThread(client, repo, 50, "olive")).requestChanges).toEqual([
      { review: 3, at: at(3), dismissed: true },
      { review: 7, at: at(7), dismissed: false },
    ]);
  });

  it("counts what the Ticket's runs landed only on the Ticket the branch names, and only while the pull request links it", async () => {
    const landedOnAnother = [{ number: 9, comments: [{ body: EMPTY_DIFF, author: { login: "fabrik-app", __typename: "Bot" } }] }];

    expect(await readDigestThread(gitHub({ closes: landedOnAnother }).client, repo, 50, "olive")).toMatchObject({ landedNothing: 0 });
    expect(await readDigestThread(gitHub({ headRefName: "feature/cart", closes: landedOnAnother }).client, repo, 50, "olive")).toMatchObject({ landedNothing: 0 });
  });

  it("reads every page of the comments and of the reviews", async () => {
    const { client, calls } = gitHub();

    await readDigestThread(client, repo, 50, "olive");

    expect(calls.toSorted()).toEqual([
      "GET /repos/acme/shop/issues/50/comments?per_page=100&page=1",
      "GET /repos/acme/shop/pulls/50/reviews?per_page=100&page=1",
      'graphql {"owner":"acme","name":"shop","number":50}',
    ]);
  });
});

describe("What the push job hands the Digest's contract", () => {
  const written = { repoUrl: "https://github.com/acme/shop", pullRequest: 50, headSha: HEAD, runUrl: RUN, operator: "olive" };
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
    expect(Object.keys(given).toSorted()).toEqual(["facts", "headSha", "pullRequest", "repoUrl", "runUrl"]);
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

  it("is what the contract renders a Digest from, beside the writer's reply", async () => {
    const given = await readDigestGiven(gitHub(thread).client, repo, written);
    const comment = digestCommentOf(aDigestReply(), given);

    expect(comment).toMatchObject({ ok: true, body: expect.stringContaining(`[The run](${RUN})`) });
    expect(comment).toMatchObject({ body: expect.stringContaining("| The Kit | An Infrastructure failure | |") });
  });
});
