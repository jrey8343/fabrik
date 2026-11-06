import { describe, expect, it } from "vitest";
import { kitConfig, notificationsOf, RETRO_WINDOW_END, retroBody, retroRunSnapshotOf } from "../__fixtures__/snapshots.ts";
import type { EvidenceRef, StreakRow } from "../kit/retroEvidence.ts";
import { MAX_ISSUE_URL_LENGTH } from "./followUps.ts";
import { fromAuditIn, fromPullRequestIn, fromRetroIn, linesOutsideCode, retroMarksIn } from "./markers.ts";
import { planFor } from "./rules.ts";
import type { LoopEvent, Plan, RetroEvidence } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

/** Where a file in the fabrik-runs store opens on GitHub. */
const STORE = "https://github.com/jrey8343/fabrik-runs/blob/HEAD";

/** The passing Review run on #140 that missed escape #212, and its transcript. */
const REVIEW_RECORD = "runs/acme/shop/2026-10/88123-1-review.json";
const REVIEW_TRANSCRIPT = "transcripts/acme/shop/2026-10/88123-1-review.jsonl.gz";

/** The 20 docs-only PRs merged since the tightening a loosening undoes, none of them flagged. */
const DOCS_STREAK = Array.from({ length: 20 }, (_, i) => 141 + i);

/** An agent PR in the streak table: by default merged in the 90 days and flagged for nothing. */
function aStreakRow(number: number, overrides: Partial<StreakRow> = {}): StreakRow {
  return {
    ref: `#${number}`,
    number,
    title: `Agent PR ${number}`,
    mergedAt: "2026-10-20T00:00:00Z",
    paths: ["docs/guide.md"],
    escaped: false,
    reverted: false,
    requestChanges: false,
    ...overrides,
  };
}

const pullRequestRef = (number: number): EvidenceRef => ({ ref: `#${number}`, kind: "pull-request" });

/**
 * What Retro #120 was given, as the push job re-reads it from the evidence
 * artifact: escape #212 against #140, whose Ticket is #7 and whose passing
 * Review run is REVIEW_RECORD; the Operator's feedback on #131 and #137;
 * #97, filed from an earlier Retro; and a streak table holding #140, flagged
 * as escaped, and DOCS_STREAK.
 */
function anEvidence(overrides: Partial<RetroEvidence> = {}): RetroEvidence {
  return {
    window: { start: "2026-10-24T06:00:00.000Z", end: RETRO_WINDOW_END },
    refs: [
      { ref: "#212", kind: "escape" },
      pullRequestRef(140),
      { ref: "#7", kind: "issue" },
      { ref: REVIEW_RECORD, kind: "record" },
      pullRequestRef(131),
      pullRequestRef(137),
      ...DOCS_STREAK.map(pullRequestRef),
      { ref: "#97", kind: "issue" },
    ],
    streakTable: [aStreakRow(140, { escaped: true, paths: ["src/routes/cart.ts"] }), ...DOCS_STREAK.map((number) => aStreakRow(number))],
    transcripts: { [REVIEW_RECORD]: REVIEW_TRANSCRIPT },
    ...overrides,
  };
}

/** Retro #120's run finished with this `<retro>` JSON, or this text when it's a string. */
function retroFinished(output: unknown, evidence: RetroEvidence = anEvidence()): LoopEvent {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return { kind: "retro-run-finished", issue: 120, output: text, evidence, runUrl: RUN, repoUrl: "https://github.com/acme/shop" };
}

/** A tightening as the Retro writes it: by default a lint rule for escape #212, citing it, #140 and the Review run that passed #140. */
function aTightening(overrides: Record<string, unknown> = {}) {
  return {
    title: "Fail the lint when a route handler imports the database client",
    problem: "Escape #212 traced a route handler querying the database directly to #140. No check forbids it.",
    change: "In `eslint.config.js`, add a `no-restricted-imports` rule to the `src/routes/**` block that forbids `pg`.",
    kind: "mechanical",
    direction: "tighten",
    target: "product-code",
    evidence: ["#212", "#140", REVIEW_RECORD],
    ...overrides,
  };
}

/** A loosening as the Retro writes it: by default undoing #97 on DOCS_STREAK, citing two of its PRs. */
function aLoosening(overrides: Record<string, unknown> = {}) {
  return {
    title: "Let docs-only Tickets skip the end-to-end suite",
    problem: "#97 had the Implementer run `npm run e2e` before every PR, and docs-only PRs spent most of their run on it.",
    change: 'In `.fabrik/implement.md`, replace "Run `npm run e2e`." with "Run `npm run e2e`, unless the PR changes only `docs/`."',
    kind: "judgement",
    direction: "loosen",
    target: "product-trust-root",
    evidence: ["#141", "#142"],
    streak: { pullRequests: DOCS_STREAK, kind: "agent PRs that change only Markdown under docs/" },
    undoes: "#97",
    ...overrides,
  };
}

