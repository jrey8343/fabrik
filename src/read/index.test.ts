import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isUi } from "../evidence/uiEvidence.ts";
import { DEFAULT_KIT_CONFIG, type UiConfig } from "../kit/config.ts";
import { aCheckIssue, aGateRerunDone, anOpenPullRequest, aPassNaming, factsOf, standingFactsOf } from "./builders.ts";
import { A_BLOCKED_ISSUE, EXPORT_CALLS, EXPORT_SHAPES, NOT_DATA } from "./exports.fixture.ts";

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
      staging: { environment: "staging", production: "production", trial: { needed: true, why: "ui-evidence" }, result: null, standsUntil: "2026-11-10T11:30:00.000Z", mainChecks: ["e2e"], check: null, checksUnread: false },
    });
    expect(rows[0]?.staging).toEqual({
      site: "https://staging.shop.example",
      pages: [
        { route: "/book", url: "https://staging.shop.example/book" },
        { route: "/patients/[patientId]/notes", url: "https://staging.shop.example" },
      ],
      shots: [],
      toTry: ["/book", "/patients/[patientId]/notes"],
    });
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
