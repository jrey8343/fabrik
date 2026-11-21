import { describe, expect, it } from "vitest";
import { DEFAULT_KIT_CONFIG, type KitConfig } from "../kit/config.ts";
import { TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL } from "../loop/labels.ts";
import { aDeploymentsRead, aDeployOf, aLabelAdded, aMergedLastDay, homeFactsOf } from "./builders.ts";
import type { DeploymentsRead } from "./deployments.ts";
import type { Facts } from "./gather.ts";
import { type PromoteEntry, promoteListOf } from "./promoteList.ts";
import { rowsOf, type StagingRead } from "./rows.ts";

const NOW = "2026-11-09T12:00:00Z";
const commit = (number: number) => String(number).padStart(40, "0");

/** A repo declaring production in `production`, dispatched by `deploy-production.yml`, and staging in `staging`, unless a test says otherwise. */
const declaring = (overrides: Partial<KitConfig> = {}) =>
  ({
    repo: "owner/product",
    branch: "main",
    config: {
      ok: true,
      config: {
        ...DEFAULT_KIT_CONFIG,
        production: { url: "https://shop.example", environment: "production", workflow: "deploy-production.yml" },
        staging: { url: "https://staging.shop.example", environment: "staging" },
        ...overrides,
      },
    },
    dispatch: null,
  }) as const;

/** Production's newest successful Deployment, 800 of commit `e…`, which succeeded a week before NOW: where the list starts. */
const SINCE = { from: "production", deployment: 800, commit: "e".repeat(40), at: "2026-11-02T09:00:00Z", deployedAt: "2026-11-02T09:15:00Z" } as const;

/** Agent pull request `number`, closing Ticket `number - 40`, merged at `mergedAt` as commit `number`. */
const merged = (number: number, mergedAt: string, title = "Build the thing") => aMergedLastDay(mergedAt, { number, ticket: number - 40, mergeCommit: commit(number), title });
const ui = (pullRequest: number, routes: readonly string[] = ["/cart"]) => ({ pullRequest, marker: { run: 4400 + pullRequest, artifact: 900 + pullRequest, failure: null, routes } });
const byTheOperator = (label: string, at: string) => aLabelAdded(label, at, { actor: "operator" });
const staged = (merges: DeploymentsRead["merges"]): StagingRead => ({ deployments: { ...aDeploymentsRead(merges, NOW), environment: "staging" }, mainChecks: null });
const onStaging = (number: number, at: string) => aDeployOf({ is: "succeeded", deployment: 600 + number, commit: commit(number), at });

/**
 * Ten agent pull requests production has not taken, 60 the newest:
 * 60 carries UI evidence, is on staging and is untried; 59 the Operator
 * accepted; 58 they found a problem on, Trial problem 70, which 57 closed
 * and they accepted 57; 56 they found Trial problem 71 on, still open; 55
 * carries no evidence and is on staging; 54's staging deploy failed; 53's is
 * running; 52 merged two hours ago with none started; 51 merged ten minutes
 * ago with none started. All but 55 and 57 carry UI evidence.
 */