/** The Open as issue link to this new-issue form, prefilled with this title, this body and, when given, these labels. */
function openAsIssue(form: string, title: string, body: readonly string[], labels?: string): string {
  return `[Open as issue](${form}?${new URLSearchParams({ title, body: body.join("\n"), ...(labels === undefined ? {} : { labels }) })})`;
}

describe("Landing a Retro: a full Retro", () => {
  it("rewrites the pending Retro into a card per proposal, with its badges, problem, evidence as links and change, a loosening's streak and what it undoes, and its Open as issue link", () => {
    const plan = planFor(retroFinished({ proposals: [aTightening(), aLoosening()] }), retroRunSnapshotOf(), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "edit-issue-body",
          issue: 120,
          body: [
            "The Retro read the factory's runs from 2026-10-24 06:00 UTC to 2026-10-31 06:00 UTC. File the proposals you want, comment here on any you reject so the next Retro knows, and close this Retro when you're done: as completed if you filed any, as not planned if you didn't.",
            "",
            "## Fail the lint when a route handler imports the database client",
            "",
            "`Mechanical` `Tighten`",
            "",
            "**Problem**",
            "",
            "Escape #212 traced a route handler querying the database directly to #140. No check forbids it.",
            "",
            "**Evidence**",
            "",
            "- [#212](https://github.com/acme/shop/issues/212)",
            "- [#140](https://github.com/acme/shop/pull/140)",
            `- [\`${REVIEW_RECORD}\`](${STORE}/${REVIEW_RECORD}), with its [transcript](${STORE}/${REVIEW_TRANSCRIPT})`,
            "",
            "**Change**",
            "",
            "In `eslint.config.js`, add a `no-restricted-imports` rule to the `src/routes/**` block that forbids `pg`.",
            "",
            openAsIssue("https://github.com/acme/shop/issues/new", "Fail the lint when a route handler imports the database client", [
              "**Problem**",
              "",
              "Escape #212 traced a route handler querying the database directly to #140. No check forbids it.",
              "",
              "**Change**",
              "",
              "In `eslint.config.js`, add a `no-restricted-imports` rule to the `src/routes/**` block that forbids `pg`.",
              "",
              "**Evidence**",
              "",
              "- [#212](https://github.com/acme/shop/issues/212)",
              "- [#140](https://github.com/acme/shop/pull/140)",
              `- [\`${REVIEW_RECORD}\`](${STORE}/${REVIEW_RECORD}), with its [transcript](${STORE}/${REVIEW_TRANSCRIPT})`,
              "",
              "From retro #120",
            ]),
            "",
            "## Let docs-only Tickets skip the end-to-end suite",
            "",
            "`Judgement` `Loosen`",
            "",
            "**Problem**",
            "",
            "#97 had the Implementer run `npm run e2e` before every PR, and docs-only PRs spent most of their run on it.",
            "",
            "**Evidence**",
            "",
            "- [#141](https://github.com/acme/shop/pull/141)",
            "- [#142](https://github.com/acme/shop/pull/142)",
            "",
            "**Change**",
            "",
            'In `.fabrik/implement.md`, replace "Run `npm run e2e`." with "Run `npm run e2e`, unless the PR changes only `docs/`."',
            "",
            `**Streak:** 20 merged agent PRs (agent PRs that change only Markdown under docs/), none of them named in an escape, reverted or sent back with Request changes: ${DOCS_STREAK.map((n) => `[#${n}](https://github.com/acme/shop/pull/${n})`).join(", ")}`,
            "",
            "**Undoes:** #97",
            "",
            openAsIssue(
              "https://github.com/acme/shop/issues/new",
              "Let docs-only Tickets skip the end-to-end suite",
              [
                "## Operator brief",
                "",
                "**Problem**",
                "",
                "#97 had the Implementer run `npm run e2e` before every PR, and docs-only PRs spent most of their run on it.",
                "",
                "**Change**",
                "",
                'In `.fabrik/implement.md`, replace "Run `npm run e2e`." with "Run `npm run e2e`, unless the PR changes only `docs/`."',
                "",
                "**Evidence**",
                "",
                "- [#141](https://github.com/acme/shop/pull/141)",
                "- [#142](https://github.com/acme/shop/pull/142)",
                "",
                "## Steps",
                "",
                "- [ ] Make the change above",
                "",
                "From retro #120",
              ],
              "ready-for-human",
            ),
            "",
            `<!-- fabrik:retro ${RETRO_WINDOW_END} -->`,
          ].join("\n"),
        },
      ],
    });
  });
});

/** The plan's new body for the Retro, from its one edit-issue-body action. */
function rewrittenBodyOf(plan: Plan): string {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  const edits = plan.actions.flatMap((action) => (action.kind === "edit-issue-body" ? [action.body] : []));
  if (edits.length !== 1) throw new Error(`expected one body edit, got ${JSON.stringify(plan.actions)}`);
  return edits[0]!;
}

