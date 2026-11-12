// Kit code's facts for a Digest (ADR-0022): everything in one that can be
// counted, worked out from the pull request's thread and handed to the Digest
// writer as fact it may word and not contradict. Kit code counts, the writer
// words. Among them are the asks: each thing the Operator asked for on the
// pull request, which the writer answers one by one. The rounds table in the
// Digest's third fold is rendered from the same facts
// (src/loop/digestContract.ts), from the push job's own read of the thread
// (src/github/digestGiven.ts), never from anything an agent passed out. Pure,
// no I/O.
import { operatorCommentId } from "../agent/operatorComments.ts";
import { verdictsIn } from "../github/threads.ts";
import { type ProductChange, productChangeBetween, type VerdictEffect, verdictEffect } from "./changeFingerprint.ts";
import { listedFollowUpsIn } from "./followUps.ts";
import { conflictAttemptIn, CONFLICT_RUN_MARKER, handBackMarkIn, REQUEST_CHANGES_RUN_MARKER, RETRY_PUSH_MARKER, startedReviewsIn, UNMARKED_RETRY_PUSH } from "./markers.ts";
import { MAX_RETRIES, retryNumber } from "./retry.ts";
import { isBrokenRun, type Verdict, type VerdictRecord } from "./types.ts";

/** A pull request's thread, as much of it as the facts are worked out from. */
export interface DigestThread {
  /** When the pull request was opened, which the push of the run that opened it did: that run leaves no note of its own. */
  readonly openedAt: string;
  /** The Kit's own comments on it, oldest first: only a bot's, so nobody can plant a round by quoting a marker. */
  readonly kitComments: readonly { readonly at: string; readonly body: string }[];
  /**
   * The Operator's reviews that requested changes, by GitHub's id for each. A
   * dismissed one no longer says what it asked, so it counts as a round only
   * when a note of the Kit's names it, and is never an ask.
   */
  readonly requestChanges: readonly ThreadRequestChanges[];
  /** How many of the Ticket's runs landed nothing before the pull request opened, each of which used one of its Retries. */
  readonly landedNothing: number;
}

/** One of the Operator's reviews that requested changes, as the thread has it. */
export interface ThreadRequestChanges {
  /** GitHub's own id for the review. */
  readonly review: number;
  readonly at: string;
  readonly dismissed: boolean;
  /** Whether it was deferred while a Retry was in flight (#427) and no run has been started for it yet: no Review was given it. */
  readonly deferred: boolean;
  /** The review's own text, empty when it speaks only through its line comments. */
  readonly body: string;
  /** Its place on the pull request's page. */
  readonly url: string;
  /** The Operator's line comments in it, oldest first. */
  readonly lineComments: readonly ThreadLineComment[];
}

/** One line comment of a Request changes. */
export interface ThreadLineComment {
  /** GitHub's own id for the comment. */
  readonly comment: number;
  /** Its place on the pull request's page. */
  readonly url: string;
  readonly path: string;
  /** The line it is on, or null when GitHub no longer places it on one. */
  readonly line: number | null;
}

/**
 * One thing the Operator asked for on the pull request: a Request changes,
 * or a line comment in one. The Digest writer answers every one, and Kit
 * code refuses a Digest that skips any (src/loop/digestContract.ts).
 */
export interface DigestAsk {
  /**
   * Kit code's id for it, made from GitHub's own id of the review or of the
   * line comment: `review-<id>` or `inline-<id>`, as the writer's input heads
   * each (src/agent/operatorComments.ts). It is the same at every head, so
   * the lists built at two heads can be compared.
   */
  readonly id: string;
  readonly what: "request-changes" | "line-comment";
  /** Its place on the pull request's page. */
  readonly url: string;
  /** On a line comment: the file it is on. */
  readonly path?: string;
  /** On a line comment: the line it is on, or null when GitHub no longer places it on one. */
  readonly line?: number | null;
}

/** Who a round was. */
export type RoundWho = "implementer" | "reviewer" | "required-checks" | "kit" | "operator";

/** What a round was: a push the Kit noted, a Verdict, a Request changes of the Operator's, or a failure notice. */
export type RoundWhat =
  | "first-run"
  | "retry"
  | "request-changes-run"
  | "conflict-only-run"
  | "rebase"
  | Verdict
  | "request-changes"
  | "infrastructure-failure"
  | "broken-run";

