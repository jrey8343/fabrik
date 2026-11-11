import { describe, expect, it } from "vitest";
import { leavingOutHeldLines, withoutHeldLines } from "./heldLines.ts";

const LINE = '<!-- fabrik:on-hold {"role":"triage"} -->\nThe Triage run is held on #41.';
const ENDED = '<!-- fabrik:on-hold-ended {"role":"triage"} -->\nWas held on #41 · resumed 2026-11-09 04:05 UTC';

describe("Leaving held lines out of what the Loop and the agents read (#471)", () => {
  it("drops every comment node that is a held line, waiting or ended, at any depth, and keeps the rest in order", () => {
    const answer = {
      repository: {
        issue: {
          body: "The issue's own body.",
          comments: {
            pageInfo: { hasPreviousPage: false },
            nodes: [{ body: "The Operator's reply." }, { body: LINE }, { body: "The Kit's round." }, { body: ENDED }],
          },
        },
      },
    };

    expect(withoutHeldLines(answer)).toEqual({
      repository: {
        issue: {
          body: "The issue's own body.",
          comments: { pageInfo: { hasPreviousPage: false }, nodes: [{ body: "The Operator's reply." }, { body: "The Kit's round." }] },
        },
      },
    });
  });

  it("keeps a held marker on a weekly-limit issue, which is the record, and a comment that only mentions a held line", () => {
    const nodes = [{ body: 'Held.\n\n<!-- fabrik:held {"issue":7,"role":"triage","label":"needs-triage"} -->' }, { body: `Quoting:\n${LINE}` }];

    expect(withoutHeldLines({ nodes })).toEqual({ nodes });
  });

  it("filters a client's GraphQL answers, and leaves its REST calls and private state as they are", async () => {
    class Client {
      readonly #token = "secret";
      async graphql<T>(_query: string, _variables: Record<string, unknown>): Promise<T> {
        return { nodes: [{ body: LINE }, { body: this.#token }] } as T;
      }
      async rest(): Promise<unknown> {
        return [{ body: LINE }];
      }
    }

    const github = leavingOutHeldLines(new Client());

    expect(await github.graphql("query", {})).toEqual({ nodes: [{ body: "secret" }] });
    expect(await github.rest()).toEqual([{ body: LINE }]);
  });
});