/** The refs each card's Evidence lists, card by card, as their links read. */
function evidenceOf(plan: Plan): string[][] {
  return rewrittenBodyOf(plan)
    .split("**Evidence**\n\n")
    .slice(1)
    .map((after) => after.split("\n\n")[0]!.split("\n").map((line) => /^- \[`?([^`\]]+)`?\]/.exec(line)?.[1] ?? line));
}

describe("Landing a Retro: the evidence", () => {
  it("drops each ref the evidence bundle doesn't hold, and lists each one it does once", () => {
    const evidence = ["#212", "#404", "runs/acme/shop/2026-10/99999-1-review.json", "#140", "#140", REVIEW_RECORD, "#212"];

    const plan = planFor(retroFinished({ proposals: [aTightening({ evidence })] }), retroRunSnapshotOf(), kitConfig());

    expect(evidenceOf(plan)).toEqual([["#212", "#140", REVIEW_RECORD]]);
  });

  it("keeps a score file the bundle holds, linked to its file in the store", () => {
    const score = "scores/acme/shop/2026-10/88124-1-implement-0a1b2c3d.json";

    const plan = planFor(
      retroFinished({ proposals: [aTightening({ evidence: ["#212", score] })] }, anEvidence({ refs: [...anEvidence().refs, { ref: score, kind: "score" }] })),
      retroRunSnapshotOf(),
      kitConfig(),
    );

    expect(rewrittenBodyOf(plan)).toContain(`- [#212](https://github.com/acme/shop/issues/212)\n- [\`${score}\`](${STORE}/${score})\n`);
  });

  it("links an issue the bundle holds to itself, and a Run record with no transcript to its file alone", () => {
    const plan = planFor(
      retroFinished({ proposals: [aTightening({ evidence: ["#212", "#7", "#131", REVIEW_RECORD] })] }, anEvidence({ transcripts: {} })),
      retroRunSnapshotOf(),
      kitConfig(),
    );

    expect(rewrittenBodyOf(plan)).toContain(
      [
        "**Evidence**",
        "",
        "- [#212](https://github.com/acme/shop/issues/212)",
        "- [#7](https://github.com/acme/shop/issues/7)",
        "- [#131](https://github.com/acme/shop/pull/131)",
        `- [\`${REVIEW_RECORD}\`](${STORE}/${REVIEW_RECORD})`,
        "",
      ].join("\n"),
    );
  });
});

