import { describe, expect, it } from "vitest";
import { aNamedPullRequest, AUDITED_SHA, auditBody, auditRunSnapshotOf, kitConfig, notificationsOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { AuditWindow, LoopEvent, Plan } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

/** The commit the Audit before this one read. */
const LAST_AUDITED_SHA = "c".repeat(40);

const SINCE_LAST_AUDIT: AuditWindow = { kind: "since-audit", audit: 90, commit: LAST_AUDITED_SHA };

/** The Auditor's run on Audit #97 finished with this `<audit>` JSON, or this text when it's a string. */
function auditFinished(output: unknown, window: AuditWindow = SINCE_LAST_AUDIT): LoopEvent {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return { kind: "audit-run-finished", issue: 97, output: text, window, runUrl: RUN };
}

/** One candidate as the Auditor writes it: by default Strong, naming PR #31. */
function aCandidate(overrides: Record<string, unknown> = {}) {
  return {
    title: "Make the cart module deeper",
    files: ["src/cart.ts", "src/cart/total.ts"],
    problem: "Callers reach into three modules to total a cart.",
    solution: "One cart module whose `total()` hides the tax and discount steps.",
    benefits: "Callers stop knowing how a total is made, so tests sit at one seam.",
    before: "flowchart LR\n  checkout --> tax\n  checkout --> discount",
    after: "flowchart LR\n  checkout --> cart",
    strength: "strong",
    introducedBy: [31],
    ...overrides,
  };
}

describe("Landing an Audit: a full Audit", () => {
  it("rewrites the pending Audit into its cards, each with its badge, diagrams and Introduced by, then the Top recommendation", () => {
    const output = {
      candidates: [
        aCandidate({ introducedBy: [31, 32] }),
        aCandidate({
          title: "Give booking its own seam",
          files: ["src/booking.ts"],
          problem: "Booking and billing share one module.",
          solution: "Split booking out behind `book()`.",
          benefits: "Billing changes stop breaking booking.",
          before: "flowchart LR\n  shop --> bookingAndBilling",
          after: "flowchart LR\n  shop --> booking\n  shop --> billing",
          strength: "worth-exploring",
          introducedBy: [],
        }),
      ],
      topRecommendation: "Start with Make the cart module deeper: every checkout change goes through it.",
    };

    const plan = planFor(
      auditFinished(output),
      auditRunSnapshotOf([aNamedPullRequest({ number: 31 }), aNamedPullRequest({ number: 32, headRef: "fabrik/ticket-8" })]),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "edit-issue-body",
          issue: 97,
          body: [
            "The Auditor read the default branch up to `bbbbbbb`, looking first at what changed since Audit #90 at `ccccccc`. File the candidates you want, comment here on any you reject so the next Audit knows, and close this Audit when you're done.",
            "",
            "## Make the cart module deeper",
            "",
            "`Strong`",
            "",
            "**Files:** `src/cart.ts`, `src/cart/total.ts`",
            "",
            "**Problem:** Callers reach into three modules to total a cart.",
            "",
            "**Solution:** One cart module whose `total()` hides the tax and discount steps.",
            "",
            "**Benefits:** Callers stop knowing how a total is made, so tests sit at one seam.",
            "",
            "**Before**",
            "",
            "```mermaid",
            "flowchart LR",
            "  checkout --> tax",
            "  checkout --> discount",
            "```",
            "",
            "**After**",
            "",
            "```mermaid",
            "flowchart LR",
            "  checkout --> cart",
            "```",
            "",
            "**Introduced by:** #31, #32",
            "",
            "## Give booking its own seam",
            "",
            "`Worth exploring`",
            "",
            "**Files:** `src/booking.ts`",
            "",
            "**Problem:** Booking and billing share one module.",
            "",
            "**Solution:** Split booking out behind `book()`.",
            "",
            "**Benefits:** Billing changes stop breaking booking.",
            "",
            "**Before**",
            "",
            "```mermaid",
            "flowchart LR",
            "  shop --> bookingAndBilling",
            "```",
            "",
            "**After**",
            "",
            "```mermaid",
            "flowchart LR",
            "  shop --> booking",
            "  shop --> billing",
            "```",
            "",
            "**Introduced by:** No merged agent PR",
            "",
            "## Top recommendation",
            "",
            "Start with Make the cart module deeper: every checkout change goes through it.",
            "",
            `<!-- fabrik:audit ${AUDITED_SHA} -->`,
          ].join("\n"),
        },
      ],
    });
  });
});

