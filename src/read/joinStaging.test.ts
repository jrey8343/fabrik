import { describe, expect, it } from "vitest";
import { DEFAULT_KIT_CONFIG, type KitConfig } from "../kit/config.ts";
import { TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL } from "../loop/labels.ts";
import { aDeploymentsRead, aDeployOf, aLabelAdded, aMergedLastDay, anOpenIssue, factsOf, homeFactsOf } from "./builders.ts";
import type { DeploymentsRead } from "./deployments.ts";
import type { Facts } from "./gather.ts";
import { joinDeployments, mergesToRead } from "./joinDeployments.ts";
import { commitsToCheck, joinStaging, stagingMergesToRead } from "./joinStaging.ts";
import type { MainCheckOf, MainChecksRead } from "./mainChecks.ts";
import { rowsOf, type StagingRead } from "./rows.ts";

const KEPT_AT = "2026-11-12T10:00:00Z";
const NOW = "2026-11-12T10:20:00Z";
const merge = (digit: string) => digit.repeat(40);
/** A commit a staging Deployment deployed, later than every merge here and containing them all. */
const DEPLOYED = "d".repeat(40);
const REDEPLOYED = "e".repeat(40);

/** A repo declaring production in `production` and staging in `staging`, naming the Main check `e2e`, unless a test says otherwise. */
const declaring = (overrides: Partial<KitConfig> = {}) =>
  ({
    repo: "owner/product",
    branch: "main",
    config: {
      ok: true,
      config: {
        ...DEFAULT_KIT_CONFIG,
        production: { url: "https://shop.example", environment: "production" },
        staging: { url: "https://staging.shop.example", environment: "staging" },
        monitor: { ...DEFAULT_KIT_CONFIG.monitor, mainChecks: ["e2e"] },
        ...overrides,
      },
    },
    dispatch: null,
  }) as const;

/**
 * Agent pull requests 50 to 53, merged at 09:30, 09:40, 09:50 and 09:55 with
 * merge commits 1 to 4, closing Tickets 7 to 10; 50 and 51 carry UI evidence,
 * 52 and 53 change no screen; and Ticket 14 waiting for a slot.
 */
const facts = (overrides: Partial<KitConfig> = {}): Facts =>
  homeFactsOf({
    kit: declaring(overrides),
    github: factsOf({ openIssues: [anOpenIssue({ number: 14, labels: ["ready-for-agent", "agent:implement"], labelEvents: [aLabelAdded("agent:implement", "2026-11-12T09:00:00Z")] })] }),
    mergedLastDay: [
      aMergedLastDay("2026-11-12T09:30:00Z", { number: 50, ticket: 7, mergeCommit: merge("1") }),
      aMergedLastDay("2026-11-12T09:40:00Z", { number: 51, ticket: 8, mergeCommit: merge("2") }),
      aMergedLastDay("2026-11-12T09:50:00Z", { number: 52, ticket: 9, mergeCommit: merge("3") }),
      aMergedLastDay("2026-11-12T09:55:00Z", { number: 53, ticket: 10, mergeCommit: merge("4") }),
    ],
    evidenceMarkers: [
      { pullRequest: 50, marker: { run: 4400, artifact: 900, failure: null, routes: ["/book"] } },
      { pullRequest: 51, marker: { run: 4401, artifact: 901, failure: null, routes: ["/cart"] } },
    ],
  });

/** A Deployments read of the `staging` environment, holding these merges. */
const staged = (merges: DeploymentsRead["merges"], readAt = NOW): DeploymentsRead => ({ ...aDeploymentsRead(merges, readAt), environment: "staging" });
/** A staging deploy of the merge's own commit that succeeded, and the newest that contains it, of `commit`. */
const succeeded = (own: string, at: string, commit = DEPLOYED, newestAt = "2026-11-12T10:00:00Z") =>
  aDeployOf({ is: "succeeded", deployment: 900, commit: own, at, newest: { deployment: 905, commit, at: newestAt } });
const check = (is: MainCheckOf["is"], at: string | null = "2026-11-12T10:05:00Z"): MainCheckOf => ({ name: "e2e", is, url: is === "undecided" ? null : "https://github.com/owner/product/actions/runs/7/job/903", at: is === "undecided" ? null : at });
const checked = (commits: MainChecksRead["commits"], readAt = NOW): MainChecksRead => ({ repo: "owner/product", readAt, commits });

/** An earlier read, at the keeping: 50 and 52 on staging with `e2e` green on DEPLOYED, 51 deploying, 53 with none yet. */
const EARLIER: StagingRead = {
  deployments: staged(
    {
      [merge("1")]: succeeded(merge("1"), "2026-11-12T09:36:00Z"),
      [merge("2")]: aDeployOf({ is: "running", deployment: 901, commit: merge("2"), at: "2026-11-12T09:45:00Z" }),
      [merge("3")]: succeeded(merge("3"), "2026-11-12T09:56:00Z"),
      [merge("4")]: aDeployOf(),
    },
    KEPT_AT,
  ),
  mainChecks: checked({ [DEPLOYED]: [check("green")] }, KEPT_AT),
};