describe("Landing a Retro: the Open as issue link", () => {
  /** Each Open as issue link in a Retro's body, read back as the new-issue form it opens. */
  function issueLinks(body: string): URL[] {
    return [...body.matchAll(/\[Open as issue\]\(([^)\s]+)\)/g)].map((match) => new URL(match[1]!));
  }

  /** The new-issue form each card's link opens, from the filled Retro these proposals land as. */
  function linksFrom(proposals: Record<string, unknown>[], config = kitConfig()): URL[] {
    return issueLinks(rewrittenBodyOf(planFor(retroFinished({ proposals }), retroRunSnapshotOf(), config)));
  }

  /** The form a link opens, its query left out. */
  const formOf = (link: URL | undefined) => (link === undefined ? undefined : `${link.origin}${link.pathname}`);

  it("ends a product-code proposal's card with a link to the Product repo's new-issue form, with no label so it goes through Intake and Triage, prefilled with its title, problem, change and evidence, then the Retro it came from", () => {
    const [link, ...others] = linksFrom([aTightening()]);

    expect(others).toEqual([]);
    expect(formOf(link)).toBe("https://github.com/acme/shop/issues/new");
    expect(link?.searchParams.has("labels")).toBe(false);
    expect(link?.searchParams.get("title")).toBe("Fail the lint when a route handler imports the database client");
    expect(link?.searchParams.get("body")).toBe(
      [
        "**Problem**",
        "",
        "Escape #212 traced a route handler querying the database directly to #140. No check forbids it.",
        "",
        "**Change**",
        "",
        "In `eslint.config.js`, add a `no-restricted-imports` rule to the `src/routes/**` block that forbids `pg`.",
        "",
        "**Evidence**",
        "",
        "- [#212](https://github.com/acme/shop/issues/212)",
        "- [#140](https://github.com/acme/shop/pull/140)",
        `- [\`${REVIEW_RECORD}\`](${STORE}/${REVIEW_RECORD}), with its [transcript](${STORE}/${REVIEW_TRANSCRIPT})`,
        "",
        "From retro #120",
      ].join("\n"),
    );
  });

  it("links a product-trust-root proposal to the Product repo's form with ready-for-human, as an Operator brief carrying the exact edit, so it skips Triage for a Pairing session", () => {
    const change = "In `AGENTS.md`, under `## Routes`, add:\n\n```md\n- A route handler never imports `pg`; it calls a module in `src/db/`.\n```";

    const [link] = linksFrom([aTightening({ kind: "judgement", target: "product-trust-root", change })]);

    expect(formOf(link)).toBe("https://github.com/acme/shop/issues/new");
    expect(link?.searchParams.get("labels")).toBe("ready-for-human");
    expect(link?.searchParams.get("title")).toBe("Fail the lint when a route handler imports the database client");
    expect(link?.searchParams.get("body")).toBe(
      [
        "## Operator brief",
        "",
        "**Problem**",
        "",
        "Escape #212 traced a route handler querying the database directly to #140. No check forbids it.",
        "",
        "**Change**",
        "",
        "In `AGENTS.md`, under `## Routes`, add:",
        "",
        "```md",
        "- A route handler never imports `pg`; it calls a module in `src/db/`.",
        "```",
        "",
        "**Evidence**",
        "",
        "- [#212](https://github.com/acme/shop/issues/212)",
        "- [#140](https://github.com/acme/shop/pull/140)",
        `- [\`${REVIEW_RECORD}\`](${STORE}/${REVIEW_RECORD}), with its [transcript](${STORE}/${REVIEW_TRANSCRIPT})`,
        "",
        "## Steps",
        "",
        "- [ ] Make the change above",
        "",
        "From retro #120",
      ].join("\n"),
    );
  });

  it("links a kit proposal to the Kit's own repo's new-issue form, with no label, prefilled with its title, problem, change and evidence, then the Retro it came from", () => {
    const change = "In `prompts/review.md`, add to the checks: a route handler that imports `pg` is an Execution flaw.";

    const [link] = linksFrom([aTightening({ kind: "judgement", target: "kit", change })]);

    expect(formOf(link)).toBe("https://github.com/jrey8343/fabrik/issues/new");
    expect(link?.searchParams.has("labels")).toBe(false);
    expect(link?.searchParams.get("title")).toBe("Fail the lint when a route handler imports the database client");
    expect(link?.searchParams.get("body")).toBe(
      [
        "**Problem**",
        "",
        "Escape #212 traced a route handler querying the database directly to #140. No check forbids it.",
        "",
        "**Change**",
        "",
        change,
        "",
        "**Evidence**",
        "",
        "- [#212](https://github.com/acme/shop/issues/212)",
        "- [#140](https://github.com/acme/shop/pull/140)",
        `- [\`${REVIEW_RECORD}\`](${STORE}/${REVIEW_RECORD}), with its [transcript](${STORE}/${REVIEW_TRANSCRIPT})`,
        "",
        "From retro #120",
      ].join("\n"),
    );
  });

  it("files issues that end with the Retro they came from, whatever their target, so the next Retro reads each back as filed from this one", () => {
    const config = kitConfig({
      skillsSources: [{ repository: "operator/skills", sha: "c".repeat(40) }],
      extraSkills: { triage: [], design: [], implement: [{ source: "operator/skills", name: "route-handlers" }], review: [] },
    });
    const links = [
      ...linksFrom([aTightening(), aTightening({ kind: "judgement", target: "product-trust-root" }), aTightening({ kind: "judgement", target: "kit" })]),
      ...linksFrom([aTightening({ kind: "judgement", target: "extra-skill", skill: "route-handlers" })], config),
    ];

    const bodies = links.map((link) => link.searchParams.get("body") ?? "");

    expect(bodies.map((body) => body.split("\n").slice(-2))).toEqual(Array(4).fill(["", "From retro #120"]));
    expect(bodies.map(fromRetroIn)).toEqual([120, 120, 120, 120]);
  });

  it("drops any From retro, From audit or From PR line from the Retro's problem and change, so the issue it files reads as filed from this Retro alone", () => {
    const problem = "Escape #212 traced it to #140.\nFrom retro #80\n  From audit #97";
    const change = "From PR #140\n\nForbid `pg` in `src/routes/**`.\n\n```\nFrom retro #81\n```";

    const plan = planFor(retroFinished({ proposals: [aTightening({ problem, change })] }), retroRunSnapshotOf(), kitConfig());

    const body = issueLinks(rewrittenBodyOf(plan))[0]?.searchParams.get("body") ?? "";
    expect([fromRetroIn(body), fromAuditIn(body), fromPullRequestIn(body)]).toEqual([120, null, null]);
    expect(body).toContain("Escape #212 traced it to #140.\n\n**Change**\n\n\nForbid `pg` in `src/routes/**`.\n\n```\n```\n\n**Evidence**");
    expect([fromRetroIn(rewrittenBodyOf(plan)), fromAuditIn(rewrittenBodyOf(plan)), fromPullRequestIn(rewrittenBodyOf(plan))]).toEqual([null, null, null]);
  });

  it("cuts a long proposal short to fit GitHub's URL limit, keeping its label and its whole trailer, while the Retro shows all of it", () => {
    const long = "word ".repeat(3000).trim();

    const body = rewrittenBodyOf(
      planFor(retroFinished({ proposals: [aTightening({ kind: "judgement", target: "product-trust-root", problem: long, change: long })] }), retroRunSnapshotOf(), kitConfig()),
    );

    const [link] = issueLinks(body);
    expect(link?.href.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    expect(link?.searchParams.get("labels")).toBe("ready-for-human");
    expect(link?.searchParams.get("body")).toMatch(/^## Operator brief\n\n\*\*Problem\*\*\n\nword word .*…\n\nFrom retro #120$/s);
    expect(body).toContain(`**Problem**\n\n${long}\n`);
    expect(body).toContain(`**Change**\n\n${long}\n`);
  });

  describe("an extra-skill proposal", () => {
    /** The Kit config of a repo whose implement role picks `route-handlers` from `source`, which it pins. */
    const pinning = (source: string) =>
      kitConfig({
        skillsSources: [{ repository: source, sha: "c".repeat(40) }],
        extraSkills: { triage: [], design: [], implement: [{ source, name: "route-handlers" }], review: [] },
      });
    const change = "In `route-handlers/SKILL.md`, add: a handler calls a module in `src/db/`, never `pg` itself.";
    const extraSkill = (skill = "route-handlers") => aTightening({ kind: "judgement", target: "extra-skill", skill, change });

    it("links to its Skills source's new-issue form, with no label, when the repo pins the skill from a source the Operator owns", () => {
      const [link] = linksFrom([extraSkill()], pinning("operator/skills"));

      expect(formOf(link)).toBe("https://github.com/operator/skills/issues/new");
      expect(link?.searchParams.has("labels")).toBe(false);
      expect(link?.searchParams.get("title")).toBe("Fail the lint when a route handler imports the database client");
      expect(link?.searchParams.get("body")).toBe(
        [
          "**Problem**",
          "",
          "Escape #212 traced a route handler querying the database directly to #140. No check forbids it.",
          "",
          "**Change**",
          "",
          change,
          "",
          "**Evidence**",
          "",
          "- [#212](https://github.com/acme/shop/issues/212)",
          "- [#140](https://github.com/acme/shop/pull/140)",
          `- [\`${REVIEW_RECORD}\`](${STORE}/${REVIEW_RECORD}), with its [transcript](${STORE}/${REVIEW_TRANSCRIPT})`,
          "",
          "From retro #120",
        ].join("\n"),
      );
    });

    it.each([
      ["the Product repo's owner, as an organization's repo pins its own skills", "acme/skills", "https://github.com/acme/skills/issues/new"],
      ["the Operator, whatever case the lockfile spells their login in", "Operator/skills", "https://github.com/Operator/skills/issues/new"],
    ])("links to a Skills source owned by %s", (_, source, form) => {
      expect(linksFrom([extraSkill()], pinning(source)).map(formOf)).toEqual([form]);
    });

    it("finds the skill by its pick, owner/name/skill, as the Kit config writes it, as well as by its name", () => {
      expect(linksFrom([extraSkill("operator/skills/route-handlers")], pinning("operator/skills")).map(formOf)).toEqual([
        "https://github.com/operator/skills/issues/new",
      ]);
    });

    /** The filled Retro's body for this extra-skill proposal, given this Kit config. */
    const filed = (proposal: Record<string, unknown>, config: ReturnType<typeof kitConfig>) =>
      rewrittenBodyOf(planFor(retroFinished({ proposals: [proposal] }), retroRunSnapshotOf(), config));

    it("gives no link when the skill comes from a Skills source the Operator doesn't own, and says to unpin or replace the skill instead", () => {
      const body = filed(extraSkill(), pinning("someone/skills"));

      expect(issueLinks(body)).toEqual([]);
      expect(body.split("\n").slice(-3)).toEqual([
        "**No Open as issue link:** this repo pins `route-handlers` from someone/skills, a Skills source the Operator doesn't own. Unpin or replace the skill.",
        "",
        `<!-- fabrik:retro ${RETRO_WINDOW_END} -->`,
      ]);
    });

    it("gives no link to a skill the repo doesn't pin, and says to unpin or replace the skill instead", () => {
      const body = filed(extraSkill("booking-rules"), pinning("operator/skills"));

      expect(issueLinks(body)).toEqual([]);
      expect(body).toContain(
        '**Change**\n\n' + change + '\n\n**No Open as issue link:** this repo pins no Extra skill named "booking-rules". Unpin or replace the skill.\n',
      );
    });

    it("lists each proposal left with no link in the run's step summary", () => {
      const plan = planFor(
        retroFinished({ proposals: [extraSkill(), aTightening(), extraSkill("booking-rules")] }),
        retroRunSnapshotOf(),
        pinning("someone/skills"),
      );

      expect(plan.kind === "act" ? plan.notes : undefined).toEqual([
        'No Open as issue link for "Fail the lint when a route handler imports the database client": this repo pins `route-handlers` from someone/skills, a Skills source the Operator doesn\'t own',
        'No Open as issue link for "Fail the lint when a route handler imports the database client": this repo pins no Extra skill named "booking-rules"',
      ]);
    });
  });
});

/** The title of each card the plan's Retro files, in order. */
function cardTitlesOf(plan: Plan): string[] {
  return rewrittenBodyOf(plan)
    .split("\n")
    .flatMap((line) => (line.startsWith("## ") ? [line.slice(3)] : []));
}

describe("Landing a Retro: the one-off rule", () => {
  /** The cards filed for a Retro proposing the default tightening, then one titled "Under test" citing `evidence`. */
  const cardsCiting = (evidence: string[]) =>
    cardTitlesOf(
      planFor(
        retroFinished({ proposals: [aTightening(), aTightening({ title: "Under test", kind: "judgement", target: "kit", evidence })] }),
        retroRunSnapshotOf(),
        kitConfig(),
      ),
    );
  const KEPT = ["Fail the lint when a route handler imports the database client", "Under test"];
  const DROPPED = ["Fail the lint when a route handler imports the database client"];

  it("drops a proposal citing one PR and no escape, whatever else it cites", () => {
    expect(cardsCiting(["#140", "#7", REVIEW_RECORD])).toEqual(DROPPED);
  });

  it("keeps a proposal citing two distinct PRs", () => {
    expect(cardsCiting(["#131", "#137"])).toEqual(KEPT);
  });

  it("keeps a proposal citing one escape and nothing else", () => {
    expect(cardsCiting(["#212"])).toEqual(KEPT);
  });

  it("drops a proposal citing one PR twice", () => {
    expect(cardsCiting(["#131", "#131"])).toEqual(DROPPED);
  });

  it("counts only the refs the bundle holds: a proposal whose second PR or escape the bundle doesn't hold is dropped", () => {
    expect(cardsCiting(["#131", "#404"])).toEqual(DROPPED);
    expect(cardsCiting(["#131", "#213"])).toEqual(DROPPED);
  });

  it("takes an issue for no PR: a proposal citing one PR and one issue is dropped", () => {
    expect(cardsCiting(["#131", "#97"])).toEqual(DROPPED);
  });
});

describe("Landing a Retro: a loosening's streak", () => {
  /** The streak table, holding a reverted #161 and a Request-changed #162 beside #140, which escaped, and DOCS_STREAK. */
  const evidence = anEvidence({
    streakTable: [...anEvidence().streakTable, aStreakRow(161, { reverted: true }), aStreakRow(162, { requestChanges: true })],
  });
  /** The cards filed for a Retro proposing the default tightening, then the default loosening counting `pullRequests`. */
  const cardsCounting = (pullRequests: number[]) =>
    cardTitlesOf(
      planFor(
        retroFinished({ proposals: [aTightening(), aLoosening({ streak: { pullRequests, kind: "docs-only PRs" } })] }, evidence),
        retroRunSnapshotOf(),
        kitConfig(),
      ),
    );
  const KEPT = ["Fail the lint when a route handler imports the database client", "Let docs-only Tickets skip the end-to-end suite"];
  const DROPPED = ["Fail the lint when a route handler imports the database client"];

  it("keeps a loosening whose streak holds: 20 PRs, every one in the streak table and none flagged", () => {
    expect(cardsCounting(DOCS_STREAK)).toEqual(KEPT);
  });

  it("drops a loosening whose streak is too short", () => {
    expect(cardsCounting(DOCS_STREAK.slice(1))).toEqual(DROPPED);
  });

  it("counts each PR once: a streak of 20 that names one PR twice is too short", () => {
    expect(cardsCounting([...DOCS_STREAK.slice(1), 142])).toEqual(DROPPED);
  });

  it("shows a kept streak's PRs once each, however often the Retro counted them", () => {
    const plan = planFor(
      retroFinished({ proposals: [aLoosening({ streak: { pullRequests: [...DOCS_STREAK, 141], kind: "docs-only PRs" } })] }),
      retroRunSnapshotOf(),
      kitConfig(),
    );

    expect(rewrittenBodyOf(plan)).toContain(
      `**Streak:** 20 merged agent PRs (docs-only PRs), none of them named in an escape, reverted or sent back with Request changes: ${DOCS_STREAK.map((n) => `[#${n}](https://github.com/acme/shop/pull/${n})`).join(", ")}\n`,
    );
  });

  it.each([
    ["named in an escape", 140],
    ["reverted", 161],
    ["sent back with Request changes", 162],
    ["not in the streak table", 404],
  ])("drops a loosening whose streak counts a PR %s, however long the streak", (_, pullRequest) => {
    expect(cardsCounting([...DOCS_STREAK, pullRequest])).toEqual(DROPPED);
  });
});

describe("Landing a Retro: a clean one", () => {
  const CLEAN = {
    kind: "act",
    actions: [
      {
        kind: "edit-issue-body",
        issue: 120,
        body: [
          "The Retro read the factory's runs from 2026-10-24 06:00 UTC to 2026-10-31 06:00 UTC and has nothing to propose.",
          "",
          `<!-- fabrik:retro ${RETRO_WINDOW_END} -->`,
        ].join("\n"),
      },
      { kind: "close", issue: 120, reason: "completed" },
    ],
  };

  it("rewrites a Retro with no proposals to a one-line clean note, keeping its retro marker, and closes it as completed", () => {
    const plan = planFor(retroFinished({ proposals: [] }), retroRunSnapshotOf(), kitConfig());

    expect(plan).toEqual(CLEAN);
  });

  it("closes a Retro whose proposals the Kit all drops as clean too", () => {
    const output = { proposals: [aTightening({ evidence: ["#140", "#404"] }), aLoosening({ streak: { pullRequests: [141], kind: "docs-only PRs" } })] };

    const plan = planFor(retroFinished(output), retroRunSnapshotOf(), kitConfig());

    expect(plan).toMatchObject(CLEAN);
  });
});

describe("Landing a Retro: a stale result", () => {
  const STALE = { kind: "nothing", reason: "#120 is no longer a pending Retro, so its Retro run's result is stale" };

  it.each([
    ["the Operator closed the Retro", { open: false }],
    ["a person opened the issue", { byApp: false, author: "someone" }],
    ["the issue has lost fabrik:retro", { labels: [] }],
    ["the Retro is already filled", { body: retroBody(RETRO_WINDOW_END, "filled") }],
    ["the Retro's run already failed, though it was reopened", { body: retroBody(RETRO_WINDOW_END, "failed") }],
  ])("lands nothing when %s", (_, retro) => {
    const plan = planFor(retroFinished({ proposals: [aTightening()] }), retroRunSnapshotOf(retro), kitConfig());

    expect(plan).toEqual(STALE);
  });

  it("lands nothing on a closed Retro even when the reply breaks the contract, so closing a pending Retro cancels it", () => {
    const plan = planFor(retroFinished({ proposals: "none" }), retroRunSnapshotOf({ open: false }), kitConfig());

    expect(plan).toEqual(STALE);
  });
});

describe("Landing a Retro: a reply that breaks the contract", () => {
  const without = (field: string) => {
    const proposal: Record<string, unknown> = aTightening();
    delete proposal[field];
    return proposal;
  };
  const four = ["One", "Two", "Three", "Four"].map((title) => aTightening({ title }));

  it.each<[string, string]>([
    ["isn't JSON", "proposals: none"],
    ["isn't an object", JSON.stringify([aTightening()])],
    ["has no proposals list", JSON.stringify({})],
    ["has more than 3 proposals", JSON.stringify({ proposals: four })],
    ...["title", "problem", "change", "kind", "direction", "target", "evidence"].map(
      (field): [string, string] => [`leaves out a proposal's ${field}`, JSON.stringify({ proposals: [without(field)] })],
    ),
    ["proposes a mechanical change anywhere but product code", JSON.stringify({ proposals: [aTightening({ target: "kit" })] })],
    ["loosens on no streak", JSON.stringify({ proposals: [aLoosening({ streak: undefined })] })],
  ])("closes the Retro as failed, filing nothing, when the reply %s", (_, output) => {
    const plan = planFor(retroFinished(output), retroRunSnapshotOf(), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "edit-issue-body",
          issue: 120,
          body: expect.stringMatching(
            new RegExp(
              `^The Retro's run failed: its reply broke the Retro output contract \\(.+\\)\\. \\[The run\\]\\(${RUN}\\)\n\n<!-- fabrik:retro ${RETRO_WINDOW_END.replace(/\./g, "\\.")} -->\n<!-- fabrik:retro-failed -->$`,
            ),
          ),
        },
        { kind: "close", issue: 120, reason: "not_planned" },
      ],
    });
  });

  it("says on the failed Retro how the reply broke the contract, mentioning nobody", () => {
    const body = rewrittenBodyOf(planFor(retroFinished({ proposals: [aTightening({ kind: "@alice" })] }), retroRunSnapshotOf(), kitConfig()));

    expect(body.split("\n")[0]).toBe(
      `The Retro's run failed: its reply broke the Retro output contract (proposals[0].kind must be one of mechanical, judgement, not "@\u200balice"). [The run](${RUN})`,
    );
  });

  it("keeps the failed Retro's reason to one line when the reply it quotes runs over several", () => {
    const body = rewrittenBodyOf(planFor(retroFinished("Here is\nmy retro"), retroRunSnapshotOf(), kitConfig()));

    expect(body.split("\n")[0]).toMatch(/^The Retro's run failed: .*"Here is my retro" is not valid JSON\)\. \[The run\]/);
  });
});

