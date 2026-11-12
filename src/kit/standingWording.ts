// The words for a Standing (src/kit/standing.ts): its pill, its sentence and,
// where it has one, its remedy. Worked out when it is shown, from the
// Standing and a clock, so "40 minutes ago" is true then and the Standing
// itself holds no relative time. The wording never quotes a repo's text.
import type { HandBack } from "../loop/handBacks.ts";
import { runNamed } from "../loop/heldRun.ts";
import { READY_FOR_HUMAN } from "../loop/labels.ts";
import { readable, spelled } from "../loop/readable.ts";
import type { Standing, StandingNamed } from "./standing.ts";
import type { RunningRun } from "./standingInFlight.ts";

/** What a Standing says when shown. */
export interface StandingWords {
  /** A word or two, for a pill beside its title. */
  readonly pill: string;
  /** One sentence on where it stands. */
  readonly sentence: string;
  /** What the Operator can do about it, or null. */
  readonly remedy: string | null;
}

/** How a `running` Standing's sentence names its run, at the start of a sentence; a Retry is named by its number. */
const RUNNING_RUNS: Readonly<Record<RunningRun, string>> = {
  implement: "An Implement run",
  retry: "A Retry",
  "request-changes": "A Request-changes run",
  "conflict-only": "A conflict-only run",
  review: "A Review",
  triage: "A Triage run",
  research: "A Research run",
  design: "A Design-session turn",
  prototype: "A Prototype turn",
};

/** The sentence for each hand-back a `yours-to-do` Standing names, in the order of HAND_BACKS; one it lacks reads as `ready-for-human` work. */
const HAND_BACK_SENTENCES: Partial<Record<HandBack, (standing: StandingNamed<"yours-to-do">, age: string) => string>> = {
  "research-failed": ({ detail }, age) => `The Research run failed ${age} ago. Add \`${detail.label}\` again to run it.`,
  "design-turn-failed": (_, age) => `A Design-session turn failed ${age} ago. Reply on the issue to run it again.`,
  "map-cap-refused": (_, age) => `The Map cap refused this session's Map ${age} ago. Reply on the issue to carry on.`,
  "weekly-summary-failed": (_, age) => `The Weekly summary run failed ${age} ago, so this week's isn't filed. Open the run and re-run its failed jobs.`,
};

/** A Standing's pill, sentence and remedy at `now`, ISO 8601; times it names are told in `timeZone`. */
export function wordStanding(standing: Standing, now: string, timeZone: string): StandingWords {
  const age = ageSince(standing.since, now);
  switch (standing.name) {
    case "running": {
      const { run, retry } = standing.detail;
      const named = run === "retry" && retry !== null ? `Retry ${retry}` : (RUNNING_RUNS[run as RunningRun] ?? "A run");
      return { pill: "Running", sentence: `${named} has been running for ${age}.`, remedy: null };
    }
    case "waiting-on-checks":
      return { pill: "Waiting on checks", sentence: "Its Review is waiting for the Required checks on its head.", remedy: null };
    case "held": {
      const { carrier, role } = standing.detail;
      return { pill: "Held", sentence: `Its ${runNamed(role)} is held${carrier === null ? "" : ` on #${carrier}`} until a Subscription is free.`, remedy: null };
    }
    case "waiting-for-slot": {
      const { slot, maxInFlight } = standing.detail;
      if (slot === "design-session") return { pill: "Waiting for a slot", sentence: `Waiting for a Design session slot for ${age}.`, remedy: null };
      const sentence = maxInFlight === 0 ? "Dispatch is paused: `max_in_flight` is 0." : `Waiting for a slot for ${age}: \`max_in_flight\` is ${maxInFlight}.`;
      return { pill: "Waiting for a slot", sentence, remedy: null };
    }
    case "waiting-for-reset": {
      const { resetsAt } = standing.detail;
      const resets = resetsAt === null ? "; when it resets is not known" : ` and resets ${readable(resetsAt, timeZone)}`;
      return { pill: "Used up", sentence: `${standing.subscription} reached its weekly limit${resets}. Runs go to the next Subscription.`, remedy: null };
    }
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
      const handedOver =
        standing.work === "usage-credits"
          ? `${standing.subscription} was caught spending usage credits. Nothing runs on it until you turn them off and close this issue.`
          : `Handed to you with \`${READY_FOR_HUMAN}\` ${age} ago.`;
      return { pill: "Yours to do", sentence: handedBack?.(standing, age) ?? handedOver, remedy: null };
    }
    case "weekly-limit-reached": {
      const { resetsAt } = standing.detail;
      const resets = resetsAt === null ? "; when the first resets is not known." : `. The first resets ${readable(resetsAt, timeZone)}.`;
      return { pill: "Weekly limit reached", sentence: `Every Subscription is used up${resets}`, remedy: null };
    }
    case "token-refused": {
      const sentence = standing.detail.anotherFree
        ? `${standing.subscription}'s Claude token was refused. Runs go to the next Subscription until it's rotated.`
        : "No run can start until it's rotated.";
      return { pill: "Claude token refused", sentence, remedy: null };
    }
    case "yours-to-read":
      return { pill: "Yours to read", sentence: readingSentence(standing, age), remedy: null };
    case "blocked":
      return { pill: "Blocked", sentence: `Blocked by ${spelled(standing.detail.blockers.map((blocker) => `#${blocker}`), "and")}.`, remedy: null };
    case "waiting-on-author":
      return { pill: "Waiting on its author", sentence: `Triage asked its author, ${standing.detail.author}, a question ${age} ago.`, remedy: null };
    default:
      throw new Error(`No wording for a ${standing.name} Standing yet.`);
  }
}

/** What reading matter is, and how long it has waited. */
function readingSentence({ work, detail }: StandingNamed<"yours-to-read">, age: string): string {
  if (detail.map !== null) return `A Decision on Map #${detail.map} that is yours to resolve.`;
  switch (work) {
    case "audit":
      return `Audit open for ${age}.`;
    case "retro":
      return `Retro open for ${age}.`;
    case "replay":
      return `Replay results in for ${age}.`;
    case "map":
      return `Map open for ${age}, ${decisions(detail.decisions.length)} waiting on you.`;
    case "weekly-summary":
      return `This week's summary, filed ${age} ago.`;
    default:
      return `Open for ${age}.`;
  }
}

/** `no Decisions`, `1 Decision` or `2 Decisions`. */
function decisions(count: number): string {
  return count === 0 ? "no Decisions" : count === 1 ? "1 Decision" : `${count} Decisions`;
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
