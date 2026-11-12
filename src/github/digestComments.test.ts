import { describe, expect, it } from "vitest";
import { aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { digestCommentOf, noDigestLine } from "../loop/digestContract.ts";
import { verdictMarker } from "../loop/markers.ts";
import { leavingOutDigests, withoutDigests } from "./digestComments.ts";

const HEAD = "a".repeat(40);
const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

const rendered = digestCommentOf(aDigestReply(), aDigestGiven({ headSha: HEAD, runUrl: RUN }));
if (!rendered.ok) throw new Error(`the fixture reply was refused: ${rendered.refused}`);
/** A Digest comment and a no-Digest line, as the Kit posts them. */
const DIGEST = rendered.body;
const NO_DIGEST = noDigestLine({ head: HEAD, how: "timed-out", runUrl: RUN });

const BOT = { __typename: "Bot" };
const PERSON = { __typename: "User" };
const VERDICT = `${verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD })}\n## Verdict: Pass`;

describe("Leaving the Digest out of what an agent is given (ADR-0022)", () => {
  it("drops every comment of a bot's that is a Digest or a no-Digest line, at any depth, and keeps the rest in order", () => {
    const answer = {
      repository: {
        pullRequest: {
          body: "The PR's own body.",
          comments: {
            nodes: [
              { body: VERDICT, author: BOT },
              { body: DIGEST, author: BOT },
              { body: "Looks good to me.", author: PERSON },
              { body: NO_DIGEST, author: BOT },
              { body: "The Kit's note of a push.", author: BOT },
            ],
          },
        },
      },
    };

    expect(withoutDigests(answer)).toEqual({
      repository: {
        pullRequest: {
          body: "The PR's own body.",
          comments: {
            nodes: [
              { body: VERDICT, author: BOT },
              { body: "Looks good to me.", author: PERSON },
              { body: "The Kit's note of a push.", author: BOT },
            ],
          },
        },
      },
    });
  });

  it("drops one read without its author's kind too: a Digest must never be in what is handed over", () => {
    expect(withoutDigests({ nodes: [{ body: DIGEST }, { body: NO_DIGEST, author: { login: "fabrik-app" } }, { body: DIGEST, author: null }, { body: "A note." }] })).toEqual({
      nodes: [{ body: "A note." }],
    });
  });

  it("keeps a person's comment that opens with a Digest's hidden line, which is no Digest, and one that only quotes a Digest further down", () => {
    const nodes = [
      { body: DIGEST, author: PERSON },
      { body: `Quoting the Kit:\n\n${DIGEST}`, author: BOT },
      { body: `Quoting the Kit:\n\n${NO_DIGEST}`, author: BOT },
    ];

    expect(withoutDigests({ nodes })).toEqual({ nodes });
  });

  it("filters a client's GraphQL answers, and leaves its REST calls and private state as they are", async () => {
    class Client {
      readonly #token = "secret";
      async graphql<T>(_query: string, _variables: Record<string, unknown>): Promise<T> {
        return { nodes: [{ body: DIGEST, author: BOT }, { body: this.#token, author: BOT }] } as T;
      }
      async rest(): Promise<unknown> {
        return [{ body: DIGEST }];
      }
    }

    const github = leavingOutDigests(new Client());

    expect(await github.graphql("query", {})).toEqual({ nodes: [{ body: "secret", author: BOT }] });
    expect(await github.rest()).toEqual([{ body: DIGEST }]);
  });
});
