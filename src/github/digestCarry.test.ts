// The Digest carried forward, as the push job applies it (ADR-0022): the
// files its places name are read at the new head, the carried comment is
// posted, the older Digests are collapsed and the gate opens, in the step
// that lands the pass. With the files unread, nothing is carried.
import { describe, expect, it } from "vitest";
import { aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { aPullRequest, HEAD_SHA, kitConfig, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import type { ChangeFingerprint } from "../loop/changeFingerprint.ts";
import { digestCommentOf, digestMarkIn, readDigestComment } from "../loop/digestContract.ts";
import type { DigestHead } from "../loop/digestPlaces.ts";
import { planFor } from "../loop/rules.ts";
import type { KitConfig, LoopEvent, Plan, PullRequestSnapshot, Snapshot } from "../loop/types.ts";
import { applyPlan, type DigestHeadReader, PlanNotApplied } from "./apply.ts";
import { GitHubError, type ReadClient } from "./client.ts";
import { describePlan } from "./describePlan.ts";
import { digestHeadReader, snapshotWithAsks } from "./digestCarry.ts";
import { verdictsIn } from "./threads.ts";

const repo = { owner: "acme", name: "shop" };
const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const REPO = "https://github.com/acme/shop";
/** The head the last Digest was written at, before the pull request was rebased onto `main` to HEAD_SHA. */
const WRITTEN_AT = "b".repeat(40);
const CHANGE: ChangeFingerprint = { v: 1, all: "1".repeat(12), product: "2".repeat(12), files: null };

/** The saved-basket rule as the last Digest's head had it, and as the new head has it: twelve lines further down. */
const SAVE_LINES = Array.from({ length: 100 }, (_, index) => `const line${index + 1} = ${index + 1};`);
const SAVE = `${SAVE_LINES.join("\n")}\n`;
const SAVE_MOVED_DOWN_12 = `${[...Array.from({ length: 12 }, (_, index) => `// from main ${index + 1}`), ...SAVE_LINES].join("\n")}\n`;

/** The last Digest on #50, written as of WRITTEN_AT: one item, pointing at lines 10 to 12 of the saved-basket rule. */
const LAST_DIGEST = (() => {
  const reply = aDigestReply({
    items: [{ kind: "yours-to-judge", claim: "Prices hold for 24 hours.", sentence: "The Ticket did not say.", asks: [], places: [{ path: "src/basket/save.ts", start: 10, end: 12, as: "code" }], suggestedRequest: null }],
  });
  const rendered = digestCommentOf(reply, aDigestGiven({ repoUrl: REPO, headSha: WRITTEN_AT, runUrl: RUN, head: { files: [{ path: "src/basket/save.ts", text: SAVE }], changed: [] } }));
  if (!rendered.ok) throw new Error(rendered.refused);
  return rendered.body;
})();

/** The plan the Loop makes when the Reviewer passes #50 at its rebased head, only `main` having moved since its last Digest. */
function passingPlan(): Plan {
  const pullRequest = aPullRequest({
    verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: WRITTEN_AT, change: CHANGE }],
    digests: [{ node: "IC_last", minimized: false, body: LAST_DIGEST, postedAt: "2026-11-10T09:00:00Z" }],
    change: CHANGE,
    asks: [],
  });
  return planFor(
    { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: "verdict: pass\n\nLooks good.", runUrl: RUN, repoUrl: REPO },
    snapshotOfPullRequest(pullRequest, { operator: "jrey" }),
    kitConfig(),
  );
}

