import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isUi } from "../evidence/uiEvidence.ts";
import { DEFAULT_KIT_CONFIG, type UiConfig } from "../kit/config.ts";
import { aCheckIssue, aGateRerunDone, aLabelAdded, aMergedLastDay, anOpenPullRequest, aPassNaming, aStagingFacts, factsOf, homeFactsOf, standingFactsOf } from "./builders.ts";
import { A_BLOCKED_ISSUE, A_ROW_KEPT_AT_V3_4_1, A_STANDING_KEPT_AT_SCHEMA_1, EXPORT_CALLS, EXPORT_SHAPES, NOT_DATA } from "./exports.fixture.ts";
import type { Row, Standing } from "./index.ts";

const ENTRY = new URL("./index.ts", import.meta.url);

/** The entry's text, comments taken out. */
function entryStatements(): string {
  return readFileSync(ENTRY, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .trim();
}

/** The names of the types the entry exports, read from its `export type { … } from` lines. */
function exportedTypeNames(): string[] {
  return [...entryStatements().matchAll(/export\s+type\s*\{([^}]*)\}\s*from/g)].flatMap((match) =>
    (match[1] ?? "")
      .split(",")
      .map((name) => name.trim().split(/\s+as\s+/).at(-1) ?? "")
      .filter((name) => name !== ""),
  );
}

/** The names of the values the entry exports, as a program importing it sees them. */
async function exportedValueNames(): Promise<string[]> {
  return Object.keys(await import("./index.ts"));
}

describe("the read library's entry", () => {
  it("holds nothing but re-exports of other modules", () => {
    const statements = entryStatements()
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement !== "");

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) expect(statement).toMatch(/^export\s+(type\s+)?\{[^}]*\}\s*from\s*"\.\.?\/[^"]+"$/);
  });

  it("exports every value the interface fixture holds a call for, and no other", async () => {
    expect((await exportedValueNames()).toSorted()).toEqual(Object.keys(EXPORT_CALLS).toSorted());
  });

  it("exports every type the interface fixture holds a value of, and no other", () => {
    expect(exportedTypeNames().toSorted()).toEqual(Object.keys(EXPORT_SHAPES).toSorted());
  });
});

describe("the read library's Standing", () => {
  it("is at schema 2, whose blocked Standing names each blocker by its repo and counts the hidden ones (#771)", async () => {
    const { STANDING_SCHEMA, wordStanding } = await import("./index.ts");
    const standings = (await EXPORT_CALLS["standingsOf"]!()) as Awaited<ReturnType<(typeof import("./index.ts"))["standingsOf"]>>;
    const blocked = standings.find(({ issue }) => issue === A_BLOCKED_ISSUE.number);

    expect(STANDING_SCHEMA).toBe(2);
    expect(blocked).toMatchObject({ schema: 2, name: "blocked", detail: { blockers: [{ repo: "a/b", number: 3 }], hiddenBlockers: 1 } });
    expect(wordStanding(blocked!, "2026-11-09T00:00:00Z", "UTC").sentence).toBe("Blocked by a/b#3 and 1 issue the Fabrik App can't read.");
  });

  it("names an Unrelated failure the Kit is healing at the Merge gate check-healing, the Kit's, with its own detail, and Stuck past its bar (#795)", async () => {
    const { STANDING_NAMES, STANDING_SCHEMA, standingAt, standingsOf, wordStanding } = await import("./index.ts");
    const head = "h".repeat(40);
    const passed = "2026-11-08T18:00:00Z";
    const healing = [{ check: "test", rerun: "done", issue: 91, stuckAt: "2026-11-08T22:30:00.000Z" }];
    const facts = standingFactsOf({
      github: factsOf({
        openIssues: [aCheckIssue("test")],
        openPullRequests: [anOpenPullRequest({ draft: false, headSha: head, comments: [aPassNaming(["test"], head, passed), aGateRerunDone(["test"], head, "2026-11-08T19:00:00Z")] })],
      }),
      kit: { repo: "owner/product", branch: "main", config: { ok: true, config: DEFAULT_KIT_CONFIG }, dispatch: null, runsInFlight: [], headChecks: { [head]: [{ name: "test", is: "failing", at: "2026-11-08T17:50:00Z" }] } },
    });

    const held = standingsOf(facts, "2026-11-08T20:00:00Z").find(({ pullRequest }) => pullRequest === 50);

    // No field was removed or changed meaning, so the schema stays where it was.
    expect(STANDING_SCHEMA).toBe(2);
    expect(STANDING_NAMES).toContain("check-healing");
    expect(held).toMatchObject({ schema: 2, name: "check-healing", place: "merge-gate", move: "kit", yours: false, stopsWork: false, since: "2026-11-08T17:50:00Z", stuckAt: "2026-11-08T22:30:00.000Z" });
    expect(held?.detail).toEqual({ plain: null, check: "test", rerun: "done", issue: 91, passedAt: passed, passedHead: head, healing, head });
    expect(wordStanding(held!, "2026-11-08T20:00:00Z", "UTC")).toEqual({
      pill: "Healing",
      sentence:
        "`test` is failing on the head the Reviewer passed 2 hours ago. The Reviewer judged it an Unrelated failure, and the Kit's one more re-run of it is done or skipped, so #50 waits for the check's fix on #91.",
      remedy: null,
    });
    expect(standingAt(held!, "2026-11-08T22:31:00Z")).toMatchObject({ name: "stuck", move: "kit", yours: true, stopsWork: true, detail: { was: "check-healing", check: "test", healing } });
  });
});

