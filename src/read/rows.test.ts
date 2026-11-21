import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPTURE_FAILURES, captureFailureSentence, type EvidenceMarker } from "../evidence/uiEvidence.ts";
import { type ShotsMarker } from "../evidence/shotsEvidence.ts";
import type { RunInFlightFact } from "../github/snapshot.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { standingsOf } from "../kit/standing.ts";
import type { CommentFacts, RequiredChecksFact } from "../kit/weeklySummary.ts";
import { endedHeldLine } from "../loop/heldLine.ts";
import { designRoundMarker, handBackMarker, PROTOTYPE_FAILURE_ROUND_MARKER, PROTOTYPE_ROUND_MARKER } from "../loop/markers.ts";
import { roundLineOf } from "../loop/roundLine.ts";
import {
  aComment,
  aDeploymentsRead,
  aDeployOf,
  aLabelAdded,
  aMergedLastDay,
  anOpenIssue,
  anOpenPullRequest,
  aPlainPullRequest,
  aRunInFlight,
  aRunRead,
  aRunsRead,
  aVerdictComment,
  aWeeklyLimitIssue,
  factsOf,
  homeFactsOf,
  standingFactsOf,
} from "./builders.ts";
import type { Facts } from "./gather.ts";
import type { RequiredChecksRead } from "./requiredChecks.ts";
import { bareRowOf, type Row, rowsOf } from "./rows.ts";

const NOW = "2026-11-08T20:00:00Z";
const HEAD = "h".repeat(40);

/** The Standing rule's own answer for the same facts, runs and checks. */
function ruleOf(facts: Facts, runs: readonly RunInFlightFact[] | "unread", checks: Readonly<Record<string, RequiredChecksFact>>, now = NOW) {
  const { github, kit, operator, appLogin } = facts;
  return standingsOf(standingFactsOf({ github, kit: { ...kit, runsInFlight: runs, headChecks: checks }, operator, appLogin: appLogin ?? "fabrik-app[bot]" }), now);
}

/** A checks read of `owner/product`'s `main`, held for everyone to these Required checks, with these heads. */
function aChecksRead(heads: RequiredChecksRead["heads"], required: readonly string[] = ["test", "lint"]): RequiredChecksRead {
  return { repo: "owner/product", branch: "main", readAt: NOW, required, holdsAdmins: "yes", heads };
}

/** Ticket 7, `ready-for-agent`, given `agent:implement` an hour before now. */
const TICKET = anOpenIssue({ number: 7, title: "Build the thing", labels: ["ready-for-agent", "agent:implement"], labelEvents: [aLabelAdded("agent:implement", "2026-11-08T19:00:00Z")] });

/** A Kit-owned failure notice on Ticket 7: the Kit hands it back. */
const handedBack = (at: string, overrides: Parameters<typeof aComment>[2] = {}) =>
  aComment(["<!-- fabrik:implement-run-failed -->", "@operator The Implement run on #7 failed: it crashed.", handBackMarker({ kind: "infrastructure-failure", role: "implement", failure: "crash" })].join("\n"), at, overrides);

