// The words for a Standing (src/kit/standing.ts): its pill, its sentence and,
// where it has one, its remedy. Worked out when it is shown, from the
// Standing and a clock, so "40 minutes ago" is true then and the Standing
// itself holds no relative time. The wording never quotes a repo's text.
import type { HandBack } from "../loop/handBacks.ts";
import { runNamed } from "../loop/heldRun.ts";
import { DESIGN_LABEL, DISPATCH_LABEL, READY_FOR_AGENT, READY_FOR_HUMAN, REPLAY_TRIGGER_LABEL, RESEARCH_LABEL, REVIEW_LABEL, type TriggerLabel } from "../loop/labels.ts";
import type { AgentRole } from "../loop/types.ts";
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
  "infrastructure-failure": ({ detail }, age) => {
    const ended = `The ${handedBackRun(detail.role)} ended in an Infrastructure failure ${age} ago and the Loop won't retry it.`;
    if (detail.role === "design") return `${ended} Reply on the issue to run the turn again.`;
    return detail.label === null ? ended : `${ended} Add \`${detail.label}\` again to run it.`;
  },
  "broken-run-no-retry": ({ detail }) => `The ${handedBackRun(detail.role)} was a Broken run that used no retry. Add \`${DISPATCH_LABEL}\` again to run it.`,
  "trigger-swept": ({ detail }, age) =>
    `${detail.label === null ? "Its trigger label" : `\`${detail.label}\``} came off ${age} ago: nothing started when it was added, nor when the Kit added it again. Check the Loop's runs, then add it again.`,
  "retry-never-started": ({ issue }) => `The Retry never started and #${issue} is no longer \`${READY_FOR_AGENT}\`, so none will.`,
  "landing-failed": (_, age) => `The Kit couldn't land a finished run ${age} ago. Open the run and re-run its failed jobs.`,
  "request-changes-empty": () => "The Request-changes run committed nothing, so your changes aren't built. It's yours from here.",
  "conflict-run-unlanded": ({ pullRequest }) => `The conflict-only run didn't bring #${pullRequest} up to date with \`main\`.`,
  "request-changes-unlanded": ({ pullRequest }) => `The Request-changes run on #${pullRequest} didn't land.`,
  "closed-by-hand": () => "Its agent pull request was closed by hand, so the Ticket stopped.",
  "kept-branch-gone": () => "Marked for a Kept-branch start, but the Kept branch is gone.",
  "research-failed": ({ detail }, age) => `The Research run failed ${age} ago. Add \`${detail.label}\` again to run it.`,
  "research-branch-refused": ({ detail }, age) => `The Kit refused the Research run's branch ${age} ago. Add \`${detail.label}\` again to run it.`,
  "design-turn-failed": (_, age) => `A Design-session turn failed ${age} ago. Reply on the issue to run it again.`,
  "map-cap-refused": (_, age) => `The Map cap refused this session's Map ${age} ago. Reply on the issue to carry on.`,
  "weekly-summary-failed": (_, age) => `The Weekly summary run failed ${age} ago, so this week's isn't filed. Open the run and re-run its failed jobs.`,
};

/** The run a hand-back names, as in "The Implement run": just "run" where an old notice named none. */
function handedBackRun(role: AgentRole | null): string {
  return role === null ? "run" : runNamed(role);
}

