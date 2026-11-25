import { describe, expect, it } from "vitest";
import { A_SCHEMA_1_BLOCKED, ON_STAGING_AT_SCHEMA_2, THAT_BLOCKED_AT_SCHEMA_2, THE_SAME_AT_SCHEMAS_1_AND_2 } from "../kit/keptStandings.fixture.ts";
import { aDeploymentsRead, aDeployOf, aRunsRead } from "./builders.ts";
import { joinChecks } from "./joinChecks.ts";
import { joinDeployments, mergesToRead } from "./joinDeployments.ts";
import { joinRuns } from "./joinRuns.ts";
import { commitsToCheck, joinStaging, stagingMergesToRead } from "./joinStaging.ts";
import { readRow } from "./keptRow.ts";
import { owedRollInsOf } from "./owedRollIn.ts";
import { headsToCheck, type RequiredChecksRead } from "./requiredChecks.ts";
import type { Row } from "./rows.ts";

/** A Standing of the kept Standings, by its name. */
const theKept = (name: string) => THE_SAME_AT_SCHEMAS_1_AND_2.find((standing) => standing.name === name)!;

/** What a row kept at v3.4.1 holds beside its Standing and its `plainPullRequest`: every field a row had then, so no `shots`, and its Follow-up with no kind. */
const KEPT_BESIDE = {
  title: "Sign the contract",
  lastWord: { text: "Blocked for now.", at: "2026-11-08T12:10:00Z", url: "https://github.com/acme/shop/issues/12#issuecomment-1" },
  related: [],
  mentions: [{ issue: 30, title: "Mentions it" }],
  relatedTo: 50,
  followUps: [{ title: "Tidy up", body: "Later.", filedAs: null }],
  ticketClosed: null,
  evidence: null,
  production: null,
  prototype: { round: 2, comment: 901, postedAt: "2026-11-08T11:00:00Z", waiting: false, route: "/book", captures: null },
  digest: null,
} as const;

/** Ticket 12's row as v3.4.1 kept it: its Standing blocked, at schema 1. */
const A_ROW_KEPT_AT_V3_4_1 = { standing: A_SCHEMA_1_BLOCKED, plainPullRequest: null, ...KEPT_BESIDE };

/** The row of Ticket 12 joined to its Pairing session's pull request 60, which took it over as yours to merge, as v3.4.1 kept it: the issue's own blocked Standing under `plainPullRequest.own`. */
const A_PAIRING_ROW_KEPT_AT_V3_4_1 = {
  standing: { ...theKept("yours-to-merge"), schema: 1, pullRequest: 60, detail: { plain: "pairing", pullRequest: "yours-to-merge", head: "h".repeat(40) } },
  plainPullRequest: { since: "2026-11-08T11:30:00Z", own: A_SCHEMA_1_BLOCKED },
  ...KEPT_BESIDE,
};

/** The same beside a row of this release: its Follow-up, kept before a Follow-up had a kind, an idea (#885). */
const BESIDE = { ...KEPT_BESIDE, followUps: [{ title: "Tidy up", body: "Later.", filedAs: null, kind: "idea" }] } as const;

/** A row of this release: its Standing at the current schema, `shots` and `operatorSession` on it, and its Follow-up's kind. */
const A_CURRENT_ROW: Row = { standing: THAT_BLOCKED_AT_SCHEMA_2, plainPullRequest: null, ...BESIDE, shots: null, operatorSession: null };

/** Where to try a merged pull request on staging as v4.3.0 kept it on its row: before a row's `staging` had `trial` (#965). */
const STAGING_KEPT_AT_V4_3_0 = { site: "https://staging.shop.example", pages: [{ route: "/book", url: "https://staging.shop.example/book" }], shots: [], toTry: ["/book"] };

/** A row of this release in a repo that declares `staging` (#855): a merged pull request's, on staging, with where to try it and no Trial steps. */
const A_ROW_AT_STAGING: Row = { ...A_CURRENT_ROW, standing: ON_STAGING_AT_SCHEMA_2, staging: { ...STAGING_KEPT_AT_V4_3_0, trial: null } };