/** A GitHub that records each change it is asked for in the order it is made, by what it does, and each comment it is given. */
function fakeGitHub() {
  const calls: string[] = [];
  const comments: string[] = [];
  return {
    calls,
    comments,
    async rest(method: string, path: string, body?: unknown): Promise<unknown> {
      if (method === "POST" && path.endsWith("/issues/50/comments")) {
        const text = (body as { body: string }).body;
        comments.push(text);
        calls.push(verdictsIn([text]).length > 0 ? "post the Verdict" : digestMarkIn(text) !== null ? "post the Digest" : "post a comment");
        return { id: 9300 + comments.length, html_url: `https://github.com/acme/shop/pull/50#issuecomment-${9300 + comments.length}` };
      }
      if (method === "GET" && path.endsWith("/issues/50/labels?per_page=100")) return [];
      if (method === "POST" && path.endsWith("/issues/50/labels")) calls.push(`add ${(body as { labels: string[] }).labels.join(", ")}`);
      if (method === "GET" && path.endsWith("/pulls/50")) return { node_id: "PR_50" };
      if (method === "POST" && path.endsWith("/pulls/50/requested_reviewers")) calls.push("request the review");
      return null;
    },
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      if (query.includes("minimizeComment(")) calls.push(`collapse ${String(variables["id"])}`);
      if (query.includes("markPullRequestReadyForReview")) calls.push("take it out of draft");
      return {} as T;
    },
  };
}

/** A reader of what a head holds, which records what it was asked for and answers with `head`, or fails as `head` says. */
function fakeReader(head: DigestHead | Error) {
  const asked: [number, string, readonly string[]][] = [];
  const reader: DigestHeadReader = {
    async read(pullRequest, headSha, paths) {
      asked.push([pullRequest, headSha, paths]);
      if (head instanceof Error) throw head;
      return head;
    },
  };
  return { asked, reader };
}

const NEW_HEAD_HOLDS: DigestHead = { files: [{ path: "src/basket/save.ts", text: SAVE_MOVED_DOWN_12 }], changed: [] };

describe("Carrying the last Digest forward, as the push job applies it (ADR-0022)", () => {
  it("reads the files its places name at the new head, posts the carried Digest, collapses the one it was carried from and opens the gate, in the step that lands the pass", async () => {
    const github = fakeGitHub();
    const { asked, reader } = fakeReader(NEW_HEAD_HOLDS);

    await applyPlan(github, repo, passingPlan(), null, null, null, reader);

    expect(asked).toEqual([[50, HEAD_SHA, ["src/basket/save.ts"]]]);
    // No label is added, so no Digest run starts.
    expect(github.calls).toEqual(["post the Verdict", "post the Digest", "collapse IC_last", "take it out of draft", "request the review"]);
    const carried = readDigestComment(github.comments[1]!);
    expect(carried).toMatchObject({ ok: true, head: HEAD_SHA, carriedFrom: WRITTEN_AT, data: { items: [{ places: [{ path: "src/basket/save.ts", start: 22, end: 24 }] }] } });
    expect(github.comments[1]).toContain("Carried over from `bbbbbbb` because only `main` moved.");
    expect(github.comments[1]).toContain(`${REPO}/blob/${HEAD_SHA}/src/basket/save.ts?plain=1#L22-L24`);
  });

  it.each<[string, Error]>([
    ["GitHub fails while the files are read", new GitHubError("GitHub API GET /repos/acme/shop/contents/src/basket/save.ts failed: 502", 502)],
    ["the read is never answered", new Error("fetch failed")],
  ])("when %s at the new head, carries nothing: the pass goes on as if no Digest could be carried, and adds agent:digest", async (_what, failure) => {
    const github = fakeGitHub();

    await applyPlan(github, repo, passingPlan(), null, null, null, fakeReader(failure).reader);

    expect(github.calls).toEqual(["post the Verdict", "add agent:digest"]);
  });

  it("when the new head no longer has a file, carries the Digest with that place dropped", async () => {
    const github = fakeGitHub();

    await applyPlan(github, repo, passingPlan(), null, null, null, fakeReader({ files: [{ path: "src/basket/save.ts", text: null }], changed: [] }).reader);

    expect(github.calls).toEqual(["post the Verdict", "post the Digest", "collapse IC_last", "take it out of draft", "request the review"]);
    expect(readDigestComment(github.comments[1]!)).toMatchObject({ ok: true, data: { items: [{ claim: "Prices hold for 24 hours.", places: [] }] } });
  });

  it("fails rather than guess when the job holds no way to read the new head", async () => {
    const github = fakeGitHub();

    await expect(applyPlan(github, repo, passingPlan())).rejects.toBeInstanceOf(PlanNotApplied);
    expect(github.calls).toEqual(["post the Verdict"]);
  });

  it("is said in the step summary as one line, naming both ways it can go", () => {
    expect(describePlan(passingPlan()).split("\n")).toEqual([
      "- comment on #50",
      "- carry the last Digest of #50 forward to aaaaaaa, with no Digest run, then collapse the older Digests and open the Merge gate; or, if the files its places name can't be read there, go on as with no Digest to carry",
    ]);
  });

  it("reads the new head through GitHub's API, as a Digest's places are read when it is first written", async () => {
    const calls: string[] = [];
    const reader = digestHeadReader(
      {
        rest: async (method, path) => {
          calls.push(`${method} ${path.split("?")[0]}`);
          return path.includes("page=1") ? [{ filename: "src/basket/save.ts", patch: "@@ -1,2 +20,10 @@\n context" }] : [];
        },
        fileText: async (_repo, path, ref) => {
          calls.push(`text ${path}@${ref}`);
          return SAVE_MOVED_DOWN_12;
        },
      },
      repo,
    );

    expect(await reader.read(50, HEAD_SHA, ["src/basket/save.ts"])).toEqual({
      files: [{ path: "src/basket/save.ts", text: SAVE_MOVED_DOWN_12 }],
      changed: [{ path: "src/basket/save.ts", patch: "@@ -1,2 +20,10 @@\n context" }],
    });
    expect(calls).toContain(`text src/basket/save.ts@${HEAD_SHA}`);
    expect(calls).toContain("GET /repos/acme/shop/pulls/50/files");
  });
});

