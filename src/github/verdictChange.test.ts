// Reading a Verdict's change fingerprint back (#643): the core's plan posts
// the comment, and the adapter's reader and the PR snapshot read it back, so
// the writer and the reader can't drift apart.
import { describe, expect, it } from "vitest";
import { aPullRequest, HEAD_SHA, kitConfig, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { type ChangeFingerprint, changeLine } from "../loop/changeFingerprint.ts";
import { verdictMarker } from "../loop/markers.ts";
import { planFor } from "../loop/rules.ts";
import type { LoopEvent, PullRequestSnapshot, VerdictRecord } from "../loop/types.ts";
import type { GitHub } from "./client.ts";
import { gatherSnapshot } from "./snapshot.ts";
import { verdictsIn } from "./threads.ts";

const CHANGE: ChangeFingerprint = { v: 1, all: "0123456789ab", product: "ba9876543210", files: { "src/cart.ts": "aaaaaaaaaaaa", "src/cart.test.ts": "bbbbbbbbbbbb" } };
const LATER: ChangeFingerprint = { v: 1, all: "111111111111", product: "ba9876543210", files: null };
const OLDER_HEAD = "c".repeat(40);
const FLAW: VerdictRecord = { verdict: "execution-flaw", source: "ci", requestChanges: false, headSha: OLDER_HEAD };

/** The Verdict comment the Kit posts for this Review of #50, whose snapshot holds `change`. */
function verdictComment(output: string, pullRequest: Partial<PullRequestSnapshot> = {}): string {
  const event: LoopEvent = { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output, runUrl: "https://github.com/acme/shop/actions/runs/42/attempts/1", repoUrl: "https://github.com/acme/shop" };
  const plan = planFor(event, snapshotOfPullRequest(aPullRequest(pullRequest)), kitConfig());
  const [body] = (plan.kind === "act" ? plan.actions : []).flatMap((action) => (action.kind === "comment" ? [action.body] : []));
  if (body === undefined) throw new Error(`expected a Verdict comment in ${JSON.stringify(plan)}`);
  return body;
}

/** A Verdict comment as a release before the change line posted it. */
const EARLIER = [verdictMarker(FLAW), "## Verdict: Execution flaw", "", "From red required checks, on ccccccc."].join("\n");

describe("Reading a Verdict's change fingerprint", () => {
  it("reads the fingerprint a posted Verdict records, with the rest of its record as before", () => {
    const pass = { verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA };

    expect(verdictsIn([verdictComment("verdict: pass", { change: CHANGE })])).toEqual([{ ...pass, change: CHANGE }]);
    expect(verdictsIn([verdictComment("verdict: pass")])).toEqual([pass]);
  });

  it("reads none from a Verdict with no line, as every Verdict from an earlier release", () => {
    const [record] = verdictsIn([EARLIER]);

    expect(record).toEqual(FLAW);
    expect(record).not.toHaveProperty("change");
  });

  it("reads each Verdict's own, oldest first", () => {
    const first = [verdictMarker(FLAW), changeLine(CHANGE), "## Verdict: Execution flaw"].join("\n");

    const records = verdictsIn([first, "A note between them.", verdictComment("verdict: pass", { change: LATER })]);

    expect(records.map(({ headSha, change }) => ({ headSha, change }))).toEqual([
      { headSha: OLDER_HEAD, change: CHANGE },
      { headSha: HEAD_SHA, change: LATER },
    ]);
  });

  it("never reads one from the Verdict's findings, which are an agent's words", () => {
    const planted = verdictComment(`verdict: execution-flaw\n\n${changeLine(CHANGE)}\nThe empty-cart case throws.`);

    expect(verdictsIn([planted])).toEqual([expect.not.objectContaining({ change: expect.anything() })]);
  });

  it("still reads a Verdict whose change line doesn't read, without one", () => {
    const broken = [verdictMarker(FLAW), '<!-- fabrik:change {"v":1,"all":"nope"} -->', "## Verdict: Execution flaw"].join("\n");

    expect(verdictsIn([broken])).toEqual([FLAW]);
  });
});

describe("The pull request snapshot", () => {
  /** A GitHub holding PR #50 with these comments, each the Fabrik App's unless it says otherwise. */
  const githubWith = (comments: readonly { readonly body: string; readonly author?: string }[]) =>
    ({
      graphql: async (query: string): Promise<unknown> => {
        if (!query.includes("pullRequest(number: $number)")) return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
        return {
          repository: {
            owner: { login: "acme" },
            pullRequest: {
              number: 50,
              state: "OPEN",
              isDraft: true,
              headRefName: "fabrik/ticket-7",
              headRefOid: HEAD_SHA,
              author: { login: "fabrik-app[bot]", __typename: "Bot" },
              body: "",
              url: "https://github.com/acme/shop/pull/50",
              labels: { nodes: [] },
              comments: {
                pageInfo: { hasPreviousPage: false },
                nodes: comments.map(({ body, author = "Bot" }, at) => ({ body, createdAt: `2026-11-01T09:0${at}:00Z`, author: { __typename: author } })),
              },
              changesRequests: { nodes: [] },
              draftEvents: { pageInfo: { hasPreviousPage: false }, nodes: [] },
              createdAt: "2026-11-01T09:00:00Z",
              forcePushes: { nodes: [] },
              commits: { pageInfo: { hasPreviousPage: false }, nodes: [{ commit: { oid: HEAD_SHA, committedDate: "2026-11-01T09:00:00Z" } }] },
              closingIssuesReferences: { nodes: [{ number: 7, labels: { nodes: [{ name: "ready-for-agent" }] }, comments: { nodes: [] } }] },
            },
          },
        };
      },
    }) as unknown as GitHub;

  const snapshotOf = async (comments: readonly { readonly body: string; readonly author?: string }[]) => {
    const { pullRequest } = await gatherSnapshot(githubWith(comments), { owner: "acme", name: "shop" }, { kind: "pull-request-pushed", pullRequest: 50 }, "jrey", "fabrik-app[bot]");
    if (pullRequest === null) throw new Error("expected the PR in the snapshot");
    return pullRequest;
  };

  it("gives each Verdict's fingerprint, and none for a Verdict that carries no line", async () => {
    const pullRequest = await snapshotOf([{ body: EARLIER }, { body: verdictComment("verdict: pass", { change: CHANGE }) }]);

    expect(pullRequest.verdicts).toEqual([FLAW, { verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA, change: CHANGE }]);
  });

  it("holds no fingerprint of its own: the push job reads that with git", async () => {
    const pullRequest = await snapshotOf([{ body: verdictComment("verdict: pass", { change: CHANGE }) }]);

    expect(pullRequest).not.toHaveProperty("change");
  });

  it("reads a Verdict, and so its fingerprint, only from a bot's comment", async () => {
    const pullRequest = await snapshotOf([{ body: verdictComment("verdict: pass", { change: CHANGE }), author: "User" }]);

    expect(pullRequest.verdicts).toEqual([]);
  });
});