describe("Landing a Retro: silent", () => {
  /** The filled Retro's body for these proposals, beside the default tightening. */
  const filled = (...proposals: Record<string, unknown>[]) =>
    rewrittenBodyOf(planFor(retroFinished({ proposals: [aTightening(), ...proposals] }), retroRunSnapshotOf(), kitConfig()));

  it("mentions nobody from any text the Retro wrote", () => {
    const body = filled(
      aTightening({ title: "Ask @alice about routes", problem: "@bob wrote it.", change: "Ping\n@carol." }),
      aLoosening({ streak: { pullRequests: DOCS_STREAK, kind: "PRs @dave liked" }, undoes: "@erin's #97" }),
    );

    expect(body).not.toMatch(/@(alice|bob|carol|dave|erin)/);
    expect(body).toContain("## Ask @​alice about routes");
    expect(body).toContain("Ping\n@​carol.");
  });

  it("leaves code in a closed fence as written, since GitHub notifies nobody from code, so a change can be applied as written", () => {
    const change = "In `eslint.config.js`, add:\n\n```js\nimport ts from \"@typescript-eslint/eslint-plugin\";\n```\n\nThen tell @alice.";

    const body = filled(aTightening({ title: "Lint floating promises", change }));

    expect(body).toContain("```js\nimport ts from \"@typescript-eslint/eslint-plugin\";\n```\n\nThen tell @​alice.");
  });

  it("closes a fence the Retro leaves open, so it can't swallow the rest of the Retro, and mentions nobody after it", () => {
    const body = filled(aTightening({ title: "Lint floating promises", change: "Add this:\n\n````\nrule @alice" }), aTightening({ title: "Third" }));

    expect(body).toContain("Add this:\n\n````\nrule @​alice\n````\n\n[Open as issue](");
    expect(linesOutsideCode(body)).toContain("## Third");
  });

  it("leaves a mention only in code that's code where it lands: a fence one text leaves open never pairs with the next text's", () => {
    const body = filled(aTightening({ title: "Lint floating promises", problem: "It opens:\n```", change: "```\n@alice\n```" }));

    expect(body).toContain("**Change**\n\n```\n@alice\n```");
    expect(linesOutsideCode(body).join("\n")).not.toMatch(/@alice/);
  });

  it("drops any marker line from the Retro's text, so the filled Retro reads as filled, at its own window end", () => {
    const markers = [`<!-- fabrik:retro 2026-01-01T00:00:00.000Z -->`, "<!-- fabrik:retro-pending -->", "  <!-- fabrik:retro-failed -->"].join("\n");

    const body = filled(aTightening({ title: "Lint floating promises", problem: `It happens.\n${markers}`, change: `\`\`\`\n${markers}\n\`\`\`` }));

    expect(retroMarksIn(body)).toEqual({ windowEnd: RETRO_WINDOW_END, pending: false, failed: false });
    expect(body).not.toContain("2026-01-01");
  });

  it("gives the filled Retro no state label, assignee, review request or mention, and leaves it open", () => {
    const plan = planFor(retroFinished({ proposals: [aTightening({ problem: "Hard to change, @operator." })] }), retroRunSnapshotOf(), kitConfig());

    expect(plan.kind === "act" && plan.actions.map((action) => action.kind)).toEqual(["edit-issue-body"]);
    expect(rewrittenBodyOf(plan)).not.toMatch(/@operator/);
    expect(notificationsOf(plan)).toEqual([]);
  });
});