const named = (rows: readonly { readonly standing: { readonly issue: number | null; readonly pullRequest: number | null; readonly name: string } }[]) => rows.map(({ standing }) => [standing.pullRequest ?? standing.issue, standing.name]);
const of = (rows: ReturnType<typeof rowsOf>, pullRequest: number) => rows.find(({ standing }) => standing.pullRequest === pullRequest);

describe("which merges want a staging Deployments read", () => {
  it("are the merge commit and merge time of every row at Staging, one on staging that needs a trial among them, but one on staging that needs none, which is settled", () => {
    const rows = rowsOf(facts(), null, null, null, KEPT_AT, EARLIER);

    expect(named(rows)).toEqual([
      [14, "not-started"],
      [50, "on-staging"],
      [51, "deploying"],
      [53, "merged"],
      [52, "on-staging"],
    ]);
    expect(rows.map(({ standing }) => standing.move)).toEqual(["kit", "operator", "nobody", "nobody", "nobody"]);
    expect(stagingMergesToRead(rows)).toEqual([
      { mergeCommit: merge("1"), mergedAt: "2026-11-12T09:30:00Z" },
      { mergeCommit: merge("2"), mergedAt: "2026-11-12T09:40:00Z" },
      { mergeCommit: merge("4"), mergedAt: "2026-11-12T09:55:00Z" },
    ]);
  });

  it("include a merge whose staging deploys were unread, and none at Production or from a repo that declares no staging", () => {
    const promoted = aDeploymentsRead({ [merge("1")]: aDeployOf({ is: "running", deployment: 950, commit: merge("1"), at: "2026-11-12T09:58:00Z" }) }, KEPT_AT);

    expect(stagingMergesToRead(rowsOf(facts(), null, null, null, KEPT_AT)).map(({ mergeCommit }) => mergeCommit)).toEqual([merge("1"), merge("2"), merge("3"), merge("4")]);
    expect(stagingMergesToRead(rowsOf(facts(), null, null, promoted, KEPT_AT)).map(({ mergeCommit }) => mergeCommit)).toEqual([merge("2"), merge("3"), merge("4")]);
    expect(stagingMergesToRead(rowsOf(facts({ staging: null }), null, null, promoted, KEPT_AT))).toEqual([]);
  });
});

describe("which merges want a Deployments read of production, in a repo that declares staging", () => {
  it("are every row at Staging too, settled or not, so a production Deployment starting is seen; and at Production every row but the Live ones, as ever", () => {
    const promoted = aDeploymentsRead(
      {
        [merge("1")]: aDeployOf({ is: "succeeded", deployment: 950, commit: merge("1"), at: "2026-11-12T09:58:00Z" }),
        [merge("2")]: aDeployOf({ is: "running", deployment: 951, commit: merge("2"), at: "2026-11-12T09:59:00Z" }),
      },
      KEPT_AT,
    );
    const rows = rowsOf(facts(), null, null, promoted, KEPT_AT, EARLIER);

    expect(rows.flatMap(({ standing }) => (standing.pullRequest === null ? [] : [[standing.pullRequest, standing.place, standing.name]]))).toEqual([
      [53, "staging", "merged"],
      [52, "staging", "on-staging"],
      [50, "production", "live"],
      [51, "production", "deploying"],
    ]);
    expect(mergesToRead(rows).map(({ mergeCommit }) => mergeCommit)).toEqual([merge("4"), merge("3"), merge("2")]);
  });

  it("are none of the rows at Staging in a repo that tracks no production deploys", () => {
    for (const production of [null, { url: "https://shop.example", environment: null }]) {
      const rows = rowsOf(facts({ production }), null, null, null, KEPT_AT, EARLIER);

      expect(rows.filter(({ standing }) => standing.place === "staging")).toHaveLength(4);
      expect(mergesToRead(rows)).toEqual([]);
    }
  });
});