describe("the read library's Standing at Staging (#855)", () => {
  it("names a merged agent pull request on staging on-staging, at the place staging, the Operator's without stopping work, with its staging pages and what to try on its row", async () => {
    const { STANDING_NAMES, STANDING_SCHEMA, wordStanding } = await import("./index.ts");
    const rows = (await EXPORT_CALLS["joinStaging"]!()) as Awaited<ReturnType<(typeof import("./index.ts"))["joinStaging"]>>;

    // A new place and a new name remove nothing and change no meaning, so the schema stays where it was.
    expect(STANDING_SCHEMA).toBe(2);
    expect(STANDING_NAMES).toContain("on-staging");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.standing).toMatchObject({ schema: 2, issue: 7, pullRequest: 50, place: "staging", name: "on-staging", move: "operator", yours: true, stopsWork: false, since: "2026-11-09T11:36:00Z", stuckAt: null });
    expect(rows[0]?.standing.detail).toEqual({
      mergeCommit: "m".repeat(40),
      mergedAt: "2026-11-09T11:30:00Z",
      environment: "staging",
      noDeployAt: null,
      deployment: 905,
      log: null,
      deploysUnread: false,
      staging: { environment: "staging", productionEnvironment: "production", trial: { needed: true, why: "ui-evidence" }, result: null, standsUntil: "2026-11-10T11:30:00.000Z", mainChecks: ["e2e"], check: null, checksUnread: false },
    });
    expect(rows[0]?.staging).toMatchObject({
      site: "https://staging.shop.example",
      pages: [
        { route: "/book", url: "https://staging.shop.example/book" },
        { route: "/patients/[patientId]/notes", url: "https://staging.shop.example" },
      ],
      shots: [],
      toTry: ["/book", "/patients/[patientId]/notes"],
    });
    expect(Object.keys(rows[0]?.staging ?? {}).toSorted()).toEqual(["pages", "shots", "site", "toTry", "trial"]);
    expect(wordStanding(rows[0]!.standing, "2026-11-09T12:36:00Z", "UTC")).toEqual({
      pill: "On staging",
      sentence: "On `staging` since 1 hour ago. It carries UI evidence, so it needs a Staging trial.",
      remedy: null,
    });
  });

  it("asks a staging Deployments read about that merge, and a Main checks read about the commit its newest staging deploy deployed", async () => {
    expect(await EXPORT_CALLS["stagingMergesToRead"]!()).toEqual([{ mergeCommit: "m".repeat(40), mergedAt: "2026-11-09T11:30:00Z" }]);
    expect(await EXPORT_CALLS["commitsToCheck"]!()).toEqual([{ commit: "d".repeat(40), checks: ["e2e"] }]);
    expect(await EXPORT_CALLS["readMainChecks"]!()).toEqual({ repo: "owner/product", readAt: "2026-11-09T12:00:00Z", commits: { ["d".repeat(40)]: "unread" } });
  });
});

