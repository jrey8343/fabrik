// The Implement runs' pushes to a pull request, from the Kit's notes of them
// on its thread (#748): each run's kind, a Retry's number as the Retry rules
// numbered it, the head the note names, and the note itself, which carries the
// `fix` comment the run wrote. A later Review is given them. Pure, no I/O.
import { type DigestThread, noteRound } from "./digestFacts.ts";
import { pushedHeadIn } from "./markers.ts";

/** The kind of Implement run that pushed to a pull request. */
export type PushingRun = "retry" | "request-changes-run" | "conflict-only-run";

/** One Implement run's push, as the Kit's note of it records it. */
export interface RunPush {
  readonly run: PushingRun;
  /** On a Retry's push: which of the Ticket's Retries it was. */
  readonly retry?: number;
  /** The head the note names, or null when it names none, as every note from before #420. */
  readonly head: string | null;
  /** The Kit's whole note, which ends with the run's `fix` comment. */
  readonly note: string;
}

/**
 * Every Implement run's push the Kit noted on a pull request, oldest first,
 * read as the Digest's rounds read them (noteRound), from the Kit's own
 * comments alone. The push that opened the pull request leaves no note, and
 * a Request-changes run that committed nothing pushed nothing.
 */
export function runPushesIn({ kitComments, landedNothing }: Pick<DigestThread, "kitComments" | "landedNothing">): RunPush[] {
  const bodies = kitComments.map(({ body }) => body);
  return bodies.flatMap((note, at) =>
    noteRound(note, bodies.slice(0, at), landedNothing).flatMap((round): RunPush[] => {
      const head = pushedHeadIn(note);
      switch (round.what) {
        case "retry":
          return [{ run: "retry", ...(round.retry === undefined ? {} : { retry: round.retry }), head, note }];
        case "request-changes-run":
        case "conflict-only-run":
          return [{ run: round.what, head, note }];
        default:
          return [];
      }
    }),
  );
}

/**
 * The kind of run that pushed `head`: the run whose note names it, the latest
 * if more than one does. None when no run's note names it: the Operator
 * pushed it, or the Kit rebased it onto main, even straight after a run's
 * push, which the snapshot's conflictRun and requestChangesRun would still
 * read as that run's.
 */
export function pushedByIn(pushes: readonly RunPush[], head: string): PushingRun | null {
  return pushes.findLast((push) => push.head === head)?.run ?? null;
}