describe("which commits want a Main checks read", () => {
  it("are, for the rows at Staging, the commit of the newest successful staging Deployment of each merge the read gives as succeeded, once each, with the Main checks the repo names", () => {
    const rows = rowsOf(facts(), null, null, null, KEPT_AT);
    const read = staged({
      [merge("1")]: succeeded(merge("1"), "2026-11-12T09:36:00Z"),
      [merge("2")]: succeeded(merge("2"), "2026-11-12T09:46:00Z", REDEPLOYED),
      [merge("3")]: succeeded(merge("3"), "2026-11-12T09:56:00Z"),
      [merge("4")]: aDeployOf({ is: "running", deployment: 901, commit: merge("4"), at: "2026-11-12T09:58:00Z" }),
    });

    expect(commitsToCheck(rows, read)).toEqual([
      { commit: DEPLOYED, checks: ["e2e"] },
      { commit: REDEPLOYED, checks: ["e2e"] },
    ]);
  });

  it("is the deploy's own commit where the read gives no newer one, and none for a merge the read leaves out, gives as unread, or does not give as succeeded", () => {
    const rows = rowsOf(facts(), null, null, null, KEPT_AT);
    const read = staged({
      [merge("1")]: aDeployOf({ is: "succeeded", deployment: 900, commit: merge("1"), at: "2026-11-12T09:36:00Z" }),
      [merge("2")]: "unread",
      [merge("3")]: aDeployOf({ is: "failed", deployment: 902, commit: merge("3"), at: "2026-11-12T09:56:00Z" }),
    });

    expect(commitsToCheck(rows, read)).toEqual([{ commit: merge("1"), checks: ["e2e"] }]);
  });

  it("are none in a repo that names no Main checks or has them off, from a read of another environment or repo, and for rows at Production", () => {
    const read = staged({ [merge("1")]: succeeded(merge("1"), "2026-11-12T09:36:00Z") });
    const promoted = aDeploymentsRead({ [merge("1")]: aDeployOf({ is: "running", deployment: 950, commit: merge("1"), at: "2026-11-12T09:58:00Z" }) }, KEPT_AT);

    expect(commitsToCheck(rowsOf(facts({ monitor: DEFAULT_KIT_CONFIG.monitor }), null, null, null, KEPT_AT), read)).toEqual([]);
    expect(commitsToCheck(rowsOf(facts({ monitor: { ...DEFAULT_KIT_CONFIG.monitor, redMain: false, mainChecks: ["e2e"] } }), null, null, null, KEPT_AT), read)).toEqual([]);
    expect(commitsToCheck(rowsOf(facts(), null, null, null, KEPT_AT), { ...read, environment: "production" })).toEqual([]);
    expect(commitsToCheck(rowsOf(facts(), null, null, null, KEPT_AT), { ...read, repo: "owner/other" })).toEqual([]);
    expect(commitsToCheck(rowsOf(facts(), null, null, promoted, KEPT_AT), read)).toEqual([]);
    expect(commitsToCheck(rowsOf(facts({ staging: null }), null, null, null, KEPT_AT), read)).toEqual([]);
  });
});

