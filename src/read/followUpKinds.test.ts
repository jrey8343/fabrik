// A row's Follow-ups by kind (#885): each carries whether it is a fault or
// an idea, and on a merged pull request's row a fault's `filedAs` names the
// issue the Kit opened for it at the merge.
import { describe, expect, it } from "vitest";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import type { CommentFacts } from "../kit/weeklySummary.ts";
import { followUpsSection, type NamedFollowUp } from "../loop/followUps.ts";
import { FOLLOW_UPS_OPENED_MARKER, followUpLeftLine, followUpOpenedLine } from "../loop/markers.ts";
import { aComment, aMergedLastDay, anOpenIssue, anOpenPullRequest, aVerdictComment, factsOf, homeFactsOf } from "./builders.ts";
import type { Facts } from "./gather.ts";
import { mergedFollowUpsOf } from "./related.ts";
import { type Row, rowsOf } from "./rows.ts";

const NOW = "2026-11-09T12:00:00Z";
const HEAD = "h".repeat(40);
const REPO = "https://github.com/owner/product";

const BADGE = { kind: "fault", title: "The badge miscounts", body: "`badge.ts:14` reads a stale count." } as const;
const FOOTER = { kind: "fault", title: "The footer test is skipped", body: "`footer.test.ts:3` is `it.skip`." } as const;
const MONEY = { kind: "idea", title: "Extract the money type", body: "The cart and the till both round." } as const;

/** The Fabrik App's Verdict on pull request 50 at `at`, listing these Follow-ups. */
const verdictListing = (verdict: "pass" | "execution-flaw", at: string, followUps: readonly NamedFollowUp[], overrides: Partial<CommentFacts> = {}): CommentFacts => {
  const comment = aVerdictComment(verdict, HEAD, at, overrides);
  return { ...comment, body: [comment.body, ...followUpsSection(followUps, REPO, 50)].join("\n") };
};

/** The Kit's comment on merged pull request 50, recording each fault it opened, with the issue, and each it left a link. */
const faultsComment = (opened: readonly (readonly [number, string])[], left: readonly string[] = [], overrides: Partial<CommentFacts> = {}): CommentFacts =>
  aComment(
    [
      FOLLOW_UPS_OPENED_MARKER,
      ...opened.map(([issue, title]) => followUpOpenedLine({ created: "opened" }, title).map((part) => (typeof part === "string" ? part : `#${issue}`)).join("")),
      ...left.map(followUpLeftLine),
      "This pull request merged, so the Kit opened each of these faults its passes named as an issue, which enters at Triage (ADR-0039):",
    ].join("\n"),
    "2026-11-09T11:31:00Z",
    overrides,
  );

/** A repo that declares where production is, so a merged pull request has a row. */
const WITH_PRODUCTION = { repo: "owner/product", branch: "main", config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, production: { url: "https://shop.example", environment: "production" } } }, dispatch: null } as const;

const rowOf50 = (facts: Facts): Row | undefined => rowsOf(facts, null, null, null, NOW).find(({ standing }) => standing.pullRequest === 50);

describe("an open pull request's Follow-ups, by kind (#885)", () => {
  it("each carry the kind its pass gave it, one given none an idea, and none is filed while nothing related has its title", () => {
    const pass = verdictListing("pass", "2026-11-09T10:00:00Z", [BADGE, MONEY, { title: "Tidy the cart", body: "" }]);
    const facts = homeFactsOf({
      github: factsOf({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, draft: false, headSha: HEAD, comments: [pass] })] }),
    });

    // In the order the Verdict comment lists them: its ideas, then its faults.
    expect(rowOf50(facts)?.followUps).toEqual([
      { title: MONEY.title, body: MONEY.body, kind: "idea", filedAs: null },
      { title: "Tidy the cart", body: "", kind: "idea", filedAs: null },
      { title: BADGE.title, body: BADGE.body, kind: "fault", filedAs: null },
    ]);
  });
});