/** That row as v4.3.0 kept it. */
const A_ROW_AT_STAGING_KEPT_AT_V4_3_0 = { ...A_CURRENT_ROW, standing: ON_STAGING_AT_SCHEMA_2, staging: STAGING_KEPT_AT_V4_3_0 };

describe("a kept row read back", () => {
  it("kept at v3.4.1, has its Standing at the current schema, no Evidence shots, no Operator session and its Follow-up an idea, with every other field as kept", () => {
    expect(readRow(JSON.parse(JSON.stringify(A_ROW_KEPT_AT_V3_4_1)))).toEqual({ standing: THAT_BLOCKED_AT_SCHEMA_2, plainPullRequest: null, ...BESIDE, shots: null, operatorSession: null });
  });

  it("kept before a row had `operatorSession` (#951), reads with it null, every other field as kept", () => {
    const { operatorSession: _none, ...keptBefore } = { ...A_CURRENT_ROW, shots: { head: null, run: null, artifact: null, failure: null, preview: "unknown", nothingVisible: null, nothingNamed: true, named: [] } } as const;

    expect(readRow(JSON.parse(JSON.stringify(keptBefore)))).toEqual({ ...keptBefore, operatorSession: null });
  });

  it("of this release comes back as it is, its Operator session with it", () => {
    const withSession: Row = { ...A_CURRENT_ROW, operatorSession: "https://claude.ai/code/session_01GcsNdk1yVNhd1T31USEtv1" };

    expect(readRow(withSession)).toBe(withSession);
    expect(readRow(JSON.parse(JSON.stringify(withSession)))).toEqual(withSession);
  });

  it("kept before a Follow-up had its kind (#885), reads each Follow-up as an idea, its title, its body and what it was filed as as kept", () => {
    const { shots: _shots, ...current } = A_CURRENT_ROW;
    const keptBefore = { ...current, shots: null, followUps: [{ title: "Tidy up", body: "Later.", filedAs: 31 }, { title: "Cache it", body: "", filedAs: null }] };

    expect(readRow(JSON.parse(JSON.stringify(keptBefore)))?.followUps).toEqual([
      { title: "Tidy up", body: "Later.", filedAs: 31, kind: "idea" },
      { title: "Cache it", body: "", filedAs: null, kind: "idea" },
    ]);
  });

  it("of this release keeps each Follow-up's kind, a fault's among them", () => {
    const withFault: Row = { ...A_CURRENT_ROW, followUps: [{ title: "The badge miscounts", body: "`badge.ts:14`.", kind: "fault", filedAs: 101 }] };

    expect(readRow(withFault)).toBe(withFault);
    expect(readRow(JSON.parse(JSON.stringify(withFault)))).toEqual(withFault);
  });

  it("a Pairing session's, kept at v3.4.1, has the issue's own Standing at the current schema too", () => {
    expect(readRow(JSON.parse(JSON.stringify(A_PAIRING_ROW_KEPT_AT_V3_4_1)))).toEqual({
      standing: { ...A_PAIRING_ROW_KEPT_AT_V3_4_1.standing, schema: 2 },
      plainPullRequest: { since: "2026-11-08T11:30:00Z", own: THAT_BLOCKED_AT_SCHEMA_2 },
      ...BESIDE,
      shots: null,
      operatorSession: null,
    });
  });

  it("a Plain pull request's, kept at v3.4.1 with no issue's own Standing, keeps its `plainPullRequest` as it was", () => {
    const plainPullRequest = { since: "2026-11-08T11:30:00Z", own: null };
    const kept = { ...A_ROW_KEPT_AT_V3_4_1, standing: { ...theKept("check-failing"), schema: 1 }, plainPullRequest };

    expect(readRow(kept)).toEqual({ ...kept, ...BESIDE, standing: theKept("check-failing"), shots: null, operatorSession: null });
  });

  it("with no `plainPullRequest` at all still reads: nothing of a row is checked but its Standings' schemas", () => {
    const { plainPullRequest: _none, ...kept } = A_ROW_KEPT_AT_V3_4_1;

    expect(readRow(kept)).toMatchObject({ standing: THAT_BLOCKED_AT_SCHEMA_2, shots: null, title: "Sign the contract" });
  });

  it("of this release comes back as it is, its Evidence shots with it", () => {
    const shots = { head: null, run: null, artifact: null, failure: null, preview: "unknown", nothingVisible: null, nothingNamed: true, named: [] } as const;
    const withShots: Row = { ...A_CURRENT_ROW, shots };

    expect(readRow(A_CURRENT_ROW)).toBe(A_CURRENT_ROW);
    expect(readRow(withShots)).toBe(withShots);
    expect(readRow(JSON.parse(JSON.stringify(withShots)))).toEqual(withShots);
  });

  it("kept before a row had `staging`, reads with none, as a row of a repo that declares no `staging` has none", () => {
    const keptAtV4_1_0 = JSON.parse(JSON.stringify(A_CURRENT_ROW)) as Row;

    expect(readRow(keptAtV4_1_0)).toBe(keptAtV4_1_0);
    expect(readRow(A_ROW_KEPT_AT_V3_4_1)).not.toHaveProperty("staging");
  });

  it("of this release at Staging comes back as it is, where to try it on staging with it", () => {
    expect(readRow(A_ROW_AT_STAGING)).toBe(A_ROW_AT_STAGING);
    expect(readRow(JSON.parse(JSON.stringify(A_ROW_AT_STAGING)))).toEqual(A_ROW_AT_STAGING);
  });

  it("kept at Staging before a row's `staging` had `trial` (#965), reads with no Trial steps, its site, its pages, its shots and what to try as kept", () => {
    const read = readRow(JSON.parse(JSON.stringify(A_ROW_AT_STAGING_KEPT_AT_V4_3_0)));

    expect(read).toEqual({ ...A_CURRENT_ROW, standing: ON_STAGING_AT_SCHEMA_2, staging: { site: "https://staging.shop.example", pages: [{ route: "/book", url: "https://staging.shop.example/book" }], shots: [], toTry: ["/book"], trial: null } });
    expect(read?.staging).toHaveProperty("trial", null);
    expect(() => joinStaging([read!], { deployments: aDeploymentsRead({}), mainChecks: null }, "2026-11-08T13:00:00Z")).not.toThrow();
  });

  it("of this release at Staging comes back as it is with its Trial steps, each with its link", () => {
    const trial = { summary: "A patient can now book a visit.", steps: [{ do: "Pick tomorrow.", expect: "Its free times.", route: "/book", url: "https://staging.shop.example/book" }, { do: "Open any patient.", expect: "The visit under Upcoming.", route: null, url: null }] };
    const withSteps: Row = { ...A_ROW_AT_STAGING, staging: { ...STAGING_KEPT_AT_V4_3_0, trial } };

    expect(readRow(withSteps)).toBe(withSteps);
    expect(readRow(JSON.parse(JSON.stringify(withSteps)))).toEqual(withSteps);
  });

  it.each([
    ["a row whose Standing is of schema 3, a newer Kit's", { ...A_CURRENT_ROW, standing: { ...THAT_BLOCKED_AT_SCHEMA_2, schema: 3 } }],
    ["a row at Staging whose Standing is of schema 3", { ...A_ROW_AT_STAGING, standing: { ...ON_STAGING_AT_SCHEMA_2, schema: 3 } }],
    ["a Pairing session's row whose issue's own Standing is of schema 3", { ...A_CURRENT_ROW, plainPullRequest: { since: "2026-11-08T11:30:00Z", own: { ...THAT_BLOCKED_AT_SCHEMA_2, schema: 3 } } }],
    ["a row whose Standing has no schema", { ...A_CURRENT_ROW, standing: { ...THAT_BLOCKED_AT_SCHEMA_2, schema: undefined } }],
    ["a row with no Standing", { ...BESIDE, plainPullRequest: null }],
    ["a string", "a row"],
    ["null", null],
    ["nothing", undefined],
  ])("%s reads as null", (_what, kept) => {
    expect(readRow(kept)).toBeNull();
  });
});

