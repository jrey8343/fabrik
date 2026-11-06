import { describe, expect, it } from "vitest";
import { aRunRecord, aScoreEntry, aScoreFile } from "../__fixtures__/weeklySummary.ts";
import { DEFAULT_KIT_CONFIG, type KitConfig } from "./config.ts";
import {
  hiddenTests,
  type MergedFile,
  nextReplayStep,
  pickReplayTickets,
  readReplayRequest,
  type ReplayAcceptance,
  replayArms,
  type ReplayGates,
  type ReplayHiddenTests,
  type ReplayOutcomes,
  type ReplayCandidate,
  type ReplayIssue,
  replayMarksIn,
  replayReads,
  replayResultsIn,
  type ReplayStep,
  type ReplayTick,
  type ReplayTicketEnd,
  type ReplayVariable,
  replayThisUrl,
  withReplayResults,
  withTicketFinished,
  withTicketStarted,
} from "./replay.ts";
import type { ReplayArm, ReplayRun, RunRecord } from "./runRecord.ts";

/** A Fabrik commit with a prompt change to try. */
const CANDIDATE = "0123456789abcdef0123456789abcdef01234567";

/** A replay issue's body: a line of the Operator's own, then the request block holding `lines`. */
function bodyWith(...lines: string[]): string {
  return ["Does Review hold up at a higher effort?", "", "```replay", ...lines, "```", ""].join("\n");
}

describe("Reading a replay request", () => {
  it.each([
    ["implement.model: claude-opus-5-5", { kind: "model", role: "implement", model: "claude-opus-5-5" }],
    ["implement.effort: max", { kind: "effort", role: "implement", effort: "max" }],
    ["review.model: claude-sonnet-5-5", { kind: "model", role: "review", model: "claude-sonnet-5-5" }],
    ["review.effort: low", { kind: "effort", role: "review", effort: "low" }],
    [`kit: ${CANDIDATE}`, { kind: "kit", sha: CANDIDATE }],
  ])("reads %j as its variable, with the default pick of Tickets", (line, variable) => {
    expect(readReplayRequest(bodyWith(line))).toEqual({ ok: true, request: { variable, tickets: null } });
  });

  it("reads the Tickets the Operator listed, in their order, with or without a #", () => {
    expect(readReplayRequest(bodyWith("tickets: #41, 12 #7", "review.effort: high"))).toEqual({
      ok: true,
      request: { variable: { kind: "effort", role: "review", effort: "high" }, tickets: [41, 12, 7] },
    });
  });

  describe("finds the request in the body's one replay block", () => {
    it("refuses a body with no replay block", () => {
      expect(readReplayRequest("Try Review at a higher effort.\n\n```\nreview.effort: high\n```\n")).toEqual({
        ok: false,
        errors: ["the body has no ```replay block: put the request in one, naming one variable, such as review.effort: high"],
      });
    });

    it("refuses a body with two, since which one is the request is unclear", () => {
      expect(readReplayRequest(`${bodyWith("review.effort: high")}\n${bodyWith("review.effort: low")}`)).toEqual({
        ok: false,
        errors: ["the body has 2 ```replay blocks, but a request is one"],
      });
    });

    it("refuses a block that's never closed", () => {
      expect(readReplayRequest("```replay\nreview.effort: high\n")).toEqual({
        ok: false,
        errors: ["the ```replay block is never closed with ```"],
      });
    });

    it("reads a body GitHub saved with Windows line endings", () => {
      expect(readReplayRequest(bodyWith("tickets: 3, 4", "review.effort: high").replaceAll("\n", "\r\n"))).toEqual({
        ok: true,
        request: { variable: { kind: "effort", role: "review", effort: "high" }, tickets: [3, 4] },
      });
    });

    it("skips blank lines in the block", () => {
      expect(readReplayRequest(bodyWith("", "review.effort: high", "  "))).toEqual({
        ok: true,
        request: { variable: { kind: "effort", role: "review", effort: "high" }, tickets: null },
      });
    });
  });

  describe("takes up to 10 listed Tickets", () => {
    const listing = (count: number) => `tickets: ${Array.from({ length: count }, (_, i) => `#${101 + i}`).join(", ")}`;

    it("takes 10", () => {
      const read = readReplayRequest(bodyWith("kit: " + CANDIDATE, listing(10)));

      expect(read.ok && read.request.tickets).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
    });

    it("refuses 11", () => {
      expect(readReplayRequest(bodyWith("kit: " + CANDIDATE, listing(11)))).toEqual({
        ok: false,
        errors: ["tickets lists 11 Tickets, but a replay takes at most 10"],
      });
    });

    it.each([
      ["something that isn't a Ticket number", "tickets: 12, twelve", `tickets lists "twelve", which isn't a Ticket number`],
      ["a zero", "tickets: #0", `tickets lists "#0", which isn't a Ticket number`],
      ["a Ticket twice", "tickets: 12, 15, #12", "tickets lists #12 twice"],
    ])("refuses a list with %s", (_, line, error) => {
      expect(readReplayRequest(bodyWith("review.effort: high", line))).toEqual({ ok: false, errors: [error] });
    });
  });

  it.each([
    ["the variable", "review.effort: low", "review.effort is given twice"],
    ["the Tickets", "tickets: 5", "tickets is given twice"],
  ])("refuses %s given twice", (_, line, error) => {
    expect(readReplayRequest(bodyWith("review.effort: high", "tickets: 4", line))).toEqual({ ok: false, errors: [error] });
  });

  it("says every way a request is invalid at once", () => {
    const read = readReplayRequest(bodyWith("review.model: best", "implement.effort: extreme", "tickets: 1 2 3 4 5 6 7 8 9 10 11"));

    expect(read).toEqual({
      ok: false,
      errors: [
        `review.model is "best": Fable can bill metered usage, so the Kit never runs it in an AFK role`,
        `implement.effort is "extreme": effort must be one of low, medium, high, xhigh, max`,
        "tickets lists 11 Tickets, but a replay takes at most 10",
        "the request names 2 variables, review.model and implement.effort, but a replay changes exactly one",
      ],
    });
  });

  describe("refuses a request that doesn't name exactly one variable", () => {
    it("refuses one naming none", () => {
      expect(readReplayRequest(bodyWith("tickets: 12"))).toEqual({
        ok: false,
        errors: ["the request names no variable: give one of implement.model, implement.effort, review.model, review.effort or kit"],
      });
    });

    it("refuses one naming two, and names both", () => {
      expect(readReplayRequest(bodyWith("implement.model: claude-opus-5-5", "review.effort: high"))).toEqual({
        ok: false,
        errors: ["the request names 2 variables, implement.model and review.effort, but a replay changes exactly one"],
      });
    });
  });

  it.each([
    ["design.model: claude-opus-5-5", "design.model names the design role, but a replay changes only implement or review"],
    ["triage.effort: high", "triage.effort names the triage role, but a replay changes only implement or review"],
  ])("refuses %j, a role a replay doesn't run", (line, error) => {
    expect(readReplayRequest(bodyWith(line))).toEqual({ ok: false, errors: [error] });
  });

  it.each([
    ["implement.timeout_minutes: 90", "implement.timeout_minutes isn't a request field: give implement.model, implement.effort, review.model, review.effort or kit, and tickets if you like"],
    ["sha: " + CANDIDATE, "sha isn't a request field: give implement.model, implement.effort, review.model, review.effort or kit, and tickets if you like"],
  ])("refuses %j, a field a request doesn't have", (line, error) => {
    expect(readReplayRequest(bodyWith(line, "review.effort: high"))).toEqual({ ok: false, errors: [error] });
  });

  it.each([
    ["a line with no colon", "review.effort high", `"review.effort high" isn't a field: write each one as name: value`],
    ["a field with no value", "review.effort:", "review.effort has no value"],
  ])("refuses %s", (_, line, error) => {
    expect(readReplayRequest(bodyWith(line, "tickets: 4"))).toEqual({ ok: false, errors: [error] });
  });

  describe("refuses a model the Kit never runs", () => {
    it.each(["fable", "claude-fable-5", "best"])("refuses %j with Kit config's reason", (model) => {
      expect(readReplayRequest(bodyWith(`implement.model: ${model}`))).toEqual({
        ok: false,
        errors: [`implement.model is ${JSON.stringify(model)}: Fable can bill metered usage, so the Kit never runs it in an AFK role`],
      });
    });

    it.each(["gpt-5", "gemini-3-pro", "sonnet"])("refuses %j, which isn't a Claude model named in full", (model) => {
      expect(readReplayRequest(bodyWith(`review.model: ${model}`))).toEqual({
        ok: false,
        errors: [`review.model is ${JSON.stringify(model)}: a replay runs only a Claude model, named in full, such as claude-sonnet-5-5`],
      });
    });
  });

  it.each(["extreme", "High", "none"])("refuses %j as an effort, with Kit config's reason", (effort) => {
    expect(readReplayRequest(bodyWith(`review.effort: ${effort}`))).toEqual({
      ok: false,
      errors: [`review.effort is ${JSON.stringify(effort)}: effort must be one of low, medium, high, xhigh, max`],
    });
  });

  it.each([
    ["a short sha", "0123456"],
    ["a sha one character short", CANDIDATE.slice(1)],
    ["an uppercase sha", CANDIDATE.toUpperCase()],
    ["a branch name", "retro/prompt-change"],
  ])("refuses %s as the candidate Kit", (_, sha) => {
    expect(readReplayRequest(bodyWith(`kit: ${sha}`))).toEqual({
      ok: false,
      errors: [`kit is ${JSON.stringify(sha)}: a candidate Kit must be a Fabrik commit's full 40-character lowercase SHA`],
    });
  });
});