describe("the read library's Staging trial (#856)", () => {
  it("gives a reader the two label names and the Trial problem's line, its writer and its reader, so a reader holds no format", async () => {
    const { TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL, trialProblemIn, trialProblemLine } = await import("./index.ts");

    expect([TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL]).toEqual(["fabrik:trial-accepted", "fabrik:trial-problem"]);
    expect(await EXPORT_CALLS["trialProblemLine"]!()).toBe("From Staging trial of PR #50");
    expect(await EXPORT_CALLS["trialProblemIn"]!()).toBe(50);
    expect(trialProblemIn(`It broke.\n\n${trialProblemLine(812)}`)).toBe(812);
    expect(trialProblemIn("It broke after #812.")).toBeNull();
  });

  it("names a merged agent pull request by the Operator's own label, trial-problem then trial-accepted through its fix, nobody's move, in rows from facts a gather of a repo that declares staging gives", async () => {
    const { rowsOf, STANDING_NAMES, STANDING_SCHEMA, TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL, wordStanding } = await import("./index.ts");
    const kit = { ...homeFactsOf().kit, config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, staging: { url: "https://staging.shop.example", environment: "staging" } } } } as const;
    const facts = (fixLabels: readonly ReturnType<typeof aLabelAdded>[]) =>
      homeFactsOf({
        kit,
        staging: aStagingFacts({
          since: { from: "staging", deployment: 600, commit: "s".repeat(40), cutAt: "2026-11-01T09:00:00Z", deployedAt: "2026-11-01T09:10:00Z" },
          unpromoted: [aMergedLastDay("2026-11-05T10:00:00Z")],
          mergedSince: 1,
          trials: {
            pullRequests: [
              { pullRequest: 50, labelEvents: [aLabelAdded(TRIAL_PROBLEM_LABEL, "2026-11-09T08:00:00Z", { actor: "operator" })], closes: [7] },
              { pullRequest: 61, labelEvents: fixLabels, closes: [70] },
            ],
            problems: [{ issue: 70, pullRequest: 50, title: "The cart total reads 0", open: false, closedAs: "completed" }],
          },
        }),
      });

    const [found] = rowsOf(facts([]), null, null, null, "2026-11-09T12:00:00Z");
    const [accepted] = rowsOf(facts([aLabelAdded(TRIAL_ACCEPTED_LABEL, "2026-11-09T11:00:00Z", { actor: "operator" })]), null, null, null, "2026-11-09T12:00:00Z");

    // Two new names remove nothing and change no meaning, so the schema stays where it was.
    expect(STANDING_SCHEMA).toBe(2);
    expect(STANDING_NAMES).toEqual(expect.arrayContaining(["trial-accepted", "trial-problem"]));
    expect(found?.standing).toMatchObject({ schema: 2, pullRequest: 50, place: "staging", name: "trial-problem", move: "nobody", yours: false, stopsWork: false, since: "2026-11-09T08:00:00Z" });
    expect(found?.standing.detail).toMatchObject({ staging: { result: { is: "problem", at: "2026-11-09T08:00:00Z", problems: [{ issue: 70, open: false }] }, standsUntil: "2026-11-10T08:00:00.000Z" } });
    expect(wordStanding(found!.standing, "2026-11-09T12:00:00Z", "UTC")).toEqual({ pill: "Problem found", sentence: "Its Staging trial found a problem 4 hours ago: #70 (closed).", remedy: null });
    expect(accepted?.standing).toMatchObject({ place: "staging", name: "trial-accepted", move: "nobody", yours: false, since: "2026-11-09T11:00:00Z" });
    expect(accepted?.standing.detail).toMatchObject({ staging: { result: { is: "accepted", at: "2026-11-09T11:00:00Z", fix: [61] }, standsUntil: "2026-11-10T11:00:00.000Z" } });
    expect(wordStanding(accepted!.standing, "2026-11-09T12:00:00Z", "UTC")).toEqual({ pill: "Accepted", sentence: "Accepted through its fix, #61, 1 hour ago.", remedy: null });
  });
});

