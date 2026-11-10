import { describe, expect, it } from "vitest";
import { acceptedBody } from "../__fixtures__/replay.ts";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { UI } from "../__fixtures__/uiEvidence.ts";
import { replayMarksIn } from "../kit/replay.ts";
import { planFor } from "../loop/rules.ts";
import type { Plan } from "../loop/types.ts";
import { applyPlan, PlanNotApplied } from "./apply.ts";
import { GitHubError } from "./client.ts";
import { pendingPrototypeIn } from "./threads.ts";

const repo = { owner: "acme", name: "shop" };
const issues = "/repos/acme/shop/issues";

/**
 * A GitHub that records every REST call. Each existing issue's database id is
 * its number plus 1000; a created issue gets the next number from 100. A
 * comment it posts is comment 9300. An issue's labels are `labelsOn` it, or
 * none, and each was added at the time `addedAt` it gives, on one page of events.
 */
function fakeGitHub(
  labelsOn: Readonly<Record<number, readonly string[]>> = {},
  addedAt: Readonly<Record<number, Readonly<Record<string, string>>>> = {},
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let next = 100;
  return {
    calls,
    async rest(method: string, path: string, body?: unknown): Promise<unknown> {
      calls.push({ method, path, body });
      if (method === "POST" && path === issues) {
        const number = next++;
        return { number, id: number + 1000 };
      }
      const labelled = new RegExp(`^${issues}/(\\d+)/labels\\?`).exec(path);
      if (method === "GET" && labelled !== null) return (labelsOn[Number(labelled[1])] ?? []).map((name) => ({ name }));
      const events = new RegExp(`^${issues}/(\\d+)/events\\?per_page=100&page=(\\d+)$`).exec(path);
      if (method === "GET" && events !== null) {
        if (events[2] !== "1") return [];
        return Object.entries(addedAt[Number(events[1])] ?? {}).map(([name, at]) => ({ event: "labeled", label: { name }, created_at: at }));
      }
      const existing = new RegExp(`^${issues}/(\\d+)$`).exec(path);
      if (method === "GET" && existing !== null) return { number: Number(existing[1]), id: Number(existing[1]) + 1000 };
      if (method === "POST" && path.endsWith("/comments")) return { id: 9300, html_url: "https://github.com/acme/shop/issues/7#issuecomment-9300" };
      if (method === "POST" && path === "/repos/acme/shop/pulls") return { number: 51, id: 5051 };
      return null;
    },
    async graphql(): Promise<never> {
      throw new Error("no GraphQL expected");
    },
  };
}

describe("Applying a close", () => {
  it.each(["duplicate", "not_planned", "completed"] as const)("sends GitHub the state reason %s", async (reason) => {
    const github = fakeGitHub();

    await applyPlan(github, repo, { kind: "act", actions: [{ kind: "close", issue: 7, reason }] });

    expect(github.calls).toEqual([{ method: "PATCH", path: `${issues}/7`, body: { state: "closed", state_reason: reason } }]);
  });
});

describe("Applying a plan that moves blocked-by edges onto new Tickets", () => {
  it("links a new Ticket to an existing blocker, and an existing issue to a new Ticket, by database id", async () => {
    const github = fakeGitHub();
    const plan: Plan = {
      kind: "act",
      actions: [
        { kind: "create-issue", key: "ticket:a", title: "A", body: "A.", labels: [], parent: null, blockedBy: [10] },
        {
          kind: "create-issue",
          key: "ticket:b",
          title: "B",
          body: "B.",
          labels: [],
          parent: null,
          blockedBy: [{ created: "ticket:a" }],
        },
        { kind: "add-blocked-by", issue: 20, blocker: { created: "ticket:b" } },
        { kind: "close-as-superseded", issue: 7, comment: ["Now ", { created: "ticket:b" }, "."] },
      ],
    };

    await applyPlan(github, repo, plan);

    const edges = github.calls
      .filter((call) => call.path.endsWith("/dependencies/blocked_by"))
      .map((call) => [call.path, call.body]);
    expect(edges).toEqual([
      [`${issues}/100/dependencies/blocked_by`, { issue_id: 1010 }],
      [`${issues}/101/dependencies/blocked_by`, { issue_id: 1100 }],
      [`${issues}/20/dependencies/blocked_by`, { issue_id: 1101 }],
    ]);
    const lastEdge = github.calls.findLastIndex((call) => call.path.endsWith("/dependencies/blocked_by"));
    const closing = github.calls.findIndex((call) => call.method === "PATCH" && call.path === `${issues}/7`);
    expect(lastEdge).toBeLessThan(closing);
  });

});