describe("the join of kept rows with a staging read", () => {
  /** A later read: 50's newest deploy is of REDEPLOYED, where `e2e` is red; 51 failed; 53 on staging with `e2e` still to pass. */
  const LATER: StagingRead = {
    deployments: staged({
      [merge("1")]: succeeded(merge("1"), "2026-11-12T09:36:00Z", REDEPLOYED, "2026-11-12T10:10:00Z"),
      [merge("2")]: aDeployOf({ is: "failed", deployment: 901, commit: merge("2"), at: "2026-11-12T10:05:00Z", log: "https://github.com/owner/product/actions/runs/40/job/41" }),
      [merge("4")]: aDeployOf({ is: "succeeded", deployment: 906, commit: merge("4"), at: "2026-11-12T10:12:00Z", newest: { deployment: 906, commit: merge("4"), at: "2026-11-12T10:12:00Z" } }),
    }),
    mainChecks: checked({ [REDEPLOYED]: [check("red", "2026-11-12T10:15:00Z")], [merge("4")]: [check("undecided")] }),
  };
  /** What the two reads say between them, the later where both speak of a merge or a commit. */
  const known = (earlier: StagingRead, later: StagingRead): StagingRead => ({
    deployments: later.deployments === null ? earlier.deployments : { ...later.deployments, merges: { ...earlier.deployments?.merges, ...later.deployments.merges } },
    mainChecks: later.mainChecks === null ? earlier.mainChecks : { ...later.mainChecks, commits: { ...earlier.mainChecks?.commits, ...later.mainChecks.commits } },
  });

  it("agrees with the rule for a Deployments and Main checks read, over the rows the rule gave with none", () => {
    for (const read of [EARLIER, LATER, known(EARLIER, LATER)]) {
      const kept = rowsOf(facts(), null, null, null, NOW);

      expect(kept.filter(({ standing }) => standing.pullRequest !== null).map(({ standing }) => standing)).toMatchObject(Array.from({ length: 4 }, () => ({ place: "staging", name: "merged", detail: { deploysUnread: true } })));
      expect(joinStaging(kept, read, NOW)).toEqual(rowsOf(facts(), null, null, null, NOW, read));
    }
  });

  it("gives each row at Staging the name, since and detail the rule gives for the read: a later deploy whose Main check is red moves one on staging back to deploy failed, with the check's link", () => {
    const kept = rowsOf(facts(), null, null, null, KEPT_AT, EARLIER);

    const joined = joinStaging(kept, LATER, NOW);

    expect(joined.filter(({ standing }) => standing.pullRequest !== null).map(({ standing }) => standing)).toMatchObject([
      { pullRequest: 52, name: "on-staging", move: "nobody", since: "2026-11-12T09:56:00Z" },
      { pullRequest: 51, name: "deploy-failed", since: "2026-11-12T10:05:00Z", detail: { deployment: 901, log: "https://github.com/owner/product/actions/runs/40/job/41", staging: { check: null } } },
      { pullRequest: 53, name: "deploying", move: "nobody", since: "2026-11-12T10:12:00Z", detail: { deployment: 906, staging: { check: "e2e", checksUnread: false } } },
      { pullRequest: 50, name: "deploy-failed", move: "nobody", yours: false, since: "2026-11-12T10:15:00Z", detail: { deployment: 905, log: "https://github.com/owner/product/actions/runs/7/job/903", staging: { check: "e2e" } } },
    ]);
    expect(joined).toEqual(rowsOf(facts(), null, null, null, NOW, known(EARLIER, LATER)));
  });

  it("makes an earlier failure on staging once a later deploy succeeded, the Operator's when it needs a trial, as the rule does", () => {
    const failed: StagingRead = { deployments: staged({ [merge("1")]: aDeployOf({ is: "failed", deployment: 899, commit: merge("1"), at: "2026-11-12T09:35:00Z" }) }, KEPT_AT), mainChecks: null };
    const fixed: StagingRead = { deployments: staged({ [merge("1")]: aDeployOf({ is: "succeeded", deployment: 905, commit: DEPLOYED, at: "2026-11-12T10:10:00Z" }) }), mainChecks: checked({ [DEPLOYED]: [check("green")] }) };
    const kept = rowsOf(facts(), null, null, null, KEPT_AT, failed);

    const joined = joinStaging(kept, fixed, NOW);

    expect(of(kept, 50)?.standing).toMatchObject({ place: "staging", name: "deploy-failed", move: "nobody" });
    expect(of(joined, 50)?.standing).toMatchObject({ place: "staging", name: "on-staging", move: "operator", yours: true, stopsWork: false, since: "2026-11-12T10:10:00Z", detail: { deployment: 905 } });
    expect(joined).toEqual(rowsOf(facts(), null, null, null, NOW, fixed));
  });

  it("turns a row with no deploy seen into deploying when a staging deploy starts after the hour, as the rule does", () => {
    const none: StagingRead = { deployments: staged({ [merge("4")]: aDeployOf() }, "2026-11-12T11:00:00Z"), mainChecks: null };
    const started: StagingRead = { deployments: staged({ [merge("4")]: aDeployOf({ is: "running", deployment: 903, commit: merge("4"), at: "2026-11-12T11:05:00Z" }) }, "2026-11-12T11:10:00Z"), mainChecks: null };
    const kept = rowsOf(facts(), null, null, null, "2026-11-12T11:00:00Z", none);

    const joined = joinStaging(kept, started, "2026-11-12T11:10:00Z");

    expect(of(kept, 53)?.standing).toMatchObject({ place: "staging", name: "no-deploy-seen", since: "2026-11-12T10:55:00.000Z" });
    expect(of(joined, 53)?.standing).toMatchObject({ place: "staging", name: "deploying", since: "2026-11-12T11:05:00Z" });
    expect(joined).toEqual(rowsOf(facts(), null, null, null, "2026-11-12T11:10:00Z", started));
  });

  it("reads a deploy that succeeded as deploying, its Main checks unread, when the read has no Main checks, or none of that commit; and never in a repo that names none", () => {
    const deployments = staged({ [merge("1")]: succeeded(merge("1"), "2026-11-12T09:36:00Z") });
    for (const mainChecks of [null, checked({}), checked({ [DEPLOYED]: "unread" })]) {
      const read = { deployments, mainChecks };
      const joined = joinStaging(rowsOf(facts(), null, null, null, KEPT_AT), read, NOW);

      expect(of(joined, 50)?.standing).toMatchObject({ name: "deploying", since: "2026-11-12T10:00:00Z", detail: { staging: { check: null, checksUnread: true } } });
      expect(joined).toEqual(rowsOf(facts(), null, null, null, NOW, read));
    }
    const naming = { monitor: DEFAULT_KIT_CONFIG.monitor };
    const joined = joinStaging(rowsOf(facts(naming), null, null, null, KEPT_AT), { deployments, mainChecks: null }, NOW);
    expect(of(joined, 50)?.standing).toMatchObject({ name: "on-staging", move: "operator" });
    expect(joined).toEqual(rowsOf(facts(naming), null, null, null, NOW, { deployments, mainChecks: null }));
  });

  it("returns a row unchanged when the read leaves out its merge, gives it as unread, or holds no Deployments read, but for reading it later", () => {
    const kept = rowsOf(facts(), null, null, null, KEPT_AT, EARLIER);
    const unread: StagingRead = { deployments: staged({ [merge("2")]: "unread" }), mainChecks: checked({ [DEPLOYED]: [check("red")] }) };

    for (const read of [unread, { deployments: null, mainChecks: unread.mainChecks }]) {
      const joined = joinStaging(kept, read, NOW);

      expect(joined).toHaveLength(kept.length);
      for (const [at, row] of joined.entries()) expect(row).toBe(kept[at]);
    }
    // Merge 4 had none at the keeping; left out of this read, it is read at the later time all the same.
    expect(of(joinStaging(kept, unread, "2026-11-12T10:56:00Z"), 53)?.standing).toMatchObject({ place: "staging", name: "no-deploy-seen", since: "2026-11-12T10:55:00.000Z" });
  });

  it("takes no read of another environment or repo, and leaves a row at Production as it is", () => {
    const kept = rowsOf(facts(), null, null, null, KEPT_AT, EARLIER);
    const nothing: StagingRead = { deployments: staged({}), mainChecks: null };
    const promoted = aDeploymentsRead({ [merge("1")]: aDeployOf({ is: "running", deployment: 950, commit: merge("1"), at: "2026-11-12T09:58:00Z" }) }, KEPT_AT);
    const atProduction = rowsOf(facts(), null, null, promoted, KEPT_AT, EARLIER);

    expect(joinStaging(kept, { ...LATER, deployments: { ...LATER.deployments!, environment: "production" } }, NOW)).toEqual(joinStaging(kept, nothing, NOW));
    expect(joinStaging(kept, { ...LATER, deployments: { ...LATER.deployments!, repo: "owner/other" } }, NOW)).toEqual(joinStaging(kept, nothing, NOW));
    expect(of(atProduction, 50)?.standing).toMatchObject({ place: "production", name: "deploying" });
    expect(of(joinStaging(atProduction, LATER, NOW), 50)).toBe(of(atProduction, 50));
  });

  it("leaves out a merged row once its 24 hours have passed, at Staging or at Production, as the rule does", () => {
    const after = "2026-11-13T09:41:00Z";
    const promoted = aDeploymentsRead({ [merge("3")]: aDeployOf({ is: "succeeded", deployment: 950, commit: merge("3"), at: "2026-11-12T09:58:00Z" }) }, KEPT_AT);
    const kept = rowsOf(facts(), null, null, promoted, KEPT_AT, EARLIER);

    const joined = joinStaging(kept, LATER, after);

    expect(named(joined)).toEqual([
      [14, "stuck"],
      [52, "live"],
      [53, "deploying"],
    ]);
    expect(joined).toEqual(rowsOf(facts(), null, null, promoted, after, known(EARLIER, LATER)));
  });

  it("reads every other row at the later time, as the rule reads a kept Standing", () => {
    const kept = rowsOf(facts(), null, null, null, KEPT_AT, EARLIER);

    expect(named(joinStaging(kept, LATER, "2026-11-12T23:00:00Z")).filter(([pullRequest]) => pullRequest === 14)).toEqual([[14, "stuck"]]);
  });

  it("gives a repo that declares no staging the rows the join with Deployments gives it for a read that says nothing, byte for byte", () => {
    const undeclared = facts({ staging: null });
    const live = aDeploymentsRead({ [merge("1")]: aDeployOf({ is: "succeeded", deployment: 900, commit: merge("1"), at: "2026-11-12T09:36:00Z" }) }, KEPT_AT);
    const kept = rowsOf(undeclared, null, null, live, KEPT_AT);

    expect(named(kept)).toEqual([
      [14, "not-started"],
      [50, "live"],
      [51, "merged"],
      [52, "merged"],
      [53, "merged"],
    ]);
    expect(JSON.stringify(joinStaging(kept, LATER, NOW))).toBe(JSON.stringify(joinDeployments(kept, aDeploymentsRead({}, NOW), NOW)));
    expect(JSON.stringify(joinStaging(kept, LATER, NOW))).toBe(JSON.stringify(kept));
  });
});

