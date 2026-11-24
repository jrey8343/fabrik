// The untried queue (#966), read against a canned GitHub: which merged agent
// pull requests are untried on staging, by the read library's own rule.
import { describe, expect, it } from "vitest";
import { CALLER, CALLER_PATH, NOW, OPERATOR } from "../__fixtures__/cannedRepo.ts";
import { aDeployment, anAgentMerge, commitOf, declaring, labelledByOperator, LIVE, stagingRepo, THREE_ON_STAGING } from "./stagingRepo.fixture.ts";
import { readUntriedQueue } from "./untriedQueue.ts";

const REPO = "jrey8343/shop";

describe("the untried queue, asked with no pull request", () => {
  it("is every merged agent pull request untried on staging, oldest merge first, each with its address on GitHub, its links on staging and its Trial steps, beside the staging and production addresses Kit config gives", async () => {
    const { client } = stagingRepo(THREE_ON_STAGING);
    const cart = "https://staging.shop.example/cart";
    const trialSteps = { summary: "A shopper now sees the cart's total.", steps: [{ do: "Add any product.", expect: "The total under the list, with tax.", route: "/cart", url: cart }] };
    const onStaging = { site: "https://staging.shop.example", pages: [{ route: "/cart", url: cart }], shots: [], toTry: ["/cart"], trialSteps, result: { is: "untried" } };

    expect(await readUntriedQueue(client, REPO, null, NOW)).toEqual({
      ok: true,
      printed: {
        repo: "jrey8343/shop",
        staging: { url: "https://staging.shop.example" },
        production: { url: "https://shop.example" },
        untried: [
          { number: 55, title: "Show the cart's total", url: "https://github.com/jrey8343/shop/pull/55", mergedAt: "2026-11-05T10:00:00Z", ...onStaging },
          { number: 57, title: "Show the cart's tax", url: "https://github.com/jrey8343/shop/pull/57", mergedAt: "2026-11-07T10:00:00Z", ...onStaging },
        ],
        unread: [],
      },
    });
  });

  it.each([
    ["nothing has merged since production's last deployment", { files: declaring(), deployments: { production: [LIVE] }, mergedPullRequests: [] }],
    [
      "the only one on staging is accepted and the only other's deploy to staging is still running",
      {
        files: declaring(),
        deployments: { production: [LIVE], staging: [aDeployment("staging", 656, 56, "2026-11-06T10:05:00Z"), aDeployment("staging", 657, 57, "2026-11-09T11:45:00Z", ["IN_PROGRESS"])] },
        mergedPullRequests: [anAgentMerge(57, "2026-11-09T11:40:00Z"), anAgentMerge(56, "2026-11-06T10:00:00Z", { timelineItems: { nodes: [labelledByOperator("fabrik:trial-accepted", "2026-11-08T09:00:00Z")] } })],
      },
    ],
  ])("is an empty list where %s", async (_where, raw) => {
    const { client } = stagingRepo(raw);

    expect(await readUntriedQueue(client, REPO, null, NOW)).toMatchObject({ ok: true, printed: { repo: "jrey8343/shop", untried: [], unread: [] } });
  });

  it("gives a null production where Kit config declares none, and still the queue, from the first successful staging Deployment", async () => {
    const { client } = stagingRepo({ ...THREE_ON_STAGING, files: declaring({ production: null }), deployments: { staging: THREE_ON_STAGING.deployments.staging } });

    expect(await readUntriedQueue(client, REPO, null, NOW)).toMatchObject({ ok: true, printed: { staging: { url: "https://staging.shop.example" }, production: null, untried: [{ number: 57 }] } });
  });

  it("leaves out one whose deploy to staging succeeded while a Main check the repo names is red on the commit staging runs, as the Standing rule does, and says why when asked for it", async () => {
    const red = [{ id: 1, name: "ci", status: "completed", conclusion: "failure", completed_at: "2026-11-07T10:20:00Z", html_url: "https://github.com/jrey8343/shop/runs/1" }];
    const named = { ...THREE_ON_STAGING, files: declaring({ monitor: { main_checks: ["ci"] } }) };
    const green = stagingRepo(named, { [commitOf(57)]: { ci: [{ ...red[0], conclusion: "success" }] } });
    const failing = stagingRepo(named, { [commitOf(57)]: { ci: red } });

    expect(await readUntriedQueue(green.client, REPO, null, NOW)).toMatchObject({ ok: true, printed: { untried: [{ number: 55 }, { number: 57 }] } });
    expect(await readUntriedQueue(failing.client, REPO, null, NOW)).toMatchObject({ ok: true, printed: { untried: [], unread: [] } });
    // The Main check was read once, on the commit staging runs: the newest success, which holds both merges.
    expect(failing.log.filter(({ path }) => path.includes("/check-runs?")).map(({ path }) => path.split("?")[0])).toEqual([`/repos/jrey8343/shop/commits/${commitOf(57)}/check-runs`]);
    expect(await readUntriedQueue(failing.client, REPO, 57, NOW)).toMatchObject({
      ok: true,
      printed: { pullRequest: { result: { is: "not-on-staging", name: "deploy-failed", unread: false }, standing: { name: "deploy-failed", sentence: "`ci` failed 2 days ago on the commit deployed to `staging`." } } },
    });
  });

  it("names each pull request whose staging deploys GitHub would not let it read, which may be on staging for all it can tell, and puts none of them in the queue", async () => {
    // The Deployments read's own query, which asks each Deployment's environment as the gather's does not.
    const { client } = stagingRepo({ ...THREE_ON_STAGING, refusing: "commitOid environment" });

    expect(await readUntriedQueue(client, REPO, null, NOW)).toMatchObject({ ok: true, printed: { untried: [], unread: [55, 57] } });
    expect(await readUntriedQueue(client, REPO, 55, NOW)).toMatchObject({
      ok: true,
      printed: { pullRequest: { result: { is: "not-on-staging", name: "merged", unread: true }, standing: { name: "merged", sentence: "Merged 4 days ago. Deployments to `staging` could not be read." } } },
    });
  });

  it("writes nothing: every request it makes of GitHub is a GET or a GraphQL query, with a pull request named or not", async () => {
    for (const pullRequest of [null, 55]) {
      const { client, log } = stagingRepo({ ...THREE_ON_STAGING, files: declaring({ monitor: { main_checks: ["ci"] } }) });

      expect(await readUntriedQueue(client, REPO, pullRequest, NOW)).toMatchObject({ ok: true });

      expect(log.filter(({ method, path, operation }) => !(method === "GET" || (method === "POST" && path === "/graphql" && operation === "query")))).toEqual([]);
      // The gather's queries, the Deployments read's, its comparisons and the Main checks read's requests were all made, so the log is of the whole read.
      expect(log.some(({ path }) => path.includes("/compare/"))).toBe(true);
      expect(log.some(({ path }) => path.includes("/check-runs?"))).toBe(true);
      expect(log.filter(({ operation }) => operation === "query").length).toBeGreaterThan(5);
    }
  });
});

