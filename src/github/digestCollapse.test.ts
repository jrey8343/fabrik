import { describe, expect, it } from "vitest";
import { aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { aPullRequest, HEAD_SHA, kitConfig, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { digestCommentOf, digestMarkIn, noDigestLine } from "../loop/digestContract.ts";
import { verdictMarker } from "../loop/markers.ts";
import { planFor } from "../loop/rules.ts";
import type { DigestOnThread, Plan } from "../loop/types.ts";
import { applyPlan } from "./apply.ts";
import { type GitHub, GitHubError } from "./client.ts";
import { describeRefusedCollapses } from "./describePlan.ts";
import { gatherSnapshot } from "./snapshot.ts";

const repo = { owner: "acme", name: "shop" };
const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const EARLIER_HEAD = "b".repeat(40);

const REPLY = aDigestReply();

/** A Digest comment's body, written as of `head`. */
function aDigestBody(head: string): string {
  const rendered = digestCommentOf(REPLY, aDigestGiven({ headSha: head }));
  if (!rendered.ok) throw new Error(rendered.refused);
  return rendered.body;
}

/** The plan the Loop makes when the Digest writer finishes on #50, a passed draft with these Digests on its thread. */
function landingPlan(digests: readonly DigestOnThread[]): Plan {
  const pullRequest = aPullRequest({
    draft: true,
    leftDraftSinceVerdict: false,
    labels: ["agent:digest"],
    verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }],
    digests,
  });
  return planFor(
    {
      kind: "digest-run-finished",
      pullRequest: 50,
      headSha: HEAD_SHA,
      output: JSON.stringify(REPLY),
      given: aDigestGiven(),
      runUrl: RUN,
    },
    snapshotOfPullRequest(pullRequest, { operator: "jrey" }),
    kitConfig(),
  );
}

function onThread(node: string, minimized = false): DigestOnThread {
  return { node, minimized, body: aDigestBody(EARLIER_HEAD), postedAt: "2026-11-10T09:00:00Z" };
}

const MINIMIZE = /^\s*mutation\b[^]*\bminimizeComment\(/;

/**
 * A GitHub that records each call in the order it is made, by what it does.
 * It refuses to collapse each comment in `refusing`, as GitHub does a call
 * its token may not make.
 */
function fakeGitHub(refusing: readonly string[] = []) {
  const calls: string[] = [];
  const collapsed: { query: string; variables: Record<string, unknown> }[] = [];
  return {
    calls,
    collapsed,
    async rest(method: string, path: string): Promise<unknown> {
      if (method === "POST" && path.endsWith("/issues/50/comments")) {
        calls.push("post the comment");
        return { id: 9300, html_url: "https://github.com/acme/shop/pull/50#issuecomment-9300" };
      }
      if (method === "DELETE" && path.endsWith("/issues/50/labels/agent%3Adigest")) calls.push("take agent:digest off");
      if (method === "GET" && path.endsWith("/pulls/50")) return { node_id: "PR_50" };
      if (method === "POST" && path.endsWith("/pulls/50/requested_reviewers")) calls.push("request the review");
      return null;
    },
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      if (MINIMIZE.test(query)) {
        const node = String(variables["id"]);
        calls.push(`collapse ${node}`);
        collapsed.push({ query, variables });
        if (refusing.includes(node)) {
          throw new GitHubError("GitHub GraphQL query failed: Resource not accessible by integration", 403, {
            body: JSON.stringify({ errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] }),
            request: "POST /graphql",
          });
        }
        return { minimizeComment: { minimizedComment: { isMinimized: true } } } as T;
      }
      if (query.includes("markPullRequestReadyForReview")) calls.push("take it out of draft");
      return {} as T;
    },
  };
}