const OPERATOR = { login: "jrey", type: "User" };
const PASSED: LoopEvent = { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: "verdict: pass\n\nLooks good.", runUrl: RUN, repoUrl: REPO };

/** The Loop's snapshot of #50 as the push job gathers it for a Reviewer's Verdict: no list of asks, and no fingerprint of its head yet. */
function gathered(overrides: Partial<PullRequestSnapshot> = {}): Snapshot {
  const pullRequest = aPullRequest({
    verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: WRITTEN_AT, change: CHANGE }],
    digests: [{ node: "IC_last", minimized: false, body: LAST_DIGEST, postedAt: "2026-11-10T09:00:00Z" }],
    ...overrides,
  });
  return snapshotOfPullRequest(pullRequest, { operator: "jrey" });
}

interface Review {
  readonly id: number;
  readonly state: string;
  readonly body?: string;
  readonly user?: { login: string; type: string };
}

/** #50's thread as GitHub answers for it: these reviews, and these line comments, each in the review that holds it. Every call the read makes is counted. */
function threadOf(reviews: readonly Review[], lineComments: readonly { id: number; review: number }[] = []) {
  const calls: string[] = [];
  const client: Pick<ReadClient, "rest" | "graphql"> = {
    graphql: async <T>() => {
      calls.push("graphql");
      return { repository: { pullRequest: { createdAt: "2026-11-02T10:00:00Z", headRefName: "fabrik/ticket-7", closingIssuesReferences: { nodes: [] } } } } as T;
    },
    rest: async (method, path) => {
      const [route, query] = path.split("?");
      calls.push(`${method} ${route}`);
      if (!/(^|&)page=1(&|$)/.test(query ?? "")) return [];
      if (route === "/repos/acme/shop/issues/50/comments") return [];
      if (route === "/repos/acme/shop/pulls/50/reviews") {
        return reviews.map(({ id, state, body = "Call it a basket.", user = OPERATOR }, index) => ({
          id,
          state,
          body,
          user,
          html_url: `${REPO}/pull/50#pullrequestreview-${id}`,
          submitted_at: `2026-11-03T10:0${index}:00Z`,
        }));
      }
      if (route === "/repos/acme/shop/pulls/50/comments") {
        return lineComments.map(({ id, review }) => ({
          id,
          user: OPERATOR,
          html_url: `${REPO}/pull/50#discussion_r${id}`,
          created_at: "2026-11-03T10:00:00Z",
          path: "src/basket/save.ts",
          line: 11,
          pull_request_review_id: review,
        }));
      }
      throw new Error(`unexpected REST call ${path}`);
    },
  };
  return { client, calls };
}