describe("the untried queue, asked for one pull request", () => {
  /** Pull request 55 untried on staging, and 57, merged twenty minutes before NOW, whose deploy to staging has been running for fifteen. */
  const ONE_DEPLOYING = {
    files: declaring(),
    deployments: { production: [LIVE], staging: [aDeployment("staging", 655, 55, "2026-11-05T10:05:00Z"), aDeployment("staging", 657, 57, "2026-11-09T11:45:00Z", ["IN_PROGRESS"])] },
    mergedPullRequests: [anAgentMerge(57, "2026-11-09T11:40:00Z", { title: "Show the cart's tax" }), anAgentMerge(55, "2026-11-05T10:00:00Z", { title: "Show the cart's total" })],
  };

  it("is that pull request in the queue's shape, whatever its result, with its Standing's name and the Kit's sentence for it: one still deploying to staging says so", async () => {
    const { client } = stagingRepo(ONE_DEPLOYING);

    const read = await readUntriedQueue(client, REPO, 57, NOW);

    expect(read).toEqual({
      ok: true,
      printed: {
        repo: "jrey8343/shop",
        staging: { url: "https://staging.shop.example" },
        production: { url: "https://shop.example" },
        pullRequest: {
          number: 57,
          title: "Show the cart's tax",
          url: "https://github.com/jrey8343/shop/pull/57",
          mergedAt: "2026-11-09T11:40:00Z",
          site: "https://staging.shop.example",
          pages: [{ route: "/cart", url: "https://staging.shop.example/cart" }],
          shots: [],
          toTry: ["/cart"],
          trialSteps: {
            summary: "A shopper now sees the cart's total.",
            steps: [{ do: "Add any product.", expect: "The total under the list, with tax.", route: "/cart", url: "https://staging.shop.example/cart" }],
          },
          result: { is: "not-on-staging", name: "deploying", unread: false },
          standing: { name: "deploying", sentence: "A deploy to `staging` has been running for 15 minutes." },
        },
      },
    });
  });

  it("is one that is untried as the queue gives it, with its Standing beside it", async () => {
    const { client } = stagingRepo(ONE_DEPLOYING);

    const queue = await readUntriedQueue(client, REPO, null, NOW);
    const one = await readUntriedQueue(client, REPO, 55, NOW);

    expect(one).toMatchObject({ ok: true, printed: { pullRequest: { number: 55, result: { is: "untried" }, standing: { name: "on-staging", sentence: "On `staging` since 4 days ago. It carries UI evidence, so it needs a Staging trial." } } } });
    expect(queue).toMatchObject({ ok: true, printed: { untried: [{ number: 55 }] } });
    if (!one.ok || !queue.ok || !("pullRequest" in one.printed) || !("untried" in queue.printed)) throw new Error("not read");
    const { standing: _standing, ...asQueued } = one.printed.pullRequest;
    expect(asQueued).toEqual(queue.printed.untried[0]);
  });

  it.each([
    ["nothing in the repo", 99],
    ["an agent pull request production has taken", 52],
    ["a Plain pull request merged since", 58],
  ])("is refused in one line for the number of %s: it is no merged agent pull request on the Promote list", async (_what, number) => {
    const { client } = stagingRepo({
      ...ONE_DEPLOYING,
      mergedPullRequests: [
        ...ONE_DEPLOYING.mergedPullRequests,
        anAgentMerge(58, "2026-11-04T10:00:00Z", { title: "Fix a typo", headRefName: "fix-typo", author: OPERATOR, closingIssuesReferences: { nodes: [] }, body: "" }),
        anAgentMerge(52, "2026-11-02T09:00:01Z"),
      ],
    });

    expect(await readUntriedQueue(client, REPO, number, NOW)).toEqual({
      ok: false,
      problem: `#${number} is not a merged agent pull request on the Promote list of jrey8343/shop, which holds only what production has not taken.`,
    });
  });
});