/** A Standing's pill, sentence and remedy at `now`, ISO 8601; times it names are told in `timeZone`. */
export function wordStanding(standing: Standing, now: string, timeZone: string): StandingWords {
  const age = ageSince(standing.since, now);
  switch (standing.name) {
    case "running": {
      const { run, retry } = standing.detail;
      const named = run === "retry" && retry !== null ? `Retry ${retry}` : (RUNNING_RUNS[run as RunningRun] ?? "A run");
      return { pill: "Running", sentence: `${named} has been running for ${age}.`, remedy: null };
    }
    case "waiting-on-checks": {
      const { plain, check, checksUnread } = standing.detail;
      const sentence =
        plain === null
          ? "Its Review is waiting for the Required checks on its head."
          : checksUnread
            ? "Waiting on its Required checks, which could not be read."
            : `Waiting on \`${check}\`.`;
      return { pill: "Waiting on checks", sentence, remedy: null };
    }
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
    case "not-started":
      return { pill: "Not started", ...notStartedWords(standing, age, false) };
    case "stuck": {
      if (standing.detail.was !== "not-started") throw new Error(`No wording for a Stuck ${standing.detail.was} Standing yet.`);
      const { was, ...detail } = standing.detail;
      return { pill: "Stuck", ...notStartedWords({ ...standing, name: was, detail }, age, true) };
    }
    case "yours-to-merge": {
      const passed = `with its Required checks passed, since ${age} ago.`;
      const sentence =
        standing.detail.plain === null
          ? `Passed Review ${age} ago and is waiting for your merge.`
          : standing.work === "plain"
            ? `Ready, ${passed}`
            : `Its Pairing session's pull request, #${standing.pullRequest}, is ready, ${passed}`;
      return { pill: "Yours to merge", sentence, remedy: null };
    }
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
    case "check-failing": {
      const { check, checkIs } = standing.detail;
      return { pill: check, sentence: checkIs === "failing" ? `\`${check}\` is failing.` : `\`${check}\` has not reported on its head.`, remedy: null };
    }
    case "conflicts": {
      const then = standing.detail.plain === "kit-bump" ? "Dependabot rebases it by itself." : "Resolve it on GitHub.";
      return { pill: "Conflicts with `main`", sentence: `It conflicts with \`main\`. ${then}`, remedy: null };
    }
    case "draft":
      return { pill: "Draft", sentence: "A draft; nothing is owed on it.", remedy: null };
    case "blocked":
      return { pill: "Blocked", sentence: `Blocked by ${spelled(standing.detail.blockers.map((blocker) => `#${blocker}`), "and")}.`, remedy: null };
    case "waiting-on-author":
      return { pill: "Waiting on its author", sentence: `Triage asked its author, ${standing.detail.author}, a question ${age} ago.`, remedy: null };
    default:
      throw new Error(`No wording for a ${standing.name} Standing yet.`);
  }
}

/** The run each trigger label asks for, as a not-started Standing's sentence names it. */
const ASKED_RUNS: Readonly<Record<TriggerLabel, string>> = {
  [DISPATCH_LABEL]: "an Implement run",
  [DESIGN_LABEL]: "a Design-session turn",
  [REVIEW_LABEL]: "a Review",
  [RESEARCH_LABEL]: "a Research run",
  [REPLAY_TRIGGER_LABEL]: "a Replay",
};

/**
 * The sentence and remedy of a run that was asked for and never began, before
 * the bar or at it (`stuck`), aged from when it was asked for. "The Loop's
 * runs" links to the repo's Actions runs.
 */
function notStartedWords({ repo, issue, detail }: StandingNamed<"not-started">, age: string, stuck: boolean): Omit<StandingWords, "pill"> {
  const runs = `Check [the Loop's runs](https://github.com/${repo}/actions)`;
  if (detail.silence === "retry") {
    return {
      sentence: stuck
        ? `No Retry has started since the Execution flaw ${age} ago.`
        : `An Execution flaw called for a Retry ${age} ago; nothing has started. The Kit adds \`${DISPATCH_LABEL}\` to #${issue} again once the Implement job's timeout has passed.`,
      remedy: `${runs}, then add \`${DISPATCH_LABEL}\` to #${issue}.`,
    };
  }
  const { label } = detail;
  const remedy = `${runs}, then add \`${label}\` again.`;
  if (detail.silence === "trigger-readded") {
    return {
      sentence: stuck
        ? `Nothing has run since the Kit added \`${label}\` again ${age} ago.`
        : `The Kit added \`${label}\` again ${age} ago; nothing has started. At its next hourly check it takes the label off and hands this to you.`,
      remedy,
    };
  }
  const asked = ASKED_RUNS[label];
  return {
    sentence: stuck ? `Nothing has run since the Kit asked for ${asked} ${age} ago.` : `Asked for ${asked} ${age} ago; nothing has started. The Kit adds the label again at its next hourly check.`,
    remedy,
  };
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