/** The plan's new body for the Audit, from its one edit-issue-body action. */
function rewrittenBodyOf(plan: Plan): string {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  const edits = plan.actions.flatMap((action) => (action.kind === "edit-issue-body" ? [action.body] : []));
  if (edits.length !== 1) throw new Error(`expected one body edit, got ${JSON.stringify(plan.actions)}`);
  return edits[0]!;
}

/** The "Introduced by" line of each card. */
function introducedByLines(body: string): string[] {
  return body.split("\n").filter((line) => line.startsWith("**Introduced by:**"));
}

describe("Landing an Audit: Introduced by", () => {
  const withPullRequests = (introducedBy: number[]) => ({
    candidates: [aCandidate({ introducedBy })],
    topRecommendation: "Make the cart module deeper",
  });

  it("keeps only the merged agent PRs, dropping an unmerged PR, a person's PR, an agent-named branch a person opened and an unknown number", () => {
    const plan = planFor(
      auditFinished(withPullRequests([31, 40, 41, 42, 404, 32])),
      auditRunSnapshotOf([
        aNamedPullRequest({ number: 31 }),
        aNamedPullRequest({ number: 32, headRef: "fabrik/ticket-8" }),
        aNamedPullRequest({ number: 40, merged: false }),
        aNamedPullRequest({ number: 41, headRef: "feature/cart", isAgent: false }),
        aNamedPullRequest({ number: 42, headRef: "fabrik/ticket-9", isAgent: false }),
      ]),
      kitConfig(),
    );

    expect(introducedByLines(rewrittenBodyOf(plan))).toEqual(["**Introduced by:** #31, #32"]);
  });

  it("names each kept PR once, however often the Auditor named it", () => {
    const plan = planFor(auditFinished(withPullRequests([31, 31])), auditRunSnapshotOf([aNamedPullRequest({ number: 31 })]), kitConfig());

    expect(introducedByLines(rewrittenBodyOf(plan))).toEqual(["**Introduced by:** #31"]);
  });

  it("says no merged agent PR introduced a candidate when none it named is one", () => {
    const plan = planFor(
      auditFinished(withPullRequests([41, 404])),
      auditRunSnapshotOf([aNamedPullRequest({ number: 41, headRef: "feature/cart", isAgent: false })]),
      kitConfig(),
    );

    expect(introducedByLines(rewrittenBodyOf(plan))).toEqual(["**Introduced by:** No merged agent PR"]);
  });
});

describe("Landing an Audit: a clean one", () => {
  const CLEAN = {
    kind: "act",
    actions: [
      {
        kind: "edit-issue-body",
        issue: 97,
        body: [
          "The Auditor read the default branch up to `bbbbbbb`, looking first at what changed since Audit #90 at `ccccccc`, and found nothing above Speculative: the repo is clean.",
          "",
          `<!-- fabrik:audit ${AUDITED_SHA} -->`,
        ].join("\n"),
      },
      { kind: "close", issue: 97, reason: "completed" },
    ],
  };

  it("rewrites an Audit with no candidates to a one-line clean note, keeping its audit marker, and closes it as completed", () => {
    const plan = planFor(auditFinished({ candidates: [], topRecommendation: null }), auditRunSnapshotOf(), kitConfig());

    expect(plan).toEqual(CLEAN);
  });

  it("closes an Audit whose candidates are all Speculative as clean too", () => {
    const output = {
      candidates: [
        aCandidate({ strength: "speculative" }),
        aCandidate({ title: "Give booking its own seam", strength: "speculative", introducedBy: [] }),
      ],
      topRecommendation: "Make the cart module deeper, if anything",
    };

    const plan = planFor(auditFinished(output), auditRunSnapshotOf([aNamedPullRequest({ number: 31 })]), kitConfig());

    expect(plan).toEqual(CLEAN);
  });

  it("files an Audit with one candidate above Speculative, its Speculative ones included", () => {
    const output = {
      candidates: [aCandidate({ strength: "worth-exploring" }), aCandidate({ title: "Give booking its own seam", strength: "speculative" })],
      topRecommendation: "Make the cart module deeper",
    };

    const body = rewrittenBodyOf(planFor(auditFinished(output), auditRunSnapshotOf([aNamedPullRequest({ number: 31 })]), kitConfig()));

    expect(body).toContain("## Make the cart module deeper\n\n`Worth exploring`");
    expect(body).toContain("## Give booking its own seam\n\n`Speculative`");
  });

  it("says when the Auditor looked first at the last 30 days", () => {
    const plan = planFor(
      auditFinished({ candidates: [], topRecommendation: null }, { kind: "last-days", days: 30 }),
      auditRunSnapshotOf(),
      kitConfig(),
    );

    expect(rewrittenBodyOf(plan).split("\n")[0]).toBe(
      "The Auditor read the default branch up to `bbbbbbb`, looking first at the last 30 days, and found nothing above Speculative: the repo is clean.",
    );
  });
});