describe("kept rows holding a Standing of another schema, given to a join or to anything else that takes kept rows", () => {
  const NOW = "2026-11-08T20:00:00Z";
  const A_CHECKS_READ: RequiredChecksRead = { repo: "acme/shop", branch: "main", readAt: NOW, required: ["test"], holdsAdmins: "yes", heads: {}, consoleCheck: { is: "not-required" } };
  const JOINS: readonly (readonly [string, (rows: readonly Row[]) => unknown])[] = [
    ["joinRuns", (rows) => joinRuns(rows, aRunsRead([]), NOW)],
    ["joinChecks", (rows) => joinChecks(rows, A_CHECKS_READ, NOW)],
    ["joinDeployments", (rows) => joinDeployments(rows, aDeploymentsRead({}), NOW)],
    ["joinStaging", (rows) => joinStaging(rows, { deployments: aDeploymentsRead({}), mainChecks: null }, NOW)],
    ["headsToCheck", (rows) => headsToCheck(rows)],
    ["mergesToRead", (rows) => mergesToRead(rows)],
    ["stagingMergesToRead", (rows) => stagingMergesToRead(rows)],
    ["commitsToCheck", (rows) => commitsToCheck(rows, aDeploymentsRead({}))],
    ["owedRollInsOf", (rows) => owedRollInsOf(rows)],
  ];
  const aPairingRowWhoseOwnIs = (own: unknown) => ({ ...A_CURRENT_ROW, plainPullRequest: { since: "2026-11-08T11:30:00Z", own } });

  describe.each(JOINS)("%s", (_join, join) => {
    it.each([
      ["a row kept at v3.4.1, its Standing blocked at schema 1", A_ROW_KEPT_AT_V3_4_1, "schema 1"],
      ["a row whose schema-1 Standing is of a name schema 2 left as it was", { ...A_CURRENT_ROW, standing: { ...theKept("not-started"), schema: 1 } }, "schema 1"],
      ["a Pairing session's row whose issue's own Standing is of schema 1", aPairingRowWhoseOwnIs(A_SCHEMA_1_BLOCKED), "schema 1"],
      ["a row whose Standing is of schema 3, a newer Kit's", { ...A_CURRENT_ROW, standing: { ...THAT_BLOCKED_AT_SCHEMA_2, schema: 3 } }, "schema 3"],
      ["a row at Staging whose Standing is of schema 3", { ...A_ROW_AT_STAGING, standing: { ...ON_STAGING_AT_SCHEMA_2, schema: 3 } }, "schema 3"],
      ["a row whose Standing has no schema", { ...A_CURRENT_ROW, standing: { ...THAT_BLOCKED_AT_SCHEMA_2, schema: undefined } }, "no schema"],
    ])("refuses %s, naming its schema, the Kit's and readStanding", (_what, kept, itsSchema) => {
      const joining = () => join([A_CURRENT_ROW, kept as unknown as Row]);

      expect(joining).toThrow(new RegExp(`${itsSchema} .*schema 2.*readStanding`));
      expect(joining).not.toThrow(TypeError);
    });

    it("takes rows kept at v3.4.1 once readRow has read them", () => {
      const read = [A_ROW_KEPT_AT_V3_4_1, A_PAIRING_ROW_KEPT_AT_V3_4_1].map((kept) => readRow(kept)!);

      expect(() => join(read)).not.toThrow();
    });

    it("takes a row at Staging readRow has read", () => {
      expect(() => join([readRow(JSON.parse(JSON.stringify(A_ROW_AT_STAGING)))!])).not.toThrow();
    });
  });
});