describe("The Replay this link", () => {
  const PRODUCT = "https://github.com/owner/product";

  it.each<[string, ReplayVariable]>([
    ["Implement's model", { kind: "model", role: "implement", model: "claude-opus-5-5" }],
    ["Implement's effort", { kind: "effort", role: "implement", effort: "xhigh" }],
    ["Review's model", { kind: "model", role: "review", model: "claude-sonnet-5-5" }],
    ["Review's effort", { kind: "effort", role: "review", effort: "medium" }],
    ["a candidate Kit", { kind: "kit", sha: CANDIDATE }],
  ])("files a replay issue whose request reads back as %s, with the default pick", (_, variable) => {
    const url = new URL(replayThisUrl(PRODUCT, variable));

    expect(`${url.origin}${url.pathname}`).toBe(`${PRODUCT}/issues/new`);
    expect(url.searchParams.get("labels")).toBe("fabrik:replay");
    expect(readReplayRequest(url.searchParams.get("body") ?? "")).toEqual({ ok: true, request: { variable, tickets: null } });
  });
});

/** The commit Ticket `ticket`'s first Implement run started from, whose short sha is the Ticket's number in hex, such as 000000c for 12. */
const baseOf = (ticket: number) => `${ticket.toString(16).padStart(7, "0")}${"0".repeat(33)}`;

/**
 * Ticket `ticket`, merged in PR `ticket + 100` on day `ticket` of November
 * with a test file, after one first Implement run costing $1: eligible, and
 * flagged for nothing.
 */
function aCandidate(ticket: number, overrides: Partial<ReplayCandidate> = {}): ReplayCandidate {
  return {
    ticket,
    merged: {
      number: ticket + 100,
      mergedAt: `2026-10-${String(ticket).padStart(2, "0")}T12:00:00Z`,
      reverted: false,
      files: [
        { path: "src/booking.ts", removed: false },
        { path: "src/booking.test.ts", removed: false },
      ],
    },
    records: [aRunRecord({ issue: ticket, pullRequest: null, baseSha: baseOf(ticket), endedAt: "2026-10-01T09:00:00Z" })],
    humanTouches: 0,
    lastEdited: { ticket: null, spec: null },
    ...overrides,
  };
}

describe("Picking a Replay's Tickets", () => {
  it("picks a listed eligible Ticket to replay from its first Implement run's base, with its merged PR", () => {
    expect(pickReplayTickets({ tickets: [12] }, [aCandidate(12)])).toEqual({
      picked: [{ ticket: 12, pullRequest: 112, baseSha: baseOf(12), flags: [] }],
      leftOut: [],
    });
  });

  it("replays a Ticket whose first Implement run ran again after an Infrastructure failure from the run that built its branch", () => {
    const refusedBase = "a".repeat(40);
    const records = [
      aRunRecord({ issue: 12, pullRequest: null, baseSha: refusedBase, endedAt: "2026-10-01T09:00:00Z", infrastructureFailure: "weekly-limit" }),
      aRunRecord({ issue: 12, pullRequest: null, baseSha: baseOf(12), endedAt: "2026-10-03T09:00:00Z" }),
      aRunRecord({ issue: 12, pullRequest: 112, retry: 1, baseSha: "c".repeat(40), endedAt: "2026-10-04T09:00:00Z" }),
    ];
    // Edited between the two, so the run that built the branch read the edit.
    const candidate = aCandidate(12, { records, lastEdited: { ticket: "2026-10-02T09:00:00Z", spec: null } });

    expect(pickReplayTickets({ tickets: [12] }, [candidate]).picked).toEqual([{ ticket: 12, pullRequest: 112, baseSha: baseOf(12), flags: [] }]);
  });

  it("picks the listed Tickets that are eligible in the order listed, and names each one left out", () => {
    const reverted = aCandidate(4, { merged: { ...aCandidate(4).merged!, reverted: true } });
    const candidates = [aCandidate(3), reverted, aCandidate(12), aCandidate(20, { merged: null }), aCandidate(9)];

    const pick = pickReplayTickets({ tickets: [12, 4, 9, 20, 3] }, candidates);

    expect(pick.picked.map(({ ticket }) => ticket)).toEqual([12, 9, 3]);
    expect(pick.leftOut).toEqual([
      { ticket: 4, reason: "its merged PR #104 was reverted" },
      { ticket: 20, reason: "no merged PR closed it" },
    ]);
  });

  describe("by default", () => {
    /** Ticket `ticket`, eligible, whose one first Implement run cost `cost`. */
    const costing = (ticket: number, cost: number) =>
      aCandidate(ticket, { records: [aRunRecord({ issue: ticket, pullRequest: null, baseSha: baseOf(ticket), totalCostUsd: cost })] });

    it("picks 5, the most recent eligible Tickets taken from each third of original cost in turn", () => {
      // Merged on day `ticket`, so a higher number is more recent. Ticket 16 is the most recent, but reverted.
      const cheap = [costing(1, 1.5), costing(4, 1), costing(7, 2), costing(10, 1.2), costing(13, 1.8)];
      const middling = [costing(2, 5.5), costing(5, 6), costing(8, 5), costing(11, 5.2), costing(14, 6.5)];
      const expensive = [costing(3, 25), costing(6, 20), costing(9, 30), costing(12, 22), costing(15, 21)];
      const reverted = aCandidate(16, { merged: { ...aCandidate(16).merged!, reverted: true } });

      const pick = pickReplayTickets({ tickets: null }, [...expensive, reverted, ...cheap, ...middling]);

      expect(pick.picked.map(({ ticket }) => ticket)).toEqual([13, 14, 15, 10, 11]);
      expect(pick.leftOut).toEqual([]);
    });

    it("picks every eligible Ticket when fewer than 5 are, and never one whose merged PR changed a Trust-root file", () => {
      const trustRoot = aCandidate(9, { merged: { ...aCandidate(9).merged!, files: [{ path: ".fabrik/config.json", removed: false }] } });
      const candidates = [costing(1, 3), costing(2, 1), trustRoot, costing(3, 8), aCandidate(5, { merged: null }), costing(4, 2)];

      const pick = pickReplayTickets({ tickets: null }, candidates);

      expect(pick.picked.map(({ ticket }) => ticket).toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4]);
      expect(pick.leftOut).toEqual([]);
    });

    it.each<[string, ReplayCandidate[]]>([
      ["no candidates", []],
      ["no eligible candidate", [aCandidate(4, { merged: null }), aCandidate(6, { records: [] })]],
    ])("picks nothing from %s", (_, candidates) => {
      expect(pickReplayTickets({ tickets: null }, candidates)).toEqual({ picked: [], leftOut: [] });
    });

    it("ranks a Ticket by the cost of all its Implement and Review runs, never its Triage, Design, judge or past Replay runs", () => {
      const run = (overrides: Partial<RunRecord>) => aRunRecord({ issue: 1, pullRequest: 101, baseSha: baseOf(1), totalCostUsd: 1, ...overrides });
      const replayed = { issue: 300, arm: "baseline", ticket: 2, candidateSha: null } as const;
      // $4 in all: its first run, a Retry, a Step-up and a Review.
      const retried = aCandidate(1, {
        records: [run({ pullRequest: null }), run({ retry: 1 }), run({ stepUp: true }), run({ role: "review", verdict: "pass" })],
      });
      // $2 of its own, beside $50 of other runs on it.
      const busy = aCandidate(2, {
        records: [
          aRunRecord({ issue: 2, pullRequest: null, baseSha: baseOf(2), totalCostUsd: 2 }),
          ...(["triage", "design", "score"] as const).map((role) => aRunRecord({ role, issue: 2, totalCostUsd: 10 })),
          aRunRecord({ issue: 2, pullRequest: 102, baseSha: baseOf(2), totalCostUsd: 10, replay: replayed }),
          aRunRecord({ role: "review", issue: 2, pullRequest: 102, totalCostUsd: 10, replay: replayed }),
        ],
      });
      // One third each, taken cheapest first: $2, $3.50, then $4.
      const pick = pickReplayTickets({ tickets: null }, [retried, busy, costing(3, 3.5)]);

      expect(pick.picked.map(({ ticket }) => ticket)).toEqual([2, 3, 1]);
    });
  });

  describe("leaves out a listed Ticket that isn't eligible, with why", () => {
    const merged = aCandidate(12).merged!;

    it.each<[string, ReplayCandidate[], string]>([
      ["no merged PR closed", [aCandidate(12, { merged: null })], "no merged PR closed it"],
      ["the Kit found nothing of", [], "no merged PR closed it"],
      ["whose merged PR was reverted", [aCandidate(12, { merged: { ...merged, reverted: true } })], "its merged PR #112 was reverted"],
      [
        "whose merged PR changed Trust-root files",
        [aCandidate(12, { merged: { ...merged, files: [...merged.files, { path: ".fabrik/config.json", removed: false }, { path: "AGENTS.md", removed: false }] } })],
        "its merged PR #112 changed Trust-root files, .fabrik/config.json and AGENTS.md, which no agent may change",
      ],
      [
        "whose merged PR moved a Trust-root file",
        [aCandidate(12, { merged: { ...merged, files: [{ path: "docs/old-coding-standards.md", from: "CODING_STANDARDS.md", removed: false }] } })],
        "its merged PR #112 changed a Trust-root file, CODING_STANDARDS.md, which no agent may change",
      ],
      [
        "no Implement run built",
        [aCandidate(12, { records: [aRunRecord({ role: "triage", issue: 12 }), aRunRecord({ role: "review", issue: 12, pullRequest: 112 })] })],
        "the store holds no Implement run of it",
      ],
      [
        "whose first Implement run left no record",
        [aCandidate(12, { records: [aRunRecord({ issue: 12, pullRequest: 112, retry: 1 })] })],
        "the store has no baseSha for its first Implement run",
      ],
      [
        "whose first Implement run's record has no baseSha",
        [aCandidate(12, { records: [aRunRecord({ issue: 12, pullRequest: null, baseSha: null })] })],
        "the store has no baseSha for its first Implement run",
      ],
    ])("leaves out a Ticket %s", (_, candidates, reason) => {
      expect(pickReplayTickets({ tickets: [12] }, candidates)).toEqual({ picked: [], leftOut: [{ ticket: 12, reason }] });
    });
  });

  describe("keeps a Ticket whose results need weighing, and flags it", () => {
    const merged = aCandidate(12).merged!;
    // Ticket 12's first Implement run ran for 90 seconds, ending at 09:00.
    const whileItRan = "2026-10-01T08:59:00Z";
    const beforeItRan = "2026-10-01T08:58:00Z";

    it.each<[string, Partial<ReplayCandidate>, string[]]>([
      ["Human touches", { humanTouches: 2 }, ["human-touches"]],
      ["its Ticket edited after its first Implement run started", { lastEdited: { ticket: whileItRan, spec: null } }, ["edited-input"]],
      ["its Spec edited after its first Implement run started", { lastEdited: { ticket: beforeItRan, spec: "2026-10-03T10:00:00Z" } }, ["edited-input"]],
      ["no hidden tests", { merged: { ...merged, files: [{ path: "src/booking.ts", removed: false }] } }, ["no-hidden-tests"]],
      [
        "all three",
        { humanTouches: 1, lastEdited: { ticket: null, spec: whileItRan }, merged: { ...merged, files: [{ path: "src/booking.ts", removed: false }] } },
        ["human-touches", "edited-input", "no-hidden-tests"],
      ],
    ])("keeps a Ticket with %s", (_, overrides, flags) => {
      expect(pickReplayTickets({ tickets: [12] }, [aCandidate(12, overrides)]).picked).toEqual([
        { ticket: 12, pullRequest: 112, baseSha: baseOf(12), flags },
      ]);
    });

    it("flags nothing for a Ticket and Spec last edited before its first Implement run started", () => {
      const picked = pickReplayTickets({ tickets: [12] }, [aCandidate(12, { lastEdited: { ticket: beforeItRan, spec: "2026-09-20T10:00:00Z" } })]).picked;

      expect(picked.map(({ flags }) => flags)).toEqual([[]]);
    });
  });
});