describe("Collapsing older Digests, as the push job applies it (ADR-0022)", () => {
  it("makes one minimizeComment call for the first Digest, as OUTDATED, after the second is posted and before the gate opens", async () => {
    const github = fakeGitHub();

    const applied = await applyPlan(github, repo, landingPlan([onThread("IC_first")]));

    expect(github.calls).toEqual(["post the comment", "collapse IC_first", "take agent:digest off", "take it out of draft", "request the review"]);
    expect(github.collapsed.map(({ variables }) => variables)).toEqual([{ id: "IC_first", classifier: "OUTDATED" }]);
    expect(github.collapsed[0]?.query).toContain("minimizeComment(input: { subjectId: $id, classifier: $classifier })");
    expect(applied.refusedCollapses).toEqual([]);
  });

  it("with two older Digests, one collapsed already, makes exactly one call", async () => {
    const github = fakeGitHub();

    await applyPlan(github, repo, landingPlan([onThread("IC_first", true), onThread("IC_second")]));

    expect(github.collapsed.map(({ variables }) => variables)).toEqual([{ id: "IC_second", classifier: "OUTDATED" }]);
  });

  it("a refused call stops nothing: the remaining calls are still made, the gate still opens and nothing is thrown", async () => {
    const github = fakeGitHub(["IC_first"]);

    const applied = await applyPlan(github, repo, landingPlan([onThread("IC_first"), onThread("IC_second")]));

    expect(github.calls).toEqual([
      "post the comment",
      "collapse IC_first",
      "collapse IC_second",
      "take agent:digest off",
      "take it out of draft",
      "request the review",
    ]);
    expect(applied.refusedCollapses).toEqual([{ pullRequest: 50, node: "IC_first", why: "Resource not accessible by integration" }]);
  });

  it("names each refused call in the step summary, and adds nothing when none was refused", () => {
    expect(describeRefusedCollapses([{ pullRequest: 50, node: "IC_first", why: "Resource not accessible by integration" }])).toEqual([
      "- GitHub refused to collapse an older Digest on #50 (comment IC_first) as outdated: Resource not accessible by integration. Nothing else was held up: the current Digest is found by its head either way",
    ]);
    expect(describeRefusedCollapses([])).toEqual([]);
  });
});

/** A comment on #50's thread, as GitHub holds it. */
interface HeldComment {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly isMinimized: boolean;
  readonly author: { readonly __typename: string };
}

const BOT = { __typename: "Bot" };

function held(id: string, body: string, createdAt: string, overrides: Partial<HeldComment> = {}): HeldComment {
  return { id, body, createdAt, isMinimized: false, author: BOT, ...overrides };
}

/**
 * A GitHub holding #50, an agent pull request with this thread, oldest
 * first, served `pageSize` comments at a time, newest page first. It answers
 * only the fields of a comment the query selects, as GitHub does.
 */
function gitHubHolding(thread: readonly HeldComment[], pageSize = 100): GitHub {
  const page = (query: string, end: number) => {
    const selection = /comments\(last: 100[^)]*\) \{[^]*?nodes \{([^]*?)\}\s*\}/.exec(query)?.[1] ?? "";
    const selects = (field: string) => new RegExp(`\\b${field}\\b`).test(selection);
    const start = Math.max(0, end - pageSize);
    return {
      pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
      nodes: thread.slice(start, end).map(({ id, body, createdAt, isMinimized, author }) => ({
        body,
        createdAt,
        author,
        ...(selects("id") ? { id } : {}),
        ...(selects("isMinimized") ? { isMinimized } : {}),
      })),
    };
  };
  return {
    async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
      if (!query.includes("pullRequest(number: $number)")) return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      if ("before" in variables) return { repository: { pullRequest: { comments: page(query, Number(variables["before"])) } } };
      return {
        repository: {
          owner: { login: "acme" },
          pullRequest: {
            number: 50,
            state: "OPEN",
            isDraft: true,
            headRefName: "fabrik/ticket-7",
            headRefOid: HEAD_SHA,
            author: { login: "fabrik-app", __typename: "Bot" },
            body: "Saves the cart.\n\nCloses #7",
            url: "https://github.com/acme/shop/pull/50",
            labels: { nodes: [{ name: "agent:digest" }] },
            comments: page(query, thread.length),
            changesRequests: { nodes: [] },
            draftEvents: { pageInfo: { hasPreviousPage: false }, nodes: [] },
            createdAt: "2026-11-01T09:00:00Z",
            forcePushes: { nodes: [] },
            commits: { pageInfo: { hasPreviousPage: false }, nodes: [] },
            closingIssuesReferences: { nodes: [] },
          },
        },
      };
    },
  } as unknown as GitHub;
}

