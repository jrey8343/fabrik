import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ChangeFingerprint, changeFingerprintOf, changeLine } from "./changeFingerprint.ts";
import { DIGEST_FOLDS_MARKER, type DigestGiven, type DigestReply, digestCommentOf, noDigestLine, readDigestReply } from "./digestContract.ts";
import { type DigestThread, digestFactsOf } from "./digestFacts.ts";
import { aDigestFacts, aDigestGiven, aDigestReply, aRequestChanges } from "../__fixtures__/digests.ts";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { verdictsIn } from "../github/threads.ts";
import { followUpsSection, newIssueUrl } from "./followUps.ts";
import { retryAfterFlaw } from "./retry.ts";
import { planFor } from "./rules.ts";
import type { FollowUp } from "./verdict.ts";
import {
  conflictAttemptMarker,
  CONFLICT_RUN_MARKER,
  flakyCheckMarker,
  handBackMarker,
  pushedHeadMarker,
  REQUEST_CHANGES_RUN_MARKER,
  requestChangesRunStartedMarker,
  RETRY_PUSH_MARKER,
  verdictMarker,
} from "./markers.ts";
import type { VerdictRecord } from "./types.ts";

const sha = (letter: string) => letter.repeat(40);
/** A time on the thread's day, by its minute, so a fixture reads in order. */
const at = (minute: number) => `2026-11-02T10:${String(minute).padStart(2, "0")}:00Z`;

const HEADINGS = { pass: "Pass", "execution-flaw": "Execution flaw", "design-flaw": "Design flaw" } as const;

/** A Verdict comment as the Kit posts one: its marker, its change line when it records a fingerprint, then what people read. */
function aVerdict(minute: number, record: Partial<VerdictRecord> & Pick<VerdictRecord, "verdict" | "headSha">, rest = ""): { at: string; body: string } {
  const { change, ...marked } = { source: "reviewer" as const, requestChanges: false, ...record };
  return {
    at: at(minute),
    body: [verdictMarker(marked), ...(change === undefined ? [] : [changeLine(change)]), `## Verdict: ${HEADINGS[record.verdict]}`, rest].join("\n"),
  };
}

const aNote = (minute: number, ...lines: string[]) => ({ at: at(minute), body: lines.join("\n") });

const aRetryPush = (minute: number, head: string) =>
  aNote(minute, RETRY_PUSH_MARKER, pushedHeadMarker(head), "The Implementer pushed a fix for the Execution flaw to `fabrik/ticket-7`; Review runs again on it.");

const aRequestChangesPush = (minute: number, head: string) =>
  aNote(minute, REQUEST_CHANGES_RUN_MARKER, pushedHeadMarker(head), "The Implementer pushed the Operator's requested changes to `fabrik/ticket-7`; Review runs again on it.");

const aConflictOnlyPush = (minute: number, head: string) =>
  aNote(minute, CONFLICT_RUN_MARKER, pushedHeadMarker(head), "The Implementer rebased `fabrik/ticket-7` onto `main` at mmmmmmm and resolved its conflicts; Review runs again on it.");

const aRebase = (minute: number) => aNote(minute, conflictAttemptMarker({ main: sha("9"), outcome: "rebased" }), "The Kit rebased `fabrik/ticket-7` onto `main` at 9999999.");

const anInfrastructureFailure = (minute: number) =>
  aNote(
    minute,
    "@operator The Review on #50 failed: it crashed.",
    "",
    "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Re-add `agent:review` on this PR to run it again.",
    "",
    "[The run](https://github.com/acme/shop/actions/runs/42/attempts/1)",
    handBackMarker({ kind: "infrastructure-failure", role: "review", failure: "crash" }),
  );

function aThread(overrides: Partial<DigestThread> = {}): DigestThread {
  return { openedAt: at(0), kitComments: [], requestChanges: [], landedNothing: 0, ...overrides };
}