describe("the read library's Trial steps (#965)", () => {
  const STEPS = {
    summary: "A patient can now book a visit and see it on their notes.",
    steps: [
      { route: "/book", do: "Pick tomorrow, then any free time.", expect: "A page saying the visit is booked, with its time." },
      { do: "Open any patient from the list, then their notes.", expect: "The visit under Upcoming." },
    ],
  };

  it("gives a reader the marker's writer and its reader, so a reader holds no format: what one writes the other reads, the last in a body counting", async () => {
    const { trialStepsIn, trialStepsMarker } = await import("./index.ts");
    const written = (await EXPORT_CALLS["trialStepsMarker"]!()) as string;
    const later = { summary: "A patient can now book a visit.", steps: [{ do: "Pick any day.", expect: "Its free times." }] };

    expect(written).toMatch(/^<!-- fabrik:trial-steps \{.*\} -->$/);
    expect(trialStepsIn(`It builds the booking page.\n\n${written}`)).toEqual(STEPS);
    expect(await EXPORT_CALLS["trialStepsIn"]!()).toEqual(STEPS);
    expect(trialStepsIn(["It builds the booking page.", written, trialStepsMarker(later)].join("\n"))).toEqual(later);
    expect(trialStepsIn("It builds the booking page.")).toBeNull();
  });

  it("gives a merged agent pull request's row its Trial steps under staging, each step with its page on staging or none, and its Promote list entry the same; the Standing's schema stays where it was", async () => {
    const { STANDING_SCHEMA } = await import("./index.ts");
    const rows = (await EXPORT_CALLS["joinStaging"]!()) as ReturnType<(typeof import("./index.ts"))["joinStaging"]>;
    const list = (await EXPORT_CALLS["promoteListOf"]!()) as ReturnType<(typeof import("./index.ts"))["promoteListOf"]>;
    const [entry, plain] = list?.entries ?? [];

    expect(STANDING_SCHEMA).toBe(2);
    expect(rows[0]?.staging?.trial).toEqual({
      summary: "A patient can now book a visit and see it on their notes.",
      steps: [
        { do: "Pick tomorrow, then any free time.", expect: "A page saying the visit is booked, with its time.", route: "/book", url: "https://staging.shop.example/book" },
        { do: "Open any patient from the list, then their notes.", expect: "The visit under Upcoming.", route: null, url: null },
      ],
    });
    expect(entry?.is === "agent" ? entry.staging.trial : undefined).toEqual(rows[0]?.staging?.trial);
    expect(plain).toMatchObject({ is: "plain" });
    expect(plain).not.toHaveProperty("staging");
    expect(plain).not.toHaveProperty("trial");
  });

  it("reads a row kept at Staging before this, with no Trial steps on it, as one whose pull request keeps none", async () => {
    const { readRow } = await import("./index.ts");
    const [row] = (await EXPORT_CALLS["joinStaging"]!()) as ReturnType<(typeof import("./index.ts"))["joinStaging"]>;
    const { trial: _, ...keptStaging } = row!.staging!;

    expect(readRow(JSON.parse(JSON.stringify({ ...row, staging: keptStaging })))).toEqual({ ...row, staging: { ...keptStaging, trial: null } });
  });
});

