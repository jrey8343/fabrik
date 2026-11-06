import { describe, expect, it } from "vitest";
import type { Plan } from "../loop/types.ts";
import { applyPlan } from "./apply.ts";

const repo = { owner: "acme", name: "shop" };
const issues = "/repos/acme/shop/issues";

/**
 * A GitHub that records every REST call. Each existing issue's database id is
 * its number plus 1000; a created issue gets the next number from 100. A
 * comment it posts is comment 9300.
 */
function fakeGitHub() {
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
      async graphql(): Promise<never> {
        throw new Error("no GraphQL expected");
      },
    };
  }

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

  it("reacts to each inline comment of a review, on every page, and never to the review itself", async () => {
    const inline = Array.from({ length: 101 }, (_, i) => 8000 + i);
    const github = gitHubWithReview(inline);
    const plan: Plan = {
      kind: "act",
      actions: [{ kind: "react", pullRequest: 50, on: { kind: "review", review: 900 }, content: "eyes" }],
    };

    await applyPlan(github, repo, plan);

    expect(posts(github)).toStrictEqual(
      inline.map((id) => ({ path: `/repos/acme/shop/pulls/comments/${id}/reactions`, body: { content: "eyes" } })),
    );
  });

  it("reacts to nothing for a review with no inline comments", async () => {
    const github = gitHubWithReview([]);
    const plan: Plan = {
      kind: "act",
      actions: [{ kind: "react", pullRequest: 50, on: { kind: "review", review: 900 }, content: "eyes" }],
    };

    await applyPlan(github, repo, plan);

    expect(posts(github)).toStrictEqual([]);
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

    expect(applied).toEqual({ preview: { pullRequest: 51, url: `https://deploy-preview-51--shop.netlify.app/fabrik-ticket-7/${HEAD}` } });
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

    expect(await applyPlan(fakeGitHub(), repo, plan, heldBranch())).toEqual({ preview: null });
    expect(await applyPlan(fakeGitHub(), repo, { kind: "nothing", reason: "no change" })).toEqual({ preview: null });
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

      expect(applied).toEqual({ preview: { round: 9300, url: `https://prototype-7--shop.netlify.app/${HEAD}/book` } });
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