describe("Reading the Digests on a pull request's thread (ADR-0022)", () => {
  /** What a Digest run's push job reads of #50 before it lands. */
  async function digestsOn(github: GitHub) {
    const landing = {
      kind: "digest-run-finished",
      pullRequest: 50,
      headSha: HEAD_SHA,
      output: "{}",
      given: aDigestGiven(),
      runUrl: RUN,
    } as const;
    return (await gatherSnapshot(github, repo, landing, null, "fabrik-app[bot]")).pullRequest?.digests;
  }

  const FIRST = aDigestBody(EARLIER_HEAD);
  const SECOND = aDigestBody(HEAD_SHA);

  it("reads each Digest's node id and whether it is minimized, oldest first", async () => {
    const digests = await digestsOn(
      gitHubHolding([
        held("IC_first", FIRST, "2026-11-10T09:00:00Z", { isMinimized: true }),
        held("IC_second", SECOND, "2026-11-11T09:00:00Z"),
      ]),
    );

    expect(digests).toEqual([
      { node: "IC_first", minimized: true, body: FIRST, postedAt: "2026-11-10T09:00:00Z" },
      { node: "IC_second", minimized: false, body: SECOND, postedAt: "2026-11-11T09:00:00Z" },
    ]);
  });

  it("a collapsed Digest still reads back whole, by the reader of the Digest's comment", async () => {
    const digests = await digestsOn(gitHubHolding([held("IC_first", FIRST, "2026-11-10T09:00:00Z", { isMinimized: true })]));

    expect(digests?.[0]?.body).toBe(FIRST);
    expect(digestMarkIn(digests?.[0]?.body ?? "")).toEqual({ head: EARLIER_HEAD, asks: [], carriedFrom: null });
  });

  it("only Digests: a no-Digest line, a Verdict, any other comment of the Kit's and a person's quoting a Digest are never among them", async () => {
    const digests = await digestsOn(
      gitHubHolding([
        held("IC_verdict", `${verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: EARLIER_HEAD })}\nVerdict: pass`, "2026-11-10T08:00:00Z"),
        held("IC_digest", FIRST, "2026-11-10T09:00:00Z"),
        held("IC_no_digest", noDigestLine({ head: HEAD_SHA, how: "timed-out", runUrl: RUN }), "2026-11-11T09:00:00Z"),
        held("IC_note", "The Kit rebased this branch onto `main`.", "2026-11-11T10:00:00Z"),
        held("IC_quoted", FIRST, "2026-11-11T11:00:00Z", { author: { __typename: "User" } }),
        held("IC_mid_comment", `See the last one:\n${FIRST}`, "2026-11-11T12:00:00Z"),
      ]),
    );

    expect(digests?.map(({ node }) => node)).toEqual(["IC_digest"]);
  });

  it("reads the same of a Digest on an earlier page of a long thread", async () => {
    const digests = await digestsOn(
      gitHubHolding(
        [
          held("IC_first", FIRST, "2026-11-10T09:00:00Z", { isMinimized: true }),
          held("IC_note", "The Kit rebased this branch onto `main`.", "2026-11-11T08:00:00Z"),
          held("IC_second", SECOND, "2026-11-11T09:00:00Z"),
        ],
        2,
      ),
    );

    expect(digests?.map(({ node, minimized }) => ({ node, minimized }))).toEqual([
      { node: "IC_first", minimized: true },
      { node: "IC_second", minimized: false },
    ]);
  });
});
