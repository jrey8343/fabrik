// No agent run is given a Digest (ADR-0022): a Digest comment and a no-Digest
// line on a pull request's thread are in none of the agents' inputs. Each
// test reads through the client the agent-inputs step reads through.
import { describe, expect, it } from "vitest";
import { aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { digestCommentOf, noDigestLine } from "../loop/digestContract.ts";
import { agentInputsClient, type DigestPullRequest, readDigestPullRequest, readIssue, readPullRequest, type Reader } from "./inputs.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const repo = { owner: "acme", name: "shop" };

const verdict = (verdict: string, headSha: string, rest: string) =>
  `<!-- fabrik:verdict {"verdict":"${verdict}","source":"reviewer","requestChanges":false,"headSha":"${headSha}"} -->\n## Verdict: ${rest}`;

const rendered = digestCommentOf(
  aDigestReply({ whatItDoes: "A shopper can now save their basket overnight.", decided: "- Prices hold for a day." }),
  aDigestGiven({ headSha: A, runUrl: RUN }),
);
if (!rendered.ok) throw new Error(`the fixture reply was refused: ${rendered.refused}`);

const PASS = verdict("pass", A, "Pass\n\n### Checked\n\nEvery criterion.");
/** The Digest written for the pass on A, and the line the Kit left when none could be written for B. */
const DIGEST = rendered.body;
const NO_DIGEST = noDigestLine({ head: B, how: "timed-out", runUrl: RUN });
const STARTED_NOTE = "<!-- fabrik:request-changes-run-started 8 -->\nThe Kit is starting the Request-changes run for your Request changes on #50.";
const PUSH_NOTE = "<!-- fabrik:request-changes-run -->\nThe Request-changes run pushed `bbbbbbb`.";
const FLAW = verdict("execution-flaw", B, "Execution flaw\n\nThe empty basket throws.");

/** What only a Digest or a no-Digest line says, hidden line or prose. */
const OF_A_DIGEST = ["fabrik:digest", "fabrik:no-digest", "save their basket overnight", "Prices hold for a day", "No Digest could be written"];

const BOT = { login: "fabrik-app[bot]", type: "Bot" };
const OPERATOR = { login: "operator", type: "User" };
const at = (day: number) => `2026-11-0${day}T00:00:00Z`;
const conversation = (id: number, user: { login: string; type: string }, body: string, day: number) => ({
  id,
  user,
  body,
  created_at: at(day),
  html_url: `https://github.com/acme/shop/pull/50#issuecomment-${id}`,
});

/** #50's thread, oldest first: a pass and its Digest, the Operator's Request changes and its run, the no-Digest line, then an Execution flaw. */
const THREAD = [
  conversation(1, BOT, PASS, 1),
  conversation(2, BOT, DIGEST, 1),
  conversation(3, OPERATOR, "Keep the copy short.", 2),
  conversation(4, BOT, STARTED_NOTE, 2),
  conversation(5, BOT, PUSH_NOTE, 3),
  conversation(6, BOT, NO_DIGEST, 3),
  conversation(7, BOT, FLAW, 4),
];

/** The Ticket's thread: the Kit's note that #50 sent it back to design on its last Verdict. */
const TICKET = {
  repository: {
    issue: {
      number: 7,
      title: "Save the basket",
      body: "As a shopper…",
      author: { login: "operator" },
      labels: { nodes: [{ name: "needs-design" }] },
      parent: null,
      comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            author: { login: "fabrik-app", __typename: "Bot" },
            body: "<!-- fabrik:back-to-design 50 https://github.com/acme/shop/pull/50#issuecomment-7 -->\n**Back to design.**",
            createdAt: at(5),
          },
        ],
      },
    },
  },
};

