// A Verdict's change line is kept from agents (#643): it is up to a few
// thousand characters of hashes and says nothing to them. These tests post a
// Verdict as the core writes it, serve it as GitHub would, and read what a
// Retry and a Design session are given of it.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aPullRequest, HEAD_SHA, kitConfig, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { type ChangeFingerprint, changeIn, changeLine } from "../loop/changeFingerprint.ts";
import { verdictMarker } from "../loop/markers.ts";
import { planFor } from "../loop/rules.ts";
import { retryContext } from "./implement.ts";
import { type Reader, readPullRequest, readSentBack } from "./inputs.ts";

const repo = { owner: "acme", name: "shop" };
const CHANGE: ChangeFingerprint = { v: 1, all: "0123456789ab", product: "ba9876543210", files: { "src/cart.ts": "aaaaaaaaaaaa", "src/cart.test.ts": "bbbbbbbbbbbb" } };

/** The Verdict comment the Kit posts for a Review of #50 that found a flaw, with the fingerprint on its second line. */
function postedVerdict(): string {
  const plan = planFor(
    {
      kind: "review-run-finished",
      pullRequest: 50,
      headSha: HEAD_SHA,
      output: "verdict: execution-flaw\n\nThe empty-cart case throws.",
      runUrl: "https://github.com/acme/shop/actions/runs/42/attempts/1",
      repoUrl: "https://github.com/acme/shop",
    },
    snapshotOfPullRequest(aPullRequest({ change: CHANGE })),
    kitConfig(),
  );
  const [body] = (plan.kind === "act" ? plan.actions : []).flatMap((action) => (action.kind === "comment" ? [action.body] : []));
  if (body === undefined || changeIn(body) === null) throw new Error(`expected a Verdict comment with a change line in ${JSON.stringify(plan)}`);
  return body;
}

const VERDICT = postedVerdict();
/** That Verdict as it read before the line: every line but its second. */
const VERDICT_WITHOUT = VERDICT.split("\n")
  .filter((_line, at) => at !== 1)
  .join("\n");
/** A Verdict from a release before the line. */
const EARLIER = [verdictMarker({ verdict: "execution-flaw", source: "ci", requestChanges: false, headSha: "c".repeat(40) }), "## Verdict: Execution flaw", "", "These required checks didn't pass."].join("\n");

const bot = { login: "fabrik-app[bot]", type: "Bot" };
const operator = { login: "operator", type: "User" };
const thread = [
  { id: 1, user: bot, body: EARLIER, created_at: "2026-11-01T00:00:00Z", html_url: "https://github.com/acme/shop/pull/50#issuecomment-1" },
  { id: 2, user: operator, body: "Is this nearly there?", created_at: "2026-11-01T01:00:00Z", html_url: "https://github.com/acme/shop/pull/50#issuecomment-2" },
  { id: 3, user: bot, body: VERDICT, created_at: "2026-11-02T00:00:00Z", html_url: "https://github.com/acme/shop/pull/50#issuecomment-3" },
];

/** GitHub as an input step reads PR #50 and its thread. */
const github: Reader = {
  graphql: async <T>() =>
    ({
      repository: {
        pullRequest: {
          number: 50,
          title: "Handle the empty cart",
          body: "Shows the empty state.\n\nCloses #7",
          baseRefName: "main",
          headRefName: "fabrik/ticket-7",
          headRefOid: HEAD_SHA,
          comments: { nodes: thread.map(({ body, user }) => ({ body, author: { __typename: user.type } })) },
        },
      },
    }) as T,
  rest: async (_method: string, path: string) => {
    const [route, query] = path.split("?");
    if (route === "/repos/acme/shop/pulls/50") return { number: 50, title: "Handle the empty cart", base: { ref: "main" }, head: { ref: "fabrik/ticket-7", sha: HEAD_SHA } };
    if (!/(^|&)page=1(&|$)/.test(query ?? "")) return [];
    return route === "/repos/acme/shop/issues/50/comments" ? thread : [];
  },
};

describe("A Retry's input", () => {
  it("carries the PR's Verdicts without their change line, each marker still first", async () => {
    const read = (await readPullRequest(github, repo, 50, { withComments: true, operator: "operator" })) as { comments: { body: string; author: unknown }[] };

    expect(read.comments).toEqual([
      { body: EARLIER, author: { __typename: "Bot" } },
      { body: "Is this nearly there?", author: { __typename: "User" } },
      { body: VERDICT_WITHOUT, author: { __typename: "Bot" } },
    ]);
    expect(JSON.stringify(read)).not.toContain("fabrik:change");
  });

  it("still finds the latest Verdict to fix, and its prompt holds none of the line", async () => {
    const read = await readPullRequest(github, repo, 50, { withComments: true, operator: "operator" });
    const path = join(await mkdtemp(join(tmpdir(), "fabrik-verdict-change-")), "pull-request.json");
    await writeFile(path, JSON.stringify(read));

    const text = (await retryContext(path)).parts.join("\n");

    expect(text).toContain(VERDICT_WITHOUT.trimEnd());
    expect(text).toContain("The empty-cart case throws.");
    expect(text).not.toContain("fabrik:change");
    expect(text).not.toContain(CHANGE.all);
  });
});

describe("A Design session's sent-back input", () => {
  it("carries each Verdict's comment without its change line, and the Verdict as it read", async () => {
    const sentBack = (await readSentBack(github, repo, { pullRequest: 50, verdictUrl: "https://github.com/acme/shop/pull/50#issuecomment-3" }, "operator")) as {
      verdicts: unknown;
    };

    expect(sentBack.verdicts).toEqual([
      { verdict: "execution-flaw", source: "ci", headSha: "c".repeat(40), comment: EARLIER },
      { verdict: "execution-flaw", source: "reviewer", headSha: HEAD_SHA, comment: VERDICT_WITHOUT },
    ]);
    expect(JSON.stringify(sentBack)).not.toContain("fabrik:change");
    expect(JSON.stringify(sentBack)).not.toContain(changeLine(CHANGE).slice(0, 40));
  });
});