describe("a schema-1 row at Production, given to the join with Deployments", () => {
  it("is refused where the read would settle it, not settled at the current schema", () => {
    const merged = theKept("merged");
    if (merged.name !== "merged" || merged.detail.mergeCommit === null) throw new Error("expected a merge commit");
    const read = { ...aDeploymentsRead({ [merged.detail.mergeCommit]: aDeployOf({ is: "succeeded", deployment: 77, commit: merged.detail.mergeCommit, at: "2026-11-08T12:20:00Z" }) }), repo: merged.repo };
    const kept = { ...A_CURRENT_ROW, standing: { ...merged, schema: 1 } } as unknown as Row;

    expect(() => joinDeployments([kept], read, "2026-11-08T13:00:00Z")).toThrow(/schema 1.*schema 2.*readStanding/);
    expect(joinDeployments([{ ...A_CURRENT_ROW, standing: merged }], read, "2026-11-08T13:00:00Z")).toMatchObject([{ standing: { schema: 2, name: "live" } }]);
  });

  it("is refused once its 24 hours have passed, not left out", () => {
    const kept = { ...A_CURRENT_ROW, standing: { ...theKept("merged"), schema: 1 } } as unknown as Row;

    expect(() => joinDeployments([kept], aDeploymentsRead({}), "2026-11-10T00:00:00Z")).toThrow(/schema 1.*schema 2.*readStanding/);
    expect(joinDeployments([{ ...A_CURRENT_ROW, standing: theKept("merged") }], aDeploymentsRead({}), "2026-11-10T00:00:00Z")).toEqual([]);
  });
});