/** One row of the rounds. */
export interface Round {
  readonly who: RoundWho;
  readonly what: RoundWhat;
  /** On a Retry's push: which of the Ticket's Retries it was. */
  readonly retry?: number;
  /** On a Verdict the Kit gave itself: what for. */
  readonly why?: "retry-changed-nothing" | "broken-run";
  /**
   * On a Verdict: what the pull request's own change had changed of the code
   * since the Verdict before it, by their fingerprints. Null on the first
   * Verdict and on every other row, which the table leaves blank.
   */
  readonly effect: VerdictEffect | null;
}

/** A Follow-up a pass on the pull request named, as the facts list it. */
export interface DigestFollowUp {
  /** Kit code's id for it on this thread: `f1`, `f2`, … in the order listed. */
  readonly id: string;
  readonly title: string;
  /** Its Open as issue link, as its Verdict comment has it. */
  readonly url: string;
}

/** How many rounds of each counted kind the thread holds. */
export interface RoundCounts {
  readonly passes: number;
  readonly executionFlaws: number;
  readonly designFlaws: number;
  /** The Retries that pushed. One that changed nothing, or was a Broken run, is the Execution flaw the Kit gave for it. */
  readonly retries: number;
  readonly conflictOnlyRuns: number;
  readonly requestChanges: number;
  readonly infrastructureFailures: number;
}

/** Kit code's facts about a pull request, from its thread. */
export interface DigestFacts {
  /** The rounds, oldest first. */
  readonly rounds: readonly Round[];
  /** The rounds, counted. */
  readonly counts: RoundCounts;
  /** The Follow-ups of every pass on the pull request, in the order their Verdicts list them. The writer says which to show, by id. */
  readonly followUps: readonly DigestFollowUp[];
  /**
   * The asks: every Request changes of the Operator's as the Reviewer is
   * given them, so neither a dismissed one nor one deferred during a Retry,
   * oldest first, each followed by every line comment in it. A review whose
   * own text is empty is listed by its line comments alone.
   */
  readonly asks: readonly DigestAsk[];
  /** How many of the Ticket's Retries are left, by the Retry rules' own count (src/loop/retry.ts): what the next Execution flaw would find. */
  readonly retriesLeft: number;
  /**
   * The product code since the first Verdict: unchanged; changed, with the
   * files that differ; or not established. The first Verdict is the first
   * on the pull request whatever its source, compared with the pass on the
   * head. A Digest is written, and lands, only while the latest Verdict is
   * that pass (src/loop/digest.ts), so that is the Verdict compared; while
   * it is no pass, or either records no fingerprint, it is not established.
   */
  readonly productCode: ProductChange;
}

/** One thing on the thread, at its time. */
type Entry = { readonly at: string } & ({ readonly body: string } | { readonly review: number });

/** Who gives a Verdict, by its source: the Kit gives its own for a Retry that changed nothing and for a Broken run. */
const VERDICT_BY: Readonly<Record<VerdictRecord["source"], Pick<Round, "who" | "why">>> = {
  reviewer: { who: "reviewer" },
  ci: { who: "required-checks" },
  "empty-diff": { who: "kit", why: "retry-changed-nothing" },
  "broken-run": { who: "kit", why: "broken-run" },
};