describe("Landing a Retro: the step summary", () => {
  /** The notes the plan leaves for the run's step summary. */
  const notesOf = (plan: Plan) => (plan.kind === "act" ? plan.notes : undefined);
  const evidence = anEvidence({
    streakTable: [...anEvidence().streakTable, aStreakRow(161, { reverted: true }), aStreakRow(162, { requestChanges: true })],
  });

  it("lists each ref and each proposal the Kit dropped, and why", () => {
    const output = {
      proposals: [
        aTightening({ evidence: ["#212", "#404", "#140", "runs/acme/shop/2026-10/1-1-review.json"] }),
        aTightening({ title: "Ask @alice to review routes", kind: "judgement", target: "kit", evidence: ["#131", "#405"] }),
        aLoosening({ streak: { pullRequests: [141, 142, 140, 161, 162, 404], kind: "docs-only PRs" } }),
      ],
    };

    const plan = planFor(retroFinished(output, evidence), retroRunSnapshotOf(), kitConfig());

    expect(notesOf(plan)).toEqual([
      'Dropped #404 from "Fail the lint when a route handler imports the database client": the evidence doesn\'t hold it',
      'Dropped runs/acme/shop/2026-10/1-1-review.json from "Fail the lint when a route handler imports the database client": the evidence doesn\'t hold it',
      'Dropped #405 from "Ask @​alice to review routes": the evidence doesn\'t hold it',
      'Dropped the proposal "Ask @​alice to review routes": its evidence holds no escape and fewer than two distinct PRs',
      'Dropped the loosening "Let docs-only Tickets skip the end-to-end suite": #140 is named in an escape; #161 was reverted; #162 was sent back with Request changes; #404 isn\'t in the streak table; its streak counts 6 PRs, fewer than 20',
    ]);
    expect(cardTitlesOf(plan)).toEqual(["Fail the lint when a route handler imports the database client"]);
  });

  it("lists the drops of a Retro the Kit closes as clean", () => {
    const plan = planFor(retroFinished({ proposals: [aTightening({ evidence: ["#140"] })] }), retroRunSnapshotOf(), kitConfig());

    expect(notesOf(plan)).toEqual([
      'Dropped the proposal "Fail the lint when a route handler imports the database client": its evidence holds no escape and fewer than two distinct PRs',
    ]);
  });

  it("notes nothing when the Kit drops nothing", () => {
    const plan = planFor(retroFinished({ proposals: [aTightening(), aLoosening()] }), retroRunSnapshotOf(), kitConfig());

    expect(notesOf(plan)).toBeUndefined();
  });
});