describe("the join with production's Deployments, in a repo that declares staging", () => {
  const promoting = (deploy: Parameters<typeof aDeployOf>[0], readAt = NOW) => aDeploymentsRead({ [merge("1")]: aDeployOf(deploy) }, readAt);

  it("moves a row at Staging to Production, as deploying, once a production Deployment that contains it has started, and agrees with the rule", () => {
    const started = promoting({ is: "running", deployment: 950, commit: merge("1"), at: "2026-11-12T10:15:00Z" });
    const kept = rowsOf(facts(), null, null, null, KEPT_AT, EARLIER);

    const joined = joinDeployments(kept, started, NOW);

    expect(of(kept, 50)?.standing).toMatchObject({ place: "staging", name: "on-staging", move: "operator" });
    expect(of(joined, 50)?.standing).toMatchObject({ place: "production", name: "deploying", move: "kit", yours: false, since: "2026-11-12T10:15:00Z", detail: { environment: "production", deployment: 950 } });
    expect(joined).toEqual(rowsOf(facts(), null, null, started, NOW, EARLIER));
  });

  it("gives it production's names from then on, as the rule does, and never merged or no deploy seen there", () => {
    const kept = rowsOf(facts(), null, null, promoting({ is: "running", deployment: 950, commit: merge("1"), at: "2026-11-12T09:58:00Z" }, KEPT_AT), KEPT_AT, EARLIER);
    const live = promoting({ is: "succeeded", deployment: 950, commit: merge("1"), at: "2026-11-12T10:10:00Z" });
    const failed = promoting({ is: "failed", deployment: 950, commit: merge("1"), at: "2026-11-12T10:10:00Z", log: "https://github.com/owner/product/actions/runs/60/job/61" });

    expect(of(joinDeployments(kept, live, NOW), 50)?.standing).toMatchObject({ place: "production", name: "live", since: "2026-11-12T10:10:00Z" });
    expect(joinDeployments(kept, live, NOW)).toEqual(rowsOf(facts(), null, null, live, NOW, EARLIER));
    expect(of(joinDeployments(kept, failed, NOW), 50)?.standing).toMatchObject({ place: "production", name: "deploy-failed", detail: { log: "https://github.com/owner/product/actions/runs/60/job/61" } });
    expect(joinDeployments(kept, failed, NOW)).toEqual(rowsOf(facts(), null, null, failed, NOW, EARLIER));
    for (const now of [NOW, "2026-11-12T12:00:00Z"]) {
      for (const read of [promoting({ is: "none" }), aDeploymentsRead({ [merge("1")]: "unread" }), aDeploymentsRead({})]) {
        const places = joinDeployments(rowsOf(facts(), null, null, null, KEPT_AT, EARLIER), read, now).map(({ standing }) => [standing.place, standing.name]);
        expect(places.filter(([place]) => place === "production")).toEqual([]);
        expect(places.filter(([place]) => place === "staging")).toHaveLength(4);
      }
    }
  });

  it("puts a row at Production back at Staging, its staging deploys unread, when production's read holds no Deployment that contains it any more; the join with staging then settles it as the rule does", () => {
    const kept = rowsOf(facts(), null, null, promoting({ is: "running", deployment: 950, commit: merge("1"), at: "2026-11-12T09:58:00Z" }, KEPT_AT), KEPT_AT, EARLIER);
    const none = promoting({ is: "none" });

    const back = joinDeployments(kept, none, NOW);

    expect(of(back, 50)?.standing).toMatchObject({ place: "staging", name: "merged", detail: { environment: "staging", deploysUnread: true, noDeployAt: null } });
    expect(back).toEqual(rowsOf(facts(), null, null, none, NOW, { deployments: staged({ [merge("2")]: EARLIER.deployments!.merges[merge("2")]!, [merge("3")]: EARLIER.deployments!.merges[merge("3")]!, [merge("4")]: aDeployOf() }), mainChecks: EARLIER.mainChecks }));
    expect(joinStaging(back, { ...EARLIER, deployments: staged(EARLIER.deployments!.merges) }, NOW)).toEqual(rowsOf(facts(), null, null, none, NOW, EARLIER));
  });

  it("takes no read of the staging environment for one, and never moves a row in a repo that tracks no production deploys", () => {
    const kept = rowsOf(facts(), null, null, null, KEPT_AT, EARLIER);
    const ofStaging = staged({ [merge("1")]: aDeployOf({ is: "running", deployment: 950, commit: merge("1"), at: "2026-11-12T10:15:00Z" }) });
    const started = promoting({ is: "running", deployment: 950, commit: merge("1"), at: "2026-11-12T10:15:00Z" });

    expect(joinDeployments(kept, ofStaging, NOW)).toEqual(joinDeployments(kept, aDeploymentsRead({}, NOW), NOW));
    for (const production of [null, { url: "https://shop.example", environment: null }]) {
      const untracked = rowsOf(facts({ production }), null, null, null, KEPT_AT, EARLIER);

      expect(of(joinDeployments(untracked, started, NOW), 50)?.standing).toMatchObject({ place: "staging", name: "on-staging" });
    }
  });

  it("leaves out a row at Staging once its 24 hours have passed, one on staging among them, as the rule does", () => {
    const after = "2026-11-13T09:51:00Z";
    const kept = rowsOf(facts(), null, null, null, KEPT_AT, EARLIER);

    const joined = joinDeployments(kept, aDeploymentsRead({}, after), after);

    expect(named(joined)).toEqual([
      [14, "stuck"],
      [53, "no-deploy-seen"],
    ]);
    expect(joined).toEqual(rowsOf(facts(), null, null, null, after, EARLIER));
  });
});