describe("the untried queue of a repo it can't read one from", () => {
  it.each([
    ["with no staging block", { files: declaring({ staging: null }) }, "jrey8343/shop's Kit config declares no staging, so it has no Staging trials."],
    ["with no Kit config at all", { files: { [CALLER_PATH]: CALLER } }, "jrey8343/shop's Kit config declares no staging, so it has no Staging trials."],
    ["that doesn't run the Kit", { files: {} }, "jrey8343/shop is not a Product repo: no caller workflow at its default branch's head pins a Fabrik release."],
    [
      "whose Kit config is invalid",
      { files: declaring({ staging: { url: "staging.shop.example", environment: "staging" }, max_in_flight: -1 }) },
      'jrey8343/shop\'s Kit config is invalid: max_in_flight must be a whole number of at least 0; staging.url is "staging.shop.example": a URL must start with http:// or https://',
    ],
    [
      "whose facts GitHub refuses",
      { files: declaring(), refusing: "pullRequests(states: OPEN" },
      "jrey8343/shop could not be read: POST /graphql failed with 403: Resource not accessible by integration",
    ],
  ])("is refused in one line for a repo %s, with or without a pull request named", async (_which, raw, problem) => {
    for (const pullRequest of [null, 55]) {
      const { client } = stagingRepo(raw);

      expect(await readUntriedQueue(client, REPO, pullRequest, NOW)).toEqual({ ok: false, problem });
    }
  });

  it("is refused in one line when GitHub refuses the first read of the repo", async () => {
    const { client } = stagingRepo({ files: declaring(), refusing: "defaultBranchRef" });

    expect(await readUntriedQueue(client, REPO, null, NOW)).toEqual({ ok: false, problem: "jrey8343/shop could not be read: Resource not accessible by integration" });
  });
});