/** The fingerprint of a change that adds one line to each of these files, built from its diff as Git prints it. */
function aChange(lines: Readonly<Record<string, string>>): ChangeFingerprint {
  return changeFingerprintOf(
    Object.entries(lines)
      .map(([path, line]) =>
        [`diff --git a/${path} b/${path}`, `index ${"1".repeat(40)}..${"2".repeat(40)} 100644`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,0 +1,1 @@", `+${line}`, ""].join("\n"),
      )
      .join(""),
  );
}

// A change to the cart and its test; the same with only the test changed again; and that with the cart changed again too.
const FIRST = aChange({ "src/cart.ts": "total()", "src/cart.test.ts": "it sums" });
const TESTS_MOVED = aChange({ "src/cart.ts": "total()", "src/cart.test.ts": "it sums twice" });
const PRODUCT_MOVED = aChange({ "src/cart.ts": "total(rounded)", "src/cart.test.ts": "it sums twice" });

describe("The rounds Kit code builds from a pull request's thread", () => {
  /**
   * A first run, an Execution flaw from red Required checks, a Retry, a pass,
   * a Request changes, its run, a rebase by the Kit, an Infrastructure
   * failure and a second pass.
   */
  const MESSY = aThread({
    kitComments: [
      aVerdict(5, { verdict: "execution-flaw", source: "ci", checks: ["test"], headSha: sha("a") }),
      aRetryPush(10, sha("b")),
      aVerdict(15, { verdict: "pass", headSha: sha("b") }),
      aNote(21, requestChangesRunStartedMarker([8]), "The Kit started the Request-changes run for the Operator's review."),
      aRequestChangesPush(25, sha("c")),
      aRebase(30),
      anInfrastructureFailure(35),
      aVerdict(40, { verdict: "pass", requestChanges: true, headSha: sha("d") }),
    ],
    requestChanges: [aRequestChanges(8, at(20))],
  });

  it("come out oldest first, each with who and what", () => {
    expect(digestFactsOf(MESSY).rounds.map(({ who, what, retry }) => (retry === undefined ? [who, what] : [who, what, retry]))).toEqual([
      ["implementer", "first-run"],
      ["required-checks", "execution-flaw"],
      ["implementer", "retry", 1],
      ["reviewer", "pass"],
      ["operator", "request-changes"],
      ["implementer", "request-changes-run"],
      ["kit", "rebase"],
      ["kit", "infrastructure-failure"],
      ["reviewer", "pass"],
    ]);
  });

  it("count each kind of Verdict, the Retries, the conflict-only runs, the Request changes and the Infrastructure failures", () => {
    expect(digestFactsOf(MESSY).counts).toEqual({
      passes: 2,
      executionFlaws: 1,
      designFlaws: 0,
      retries: 1,
      conflictOnlyRuns: 0,
      requestChanges: 1,
      infrastructureFailures: 1,
    });
  });

  const rows = (thread: DigestThread) => digestFactsOf(thread).rounds.map(({ who, what }) => `${who}: ${what}`);

  it("name the Kit for the Verdict it gives itself, and say whether a Retry changed nothing or was a Broken run", () => {
    const thread = aThread({
      kitComments: [
        aVerdict(5, { verdict: "execution-flaw", headSha: sha("a") }),
        aVerdict(10, { verdict: "execution-flaw", source: "empty-diff", headSha: sha("a") }),
        aVerdict(15, { verdict: "design-flaw", source: "broken-run", headSha: sha("a") }),
      ],
    });

    expect(digestFactsOf(thread).rounds.slice(1)).toMatchObject([
      { who: "reviewer", what: "execution-flaw" },
      { who: "kit", what: "execution-flaw", why: "retry-changed-nothing" },
      { who: "kit", what: "design-flaw", why: "broken-run" },
    ]);
    expect(digestFactsOf(thread).rounds[1]).not.toHaveProperty("why");
  });

  it("number each Retry as the Retry rules did, counting the Ticket's runs that landed nothing before the pull request opened", () => {
    const twoRetries = [
      aVerdict(5, { verdict: "execution-flaw", headSha: sha("a") }),
      aRetryPush(10, sha("b")),
      aVerdict(15, { verdict: "execution-flaw", headSha: sha("b") }),
      aNote(20, "The Implementer pushed a fix for the Execution flaw to `fabrik/ticket-7`; Review runs again on it."),
    ];
    const retries = (thread: DigestThread) => digestFactsOf(thread).rounds.flatMap(({ what, retry }) => (what === "retry" ? [retry] : []));

    expect(retries(aThread({ kitComments: twoRetries }))).toEqual([1, 2]);
    expect(retries(aThread({ kitComments: twoRetries.slice(0, 2), landedNothing: 1 }))).toEqual([1, 2]);
  });

  it("open with the Retry the opening push was, when the Ticket's earlier runs landed nothing, so the rounds, the count of Retries and the Retries left agree", () => {
    // The Ticket's first run landed nothing, so the run that opened the pull request was Retry 1, and the flaw's was Retry 2.
    const facts = digestFactsOf(
      aThread({
        kitComments: [aVerdict(5, { verdict: "execution-flaw", headSha: sha("a") }), aRetryPush(10, sha("b")), aVerdict(15, { verdict: "pass", headSha: sha("b") })],
        landedNothing: 1,
      }),
    );

    expect(facts.rounds.map(({ who, what, retry }) => (retry === undefined ? [who, what] : [who, what, retry]))).toEqual([
      ["implementer", "retry", 1],
      ["reviewer", "execution-flaw"],
      ["implementer", "retry", 2],
      ["reviewer", "pass"],
    ]);
    expect(facts.counts.retries).toBe(2);
    expect(facts.retriesLeft).toBe(0);
  });

  it("give a conflict-only run that failed its row and its count, as the Infrastructure failure or the Broken run its notice says it was", () => {
    const noticeOf = (report: { readonly failure: "missing-output"; readonly detail: string } | null): string => {
      const plan = planFor(
        { kind: "agent-run-failed", role: "implement", issue: 7, runUrl: "https://github.com/acme/shop/actions/runs/42/attempts/1", jobResult: "failure", secretsStep: "success", report, conflict: { pullRequest: 50, main: sha("9") } },
        snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"], openPullRequests: [50] })),
        kitConfig(),
      );
      return (plan.kind === "act" ? plan.actions : []).flatMap((action) => (action.kind === "comment" && action.issue === 50 ? [action.body] : []))[0] ?? "";
    };
    const crashed = noticeOf(null);
    const broken = noticeOf({ failure: "missing-output", detail: "" });
    const thread = aThread({ kitComments: [aVerdict(5, { verdict: "pass", headSha: sha("a") }), { at: at(10), body: crashed }, { at: at(20), body: broken }] });

    expect(crashed).toContain("it failed, as an Infrastructure failure");
    expect(broken).toContain("it was a Broken run");
    expect(rows(thread)).toEqual(["implementer: first-run", "reviewer: pass", "kit: infrastructure-failure", "kit: broken-run"]);
    expect(digestFactsOf(thread).counts.infrastructureFailures).toBe(1);
  });

  it("give a conflict-only run's push to the Implementer and a Broken run's notice to the Kit", () => {
    const brokenRun = aNote(
      20,
      "@operator The Implement run on #7 failed: the Implementer gave no valid output.",
      "",
      "This is a Broken run on a Request-changes run, which uses no retry, so the Loop won't run it again.",
      handBackMarker({ kind: "broken-run-no-retry", role: "implement", failure: "missing-output" }),
    );

    expect(rows(aThread({ kitComments: [aVerdict(5, { verdict: "pass", headSha: sha("a") }), aConflictOnlyPush(10, sha("b")), brokenRun] }))).toEqual([
      "implementer: first-run",
      "reviewer: pass",
      "implementer: conflict-only-run",
      "kit: broken-run",
    ]);
  });

  it("take no round from a note of the Kit's that is neither a push nor a failure notice", () => {
    const thread = aThread({
      kitComments: [
        aNote(5, conflictAttemptMarker({ main: sha("9"), outcome: "conflict-run" }), "`fabrik/ticket-7` conflicts with `main`, so the Kit started a conflict-only run."),
        aNote(6, "<!-- fabrik:conflict-run-ended -->", "@operator The conflict-only run ended without pushing.", handBackMarker({ kind: "conflict-run-unlanded", role: "implement" })),
        aNote(7, "<!-- fabrik:retry-restarted -->", "Retry 1 of 2 on #50 never started, so the Kit has added `agent:implement` to #7 again."),
        aNote(8, "<!-- fabrik:request-changes-run-empty -->", "The Request-changes run on #50 committed nothing."),
        aNote(9, `<!-- fabrik:no-digest {"head":"${sha("a")}","how":"failed"} -->`, "No Digest could be written for this head."),
      ],
    });

    expect(rows(thread)).toEqual(["implementer: first-run"]);
  });

  it("keep a Request changes the Operator has since dismissed only when a note of the Kit's names it", () => {
    const started = aNote(21, requestChangesRunStartedMarker([8]), "The Kit started the Request-changes run for the Operator's review.");
    const gaveWay = aVerdict(30, { verdict: "execution-flaw", requestChangesFirst: [9], headSha: sha("a") });
    const requestChanges = [
      aRequestChanges(8, at(20), { dismissed: true }),
      aRequestChanges(9, at(25), { dismissed: true }),
      aRequestChanges(10, at(35), { dismissed: true }),
    ];

    expect(rows(aThread({ kitComments: [started, gaveWay], requestChanges }))).toEqual([
      "implementer: first-run",
      "operator: request-changes",
      "operator: request-changes",
      "reviewer: execution-flaw",
    ]);
  });
});

describe("Each Verdict's effect on the code, against the Verdict before it", () => {
  const effects = (thread: DigestThread) => digestFactsOf(thread).rounds.map(({ what, effect }) => [what, effect]);

  it("is product code, tests only or none as its fingerprint differs from the one before, and blank on the first Verdict and on every other row", () => {
    const thread = aThread({
      kitComments: [
        aVerdict(5, { verdict: "execution-flaw", headSha: sha("a"), change: FIRST }),
        aRetryPush(10, sha("b")),
        aVerdict(15, { verdict: "execution-flaw", headSha: sha("b"), change: TESTS_MOVED }),
        aRetryPush(20, sha("c")),
        aVerdict(25, { verdict: "pass", headSha: sha("c"), change: PRODUCT_MOVED }),
        aRebase(30),
        aVerdict(35, { verdict: "pass", headSha: sha("d"), change: PRODUCT_MOVED }),
      ],
    });

    expect(effects(thread)).toEqual([
      ["first-run", null],
      ["execution-flaw", null],
      ["retry", null],
      ["execution-flaw", "tests-only"],
      ["retry", null],
      ["pass", "product-code"],
      ["rebase", null],
      ["pass", "none"],
    ]);
  });

  it("is not known when it or the Verdict before it records no fingerprint", () => {
    const thread = aThread({
      kitComments: [
        aVerdict(5, { verdict: "execution-flaw", headSha: sha("a") }),
        aVerdict(15, { verdict: "execution-flaw", headSha: sha("b"), change: FIRST }),
        aVerdict(25, { verdict: "execution-flaw", headSha: sha("c") }),
        aVerdict(35, { verdict: "pass", headSha: sha("d"), change: FIRST }),
      ],
    });

    expect(effects(thread).slice(1)).toEqual([
      ["execution-flaw", null],
      ["execution-flaw", "not-known"],
      ["execution-flaw", "not-known"],
      ["pass", "not-known"],
    ]);
  });
});

describe("The product code since the first Verdict", () => {
  /** A first Verdict recording `first`, a Retry, then the pass on the head recording `pass`. */
  const since = (first: ChangeFingerprint | undefined, pass: ChangeFingerprint | undefined) =>
    digestFactsOf(
      aThread({
        kitComments: [
          aVerdict(5, { verdict: "execution-flaw", headSha: sha("a"), ...(first === undefined ? {} : { change: first }) }),
          aRetryPush(10, sha("b")),
          aVerdict(15, { verdict: "pass", headSha: sha("b"), ...(pass === undefined ? {} : { change: pass }) }),
        ],
      }),
    ).productCode;

  it("is unchanged when only tests moved between the first Verdict and the pass on the head", () => {
    expect(since(FIRST, TESTS_MOVED)).toEqual({ kind: "unchanged" });
  });

  it("is changed, with the product files that differ and never a test file", () => {
    expect(since(FIRST, PRODUCT_MOVED)).toEqual({ kind: "changed", files: ["src/cart.ts"] });
  });

  it("could not be established when either Verdict records no fingerprint, as one from before the fingerprint does", () => {
    expect(since(undefined, PRODUCT_MOVED)).toEqual({ kind: "not-established" });
    expect(since(FIRST, undefined)).toEqual({ kind: "not-established" });
  });

  it("takes the first Verdict whatever its source, one from red Required checks included", () => {
    const thread = aThread({
      kitComments: [
        aVerdict(5, { verdict: "execution-flaw", source: "ci", checks: ["test"], headSha: sha("a"), change: FIRST }),
        aRetryPush(10, sha("b")),
        aVerdict(15, { verdict: "execution-flaw", headSha: sha("b"), change: PRODUCT_MOVED }),
        aRetryPush(20, sha("c")),
        aVerdict(25, { verdict: "pass", headSha: sha("c"), change: PRODUCT_MOVED }),
      ],
    });

    expect(digestFactsOf(thread).productCode).toEqual({ kind: "changed", files: ["src/cart.ts"] });
  });

  it("is unchanged on a pull request whose first Verdict is the pass on its head", () => {
    expect(digestFactsOf(aThread({ kitComments: [aVerdict(5, { verdict: "pass", headSha: sha("a"), change: FIRST })] })).productCode).toEqual({ kind: "unchanged" });
  });

  it("could not be established while the latest Verdict is no pass, there being no pass on the head to compare", () => {
    const thread = aThread({
      kitComments: [aVerdict(5, { verdict: "pass", headSha: sha("a"), change: FIRST }), aVerdict(15, { verdict: "execution-flaw", headSha: sha("b"), change: FIRST })],
    });

    expect(digestFactsOf(thread).productCode).toEqual({ kind: "not-established" });
    expect(digestFactsOf(aThread()).productCode).toEqual({ kind: "not-established" });
  });
});

describe("How many Retries are left", () => {
  const flaw = (minute: number, head: string, more: Partial<VerdictRecord> = {}) => aVerdict(minute, { verdict: "execution-flaw", headSha: sha(head), ...more });
  const flakyLine = aNote(8, flakyCheckMarker({ headSha: sha("a"), checks: ["test"], countedBack: true }), "The Flaky check passed on a re-run.");

  const THREADS: readonly (readonly [string, DigestThread, number])[] = [
    ["both, on a pull request with no Execution flaw", aThread({ kitComments: [aVerdict(5, { verdict: "pass", headSha: sha("a") })] }), 2],
    ["one, after an Execution flaw that called for a Retry", aThread({ kitComments: [flaw(5, "a"), aRetryPush(10, sha("b")), aVerdict(15, { verdict: "pass", headSha: sha("b") })] }), 1],
    ["none, after two", aThread({ kitComments: [flaw(5, "a"), flaw(15, "b"), aVerdict(25, { verdict: "pass", headSha: sha("c") })] }), 0],
    ["none, never fewer, after a third flaw", aThread({ kitComments: [flaw(5, "a"), flaw(15, "b"), flaw(25, "c")] }), 0],
    ["one fewer for each run that landed nothing before the pull request opened", aThread({ kitComments: [flaw(5, "a")], landedNothing: 1 }), 0],
    ["both, after a flaw that gave way to the Operator's Request changes", aThread({ kitComments: [flaw(5, "a", { requestChangesFirst: [8] })] }), 2],
    ["both, after a flaw from a Flaky check that the Kit counted back", aThread({ kitComments: [flaw(5, "a", { source: "ci", checks: ["test"] }), flakyLine] }), 2],
  ];

  it.each(THREADS)("is %s", (_name, thread, left) => {
    expect(digestFactsOf(thread).retriesLeft).toBe(left);
  });

  it.each(THREADS)("is what the Retry rules give the next Execution flaw on the same thread: %s", (_name, thread, left) => {
    const snapshot = aPullRequest({ verdicts: verdictsIn(thread.kitComments.map(({ body }) => body)), ticketLandedNothing: thread.landedNothing });

    const next = retryAfterFlaw(snapshot, null);

    // The rules give the next flaw Retry 1 of 2 with both left, Retry 2 of 2 with one, and none with none.
    expect(next?.line.slice(0, "Retry 1 of 2".length) ?? null).toBe(left === 0 ? null : `Retry ${3 - left} of 2`);
  });
});

describe("The Follow-ups of every pass on the pull request", () => {
  const REPO = "https://github.com/acme/shop";
  const RATE_LIMIT = { title: "Rate limit the cart", body: "Saving has no limit.\n\nA shopper can save a thousand times a second." };
  const DEAD_CODE = { title: "Delete the old basket page", body: "" };
  const COPY = { title: "Say 'basket' in the emails", body: "They still say cart." };
  /** A pass whose comment lists these Follow-ups after its findings, as the Kit posts one (src/loop/followUps.ts). */
  const aPassNaming = (minute: number, head: string, followUps: readonly FollowUp[]) =>
    aVerdict(minute, { verdict: "pass", headSha: sha(head) }, ["", "### Checked", "", "Every criterion.", ...followUpsSection(followUps, REPO, 50), "", "[The run](https://github.com/acme/shop/actions/runs/42/attempts/1)"].join("\n"));

  it("are listed in the order their Verdicts name them, each with an id, its title and its Open as issue link as the Verdict has it", () => {
    const thread = aThread({
      kitComments: [aPassNaming(5, "a", [RATE_LIMIT, DEAD_CODE]), aRebase(10), aPassNaming(15, "b", [COPY])],
    });

    const { followUps } = digestFactsOf(thread);

    expect(followUps).toEqual([
      { id: "f1", title: "Rate limit the cart", url: newIssueUrl(REPO, RATE_LIMIT.title, RATE_LIMIT.body, "From PR #50") },
      { id: "f2", title: "Delete the old basket page", url: newIssueUrl(REPO, DEAD_CODE.title, DEAD_CODE.body, "From PR #50") },
      { id: "f3", title: "Say 'basket' in the emails", url: newIssueUrl(REPO, COPY.title, COPY.body, "From PR #50") },
    ]);
    expect(followUps[0]?.url).toMatch(/^https:\/\/github\.com\/acme\/shop\/issues\/new\?title=Rate\+limit\+the\+cart&body=Saving\+has\+no\+limit\./);
    expect(thread.kitComments[0]?.body).toContain(`[Open as issue](${followUps[0]?.url})`);
  });

  it("are none on a pull request whose passes name none", () => {
    expect(digestFactsOf(aThread({ kitComments: [aPassNaming(5, "a", [])] })).followUps).toEqual([]);
    expect(digestFactsOf(aThread()).followUps).toEqual([]);
  });

  it("are never taken from a Verdict that is no pass, whatever its findings quote", () => {
    const quoting = aVerdict(5, { verdict: "execution-flaw", headSha: sha("a") }, ["", "The cart throws.", ...followUpsSection([RATE_LIMIT], REPO, 50)].join("\n"));

    expect(digestFactsOf(aThread({ kitComments: [quoting] })).followUps).toEqual([]);
  });
});

/** The Digest's comment for this reply and what Kit code hands the contract; a refusal fails the test. */
function bodyOf(reply: DigestReply, given: DigestGiven): string {
  const comment = digestCommentOf(reply, given);
  if (!comment.ok) throw new Error(`expected a Digest, got the refusal: ${comment.refused}`);
  return comment.body;
}

describe("The Follow-ups a Digest shows", () => {
  const NEW_ISSUE = "https://github.com/acme/shop/issues/new?title=";
  const THREE = aDigestGiven({
    facts: aDigestFacts({
      followUps: [
        { id: "f1", title: "Rate limit the cart", url: `${NEW_ISSUE}Rate+limit+the+cart` },
        { id: "f2", title: "Delete the old basket page", url: `${NEW_ISSUE}Delete+the+old+basket+page` },
        { id: "f3", title: "Say 'basket' in the emails", url: `${NEW_ISSUE}Say+%27basket%27+in+the+emails` },
      ],
    }),
  });
  /** The Follow-ups section of a Digest: what sits between its heading and the folds line. */
  const shown = (body: string) => body.split("\n### Follow-ups\n\n")[1]?.split(`\n\n${DIGEST_FOLDS_MARKER}\n`)[0];

  it("are only the ones the reply names: f2 of three is one line with its title and its Open as issue link", () => {
    expect(shown(bodyOf(aDigestReply({ followUps: ["f2"] }), THREE))).toBe(`- Delete the old basket page: [Open as issue](${NEW_ISSUE}Delete+the+old+basket+page)`);
  });

  it("sit after How it got here, above the folds", () => {
    const body = bodyOf(aDigestReply({ howItGotHere: "One Review passed it.", followUps: ["f2"] }), THREE);

    expect(body).toContain("### How it got here\n\nOne Review passed it.\n\n### Follow-ups\n\n- Delete the old basket page");
    expect(body.indexOf("### Follow-ups")).toBeLessThan(body.indexOf(DIGEST_FOLDS_MARKER));
  });

  it('are "None named." when the reply names none, whatever Kit code listed', () => {
    expect(shown(bodyOf(aDigestReply({ followUps: [] }), THREE))).toBe("None named.");
    expect(shown(bodyOf(aDigestReply({ followUps: [] }), aDigestGiven()))).toBe("None named.");
  });

  it("are each shown once, in the order their Verdicts named them", () => {
    expect(shown(bodyOf(aDigestReply({ followUps: ["f3", "f1", "f3"] }), THREE))).toBe(
      [`- Rate limit the cart: [Open as issue](${NEW_ISSUE}Rate+limit+the+cart)`, `- Say 'basket' in the emails: [Open as issue](${NEW_ISSUE}Say+%27basket%27+in+the+emails)`].join("\n"),
    );
  });

  it("refuse the Digest when the reply names an id Kit code did not list", () => {
    expect(digestCommentOf(aDigestReply({ followUps: ["f2", "f9", "f7"] }), THREE)).toEqual({
      ok: false,
      refused: "the reply names Follow-ups Kit code did not list: `f9`, `f7`",
    });
    expect(digestCommentOf(aDigestReply({ followUps: ["f1"] }), aDigestGiven())).toEqual({ ok: false, refused: "the reply names a Follow-up Kit code did not list: `f1`" });
  });

  it("have the no-Digest line say so when the reply names one that was not listed, as a broken reply's does", () => {
    const pullRequest = aPullRequest({ draft: false, leftDraftSinceVerdict: true, labels: ["agent:digest"], verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }] });
    const given = aDigestGiven({ ...THREE, headSha: HEAD_SHA });

    const plan = planFor(
      { kind: "digest-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: JSON.stringify(aDigestReply({ followUps: ["f4"] })), given, runUrl: given.runUrl },
      snapshotOfPullRequest(pullRequest),
      kitConfig(),
    );

    const comments = plan.kind === "act" ? plan.actions.flatMap((action) => (action.kind === "comment" ? [action.body] : [])) : [];
    expect(comments).toEqual([noDigestLine({ head: HEAD_SHA, how: "refused", reason: "the reply names a Follow-up Kit code did not list: `f4`", runUrl: given.runUrl })]);
    expect(comments[0]).toContain("`refused`, Kit code refused the Digest writer's reply (the reply names a Follow-up Kit code did not list: `f4`).");
  });
});

