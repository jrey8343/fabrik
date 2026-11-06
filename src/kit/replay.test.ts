import { describe, expect, it } from "vitest";
import { aRunRecord } from "../__fixtures__/weeklySummary.ts";
import { DEFAULT_KIT_CONFIG, type KitConfig } from "./config.ts";
import {
  hiddenTests,
  type MergedFile,
  nextReplayStep,
  pickReplayTickets,
  readReplayRequest,
  type ReplayAcceptance,
  replayArms,
  type ReplayCandidate,
  type ReplayIssue,
  replayMarksIn,
  type ReplayStep,
  type ReplayTick,
  type ReplayVariable,
  replayThisUrl,
} from "./replay.ts";
import type { RunRecord } from "./runRecord.ts";

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

/** The commit Ticket `ticket`'s first Implement run started from. */
const baseOf = (ticket: number) => ticket.toString(16).padStart(40, "0");

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

describe("A Replay's next step on the tick", () => {
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
});

/** The lines of a body the Operator sees: none of its hidden marker lines. */
function visible(body: string): string[] {
  return body.split("\n").filter((line) => !line.trim().startsWith("<!--"));
}
