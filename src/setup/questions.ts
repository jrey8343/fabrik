// Setup's questions: the Operator's time zone, a second Subscription, and
// whether to install with Dispatch paused. Each has a flag, and setup asks
// only what the flags left out, and only on a terminal. Without one, a missing
// answer means no.
import { KIT_CONFIG_PATH } from "../kit/config.ts";
import type { FlagAnswers } from "./args.ts";
import { isTimeZone, type ProductState, type SetupAnswers } from "./plan.ts";
import { isYes, type Prompt } from "./prompt.ts";
import { STORE_CALLER_PATH, timeZoneIn } from "./shims.ts";

export interface QuestionInputs {
  readonly flags: FlagAnswers;
  readonly state: ProductState;
  /** This machine's time zone, offered when fabrik-runs holds none. */
  readonly machineTimeZone: string;
  /** Null without a terminal. */
  readonly prompt: Prompt | null;
  readonly say: (line: string) => void;
}

export type QuestionAnswers = Pick<SetupAnswers, "timeZone" | "secondSubscription" | "paused">;

export async function askQuestions({ flags, state, machineTimeZone, prompt, say }: QuestionInputs): Promise<QuestionAnswers> {
  const timeZone = flags.timeZone !== undefined ? flags.timeZone : await askTimeZone(state, machineTimeZone, prompt, say);
  const secondSubscription = flags.secondSubscription ?? (await askSecondSubscription(prompt, say));
  // --paused changes only the starter: an existing Kit config is the Product's.
  const paused = flags.paused ?? (state.files[KIT_CONFIG_PATH] == null ? await askPaused(state.readyForAgent, prompt, say) : false);
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

async function askSecondSubscription(prompt: Prompt | null, say: (line: string) => void): Promise<boolean> {
  if (prompt === null) return false;
  say("A second Subscription is a second Claude account. Runs move to it when the first is used up, so they wait only once both are.");
  return isYes(await prompt.ask("Add a second Subscription? [y/N] "));
}

async function askPaused(readyForAgent: number, prompt: Prompt | null, say: (line: string) => void): Promise<boolean> {
  if (prompt === null) return false;
  say(
    readyForAgent === 0
      ? "No open issues are labelled ready-for-agent."
      : `${readyForAgent} open ${readyForAgent === 1 ? "issue is" : "issues are"} labelled ready-for-agent. Dispatch starts releasing them to Implementers as soon as the setup PR merges.`,
  );
  return isYes(await prompt.ask("Install with Dispatch paused, so no Implementer starts until you raise max_in_flight? [y/N] "));
}