describe("A Replay's two arms", () => {
  /** A Product repo's Kit config at a Ticket's baseSha, with role defaults of its own. */
  const base: KitConfig = {
    ...DEFAULT_KIT_CONFIG,
    roles: {
      ...DEFAULT_KIT_CONFIG.roles,
      implement: { model: "claude-sonnet-5-5", effort: "medium", timeoutMinutes: 60 },
      review: { model: "claude-opus-5-5", effort: null, timeoutMinutes: 30 },
      stepUp: { model: "claude-opus-5-5", effort: "max" },
    },
  };

  /** How the Ticket was built: the base Kit config's models and efforts, and the pinned release's own prompts. */
  const asBuilt = {
    implement: { model: "claude-sonnet-5-5", effort: "medium" },
    review: { model: "claude-opus-5-5", effort: null },
    candidateSha: null,
  };

  const variables: [string, ReplayVariable, unknown][] = [
    [
      "Implement's model",
      { kind: "model", role: "implement", model: "claude-opus-5-5" },
      { ...asBuilt, implement: { model: "claude-opus-5-5", effort: "medium" } },
    ],
    [
      "Implement's effort",
      { kind: "effort", role: "implement", effort: "max" },
      { ...asBuilt, implement: { model: "claude-sonnet-5-5", effort: "max" } },
    ],
    [
      "Review's model",
      { kind: "model", role: "review", model: "claude-sonnet-5-5" },
      { ...asBuilt, review: { model: "claude-sonnet-5-5", effort: null } },
    ],
    ["Review's effort", { kind: "effort", role: "review", effort: "low" }, { ...asBuilt, review: { model: "claude-opus-5-5", effort: "low" } }],
    ["a candidate Kit", { kind: "kit", sha: CANDIDATE }, { ...asBuilt, candidateSha: CANDIDATE }],
  ];

  it.each(variables)("run the baseline as the base Kit config held, when the variable is %s", (_, variable) => {
    expect(replayArms(base, variable).baseline).toEqual(asBuilt);
  });

  it.each(variables)("run the variant differing from it only in %s", (_, variable, variant) => {
    expect(replayArms(base, variable).variant).toEqual(variant);
  });
});

describe("A merged PR's hidden tests", () => {
  /** A file the merged PR added or changed. */
  const changed = (path: string): MergedFile => ({ path, removed: false });

  it.each([
    ["*.test.*", "src/kit/replay.test.ts"],
    ["*.spec.*", "web/components/Button.spec.tsx"],
    ["*_test.*", "internal/store/store_test.go"],
    ["test_*.*", "app/test_views.py"],
    ["anything under test/", "test/helpers.js"],
    ["anything under tests/", "packages/api/tests/fixtures/patient.json"],
    ["anything under __tests__/", "src/__tests__/booking.tsx"],
  ])("are its files named by %s", (_, path) => {
    expect(hiddenTests([changed("src/kit/replay.ts"), changed(path), changed("README.md")])).toEqual([path]);
  });

  it("are none for a PR whose files follow no test convention", () => {
    const files = ["src/testing.ts", "docs/test-plan.md", "src/contest/entry.ts", "src/latest_results.py", "testdata/patient.json"];

    expect(hiddenTests(files.map(changed))).toEqual([]);
  });

  it("leave out a test file the PR removed, which the merged tree doesn't hold", () => {
    const files: MergedFile[] = [
      { path: "src/old.test.ts", removed: true },
      { path: "src/booking.test.ts", from: "src/appointment.test.ts", removed: false },
    ];

    expect(hiddenTests(files)).toEqual(["src/booking.test.ts"]);
  });
});

/** The Operator, who files every replay issue that counts. */
const OPERATOR = "jrey8343";

/** Kit config at every candidate's baseSha: Implement on Sonnet at medium effort, Review on Opus at the CLI's default. */
const BASE: KitConfig = {
  ...DEFAULT_KIT_CONFIG,
  roles: {
    ...DEFAULT_KIT_CONFIG.roles,
    implement: { model: "claude-sonnet-5-5", effort: "medium", timeoutMinutes: 60 },
    review: { model: "claude-opus-5-5", effort: null, timeoutMinutes: 30 },
  },
};

/** The arms of a Ticket built under BASE, replayed with review.effort: high. */
const REVIEW_HIGH_ARMS = {
  baseline: { implement: { model: "claude-sonnet-5-5", effort: "medium" }, review: { model: "claude-opus-5-5", effort: null }, candidateSha: null },
  variant: { implement: { model: "claude-sonnet-5-5", effort: "medium" }, review: { model: "claude-opus-5-5", effort: "high" }, candidateSha: null },
};

/** Replay issue `number`, open and the Operator's, asking for review.effort: high on Tickets 12 and 7. */
function aReplayIssue(number: number, overrides: Partial<ReplayIssue> = {}): ReplayIssue {
  return { number, open: true, author: OPERATOR, body: bodyWith("review.effort: high", "tickets: 12, 7"), comments: [], ...overrides };
}