const UNPROMOTED = [
  merged(51, "2026-11-09T11:50:00Z"),
  merged(52, "2026-11-09T10:00:00Z"),
  merged(60, "2026-11-08T16:00:00Z", "Show the cart total"),
  merged(59, "2026-11-08T15:00:00Z"),
  merged(57, "2026-11-08T14:00:00Z"),
  merged(55, "2026-11-08T13:00:00Z"),
  merged(58, "2026-11-06T10:00:00Z"),
  merged(56, "2026-11-05T10:00:00Z"),
  merged(54, "2026-11-04T10:00:00Z"),
  merged(53, "2026-11-03T10:00:00Z"),
];
const TRIALS = {
  pullRequests: [
    { pullRequest: 59, labelEvents: [byTheOperator(TRIAL_ACCEPTED_LABEL, "2026-11-09T09:00:00Z")], closes: [19] },
    { pullRequest: 58, labelEvents: [byTheOperator(TRIAL_PROBLEM_LABEL, "2026-11-07T09:00:00Z")], closes: [18] },
    { pullRequest: 57, labelEvents: [byTheOperator(TRIAL_ACCEPTED_LABEL, "2026-11-09T10:00:00Z")], closes: [70] },
    { pullRequest: 56, labelEvents: [byTheOperator(TRIAL_PROBLEM_LABEL, "2026-11-09T08:00:00Z")], closes: [16] },
  ],
  problems: [
    { issue: 70, pullRequest: 58, title: "The cart total reads 0", open: false, closedAs: "completed" },
    { issue: 71, pullRequest: 56, title: "The basket loses its last line", open: true, closedAs: null },
  ],
} as const;
const STAGING_READ = staged({
  [commit(60)]: onStaging(60, "2026-11-08T16:06:00Z"),
  [commit(59)]: onStaging(59, "2026-11-08T15:06:00Z"),
  [commit(58)]: onStaging(58, "2026-11-06T10:06:00Z"),
  [commit(57)]: onStaging(57, "2026-11-08T14:06:00Z"),
  [commit(56)]: onStaging(56, "2026-11-05T10:06:00Z"),
  [commit(55)]: onStaging(55, "2026-11-08T13:06:00Z"),
  [commit(54)]: aDeployOf({ is: "failed", deployment: 654, commit: commit(54), at: "2026-11-04T10:08:00Z", log: "https://github.com/owner/product/actions/runs/54/job/1" }),
  [commit(53)]: aDeployOf({ is: "running", deployment: 653, commit: commit(53), at: "2026-11-09T11:55:00Z" }),
  [commit(52)]: aDeployOf(),
  [commit(51)]: aDeployOf(),
});

/** What a gather of that repo holds, with these facts past the last day beside. */
const facts = (staging: Partial<NonNullable<Facts["staging"]>> = {}, kit: Partial<KitConfig> = {}): Facts =>
  homeFactsOf({
    kit: declaring(kit),
    mergedLastDay: UNPROMOTED.filter(({ mergedAt }) => Date.parse(mergedAt) >= Date.parse(NOW) - 24 * 60 * 60 * 1000),
    staging: {
      since: SINCE,
      unpromoted: UNPROMOTED,
      promoted: [],
      plain: [],
      mergedSince: UNPROMOTED.length,
      trials: TRIALS,
      evidenceMarkers: [60, 59, 58, 56, 54, 53, 52, 51].map((pullRequest) => ui(pullRequest)),
      shotsMarkers: [],
      ...staging,
    },
  });

const agentEntries = (entries: readonly PromoteEntry[]) => entries.flatMap((entry) => (entry.is === "agent" ? [entry] : []));
const entryOf = (entries: readonly PromoteEntry[], pullRequest: number) => agentEntries(entries).find((entry) => entry.pullRequest === pullRequest);