describe("what a merged pull request's comments say of its Follow-ups (#885)", () => {
  it("is the Follow-ups its last Verdict named, when that is a pass, and each fault the Kit opened as an issue", () => {
    const comments = [verdictListing("pass", "2026-11-09T09:00:00Z", [MONEY]), verdictListing("pass", "2026-11-09T10:00:00Z", [BADGE, MONEY, FOOTER]), faultsComment([[101, BADGE.title]], [FOOTER.title])];

    expect(mergedFollowUpsOf(50, comments)).toEqual({ pullRequest: 50, named: [MONEY, BADGE, FOOTER], opened: [{ issue: 101, title: BADGE.title }] });
  });

  it("is nothing when its last Verdict is no pass, or its pass named none", () => {
    expect(mergedFollowUpsOf(50, [verdictListing("pass", "2026-11-09T09:00:00Z", [BADGE]), verdictListing("execution-flaw", "2026-11-09T10:00:00Z", [BADGE])])).toBeNull();
    expect(mergedFollowUpsOf(50, [verdictListing("pass", "2026-11-09T10:00:00Z", [])])).toBeNull();
    expect(mergedFollowUpsOf(50, [])).toBeNull();
  });

  it("is read from a bot's comments alone: a person quoting a pass names none, and one quoting the Kit's comment opened none", () => {
    const person = { author: "someone", byBot: false };

    expect(mergedFollowUpsOf(50, [verdictListing("pass", "2026-11-09T10:00:00Z", [BADGE], person)])).toBeNull();
    expect(mergedFollowUpsOf(50, [verdictListing("pass", "2026-11-09T10:00:00Z", [BADGE]), faultsComment([[666, BADGE.title]], [], person)])).toEqual({ pullRequest: 50, named: [BADGE], opened: [] });
  });
});

describe("a merged pull request's Follow-ups (#885)", () => {
  const merged = (overrides: Partial<Omit<Facts, "kind">> = {}): Facts =>
    homeFactsOf({
      kit: WITH_PRODUCTION,
      mergedLastDay: [aMergedLastDay("2026-11-09T11:30:00Z")],
      mergedFollowUps: [{ pullRequest: 50, named: [BADGE, MONEY, FOOTER], opened: [{ issue: 101, title: ` ${BADGE.title} ` }] }],
      ...overrides,
    });

  it("are on its row, each with its kind, a fault's filedAs naming the issue the Kit opened for it at the merge", () => {
    expect(rowOf50(merged())?.followUps).toEqual([
      { title: BADGE.title, body: BADGE.body, kind: "fault", filedAs: 101 },
      { title: MONEY.title, body: MONEY.body, kind: "idea", filedAs: null },
      { title: FOOTER.title, body: FOOTER.body, kind: "fault", filedAs: null },
    ]);
  });

  it("name the open issue the Operator opened from a link, by its From PR line and its title, for an idea or a fault left over the cap", () => {
    const facts = merged({
      github: factsOf({
        openIssues: [
          anOpenIssue({ number: 90, title: MONEY.title, author: "operator", labels: ["needs-triage"] }),
          anOpenIssue({ number: 91, title: FOOTER.title, author: "operator", labels: ["needs-triage"] }),
          anOpenIssue({ number: 92, title: FOOTER.title, author: "someone", labels: ["needs-triage"] }),
        ],
      }),
      issueBodies: [
        { issue: 90, body: "The cart and the till both round.\n\nFrom PR #50" },
        { issue: 91, body: "Skipped.\n\nFrom PR #49" },
      ],
    });

    expect(rowOf50(facts)?.followUps.map(({ title, filedAs }) => [title, filedAs])).toEqual([
      [BADGE.title, 101],
      [MONEY.title, 90],
      [FOOTER.title, null],
    ]);
  });

  it("are none on the row of one whose comments named none, and none in facts kept before a gather read them", () => {
    const { mergedFollowUps: _none, ...keptBefore } = merged();

    expect(rowOf50(merged({ mergedFollowUps: [] }))?.followUps).toEqual([]);
    expect(rowOf50(keptBefore as Facts)?.followUps).toEqual([]);
  });

  it("survive a JSON round trip", () => {
    const rows = rowsOf(merged(), null, null, null, NOW);

    expect(JSON.parse(JSON.stringify(rows))).toStrictEqual(rows);
  });
});
