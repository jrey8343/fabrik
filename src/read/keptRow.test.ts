import { describe, expect, it } from "vitest";
import { A_SCHEMA_1_BLOCKED, THAT_BLOCKED_AT_SCHEMA_2, THE_SAME_AT_SCHEMAS_1_AND_2 } from "../kit/keptStandings.fixture.ts";
import { aDeploymentsRead, aDeployOf, aRunsRead } from "./builders.ts";
import { joinChecks } from "./joinChecks.ts";
import { joinDeployments } from "./joinDeployments.ts";
import { joinRuns } from "./joinRuns.ts";
import { readRow } from "./keptRow.ts";
import type { RequiredChecksRead } from "./requiredChecks.ts";
import type { Row } from "./rows.ts";

/** A Standing of the kept Standings, by its name. */
const theKept = (name: string) => THE_SAME_AT_SCHEMAS_1_AND_2.find((standing) => standing.name === name)!;

/** What a row kept at v3.4.1 holds beside its Standing and its `plainPullRequest`: every field a row had then, so no `shots`. */
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

/** A row of this release: its Standing at the current schema, and `shots` on it. */
const A_CURRENT_ROW: Row = { standing: THAT_BLOCKED_AT_SCHEMA_2, plainPullRequest: null, ...KEPT_BESIDE, shots: null };

describe("a kept row read back", () => {
  it("kept at v3.4.1, has its Standing at the current schema and no Evidence shots, with every other field as kept", () => {
    expect(readRow(JSON.parse(JSON.stringify(A_ROW_KEPT_AT_V3_4_1)))).toEqual({ standing: THAT_BLOCKED_AT_SCHEMA_2, plainPullRequest: null, ...KEPT_BESIDE, shots: null });
  });

  it("a Pairing session's, kept at v3.4.1, has the issue's own Standing at the current schema too", () => {
    expect(readRow(JSON.parse(JSON.stringify(A_PAIRING_ROW_KEPT_AT_V3_4_1)))).toEqual({
      standing: { ...A_PAIRING_ROW_KEPT_AT_V3_4_1.standing, schema: 2 },
      plainPullRequest: { since: "2026-11-08T11:30:00Z", own: THAT_BLOCKED_AT_SCHEMA_2 },
      ...KEPT_BESIDE,
      shots: null,
    });
  });

  it("a Plain pull request's, kept at v3.4.1 with no issue's own Standing, keeps its `plainPullRequest` as it was", () => {
    const plainPullRequest = { since: "2026-11-08T11:30:00Z", own: null };
    const kept = { ...A_ROW_KEPT_AT_V3_4_1, standing: { ...theKept("check-failing"), schema: 1 }, plainPullRequest };

    expect(readRow(kept)).toEqual({ ...kept, standing: theKept("check-failing"), shots: null });
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

  it.each([
    ["a row whose Standing is of schema 3, a newer Kit's", { ...A_CURRENT_ROW, standing: { ...THAT_BLOCKED_AT_SCHEMA_2, schema: 3 } }],
    ["a Pairing session's row whose issue's own Standing is of schema 3", { ...A_CURRENT_ROW, plainPullRequest: { since: "2026-11-08T11:30:00Z", own: { ...THAT_BLOCKED_AT_SCHEMA_2, schema: 3 } } }],
    ["a row whose Standing has no schema", { ...A_CURRENT_ROW, standing: { ...THAT_BLOCKED_AT_SCHEMA_2, schema: undefined } }],
    ["a row with no Standing", { ...KEPT_BESIDE, plainPullRequest: null }],
    ["a string", "a row"],
    ["null", null],
    ["nothing", undefined],
  ])("%s reads as null", (_what, kept) => {
    expect(readRow(kept)).toBeNull();
  });
});

describe("kept rows holding a Standing of another schema, given to a join", () => {
  const NOW = "2026-11-08T20:00:00Z";
  const A_CHECKS_READ: RequiredChecksRead = { repo: "acme/shop", branch: "main", readAt: NOW, required: ["test"], holdsAdmins: "yes", heads: {} };
  const JOINS: readonly (readonly [string, (rows: readonly Row[]) => Row[]])[] = [
    ["joinRuns", (rows) => joinRuns(rows, aRunsRead([]), NOW)],
    ["joinChecks", (rows) => joinChecks(rows, A_CHECKS_READ, NOW)],
    ["joinDeployments", (rows) => joinDeployments(rows, aDeploymentsRead({}), NOW)],
  ];
  const aPairingRowWhoseOwnIs = (own: unknown) => ({ ...A_CURRENT_ROW, plainPullRequest: { since: "2026-11-08T11:30:00Z", own } });

  describe.each(JOINS)("%s", (_join, join) => {
    it.each([
      ["a row kept at v3.4.1, its Standing blocked at schema 1", A_ROW_KEPT_AT_V3_4_1, "schema 1"],
      ["a row whose schema-1 Standing is of a name schema 2 left as it was", { ...A_CURRENT_ROW, standing: { ...theKept("not-started"), schema: 1 } }, "schema 1"],
      ["a Pairing session's row whose issue's own Standing is of schema 1", aPairingRowWhoseOwnIs(A_SCHEMA_1_BLOCKED), "schema 1"],
      ["a row whose Standing is of schema 3, a newer Kit's", { ...A_CURRENT_ROW, standing: { ...THAT_BLOCKED_AT_SCHEMA_2, schema: 3 } }, "schema 3"],
      ["a row whose Standing has no schema", { ...A_CURRENT_ROW, standing: { ...THAT_BLOCKED_AT_SCHEMA_2, schema: undefined } }, "no schema"],
    ])("refuses %s, naming its schema, the Kit's and readStanding", (_what, kept, itsSchema) => {
      const joining = () => join([A_CURRENT_ROW, kept as unknown as Row]);

      expect(joining).toThrow(new RegExp(`${itsSchema} .*schema 2.*readStanding`));
      expect(joining).not.toThrow(TypeError);
    });

    it("joins rows kept at v3.4.1 once readRow has read them", () => {
      const read = [A_ROW_KEPT_AT_V3_4_1, A_PAIRING_ROW_KEPT_AT_V3_4_1].map((kept) => readRow(kept)!);

      expect(join(read).map(({ standing }) => standing.schema)).toEqual([2, 2]);
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