describe("Applying a trigger label the issue already carries (#417)", () => {
  const changes = (calls: { method: string; path: string; body: unknown }[]) =>
    calls.filter(({ method }) => method !== "GET").map(({ method, path, body }) => [method, path, body]);

  const run = { id: 9001, at: "2026-11-09T12:00:00.000Z" };
  const addImplement: Plan = { kind: "act", actions: [{ kind: "add-labels", issue: 7, labels: ["agent:implement"] }] };

  it("takes off one added long enough ago that its run would have claimed it, and puts it back on, so GitHub fires the labeled event that starts the run", async () => {
    const github = fakeGitHub({ 7: ["ready-for-agent", "agent:implement"] }, { 7: { "agent:implement": "2026-11-09T11:49:00Z" } });

    const applied = await applyPlan(github, repo, addImplement, null, run);

    expect(changes(github.calls)).toEqual([
      ["DELETE", `${issues}/7/labels/agent%3Aimplement`, undefined],
      ["POST", `${issues}/7/labels`, { labels: ["agent:implement"] }],
    ]);
    expect(applied.readded).toEqual([{ issue: 7, label: "agent:implement" }]);
  });

  it("leaves one added in the last 10 minutes on, since its run is still starting and a second event would start a second run", async () => {
    const github = fakeGitHub({ 7: ["ready-for-agent", "agent:implement"] }, { 7: { "agent:implement": "2026-11-09T11:52:00Z" } });

    const applied = await applyPlan(github, repo, addImplement, null, run);

    expect(changes(github.calls)).toEqual([["POST", `${issues}/7/labels`, { labels: ["agent:implement"] }]]);
    expect(applied.readded).toEqual([]);
  });

  it("re-adds one whose labeled event GitHub no longer lists, as stale", async () => {
    const github = fakeGitHub({ 7: ["ready-for-agent", "agent:implement"] });

    const applied = await applyPlan(github, repo, addImplement, null, run);

    expect(applied.readded).toEqual([{ issue: 7, label: "agent:implement" }]);
  });

  it("adds a trigger label the issue doesn't carry once, as before", async () => {
    const github = fakeGitHub({ 50: ["fabrik:step-up"] });

    const applied = await applyPlan(github, repo, { kind: "act", actions: [{ kind: "add-labels", issue: 50, labels: ["agent:review"] }] });

    expect(changes(github.calls)).toEqual([["POST", `${issues}/50/labels`, { labels: ["agent:review"] }]]);
    expect(applied.readded).toEqual([]);
  });

  it("never reads the labels to add a label that starts nothing", async () => {
    const github = fakeGitHub({ 7: ["ready-for-human"] });

    await applyPlan(github, repo, { kind: "act", actions: [{ kind: "add-labels", issue: 7, labels: ["ready-for-human"] }] });

    expect(github.calls).toEqual([{ method: "POST", path: `${issues}/7/labels`, body: { labels: ["ready-for-human"] } }]);
  });
});

describe("Applying a comment that names issues the plan created", () => {
  it("writes each created issue as its number, and leaves the issue it comments on open", async () => {
    const github = fakeGitHub();
    const plan: Plan = {
      kind: "act",
      actions: [
        { kind: "create-issue", key: "decision:a", title: "A?", body: "A.", labels: [], parent: 7, blockedBy: [] },
        { kind: "create-issue", key: "decision:b", title: "B?", body: "B.", labels: [], parent: 7, blockedBy: [] },
        { kind: "comment-linking", issue: 7, body: ["Filed ", { created: "decision:a" }, " and ", { created: "decision:b" }, "."] },
      ],
    };

    await applyPlan(github, repo, plan);

    expect(github.calls.filter((call) => call.path === `${issues}/7/comments`).map((call) => call.body)).toEqual([
      { body: "Filed #100 and #101." },
    ]);
    expect(github.calls.some((call) => call.method === "PATCH")).toBe(false);
  });
});

describe("Applying a plan that creates an issue", () => {
  it("assigns a created issue as it creates it, and assigns nobody when the action names no one", async () => {
    const github = fakeGitHub();
    const plan: Plan = {
      kind: "act",
      actions: [
        { kind: "create-issue", key: "ticket:a", title: "A", body: "A.", labels: [], parent: null, blockedBy: [] },
        {
          kind: "create-issue",
          key: "ticket:b",
          title: "B",
          body: "B.",
          labels: ["ready-for-human"],
          assignees: ["jrey"],
          parent: null,
          blockedBy: [],
        },
      ],
    };

    await applyPlan(github, repo, plan);

    expect(github.calls.filter((call) => call.path === issues).map((call) => call.body)).toStrictEqual([
      { title: "A", body: "A.", labels: [] },
      { title: "B", body: "B.", labels: ["ready-for-human"], assignees: ["jrey"] },
    ]);
  });
});