/** Kit code's facts about a pull request, from its thread. */
export function digestFactsOf(thread: DigestThread): DigestFacts {
  const bodies = thread.kitComments.map(({ body }) => body);
  // The reviews a note of the Kit's names: each was the Operator's Request changes, whatever became of it since.
  const noted = new Set(bodies.flatMap((body) => [...(startedReviewsIn(body) ?? []), ...(verdictsIn([body])[0]?.requestChangesFirst ?? [])]));
  const asked = thread.requestChanges.filter(({ review, dismissed }) => !dismissed || noted.has(review));
  // Stable, so things at the same time keep the order they were read in, the Kit's comments first.
  const entries = [...thread.kitComments, ...asked].sort((a: Entry, b: Entry) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  // The push that opened the pull request: the Ticket's first run, or, when its runs before that landed nothing, the
  // Retry after the last of them, as the Implement rules number it (src/loop/implement.ts).
  const rounds: Round[] = [thread.landedNothing === 0 ? row("implementer", "first-run") : { ...row("implementer", "retry"), retry: thread.landedNothing }];
  // The Kit's comments so far, which say what the Kit had counted when each round came.
  const sofar: string[] = [];
  let before: VerdictRecord | undefined;
  for (const entry of entries) {
    if ("review" in entry) {
      rounds.push(row("operator", "request-changes"));
      continue;
    }
    const { body } = entry;
    const [verdict] = verdictsIn([body]);
    if (verdict !== undefined) {
      rounds.push({ ...VERDICT_BY[verdict.source], what: verdict.verdict, effect: before === undefined ? null : verdictEffect(before.change, verdict.change) });
      before = verdict;
    } else {
      rounds.push(...noteRound(body, sofar, thread.landedNothing));
    }
    sofar.push(body);
  }
  const count = (what: RoundWhat): number => rounds.filter((round) => round.what === what).length;
  const verdicts = verdictsIn(bodies);
  const [first, latest] = [verdicts[0], verdicts.at(-1)];
  return {
    rounds,
    followUps: bodies
      .flatMap((body) => (verdictsIn([body])[0]?.verdict === "pass" ? listedFollowUpsIn(body) : []))
      .map(({ title, url }, index) => ({ id: `f${index + 1}`, title, url })),
    asks: asksIn(thread.requestChanges),
    // The next flaw would call for Retry `retryNumber`, so the ones before it are used.
    retriesLeft: Math.max(0, MAX_RETRIES + 1 - retryNumber(verdicts, thread.landedNothing)),
    productCode: latest?.verdict === "pass" ? productChangeBetween(first?.change, latest.change) : { kind: "not-established" },
    counts: {
      passes: count("pass"),
      executionFlaws: count("execution-flaw"),
      designFlaws: count("design-flaw"),
      retries: count("retry"),
      conflictOnlyRuns: count("conflict-only-run"),
      requestChanges: count("request-changes"),
      infrastructureFailures: count("infrastructure-failure"),
    },
  };
}

/**
 * The asks among the Operator's Request changes: those the Reviewer is given,
 * so neither a dismissed one nor one deferred during a Retry, oldest first.
 * Each is listed when its own text says something, then each of its line
 * comments.
 */
function asksIn(requestChanges: readonly ThreadRequestChanges[]): DigestAsk[] {
  return requestChanges
    .filter(({ dismissed, deferred }) => !dismissed && !deferred)
    .toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .flatMap(({ review, body, url, lineComments }): DigestAsk[] => [
      ...(body.trim() === "" ? [] : [{ id: operatorCommentId("review", review), what: "request-changes" as const, url }]),
      ...lineComments.map((comment) => ({
        id: operatorCommentId("inline", comment.comment),
        what: "line-comment" as const,
        url: comment.url,
        path: comment.path,
        line: comment.line,
      })),
    ]);
}

/** A row that is no Verdict, so it says nothing of the code. */
function row(who: RoundWho, what: RoundWhat): Round {
  return { who, what, effect: null };
}

/** The round a note of the Kit's records, if it records one: a push, or a failure notice. */
function noteRound(body: string, sofar: readonly string[], landedNothing: number): Round[] {
  if (body.startsWith(RETRY_PUSH_MARKER) || body.startsWith(UNMARKED_RETRY_PUSH)) {
    // The Retry the latest Verdict called for, numbered as the Retry rules numbered it then.
    return [{ ...row("implementer", "retry"), retry: retryNumber(verdictsIn(sofar).slice(0, -1), landedNothing) }];
  }
  if (body.startsWith(REQUEST_CHANGES_RUN_MARKER)) return [row("implementer", "request-changes-run")];
  if (body.startsWith(CONFLICT_RUN_MARKER)) return [row("implementer", "conflict-only-run")];
  if (conflictAttemptIn(body)?.outcome === "rebased") return [row("kit", "rebase")];
  const handBack = handBackMarkIn(body);
  if (handBack?.kind === "infrastructure-failure") return [row("kit", "infrastructure-failure")];
  if (handBack?.kind === "broken-run-no-retry") return [row("kit", "broken-run")];
  // A conflict-only run that failed is handed back as one that landed nothing is, and its hand-back names the failure:
  // one that changed nothing, didn't bring `main` in or was refused names none, and is no failure.
  if (handBack?.kind === "conflict-run-unlanded" && handBack.failure !== undefined) return [row("kit", isBrokenRun(handBack.failure) ? "broken-run" : "infrastructure-failure")];
  return [];
}
