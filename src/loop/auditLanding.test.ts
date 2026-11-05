import { describe, expect, it } from "vitest";
import { aNamedPullRequest, anIssue, AUDITED_SHA, auditBody, auditRunSnapshotOf, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { MAX_ISSUE_URL_LENGTH } from "./followUps.ts";
import { escapeMarkerIn, fromAuditIn } from "./markers.ts";
import { planFor } from "./rules.ts";
import type { AuditWindow, LoopEvent, Plan } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

/** The commit the Audit before this one read. */
const LAST_AUDITED_SHA = "c".repeat(40);

const SINCE_LAST_AUDIT: AuditWindow = { kind: "since-audit", audit: 90, commit: LAST_AUDITED_SHA };

/** The Auditor's run on Audit #97 finished with this `<audit>` JSON, or this text when it's a string. */
function auditFinished(output: unknown, window: AuditWindow = SINCE_LAST_AUDIT): LoopEvent {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return { kind: "audit-run-finished", issue: 97, output: text, window, runUrl: RUN, repoUrl: "https://github.com/acme/shop" };
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

/** The Open as issue link to the Product repo's new-issue form, prefilled with this title and body. */
function openAsIssue(title: string, body: readonly string[]): string {
  return `[Open as issue](https://github.com/acme/shop/issues/new?${new URLSearchParams({ title, body: body.join("\n") })})`;
}

describe("Landing an Audit: a full Audit", () => {
  it("rewrites the pending Audit into its cards, each with its badge, diagrams, Introduced by and Open as issue link, then the Top recommendation", () => {
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
            openAsIssue("Make the cart module deeper", [
              "**Files:** `src/cart.ts`, `src/cart/total.ts`",
              "",
              "**Problem:** Callers reach into three modules to total a cart.",
              "",
              "**Solution:** One cart module whose `total()` hides the tax and discount steps.",
              "",
              "**Benefits:** Callers stop knowing how a total is made, so tests sit at one seam.",
              "",
              "**Strength:** Strong",
              "",
              "From audit #97",
              "<!-- fabrik:escape strong #31 #32 -->",
            ]),
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
            openAsIssue("Give booking its own seam", [
              "**Files:** `src/booking.ts`",
              "",
              "**Problem:** Booking and billing share one module.",
              "",
              "**Solution:** Split booking out behind `book()`.",
              "",
              "**Benefits:** Billing changes stop breaking booking.",
              "",
              "**Strength:** Worth exploring",
              "",
              "From audit #97",
            ]),
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

describe("Landing an Audit: the Open as issue link", () => {
  /** Each Open as issue link in an Audit's body, read back as the new-issue form it opens. */
  function issueLinks(body: string): URL[] {
    return [...body.matchAll(/\[Open as issue\]\(([^)\s]+)\)/g)].map((match) => new URL(match[1]!));
  }

  /** The new-issue form each card's link opens, from the filled Audit `output` lands as, given the PRs it named. */
  function linksFrom(output: unknown, named = [aNamedPullRequest()]): URL[] {
    return issueLinks(rewrittenBodyOf(planFor(auditFinished(output), auditRunSnapshotOf(named), kitConfig())));
  }

  it("ends each card with a link to the Product repo's new-issue form, prefilled with the candidate's title, Files, Problem, Solution, Benefits and Strength, then the Audit it came from", () => {
    const output = {
      candidates: [
        aCandidate({ introducedBy: [] }),
        aCandidate({ title: "Give booking its own seam", files: ["src/booking.ts"], strength: "worth-exploring", introducedBy: [] }),
      ],
      topRecommendation: "Make the cart module deeper",
    };

    const links = linksFrom(output);

    expect(links.map((link) => `${link.origin}${link.pathname}`)).toEqual([
      "https://github.com/acme/shop/issues/new",
      "https://github.com/acme/shop/issues/new",
    ]);
    expect(links.map((link) => [link.searchParams.get("title"), link.searchParams.get("body")])).toEqual([
      [
        "Make the cart module deeper",
        [
          "**Files:** `src/cart.ts`, `src/cart/total.ts`",
          "",
          "**Problem:** Callers reach into three modules to total a cart.",
          "",
          "**Solution:** One cart module whose `total()` hides the tax and discount steps.",
          "",
          "**Benefits:** Callers stop knowing how a total is made, so tests sit at one seam.",
          "",
          "**Strength:** Strong",
          "",
          "From audit #97",
        ].join("\n"),
      ],
      [
        "Give booking its own seam",
        [
          "**Files:** `src/booking.ts`",
          "",
          "**Problem:** Callers reach into three modules to total a cart.",
          "",
          "**Solution:** One cart module whose `total()` hides the tax and discount steps.",
          "",
          "**Benefits:** Callers stop knowing how a total is made, so tests sit at one seam.",
          "",
          "**Strength:** Worth exploring",
          "",
          "From audit #97",
        ].join("\n"),
      ],
    ]);
  });

  it("ends the issue with the escape marker, naming the Strength and the PRs kept in Introduced by, when it traces to merged agent PRs", () => {
    const output = {
      candidates: [aCandidate({ strength: "worth-exploring", introducedBy: [32, 40, 31] })],
      topRecommendation: "Make the cart module deeper",
    };

    const [link] = linksFrom(output, [
      aNamedPullRequest({ number: 31 }),
      aNamedPullRequest({ number: 32, headRef: "fabrik/ticket-8" }),
      aNamedPullRequest({ number: 40, merged: false }),
    ]);

    expect(link?.searchParams.get("body")?.split("\n").slice(-4)).toEqual([
      "**Strength:** Worth exploring",
      "",
      "From audit #97",
      "<!-- fabrik:escape worth-exploring #32 #31 -->",
    ]);
  });

  it("gives a candidate naming only a PR from a person's branch no Introduced by and no escape marker", () => {
    const output = { candidates: [aCandidate({ introducedBy: [41] })], topRecommendation: "Make the cart module deeper" };
    const named = [aNamedPullRequest({ number: 41, headRef: "feature/cart", isAgent: false })];

    const body = rewrittenBodyOf(planFor(auditFinished(output), auditRunSnapshotOf(named), kitConfig()));

    expect(introducedByLines(body)).toEqual(["**Introduced by:** No merged agent PR"]);
    const prefilled = issueLinks(body)[0]?.searchParams.get("body") ?? "";
    expect(prefilled).toMatch(/\n\nFrom audit #97$/);
    expect(prefilled).not.toContain("fabrik:escape");
  });

  it("cuts a long candidate short to fit GitHub's URL limit, keeping its whole trailer, while the Audit shows all of it", () => {
    const long = "word ".repeat(3000).trim();
    const output = {
      candidates: [aCandidate({ problem: long, solution: long, introducedBy: [31, 32] })],
      topRecommendation: "Make the cart module deeper",
    };
    const named = [aNamedPullRequest({ number: 31 }), aNamedPullRequest({ number: 32, headRef: "fabrik/ticket-8" })];

    const body = rewrittenBodyOf(planFor(auditFinished(output), auditRunSnapshotOf(named), kitConfig()));

    const [link] = issueLinks(body);
    expect(link?.href.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    expect(link?.searchParams.get("body")).toMatch(
      /^\*\*Files:\*\* `src\/cart\.ts`, `src\/cart\/total\.ts`\n\n\*\*Problem:\*\* word word .*…\n\nFrom audit #97\n<!-- fabrik:escape strong #31 #32 -->$/s,
    );
    expect(body).toContain(`**Problem:** ${long}`);
    expect(body).toContain(`**Solution:** ${long}`);
  });

  it("files an issue whose escape marker reads back as the candidate's Strength and kept PRs, for every Strength", () => {
    const output = {
      candidates: [
        aCandidate({ title: "One", strength: "strong", introducedBy: [31] }),
        aCandidate({ title: "Two", strength: "worth-exploring", introducedBy: [32, 31] }),
        aCandidate({ title: "Three", strength: "speculative", introducedBy: [32] }),
      ],
      topRecommendation: "One",
    };

    const links = linksFrom(output, [aNamedPullRequest({ number: 31 }), aNamedPullRequest({ number: 32, headRef: "fabrik/ticket-8" })]);

    expect(links.map((link) => escapeMarkerIn(link.searchParams.get("body") ?? ""))).toEqual([
      { strength: "strong", pullRequests: [31] },
      { strength: "worth-exploring", pullRequests: [32, 31] },
      { strength: "speculative", pullRequests: [32] },
    ]);
  });

  it("files issues that the next Audit's inputs read back as filed from this Audit", () => {
    const output = {
      candidates: [aCandidate({ title: "One", introducedBy: [31] }), aCandidate({ title: "Two", introducedBy: [] })],
      topRecommendation: "One",
    };

    const links = linksFrom(output);

    expect(links.map((link) => fromAuditIn(link.searchParams.get("body") ?? ""))).toEqual([97, 97]);
  });

  it("files an issue that keeps its From audit line and escape marker when a Design session rewrites it, so it still counts", () => {
    const [link] = linksFrom({ candidates: [aCandidate({ introducedBy: [31] })], topRecommendation: "Make the cart module deeper" });
    const filed = anIssue({ number: 120, labels: ["enhancement", "needs-design"], body: link?.searchParams.get("body") ?? "" });
    const operatorBrief = {
      kind: "brief",
      comment: "This is all Operator work.",
      brief: { operator: true, summary: "Merge the cart modules by hand.", steps: ["Move total() into cart"] },
    };

    const plan = planFor(
      { kind: "agent-run-finished", role: "design", issue: 120, output: JSON.stringify(operatorBrief) },
      snapshotOf(filed, { operator: "jrey" }),
      kitConfig(),
    );

    const rewritten = rewrittenBodyOf(plan);
    expect(rewritten).toContain("Merge the cart modules by hand.");
    expect(rewritten.split("\n").slice(-2)).toEqual(["From audit #97", "<!-- fabrik:escape strong #31 -->"]);
    expect(escapeMarkerIn(rewritten)).toEqual({ strength: "strong", pullRequests: [31] });
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
  it("mentions nobody from any text the Auditor wrote, on the Audit or in the issue a candidate files", () => {
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
    // Nor does the issue a candidate's Open as issue link files.
    const link = new URL(/\[Open as issue\]\(([^)\s]+)\)/.exec(body)?.[1] ?? "");
    expect(link.searchParams.get("title")).toBe("Ask @\u200balice about the cart");
    expect(link.searchParams.get("body")).not.toMatch(/@(alice|bob|carol|dave|erin|frank|grace|heidi)/);
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

  it("files the cards Strongest first, whatever order the Auditor gave them, keeping its order among candidates of one Strength", () => {
    /** The cards' titles, in the order the Audit files them, for candidates One, Two and Three of these Strengths. */
    const cardsFor = (...strengths: string[]) => {
      const candidates = ["One", "Two", "Three"].map((title, i) => aCandidate({ title, strength: strengths[i] }));
      const plan = planFor(auditFinished({ candidates, topRecommendation: "Start with One" }), auditRunSnapshotOf(), kitConfig());
      return rewrittenBodyOf(plan).match(/^## (One|Two|Three)$/gm);
    };

    expect(cardsFor("speculative", "worth-exploring", "strong")).toEqual(["## Three", "## Two", "## One"]);
    expect(cardsFor("strong", "worth-exploring", "strong")).toEqual(["## One", "## Three", "## Two"]);
  });

  it("takes a Top recommendation that names its candidate in any case", () => {
    const plan = planFor(auditFinished({ candidates: [aCandidate()], topRecommendation: "Start by making the cart module deeper? No: make the cart module deeper." }), auditRunSnapshotOf(), kitConfig());

    expect(plan.kind).toBe("act");
  });
});