describe("Landing an Audit: a stale result", () => {
  const full = { candidates: [aCandidate()], topRecommendation: "Make the cart module deeper" };

  it.each([
    ["the Operator closed the Audit", { open: false }],
    ["a person opened the issue", { byApp: false }],
    ["the issue has lost fabrik:audit", { labels: [] }],
    ["the Audit is already filled", { body: auditBody(AUDITED_SHA, "filled") }],
    ["the Audit's run already failed, though it was reopened", { body: auditBody(AUDITED_SHA, "failed") }],
    ["the Audit has lost its audit marker", { body: "The Auditor is reading the default branch.\n\n<!-- fabrik:audit-pending -->" }],
  ])("lands nothing when %s", (_, audit) => {
    const plan = planFor(auditFinished(full), auditRunSnapshotOf([aNamedPullRequest()], audit), kitConfig());

    expect(plan.kind).toBe("nothing");
  });

  it("lands nothing on a closed Audit even when the reply breaks the contract, so closing a pending Audit cancels it", () => {
    const plan = planFor(auditFinished({ candidates: "none" }), auditRunSnapshotOf([], { open: false }), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "#97 is no longer a pending Audit, so its Auditor's result is stale" });
  });
});

describe("Landing an Audit: silent", () => {
  it("mentions nobody from any text the Auditor wrote", () => {
    const output = {
      candidates: [
        aCandidate({
          title: "Ask @alice about the cart",
          files: ["src/@bob/cart.ts"],
          problem: "@carol wrote it.",
          solution: "Ping @dave.",
          benefits: "@erin is happy.",
          before: "flowchart LR\n  frank[@frank] --> cart",
          after: "flowchart LR\n  grace[@grace]",
        }),
      ],
      topRecommendation: "Ask @alice about the cart, with @heidi",
    };

    const body = rewrittenBodyOf(planFor(auditFinished(output), auditRunSnapshotOf([aNamedPullRequest()]), kitConfig()));

    expect(body).not.toMatch(/@(alice|bob|carol|dave|erin|frank|grace|heidi)/);
    expect(body).toContain("## Ask @​alice about the cart");
  });

  it("gives the filled Audit no state label, assignee, review request or mention, and leaves it open", () => {
    const output = { candidates: [aCandidate({ problem: "Hard to change, @operator." })], topRecommendation: "Make the cart module deeper" };

    const plan = planFor(auditFinished(output), auditRunSnapshotOf([aNamedPullRequest()]), kitConfig());

    expect(plan.kind === "act" && plan.actions.map((action) => action.kind)).toEqual(["edit-issue-body"]);
    expect(rewrittenBodyOf(plan)).not.toMatch(/@operator/);
    expect(notificationsOf(plan)).toEqual([]);
  });
});