describe("Applying a 👀 reaction to an Operator comment", () => {
  /** A GitHub whose review 900 on PR 50 holds these inline comment ids, served 100 a page. */
  function gitHubWithReview(inlineComments: readonly number[]) {
    const calls: { method: string; path: string; body: unknown }[] = [];
    return {
      calls,
      async rest(method: string, path: string, body?: unknown): Promise<unknown> {
        calls.push({ method, path, body });
        const page = /^\/repos\/acme\/shop\/pulls\/50\/reviews\/900\/comments\?per_page=100&page=(\d+)$/.exec(path);
        if (method === "GET" && page !== null) {
          const start = (Number(page[1]) - 1) * 100;
          return inlineComments.slice(start, start + 100).map((id) => ({ id }));
        }
        return null;
      },
      async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        calls.push({ method: "GRAPHQL", path: query, body: variables });
        return {} as T;
      },
    };
  }

  const ADD_REACTION = "mutation ($id: ID!, $content: ReactionContent!) { addReaction(input: { subjectId: $id, content: $content }) { clientMutationId } }";
  const reactedToReview = (github: ReturnType<typeof gitHubWithReview>) =>
    github.calls.filter((call) => call.method === "GRAPHQL").map(({ path, body }) => ({ query: path, variables: body }));

  const posts = (github: ReturnType<typeof gitHubWithReview>) =>
    github.calls.filter((call) => call.method === "POST").map(({ path, body }) => ({ path, body }));

  it("reacts to a conversation comment itself", async () => {
    const github = gitHubWithReview([]);
    const plan: Plan = {
      kind: "act",
      actions: [{ kind: "react", pullRequest: 50, on: { kind: "conversation", comment: 7001 }, content: "eyes" }],
    };

    await applyPlan(github, repo, plan);

    expect(posts(github)).toStrictEqual([
      { path: "/repos/acme/shop/issues/comments/7001/reactions", body: { content: "eyes" } },
    ]);
  });

  const reviewPlan = (body: boolean): Plan => ({
    kind: "act",
    actions: [{ kind: "react", pullRequest: 50, on: { kind: "review", review: 900, node: "PRR_kwDO900", hasBody: body }, content: "eyes" }],
  });

  it("reacts to a review with a body itself, by its node id, as only GraphQL can", async () => {
    const github = gitHubWithReview([]);

    await applyPlan(github, repo, reviewPlan(true));

    expect(reactedToReview(github)).toStrictEqual([{ query: ADD_REACTION, variables: { id: "PRR_kwDO900", content: "EYES" } }]);
    expect(posts(github)).toStrictEqual([]);
  });

  it("reacts to each inline comment of a review, on every page, and to its body too", async () => {
    const inline = Array.from({ length: 101 }, (_, i) => 8000 + i);
    const github = gitHubWithReview(inline);

    await applyPlan(github, repo, reviewPlan(true));

    expect(reactedToReview(github)).toHaveLength(1);
    expect(posts(github)).toStrictEqual(
      inline.map((id) => ({ path: `/repos/acme/shop/pulls/comments/${id}/reactions`, body: { content: "eyes" } })),
    );
  });

  it("reacts only to the inline comments of a review with no body", async () => {
    const github = gitHubWithReview([8000]);

    await applyPlan(github, repo, reviewPlan(false));

    expect(reactedToReview(github)).toStrictEqual([]);
    expect(posts(github)).toStrictEqual([{ path: "/repos/acme/shop/pulls/comments/8000/reactions", body: { content: "eyes" } }]);
  });
});

describe("Applying a plan that links a UI PR's preview deployment", () => {
  const HEAD = "4f2b9c0e1d3a5b7c9e0f2a4b6c8d0e1f3a5b7c9d";
  const TEMPLATE = "https://deploy-preview-{pr}--shop.netlify.app/{branch_slug}/{sha}";
  /** The agent branch the push job holds, which its push leaves at HEAD. */
  const heldBranch = () => {
    const pushed: string[] = [];
    return { pushed, head: HEAD, push: async (branch: string) => void pushed.push(branch) };
  };

  it("hands on the preview to poll, filled in from the PR it opened, its branch's slug and the head its push left", async () => {
    const plan: Plan = {
      kind: "act",
      actions: [
        { kind: "push-branch", branch: "fabrik/ticket-7" },
        { kind: "open-pull-request", issue: 7, head: "fabrik/ticket-7", base: "main", title: "Waitlist", body: "Adds it.", draft: true },
        { kind: "link-preview", pullRequest: null, template: TEMPLATE, branch: "fabrik/ticket-7" },
      ],
    };

    const applied = await applyPlan(fakeGitHub(), repo, plan, heldBranch());

    expect(applied).toEqual({ preview: { pullRequest: 51, url: `https://deploy-preview-51--shop.netlify.app/fabrik-ticket-7/${HEAD}` }, readded: [] });
  });

  it("hands on a retry's preview for the PR it pushed to, changing nothing on GitHub itself", async () => {
    const github = fakeGitHub();
    const branch = heldBranch();
    const plan: Plan = {
      kind: "act",
      actions: [
        { kind: "push-branch", branch: "fabrik/ticket-7" },
        { kind: "link-preview", pullRequest: 50, template: TEMPLATE, branch: "fabrik/ticket-7" },
      ],
    };

    const applied = await applyPlan(github, repo, plan, branch);

    expect(applied.preview).toEqual({ pullRequest: 50, url: `https://deploy-preview-50--shop.netlify.app/fabrik-ticket-7/${HEAD}` });
    expect(github.calls).toEqual([]);
    expect(branch.pushed).toEqual(["fabrik/ticket-7"]);
  });

  it("hands on no preview for a plan that doesn't ask to link one", async () => {
    const plan: Plan = {
      kind: "act",
      actions: [
        { kind: "push-branch", branch: "fabrik/ticket-7" },
        { kind: "open-pull-request", issue: 7, head: "fabrik/ticket-7", base: "main", title: "Waitlist", body: "Adds it.", draft: true },
      ],
    };

    expect(await applyPlan(fakeGitHub(), repo, plan, heldBranch())).toEqual({ preview: null, readded: [] });
    expect(await applyPlan(fakeGitHub(), repo, { kind: "nothing", reason: "no change" })).toEqual({ preview: null, readded: [] });
  });
});