describe("The rounds fold", () => {
  /** The folds of a Digest, each as GitHub is given it: everything under the folds line but the link to the run. */
  const foldsOf = (body: string) => (body.split(`\n${DIGEST_FOLDS_MARKER}\n`)[1] ?? "").split("\n\n[The run](")[0] ?? "";
  const roundsFoldOf = (body: string) => `${foldsOf(body).slice(foldsOf(body).indexOf("<details>\n<summary>The rounds</summary>")).split("\n</details>")[0]}\n</details>`;

  it("is Kit code's table of the rounds from the thread, with who, what and the effect on the code, then the writer's closing line, and nothing else", () => {
    const facts = digestFactsOf(
      aThread({
        kitComments: [
          aVerdict(5, { verdict: "execution-flaw", source: "ci", checks: ["test"], headSha: sha("a"), change: FIRST }),
          aRetryPush(10, sha("b")),
          aVerdict(15, { verdict: "pass", headSha: sha("b"), change: PRODUCT_MOVED }),
          aNote(21, requestChangesRunStartedMarker([8]), "The Kit started the Request-changes run for the Operator's review."),
          aRequestChangesPush(25, sha("c")),
          aRebase(30),
          anInfrastructureFailure(35),
          aVerdict(40, { verdict: "pass", requestChanges: true, headSha: sha("d"), change: PRODUCT_MOVED }),
        ],
        requestChanges: [aRequestChanges(8, at(20))],
      }),
    );

    // The thread's one Request changes is an ask, which a reply has to answer to land.
    const asks = [{ id: "review-8", answer: "in-head", where: "src/basket/save.ts", checkedBy: "reading" }] as const;
    const body = bodyOf(aDigestReply({ asks, roundsLine: "Both passes agree; the Request-changes run changed nothing the second Review weighed." }), aDigestGiven({ facts }));

    expect(roundsFoldOf(body)).toBe(
      [
        "<details>",
        "<summary>The rounds</summary>",
        "",
        "| Who | What | Effect on the code |",
        "| --- | --- | --- |",
        "| The Implementer | The first run | |",
        "| Red Required checks | Execution flaw | |",
        "| The Implementer | Retry 1 | |",
        "| The Reviewer | Pass | Product code |",
        "| The Operator | Request changes | |",
        "| The Implementer | A Request-changes run | |",
        "| The Kit | A rebase onto `main` | |",
        "| The Kit | An Infrastructure failure | |",
        "| The Reviewer | Pass | None |",
        "",
        "Both passes agree; the Request-changes run changed nothing the second Review weighed.",
        "",
        "</details>",
      ].join("\n"),
    );
  });

  it("comes third, inside a details block, after Walk me through it and Decided without you, and before the criteria and the link to the run", () => {
    const body = bodyOf(aDigestReply(), aDigestGiven());

    expect(foldsOf(body).match(/<summary>(.*)<\/summary>/g)).toEqual([
      "<summary>Walk me through it</summary>",
      "<summary>Decided without you, and left alone</summary>",
      "<summary>The rounds</summary>",
      "<summary>The criteria and how each was checked</summary>",
    ]);
    expect(foldsOf(body)).toContain(`${roundsFoldOf(body)}\n\n<details>\n<summary>The criteria and how each was checked</summary>`);
    expect(body.endsWith(`</details>\n\n[The run](${aDigestGiven().runUrl})`)).toBe(true);
  });

  it("words every kind of round: the Kit's own Verdicts with what they were for, a Design flaw, a conflict-only run, a Broken run, and an effect that is tests only or not known", () => {
    const facts = aDigestFacts({
      rounds: [
        { who: "implementer", what: "first-run", effect: null },
        { who: "reviewer", what: "execution-flaw", effect: null },
        { who: "kit", what: "execution-flaw", why: "retry-changed-nothing", effect: "none" },
        { who: "implementer", what: "retry", retry: 2, effect: null },
        { who: "kit", what: "broken-run", effect: null },
        { who: "kit", what: "execution-flaw", why: "broken-run", effect: "not-known" },
        { who: "implementer", what: "conflict-only-run", effect: null },
        { who: "reviewer", what: "design-flaw", effect: "tests-only" },
      ],
    });

    expect(roundsFoldOf(bodyOf(aDigestReply(), aDigestGiven({ facts }))).split("\n").slice(5, 13)).toEqual([
      "| The Implementer | The first run | |",
      "| The Reviewer | Execution flaw | |",
      "| The Kit, for a Retry that changed nothing | Execution flaw | None |",
      "| The Implementer | Retry 2 | |",
      "| The Kit | A Broken run | |",
      "| The Kit, for a Broken run | Execution flaw | Not known |",
      "| The Implementer | A conflict-only run | |",
      "| The Reviewer | Design flaw | Tests only |",
    ]);
  });

  it("keeps the closing line to one line, with no mention in it", () => {
    const body = bodyOf(aDigestReply({ roundsLine: "  The two Verdicts disagreed\non the empty basket, says @octocat.\n" }), aDigestGiven());

    expect(roundsFoldOf(body).split("\n").slice(-3)).toEqual(["The two Verdicts disagreed on the empty basket, says @​octocat.", "", "</details>"]);
  });
});