describe("a Product repo's rows", () => {
  it("are the Standing rule's own Standings for the same facts, one row for each, in its order", () => {
    const facts = homeFactsOf({
      github: factsOf({
        openIssues: [
          TICKET,
          anOpenIssue({ number: 8, title: "Fix the cart", labels: ["ready-for-agent"] }),
          anOpenIssue({ number: 9, title: "Tidy the footer", labels: ["needs-triage"], labelEvents: [aLabelAdded("needs-triage", "2026-11-07T09:00:00Z")] }),
          anOpenIssue({ number: 20, title: "Weekly limit reached", labels: ["fabrik:weekly-limit"], author: "fabrik-app[bot]" }),
        ],
        openPullRequests: [anOpenPullRequest({ number: 50, ticket: 8, draft: false, comments: [aVerdictComment("pass", HEAD, "2026-11-07T20:00:00Z")] })],
        plainPullRequests: [aPlainPullRequest({ number: 70 }), aPlainPullRequest({ number: 71, headSha: "q".repeat(40), draft: true })],
        kitIssues: [aWeeklyLimitIssue("2026-11-10T00:00:00Z")],
      }),
    });
    const runs = aRunsRead([aRunRead({ issue: 7 })]);
    const checks = aChecksRead({ ["p".repeat(40)]: [{ name: "test", is: "passed", url: "https://github.com/owner/product/runs/1", at: "2026-11-08T19:30:00Z" }] });

    const rows = rowsOf(facts, runs, checks, null, NOW);

    expect(rows.map(({ standing }) => standing)).toEqual(ruleOf(facts, [aRunInFlight({ issue: 7 })], { ["p".repeat(40)]: [{ name: "test", is: "passed", at: "2026-11-08T19:30:00Z" }] }));
    expect(rows.length).toBeGreaterThan(4);
  });

  it("take a runs read, the rule reading it as its runs-in-flight fact, and carry the Actions run on a running Standing (#621)", () => {
    const facts = homeFactsOf({ github: factsOf({ openIssues: [anOpenIssue({ number: 12, title: "Add the cart", labels: ["ready-for-agent", "agent:implement"] })] }) });
    const runs = aRunsRead([aRunRead({ issue: 12, exact: true, kind: "first", run: 4410, createdAt: "2026-11-08T19:20:00Z", startedAt: "2026-11-08T19:25:00Z" })]);

    const rows = rowsOf(facts, runs, null, null, NOW);

    expect(rows.map(({ standing }) => ({ name: standing.name, since: standing.since, detail: standing.detail }))).toEqual([
      { name: "running", since: "2026-11-08T19:25:00Z", detail: { run: "implement", retry: null, actionsRun: 4410 } },
    ]);
    expect(rowsOf(facts, aRunsRead("unread"), null, null, NOW)).toEqual(rowsOf(facts, null, null, null, NOW));
  });

  it("take a Plain pull request's name from the checks read, since the report that decided it", () => {
    const facts = homeFactsOf({ github: factsOf({ plainPullRequests: [aPlainPullRequest({ number: 70 })] }) });
    const checks = aChecksRead({
      ["p".repeat(40)]: [
        { name: "test", is: "passed", url: "https://github.com/owner/product/runs/1", at: "2026-11-08T19:00:00Z" },
        { name: "lint", is: "failing", url: "https://github.com/owner/product/runs/2", at: "2026-11-08T19:10:00Z" },
      ],
    });

    expect(rowsOf(facts, null, checks, null, NOW).map(({ standing }) => standing)).toMatchObject([
      { pullRequest: 70, name: "check-failing", since: "2026-11-08T19:10:00Z", detail: { plain: "kit-bump", check: "lint", checkIs: "failing" } },
    ]);
  });

  it("take every Plain pull request as passed on a branch requiring nothing, and as waiting on checks it could not read with no checks read", () => {
    const facts = homeFactsOf({ github: factsOf({ plainPullRequests: [aPlainPullRequest({ number: 70 })] }) });

    expect(rowsOf(facts, null, aChecksRead({ ["p".repeat(40)]: [] }, []), null, NOW).map(({ standing }) => standing.name)).toEqual(["yours-to-merge"]);
    expect(rowsOf(facts, null, null, null, NOW).map(({ standing }) => standing.detail)).toEqual([{ plain: "kit-bump", check: null, checksUnread: true, head: "p".repeat(40) }]);
  });

  it("are the rule's Standings with the runs and the checks unread", () => {
    const facts = homeFactsOf({ github: factsOf({ openIssues: [TICKET], plainPullRequests: [aPlainPullRequest()] }) });

    expect(rowsOf(facts, null, null, null, NOW).map(({ standing }) => standing)).toEqual(ruleOf(facts, "unread", {}));
  });

  it("give each Standing its title, the issue's, or the pull request's for a Plain one with no issue, and nothing related yet", () => {
    const facts = homeFactsOf({
      github: factsOf({
        openIssues: [TICKET],
        openPullRequests: [anOpenPullRequest({ number: 51, ticket: null, title: "Speed up the build", draft: false, comments: [aVerdictComment("pass", HEAD, "2026-11-07T20:00:00Z")] })],
        plainPullRequests: [aPlainPullRequest({ number: 70, title: "fabrik: bump the fabrik group" })],
      }),
    });

    const rows = rowsOf(facts, null, null, null, NOW);

    expect(rows.map(({ standing, title, related, mentions, relatedTo, followUps }) => ({ issue: standing.issue, pullRequest: standing.pullRequest, title, related, mentions, relatedTo, followUps }))).toEqual(
      expect.arrayContaining([
        { issue: 7, pullRequest: null, title: "Build the thing", related: [], mentions: [], relatedTo: null, followUps: [] },
        { issue: null, pullRequest: 51, title: "Speed up the build", related: [], mentions: [], relatedTo: null, followUps: [] },
        { issue: null, pullRequest: 70, title: "fabrik: bump the fabrik group", related: [], mentions: [], relatedTo: null, followUps: [] },
      ]),
    );
    expect(rows).toHaveLength(3);
  });

  describe("a merged agent pull request at Production (#634)", () => {
    const MERGE = "m".repeat(40);
    const production = homeFactsOf().kit;
    const tracked = { ...production, config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, production: { url: "https://shop.example", environment: "production" } } } } as const;

    it("take the Deployments read, giving the merged pull request a row with the rule's Standing for it, titled with its own title when its Ticket is closed", () => {
      const facts = homeFactsOf({ kit: tracked, mergedLastDay: [aMergedLastDay("2026-11-08T19:30:00Z", { title: "Build the thing, merged" })] });
      const read = aDeploymentsRead({ [MERGE]: aDeployOf({ is: "succeeded", deployment: 900, commit: MERGE, at: "2026-11-08T19:40:00Z" }) });

      const rows = rowsOf(facts, null, null, read, NOW);

      expect(rows.map(({ standing }) => standing)).toEqual(
        standingsOf(standingFactsOf({ github: facts.github, kit: { ...tracked, runsInFlight: "unread", headChecks: {} }, mergedLastDay: facts.mergedLastDay, deployments: read }), NOW),
      );
      expect(rows).toEqual([
        {
          ...bareRowOf(rows[0]!.standing, "Build the thing, merged", null),
          related: [],
          mentions: [],
          followUps: [],
          relatedTo: null,
          ticketClosed: null,
          plainPullRequest: null,
          evidence: null,
          production: { site: "https://shop.example", tracked: true, pages: [] },
        },
      ]);
      expect(rows[0]!.standing).toMatchObject({ issue: 7, pullRequest: 50, name: "live" });
      expect(rowsOf(facts, null, null, null, NOW).map(({ standing }) => standing)).toMatchObject([{ name: "merged", detail: { deploysUnread: true } }]);
    });

    it("title the row with its Ticket's title where the facts hold the Ticket", () => {
      const facts = homeFactsOf({ kit: tracked, github: factsOf({ openIssues: [TICKET] }), mergedLastDay: [aMergedLastDay("2026-11-08T19:30:00Z", { title: "Merged as" })] });

      expect(rowsOf(facts, null, null, null, NOW).filter(({ standing }) => standing.pullRequest === 50).map(({ title }) => title)).toEqual(["Build the thing"]);
    });

    describe("its links to production (#639)", () => {
      const UI_MARKER = { run: 4400, artifact: 900, failure: null, routes: ["/book", "/cart?step=2"], preview: { is: "linked", url: "https://fabrik-ticket-7.shop.example.dev/" } } as const;
      const productionOf = (facts: Facts, read = aDeploymentsRead({})) => rowsOf(facts, null, null, read, NOW).map(({ standing, production }) => ({ name: standing.name, production }));

      it("give the site, that it is tracked, and the live page of each captured route, whatever the row's name", () => {
        const merged = homeFactsOf({ kit: tracked, mergedLastDay: [aMergedLastDay("2026-11-08T19:30:00Z")], evidenceMarkers: [{ pullRequest: 50, marker: UI_MARKER }] });
        const production = {
          site: "https://shop.example",
          tracked: true,
          pages: [
            { route: "/book", url: "https://shop.example/book" },
            { route: "/cart?step=2", url: "https://shop.example/cart?step=2" },
          ],
        };

        expect(productionOf(merged)).toEqual([{ name: "merged", production }]);
        expect(productionOf(merged, aDeploymentsRead({ [MERGE]: aDeployOf({ is: "succeeded", deployment: 900, commit: MERGE, at: "2026-11-08T19:40:00Z" }) }))).toEqual([{ name: "live", production }]);
        expect(productionOf(merged, aDeploymentsRead({ [MERGE]: aDeployOf({ is: "running", deployment: 900, commit: MERGE, at: "2026-11-08T19:40:00Z" }) }))).toEqual([{ name: "deploying", production }]);
      });

      it("say a site whose Kit config names no environment is not tracked, with its pages built on its own path", () => {
        const untracked = { ...production, config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, production: { url: "https://example.dev/shop/", environment: null } } } } as const;
        const facts = homeFactsOf({ kit: untracked, mergedLastDay: [aMergedLastDay("2026-11-08T19:30:00Z")], evidenceMarkers: [{ pullRequest: 50, marker: UI_MARKER }] });

        expect(productionOf(facts, aDeploymentsRead({}))).toEqual([
          {
            name: "merged",
            production: {
              site: "https://example.dev/shop/",
              tracked: false,
              pages: [
                { route: "/book", url: "https://example.dev/shop/book" },
                { route: "/cart?step=2", url: "https://example.dev/shop/cart?step=2" },
              ],
            },
          },
        ]);
      });

      it.each([
        ["that is not UI", []],
        ["whose marker an earlier release wrote, naming no routes", [{ pullRequest: 50, marker: { run: 4400, artifact: 900 } }]],
        ["whose capture named no routes", [{ pullRequest: 50, marker: { ...UI_MARKER, routes: [] } }]],
      ] as const)("give a merged pull request %s no pages, so a reader links the site alone", (_what, evidenceMarkers) => {
        const facts = homeFactsOf({ kit: tracked, mergedLastDay: [aMergedLastDay("2026-11-08T19:30:00Z")], evidenceMarkers });

        expect(productionOf(facts).map(({ production }) => production)).toEqual([{ site: "https://shop.example", tracked: true, pages: [] }]);
      });

      it("are null on a row that is not a merged pull request's, an open UI pull request's among them", () => {
        const facts = homeFactsOf({ kit: tracked, github: factsOf({ openIssues: [TICKET], openPullRequests: [anOpenPullRequest({ number: 51, ticket: 8 })] }), evidenceMarkers: [{ pullRequest: 51, marker: UI_MARKER }] });

        expect(rowsOf(facts, null, null, null, NOW).map(({ production }) => production)).toEqual([null, null]);
      });
    });
  });

  describe("a merged agent pull request at Staging (#855)", () => {
    const MERGE = "m".repeat(40);
    const DEPLOYED = "d".repeat(40);
    const declaring = (overrides: Partial<typeof DEFAULT_KIT_CONFIG> = {}) =>
      ({
        ...homeFactsOf().kit,
        config: {
          ok: true,
          config: { ...DEFAULT_KIT_CONFIG, production: { url: "https://shop.example", environment: "production" }, staging: { url: "https://staging.example.dev/shop/", environment: "staging" }, ...overrides },
        },
      }) as const;
    const STAGED = declaring();
    /** Agent pull request 50, merged half an hour ago in a repo that declares staging, with these facts beside. */
    const merged = (overrides: Partial<Omit<Facts, "kind">> = {}) => homeFactsOf({ kit: STAGED, mergedLastDay: [aMergedLastDay("2026-11-08T19:30:00Z")], ...overrides });
    /** A staging Deployments read: the merge's first deploy succeeded at 19:40, and the newest that contains it is of DEPLOYED. */
    const ON_STAGING = {
      ...aDeploymentsRead({ [MERGE]: aDeployOf({ is: "succeeded", deployment: 900, commit: MERGE, at: "2026-11-08T19:40:00Z", newest: { deployment: 905, commit: DEPLOYED, at: "2026-11-08T19:50:00Z" } }) }),
      environment: "staging",
    };
    const UI_MARKER = { run: 4400, artifact: 900, failure: null, routes: ["/book", "/patients/[patientId]/notes", "/cart?step=2"], preview: { is: "linked", url: "https://fabrik-ticket-7.shop.example.dev/" } } as const;
    const SHOTS_MARKER: ShotsMarker = {
      source: "shots",
      head: "c".repeat(40),
      run: 9300,
      artifact: 9301,
      failure: null,
      routes: [],
      named: [{ name: "composer: draft ready", journey: "write-a-clinical-note", path: "/patients/6f1b2c3d/notes/new?tab=draft" }, { name: "inbox: empty" }],
      missed: [{ name: "inbox: empty", why: "not-produced" }],
    };

    it("take the staging reads after the time, giving the merged pull request a row with the rule's Standing for them; with none given its staging deploys are unread", () => {
      const facts = merged();

      const rows = rowsOf(facts, null, null, null, NOW, { deployments: ON_STAGING, mainChecks: null });

      expect(rows.map(({ standing }) => standing)).toEqual(
        standingsOf(standingFactsOf({ github: facts.github, kit: { ...STAGED, runsInFlight: "unread", headChecks: {} }, mergedLastDay: facts.mergedLastDay, stagingDeployments: ON_STAGING }), NOW),
      );
      expect(rows.map(({ standing }) => standing)).toMatchObject([{ issue: 7, pullRequest: 50, place: "staging", name: "on-staging", move: "nobody" }]);
      for (const none of [rowsOf(facts, null, null, null, NOW), rowsOf(facts, null, null, null, NOW, null), rowsOf(facts, null, null, null, NOW, { deployments: null, mainChecks: null })]) {
        expect(none.map(({ standing }) => standing)).toMatchObject([{ place: "staging", name: "merged", detail: { deploysUnread: true } }]);
      }
    });

    it("take the Main checks read with them, and production's Deployments read where it always was", () => {
      const facts = merged({ kit: declaring({ monitor: { ...DEFAULT_KIT_CONFIG.monitor, mainChecks: ["e2e"] } }) });
      const red = { name: "e2e", is: "red", url: "https://github.com/owner/product/actions/runs/7/job/903", at: "2026-11-08T19:58:00Z" } as const;
      const checks = (check: typeof red | { readonly name: string; readonly is: "green"; readonly url: null; readonly at: null }) => ({ repo: "owner/product", readAt: NOW, commits: { [DEPLOYED]: [check] } });
      const promoted = aDeploymentsRead({ [MERGE]: aDeployOf({ is: "running", deployment: 950, commit: MERGE, at: "2026-11-08T19:59:00Z" }) });

      expect(rowsOf(facts, null, null, null, NOW, { deployments: ON_STAGING, mainChecks: checks(red) }).map(({ standing }) => standing)).toMatchObject([
        { place: "staging", name: "deploy-failed", since: "2026-11-08T19:58:00Z", detail: { log: red.url, staging: { check: "e2e" } } },
      ]);
      expect(rowsOf(facts, null, null, null, NOW, { deployments: ON_STAGING, mainChecks: checks({ name: "e2e", is: "green", url: null, at: null }) }).map(({ standing }) => standing)).toMatchObject([{ place: "staging", name: "on-staging" }]);
      expect(rowsOf(facts, null, null, null, NOW, { deployments: ON_STAGING, mainChecks: null }).map(({ standing }) => standing)).toMatchObject([{ place: "staging", name: "deploying", detail: { staging: { checksUnread: true } } }]);
      expect(rowsOf(facts, null, null, promoted, NOW, { deployments: ON_STAGING, mainChecks: checks(red) }).map(({ standing }) => standing)).toMatchObject([{ place: "production", name: "deploying", move: "kit" }]);
    });

    describe("which need a Staging trial", () => {
      const onStaging = (overrides: Partial<Omit<Facts, "kind">>) => rowsOf(merged(overrides), null, null, null, NOW, { deployments: ON_STAGING, mainChecks: null }).map(({ standing }) => standing);

      it.each([
        ["an evidence marker", { evidenceMarkers: [{ pullRequest: 50, marker: UI_MARKER }] }],
        ["an evidence marker whose capture failed", { evidenceMarkers: [{ pullRequest: 50, marker: { run: 4400, artifact: null, failure: "server-did-not-start", routes: ["/book"] } }] }],
        ["an evidence marker an earlier release wrote, naming no routes", { evidenceMarkers: [{ pullRequest: 50, marker: { run: 4400, artifact: 900 } }] }],
        ["a shots marker", { shotsMarkers: [{ pullRequest: 50, marker: SHOTS_MARKER }] }],
        ["a shots marker nothing of whose check could be read", { shotsMarkers: [{ pullRequest: 50, marker: { ...SHOTS_MARKER, artifact: null, failure: "no-artifact" } }] }],
        ["a shots marker with an Evidence miss", { shotsMarkers: [{ pullRequest: 50, marker: { ...SHOTS_MARKER, named: [], missed: [], miss: "nothing-named" } }] }],
      ] as const)("is the Operator's on staging, yours and not stopping work, with %s", (_what, markers) => {
        expect(onStaging(markers)).toMatchObject([{ name: "on-staging", move: "operator", yours: true, stopsWork: false, detail: { staging: { trial: { needed: true, why: "ui-evidence" } } } }]);
      });

      it.each([
        ["whose Implementer said nothing visible changes", { shotsMarkers: [{ pullRequest: 50, marker: { ...SHOTS_MARKER, named: [], missed: [], nothingVisible: "Only the API's error codes changed." } }] }],
        ["with neither marker", {}],
        ["when only another pull request carries one", { evidenceMarkers: [{ pullRequest: 51, marker: UI_MARKER }], shotsMarkers: [{ pullRequest: 52, marker: SHOTS_MARKER }] }],
      ] as const)("is nobody's on staging, changing no screen, for one %s", (_what, markers) => {
        expect(onStaging(markers)).toMatchObject([{ name: "on-staging", move: "nobody", yours: false, stopsWork: false, detail: { staging: { trial: { needed: false, why: "no-screen" } } } }]);
      });

      it("reads facts cached by an earlier release, which hold no shots markers, as carrying none", () => {
        const { shotsMarkers: _, ...cached } = merged({ evidenceMarkers: [{ pullRequest: 50, marker: UI_MARKER }] });

        expect(rowsOf(JSON.parse(JSON.stringify(cached)) as Facts, null, null, null, NOW, { deployments: ON_STAGING, mainChecks: null }).map(({ standing }) => standing)).toMatchObject([{ name: "on-staging", move: "operator" }]);
      });
    });

    describe("its staging pages and what to try", () => {
      const stagingOf = (facts: Facts, production: Parameters<typeof rowsOf>[3] = null) =>
        rowsOf(facts, null, null, production, NOW, { deployments: ON_STAGING, mainChecks: null }).map(({ standing, staging }) => ({ place: standing.place, staging }));

      it("give a captured route with no dynamic segment its page on the staging site, built as a production page is, one with a dynamic segment the site itself, and the route patterns to try", () => {
        expect(stagingOf(merged({ evidenceMarkers: [{ pullRequest: 50, marker: UI_MARKER }] }))).toEqual([
          {
            place: "staging",
            staging: {
              site: "https://staging.example.dev/shop/",
              pages: [
                { route: "/book", url: "https://staging.example.dev/shop/book" },
                { route: "/patients/[patientId]/notes", url: "https://staging.example.dev/shop/" },
                { route: "/cart?step=2", url: "https://staging.example.dev/shop/cart?step=2" },
              ],
              shots: [],
              toTry: ["/book", "/patients/[patientId]/notes", "/cart?step=2"],
            },
          },
        ]);
      });

      it("give every Evidence shot the site itself, whatever path its Journey visited, and the shot names to try", () => {
        expect(stagingOf(merged({ shotsMarkers: [{ pullRequest: 50, marker: SHOTS_MARKER }] }))).toEqual([
          {
            place: "staging",
            staging: {
              site: "https://staging.example.dev/shop/",
              pages: [],
              shots: [
                { name: "composer: draft ready", url: "https://staging.example.dev/shop/" },
                { name: "inbox: empty", url: "https://staging.example.dev/shop/" },
              ],
              toTry: ["composer: draft ready", "inbox: empty"],
            },
          },
        ]);
      });

      it("give the site alone, and nothing to try, for a pull request that is not UI, and for one whose marker names no routes", () => {
        const bare = { site: "https://staging.example.dev/shop/", pages: [], shots: [], toTry: [] };

        expect(stagingOf(merged())).toEqual([{ place: "staging", staging: bare }]);
        expect(stagingOf(merged({ evidenceMarkers: [{ pullRequest: 50, marker: { run: 4400, artifact: 900 } }] }))).toEqual([{ place: "staging", staging: bare }]);
      });

      it("stay on its row once it is at Production, beside production's pages and shot links, which are what they were", () => {
        const promoted = aDeploymentsRead({ [MERGE]: aDeployOf({ is: "succeeded", deployment: 950, commit: MERGE, at: "2026-11-08T19:58:00Z" }) });
        const facts = merged({ evidenceMarkers: [{ pullRequest: 50, marker: UI_MARKER }] });
        const [atStaging] = rowsOf(facts, null, null, null, NOW, { deployments: ON_STAGING, mainChecks: null });
        const [atProduction] = rowsOf(facts, null, null, promoted, NOW, { deployments: ON_STAGING, mainChecks: null });
        const [undeclared] = rowsOf({ ...facts, kit: { ...STAGED, config: { ok: true, config: { ...STAGED.config.config, staging: null } } } }, null, null, promoted, NOW);

        expect(atProduction?.standing).toMatchObject({ place: "production", name: "live" });
        expect(atProduction?.staging).toEqual(atStaging?.staging);
        expect(atStaging?.production).toEqual(undeclared?.production);
        expect(atProduction?.production).toEqual({
          site: "https://shop.example",
          tracked: true,
          pages: [
            { route: "/book", url: "https://shop.example/book" },
            { route: "/patients/[patientId]/notes", url: "https://shop.example/patients/[patientId]/notes" },
            { route: "/cart?step=2", url: "https://shop.example/cart?step=2" },
          ],
        });
        const shots = rowsOf(merged({ shotsMarkers: [{ pullRequest: 50, marker: SHOTS_MARKER }] }), null, null, null, NOW, { deployments: ON_STAGING, mainChecks: null })[0]?.shots;
        expect(shots?.named.map(({ production }) => production)).toEqual(["https://shop.example/patients/6f1b2c3d/notes/new?tab=draft", null]);
      });

      it("are no key at all on a row that is not a merged pull request's, and on every row of a repo that declares no staging", () => {
        const open = homeFactsOf({ kit: STAGED, github: factsOf({ openIssues: [TICKET], openPullRequests: [anOpenPullRequest({ number: 51, ticket: 8 })] }), evidenceMarkers: [{ pullRequest: 51, marker: UI_MARKER }] });
        const undeclared = homeFactsOf({
          kit: { ...STAGED, config: { ok: true, config: { ...STAGED.config.config, staging: null } } },
          github: factsOf({ openIssues: [TICKET] }),
          mergedLastDay: [aMergedLastDay("2026-11-08T19:30:00Z")],
          evidenceMarkers: [{ pullRequest: 50, marker: UI_MARKER }],
        });

        for (const rows of [rowsOf(open, null, null, null, NOW, { deployments: ON_STAGING, mainChecks: null }), rowsOf(undeclared, null, null, null, NOW, { deployments: ON_STAGING, mainChecks: null })]) {
          expect(rows.length).toBe(2);
          for (const row of rows) expect(row).not.toHaveProperty("staging");
        }
      });
    });

    describe("that production has not taken, as a gather keeps it past the last day (#856)", () => {
      const WEEK_OLD = "2026-11-01T19:30:00Z";
      /** What a gather reads past the last day: agent pull request 50, merged a week ago, with these facts beside. */
      const waiting = (staging: Partial<NonNullable<Facts["staging"]>> = {}) =>
        homeFactsOf({
          kit: STAGED,
          staging: { since: null, unpromoted: [aMergedLastDay(WEEK_OLD, { title: "Show the cart total" })], trials: { pullRequests: [], problems: [] }, evidenceMarkers: [], shotsMarkers: [], ...staging },
        });
      const read = { deployments: ON_STAGING, mainChecks: null };

      it("has a row a week after its merge while it needs a Staging trial, the Operator's, with its title, its evidence, its staging pages and production's as a newly merged one has them", () => {
        const [row, ...rest] = rowsOf(waiting({ evidenceMarkers: [{ pullRequest: 50, marker: UI_MARKER }] }), null, null, null, NOW, read);
        const [lastDay] = rowsOf(merged({ evidenceMarkers: [{ pullRequest: 50, marker: UI_MARKER }] }), null, null, null, NOW, read);

        expect(rest).toEqual([]);
        expect(row).toMatchObject({ title: "Show the cart total", standing: { issue: 7, pullRequest: 50, place: "staging", name: "on-staging", move: "operator", yours: true, stopsWork: false, detail: { mergedAt: WEEK_OLD, staging: { trial: { needed: true, why: "ui-evidence" }, standsUntil: null } } } });
        expect(row?.evidence).toEqual(lastDay?.evidence);
        expect(row?.staging).toEqual(lastDay?.staging);
        expect(row?.production).toEqual(lastDay?.production);
        expect(row?.evidence?.pages?.map(({ route }) => route)).toEqual(["/book", "/patients/[patientId]/notes", "/cart?step=2"]);
      });

      it("reads its shots marker the same way, and has no row once its 24 hours have passed when it changes no screen", () => {
        const [row] = rowsOf(waiting({ shotsMarkers: [{ pullRequest: 50, marker: SHOTS_MARKER }] }), null, null, null, NOW, read);

        expect(row).toMatchObject({ standing: { name: "on-staging", move: "operator" }, shots: { run: 9300 }, staging: { toTry: ["composer: draft ready", "inbox: empty"] } });
        expect(rowsOf(waiting({ shotsMarkers: [{ pullRequest: 50, marker: { ...SHOTS_MARKER, named: [], missed: [], nothingVisible: "Only the copy of an email changed." } }] }), null, null, null, NOW, read)).toEqual([]);
        expect(rowsOf(waiting(), null, null, null, NOW, read)).toEqual([]);
      });

      it("takes its Staging trial's result from the label events the gather read, by the Operator the facts name, and needs a trial when it closes a Trial problem", () => {
        const accepted = (actor: string) => ({ pullRequests: [{ pullRequest: 50, labelEvents: [aLabelAdded("fabrik:trial-accepted", "2026-11-08T19:50:00Z", { actor })], closes: [] }], problems: [] });
        const closing = { pullRequests: [{ pullRequest: 50, labelEvents: [], closes: [70] }], problems: [{ issue: 70, pullRequest: 12, title: "The cart total reads 0", open: false, closedAs: "completed" }] } as const;

        expect(rowsOf(waiting({ trials: accepted("operator") }), null, null, null, NOW, read).map(({ standing }) => standing)).toMatchObject([{ name: "trial-accepted", move: "nobody", since: "2026-11-08T19:50:00Z" }]);
        expect(rowsOf(waiting({ trials: accepted("fabrik-app[bot]") }), null, null, null, NOW, read)).toEqual([]);
        expect(rowsOf({ ...waiting({ trials: accepted("kate") }), operator: "kate" }, null, null, null, NOW, read).map(({ standing }) => standing)).toMatchObject([{ name: "trial-accepted" }]);
        expect(rowsOf(waiting({ trials: closing }), null, null, null, NOW, read).map(({ standing }) => standing)).toMatchObject([
          { name: "on-staging", move: "operator", yours: true, detail: { staging: { trial: { needed: true, why: "closes-trial-problem" }, standsUntil: null } } },
        ]);
        // Even one whose Implementer said nothing visible changes: a fix is never accepted with nobody looking.
        const nothingVisible = [{ pullRequest: 50, marker: { ...SHOTS_MARKER, named: [], missed: [], nothingVisible: "Only the copy of an email changed." } }];
        expect(rowsOf(waiting({ trials: closing, shotsMarkers: nothingVisible }), null, null, null, NOW, read).map(({ standing }) => standing)).toMatchObject([
          { name: "on-staging", move: "operator", detail: { staging: { trial: { needed: true, why: "closes-trial-problem" } } } },
        ]);
      });

      it("gives one row to a pull request the gather kept both ways, and survives a JSON round trip", () => {
        const both = { ...waiting({ unpromoted: [aMergedLastDay("2026-11-08T19:30:00Z")], evidenceMarkers: [{ pullRequest: 50, marker: UI_MARKER }] }), mergedLastDay: [aMergedLastDay("2026-11-08T19:30:00Z")], evidenceMarkers: [{ pullRequest: 50, marker: UI_MARKER }] };
        const rows = rowsOf(both, null, null, null, NOW, read);

        expect(rows.map(({ standing }) => standing)).toMatchObject([{ pullRequest: 50, name: "on-staging", detail: { staging: { standsUntil: null } } }]);
        expect(rowsOf(JSON.parse(JSON.stringify(both)) as Facts, null, null, null, NOW, read)).toStrictEqual(rows);
        expect(JSON.parse(JSON.stringify(rows))).toStrictEqual(rows);
      });
    });

    it("gives a repo that declares no staging the rows it gave before, whatever staging reads it is handed", () => {
      const undeclared = homeFactsOf({
        kit: { ...STAGED, config: { ok: true, config: { ...STAGED.config.config, staging: null } } },
        github: factsOf({ openIssues: [TICKET] }),
        mergedLastDay: [aMergedLastDay("2026-11-08T19:30:00Z")],
        evidenceMarkers: [{ pullRequest: 50, marker: UI_MARKER }],
      });
      const live = aDeploymentsRead({ [MERGE]: aDeployOf({ is: "succeeded", deployment: 900, commit: MERGE, at: "2026-11-08T19:40:00Z" }) });

      const before = rowsOf(undeclared, null, null, live, NOW);

      expect(JSON.stringify(rowsOf(undeclared, null, null, live, NOW, { deployments: ON_STAGING, mainChecks: { repo: "owner/product", readAt: NOW, commits: {} } }))).toBe(JSON.stringify(before));
      expect(before.map(({ standing }) => standing)).toMatchObject([{ issue: 7, name: "not-started" }, { pullRequest: 50, place: "production", name: "live", detail: { mergeCommit: MERGE, mergedAt: "2026-11-08T19:30:00Z", environment: "production", noDeployAt: null, deployment: 900, log: null, deploysUnread: false } }]);
      expect(Object.keys(before[1]!.standing.detail).toSorted()).toEqual(["deployment", "deploysUnread", "environment", "log", "mergeCommit", "mergedAt", "noDeployAt"]);
    });
  });

  describe("an agent pull request's UI evidence (#639)", () => {
    const PREVIEW = "https://fabrik-ticket-7.shop.example.dev/";
    const evidenceOf = (marker: EvidenceMarker | null, pullRequest = anOpenPullRequest({ number: 50, ticket: 7 })) => {
      const facts = homeFactsOf({ github: factsOf({ openPullRequests: [pullRequest] }), evidenceMarkers: marker === null ? [] : [{ pullRequest: 50, marker }] });
      return rowsOf(facts, null, null, null, NOW)
        .filter(({ standing }) => standing.pullRequest === 50)
        .map(({ evidence }) => evidence);
    };

    it("is on an open UI pull request's row: its run, artifact and failure, what came of the preview, and a page for each captured route, in the marker's order", () => {
      const marker = { run: 4410, artifact: 901, failure: null, routes: ["/cart?step=2", "/book"], preview: { is: "linked", url: PREVIEW }, missed: [] } as const;

      expect(evidenceOf(marker)).toEqual([
        {
          run: 4410,
          artifact: 901,
          failure: null,
          preview: "linked",
          pages: [
            { route: "/cart?step=2", preview: "https://fabrik-ticket-7.shop.example.dev/cart?step=2" },
            { route: "/book", preview: "https://fabrik-ticket-7.shop.example.dev/book" },
          ],
          failureSentence: null,
          missed: [],
        },
      ]);
    });

    it.each([
      ["pending", { is: "pending" }],
      ["never-answered", { is: "never-answered", url: PREVIEW }],
      ["none", { is: "none" }],
    ] as const)("gives no page a preview address when the preview is %s", (is, preview) => {
      const marker = { run: 4410, artifact: 901, failure: null, routes: ["/book"], preview };

      expect(evidenceOf(marker)).toEqual([{ run: 4410, artifact: 901, failure: null, preview: is, pages: [{ route: "/book", preview: null }], failureSentence: null, missed: null }]);
    });

    it("gives a failed capture's reason in the Kit's own sentence for it, and no pages when it captured no route", () => {
      const marker = { run: 4410, artifact: null, failure: "server-did-not-start", routes: [], preview: { is: "pending" } } as const;

      expect(evidenceOf(marker)).toEqual([
        {
          run: 4410,
          artifact: null,
          failure: "server-did-not-start",
          preview: "pending",
          pages: [],
          failureSentence: "Capture failed: the server wouldn't start: nothing answered at `ui.url` once `ui.serve` ran.",
          missed: null,
        },
      ]);
    });

    // The sentence is the Kit's, from the reason alone (#667): no route, which may be agent text, reaches it.
    it.each(CAPTURE_FAILURES)("words a capture that failed for %s in the evidence section's sentence for it", (failure) => {
      const [evidence] = evidenceOf({ run: 4410, artifact: 901, failure, routes: ["/book @octocat -->"], preview: { is: "none" } });

      expect(evidence?.failureSentence).toBe(captureFailureSentence(failure));
    });

    it("names exactly the one shot a capture missed, by route, size and side, and leaves its pages and the other pull request's evidence as they were", () => {
      const missedOne = { run: 4410, artifact: 901, failure: null, routes: ["/book", "/"], preview: { is: "linked", url: PREVIEW }, missed: [{ route: "/book", viewport: "mobile", side: "before" }] } as const;
      const missedNone = { run: 4420, artifact: 902, failure: null, routes: ["/cart"], preview: { is: "none" }, missed: [] } as const;
      const facts = homeFactsOf({
        github: factsOf({ openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 }), anOpenPullRequest({ number: 51, ticket: 8 })] }),
        evidenceMarkers: [
          { pullRequest: 50, marker: missedOne },
          { pullRequest: 51, marker: missedNone },
        ],
      });

      const evidence = Object.fromEntries(rowsOf(facts, null, null, null, NOW).flatMap(({ standing, evidence }) => (standing.pullRequest === null ? [] : [[standing.pullRequest, evidence]])));

      expect(evidence[50]).toEqual({
        run: 4410,
        artifact: 901,
        failure: null,
        preview: "linked",
        pages: [
          { route: "/book", preview: "https://fabrik-ticket-7.shop.example.dev/book" },
          { route: "/", preview: "https://fabrik-ticket-7.shop.example.dev/" },
        ],
        failureSentence: null,
        missed: [{ route: "/book", viewport: "mobile", side: "before" }],
      });
      expect(evidence[51]).toEqual({ run: 4420, artifact: 902, failure: null, preview: "none", pages: [{ route: "/cart", preview: null }], failureSentence: null, missed: [] });
    });

    it("gives a capture that failed outright after taking some pictures its sentence, and still lists what it missed", () => {
      const marker = {
        run: 4410,
        artifact: 901,
        failure: "timeout",
        routes: ["/book", "/book/waitlist"],
        preview: { is: "none" },
        missed: [
          { route: "/book/waitlist", viewport: "mobile", side: "after" },
          { route: "/book/waitlist", viewport: "desktop", side: "after" },
        ],
      } as const;

      expect(evidenceOf(marker)).toEqual([
        {
          run: 4410,
          artifact: 901,
          failure: "timeout",
          preview: "none",
          pages: [
            { route: "/book", preview: null },
            { route: "/book/waitlist", preview: null },
          ],
          failureSentence: "Capture failed: it ran out of time.",
          missed: [
            { route: "/book/waitlist", viewport: "mobile", side: "after" },
            { route: "/book/waitlist", viewport: "desktop", side: "after" },
          ],
        },
      ]);
    });

    it("reads a marker from an earlier release with its run, artifact and failure, its pages null and its preview unknown", () => {
      expect(evidenceOf({ run: 4410, artifact: 901, failure: "timeout" })).toEqual([
        { run: 4410, artifact: 901, failure: "timeout", preview: "unknown", pages: null, failureSentence: "Capture failed: it ran out of time.", missed: null },
      ]);
      expect(evidenceOf({ run: 4410, artifact: 901 })).toEqual([{ run: 4410, artifact: 901, failure: null, preview: "unknown", pages: null, failureSentence: null, missed: null }]);
    });

    it("is null on a pull request with no marker, and on a row with no pull request", () => {
      const facts = homeFactsOf({ github: factsOf({ openIssues: [TICKET], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 8 })] }) });

      expect(evidenceOf(null)).toEqual([null]);
      expect(rowsOf(facts, null, null, null, NOW).map(({ evidence }) => evidence)).toEqual([null, null]);
    });
  });

  describe("an agent pull request's named Evidence shots (#822)", () => {
    const PREVIEW = "https://fabrik-ticket-7.shop.example.dev/";
    const READ_AT = "c".repeat(40);
    /** The shots marker once the Review's jobs read the `e2e` check's artifact at READ_AT: three names, one with no path, one missed outright, one lacking its desktop size. */
    const READ: ShotsMarker = {
      source: "shots",
      head: READ_AT,
      run: 9300,
      artifact: 9301,
      failure: null,
      routes: [],
      named: [{ name: "composer: draft ready", journey: "write-a-clinical-note", path: "/patients/6f1b2c3d/notes/new?tab=draft" }, { name: "inbox: empty" }, { name: "sign in: form", path: "/sign-in" }],
      missed: [
        { name: "inbox: empty", why: "not-produced" },
        { name: "sign in: form", viewport: "desktop", why: "size-missing" },
      ],
      preview: { is: "linked", url: PREVIEW },
      implementRun: 9100,
    };
    const shotsOf = (marker: ShotsMarker, overrides: Partial<Omit<Facts, "kind">> = {}) => {
      const facts = homeFactsOf({ github: factsOf({ openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 })] }), shotsMarkers: [{ pullRequest: 50, marker }], ...overrides });
      return rowsOf(facts, null, null, null, NOW)
        .filter(({ standing }) => standing.pullRequest === 50)
        .map(({ shots }) => shots);
    };

    it("carries each named shot in the pull request's order, with its path, whether it was produced and why not, and its page on the linked preview", () => {
      expect(shotsOf(READ)).toEqual([
        {
          head: READ_AT,
          run: 9300,
          artifact: 9301,
          failure: null,
          preview: "linked",
          nothingVisible: null,
          nothingNamed: false,
          named: [
            {
              name: "composer: draft ready",
              journey: "write-a-clinical-note",
              path: "/patients/6f1b2c3d/notes/new?tab=draft",
              produced: true,
              missed: [],
              preview: "https://fabrik-ticket-7.shop.example.dev/patients/6f1b2c3d/notes/new?tab=draft",
              production: null,
            },
            { name: "inbox: empty", journey: null, path: null, produced: false, missed: [{ why: "not-produced" }], preview: null, production: null },
            { name: "sign in: form", journey: null, path: "/sign-in", produced: true, missed: [{ viewport: "desktop", why: "size-missing" }], preview: "https://fabrik-ticket-7.shop.example.dev/sign-in", production: null },
          ],
        },
      ]);
    });

    it("gives no shot a preview page when the preview isn't linked", () => {
      const [shots] = shotsOf({ ...READ, preview: { is: "never-answered", url: PREVIEW } });

      expect(shots?.preview).toBe("never-answered");
      expect(shots?.named.map(({ preview }) => preview)).toEqual([null, null, null]);
    });

    it("carries the names as unproduced, with no head, while the marker waits for the named check", () => {
      const waiting: ShotsMarker = { ...READ, head: null, run: null, artifact: null, named: READ.named.map(({ name }) => ({ name })), missed: [], preview: { is: "pending" } };

      expect(shotsOf(waiting)).toMatchObject([{ head: null, run: null, artifact: null, preview: "pending", named: [{ produced: false, path: null }, { produced: false, path: null }, { produced: false, path: null }] }]);
    });

    it("carries why nothing of the run could be read, with every name unproduced", () => {
      const [shots] = shotsOf({ ...READ, failure: "no-artifact", named: READ.named.map(({ name }) => ({ name })), missed: [] });

      expect(shots?.failure).toBe("no-artifact");
      expect(shots?.named.map(({ produced }) => produced)).toEqual([false, false, false]);
    });

    it("carries the Implementer's sentence that nothing a person sees changes, and no shots", () => {
      expect(shotsOf({ ...READ, named: [], missed: [], nothingVisible: "Only the API's error codes changed." })).toMatchObject([{ nothingVisible: "Only the API's error codes changed.", nothingNamed: false, named: [] }]);
    });

    it("says a pull request that names nothing and gives no sentence named nothing", () => {
      expect(shotsOf({ ...READ, named: [], missed: [], miss: "nothing-named" })).toMatchObject([{ nothingVisible: null, nothingNamed: true, named: [] }]);
    });

    it("gives a merged pull request's shot with a path its live page, built as a route's is, and one with no path none", () => {
      const kit = homeFactsOf().kit;
      const [shots] = shotsOf(READ, {
        github: factsOf(),
        kit: { ...kit, config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, production: { url: "https://example.dev/shop/", environment: null } } } },
        mergedLastDay: [aMergedLastDay("2026-11-08T19:30:00Z")],
      });

      expect(shots?.named.map(({ name, production }) => ({ name, production }))).toEqual([
        { name: "composer: draft ready", production: "https://example.dev/shop/patients/6f1b2c3d/notes/new?tab=draft" },
        { name: "inbox: empty", production: null },
        { name: "sign in: form", production: "https://example.dev/shop/sign-in" },
      ]);
    });

    it("are null on a pull request with a route marker, whose evidence is what it was, and on one with no marker", () => {
      const ROUTE_MARKER = { run: 4410, artifact: 901, failure: null, routes: ["/book"], preview: { is: "linked", url: PREVIEW }, missed: [] } as const;
      const facts = homeFactsOf({
        github: factsOf({ openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 }), anOpenPullRequest({ number: 51, ticket: 8 })] }),
        evidenceMarkers: [{ pullRequest: 50, marker: ROUTE_MARKER }],
      });

      expect(rowsOf(facts, null, null, null, NOW).flatMap(({ standing, evidence, shots }) => (standing.pullRequest === null ? [] : [{ pullRequest: standing.pullRequest, evidence, shots }]))).toEqual([
        {
          pullRequest: 50,
          evidence: { run: 4410, artifact: 901, failure: null, preview: "linked", pages: [{ route: "/book", preview: "https://fabrik-ticket-7.shop.example.dev/book" }], failureSentence: null, missed: [] },
          shots: null,
        },
        { pullRequest: 51, evidence: null, shots: null },
      ]);
    });

    it("are null on every row of facts cached by an earlier release, which hold no shots markers", () => {
      const { shotsMarkers: _, ...cached } = homeFactsOf({ github: factsOf({ openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 })] }) });

      const rows = rowsOf(JSON.parse(JSON.stringify(cached)) as Facts, null, null, null, NOW);

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map(({ shots }) => shots)).toEqual(rows.map(() => null));
    });

    describe("as the README's section on reading the Kit says it", () => {
      const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
      const section = readme.split("\n## Reading the Kit from another program\n")[1]?.split("\n## ")[0] ?? "";
      const lines = section.split("\n");
      const at = lines.findIndex((line) => line.startsWith("- **Evidence shots.**"));
      /** The bullet with the bullets under it. */
      const bullet = at === -1 ? "" : [lines[at], ...lines.slice(at + 1).filter((line, index, rest) => rest.slice(0, index + 1).every((under) => under.startsWith("  - ")))].join("\n");

      it("names what the row carries under shots, and that a shot with no path has no link", () => {
        for (const named of ["`shots`", "`head`", "`nothingVisible`", "`named`", "`path`", "`produced`", "`missed`", "`preview`", "`production`"]) expect(bullet).toContain(named);
        expect(bullet).toContain("a shot with no `path` has neither");
      });

      it("says a pull request with no section has no named shots on its row, and how a reader finds and reads a head's shots itself", () => {
        expect(bullet).toMatch(/a Plain pull request[^.]*has no named shots on its row/);
        expect(bullet).toContain("the newest attempt of the check `ui.shots.check` names");
        for (const named of ["`ui.shots.artifact`", "`DEFAULT_SHOTS_ARTIFACT`", "`readShotsManifest`", "`SHOTS_MANIFEST_FILE`", "`namedShots`", "`shotsMarkerIn`", "`producedNamedShots`"]) expect(bullet).toContain(named);
        expect(bullet).toContain("with its own credential");
      });
    });
  });

  describe("an issue's Prototype (#639)", () => {
    const at = (minute: number) => `2026-11-08T19:${String(minute).padStart(2, "0")}:00Z`;
    const posted = (id: number, body: string, minute: number, overrides: Parameters<typeof aComment>[2] = {}) =>
      aComment(body, at(minute), { id, url: `https://github.com/owner/product/issues/21#issuecomment-${id}`, ...overrides });
    const question = { question: "Which variant?", recommendation: "B, as it shows the price first." };
    const variant = (letter: string) => ({ letter, summary: `Variant ${letter}`, component: `https://github.com/owner/product/blob/${HEAD}/src/Book${letter}.tsx`, preview: null });
    /** A prototype round as this release posts it, its line third. */
    const prototypeRound = (round: number, captures: { run: number; artifact: number } | null = { run: 4410, artifact: 902 }) =>
      [
        designRoundMarker(round),
        PROTOTYPE_ROUND_MARKER,
        roundLineOf({ v: 1, kind: "prototype", round, intro: "Two takes on the booking page.", questions: [question], route: "/book", variants: [variant("A"), variant("B")], captures }),
        "Two takes on the booking page.",
        "",
        "**Which variant?**",
      ].join("\n");
    const earlierPrototypeRound = (round: number) => [designRoundMarker(round), PROTOTYPE_ROUND_MARKER, "Two takes on the booking page.", "", "**Which variant?**"].join("\n");
    const failureRound = (round: number) =>
      [
        designRoundMarker(round),
        PROTOTYPE_FAILURE_ROUND_MARKER,
        roundLineOf({ v: 1, kind: "prototype-failed", round, intro: "The build failed.", questions: [{ question: "Carry on without a prototype, or try again?", recommendation: "Carry on." }], otherAnswers: ["Try again"] }),
        "The build failed.",
      ].join("\n");
    const ordinaryRound = (round: number) => `${designRoundMarker(round)}\nWhich of these should it do?`;
    const reply = (id: number, minute: number) => posted(id, "B, but with a bigger button.", minute, { author: "operator", byBot: false });
    const prototypeOf = (comments: readonly CommentFacts[], appLogin: string | null = "fabrik-app[bot]") => {
      const facts = homeFactsOf({ appLogin, github: factsOf({ openIssues: [anOpenIssue({ number: 21, title: "Rework the booking page", labels: ["needs-design"], comments })] }) });
      return rowsOf(facts, null, null, null, NOW)
        .filter(({ standing }) => standing.issue === 21)
        .map(({ prototype }) => prototype);
    };

    it("is the session's newest prototype round: its number, comment, time, route and captures, waiting while the Operator has not replied after it", () => {
      const comments = [posted(5001, ordinaryRound(1), 0), reply(5002, 5), posted(5003, prototypeRound(2), 10)];

      expect(prototypeOf(comments)).toEqual([{ round: 2, comment: 5003, postedAt: at(10), waiting: true, route: "/book", captures: { run: 4410, artifact: 902 } }]);
    });

    it("gives no captures when the prototype job kept none", () => {
      expect(prototypeOf([posted(5003, prototypeRound(1, null), 10)])).toMatchObject([{ round: 1, captures: null, waiting: true }]);
    });

    it("no longer waits once the Operator replies after it, and a bot's reply or another person's is not theirs", () => {
      expect(prototypeOf([posted(5003, prototypeRound(2), 10), reply(5004, 20)])).toMatchObject([{ comment: 5003, waiting: false }]);
      expect(prototypeOf([posted(5003, prototypeRound(2), 10), posted(5004, "Deployed a preview.", 20, { author: "vercel[bot]" })])).toMatchObject([{ comment: 5003, waiting: true }]);
      expect(prototypeOf([posted(5003, prototypeRound(2), 10), posted(5004, "Looks good.", 20, { author: "kate", byBot: false })])).toMatchObject([{ comment: 5003, waiting: true }]);
    });

    it("no longer waits once a later Round is posted, an ordinary one or a prototype failure round", () => {
      expect(prototypeOf([posted(5003, prototypeRound(2), 10), posted(5004, ordinaryRound(3), 20)])).toMatchObject([{ round: 2, comment: 5003, waiting: false }]);
      expect(prototypeOf([posted(5003, prototypeRound(2), 10), reply(5004, 15), posted(5005, failureRound(3), 20)])).toMatchObject([{ round: 2, comment: 5003, waiting: false }]);
    });

    it("is null when the newest prototype round was posted by an earlier release, with no line, even after one that has one", () => {
      expect(prototypeOf([posted(5003, earlierPrototypeRound(2), 10)])).toEqual([null]);
      expect(prototypeOf([posted(5003, prototypeRound(2), 10), reply(5004, 15), posted(5005, earlierPrototypeRound(3), 20)])).toEqual([null]);
    });

    it("is never a prototype failure round, nor an issue with no prototype round", () => {
      expect(prototypeOf([posted(5003, failureRound(2), 10)])).toEqual([null]);
      expect(prototypeOf([posted(5001, ordinaryRound(1), 0)])).toEqual([null]);
      expect(prototypeOf([])).toEqual([null]);
    });

    it("reads a round's line only from the Fabrik App's comment, any bot's when the gather was given no App login", () => {
      const quoted = posted(5003, prototypeRound(2), 10, { author: "kate", byBot: false });
      const anotherBot = posted(5003, prototypeRound(2), 10, { author: "helper[bot]" });

      expect(prototypeOf([quoted])).toEqual([null]);
      expect(prototypeOf([anotherBot])).toEqual([null]);
      expect(prototypeOf([anotherBot], null)).toMatchObject([{ comment: 5003, waiting: true }]);
    });

    it("is null on a row with no open issue: a pull request's with no Ticket", () => {
      const facts = homeFactsOf({ github: factsOf({ openPullRequests: [anOpenPullRequest({ number: 51, ticket: null, comments: [posted(5003, prototypeRound(2), 10)] })] }) });

      expect(rowsOf(facts, null, null, null, NOW).map(({ prototype }) => prototype)).toEqual([null]);
    });
  });

  describe("the last word", () => {
    const lastWordOf = (facts: Facts) => rowsOf(facts, null, null, null, NOW).find(({ standing }) => standing.issue === 7)?.lastWord;

    it("is the Fabrik App's latest comment on the issue or its pull request, with when and where it was said", () => {
      const onIssue = aComment("The Kit opened #50 for this Ticket.", "2026-11-08T18:00:00Z", { url: "https://github.com/owner/product/issues/7#issuecomment-1" });
      const onPullRequest = aComment("Review passed.", "2026-11-08T19:00:00Z", { url: "https://github.com/owner/product/pull/50#issuecomment-2" });
      const facts = homeFactsOf({ github: factsOf({ openIssues: [{ ...TICKET, comments: [onIssue] }], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, comments: [onPullRequest] })] }) });

      expect(lastWordOf(facts)).toEqual({ text: "Review passed.", at: "2026-11-08T19:00:00Z", url: "https://github.com/owner/product/pull/50#issuecomment-2" });
    });

    it("is never a held line, and a person's later comment does not replace it", () => {
      const said = aComment("The Implement run failed.", "2026-11-08T17:00:00Z");
      const held = aComment(endedHeldLine("implement", 7, { kind: "resumed" }, "2026-11-08T18:00:00Z", null), "2026-11-08T18:00:00Z");
      const person = aComment("Any news?", "2026-11-08T19:00:00Z", { author: "operator", byBot: false });
      const facts = homeFactsOf({ github: factsOf({ openIssues: [{ ...TICKET, comments: [said, held, person] }] }) });

      expect(lastWordOf(facts)).toMatchObject({ text: "The Implement run failed.", at: "2026-11-08T17:00:00Z" });
    });

    it("is null when the Fabrik App has said nothing on the work, and another bot's comment is not its word", () => {
      const other = aComment("Deployed a preview.", "2026-11-08T19:00:00Z", { author: "vercel[bot]" });
      const facts = homeFactsOf({ github: factsOf({ openIssues: [{ ...TICKET, comments: [other] }] }) });

      expect(lastWordOf(facts)).toBeNull();
    });

    it("is any bot's latest comment when the gather was given no App login, as the Kit job takes any bot's text for the App's", () => {
      const other = aComment("Deployed a preview.", "2026-11-08T19:00:00Z", { author: "vercel[bot]" });
      const facts = homeFactsOf({ appLogin: null, github: factsOf({ openIssues: [{ ...TICKET, comments: [other] }] }) });

      expect(lastWordOf(facts)).toMatchObject({ text: "Deployed a preview." });
    });
  });

  describe("whether an open agent pull request's Ticket is closed", () => {
    const atTheMergeGate = anOpenPullRequest({ number: 50, ticket: 7, draft: false, comments: [aVerdictComment("pass", HEAD, "2026-11-07T20:00:00Z")] });
    const inDraft = anOpenPullRequest({ number: 50, ticket: 7, draft: true });
    const ticketClosedOf = (facts: Facts) => rowsOf(facts, null, null, null, NOW).filter(({ standing }) => standing.pullRequest === 50).map(({ ticketClosed }) => ticketClosed);

    it.each([
      ["at the Merge gate", atTheMergeGate],
      ["in draft", inDraft],
    ])("is yes on its row %s when its Ticket is closed", (_where, pullRequest) => {
      const facts = homeFactsOf({ github: factsOf({ openPullRequests: [pullRequest] }), ticketStates: [{ ticket: 7, closed: true }] });

      expect(ticketClosedOf(facts)).toEqual(["yes"]);
    });

    it.each([
      ["at the Merge gate", atTheMergeGate],
      ["in draft", inDraft],
    ])("is no on its row %s when its Ticket is open", (_where, pullRequest) => {
      const facts = homeFactsOf({ github: factsOf({ openIssues: [TICKET], openPullRequests: [pullRequest] }), ticketStates: [{ ticket: 7, closed: false }] });

      expect(ticketClosedOf(facts)).toEqual(["no"]);
    });

    it("is unknown when the pull request names no Ticket", () => {
      const facts = homeFactsOf({ github: factsOf({ openPullRequests: [{ ...atTheMergeGate, ticket: null }] }) });

      expect(ticketClosedOf(facts)).toEqual(["unknown"]);
    });

    it("is unknown when its Ticket could not be read", () => {
      const facts = homeFactsOf({ github: factsOf({ openIssues: [TICKET], openPullRequests: [atTheMergeGate] }), ticketStates: [] });

      expect(ticketClosedOf(facts)).toEqual(["unknown"]);
    });

    it("is null on a row with no open agent pull request: an issue's, and a Plain pull request's", () => {
      const facts = homeFactsOf({ github: factsOf({ openIssues: [TICKET], plainPullRequests: [aPlainPullRequest({ number: 70 })] }), ticketStates: [{ ticket: 7, closed: false }] });

      const rows = rowsOf(facts, null, null, null, NOW);

      expect(rows.map(({ standing, ticketClosed }) => ({ issue: standing.issue, pullRequest: standing.pullRequest, ticketClosed }))).toEqual(
        expect.arrayContaining([
          { issue: 7, pullRequest: null, ticketClosed: null },
          { issue: null, pullRequest: 70, ticketClosed: null },
        ]),
      );
      expect(rows).toHaveLength(2);
    });
  });

  it("take any bot's text for the Fabrik App's when the gather was given no App login", () => {
    const notice = handedBack("2026-11-08T19:30:00Z", { author: "some-app[bot]" });
    const issues = [{ ...TICKET, comments: [notice] }];

    const named = (appLogin: string | null) => rowsOf(homeFactsOf({ appLogin, github: factsOf({ openIssues: issues }) }), null, null, null, NOW).map(({ standing }) => standing.name);

    expect(named(null)).toEqual(["yours-to-do"]);
    expect(named("fabrik-app[bot]")).not.toEqual(["yours-to-do"]);
  });

  it("survive a JSON round trip", () => {
    const facts = homeFactsOf({
      github: factsOf({
        openIssues: [{ ...TICKET, comments: [aComment("Started.", "2026-11-08T19:10:00Z")] }],
        openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 })],
        plainPullRequests: [aPlainPullRequest()],
      }),
    });

    const rows: Row[] = rowsOf(facts, aRunsRead([aRunRead({ issue: 7 })]), null, null, NOW);

    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(rows))).toStrictEqual(rows);
    expect(JSON.parse(JSON.stringify(facts))).toStrictEqual(facts);
  });

  it("carry their evidence, production and Prototype on every row, null where there is nothing, and survive a JSON round trip with each filled (#639)", () => {
    const line = roundLineOf({
      v: 1,
      kind: "prototype",
      round: 1,
      intro: "Two takes.",
      questions: [{ question: "Which variant?", recommendation: "A." }],
      route: "/book",
      variants: [{ letter: "A", summary: "Variant A", component: "https://github.com/owner/product/blob/h/src/A.tsx", preview: null }],
      captures: { run: 4420, artifact: 902 },
    });
    const prototypeRound = aComment([designRoundMarker(1), PROTOTYPE_ROUND_MARKER, line, "Two takes."].join("\n"), "2026-11-08T19:00:00Z", { id: 5003 });
    const marker = { run: 4410, artifact: 901, failure: null, routes: ["/book"], preview: { is: "linked", url: "https://fabrik-ticket-8.shop.example.dev/" } } as const;
    const facts = homeFactsOf({
      kit: { ...homeFactsOf().kit, config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, production: { url: "https://shop.example", environment: "production" } } } },
      github: factsOf({
        openIssues: [anOpenIssue({ number: 21, title: "Rework the booking page", labels: ["needs-design"], comments: [prototypeRound] }), TICKET],
        openPullRequests: [anOpenPullRequest({ number: 51, ticket: 8 })],
        plainPullRequests: [aPlainPullRequest()],
      }),
      mergedLastDay: [aMergedLastDay("2026-11-08T19:30:00Z")],
      evidenceMarkers: [
        { pullRequest: 50, marker },
        { pullRequest: 51, marker },
      ],
    });

    const rows = rowsOf(facts, null, null, null, NOW);

    for (const row of rows) expect(Object.keys(row)).toEqual(expect.arrayContaining(["evidence", "production", "prototype"]));
    expect(rows.filter(({ evidence }) => evidence !== null).map(({ standing }) => standing.pullRequest)).toEqual(expect.arrayContaining([50, 51]));
    expect(rows.filter(({ production }) => production !== null).map(({ standing }) => standing.pullRequest)).toEqual([50]);
    expect(rows.filter(({ prototype }) => prototype !== null).map(({ standing }) => standing.issue)).toEqual([21]);
    expect(rows.filter(({ evidence, production, prototype }) => evidence === null && production === null && prototype === null).length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(rows))).toStrictEqual(rows);
    expect(JSON.parse(JSON.stringify(facts))).toStrictEqual(facts);
  });
});