describe("Applying a plan that appends a line to a Map's Decisions so far", () => {
  /**
   * A GitHub holding Map #9, whose body is whatever it holds when the adapter
   * reads it, and which each PATCH of its body replaces. A comment it posts
   * gets a URL from its count, from 1.
   */
  function gitHubWithMap(body: string | null) {
    const map = { body };
    let comments = 0;
    return {
      map,
      async rest(method: string, path: string, sent?: unknown): Promise<unknown> {
        if (method === "GET" && path === `${issues}/9`) return { number: 9, id: 1009, body: map.body };
        if (method === "PATCH" && path === `${issues}/9`) map.body = (sent as { body: string }).body;
        if (method === "POST" && path.endsWith("/comments")) {
          return { html_url: `https://github.com/acme/shop/issues/13#issuecomment-${++comments}` };
        }
        return null;
      },
      async graphql(): Promise<never> {
        throw new Error("no GraphQL expected");
      },
    };
  }

  const MAP = [
    "## Destination",
    "",
    "A waitlist the shop can open and close.",
    "",
    "## Notes",
    "",
    "Read the checkout code first.",
    "",
    "## Decisions so far",
    "",
    "- [Which email provider?](https://github.com/acme/shop/issues/12#issuecomment-1): Postmark, for its sandbox.",
    "",
    "## Not yet specified",
    "",
    "How invites expire.",
    "",
    "## Out of scope",
    "",
    "Paid tiers.",
    "",
  ].join("\n");

  /** A plan that appends one line to Map #9's Decisions so far. */
  const APPENDING: Plan = {
    kind: "act",
    actions: [{ kind: "append-to-decisions-so-far", issue: 9, line: ["- [Which queue?](https://x/13): SQS."] }],
  };

  it("lands the line at the end of Decisions so far, linking the resolution posted earlier in the plan, and changes nothing else", async () => {
    const github = gitHubWithMap(MAP);
    const plan: Plan = {
      kind: "act",
      actions: [
        { kind: "comment", issue: 13, body: "SQS, for its dead-letter queue.", key: "resolution" },
        {
          kind: "append-to-decisions-so-far",
          issue: 9,
          line: ["- [Which queue?](", { posted: "resolution" }, "): SQS, for its dead-letter queue."],
        },
      ],
    };

    await applyPlan(github, repo, plan);

    expect(github.map.body).toBe(
      MAP.replace(
        "Postmark, for its sandbox.\n",
        "Postmark, for its sandbox.\n- [Which queue?](https://github.com/acme/shop/issues/13#issuecomment-1): SQS, for its dead-letter queue.\n",
      ),
    );
  });

  it("keeps what the Operator edited in the Map after the plan was made, appending after their own last line", async () => {
    const edited = MAP.replace("Read the checkout code first.", "Read the checkout code first, then the mailer.").replace(
      "Postmark, for its sandbox.\n",
      "Postmark, for its sandbox.\n- [Invite copy](https://github.com/acme/shop/issues/14): settled live, short and plain.\n",
    );
    const github = gitHubWithMap(edited);

    await applyPlan(github, repo, APPENDING);

    expect(github.map.body).toBe(
      edited.replace("short and plain.\n", "short and plain.\n- [Which queue?](https://x/13): SQS.\n"),
    );
  });

  it("makes the line the first entry of an empty Decisions so far, under its heading", async () => {
    const empty = MAP.replace(/(## Decisions so far\n\n)[^\n]+\n\n/, "$1");
    const github = gitHubWithMap(empty);

    await applyPlan(github, repo, APPENDING);

    expect(github.map.body).toBe(
      empty.replace("## Decisions so far\n", "## Decisions so far\n- [Which queue?](https://x/13): SQS.\n"),
    );
  });

  it("ends the line as the rest of a body edited on GitHub's web editor ends its lines, in \\r\\n", async () => {
    const crlf = MAP.replaceAll("\n", "\r\n");
    const github = gitHubWithMap(crlf);

    await applyPlan(github, repo, APPENDING);

    expect(github.map.body).toBe(crlf.replace("sandbox.\r\n", "sandbox.\r\n- [Which queue?](https://x/13): SQS.\r\n"));
  });

  it("reads a heading quoted as code as no heading, in Notes or in the section itself", async () => {
    const quoting = MAP.replace(
      "Read the checkout code first.",
      "Read the checkout code first. A Map reads:\n\n```markdown\n## Decisions so far\n\n- [title](link): gist\n```",
    ).replace("Postmark, for its sandbox.\n", "Postmark, for its sandbox.\n\n~~~\n## Not yet specified\n~~~\n");
    const github = gitHubWithMap(quoting);

    await applyPlan(github, repo, APPENDING);

    expect(github.map.body).toBe(
      quoting.replace("## Not yet specified\n~~~\n", "## Not yet specified\n~~~\n- [Which queue?](https://x/13): SQS.\n"),
    );
  });

  it.each([
    [
      "ends with a newline",
      "## Destination\n\nA waitlist.\n\n## Out of scope\n\nPaid tiers.\n",
      "## Destination\n\nA waitlist.\n\n## Out of scope\n\nPaid tiers.\n\n## Decisions so far\n- [Which queue?](https://x/13): SQS.\n",
    ],
    [
      "ends without one",
      "## Destination\n\nA waitlist.\n\n## Out of scope\n\nPaid tiers.",
      "## Destination\n\nA waitlist.\n\n## Out of scope\n\nPaid tiers.\n\n## Decisions so far\n- [Which queue?](https://x/13): SQS.",
    ],
    [
      "ends its lines in \\r\\n",
      "## Destination\r\n\r\nA waitlist.\r\n",
      "## Destination\r\n\r\nA waitlist.\r\n\r\n## Decisions so far\r\n- [Which queue?](https://x/13): SQS.\r\n",
    ],
    ["is empty", null, "## Decisions so far\n- [Which queue?](https://x/13): SQS."],
    [
      "quotes the heading only as code",
      "## Notes\n\n```markdown\n## Decisions so far\n```\n",
      "## Notes\n\n```markdown\n## Decisions so far\n```\n\n## Decisions so far\n- [Which queue?](https://x/13): SQS.\n",
    ],
  ])("adds the heading at the end of a Map with no Decisions so far, with the line under it, when its body %s", async (_, body, appended) => {
    const github = gitHubWithMap(body);

    await applyPlan(github, repo, APPENDING);

    expect(github.map.body).toBe(appended);
  });
});

describe("Applying a prototype turn's plan (#155)", () => {
  /** The prototype branch the push job holds from the turn's bundle. */
  const heldBranch = () => {
    const pushed: string[] = [];
    return { pushed, head: "7e3d1c9b5a4f2e0d8c6b4a2f0e9d7c5b3a1f0e2d", push: async (branch: string) => void pushed.push(branch) };
  };

  it("pushes the issue's prototype branch, then posts the round, and opens no PR", async () => {
    const github = fakeGitHub();
    const branch = heldBranch();
    const plan: Plan = {
      kind: "act",
      actions: [
        { kind: "push-prototype-branch", issue: 7 },
        { kind: "comment", issue: 7, body: "The prototype round." },
      ],
    };

    await applyPlan(github, repo, plan, branch);

    expect(branch.pushed).toEqual(["prototype/7"]);
    expect(github.calls).toEqual([{ method: "POST", path: `${issues}/7/comments`, body: { body: "The prototype round." } }]);
  });

  it("fails rather than push when the job holds no branch", async () => {
    await expect(applyPlan(fakeGitHub(), repo, { kind: "act", actions: [{ kind: "push-prototype-branch", issue: 7 }] })).rejects.toThrow(
      "This job holds no branch to push (prototype/7)",
    );
  });

  describe("that links each variant's preview", () => {
    const HEAD = "7e3d1c9b5a4f2e0d8c6b4a2f0e9d7c5b3a1f0e2d";
    const planLinking = (template: string, route = "/book"): Plan => ({
      kind: "act",
      actions: [
        { kind: "push-prototype-branch", issue: 7 },
        { kind: "comment", issue: 7, body: "The prototype round.", key: "prototype-round" },
        { kind: "link-prototype-preview", issue: 7, round: { posted: "prototype-round" }, template, route },
      ],
    });

    it("hands on the route's page to poll, filled in from the prototype branch's slug and the head its push left, for the round it posted, changing nothing more on GitHub", async () => {
      const github = fakeGitHub();

      const applied = await applyPlan(github, repo, planLinking("https://{branch_slug}--shop.netlify.app/{sha}"), heldBranch());

      expect(applied).toEqual({ preview: { round: 9300, url: `https://prototype-7--shop.netlify.app/${HEAD}/book` }, readded: [] });
      expect(github.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([`POST ${issues}/7/comments`]);
    });

    it.each([
      ["puts the route on the template's own path, keeping its query", "https://preview.example.dev/shop/?branch={branch_slug}", "/book", "https://preview.example.dev/shop/book?branch=prototype-7"],
      ["keeps the route's own query too, as capture serves it", "https://{branch_slug}.shop.example.dev", "/book?step=2", "https://prototype-7.shop.example.dev/book?step=2"],
      ["keeps the route on the preview's host, whatever the route holds", "https://{branch_slug}.shop.example.dev", "/\\evil.example/x", "https://prototype-7.shop.example.dev//evil.example/x"],
    ])("%s", async (_name, template, route, url) => {
      const applied = await applyPlan(fakeGitHub(), repo, planLinking(template, route), heldBranch());

      expect(applied.preview).toEqual({ round: 9300, url });
    });

    it("fails rather than hand on a preview of a round the plan hasn't posted", async () => {
      const plan: Plan = {
        kind: "act",
        actions: [
          { kind: "push-prototype-branch", issue: 7 },
          { kind: "link-prototype-preview", issue: 7, round: { posted: "prototype-round" }, template: "https://{branch_slug}.example.dev", route: "/book" },
        ],
      };

      await expect(applyPlan(fakeGitHub(), repo, plan, heldBranch())).rejects.toThrow("The plan refers to a comment it hasn't posted: prototype-round");
    });
  });
});

describe("Marking whether a prototype request's prototype turn has started (#155)", () => {
  /** A GitHub holding the request comment 9010 the core posted on #7, which a GET reads and a PATCH replaces. */
  function holdingRequest() {
    const output = JSON.stringify({ kind: "prototype", route: "/book", variants: 3, brief: "- **A**: a form.\n- **B**: a stepper.", comment: "Prototyping it." });
    const posted = planFor(
      { kind: "agent-run-finished", role: "design", issue: 7, output },
      snapshotOf(anIssue({ number: 7, labels: ["needs-design"], designRounds: 1 })),
      kitConfig({ ui: UI }),
    );
    const comment = { body: posted.kind === "act" && posted.actions[0]?.kind === "comment" ? posted.actions[0].body : "" };
    const calls: string[] = [];
    return {
      comment,
      calls,
      async rest(method: string, path: string, sent?: unknown): Promise<unknown> {
        calls.push(`${method} ${path}`);
        expect(path).toBe(`${issues}/comments/9010`);
        if (method === "GET") return { id: 9010, body: comment.body };
        if (method === "PATCH") comment.body = (sent as { body: string }).body;
        return null;
      },
      async graphql(): Promise<never> {
        throw new Error("no GraphQL expected");
      },
    };
  }

  const mark = (started: boolean): Plan => ({ kind: "act", actions: [{ kind: "mark-prototype-request", issue: 7, comment: 9010, started }] });
  const read = ({ body }: { body: string }) => pendingPrototypeIn([{ id: 9010, body, byApp: true }]);

  it("marks the request's comment started, which the snapshot reads back, leaving the request it holds and its text as they were", async () => {
    const github = holdingRequest();
    const before = github.comment.body;

    await applyPlan(github, repo, mark(true));

    expect(read(github.comment)).toEqual({ ...read({ body: before }), started: true });
    expect(github.comment.body.split("\n").filter((line) => !line.startsWith("<!--"))).toEqual(before.split("\n").filter((line) => !line.startsWith("<!--")));
  });

  it("marks it waiting for its prototype turn again, as the core posted it", async () => {
    const github = holdingRequest();
    const before = github.comment.body;
    await applyPlan(github, repo, mark(true));

    await applyPlan(github, repo, mark(false));

    expect(github.comment.body).toBe(before);
    expect(read(github.comment)?.started).toBe(false);
  });

  it("leaves a comment already marked so as it is", async () => {
    const github = holdingRequest();

    await applyPlan(github, repo, mark(false));

    expect(github.calls).toEqual([`GET ${issues}/comments/9010`]);
  });
});

/** A GitHub holding replay issue #140, accepted with Tickets 12 and 7, which a GET reads, a PATCH replaces and a POST comments on. */
function holdingReplay(body = acceptedBody()) {
  const issue = { body };
  const calls: string[] = [];
  const comments: string[] = [];
  return {
    issue,
    calls,
    comments,
    async rest(method: string, path: string, sent?: unknown): Promise<unknown> {
      calls.push(`${method} ${path}`);
      if (path.endsWith("/labels/agent%3Areplay")) return null;
      if (method === "POST" && path === `${issues}/140/comments`) {
        comments.push((sent as { body: string }).body);
        return { html_url: "https://github.com/acme/shop/issues/140#issuecomment-1", id: 1 };
      }
      expect(path).toBe(`${issues}/140`);
      if (method === "GET") return { number: 140, body: issue.body };
      if (method === "PATCH") issue.body = (sent as { body: string }).body;
      return null;
    },
    async graphql(): Promise<never> {
      throw new Error("no GraphQL expected");
    },
  };
}

/** The Actions run applying a replay plan, and when it applies it. */
const RUN_9001 = { id: 9001, at: "2026-11-11T05:00:00.000Z" };

describe("Marking a replay Ticket in progress as its run's claim takes agent:replay off (#156)", () => {
  const claim: Plan = {
    kind: "act",
    actions: [
      { kind: "remove-label", issue: 140, label: "agent:replay" },
      { kind: "mark-replay-started", issue: 140, ticket: 12 },
    ],
  };

  it("marks it in progress in the run applying the plan, and when, read fresh, after the label came off", async () => {
    const github = holdingReplay();

    await applyPlan(github, repo, claim, null, RUN_9001);

    expect(replayMarksIn(github.issue.body)?.progress).toEqual([
      { ticket: 12, state: "in-progress", run: 9001, retrying: null, startedAt: "2026-11-11T05:00:00.000Z" },
      { ticket: 7, state: "pending" },
    ]);
    expect(github.calls).toEqual([`DELETE ${issues}/140/labels/agent%3Areplay`, `GET ${issues}/140`, `PATCH ${issues}/140`]);
  });

  it("fails, writing nothing, when the Ticket isn't waiting to run, as when another run claimed it first, so its replay jobs never start", async () => {
    const github = holdingReplay(acceptedBody([12, 7], [{ ticket: 12, state: "in-progress", run: 8000, retrying: null, startedAt: "2026-11-11T04:00:00.000Z" }]));

    await expect(applyPlan(github, repo, claim, null, RUN_9001)).rejects.toThrow("#12 isn't waiting to run on replay #140, so run 9001 doesn't claim it");
    expect(github.calls.some((call) => call.startsWith("PATCH"))).toBe(false);
  });

  it("fails in a job that names no run to mark it in", async () => {
    await expect(applyPlan(holdingReplay(), repo, claim)).rejects.toThrow("This job names no Actions run to mark #12 in progress in");
  });
});

describe("Releasing a replay Ticket whose run never landed, as the tick found it (#156)", () => {
  const STARTED = "2026-11-11T00:00:00.000Z";
  const release: Plan = {
    kind: "act",
    actions: [{ kind: "release-replay-ticket", issue: 140, ticket: 12, run: 8000, reason: "run 8000 never landed", resultsReady: "@operator This Replay's results are in." }],
  };

  it("ends its run as an Infrastructure failure, read fresh, so the Ticket waits to run again, posting nothing", async () => {
    const github = holdingReplay(acceptedBody([12, 7], [{ ticket: 12, state: "in-progress", run: 8000, retrying: null, startedAt: STARTED }]));

    await applyPlan(github, repo, release);

    expect(replayMarksIn(github.issue.body)?.progress[0]).toEqual({ ticket: 12, state: "retried", reason: "run 8000 never landed" });
    expect(github.comments).toEqual([]);
  });

  it("fails it on its one retry, and posts that the results are in once that ends the Replay's last Ticket", async () => {
    const github = holdingReplay(acceptedBody([12], [{ ticket: 12, state: "in-progress", run: 8000, retrying: "it crashed", startedAt: STARTED }]));

    await applyPlan(github, repo, release);

    expect(replayMarksIn(github.issue.body)?.progress[0]).toEqual({ ticket: 12, state: "failed", run: 8000, reason: "run 8000 never landed" });
    expect(github.comments).toEqual(["@operator This Replay's results are in."]);
  });

  it("changes nothing, and posts nothing, when its run landed since the tick read the body", async () => {
    const landed = acceptedBody([12], [{ ticket: 12, state: "done", run: 8000 }]);
    const github = holdingReplay(landed);

    await applyPlan(github, repo, release);

    expect(github.issue.body).toBe(landed);
    expect(github.calls).toEqual([`GET ${issues}/140`]);
  });
});

describe("Applying a plan that rebases an agent PR onto main (#304)", () => {
  const MAIN = "9".repeat(40);

  /** A rebaser that finds the branch rebases with this outcome, and records what it was asked and what it pushed. */
  function fakeRebaser(outcome: "rebased" | "conflicted" | "up-to-date" | "gone", leaseHolds = true) {
    const asked: [string, string][] = [];
    const pushed: string[] = [];
    return {
      asked,
      pushed,
      async rebase(branch: string, onto: string) {
        asked.push([branch, onto]);
        return {
          outcome,
          push: async () => {
            if (!leaseHolds) throw new Error("stale info");
            pushed.push(branch);
          },
        };
      },
    };
  }

  const plan: Plan = {
    kind: "act",
    actions: [
      {
        kind: "rebase-onto-main",
        pullRequest: 50,
        branch: "fabrik/ticket-7",
        onto: MAIN,
        clean: [{ kind: "comment", issue: 50, body: "clean" }],
        pushed: [{ kind: "comment", issue: 50, body: "pushed" }],
        refused: [{ kind: "comment", issue: 50, body: "refused" }],
        conflicted: [
          { kind: "comment", issue: 50, body: "conflicted" },
          { kind: "add-labels", issue: 7, labels: ["agent:implement"] },
        ],
      },
    ],
  };

  it("when the rebase is clean, applies the clean actions, pushes the rebased branch, then applies the pushed actions", async () => {
    const github = fakeGitHub();
    const rebaser = fakeRebaser("rebased");
    const order: string[] = [];
    const watched = {
      ...github,
      async rest(method: string, path: string, body?: unknown) {
        order.push(`${method} ${path}`);
        return github.rest(method, path, body);
      },
    };
    const pushOrder = {
      async rebase(branch: string, onto: string) {
        const result = await rebaser.rebase(branch, onto);
        return { ...result, push: async () => (order.push("push"), result.push()) };
      },
    };

    await applyPlan(watched, repo, plan, null, null, pushOrder);

    expect(rebaser.asked).toEqual([["fabrik/ticket-7", MAIN]]);
    expect(order).toEqual([`POST ${issues}/50/comments`, "push", `POST ${issues}/50/comments`]);
    expect(github.calls.map(({ body }) => body)).toEqual([{ body: "clean" }, { body: "pushed" }]);
    expect(rebaser.pushed).toEqual(["fabrik/ticket-7"]);
  });

  it("when its lease refuses the push, applies the refused actions instead of the pushed ones", async () => {
    const github = fakeGitHub();

    await applyPlan(github, repo, plan, null, null, fakeRebaser("rebased", false));

    expect(github.calls.map(({ body }) => body)).toEqual([{ body: "clean" }, { body: "refused" }]);
  });

  it("when it conflicts, applies the conflicted actions instead and pushes nothing", async () => {
    const github = fakeGitHub();
    const rebaser = fakeRebaser("conflicted");

    await applyPlan(github, repo, plan, null, null, rebaser);

    expect(github.calls.filter(({ method }) => method !== "GET").map(({ path, body }) => [path, body])).toEqual([
      [`${issues}/50/comments`, { body: "conflicted" }],
      [`${issues}/7/labels`, { labels: ["agent:implement"] }],
    ]);
    expect(rebaser.pushed).toEqual([]);
  });

  it.each(["up-to-date", "gone"] as const)("when the branch is %s, does neither", async (outcome) => {
    const github = fakeGitHub();
    const rebaser = fakeRebaser(outcome);

    await applyPlan(github, repo, plan, null, null, rebaser);

    expect(github.calls).toEqual([]);
    expect(rebaser.pushed).toEqual([]);
  });

  it("fails rather than guess when the job holds no way to rebase", async () => {
    await expect(applyPlan(fakeGitHub(), repo, plan)).rejects.toThrow(/rebase/);
  });
});

// #421 (and #408's Finding 1): a call that fails partway leaves some of the plan on GitHub, and the failure says which.
describe("Applying a plan when one of its actions fails", () => {
  it("throws, naming the action that failed, the ones already applied and the ones never applied, with GitHub's failure", async () => {
    const github = fakeGitHub();
    const failure = new GitHubError("GitHub PATCH failed: 502", 502, { request: `PATCH ${issues}/7` });
    const failing = {
      ...github,
      async rest(method: string, path: string, body?: unknown): Promise<unknown> {
        if (method === "PATCH") throw failure;
        return github.rest(method, path, body);
      },
    };
    const comment = { kind: "comment", issue: 7, body: "Verdict" } as const;
    const close = { kind: "close", issue: 7, reason: "completed" } as const;
    const label = { kind: "remove-label", issue: 7, label: "agent:review" } as const;

    const error = await applyPlan(failing, repo, { kind: "act", actions: [comment, close, label] }).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(PlanNotApplied);
    expect(error).toMatchObject({ failed: close, applied: [comment], unapplied: [label], cause: failure });
    expect(github.calls.map((call) => call.method)).toEqual(["POST"]);
  });
});
