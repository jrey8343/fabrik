import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isUi } from "../evidence/uiEvidence.ts";
import { DEFAULT_KIT_CONFIG, type UiConfig } from "../kit/config.ts";
import { aCheckIssue, aGateRerunDone, anOpenPullRequest, aPassNaming, factsOf, standingFactsOf } from "./builders.ts";
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
    const { headsToCheck, joinChecks, joinDeployments, joinRuns, mergesToRead, owedRollInsOf, standingAt, wordStanding } = await import("./index.ts");
    const kept = A_STANDING_KEPT_AT_SCHEMA_1 as unknown as Standing;
    const rows = [A_ROW_KEPT_AT_V3_4_1 as unknown as Row];
    const refusal = /schema 1 .*schema 2.*readStanding/;

    expect(() => wordStanding(kept, NOW, "UTC")).toThrow(refusal);
    expect(() => standingAt(kept, NOW)).toThrow(refusal);
    expect(() => joinRuns(rows, { repo: "acme/shop", readAt: NOW, runs: [], tick: { lastStartedAt: NOW } }, NOW)).toThrow(refusal);
    expect(() => joinChecks(rows, { repo: "acme/shop", branch: "main", readAt: NOW, required: [], holdsAdmins: "yes", heads: {} }, NOW)).toThrow(refusal);
    expect(() => joinDeployments(rows, { repo: "acme/shop", environment: "production", readAt: NOW, merges: {} }, NOW)).toThrow(refusal);
    expect(() => headsToCheck(rows)).toThrow(refusal);
    expect(() => mergesToRead(rows)).toThrow(refusal);
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