describe("the joins and a Staging trial's result (#856)", () => {
  /** The Operator adding `label` at `at`. */
  const added = (label: string, at: string) => aLabelAdded(label, at, { actor: "operator" });
  /** The facts above, with what a gather reads past the last day in a repo that declares staging: these label events on pull request 50, and no pull request production has not taken, unless a test says otherwise. */
  const tried = (labelEvents: readonly ReturnType<typeof aLabelAdded>[], staging: Partial<NonNullable<Facts["staging"]>> = {}): Facts => ({
    ...facts(),
    staging: { since: null, unpromoted: [], promoted: [], plain: [], mergedSince: 0, trials: { pullRequests: [{ pullRequest: 50, labelEvents, closes: [] }], problems: [] }, evidenceMarkers: [], shotsMarkers: [], ...staging },
  });
  const ACCEPTED = tried([added(TRIAL_ACCEPTED_LABEL, "2026-11-12T09:58:00Z")]);
  /** A later read: 50's newest deploy is of REDEPLOYED, where `e2e` is red. */
  const REDDER: StagingRead = {
    deployments: staged({ [merge("1")]: succeeded(merge("1"), "2026-11-12T09:36:00Z", REDEPLOYED, "2026-11-12T10:10:00Z") }),
    mainChecks: checked({ [REDEPLOYED]: [check("red", "2026-11-12T10:15:00Z")] }),
  };

  it("ask nothing of staging for a row with a result, which is settled, and still ask production's read of it", () => {
    const kept = rowsOf(ACCEPTED, null, null, null, KEPT_AT, EARLIER);

    expect(of(kept, 50)?.standing).toMatchObject({ place: "staging", name: "trial-accepted", move: "nobody", since: "2026-11-12T09:58:00Z" });
    expect(stagingMergesToRead(kept).map(({ mergeCommit }) => mergeCommit)).toEqual([merge("2"), merge("4")]);
    expect(commitsToCheck(kept, REDDER.deployments!)).toEqual([]);
    expect(commitsToCheck(rowsOf(facts(), null, null, null, KEPT_AT, EARLIER), REDDER.deployments!)).toEqual([{ commit: REDEPLOYED, checks: ["e2e"] }]);
    expect(mergesToRead(kept).map(({ mergeCommit }) => mergeCommit)).toContain(merge("1"));
  });

  it("leave a row with a result alone: a later deploy whose Main check is red never moves it, as the rule has it", () => {
    for (const label of [TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL]) {
      const settled = tried([added(label, "2026-11-12T09:58:00Z")]);
      const kept = rowsOf(settled, null, null, null, KEPT_AT, EARLIER);

      const joined = joinStaging(kept, REDDER, NOW);

      expect(of(joined, 50)).toBe(of(kept, 50));
      const known = { deployments: staged({ ...EARLIER.deployments!.merges, ...REDDER.deployments!.merges }), mainChecks: checked({ ...EARLIER.mainChecks!.commits, ...REDDER.mainChecks!.commits }) };
      expect(joined).toEqual(rowsOf(settled, null, null, null, NOW, known));
    }
    // Untried, the same read moves it back to deploy failed.
    expect(of(joinStaging(rowsOf(tried([]), null, null, null, KEPT_AT, EARLIER), REDDER, NOW), 50)?.standing).toMatchObject({ name: "deploy-failed" });
  });

  it("move a row with a result to Production once a production Deployment that contains it has started, and put it back with its result when that read holds none any more, as the rule does", () => {
    const started = aDeploymentsRead({ [merge("1")]: aDeployOf({ is: "running", deployment: 950, commit: merge("1"), at: "2026-11-12T10:15:00Z" }) }, NOW);
    const none = aDeploymentsRead({ [merge("1")]: aDeployOf() }, NOW);
    const kept = rowsOf(ACCEPTED, null, null, null, KEPT_AT, EARLIER);

    const promoted = joinDeployments(kept, started, NOW);
    const back = joinDeployments(promoted, none, NOW);

    expect(of(promoted, 50)?.standing).toMatchObject({ place: "production", name: "deploying", detail: { staging: { result: { is: "accepted", at: "2026-11-12T09:58:00Z" } } } });
    expect(promoted).toEqual(rowsOf(ACCEPTED, null, null, started, NOW, EARLIER));
    expect(of(back, 50)?.standing).toMatchObject({ place: "staging", name: "trial-accepted", since: "2026-11-12T09:58:00Z" });
    expect(of(back, 50)).toEqual(of(rowsOf(ACCEPTED, null, null, none, NOW, EARLIER), 50));
  });

  describe("and how long a row stands", () => {
    /** Agent pull request 44, merged a week before with merge commit 9, closing Ticket 3, carrying UI evidence, among those production has not taken. */
    const WAITING = {
      unpromoted: [aMergedLastDay("2026-11-05T09:30:00Z", { number: 44, ticket: 3, mergeCommit: merge("9"), title: "Show the cart total" })],
      evidenceMarkers: [{ pullRequest: 44, marker: { run: 4300, artifact: 800, failure: null, routes: ["/cart"] } }],
    };
    const WEEK_OLD: StagingRead = {
      deployments: staged({ ...EARLIER.deployments!.merges, [merge("9")]: aDeployOf({ is: "succeeded", deployment: 800, commit: merge("9"), at: "2026-11-05T09:36:00Z", newest: { deployment: 905, commit: DEPLOYED, at: "2026-11-12T10:00:00Z" } }) }, KEPT_AT),
      mainChecks: EARLIER.mainChecks,
    };

    it("keep an untried row that needs a trial a week after its merge, through both joins, as the rule does; and ask staging's and production's reads of it still", () => {
      const waiting = tried([], WAITING);
      const kept = rowsOf(waiting, null, null, null, KEPT_AT, WEEK_OLD);

      expect(of(kept, 44)).toMatchObject({ title: "Show the cart total", standing: { place: "staging", name: "on-staging", move: "operator", yours: true, since: "2026-11-05T09:36:00Z", detail: { staging: { standsUntil: null } } } });
      expect(stagingMergesToRead(kept)).toContainEqual({ mergeCommit: merge("9"), mergedAt: "2026-11-05T09:30:00Z" });
      expect(mergesToRead(kept)).toContainEqual({ mergeCommit: merge("9"), mergedAt: "2026-11-05T09:30:00Z" });
      for (const later of [NOW, "2026-11-20T10:00:00Z"]) {
        expect(of(joinStaging(kept, { deployments: staged({}, later), mainChecks: null }, later), 44)?.standing).toMatchObject({ name: "on-staging", move: "operator" });
        expect(of(joinDeployments(kept, aDeploymentsRead({}, later), later), 44)?.standing).toMatchObject({ name: "on-staging", move: "operator" });
      }
      expect(joinStaging(kept, WEEK_OLD, NOW)).toEqual(rowsOf(waiting, null, null, null, NOW, WEEK_OLD));
      expect(joinDeployments(kept, aDeploymentsRead({}, NOW), NOW)).toEqual(rowsOf(waiting, null, null, null, NOW, WEEK_OLD));
    });

    it("leave out a row 24 hours after the label event that gave its result, and not a minute sooner, as the rule does", () => {
      const settled = tried([], { ...WAITING, trials: { pullRequests: [{ pullRequest: 44, labelEvents: [added(TRIAL_ACCEPTED_LABEL, "2026-11-11T10:10:00Z")], closes: [] }], problems: [] } });
      const kept = rowsOf(settled, null, null, null, KEPT_AT, WEEK_OLD);

      expect(of(kept, 44)?.standing).toMatchObject({ name: "trial-accepted", detail: { staging: { standsUntil: "2026-11-12T10:10:00.000Z" } } });
      for (const [now, stands] of [["2026-11-12T10:10:00Z", true], ["2026-11-12T10:11:00Z", false]] as const) {
        expect(of(joinStaging(kept, WEEK_OLD, now), 44) !== undefined).toBe(stands);
        expect(of(joinDeployments(kept, aDeploymentsRead({}, now), now), 44) !== undefined).toBe(stands);
        expect(joinStaging(kept, WEEK_OLD, now)).toEqual(rowsOf(settled, null, null, null, now, WEEK_OLD));
        expect(joinDeployments(kept, aDeploymentsRead({}, now), now)).toEqual(rowsOf(settled, null, null, null, now, WEEK_OLD));
      }
    });

    it("keep a week-old row once a production Deployment that contains it has started, at Production, where it stands 24 hours from that Deployment and not from its merge, as the rule does (#857)", () => {
      const waiting = tried([], WAITING);
      const kept = rowsOf(waiting, null, null, null, KEPT_AT, WEEK_OLD);
      const started = aDeploymentsRead({ [merge("9")]: aDeployOf({ is: "running", deployment: 950, commit: DEPLOYED, at: "2026-11-12T10:15:00Z" }) }, NOW);

      const joined = joinDeployments(kept, started, NOW);

      expect(of(joined, 44)?.standing).toMatchObject({ place: "production", name: "deploying", move: "kit", since: "2026-11-12T10:15:00Z", detail: { mergedAt: "2026-11-05T09:30:00Z", deployment: 950 } });
      expect(joined).toEqual(rowsOf(waiting, null, null, started, NOW, WEEK_OLD));
      for (const [now, stands] of [["2026-11-13T10:15:00Z", true], ["2026-11-13T10:16:00Z", false]] as const) {
        expect(of(joinDeployments(kept, started, now), 44) !== undefined).toBe(stands);
        expect(of(joinDeployments(joined, aDeploymentsRead({}, now), now), 44) !== undefined).toBe(stands);
        expect(of(joinStaging(joined, WEEK_OLD, now), 44) !== undefined).toBe(stands);
        expect(of(rowsOf(waiting, null, null, started, now, WEEK_OLD), 44) !== undefined).toBe(stands);
      }
    });

    it("keep it Live for 24 hours from the production Deployment that took it, a week after its merge, through both joins, as the rule does; and never ask production's read of it again (#857)", () => {
      const waiting = tried([], WAITING);
      const kept = rowsOf(waiting, null, null, null, KEPT_AT, WEEK_OLD);
      const taken = aDeploymentsRead({ [merge("9")]: aDeployOf({ is: "succeeded", deployment: 950, commit: DEPLOYED, at: "2026-11-12T10:18:00Z" }) }, NOW);

      const joined = joinDeployments(kept, taken, NOW);

      expect(of(joined, 44)?.standing).toMatchObject({ place: "production", name: "live", move: "nobody", since: "2026-11-12T10:18:00Z", detail: { mergedAt: "2026-11-05T09:30:00Z", deployment: 950 } });
      expect(joined).toEqual(rowsOf(waiting, null, null, taken, NOW, WEEK_OLD));
      expect(mergesToRead(joined)).not.toContainEqual({ mergeCommit: merge("9"), mergedAt: "2026-11-05T09:30:00Z" });
      // An hour after the Deployment it is Live; 25 hours after, it has no row.
      for (const [now, stands] of [["2026-11-12T11:18:00Z", true], ["2026-11-13T10:18:00Z", true], ["2026-11-13T10:19:00Z", false], ["2026-11-13T11:18:00Z", false]] as const) {
        expect(of(joinDeployments(kept, taken, now), 44) !== undefined).toBe(stands);
        expect(of(joinDeployments(joined, aDeploymentsRead({}, now), now), 44) !== undefined).toBe(stands);
        expect(of(joinStaging(joined, WEEK_OLD, now), 44) !== undefined).toBe(stands);
        expect(of(rowsOf(waiting, null, null, taken, now, WEEK_OLD), 44) !== undefined).toBe(stands);
      }
    });
  });
});