describe("the promote list", () => {
  it("is null for a repo whose Kit config declares no staging, one whose Kit config is invalid, and the store", () => {
    const merges = { mergedLastDay: [merged(60, "2026-11-09T10:00:00Z")] };

    expect(promoteListOf(homeFactsOf(merges), null, NOW)).toBeNull();
    expect(promoteListOf(homeFactsOf({ ...merges, kit: declaring({ staging: null }) }), STAGING_READ, NOW)).toBeNull();
    expect(promoteListOf(homeFactsOf({ ...merges, kit: { ...declaring(), config: { ok: false, errors: ["staging.url is missing"] } } }), STAGING_READ, NOW)).toBeNull();
    expect(promoteListOf({ kind: "store", appLogin: "fabrik-app[bot]", summaries: [], failedSummaryIssues: [], readyForHuman: [] }, null, NOW)).toBeNull();
  });

  it("holds every pull request production has not taken, newest first, each agent one with its number, title, Ticket and merge time, and names the Deployment it starts at", () => {
    const list = promoteListOf(facts(), STAGING_READ, NOW);

    expect(list).toMatchObject({ repo: "owner/product", start: { from: "production", deployment: 800, commit: "e".repeat(40), deployedAt: "2026-11-02T09:15:00Z" }, leftOut: 0 });
    expect(list?.entries.map((entry) => entry.pullRequest)).toEqual([51, 52, 60, 59, 57, 55, 58, 56, 54, 53]);
    expect(entryOf(list?.entries ?? [], 60)).toMatchObject({ is: "agent", pullRequest: 60, title: "Show the cart total", ticket: 20, mergedAt: "2026-11-08T16:00:00Z" });
  });

  it("gives an agent entry its evidence and shots as its row gives them, its staging pages and what to try", () => {
    const withShots = facts({
      evidenceMarkers: [ui(60, ["/cart", "/orders/[orderId]"])],
      shotsMarkers: [{ pullRequest: 59, marker: { source: "shots", head: "c".repeat(40), run: 9300, artifact: 9301, failure: null, routes: [], named: [{ name: "composer: draft ready", path: "/compose" }], missed: [] } }],
    });
    const rows = rowsOf(withShots, null, null, null, NOW, STAGING_READ);
    const rowOf = (pullRequest: number) => rows.find(({ standing }) => standing.pullRequest === pullRequest);

    const { entries } = promoteListOf(withShots, STAGING_READ, NOW) ?? { entries: [] };

    expect(entryOf(entries, 60)).toMatchObject({
      evidence: { run: 4460, artifact: 960, failure: null, pages: [{ route: "/cart" }, { route: "/orders/[orderId]" }] },
      shots: null,
      staging: {
        site: "https://staging.shop.example",
        pages: [
          { route: "/cart", url: "https://staging.shop.example/cart" },
          { route: "/orders/[orderId]", url: "https://staging.shop.example" },
        ],
        shots: [],
        toTry: ["/cart", "/orders/[orderId]"],
      },
    });
    expect(entryOf(entries, 59)).toMatchObject({
      evidence: null,
      shots: { run: 9300, named: [{ name: "composer: draft ready", path: "/compose", production: "https://shop.example/compose" }] },
      staging: { pages: [], shots: [{ name: "composer: draft ready", url: "https://staging.shop.example" }], toTry: ["composer: draft ready"] },
    });
    for (const pullRequest of [60, 59]) {
      const row = rowOf(pullRequest);
      const entry = entryOf(entries, pullRequest);

      expect(row).toBeDefined();
      expect(entry?.evidence).toEqual(row?.evidence);
      expect(entry?.shots).toEqual(row?.shots);
      expect(entry?.staging).toEqual(row?.staging);
    }
  });

  describe("an agent entry's trial result, which is what its Standing at Staging says for the same facts", () => {
    const rows = rowsOf(facts(), null, null, null, NOW, STAGING_READ);
    const standingOf = (pullRequest: number) => rows.find(({ standing }) => standing.pullRequest === pullRequest)?.standing;
    const { entries } = promoteListOf(facts(), STAGING_READ, NOW) ?? { entries: [] };

    it("is untried for one on staging that needs a Staging trial and has no result, as its Standing is on staging and the Operator's", () => {
      expect(standingOf(60)).toMatchObject({ place: "staging", name: "on-staging", move: "operator", detail: { staging: { trial: { needed: true, why: "ui-evidence" }, result: null } } });
      expect(entryOf(entries, 60)).toMatchObject({ trial: { needed: true, why: "ui-evidence" }, result: { is: "untried" } });
    });

    it("is accepted, by the Operator's own label, as its Standing is trial accepted", () => {
      expect(standingOf(59)).toMatchObject({ place: "staging", name: "trial-accepted", detail: { staging: { result: { is: "accepted", at: "2026-11-09T09:00:00Z", fix: null } } } });
      expect(entryOf(entries, 59)?.result).toEqual({ is: "accepted", at: "2026-11-09T09:00:00Z", fix: null, problems: [] });
    });

    it("is accepted through its fix, naming the fix and the Trial problem with its title, as its Standing is trial accepted through that fix", () => {
      expect(standingOf(58)).toMatchObject({ place: "staging", name: "trial-accepted", detail: { staging: { result: { is: "accepted", at: "2026-11-09T10:00:00Z", fix: [57], problems: [{ issue: 70, open: false }] } } } });
      expect(entryOf(entries, 58)?.result).toEqual({ is: "accepted", at: "2026-11-09T10:00:00Z", fix: [57], problems: [{ issue: 70, title: "The cart total reads 0", open: false }] });
      // The fix itself needs a Staging trial for the Trial problem it closes, and the Operator accepted it.
      expect(entryOf(entries, 57)).toMatchObject({ trial: { needed: true, why: "closes-trial-problem" }, result: { is: "accepted", fix: null } });
    });

    it("is a problem, with its Trial problems, as its Standing is trial problem", () => {
      expect(standingOf(56)).toMatchObject({ place: "staging", name: "trial-problem", detail: { staging: { result: { is: "problem", at: "2026-11-09T08:00:00Z", problems: [{ issue: 71, open: true }] } } } });
      expect(entryOf(entries, 56)?.result).toEqual({ is: "problem", at: "2026-11-09T08:00:00Z", problems: [{ issue: 71, title: "The basket loses its last line", open: true }] });
    });

    it("is changes no screen for one on staging that needs no Staging trial, as its Standing is on staging and nobody's", () => {
      expect(standingOf(55)).toMatchObject({ place: "staging", name: "on-staging", move: "nobody", detail: { staging: { trial: { needed: false, why: "no-screen" } } } });
      expect(entryOf(entries, 55)).toMatchObject({ trial: { needed: false, why: "no-screen" }, result: { is: "no-screen" } });
    });

    it.each([
      [54, "deploy-failed"],
      [53, "deploying"],
      [52, "no-deploy-seen"],
      [51, "merged"],
    ] as const)("is not yet on staging for #%i, with the name %s its Standing at Staging has", (pullRequest, name) => {
      expect(standingOf(pullRequest)).toMatchObject({ place: "staging", name });
      expect(entryOf(entries, pullRequest)?.result).toEqual({ is: "not-on-staging", name, unread: false });
    });

    it("says so where its staging deploys could not be read: not yet on staging as merged, unread, as its Standing is", () => {
      const unread = promoteListOf(facts(), null, NOW);

      expect(rowsOf(facts(), null, null, null, NOW).find(({ standing }) => standing.pullRequest === 60)?.standing).toMatchObject({ place: "staging", name: "merged", detail: { deploysUnread: true } });
      expect(entryOf(unread?.entries ?? [], 60)?.result).toEqual({ is: "not-on-staging", name: "merged", unread: true });
      // A result is the Operator's word, whatever the deploys say.
      expect(entryOf(unread?.entries ?? [], 59)?.result).toMatchObject({ is: "accepted" });
    });

    it("says the result of one whose Standing at Staging ended days ago, and still says where one is at Staging once a production Deployment has started on it", () => {
      const long = facts({ trials: { ...TRIALS, pullRequests: [{ pullRequest: 59, labelEvents: [byTheOperator(TRIAL_ACCEPTED_LABEL, "2026-11-04T09:00:00Z")], closes: [19] }] } });
      const started = aDeploymentsRead({ [commit(60)]: aDeployOf({ is: "running", deployment: 950, commit: commit(60), at: "2026-11-09T11:58:00Z" }) }, NOW);
      const promoting = rowsOf(long, null, null, started, NOW, STAGING_READ);

      const { entries: later } = promoteListOf(long, STAGING_READ, NOW) ?? { entries: [] };

      expect(promoting.find(({ standing }) => standing.pullRequest === 59)).toBeUndefined();
      expect(entryOf(later, 59)?.result).toEqual({ is: "accepted", at: "2026-11-04T09:00:00Z", fix: null, problems: [] });
      expect(promoting.find(({ standing }) => standing.pullRequest === 60)?.standing).toMatchObject({ place: "production", name: "deploying" });
      expect(entryOf(later, 60)?.result).toEqual({ is: "untried" });
    });
  });

  it("counts as not yet accepted every entry that needs a Staging trial and is not accepted: untried, a problem, and not yet on staging", () => {
    const list = promoteListOf(facts(), STAGING_READ, NOW);
    const counted = agentEntries(list?.entries ?? []).filter(({ trial, result }) => trial.needed && result.is !== "accepted");

    expect(counted.map(({ pullRequest }) => pullRequest)).toEqual([51, 52, 60, 56, 54, 53]);
    expect(list?.notAccepted).toBe(6);
    // One that changes no screen is never counted, on staging or not, nor whatever label it was given.
    const noScreens = facts({ unpromoted: [merged(55, "2026-11-08T13:00:00Z"), merged(45, "2026-11-08T12:00:00Z"), merged(44, "2026-11-09T11:50:00Z")], evidenceMarkers: [], trials: { pullRequests: [{ pullRequest: 45, labelEvents: [byTheOperator(TRIAL_PROBLEM_LABEL, "2026-11-09T08:00:00Z")], closes: [5] }], problems: [] } });
    expect(promoteListOf(noScreens, STAGING_READ, NOW)).toMatchObject({ notAccepted: 0, entries: [{ pullRequest: 44, result: { is: "not-on-staging" } }, { pullRequest: 55, result: { is: "no-screen" } }, { pullRequest: 45, result: { is: "problem" } }] });
  });

  it("holds a Kit bump, a Pairing session's pull request and the Operator's own each with its kind, no evidence and no staging pages, among the agent ones by merge time, and counts none of them", () => {
    const plain = [
      { number: 64, title: "Bump the Kit to v3.2.0", mergedAt: "2026-11-09T11:55:00Z", author: "dependabot[bot]", headRef: "dependabot/github_actions/fabrik-3.2.0", closes: [] },
      { number: 63, title: "Pair on the cart", mergedAt: "2026-11-08T15:30:00Z", author: "operator", headRef: "fabrik/pair-12", closes: [12] },
      { number: 62, title: "Fix a typo", mergedAt: "2026-11-05T12:00:00Z", author: "operator", headRef: "fix-typo", closes: [] },
      { number: 61, title: "Upgrade the Kit's files", mergedAt: "2026-11-04T12:00:00Z", author: "operator", headRef: "fabrik/upgrade-v3.2.0", closes: [] },
      { number: 47, title: "Bump the skills", mergedAt: "2026-11-03T12:00:00Z", author: "fabrik-app[bot]", headRef: "fabrik/skills-bump/2026-11-03", closes: [] },
    ];
    // The Operator can label any pull request: a Plain one's label gives its entry no result.
    const labelled = { ...TRIALS, pullRequests: [...TRIALS.pullRequests, { pullRequest: 62, labelEvents: [byTheOperator(TRIAL_PROBLEM_LABEL, "2026-11-06T09:00:00Z")], closes: [] }] };

    const list = promoteListOf(facts({ plain, trials: labelled, mergedSince: 15 }), STAGING_READ, NOW);

    expect(list?.entries.map((entry) => entry.pullRequest)).toEqual([64, 51, 52, 60, 63, 59, 57, 55, 58, 62, 56, 61, 54, 47, 53]);
    expect(list?.entries.filter((entry) => entry.is === "plain")).toEqual([
      { is: "plain", pullRequest: 64, title: "Bump the Kit to v3.2.0", mergedAt: "2026-11-09T11:55:00Z", kind: "kit-bump" },
      { is: "plain", pullRequest: 63, title: "Pair on the cart", mergedAt: "2026-11-08T15:30:00Z", kind: "pairing" },
      { is: "plain", pullRequest: 62, title: "Fix a typo", mergedAt: "2026-11-05T12:00:00Z", kind: "other" },
      { is: "plain", pullRequest: 61, title: "Upgrade the Kit's files", mergedAt: "2026-11-04T12:00:00Z", kind: "setup" },
      { is: "plain", pullRequest: 47, title: "Bump the skills", mergedAt: "2026-11-03T12:00:00Z", kind: "skills-bump" },
    ]);
    expect(list).toMatchObject({ notAccepted: 6, leftOut: 0 });
    // No Plain pull request has a Standing at Staging, or anywhere past its merge.
    const standings = rowsOf(facts({ plain, trials: labelled, mergedSince: 15 }), null, null, null, NOW, STAGING_READ).map(({ standing }) => standing.pullRequest);
    for (const { number } of plain) expect(standings).not.toContain(number);
  });

  it("carries GitHub's Actions page for production.workflow in that repo as its dispatch page, and none where the block names no workflow or Kit config declares no production", () => {
    const tracked = { url: "https://shop.example", environment: "production" };

    expect(promoteListOf(facts(), STAGING_READ, NOW)?.dispatchPage).toBe("https://github.com/owner/product/actions/workflows/deploy-production.yml");
    expect(promoteListOf(facts({}, { production: { ...tracked, workflow: null } }), STAGING_READ, NOW)?.dispatchPage).toBeNull();
    expect(promoteListOf(facts({}, { production: tracked }), STAGING_READ, NOW)?.dispatchPage).toBeNull();
    expect(promoteListOf(facts({}, { production: null }), STAGING_READ, NOW)).toMatchObject({ dispatchPage: null, entries: [{ pullRequest: 51 }, {}, {}, {}, {}, {}, {}, {}, {}, {}] });
  });

  it("says which start it used: the first successful staging Deployment where the gather found no production one, and none, with nothing in it, where it found neither", () => {
    const fromStaging = { from: "staging", deployment: 602, commit: "7".repeat(40), at: "2026-10-04T09:00:00Z", deployedAt: "2026-10-04T09:10:00Z" } as const;

    expect(promoteListOf(facts({ since: fromStaging }), STAGING_READ, NOW)?.start).toEqual({ from: "staging", deployment: 602, commit: "7".repeat(40), deployedAt: "2026-10-04T09:10:00Z" });
    expect(promoteListOf(facts({ since: null, unpromoted: [], mergedSince: 0 }), STAGING_READ, NOW)).toEqual({ repo: "owner/product", start: null, entries: [], notAccepted: 0, leftOut: 0, dispatchPage: "https://github.com/owner/product/actions/workflows/deploy-production.yml" });
  });

  it("holds the 100 most recent merges, agent and Plain together, and says how many it left out", () => {
    // 120 merges since the start, an hour apart, newest first: every sixth a Plain one. The gather keeps the 100 agent ones and the Plain ones among the 100 most recent of either kind.
    const hours = (back: number) => new Date(Date.parse("2026-11-09T11:00:00Z") - back * 60 * 60 * 1000).toISOString().replace(".000Z", "Z");
    const all = Array.from({ length: 120 }, (_, at) => ({ number: 1000 - at, mergedAt: hours(at), plain: at % 6 === 5 }));
    const many = facts({
      unpromoted: all.filter(({ plain }) => !plain).map(({ number, mergedAt }) => merged(number, mergedAt)),
      plain: all.slice(0, 100).filter(({ plain }) => plain).map(({ number, mergedAt }) => ({ number, title: "Fix a typo", mergedAt, author: "operator", headRef: "fix-typo", closes: [] })),
      mergedSince: 120,
      evidenceMarkers: [],
      trials: { pullRequests: [], problems: [] },
    });

    const list = promoteListOf(many, null, NOW);

    expect(list?.entries).toHaveLength(100);
    expect(list?.entries.map((entry) => entry.pullRequest)).toEqual(Array.from({ length: 100 }, (_, at) => 1000 - at));
    expect(list?.leftOut).toBe(20);
  });

  it("is plain data: written as JSON and read back it is equal", () => {
    const list = promoteListOf(facts(), STAGING_READ, NOW);

    expect(JSON.parse(JSON.stringify(list))).toStrictEqual(list);
  });
});