describe("Landing an Audit: a reply that breaks the contract", () => {
  const top = "Make the cart module deeper";
  const without = (field: string) => {
    const candidate: Record<string, unknown> = aCandidate();
    delete candidate[field];
    return candidate;
  };
  const four = ["One", "Two", "Three", "Four"].map((title) => aCandidate({ title }));

  it.each<[string, string]>([
    ["isn't JSON", "candidates: none"],
    ["isn't an object", JSON.stringify([aCandidate()])],
    ["has no candidates list", JSON.stringify({ topRecommendation: null })],
    ["has more than 3 candidates", JSON.stringify({ candidates: four, topRecommendation: "One" })],
    ["gives an unknown Strength", JSON.stringify({ candidates: [aCandidate({ strength: "certain" })], topRecommendation: top })],
    ...["title", "files", "problem", "solution", "benefits", "before", "after", "strength", "introducedBy"].map(
      (field): [string, string] => [`leaves out a candidate's ${field}`, JSON.stringify({ candidates: [without(field)], topRecommendation: top })],
    ),
    ["leaves out the Top recommendation", JSON.stringify({ candidates: [aCandidate()] })],
    ["names a PR by something other than its number", JSON.stringify({ candidates: [aCandidate({ introducedBy: ["#31"] })], topRecommendation: top })],
    ["fences a before diagram", JSON.stringify({ candidates: [aCandidate({ before: "```mermaid\nflowchart LR\n  a --> b\n```" })], topRecommendation: top })],
    ["fences an after diagram with tildes", JSON.stringify({ candidates: [aCandidate({ after: "flowchart LR\n~~~\n  a" })], topRecommendation: top })],
    ["gives a Top recommendation naming no candidate", JSON.stringify({ candidates: [aCandidate()], topRecommendation: "Start with billing" })],
    ["gives no Top recommendation for its candidates", JSON.stringify({ candidates: [aCandidate()], topRecommendation: null })],
    ["gives a Top recommendation with no candidates", JSON.stringify({ candidates: [], topRecommendation: top })],
  ])("closes the Audit as failed, filing nothing, when the reply %s", (_, output) => {
    const plan = planFor(auditFinished(output), auditRunSnapshotOf([aNamedPullRequest()]), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "edit-issue-body",
          issue: 97,
          body: expect.stringMatching(
            new RegExp(
              `^The Auditor's run failed: its reply broke the Audit output contract \\(.+\\)\\. \\[The run\\]\\(${RUN}\\)\n\n<!-- fabrik:audit ${AUDITED_SHA} -->\n<!-- fabrik:audit-failed -->$`,
            ),
          ),
        },
        { kind: "close", issue: 97, reason: "not_planned" },
      ],
    });
  });

  it("says on the failed Audit how the reply broke the contract, mentioning nobody", () => {
    const output = { candidates: [aCandidate({ title: "Ask @alice" })], topRecommendation: "Start with billing" };

    const body = rewrittenBodyOf(planFor(auditFinished(output), auditRunSnapshotOf(), kitConfig()));

    expect(body.split("\n")[0]).toBe(
      `The Auditor's run failed: its reply broke the Audit output contract (topRecommendation must name one of the candidates by its title ("Ask @\u200balice")). [The run](${RUN})`,
    );
  });

  it("keeps the failed Audit's reason to one line when the reply it quotes runs over several", () => {
    const body = rewrittenBodyOf(planFor(auditFinished("Here is\nmy audit"), auditRunSnapshotOf(), kitConfig()));

    expect(body.split("\n")[0]).toMatch(/^The Auditor's run failed: .*"Here is my audit" is not valid JSON\)\. \[The run\]/);
  });

  it("files three candidates, the most there can be", () => {
    const three = ["One", "Two", "Three"].map((title) => aCandidate({ title }));

    const plan = planFor(auditFinished({ candidates: three, topRecommendation: "Start with Two" }), auditRunSnapshotOf(), kitConfig());

    expect(rewrittenBodyOf(plan).match(/^## (One|Two|Three)$/gm)).toEqual(["## One", "## Two", "## Three"]);
  });

  it("takes a Top recommendation that names its candidate in any case", () => {
    const plan = planFor(auditFinished({ candidates: [aCandidate()], topRecommendation: "Start by making the cart module deeper? No: make the cart module deeper." }), auditRunSnapshotOf(), kitConfig());

    expect(plan.kind).toBe("act");
  });
});