describe("the read library's Promote list (#857)", () => {
  const STAGED ={ ...homeFactsOf().kit, config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, production: { url: "https://shop.example", environment: "production" }, staging: { url: "https://staging.shop.example", environment: "staging" } } } } as const;

  it("says what a production deployment would take, from a gather's facts and a staging read: its start, each agent pull request with the result its row's Standing at Staging has, each Plain one with its kind, the count not yet accepted, and the dispatch page", async () => {
    const list = (await EXPORT_CALLS["promoteListOf"]!()) as ReturnType<(typeof import("./index.ts"))["promoteListOf"]>;
    const rows = (await EXPORT_CALLS["joinStaging"]!()) as ReturnType<(typeof import("./index.ts"))["joinStaging"]>;

    expect(list).toEqual(EXPORT_SHAPES["PromoteList"]);
    expect(list).toMatchObject({
      repo: "owner/product",
      start: { from: "production", deployment: 880, commit: "p".repeat(40), deployedAt: "2026-11-08T09:15:00Z" },
      notAccepted: 1,
      leftOut: 0,
      dispatchPage: "https://github.com/owner/product/actions/workflows/deploy-production.yml",
    });
    expect(list?.entries).toMatchObject([
      { is: "agent", pullRequest: 50, title: "Build the thing", ticket: 7, mergedAt: "2026-11-09T11:30:00Z", trial: { needed: true, why: "ui-evidence" }, result: { is: "untried" } },
      { is: "plain", pullRequest: 51, kind: "kit-bump" },
    ]);
    // Pull request 50's row, for the same merge and the same staging read: on staging, the Operator's, with no result, and the same staging pages.
    expect(rows[0]?.standing).toMatchObject({ pullRequest: 50, place: "staging", name: "on-staging", move: "operator", detail: { staging: { trial: { needed: true, why: "ui-evidence" }, result: null } } });
    expect(list?.entries[0]).toMatchObject({ staging: rows[0]?.staging, evidence: rows[0]?.evidence });
    expect(Object.keys(list?.entries[1] ?? {}).toSorted()).toEqual(["is", "kind", "mergedAt", "pullRequest", "title"]);
  });

  it("is null for a repo that declares no staging, whose rows are what they were", async () => {
    const { promoteListOf, rowsOf } = await import("./index.ts");
    const facts = homeFactsOf({ kit: { ...STAGED, config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, production: { url: "https://shop.example", environment: "production" } } } }, mergedLastDay: [aMergedLastDay("2026-11-09T11:30:00Z")] });

    expect(promoteListOf(facts, null, "2026-11-09T12:00:00Z")).toBeNull();
    expect(rowsOf(facts, null, null, null, "2026-11-09T12:00:00Z").map(({ standing }) => [standing.place, standing.name])).toEqual([["production", "merged"]]);
  });

  it("keeps a pull request Live for 24 hours from the production Deployment that took it in a repo that declares staging, and for 24 hours from its merge in one that declares none", async () => {
    const { aDeploymentsRead, aDeployOf, rowsOf } = await import("./index.ts");
    const merge = aMergedLastDay("2026-11-04T11:00:00Z");
    const by = { deployment: 880, commit: "p".repeat(40), at: "2026-11-09T11:00:00Z" };
    const staged = homeFactsOf({
      kit: STAGED,
      staging: aStagingFacts({ since: { from: "production", ...by, cutAt: "2026-11-09T10:30:00Z", deployedAt: by.at }, promoted: [{ ...merge, by }] }),
    });
    const names = (facts: ReturnType<typeof homeFactsOf>, deployments: Parameters<typeof rowsOf>[3], now: string) => rowsOf(facts, null, null, deployments, now).map(({ standing }) => [standing.place, standing.name, standing.since]);

    // Merged five days before the Deployment that took it: Live an hour after that Deployment, and with no row 25 hours after it.
    expect(names(staged, null, "2026-11-09T12:00:00Z")).toEqual([["production", "live", "2026-11-09T11:00:00Z"]]);
    expect(names(staged, null, "2026-11-10T11:00:00Z")).toEqual([["production", "live", "2026-11-09T11:00:00Z"]]);
    expect(names(staged, null, "2026-11-10T12:00:00Z")).toEqual([]);
    // With no staging block, Live lasts 24 hours from the merge, as it did.
    const lastDay = aMergedLastDay("2026-11-09T09:00:00Z");
    const unstaged = homeFactsOf({ kit: { ...STAGED, config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, production: { url: "https://shop.example", environment: "production" } } } }, mergedLastDay: [lastDay] });
    const live = aDeploymentsRead({ ["m".repeat(40)]: aDeployOf({ is: "succeeded", deployment: 881, commit: "m".repeat(40), at: "2026-11-09T11:00:00Z" }) }, "2026-11-09T12:00:00Z");
    expect(names(unstaged, live, "2026-11-10T09:00:00Z")).toEqual([["production", "live", "2026-11-09T11:00:00Z"]]);
    expect(names(unstaged, live, "2026-11-10T09:01:00Z")).toEqual([]);
  });
});