describe("The reply's Follow-ups and closing line", () => {
  it("reads a reply that names the Follow-ups to show and words the rounds' closing line", () => {
    expect(readDigestReply(aDigestReply({ followUps: ["f2"], roundsLine: "Two Reviews; the second passed it." }))).toEqual({
      ok: true,
      output: aDigestReply({ followUps: ["f2"], roundsLine: "Two Reviews; the second passed it." }),
    });
  });

  it.each([
    ["missing", undefined],
    ["text", "f1"],
    ["a list holding anything but ids", ["f1", 2]],
    ["a list holding an empty id", ["f1", " "]],
  ])("refuses followUps that is %s", (_name, followUps) => {
    expect(readDigestReply({ ...aDigestReply(), followUps })).toEqual({ ok: false, errors: ["followUps must be a list of Follow-up ids"] });
  });

  it.each([
    ["missing", undefined],
    ["empty", "  "],
    ["no text", 7],
  ])("refuses a roundsLine that is %s", (_name, roundsLine) => {
    expect(readDigestReply({ ...aDigestReply(), roundsLine })).toEqual({ ok: false, errors: ["roundsLine must be non-empty text"] });
  });
});

describe("The README's Digest section, on Kit code's facts", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = readme.split("\n## Digest\n")[1]?.split("\n## ")[0] ?? "";
  const facts = section.split("\n").find((line) => line.startsWith("- **Kit code's facts**")) ?? "";

  it("says Kit code counts and the writer words, and names each fact", () => {
    expect(facts).toContain("the Digest writer words it and may not contradict it");
    for (const fact of ["the rounds", "each Verdict's effect on the code", "the counts", "how many Retries are left", "the Follow-ups of every pass", "whether the product code changed since the first Verdict"]) {
      expect(facts).toContain(fact);
    }
    expect(facts).toContain("could not be established");
  });

  it("names the reply's two fields, the comment's Follow-ups and third fold as the contract renders them, and the refusal", () => {
    const body = bodyOf(aDigestReply(), aDigestGiven());

    expect(facts).toContain("`followUps`");
    expect(facts).toContain("`roundsLine`");
    expect(body).toContain("\n### Follow-ups\n\nNone named.\n");
    expect(facts).toContain("**Follow-ups**");
    expect(facts).toContain('"None named."');
    expect(body).toContain("<summary>The rounds</summary>");
    expect(facts).toContain("a third fold, **The rounds**");
    expect(facts).toContain("A reply naming a Follow-up Kit code did not list is refused");
  });
});