describe("a row at Staging of another schema, given to the join with staging", () => {
  const onStaging = ON_STAGING_AT_SCHEMA_2;
  if (onStaging.name !== "on-staging" || onStaging.detail.mergeCommit === null) throw new Error("expected a merge commit");
  const { repo, detail } = onStaging;
  const mergeCommit = onStaging.detail.mergeCommit;
  /** The staging environment's Deployments, a later deploy that contains the merge under way, and no Main checks read. */
  const read = {
    deployments: { ...aDeploymentsRead({ [mergeCommit]: aDeployOf({ is: "running", deployment: 78, commit: mergeCommit, at: "2026-11-08T12:40:00Z" }) }), repo, environment: "staging" },
    mainChecks: null,
  };
  /** That Standing with no Staging trial to wait for: it stands for 24 hours from its merge. */
  const settledADayOn = { ...ON_STAGING_AT_SCHEMA_2, detail: { ...detail, staging: { ...detail.staging, trial: { needed: false, why: "no-screen" }, standsUntil: "2026-11-09T12:00:00.000Z" } } };

  it("is refused where the read would settle it, not settled at the current schema", () => {
    const kept = { ...A_ROW_AT_STAGING, standing: { ...ON_STAGING_AT_SCHEMA_2, schema: 3 } } as unknown as Row;

    expect(() => joinStaging([kept], read, "2026-11-08T13:00:00Z")).toThrow(/schema 3.*schema 2.*readStanding/);
    expect(joinStaging([A_ROW_AT_STAGING], read, "2026-11-08T13:00:00Z")).toMatchObject([{ standing: { schema: 2, name: "deploying" } }]);
  });

  it("is refused once it no longer stands, not left out", () => {
    const kept = { ...A_ROW_AT_STAGING, standing: { ...settledADayOn, schema: 3 } } as unknown as Row;

    expect(() => joinStaging([kept], read, "2026-11-10T00:00:00Z")).toThrow(/schema 3.*schema 2.*readStanding/);
    expect(joinStaging([{ ...A_ROW_AT_STAGING, standing: settledADayOn } as Row], read, "2026-11-10T00:00:00Z")).toEqual([]);
  });

  it("is refused by what asks for its reads, not asked about", () => {
    const kept = { ...A_ROW_AT_STAGING, standing: { ...ON_STAGING_AT_SCHEMA_2, schema: 3 } } as unknown as Row;
    const deployed = { ...read.deployments, merges: { [mergeCommit]: aDeployOf({ is: "succeeded", deployment: 77, commit: mergeCommit, at: "2026-11-08T12:20:00Z" }) } };
    const namingAMainCheck = { ...A_ROW_AT_STAGING, standing: { ...ON_STAGING_AT_SCHEMA_2, detail: { ...detail, staging: { ...detail.staging, mainChecks: ["e2e"] } } } } as Row;

    expect(() => stagingMergesToRead([kept])).toThrow(/schema 3.*schema 2.*readStanding/);
    expect(() => commitsToCheck([kept], deployed)).toThrow(/schema 3.*schema 2.*readStanding/);
    expect(stagingMergesToRead([A_ROW_AT_STAGING])).toEqual([{ mergeCommit, mergedAt: detail.mergedAt }]);
    expect(commitsToCheck([namingAMainCheck], deployed)).toEqual([{ commit: mergeCommit, checks: ["e2e"] }]);
  });
});