/** GitHub as the agent-inputs step reads it: #50 and its Ticket over GraphQL, #50's lists over REST. */
function gitHub(): Reader {
  const github: Reader = {
    graphql: async <T>(query: string) =>
      (query.includes("pullRequest(number: $number)")
        ? {
            repository: {
              pullRequest: {
                number: 50,
                title: "Save the basket",
                body: "Saves the basket.\n\nCloses #7",
                baseRefName: "main",
                headRefName: "fabrik/ticket-7",
                headRefOid: B,
                comments: { nodes: THREAD.map(({ body, user }) => ({ body, author: { __typename: user.type } })) },
                // What the read of the thread for Kit code's facts asks of it.
                createdAt: at(1),
                closingIssuesReferences: { nodes: [] },
              },
            },
          }
        : TICKET) as T,
    rest: async (_method: string, path: string) => {
      const [route, query] = path.split("?");
      if (route === "/repos/acme/shop/pulls/50") return { number: 50, title: "Save the basket", base: { ref: "main" }, head: { ref: "fabrik/ticket-7", sha: B } };
      if (!/(^|&)page=1(&|$)/.test(query ?? "")) return [];
      switch (route) {
        case "/repos/acme/shop/issues/50/comments":
          return THREAD;
        case "/repos/acme/shop/pulls/50/comments":
          return [];
        case "/repos/acme/shop/pulls/50/reviews":
          return [{ id: 8, user: OPERATOR, state: "CHANGES_REQUESTED", body: "Call it a basket.", submitted_at: at(2), html_url: "https://github.com/acme/shop/pull/50#pullrequestreview-8" }];
        case "/repos/acme/shop/pulls/50/commits":
          return [{ sha: B, commit: { message: "Save the basket" } }];
        case "/repos/acme/shop/pulls/50/files":
          return [{ filename: "src/basket.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const basket = [];" }];
        default:
          throw new Error(`unexpected REST call ${path}`);
      }
    },
  };
  return agentInputsClient(github);
}

/** Each thing only a Digest says that this input carries. */
function digestsIn(given: unknown): string[] {
  const text = JSON.stringify(given);
  return OF_A_DIGEST.filter((words) => text.includes(words));
}

describe("With a Digest and a no-Digest line on a pull request's thread, no agent's input carries either", () => {
  it("the thread itself holds both, so each input below is leaving them out", () => {
    expect(digestsIn(THREAD)).toEqual(OF_A_DIGEST);
  });

  it("a Retry's, a Request-changes run's and a conflict-only run's: the PR's comments are the rest of the thread, in order", async () => {
    const given = (await readPullRequest(gitHub(), repo, 50, { withComments: true, operator: "operator" })) as { comments: { body: string }[] };

    expect(digestsIn(given)).toEqual([]);
    expect(given.comments.map(({ body }) => body)).toEqual([PASS, "Keep the copy short.", STARTED_NOTE, PUSH_NOTE, FLAW]);
  });

  it("the Reviewer's, which carries no comments but the Operator's", async () => {
    const given = await readPullRequest(gitHub(), repo, 50, { withComments: false, operator: "operator" });

    expect(digestsIn(given)).toEqual([]);
    expect(given).not.toHaveProperty("comments");
    expect(given).toMatchObject({ operatorComments: [{ body: "Keep the copy short." }], requestedChanges: [{ body: "Call it a basket." }] });
  });

  it("the Digest writer's own: an earlier Digest is never among the Kit's notes it is given", async () => {
    const given: DigestPullRequest = await readDigestPullRequest(gitHub(), repo, 50, { operator: "operator" });

    expect(digestsIn(given)).toEqual([]);
    expect(given.kitNotes).toEqual([STARTED_NOTE, PUSH_NOTE]);
    expect(given.verdicts.map(({ comment }) => comment)).toEqual([PASS, FLAW]);
  });

  it("a Design session's, of the pull request sent back to it: its Verdicts and the Operator's words alone", async () => {
    const { issue } = await readIssue(gitHub(), repo, 7, "operator");
    const { sentBack } = issue as { sentBack: { verdicts: { comment: string }[]; operatorComments: { body: string }[] } };

    expect(digestsIn(issue)).toEqual([]);
    expect(sentBack.verdicts.map(({ comment }) => comment)).toEqual([PASS, FLAW]);
    expect(sentBack.operatorComments.map(({ body }) => body)).toEqual(["Keep the copy short."]);
  });
});