describe("the read library's kept Standings and rows (#793)", () => {
  const NOW = "2026-11-09T00:00:00Z";

  it("reads a Standing and a row kept at v3.4.1 at the current schema, which then word and join as any other", async () => {
    const { joinRuns, readRow, readStanding, wordStanding } = await import("./index.ts");
    const blockers = [
      { repo: "acme/shop", number: 7 },
      { repo: "acme/shop", number: 9 },
    ];

    const standing = readStanding(A_STANDING_KEPT_AT_SCHEMA_1);
    const row = readRow(A_ROW_KEPT_AT_V3_4_1);

    expect(standing).toEqual({ ...A_STANDING_KEPT_AT_SCHEMA_1, schema: 2, detail: { blockers, hiddenBlockers: 0 } });
    expect(wordStanding(standing!, NOW, "UTC").sentence).toBe("Blocked by #7 and #9.");
    expect(row).toEqual({ ...A_ROW_KEPT_AT_V3_4_1, standing, shots: null });
    expect(joinRuns([row!], { repo: "acme/shop", readAt: NOW, runs: [], tick: { lastStartedAt: NOW } }, NOW)).toEqual([row]);
  });

  it("tells a newer Kit's Standing apart, which reads as null", async () => {
    const { newerStandingSchemaOf, readRow, readStanding } = await import("./index.ts");
    const newer = { ...A_STANDING_KEPT_AT_SCHEMA_1, schema: 3 };

    expect(readStanding(newer)).toBeNull();
    expect(readRow({ ...A_ROW_KEPT_AT_V3_4_1, standing: newer })).toBeNull();
    expect(newerStandingSchemaOf(newer)).toBe(3);
    expect(newerStandingSchemaOf(A_STANDING_KEPT_AT_SCHEMA_1)).toBeNull();
  });

  it("refuses a kept Standing, or a row holding one, that didn't come back through them, naming both schemas and readStanding", async () => {
    const { commitsToCheck, headsToCheck, joinChecks, joinDeployments, joinRuns, joinStaging, mergesToRead, owedRollInsOf, stagingMergesToRead, standingAt, wordStanding } = await import("./index.ts");
    const kept = A_STANDING_KEPT_AT_SCHEMA_1 as unknown as Standing;
    const rows = [A_ROW_KEPT_AT_V3_4_1 as unknown as Row];
    const refusal = /schema 1 .*schema 2.*readStanding/;

    expect(() => wordStanding(kept, NOW, "UTC")).toThrow(refusal);
    expect(() => standingAt(kept, NOW)).toThrow(refusal);
    expect(() => joinRuns(rows, { repo: "acme/shop", readAt: NOW, runs: [], tick: { lastStartedAt: NOW } }, NOW)).toThrow(refusal);
    expect(() => joinChecks(rows, { repo: "acme/shop", branch: "main", readAt: NOW, required: [], holdsAdmins: "yes", heads: {} }, NOW)).toThrow(refusal);
    expect(() => joinDeployments(rows, { repo: "acme/shop", environment: "production", readAt: NOW, merges: {} }, NOW)).toThrow(refusal);
    expect(() => joinStaging(rows, { deployments: { repo: "acme/shop", environment: "staging", readAt: NOW, merges: {} }, mainChecks: null }, NOW)).toThrow(refusal);
    expect(() => headsToCheck(rows)).toThrow(refusal);
    expect(() => mergesToRead(rows)).toThrow(refusal);
    expect(() => stagingMergesToRead(rows)).toThrow(refusal);
    expect(() => commitsToCheck(rows, { repo: "acme/shop", environment: "staging", readAt: NOW, merges: {} })).toThrow(refusal);
    expect(() => owedRollInsOf(rows)).toThrow(refusal);
  });
});

/** A value as a reader gets it back after writing it as JSON and reading it again. */
function roundTripped(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe("the read library's values", () => {
  it.each(Object.entries(EXPORT_SHAPES).filter(([name]) => !NOT_DATA.includes(name)))(
    "a value of %s comes back equal after being written as JSON and read again",
    (_name, value) => {
      expect(roundTripped(value)).toStrictEqual(value);
    },
  );

  it.each(Object.entries(EXPORT_CALLS).filter(([name]) => !NOT_DATA.includes(name)))(
    "what the call of %s returns comes back equal after being written as JSON and read again",
    async (_name, call) => {
      const value = await call();

      expect(roundTripped(value)).toStrictEqual(value);
    },
  );
});

describe("the read library in a Worker", () => {
  const WORKER_REFUSAL = "path.posix.matchesGlob is not implemented in the Workers runtime";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Node's path globs made to throw, as the Workers runtime does. */
  function asInAWorker(): void {
    vi.spyOn(path.posix, "matchesGlob").mockImplementation(() => {
      throw new Error(WORKER_REFUSAL);
    });
  }

  it("throws where the Kit matches a path glob, so the trap is set where the Kit would fall in", () => {
    asInAWorker();
    const ui: UiConfig = { paths: ["src/pages/**"], serve: "npm run dev", url: "http://127.0.0.1:4321", beforeUrl: null, defaultRoutes: ["/"] };

    expect(() => isUi(["src/pages/book.astro"], ui)).toThrow(WORKER_REFUSAL);
  });

  it.each(Object.entries(EXPORT_CALLS))("the call of %s returns without matching a path glob", async (_name, call) => {
    asInAWorker();

    const outcome = await Promise.resolve()
      .then(call)
      .then(
        () => "returned",
        (error: unknown) => error,
      );

    expect(outcome).toBe("returned");
  });
});
