import { describe, expect, it } from "vitest";
import type { EvidenceMarker } from "../evidence/uiEvidence.ts";
import type { RunInFlightFact } from "../github/snapshot.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { standingsOf } from "../kit/standing.ts";
import type { RequiredChecksFact } from "../kit/weeklySummary.ts";
import { endedHeldLine } from "../loop/heldLine.ts";
import { handBackMarker } from "../loop/markers.ts";
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

  describe("an agent pull request's UI evidence (#639)", () => {
    const PREVIEW = "https://fabrik-ticket-7.shop.example.dev/";
    const evidenceOf = (marker: EvidenceMarker | null, pullRequest = anOpenPullRequest({ number: 50, ticket: 7 })) => {
      const facts = homeFactsOf({ github: factsOf({ openPullRequests: [pullRequest] }), evidenceMarkers: marker === null ? [] : [{ pullRequest: 50, marker }] });
      return rowsOf(facts, null, null, null, NOW)
        .filter(({ standing }) => standing.pullRequest === 50)
        .map(({ evidence }) => evidence);
    };

    it("is on an open UI pull request's row: its run, artifact and failure, what came of the preview, and a page for each captured route, in the marker's order", () => {
      const marker = { run: 4410, artifact: 901, failure: null, routes: ["/cart?step=2", "/book"], preview: { is: "linked", url: PREVIEW } } as const;

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
        },
      ]);
    });

    it.each([
      ["pending", { is: "pending" }],
      ["never-answered", { is: "never-answered", url: PREVIEW }],
      ["none", { is: "none" }],
    ] as const)("gives no page a preview address when the preview is %s", (is, preview) => {
      const marker = { run: 4410, artifact: 901, failure: null, routes: ["/book"], preview };

      expect(evidenceOf(marker)).toEqual([{ run: 4410, artifact: 901, failure: null, preview: is, pages: [{ route: "/book", preview: null }] }]);
    });

    it("gives a failed capture's reason, and no pages when it captured no route", () => {
      const marker = { run: 4410, artifact: null, failure: "server-did-not-start", routes: [], preview: { is: "pending" } } as const;

      expect(evidenceOf(marker)).toEqual([{ run: 4410, artifact: null, failure: "server-did-not-start", preview: "pending", pages: [] }]);
    });

    it("reads a marker from an earlier release with its run, artifact and failure, its pages null and its preview unknown", () => {
      expect(evidenceOf({ run: 4410, artifact: 901, failure: "timeout" })).toEqual([{ run: 4410, artifact: 901, failure: "timeout", preview: "unknown", pages: null }]);
      expect(evidenceOf({ run: 4410, artifact: 901 })).toEqual([{ run: 4410, artifact: 901, failure: null, preview: "unknown", pages: null }]);
    });

    it("is null on a pull request with no marker, and on a row with no pull request", () => {
      const facts = homeFactsOf({ github: factsOf({ openIssues: [TICKET], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 8 })] }) });

      expect(evidenceOf(null)).toEqual([null]);
      expect(rowsOf(facts, null, null, null, NOW).map(({ evidence }) => evidence)).toEqual([null, null]);
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
      const held = aComment(endedHeldLine("implement", 7, { kind: "resumed" }, "2026-11-08T18:00:00Z"), "2026-11-08T18:00:00Z");
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
});