/** What accepting a request weighs: these candidates, each built under BASE, and no candidate Kit checked. */
function acceptanceOf(candidates: readonly ReplayCandidate[]): ReplayAcceptance {
  const baseConfigs = Object.fromEntries(candidates.map(({ ticket }) => [baseOf(ticket), { ok: true, config: BASE } as const]));
  return { candidates, baseConfigs, fabrikCommits: {} };
}

/** A tick with spare capacity, these replay issues, and Tickets 7, 12 and 20 to pick from. */
function aTick(issues: readonly ReplayIssue[], overrides: Partial<ReplayTick> = {}): ReplayTick {
  return { operator: OPERATOR, issues, capacity: { spare: true }, acceptance: acceptanceOf([aCandidate(7), aCandidate(12), aCandidate(20)]), ...overrides };
}

/** The body an accept step writes, failing the test on any other step. */
function acceptedBody(step: ReplayStep): string {
  if (step.kind !== "accept") throw new Error(`expected an accept step, got ${JSON.stringify(step)}`);
  return step.body;
}

/** Replay issue `number` once the tick accepted its request, review.effort: high on Tickets 12 and 7, both pending, picked from `acceptance`'s candidates. */
function anAcceptedIssue(number: number, overrides: Partial<ReplayIssue> = {}, acceptance?: ReplayAcceptance): ReplayIssue {
  const issue = aReplayIssue(number, overrides);
  return { ...issue, body: acceptedBody(nextReplayStep(aTick([{ ...issue, open: true }], acceptance === undefined ? {} : { acceptance }))) };
}

/** The issue with its Ticket `ticket` started by run `run`, failing the test when it can't start. */
function started(issue: ReplayIssue, ticket: number, run: number): ReplayIssue {
  const body = withTicketStarted(issue.body, ticket, run);
  if (body === null) throw new Error(`#${ticket} can't start on #${issue.number}`);
  return { ...issue, body };
}

/** The issue with run `run` of its Ticket `ticket` ended so, failing the test when it can't end. */
function finished(issue: ReplayIssue, ticket: number, run: number, end: ReplayTicketEnd): ReplayIssue {
  const body = withTicketFinished(issue.body, ticket, run, end);
  if (body === null) throw new Error(`#${ticket}'s run ${run} can't end on #${issue.number}`);
  return { ...issue, body };
}

