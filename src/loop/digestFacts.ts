// Kit code's facts for a Digest (ADR-0022): everything in one that can be
// counted, worked out from the pull request's thread and handed to the Digest
// writer as fact it may word and not contradict. Kit code counts, the writer
// words. The rounds table in the Digest's third fold is rendered from the
// same facts (src/loop/digestContract.ts), from the push job's own read of
// the thread (src/github/digestGiven.ts), never from anything an agent
// passed out. Pure, no I/O.
import { verdictsIn } from "../github/threads.ts";
import { conflictAttemptIn, CONFLICT_RUN_MARKER, handBackMarkIn, REQUEST_CHANGES_RUN_MARKER, RETRY_PUSH_MARKER, startedReviewsIn, UNMARKED_RETRY_PUSH } from "./markers.ts";
import { retryNumber } from "./retry.ts";
import type { Verdict, VerdictRecord } from "./types.ts";

/** A pull request's thread, as much of it as the facts are worked out from. */
export interface DigestThread {
  /** When the pull request was opened, which the first run's push did: that run leaves no note of its own. */
  readonly openedAt: string;
  /** The Kit's own comments on it, oldest first: only a bot's, so nobody can plant a round by quoting a marker. */
  readonly kitComments: readonly { readonly at: string; readonly body: string }[];
  /**
   * The Operator's reviews that requested changes, by GitHub's id for each. A
   * dismissed one no longer says what it asked, so it counts only when a
   * note of the Kit's names it.
   */
  readonly requestChanges: readonly { readonly review: number; readonly at: string; readonly dismissed: boolean }[];
  /** How many of the Ticket's runs landed nothing before the pull request opened, each of which used one of its Retries. */
  readonly landedNothing: number;
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

  const rounds: Round[] = [{ who: "implementer", what: "first-run" }];
  // The Kit's comments so far, which say what the Kit had counted when each round came.
  const sofar: string[] = [];
  for (const entry of entries) {
    if ("review" in entry) {
      rounds.push({ who: "operator", what: "request-changes" });
      continue;
    }
    const { body } = entry;
    const [verdict] = verdictsIn([body]);
    if (verdict !== undefined) rounds.push({ ...VERDICT_BY[verdict.source], what: verdict.verdict });
    else rounds.push(...noteRound(body, sofar, thread.landedNothing));
    sofar.push(body);
  }
  const count = (what: RoundWhat): number => rounds.filter((round) => round.what === what).length;
  return {
    rounds,
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

/** The round a note of the Kit's records, if it records one: a push, or a failure notice. */
function noteRound(body: string, sofar: readonly string[], landedNothing: number): Round[] {
  if (body.startsWith(RETRY_PUSH_MARKER) || body.startsWith(UNMARKED_RETRY_PUSH)) {
    // The Retry the latest Verdict called for, numbered as the Retry rules numbered it then.
    return [{ who: "implementer", what: "retry", retry: retryNumber(verdictsIn(sofar).slice(0, -1), landedNothing) }];
  }
  if (body.startsWith(REQUEST_CHANGES_RUN_MARKER)) return [{ who: "implementer", what: "request-changes-run" }];
  if (body.startsWith(CONFLICT_RUN_MARKER)) return [{ who: "implementer", what: "conflict-only-run" }];
  if (conflictAttemptIn(body)?.outcome === "rebased") return [{ who: "kit", what: "rebase" }];
  const handBack = handBackMarkIn(body)?.kind;
  if (handBack === "infrastructure-failure") return [{ who: "kit", what: "infrastructure-failure" }];
  if (handBack === "broken-run-no-retry") return [{ who: "kit", what: "broken-run" }];
  return [];
}
