// The words for a Standing (src/kit/standing.ts): its pill, its sentence and,
// where it has one, its remedy. Worked out when it is shown, from the
// Standing and a clock, so "40 minutes ago" is true then and the Standing
// itself holds no relative time. The wording never quotes a repo's text.
import type { HandBack } from "../loop/handBacks.ts";
import { READY_FOR_HUMAN } from "../loop/labels.ts";
import type { Standing, StandingNamed } from "./standing.ts";

/** What a Standing says when shown. */
export interface StandingWords {
  /** A word or two, for a pill beside its title. */
  readonly pill: string;
  /** One sentence on where it stands. */
  readonly sentence: string;
  /** What the Operator can do about it, or null. */
  readonly remedy: string | null;
}

/** The sentence for each hand-back a `yours-to-do` Standing names, in the order of HAND_BACKS; one it lacks reads as `ready-for-human` work. */
const HAND_BACK_SENTENCES: Partial<Record<HandBack, (standing: StandingNamed<"yours-to-do">, age: string) => string>> = {};

/** A Standing's pill, sentence and remedy at `now`, ISO 8601; times it names are told in `timeZone`. */
export function wordStanding(standing: Standing, now: string, _timeZone: string): StandingWords {
  const age = ageSince(standing.since, now);
  switch (standing.name) {
    case "yours-to-merge":
      return { pill: "Yours to merge", sentence: `Passed Review ${age} ago and is waiting for your merge.`, remedy: null };
    case "design-round": {
      const { round, prototype } = standing.detail;
      const prototypeIs = prototype === "ready" ? ": the prototype is ready to look at" : prototype === "failed" ? ": the prototype failed" : "";
      return { pill: `Design round ${round}`, sentence: `Round ${round} has waited for your answer since ${age} ago${prototypeIs}.`, remedy: null };
    }
    case "needs-your-answer":
      return { pill: "Needs your answer", sentence: `Triage asked a question ${age} ago and is waiting for your answer.`, remedy: null };
    case "yours-to-do": {
      const handedBack = standing.detail.handBack === null ? undefined : HAND_BACK_SENTENCES[standing.detail.handBack];
      return { pill: "Yours to do", sentence: handedBack?.(standing, age) ?? `Handed to you with \`${READY_FOR_HUMAN}\` ${age} ago.`, remedy: null };
    }
    case "waiting-on-author":
      return { pill: "Waiting on its author", sentence: `Triage asked its author, ${standing.detail.author}, a question ${age} ago.`, remedy: null };
    default:
      throw new Error(`No wording for a ${standing.name} Standing yet.`);
  }
}

/** How long ago `at` was at `now`, both ISO 8601: whole minutes under an hour, whole hours under two days, else whole days. */
export function ageSince(at: string, now: string): string {
  const minutes = Math.floor((Date.parse(now) - Date.parse(at)) / (60 * 1000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}