describe("A Replay's next step on the tick", () => {
  describe("accepts a valid new request", () => {
    it("writing its plan into the body: the picked Tickets, their flags and each arm's settings, every Ticket pending", () => {
      const step = nextReplayStep(aTick([aReplayIssue(140)]));

      expect(step).toMatchObject({ kind: "accept", issue: 140 });
      expect(replayMarksIn(acceptedBody(step))).toEqual({
        plan: {
          variable: { kind: "effort", role: "review", effort: "high" },
          tickets: [
            { ticket: 12, pullRequest: 112, baseSha: baseOf(12), flags: [], arms: REVIEW_HIGH_ARMS },
            { ticket: 7, pullRequest: 107, baseSha: baseOf(7), flags: [], arms: REVIEW_HIGH_ARMS },
          ],
          leftOut: [],
        },
        progress: [
          { ticket: 12, state: "pending" },
          { ticket: 7, state: "pending" },
        ],
      });
    });

    it("listing the picked Tickets in the body for the Operator to read, each with its flags", () => {
      const touched = aCandidate(12, { humanTouches: 2 });
      const untested = aCandidate(7, { merged: { ...aCandidate(7).merged!, files: [{ path: "src/booking.ts", removed: false }] } });

      const shown = visible(acceptedBody(nextReplayStep(aTick([aReplayIssue(140)], { acceptance: acceptanceOf([touched, untested]) }))));

      expect(shown.find((line) => line.includes("#12"))).toContain("Human touches");
      expect(shown.find((line) => line.includes("#7"))).toContain("no hidden tests");
    });

    describe("leaving out a Ticket its arms can't compare", () => {
      /** BASE, but with Review already at effort high, as the request's variant would run it. */
      const reviewHigh = { ok: true, config: { roles: { ...BASE.roles, review: { ...BASE.roles.review, effort: "high" } } } } as const;
      const invalid = { ok: false, errors: [".fabrik/config.json: roles.implement.turns is not a field"] } as const;

      it("naming a listed one whose Kit config at its base doesn't resolve, or already runs the variant, with why", () => {
        const acceptance = acceptanceOf([aCandidate(7), aCandidate(12), aCandidate(20)]);
        const baseConfigs = { ...acceptance.baseConfigs, [baseOf(12)]: invalid, [baseOf(20)]: reviewHigh };
        const issue = aReplayIssue(140, { body: bodyWith("review.effort: high", "tickets: 12, 7, 20") });

        const plan = replayMarksIn(acceptedBody(nextReplayStep(aTick([issue], { acceptance: { ...acceptance, baseConfigs } }))))?.plan;

        expect(plan?.tickets.map(({ ticket }) => ticket)).toEqual([7]);
        expect(plan?.leftOut).toEqual([
          { ticket: 12, reason: "its Kit config at 000000c doesn't resolve under this Kit release: .fabrik/config.json: roles.implement.turns is not a field" },
          { ticket: 20, reason: "its Kit config at 0000014 already runs Review at effort high, so its two arms would be the same" },
        ]);
      });

      it("taking another eligible Ticket in its place in the default pick", () => {
        const candidates = [1, 2, 3, 4, 5, 6].map((ticket) => aCandidate(ticket));
        const acceptance = acceptanceOf(candidates);
        const baseConfigs = { ...acceptance.baseConfigs, [baseOf(6)]: reviewHigh, [baseOf(5)]: invalid };
        const issue = aReplayIssue(140, { body: bodyWith("review.effort: high") });

        const plan = replayMarksIn(acceptedBody(nextReplayStep(aTick([issue], { acceptance: { ...acceptance, baseConfigs } }))))?.plan;

        expect(plan?.tickets.map(({ ticket }) => ticket).toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4]);
        expect(plan?.leftOut).toEqual([]);
      });

      it("rejecting a default pick left with none, naming each Ticket left out", () => {
        const acceptance = acceptanceOf([aCandidate(7), aCandidate(12)]);
        const baseConfigs = { [baseOf(7)]: reviewHigh, [baseOf(12)]: reviewHigh };
        const issue = aReplayIssue(140, { body: bodyWith("review.effort: high") });

        const step = nextReplayStep(aTick([issue], { acceptance: { ...acceptance, baseConfigs } }));

        expect(step).toMatchObject({ kind: "reject", issue: 140 });
        expect((step as Extract<ReplayStep, { kind: "reject" }>).comment).toContain(
          "- #12: its Kit config at 000000c already runs Review at effort high, so its two arms would be the same",
        );
      });

      it.each([
        ["Implement's model", "implement.model: claude-sonnet-5-5", "Implement on claude-sonnet-5-5"],
        ["Review's model", "review.model: claude-opus-5-5", "Review on claude-opus-5-5"],
        ["Implement's effort", "implement.effort: medium", "Implement at effort medium"],
      ])("whose base already runs the variant's %s", (_, line, runs) => {
        const issue = aReplayIssue(140, { body: bodyWith(line, "tickets: 12") });

        const step = nextReplayStep(aTick([issue]));

        expect((step as Extract<ReplayStep, { kind: "reject" }>).comment).toContain(
          `- #12: its Kit config at 000000c already runs ${runs}, so its two arms would be the same`,
        );
      });
    });

    it("keeping the Operator's text above the Kit's part as it was, so the request still reads the same", () => {
      const body = "Does Review hold up at a higher effort?  \r\n\r\n```replay\r\nreview.effort: high\r\ntickets: 12\r\n```";

      const accepted = acceptedBody(nextReplayStep(aTick([aReplayIssue(140, { body })])));

      expect(accepted.startsWith(body)).toBe(true);
      expect(readReplayRequest(accepted)).toEqual(readReplayRequest(body));
    });
  });

  describe("rejects an invalid request", () => {
    const invalid = aReplayIssue(140, { body: bodyWith("review.effort: highest", "implement.model: sonnet") });

    it("with one comment saying everything wrong with it", () => {
      const step = nextReplayStep(aTick([invalid]));

      expect(step).toMatchObject({ kind: "reject", issue: 140 });
      const { comment } = step as Extract<ReplayStep, { kind: "reject" }>;
      expect(comment).toContain('review.effort is "highest": effort must be one of low, medium, high, xhigh, max');
      expect(comment).toContain('implement.model is "sonnet": a replay runs only a Claude model, named in full');
    });

    it("and never comments on it twice for the same problem", () => {
      const { comment } = nextReplayStep(aTick([invalid])) as Extract<ReplayStep, { kind: "reject" }>;

      expect(nextReplayStep(aTick([{ ...invalid, comments: [comment] }]))).toMatchObject({ kind: "nothing" });
    });

    it("but comments again on a new problem once the Operator edits the body", () => {
      const { comment } = nextReplayStep(aTick([invalid])) as Extract<ReplayStep, { kind: "reject" }>;
      const edited = { ...invalid, body: bodyWith("review.effort: highest"), comments: [comment] };

      expect(nextReplayStep(aTick([edited]))).toMatchObject({ kind: "reject", issue: 140 });
    });

    it("and reads the body again on the next tick, accepting it once an edit fixes it", () => {
      const { comment } = nextReplayStep(aTick([invalid])) as Extract<ReplayStep, { kind: "reject" }>;
      const fixed = { ...invalid, body: bodyWith("review.effort: high", "tickets: 12"), comments: [comment] };

      expect(nextReplayStep(aTick([fixed]))).toMatchObject({ kind: "accept", issue: 140 });
    });
  });

  describe("rejects a request with no eligible Ticket, with one comment, and runs nothing", () => {
    it("naming each listed Ticket left out, with why", () => {
      const reverted = aCandidate(4, { merged: { ...aCandidate(4).merged!, reverted: true } });
      const issue = aReplayIssue(140, { body: bodyWith("review.effort: high", "tickets: 4, 30") });

      const step = nextReplayStep(aTick([issue], { acceptance: acceptanceOf([reverted]) }));

      expect(step).toMatchObject({ kind: "reject", issue: 140 });
      const { comment } = step as Extract<ReplayStep, { kind: "reject" }>;
      expect(comment).toContain("- #4: its merged PR #104 was reverted");
      expect(comment).toContain("- #30: no merged PR closed it");
      expect(nextReplayStep(aTick([{ ...issue, comments: [comment] }], { acceptance: acceptanceOf([reverted]) }))).toMatchObject({ kind: "nothing" });
    });

    it("saying what makes a Ticket eligible when the default pick finds none", () => {
      const issue = aReplayIssue(140, { body: bodyWith("review.effort: high") });

      const step = nextReplayStep(aTick([issue], { acceptance: acceptanceOf([aCandidate(4, { merged: null })]) }));

      expect(step).toMatchObject({ kind: "reject", issue: 140 });
      expect((step as Extract<ReplayStep, { kind: "reject" }>).comment).toContain("no merged Ticket here can be replayed");
    });
  });

  describe("checks a candidate Kit is a Fabrik commit", () => {
    const issue = aReplayIssue(140, { body: bodyWith(`kit: ${CANDIDATE}`, "tickets: 12") });

    it("rejecting a request whose candidate Kit isn't one", () => {
      const step = nextReplayStep(aTick([issue], { acceptance: { ...acceptanceOf([aCandidate(12)]), fabrikCommits: { [CANDIDATE]: false } } }));

      expect(step).toMatchObject({ kind: "reject", issue: 140 });
      expect((step as Extract<ReplayStep, { kind: "reject" }>).comment).toContain(`kit is ${CANDIDATE}, which isn't a commit in the Fabrik repo`);
    });

    it("accepting one whose candidate Kit is, its variant loading that commit's prompts and Base skills", () => {
      const step = nextReplayStep(aTick([issue], { acceptance: { ...acceptanceOf([aCandidate(12)]), fabrikCommits: { [CANDIDATE]: true } } }));

      expect(replayMarksIn(acceptedBody(step))?.plan.tickets[0]?.arms.variant.candidateSha).toBe(CANDIDATE);
    });
  });

  describe("tells the adapter what to read for a request waiting to be accepted", () => {
    const listed = aReplayIssue(140, { body: bodyWith(`kit: ${CANDIDATE}`, "tickets: 12, 7, 30") });
    const byDefault = aReplayIssue(150, { body: bodyWith("review.effort: high") });
    const candidates = [aCandidate(7), aCandidate(12), aCandidate(20), aCandidate(21, { merged: null })];

    it("the candidates and each candidate Kit to check, then the Kit config at the base of each eligible Ticket a pick weighs", () => {
      const tick = aTick([listed]);

      expect(replayReads(tick, null)).toEqual({ acceptance: true, fabrikShas: [CANDIDATE], baseShas: [] });
      expect(replayReads(tick, candidates)).toEqual({ acceptance: true, fabrikShas: [CANDIDATE], baseShas: [baseOf(12), baseOf(7)] });
      expect(replayReads(aTick([byDefault]), candidates).baseShas).toEqual([baseOf(7), baseOf(12), baseOf(20)]);
    });

    it.each<[string, ReplayIssue[]]>([
      ["no replay issue", []],
      ["an accepted one", [anAcceptedIssue(140)]],
      ["an invalid request", [aReplayIssue(140, { body: bodyWith("review.effort: highest") })]],
      ["someone else's request", [aReplayIssue(140, { author: "someone-else" })]],
      ["a closed issue's request", [aReplayIssue(140, { open: false })]],
    ])("and nothing for %s", (_, issues) => {
      expect(replayReads(aTick(issues), candidates)).toEqual({ acceptance: false, fabrikShas: [], baseShas: [] });
    });

    it.each<[string, ReplayIssue, Partial<ReplayTick>]>([
      ["with no acceptance facts", byDefault, { acceptance: null }],
      ["with no Kit config read at a base it names", byDefault, { acceptance: { ...acceptanceOf([aCandidate(7), aCandidate(12)]), baseConfigs: {} } }],
      ["with no check of the candidate Kit", listed, {}],
    ])("doing nothing, never a comment, for a waiting request %s", (_, issue, overrides) => {
      expect(nextReplayStep(aTick([issue], overrides))).toMatchObject({ kind: "nothing" });
    });
  });

  describe("weighs only the Operator's open replay issues", () => {
    it.each<[string, Partial<ReplayIssue>]>([
      ["a valid request filed by someone else", { author: "someone-else" }],
      ["an invalid request filed by someone else", { author: "someone-else", body: bodyWith("review.effort: highest") }],
      ["a closed issue's valid request", { open: false }],
      ["a closed issue's invalid request", { open: false, body: bodyWith("review.effort: highest") }],
    ])("gives %s nothing, not even a comment", (_, overrides) => {
      expect(nextReplayStep(aTick([aReplayIssue(140, overrides)]))).toMatchObject({ kind: "nothing" });
    });
  });

  describe("starts the next pending Ticket", () => {
    it("of an accepted request, the first in its plan", () => {
      expect(nextReplayStep(aTick([anAcceptedIssue(140)]))).toEqual({ kind: "start", issue: 140, ticket: 12 });
    });

    it("on the oldest accepted issue first", () => {
      const newer = anAcceptedIssue(150, { body: bodyWith("implement.effort: max", "tickets: 7") });

      expect(nextReplayStep(aTick([newer, anAcceptedIssue(140)]))).toEqual({ kind: "start", issue: 140, ticket: 12 });
    });

    it("but nothing without spare capacity, saying why", () => {
      const step = nextReplayStep(aTick([anAcceptedIssue(140)], { capacity: { spare: false, why: "Ticket #31 is waiting for Dispatch" } }));

      expect(step).toEqual({ kind: "nothing", reason: "Ticket #31 is waiting for Dispatch" });
    });

    it("never on a closed issue", () => {
      expect(nextReplayStep(aTick([anAcceptedIssue(140, { open: false })]))).toMatchObject({ kind: "nothing" });
    });
  });

  describe("keeps each Ticket's progress in the body", () => {
    it("marking a Ticket its run starts in progress with the run's id, the plan reading back unchanged", () => {
      const accepted = anAcceptedIssue(140);

      const marks = replayMarksIn(started(accepted, 12, 9001).body);

      expect(marks?.plan).toEqual(replayMarksIn(accepted.body)?.plan);
      expect(marks?.progress).toEqual([
        { ticket: 12, state: "in-progress", run: 9001, retrying: null },
        { ticket: 7, state: "pending" },
      ]);
    });

    it("starting nothing while a replay Ticket is in progress on any issue", () => {
      const [older, newer] = [anAcceptedIssue(140), anAcceptedIssue(150, { body: bodyWith("implement.effort: max", "tickets: 7") })];

      expect(nextReplayStep(aTick([started(older, 12, 9001), newer]))).toMatchObject({ kind: "nothing" });
      expect(nextReplayStep(aTick([older, started(newer, 7, 9001)]))).toMatchObject({ kind: "nothing" });
    });

    it("but not for a closed issue's Ticket, which no longer counts", () => {
      const cancelled = { ...started(anAcceptedIssue(140), 12, 9001), open: false };

      expect(nextReplayStep(aTick([cancelled, anAcceptedIssue(150)]))).toEqual({ kind: "start", issue: 150, ticket: 12 });
    });

    it("starting only a Ticket in the plan that is waiting to run", () => {
      const accepted = anAcceptedIssue(140);

      expect(withTicketStarted(started(accepted, 12, 9001).body, 12, 9002)).toBeNull();
      expect(withTicketStarted(accepted.body, 30, 9001)).toBeNull();
      expect(withTicketStarted(bodyWith("review.effort: high"), 12, 9001)).toBeNull();
    });

    it("marking a Ticket done once its run ends, so the next one starts", () => {
      const done = finished(started(anAcceptedIssue(140), 12, 9001), 12, 9001, { kind: "done" });

      expect(replayMarksIn(done.body)?.progress[0]).toEqual({ ticket: 12, state: "done", run: 9001 });
      expect(nextReplayStep(aTick([done]))).toEqual({ kind: "start", issue: 140, ticket: 7 });
    });

    it("ending only the run its Ticket is in progress with", () => {
      const running = started(anAcceptedIssue(140), 12, 9001);

      expect(withTicketFinished(running.body, 12, 9002, { kind: "done" })).toBeNull();
      expect(withTicketFinished(running.body, 7, 9001, { kind: "done" })).toBeNull();
    });

    it("returning a Ticket whose run was refused on a weekly limit to pending, to start again", () => {
      const refused = finished(started(anAcceptedIssue(140), 12, 9001), 12, 9001, { kind: "weekly-limit" });

      expect(replayMarksIn(refused.body)?.progress[0]).toEqual({ ticket: 12, state: "pending" });
      expect(nextReplayStep(aTick([refused]))).toEqual({ kind: "start", issue: 140, ticket: 12 });
    });

    it("retrying a Ticket once after any other Infrastructure failure, then marking it failed with its reason", () => {
      const once = finished(started(anAcceptedIssue(140), 12, 9001), 12, 9001, { kind: "infrastructure", reason: "the model provider failed" });

      expect(replayMarksIn(once.body)?.progress[0]).toEqual({ ticket: 12, state: "retried", reason: "the model provider failed" });
      expect(nextReplayStep(aTick([once]))).toEqual({ kind: "start", issue: 140, ticket: 12 });

      const twice = finished(started(once, 12, 9002), 12, 9002, { kind: "infrastructure", reason: "the Sandbox timed out" });

      expect(replayMarksIn(twice.body)?.progress[0]).toEqual({ ticket: 12, state: "failed", run: 9002, reason: "the Sandbox timed out" });
      expect(nextReplayStep(aTick([twice]))).toEqual({ kind: "start", issue: 140, ticket: 7 });
    });

    it("keeping a retried Ticket's one retry through a weekly-limit refusal", () => {
      const once = finished(started(anAcceptedIssue(140), 12, 9001), 12, 9001, { kind: "infrastructure", reason: "the model provider failed" });
      const refused = finished(started(once, 12, 9002), 12, 9002, { kind: "weekly-limit" });

      expect(replayMarksIn(refused.body)?.progress[0]).toEqual({ ticket: 12, state: "retried", reason: "the model provider failed" });
    });

    it("starting nothing once every Ticket is done or failed", () => {
      const once = finished(started(anAcceptedIssue(140), 12, 9001), 12, 9001, { kind: "infrastructure", reason: "the model provider failed" });
      const failed = finished(started(once, 12, 9002), 12, 9002, { kind: "infrastructure", reason: "the Sandbox timed out" });
      const finishedAll = finished(started(failed, 7, 9003), 7, 9003, { kind: "done" });

      expect(nextReplayStep(aTick([finishedAll]))).toMatchObject({ kind: "nothing" });
    });

    it("holding to the plan once it's written, whatever the Operator edits in the request", () => {
      const accepted = anAcceptedIssue(140);
      const edited = { ...accepted, body: accepted.body.replace("review.effort: high", "implement.model: claude-opus-5-5") };

      expect(replayMarksIn(edited.body)).toEqual(replayMarksIn(accepted.body));
      expect(nextReplayStep(aTick([edited]))).toEqual({ kind: "start", issue: 140, ticket: 12 });
    });

    it("reading a marker only below the Kit's start line, and only as the Kit writes one", () => {
      const accepted = anAcceptedIssue(140).body;
      const [operatorPart = "", kitPart = ""] = accepted.split("<!-- fabrik:replay-start -->");
      const markers = kitPart.split("\n").filter((line) => line.startsWith("<!--"));

      expect(replayMarksIn(`${operatorPart}${markers.join("\n")}`)).toBeNull();
      expect(replayMarksIn(accepted.replace(/fabrik:replay-plan \{/, "fabrik:replay-plan {,"))).toBeNull();
    });

    it.each([
      ["a model the Kit never runs", (plan: string) => plan.replace('"model":"claude-opus-5-5"', '"model":"claude-fable-5"')],
      ["an effort Kit config doesn't take", (plan: string) => plan.replace('"effort":"medium"', '"effort":"extreme"')],
      ["a base that isn't a full sha", (plan: string) => plan.replace(/"baseSha":"[0-9a-f]{40}"/, '"baseSha":"main"')],
      ["a variable no request names", (plan: string) => plan.replace('"role":"review"', '"role":"design"')],
      ["a flag the Kit doesn't know", (plan: string) => plan.replace('"flags":[]', '"flags":["lucky"]')],
    ])("reading no plan from a plan marker edited to hold %s", (_, edit) => {
      const accepted = anAcceptedIssue(140).body;
      const tampered = accepted.replace(/^<!-- fabrik:replay-plan .*$/m, edit);

      expect(tampered).not.toBe(accepted);
      expect(replayMarksIn(tampered)).toBeNull();
    });

    it("reading a Ticket whose progress marker doesn't read as pending", () => {
      const running = started(anAcceptedIssue(140), 12, 9001);
      const broken = running.body.replace('"state":"in-progress"', '"state":"sleeping"');

      expect(replayMarksIn(broken)?.progress[0]).toEqual({ ticket: 12, state: "pending" });
    });

    it("never changing the Operator's text above the Kit's part, however often the Kit rewrites its own", () => {
      const body = "Does Review hold up at a higher effort?  \r\n\r\n```replay\r\nreview.effort: high\r\ntickets: 12\r\n```\r\nThanks!";

      const accepted = anAcceptedIssue(140, { body });
      const done = finished(started(accepted, 12, 9001), 12, 9001, { kind: "done" });

      expect(done.body.startsWith(body)).toBe(true);
      // Nor anything between it and the Kit's part, which the Kit put there once.
      const above = (each: string) => each.slice(0, each.indexOf("<!-- fabrik:replay-start -->"));
      expect(above(done.body)).toBe(above(accepted.body));
      expect(replayMarksIn(done.body)?.progress).toEqual([{ ticket: 12, state: "done", run: 9001 }]);
    });
  });
});

