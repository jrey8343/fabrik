import { describe, expect, it } from "vitest";
import { type ChangeFingerprint, changeLine } from "./changeFingerprint.ts";
import { type DigestThread, digestFactsOf } from "./digestFacts.ts";
import {
  conflictAttemptMarker,
  CONFLICT_RUN_MARKER,
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
    requestChanges: [{ review: 8, at: at(20), dismissed: false }],
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
    expect(retries(aThread({ kitComments: twoRetries.slice(0, 2), landedNothing: 1 }))).toEqual([2]);
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
      { review: 8, at: at(20), dismissed: true },
      { review: 9, at: at(25), dismissed: true },
      { review: 10, at: at(35), dismissed: true },
    ];

    expect(rows(aThread({ kitComments: [started, gaveWay], requestChanges }))).toEqual([
      "implementer: first-run",
      "operator: request-changes",
      "operator: request-changes",
      "reviewer: execution-flaw",
    ]);
  });
});