/** A GitHub that fails every call, as when nothing should be asked of it. */
const UNASKED: Pick<ReadClient, "rest" | "graphql"> = {
  graphql: async () => {
    throw new GitHubError("GitHub GraphQL query failed: 502", 502);
  },
  rest: async () => {
    throw new GitHubError("GitHub API GET failed: 502", 502);
  },
};

describe("The Kit's list of asks, read for a pass that might carry the last Digest forward (ADR-0022)", () => {
  it("is each Request changes of the Operator's a Review is given and each line comment in it, by Kit code's ids, oldest first", async () => {
    const { client } = threadOf(
      [
        { id: 8, state: "CHANGES_REQUESTED" },
        { id: 9, state: "DISMISSED" },
        { id: 10, state: "CHANGES_REQUESTED", body: "" },
        { id: 11, state: "CHANGES_REQUESTED" },
        { id: 12, state: "CHANGES_REQUESTED", user: { login: "stranger", type: "User" } },
      ],
      [{ id: 21, review: 10 }],
    );

    // Review 11 was deferred during a Retry: no Review was given it, so it is no ask yet.
    const { snapshot, unread } = await snapshotWithAsks(client, repo, PASSED, gathered({ deferredChangesRequests: [11] }), kitConfig());

    expect(snapshot.pullRequest?.asks).toEqual(["review-8", "inline-21"]);
    expect(unread).toBeNull();
  });

  it("lets a pass carry the Digest when no ask was added since, once the push job has read the pull request's own change", async () => {
    const { client } = threadOf([]);
    const { snapshot } = await snapshotWithAsks(client, repo, PASSED, gathered(), kitConfig());
    const carries = (given: Snapshot): boolean => {
      const plan = planFor(PASSED, { ...given, pullRequest: { ...given.pullRequest!, change: CHANGE } }, kitConfig());
      return plan.kind === "act" && plan.actions.some(({ kind }) => kind === "carry-digest");
    };

    expect(snapshot.pullRequest?.asks).toEqual([]);
    expect(carries(snapshot)).toBe(true);
    // The snapshot as it was gathered, with no list of asks, carries nothing.
    expect(carries(gathered())).toBe(false);
  });

  it.each<[string, LoopEvent, Snapshot, KitConfig]>([
    ["the Digest is off in Kit config", PASSED, gathered(), kitConfig({ digest: { enabled: false } })],
    ["the Verdict is from red Required checks", { kind: "required-checks-finished", pullRequest: 50, headSha: HEAD_SHA, failed: ["build"], runUrl: RUN }, gathered(), kitConfig()],
    ["the pull request has no Digest", PASSED, gathered({ digests: [] }), kitConfig()],
    ["its last Digest does not read back", PASSED, gathered({ digests: [{ node: "IC_last", minimized: false, body: LAST_DIGEST.split("\n").toSpliced(1, 1).join("\n"), postedAt: "2026-11-10T09:00:00Z" }] }), kitConfig()],
    ["no Verdict on its last Digest's head records a fingerprint", PASSED, gathered({ verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: WRITTEN_AT }] }), kitConfig()],
  ])("asks nothing of GitHub when %s: nothing could be carried", async (_what, event, snapshot, config) => {
    const { client, calls } = threadOf([{ id: 8, state: "CHANGES_REQUESTED" }]);

    expect(await snapshotWithAsks(client, repo, event, snapshot, config)).toEqual({ snapshot, unread: null });
    expect(calls).toEqual([]);
  });

  it("never fails a Verdict for want of them: when the read fails, the snapshot holds no asks, so nothing is carried, and the step summary is told why", async () => {
    const snapshot = gathered();

    expect(await snapshotWithAsks(UNASKED, repo, PASSED, snapshot, kitConfig())).toEqual({
      snapshot,
      unread: "The last Digest of #50 could not be carried forward: the Operator's asks on it could not be read (GitHub GraphQL query failed: 502).",
    });
  });
});