describe("A Replay's results", () => {
  /** Replay 140's arm `arm` of Ticket `ticket`. */
  const replayOf = (ticket: number, arm: ReplayArm): ReplayRun => ({ issue: 140, arm, ticket, candidateSha: null });

  /** What one arm of a Ticket measured, as a test gives it: anything left out is as anArm makes it. */
  interface ArmGiven {
    readonly implement?: Partial<RunRecord>;
    readonly review?: Partial<RunRecord>;
    /** Its Efficiency, Ticket compliance and Skill use scores, or null for no score file. */
    readonly scores?: readonly [number, number, number] | null;
    readonly gates?: ReplayGates;
    readonly hiddenTests?: ReplayHiddenTests;
  }

  /**
   * Arm `arm` of Ticket `ticket`, run in workflow run `run`, as the store
   * holds it: an Implement and a Review run, each costing $1 over 12 turns
   * and 90 seconds, a pass Verdict, scores of 0.80, 0.90 and 0.75, and its
   * gates and hidden tests passed, unless a test says otherwise.
   */
  function anArm(ticket: number, arm: ReplayArm, run: number, given: ArmGiven = {}): Omit<ReplayOutcomes, "open"> {
    const replay = replayOf(ticket, arm);
    const ran = { runId: run, issue: ticket, pullRequest: ticket + 100, baseSha: baseOf(ticket), replay, endedAt: "2026-11-05T12:00:00Z" };
    const [efficiency, compliance, skillUse] = given.scores === undefined ? [0.8, 0.9, 0.75] : (given.scores ?? []);
    return {
      records: [aRunRecord({ ...ran, role: "implement", ...given.implement }), aRunRecord({ ...ran, role: "review", verdict: "pass", ...given.review })],
      scoreFiles:
        given.scores === null
          ? []
          : [
              aScoreFile({
                runId: run,
                issue: ticket,
                pullRequest: ticket + 100,
                replay,
                entries: [
                  aScoreEntry({ score: efficiency }),
                  aScoreEntry({ scorer: "ticket-compliance", score: compliance }),
                  aScoreEntry({ scorer: "skill-use", score: skillUse }),
                ],
              }),
            ],
      gates: [{ ticket, arm, run, gates: given.gates ?? "passed", hiddenTests: given.hiddenTests ?? "passed" }],
    };
  }

  /** The outcomes of these arms, read back from the store of an open replay issue. */
  function outcomesOf(...arms: Omit<ReplayOutcomes, "open">[]): ReplayOutcomes {
    return {
      open: true,
      records: arms.flatMap(({ records }) => records),
      scoreFiles: arms.flatMap(({ scoreFiles }) => scoreFiles),
      gates: arms.flatMap(({ gates }) => gates),
    };
  }

  /** Replay 140, review.effort: high on Tickets 12 and 7, with both done, in runs 9001 and 9002. */
  function aFinishedReplay(): ReplayIssue {
    const twelve = finished(started(anAcceptedIssue(140), 12, 9001), 12, 9001, { kind: "done" });
    return finished(started(twelve, 7, 9002), 7, 9002, { kind: "done" });
  }

  /** The body with its results written from `outcomes`, failing the test when it has no plan. */
  function resultsIn(body: string, outcomes: ReplayOutcomes): string {
    const written = withReplayResults(body, outcomes);
    if (written === null) throw new Error("expected a body with a plan");
    return written;
  }

  /** The results table's rows, one per arm of each Ticket. */
  const rowsOf = (body: string) => visible(body).filter((line) => line.startsWith("| #"));

  /** The store link of arm `arm`'s patch of Ticket `ticket`. */
  const patchOf = (ticket: number, arm: ReplayArm) => `[patch](https://github.com/jrey8343/fabrik-runs/blob/HEAD/replays/owner/product/140/${ticket}-${arm}.patch)`;

  it("shows each arm of each Ticket in a row of its own: its gates, Verdict, hidden tests, scores, cost, turns, duration and patch", () => {
    const body = resultsIn(
      aFinishedReplay().body,
      outcomesOf(
        anArm(12, "baseline", 9001, { implement: { totalCostUsd: 1.5, turns: 20, durationMs: 120_000 }, review: { totalCostUsd: 0.5, turns: 4, durationMs: 60_000 } }),
        anArm(12, "variant", 9001, { review: { verdict: "execution-flaw", totalCostUsd: 0.9 }, hiddenTests: "failed", scores: [0.6, 0.85, 0.7] }),
        anArm(7, "baseline", 9002, { review: { verdict: "design-flaw" }, gates: "tests-failed", hiddenTests: "failed" }),
        anArm(7, "variant", 9002, { implement: { durationMs: 270_000 }, scores: null }),
      ),
    );

    expect(visible(body)).toContain("| Ticket | Arm | Gates | Verdict | Hidden tests | Efficiency | Ticket compliance | Skill use | Cost | Turns | Duration | Patch | Flags |");
    expect(rowsOf(body)).toEqual([
      `| #12 (merged in #112) | baseline, default effort | passed | pass | passed | 0.80 | 0.90 | 0.75 | $2.00 | 24 | 3 min | ${patchOf(12, "baseline")} | – |`,
      `| #12 (merged in #112) | variant, effort high | passed | Execution flaw | failed | 0.60 | 0.85 | 0.70 | $1.90 | 24 | 3 min | ${patchOf(12, "variant")} | – |`,
      `| #7 (merged in #107) | baseline, default effort | tests failed | Design flaw | failed | 0.80 | 0.90 | 0.75 | $2.00 | 24 | 3 min | ${patchOf(7, "baseline")} | – |`,
      `| #7 (merged in #107) | variant, effort high | passed | pass | passed | – | – | – | $2.00 | 24 | 6 min | ${patchOf(7, "variant")} | – |`,
    ]);
  });

  /** The cells of a row with no result, after where its Ticket stands and before its flags. */
  const NOTHING_YET = "– | – | – | – | – | – | – | – | –";

  it("shows a Ticket not done as pending, in progress or failed, on both its rows", () => {
    const once = finished(started(anAcceptedIssue(140), 12, 9001), 12, 9001, { kind: "infrastructure", reason: "the model provider failed" });
    const failed = finished(started(once, 12, 9002), 12, 9002, { kind: "infrastructure", reason: "the Sandbox timed out" });

    expect(rowsOf(resultsIn(failed.body, outcomesOf()))).toEqual([
      `| #12 (merged in #112) | baseline, default effort | failed: the Sandbox timed out | ${NOTHING_YET} | – |`,
      `| #12 (merged in #112) | variant, effort high | failed: the Sandbox timed out | ${NOTHING_YET} | – |`,
      `| #7 (merged in #107) | baseline, default effort | pending | ${NOTHING_YET} | – |`,
      `| #7 (merged in #107) | variant, effort high | pending | ${NOTHING_YET} | – |`,
    ]);
    expect(rowsOf(resultsIn(started(failed, 7, 9003).body, outcomesOf())).slice(2)).toEqual([
      `| #7 (merged in #107) | baseline, default effort | in progress in run 9003 | ${NOTHING_YET} | – |`,
      `| #7 (merged in #107) | variant, effort high | in progress in run 9003 | ${NOTHING_YET} | – |`,
    ]);
  });

  it("shows every Ticket not finished as cancelled once the Operator closes the issue, keeping what finished", () => {
    const twelve = finished(started(anAcceptedIssue(140), 12, 9001), 12, 9001, { kind: "done" });
    const outcomes = { ...outcomesOf(anArm(12, "baseline", 9001), anArm(12, "variant", 9001)), open: false };

    const rows = rowsOf(resultsIn(started(twelve, 7, 9002).body, outcomes));

    expect(rows[0]).toBe(`| #12 (merged in #112) | baseline, default effort | passed | pass | passed | 0.80 | 0.90 | 0.75 | $2.00 | 24 | 3 min | ${patchOf(12, "baseline")} | – |`);
    expect(rows.slice(2)).toEqual([
      `| #7 (merged in #107) | baseline, default effort | cancelled | ${NOTHING_YET} | – |`,
      `| #7 (merged in #107) | variant, effort high | cancelled | ${NOTHING_YET} | – |`,
    ]);
  });

  /**
   * Ticket `ticket`'s original first Implement run, on 1 October, and its
   * Review an hour later, each costing $1 over 12 turns and 90 seconds, with a
   * pass Verdict, unless a test says otherwise.
   */
  function theOriginal(ticket: number, given: { readonly implement?: Partial<RunRecord>; readonly review?: Partial<RunRecord> } = {}): RunRecord[] {
    const ran = { runId: 500 + ticket, issue: ticket, pullRequest: ticket + 100, baseSha: baseOf(ticket) };
    return [
      aRunRecord({ ...ran, role: "implement", endedAt: "2026-10-01T09:00:00Z", ...given.implement }),
      aRunRecord({ ...ran, role: "review", endedAt: "2026-10-01T10:00:00Z", verdict: "pass", ...given.review }),
    ];
  }

  /** Replay 140 finished: Ticket 12's variant failing its hidden tests at a lower cost, and Ticket 7's baseline failing its tests and its variant having no test command. */
  function aMixedReplay(): string {
    const outcomes = outcomesOf(
      anArm(12, "baseline", 9001),
      anArm(12, "variant", 9001, { review: { verdict: "execution-flaw", totalCostUsd: 0.4 }, hiddenTests: "failed", scores: [0.6, 0.8, 0.7] }),
      anArm(7, "baseline", 9002, { gates: "tests-failed", hiddenTests: "failed" }),
      anArm(7, "variant", 9002, { implement: { turns: 31 }, gates: "no-test-command", hiddenTests: "no-test-command", scores: null }),
    );
    const originals = [
      ...theOriginal(12),
      ...theOriginal(7, { implement: { totalCostUsd: 2.5, durationMs: 270_000 }, review: { verdict: "execution-flaw", totalCostUsd: 0.5 } }),
    ];
    return resultsIn(aFinishedReplay().body, { ...outcomes, records: [...outcomes.records, ...originals] });
  }

  /** The lines of the body's Totals section, its heading and the blank lines in it left out. */
  function totalsIn(body: string): string[] {
    const shown = visible(body);
    const at = shown.indexOf("### Totals");
    const end = shown.findIndex((line, i) => i > at && line.startsWith("Baseline vs original"));
    return at === -1 ? [] : shown.slice(at + 1, end + 1).filter((line) => line !== "");
  }

  it("totals each arm over its Tickets done, beside the original runs, with the baseline's gap from the original", () => {
    expect(totalsIn(aMixedReplay())).toEqual([
      "Over the 2 Tickets done, beside the original: each one's first Implement run and its Review.",
      "| Arm | Gates | Pass Verdicts | Hidden tests | Efficiency | Ticket compliance | Skill use | Cost | Turns | Duration |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| baseline | 1/2 | 2/2 | 1/2 | 0.80 | 0.90 | 0.75 | $4.00 | 48 | 6 min |",
      "| variant | 1/1 | 1/2 | 0/1 | 0.60 | 0.80 | 0.70 | $3.40 | 67 | 6 min |",
      "| original | – | 1/2 | – | – | – | – | $5.00 | 48 | 9 min |",
      "Baseline vs original: pass Verdicts 2/2 vs 1/2; cost −20%; turns 0%; duration −33%.",
    ]);
  });

  it("compares the baseline with the original's first attempt only, never a Retry, nor a past Replay's runs", () => {
    const outcomes = outcomesOf(anArm(12, "baseline", 9001), anArm(12, "variant", 9001), anArm(7, "baseline", 9002), anArm(7, "variant", 9002));
    const retry = { runId: 600, retry: 1, endedAt: "2026-10-01T11:00:00Z", totalCostUsd: 9 };
    const pastReplay = { ...replayOf(12, "baseline"), issue: 130 };
    const records = [
      ...theOriginal(12, { review: { verdict: "execution-flaw" } }),
      aRunRecord({ ...retry, issue: 12 }),
      aRunRecord({ ...retry, issue: 12, role: "review", endedAt: "2026-10-01T12:00:00Z", verdict: "pass" }),
      aRunRecord({ runId: 700, issue: 12, role: "review", replay: pastReplay, verdict: "pass", totalCostUsd: 9 }),
      ...theOriginal(7, { review: { verdict: "execution-flaw" } }),
    ];

    const body = resultsIn(aFinishedReplay().body, { ...outcomes, records: [...outcomes.records, ...records] });

    expect(totalsIn(body)).toContain("| original | – | 0/2 | – | – | – | – | $4.00 | 48 | 6 min |");
  });

  it("never totals a figure the store doesn't hold for every run, nor compares it", () => {
    const unknown = { totalCostUsd: null, turns: null };
    const outcomes = outcomesOf(anArm(12, "baseline", 9001, { review: unknown }), anArm(12, "variant", 9001), anArm(7, "baseline", 9002), anArm(7, "variant", 9002));

    const body = resultsIn(aFinishedReplay().body, { ...outcomes, records: [...outcomes.records, ...theOriginal(12), ...theOriginal(7, { implement: unknown })] });

    expect(rowsOf(body)[0]).toContain("| 0.75 | – | – | 3 min |");
    expect(totalsIn(body)).toEqual(expect.arrayContaining(["| baseline | 2/2 | 2/2 | 2/2 | 0.80 | 0.90 | 0.75 | – | – | 6 min |", "| original | – | 2/2 | – | – | – | – | – | – | 6 min |"]));
    expect(visible(body)).toContain("**variant: gates 2/2 vs 2/2; pass Verdicts 2/2 vs 2/2; hidden tests 2/2 vs 2/2; duration 0%**");
    expect(totalsIn(body).at(-1)).toBe("Baseline vs original: pass Verdicts 2/2 vs 2/2; duration 0%.");
  });

  it("heads the results with one line of the variant's totals against the baseline's", () => {
    expect(visible(aMixedReplay())).toContain("**variant: gates 1/1 vs 1/2; pass Verdicts 1/2 vs 2/2; hidden tests 0/1 vs 1/2; cost −15%; turns +40%; duration 0%**");
  });

  it("keeps the Operator's request at the top as it was, its one request block, the plan and each Ticket's progress", () => {
    const request = "Does Review hold up at a higher effort?  \r\n\r\n```replay\r\nreview.effort: high\r\ntickets: 12\r\n```\r\nThanks!";
    const done = finished(started(anAcceptedIssue(140, { body: request }), 12, 9001), 12, 9001, { kind: "done" });

    const body = resultsIn(done.body, outcomesOf(anArm(12, "baseline", 9001), anArm(12, "variant", 9001)));

    expect(body.startsWith(request)).toBe(true);
    expect(body.slice(0, body.indexOf("<!-- fabrik:replay-start -->"))).toBe(done.body.slice(0, done.body.indexOf("<!-- fabrik:replay-start -->")));
    expect(readReplayRequest(body)).toEqual(readReplayRequest(request));
    expect(replayMarksIn(body)).toEqual(replayMarksIn(done.body));
  });

  it("shows the plan's variable, whatever the Operator has since edited in the request", () => {
    const done = finished(started(anAcceptedIssue(140), 12, 9001), 12, 9001, { kind: "done" });
    const edited = done.body.replace("review.effort: high", "implement.model: claude-opus-5-5");

    const shown = visible(resultsIn(edited, outcomesOf(anArm(12, "baseline", 9001), anArm(12, "variant", 9001)))).join("\n");

    expect(shown.slice(shown.indexOf("## Replay results"))).toContain("a variant with `review.effort: high`");
    expect(shown).not.toContain("variant, claude-opus-5-5");
  });

  describe("shows the results as each Ticket finishes", () => {
    /** Replay 140 once Ticket 12 is done in run 9001 and its results are shown. */
    function twelveShown(): ReplayIssue {
      const twelve = finished(started(anAcceptedIssue(140), 12, 9001), 12, 9001, { kind: "done" });
      return { ...twelve, body: resultsIn(twelve.body, outcomesOf(anArm(12, "baseline", 9001), anArm(12, "variant", 9001))) };
    }

    it("keeping a done Ticket's results as the next one starts, and its run ends, until they're read again", () => {
      const shown = twelveShown();

      const running = started(shown, 7, 9002);
      const refused = finished(running, 7, 9002, { kind: "weekly-limit" });

      expect(rowsOf(running.body)).toEqual([
        ...rowsOf(shown.body).slice(0, 2),
        `| #7 (merged in #107) | baseline, default effort | in progress in run 9002 | ${NOTHING_YET} | – |`,
        `| #7 (merged in #107) | variant, effort high | in progress in run 9002 | ${NOTHING_YET} | – |`,
      ]);
      expect(rowsOf(refused.body)).toEqual(rowsOf(shown.body));
      expect(totalsIn(refused.body)).toEqual(totalsIn(shown.body));
    });

    it("but showing no figure from a results marker edited to hold one the Kit wouldn't write", () => {
      const shown = twelveShown();
      const tampered = shown.body.replace(/^(<!-- fabrik:replay-results .*)"costUsd":2([,}])/m, '$1"costUsd":"lots"$2');

      expect(tampered).not.toBe(shown.body);
      expect(rowsOf(started({ ...shown, body: tampered }, 7, 9002).body).slice(0, 2)).toEqual([
        `| #12 (merged in #112) | baseline, default effort | done | ${NOTHING_YET} | – |`,
        `| #12 (merged in #112) | variant, effort high | done | ${NOTHING_YET} | – |`,
      ]);
    });
  });

  describe("are in", () => {
    it("once every Ticket in the plan is done or failed", () => {
      const once = finished(started(anAcceptedIssue(140), 12, 9001), 12, 9001, { kind: "infrastructure", reason: "the model provider failed" });
      const failed = finished(started(once, 12, 9002), 12, 9002, { kind: "infrastructure", reason: "the Sandbox timed out" });

      expect(replayResultsIn(aFinishedReplay().body)).toBe(true);
      expect(replayResultsIn(finished(started(failed, 7, 9003), 7, 9003, { kind: "done" }).body)).toBe(true);
    });

    it.each<[string, () => string]>([
      ["before its request is accepted", () => bodyWith("review.effort: high")],
      ["while a Ticket is pending", () => finished(started(anAcceptedIssue(140), 12, 9001), 12, 9001, { kind: "done" }).body],
      ["while a Ticket waits to run again", () => finished(started(anAcceptedIssue(140), 12, 9001), 12, 9001, { kind: "infrastructure", reason: "the model provider failed" }).body],
      ["while a Ticket is in progress", () => started(finished(started(anAcceptedIssue(140), 12, 9001), 12, 9001, { kind: "done" }), 7, 9002).body],
    ])("not %s", (_, body) => {
      expect(replayResultsIn(body())).toBe(false);
    });
  });

  it("shows a Ticket's flags on each of its rows, and no hidden tests never as a pass", () => {
    const untested = aCandidate(7, {
      merged: { ...aCandidate(7).merged!, files: [{ path: "src/booking.ts", removed: false }] },
      lastEdited: { ticket: "2026-10-02T00:00:00Z", spec: null },
    });
    const issue = anAcceptedIssue(140, {}, acceptanceOf([aCandidate(12, { humanTouches: 2 }), untested]));
    const done = finished(started(issue, 7, 9001), 7, 9001, { kind: "done" });

    const rows = rowsOf(resultsIn(done.body, outcomesOf(anArm(7, "baseline", 9001, { hiddenTests: "no-hidden-tests" }), anArm(7, "variant", 9001, { hiddenTests: "no-hidden-tests" }))));

    expect(rows).toEqual([
      `| #12 (merged in #112) | baseline, default effort | pending | ${NOTHING_YET} | Human touches |`,
      `| #12 (merged in #112) | variant, effort high | pending | ${NOTHING_YET} | Human touches |`,
      `| #7 (merged in #107) | baseline, default effort | passed | pass | no hidden tests | 0.80 | 0.90 | 0.75 | $2.00 | 24 | 3 min | ${patchOf(7, "baseline")} | edited input, no hidden tests |`,
      `| #7 (merged in #107) | variant, effort high | passed | pass | no hidden tests | 0.80 | 0.90 | 0.75 | $2.00 | 24 | 3 min | ${patchOf(7, "variant")} | edited input, no hidden tests |`,
    ]);
  });
});

/** The lines of a body the Operator sees: none of its hidden marker lines. */
function visible(body: string): string[] {
  return body.split("\n").filter((line) => !line.trim().startsWith("<!--"));
}
