// Setup's questions: the Operator's time zone, a second Subscription, and
// whether to install with Dispatch paused. Each has a flag, and setup asks
// only what the flags left out, and only on a terminal. Without one, a missing
// answer means no, but for pausing the starter setup wrote on its branch, which
// keeps what it holds.
import { KIT_CONFIG_PATH } from "../kit/config.ts";
import type { FlagAnswers } from "./args.ts";
import { isTimeZone, pausesDispatch, type ProductState, type SetupAnswers, subscriptionsTheKitReads } from "./plan.ts";
import { isYes, type Prompt } from "./prompt.ts";
import { STORE_CALLER_PATH, timeZoneIn } from "./shims.ts";

export interface QuestionInputs {
  readonly flags: FlagAnswers;
  readonly state: ProductState;
  /** Whether the repo's Kit config is the starter setup wrote on its branch, still setup's own until the setup PR merges. */
  readonly wroteStarter: boolean;
  /** This machine's time zone, offered when fabrik-runs holds none. */
  readonly machineTimeZone: string;
  /** Null without a terminal. */
  readonly prompt: Prompt | null;
  readonly say: (line: string) => void;
}

export type QuestionAnswers = Pick<SetupAnswers, "timeZone" | "secondSubscription" | "paused">;

export async function askQuestions({ flags, state, wroteStarter, machineTimeZone, prompt, say }: QuestionInputs): Promise<QuestionAnswers> {
  const timeZone = flags.timeZone !== undefined ? flags.timeZone : await askTimeZone(state, machineTimeZone, prompt, say);
  const secondSubscription = await askSecondSubscription(flags.secondSubscription, state, prompt, say);
  const paused = flags.paused ?? (await askPaused(state, wroteStarter, prompt, say));
  return {
    ...(timeZone === null ? {} : { timeZone }),
    ...(secondSubscription ? { secondSubscription } : {}),
    ...(paused ? { paused } : {}),
  };
}

/** The time zone for the Weekly summary, offering the one fabrik-runs holds, else this machine's. Null leaves fabrik-runs out. */
async function askTimeZone(state: ProductState, machineTimeZone: string, prompt: Prompt | null, say: (line: string) => void): Promise<string | null> {
  if (prompt === null) return null;
  const caller = state.store.files[STORE_CALLER_PATH];
  const offered = (caller == null ? null : timeZoneIn(caller)) ?? machineTimeZone;
  say("Setup also sets up fabrik-runs, where each Run record goes. The Weekly summary is filed there each Monday at 07:00 your time.");
  for (;;) {
    const answer = await prompt.ask(`Your time zone, or no to leave fabrik-runs out [${offered}]: `);
    if (answer === null || /^no?$/i.test(answer.trim())) return null;
    const timeZone = answer.trim() === "" ? offered : answer.trim();
    if (isTimeZone(timeZone)) return timeZone;
    say(`${timeZone} isn't an IANA time zone, such as Europe/London.`);
  }
}

/**
 * A Kit config that lists two or more Subscriptions is a rotation setup never
 * adds to, so it isn't asked about, and --second-subscription does nothing
 * for it but say so.
 */
async function askSecondSubscription(flag: boolean | undefined, state: ProductState, prompt: Prompt | null, say: (line: string) => void): Promise<boolean> {
  const listed = subscriptionsTheKitReads(state.files[KIT_CONFIG_PATH] ?? null);
  if (listed.length > 1) {
    const lists = `${KIT_CONFIG_PATH} already lists ${listed.length} Subscriptions, and Setup leaves a list of two or more as it is`;
    if (flag === true) say(`--second-subscription has no effect: ${lists}.`);
    else if (flag === undefined && prompt !== null) say(`${lists}, so it doesn't ask about a second.`);
    return false;
  }
  if (flag !== undefined) return flag;
  if (prompt === null) return false;
  say("A second Subscription is a second Claude account. Runs move to it when the first is used up, so they wait only once both are.");
  return isYes(await prompt.ask("Add a second Subscription? [y/N] "));
}

/**
 * --paused changes only the starter, so a Kit config the default branch has,
 * the Product's own, isn't asked about. The starter setup wrote on its branch
 * is asked about again, offering what it holds.
 */
async function askPaused(state: ProductState, wroteStarter: boolean, prompt: Prompt | null, say: (line: string) => void): Promise<boolean> {
  const config = state.files[KIT_CONFIG_PATH] ?? null;
  if (config !== null && !wroteStarter) return false;
  const held = config !== null && pausesDispatch(config);
  if (prompt === null) return held;
  const { readyForAgent } = state;
  say(
    readyForAgent === 0
      ? "No open issues are labelled ready-for-agent."
      : `${readyForAgent} open ${readyForAgent === 1 ? "issue is" : "issues are"} labelled ready-for-agent. Dispatch starts releasing them to Implementers as soon as the setup PR merges.`,
  );
  const answer = await prompt.ask(`Install with Dispatch paused, so no Implementer starts until you raise max_in_flight? ${held ? "[Y/n]" : "[y/N]"} `);
  return answer === null || answer.trim() === "" ? held : isYes(answer);
}
