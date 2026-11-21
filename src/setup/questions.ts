// Setup's questions: the Operator's time zone, a second Subscription, whether
// to install with Dispatch paused, where production is, and where staging is.
// Each has a flag, and setup asks only what the flags left out, and only on a
// terminal. Without one, a missing answer means no, but for pausing the starter
// setup wrote on its branch, which keeps what it holds.
import { KIT_CONFIG_PATH, type ProductionConfig, type StagingConfig } from "../kit/config.ts";
import { isTimeZone, knownTimeZone } from "../loop/readable.ts";
import type { FlagAnswers } from "./args.ts";
import {
  declaresProduction,
  declaresStaging,
  type DeploymentsSeen,
  jsonObject,
  pausesDispatch,
  productionEnvironmentIn,
  productionRefusal,
  type ProductState,
  SECOND_SUBSCRIPTION,
  type SetupAnswers,
  stagingRefusal,
  subscriptionsTheKitReads,
  takesSecondSubscription,
} from "./plan.ts";
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
  /** Reads the repo's Deployments with the Operator's gh, only when production's or staging's question needs them to offer an environment or an address. */
  readonly deployments: () => Promise<DeploymentsSeen>;
}

export type QuestionAnswers = Pick<SetupAnswers, "timeZone" | "secondSubscription" | "paused" | "production" | "staging">;

export async function askQuestions({ flags, state, wroteStarter, machineTimeZone, prompt, say, deployments }: QuestionInputs): Promise<QuestionAnswers> {
  const timeZone = flags.timeZone !== undefined ? flags.timeZone : await askTimeZone(state, machineTimeZone, prompt, say);
  const secondSubscription = await askSecondSubscription(flags.secondSubscription, state, prompt, say);
  const paused = flags.paused ?? (await askPaused(state, wroteStarter, prompt, say));
  const seen = sharedDeployments(deployments, say);
  const production = await askProduction(flags, state, prompt, say, seen);
  const staging = await askStaging(flags, state, production, prompt, say, seen);
  return {
    ...(timeZone === null ? {} : { timeZone }),
    ...(secondSubscription ? { secondSubscription } : {}),
    ...(paused ? { paused } : {}),
    ...(production === null ? {} : { production }),
    ...(staging === null ? {} : { staging }),
  };
}

/** The repo's Deployments as production's and staging's questions share them. */
interface SharedDeployments {
  /** Reads them once, for whichever question first needs them. */
  readonly read: () => Promise<DeploymentsSeen>;
  /** Says why they couldn't be read, once for both questions. */
  readonly sayUnread: (why: string) => void;
}

function sharedDeployments(deployments: () => Promise<DeploymentsSeen>, say: (line: string) => void): SharedDeployments {
  let seen: Promise<DeploymentsSeen> | undefined;
  let said = false;
  return {
    read: () => (seen ??= deployments()),
    sayUnread: (why) => {
      if (!said) say(`Setup couldn't read this repo's Deployments (${why}), so it offers no environment.`);
      said = true;
    },
  };
}

/**
 * Where production is, asked once on any run whose Kit config declares none: a
 * first install, a repair, or a run after a bump. It offers an environment from
 * the repo's Deployments, then an address: ui.before_url, else the address on
 * that environment's newest successful Deployment. Null writes no block. An
 * address Kit config would refuse is asked again, and stops the run when a flag
 * gave it.
 */
async function askProduction(
  flags: FlagAnswers,
  state: ProductState,
  prompt: Prompt | null,
  say: (line: string) => void,
  deployments: SharedDeployments,
): Promise<ProductionConfig | null> {
  const config = state.files[KIT_CONFIG_PATH] ?? null;
  const flagged = typeof flags.productionUrl === "string" || typeof flags.productionEnvironment === "string";
  if (config !== null && declaresProduction(config)) {
    if (flagged) say(`${KIT_CONFIG_PATH} already declares production, which Setup leaves as it is, so production's flags have no effect.`);
    return null;
  }
  const url = flags.productionUrl;
  if (url === null) return null;
  if (url !== undefined) {
    const refused = productionRefusal({ url, environment: flags.productionEnvironment ?? null });
    if (refused !== null) throw new Error(`Kit config would refuse --production-url=${url}: ${refused}`);
  }
  if (prompt === null || (config !== null && jsonObject(config) === null)) {
    if (url !== undefined) return { url, environment: flags.productionEnvironment ?? null };
    if (prompt === null && typeof flags.productionEnvironment === "string") {
      say("--production-environment= has no effect without an address: give --production-url= too.");
    }
    if (prompt !== null) say(`${KIT_CONFIG_PATH} isn't a JSON object, so Setup doesn't ask about production: fix it, then run setup again.`);
    return null;
  }
  if (url !== undefined && flags.productionEnvironment !== undefined) return { url, environment: flags.productionEnvironment };

  say(
    "Kit config can say where this repo's site is live, and the environment its deploys carry in GitHub's Deployments, so a merged pull request is followed to production.",
  );
  const seen = await deployments.read();
  const environment = flags.productionEnvironment !== undefined ? flags.productionEnvironment : await askEnvironment(seen, prompt, say, deployments.sayUnread);
  if (url !== undefined) return { url, environment };
  const deployed = seen.read ? (seen.environments.find((candidate) => candidate.name === environment)?.url ?? null) : null;
  const offered = beforeUrlIn(config) ?? deployed;
  for (;;) {
    const answer = (await prompt.ask(`Production's address, or no to leave production out${offered === null ? "" : ` [${offered}]`}: `))?.trim() ?? null;
    if (answer === null || /^no?$/i.test(answer)) return null;
    const address = answer === "" ? offered : answer;
    if (address === null) return null;
    const refused = productionRefusal({ url: address, environment });
    if (refused === null) return { url: address, environment };
    say(`Kit config would refuse that: ${refused}.`);
  }
}

/**
 * The environment production's deploys carry: production when the repo has
 * Deployments by that name, else the only one it has, else the one the
 * Operator picks from the list. None when the repo reports no Deployments, or
 * they couldn't be read.
 */
async function askEnvironment(seen: DeploymentsSeen, prompt: Prompt, say: (line: string) => void, sayUnread: (why: string) => void): Promise<string | null> {
  if (!seen.read) {
    sayUnread(seen.why);
    return null;
  }
  const names = seen.environments.map((environment) => environment.name);
  if (names.length === 0) {
    say(
      "This repo reports no Deployments to GitHub, so merged work won't be followed to production until its deploy runs from an Actions job that names an environment. Setup can write the address alone, with environment null.",
    );
    return null;
  }
  const offered = names.includes("production") ? "production" : names.length === 1 ? names[0]! : null;
  if (offered !== null) {
    for (;;) {
      const answer = (await prompt.ask(`The environment production's deploys carry in GitHub's Deployments, or none [${offered}]: `))?.trim() ?? "";
      if (/^(none|no?)$/i.test(answer)) return null;
      const name = answer === "" ? offered : answer;
      const refused = productionRefusal({ url: "https://example.com", environment: name });
      if (refused === null) return name;
      say(`Kit config would refuse that: ${refused}.`);
    }
  }
  say(`This repo's Deployments carry ${names.length} environments: ${names.map((name, i) => `${i + 1}. ${name}`).join(", ")}.`);
  for (;;) {
    const answer = await prompt.ask("Which one do production's deploys carry? Its number or name, or none: ");
    if (answer === null || /^(none|no?)$/i.test(answer.trim())) return null;
    const chosen = /^\d+$/.test(answer.trim()) ? names[Number(answer.trim()) - 1] : names.find((name) => name === answer.trim());
    if (chosen !== undefined) return chosen;
    say(`Give the number of one of the ${names.length}, its name, or none.`);
  }
}

/**
 * Where staging is, asked beside production's question on any run whose Kit
 * config declares none. It offers an environment from the repo's Deployments,
 * production's left out, then the address on that environment's newest
 * successful Deployment. Staging needs both, so no environment, like no
 * address, writes no block. An answer Kit config would refuse is asked again,
 * and stops the run when a flag gave it.
 */
async function askStaging(
  flags: FlagAnswers,
  state: ProductState,
  production: ProductionConfig | null,
  prompt: Prompt | null,
  say: (line: string) => void,
  deployments: SharedDeployments,
): Promise<StagingConfig | null> {
  const config = state.files[KIT_CONFIG_PATH] ?? null;
  const { stagingUrl: url, stagingEnvironment: environment } = flags;
  const flagged = typeof url === "string" || typeof environment === "string";
  if (config !== null && declaresStaging(config)) {
    if (flagged) say(`${KIT_CONFIG_PATH} already declares staging, which Setup leaves as it is, so staging's flags have no effect.`);
    return null;
  }
  if (url === null || environment === null) return null;
  // The one environment staging's can't be: production's, as just answered, or as the Kit config declares it.
  const productionEnvironment = production?.environment ?? productionEnvironmentIn(config);
  if (flagged) {
    // A value no flag gave is stood in for by one Kit config takes, so only what a flag gave is refused.
    const given = { url: url ?? "https://example.com", environment: environment ?? "an environment" };
    const refused = stagingRefusal(given, environment === undefined ? null : productionEnvironment);
    if (refused !== null) throw new Error(`Kit config would refuse staging's flags: ${refused}`);
  }
  if (url !== undefined && environment !== undefined) return { url, environment };
  if (prompt === null || (config !== null && jsonObject(config) === null)) {
    if (prompt === null && url !== undefined) say("--staging-url= has no effect without an environment, which staging needs: give --staging-environment= too.");
    if (prompt === null && environment !== undefined) say("--staging-environment= has no effect without an address: give --staging-url= too.");
    if (prompt !== null) say(`${KIT_CONFIG_PATH} isn't a JSON object, so Setup doesn't ask about staging: fix it, then run setup again.`);
    return null;
  }

  say(
    "Kit config can also say where this repo's staging site is, and the environment its deploys carry in GitHub's Deployments, so a merged pull request is followed to staging, where you try it before you deploy production.",
  );
  const seen = await deployments.read();
  const named = environment ?? (await askStagingEnvironment(seen, productionEnvironment, prompt, say, deployments.sayUnread));
  if (named === null) return null;
  if (url !== undefined) return { url, environment: named };
  const offered = seen.read ? (seen.environments.find((candidate) => candidate.name === named)?.url ?? null) : null;
  for (;;) {
    const answer = (await prompt.ask(`Staging's address, or no to leave staging out${offered === null ? "" : ` [${offered}]`}: `))?.trim() ?? null;
    if (answer === null || /^no?$/i.test(answer)) return null;
    const address = answer === "" ? offered : answer;
    if (address === null) return null;
    const refused = stagingRefusal({ url: address, environment: named }, productionEnvironment);
    if (refused === null) return { url: address, environment: named };
    say(`Kit config would refuse that: ${refused}.`);
  }
}

/**
 * The environment staging's deploys carry: staging when the repo has
 * Deployments by that name, else the Operator's pick from the others it has,
 * production's never among them, or a name they type. Unlike production's
 * question, it offers no other environment for an Enter, since a repo's only
 * other environment is as likely its previews'. None, or an Enter with
 * nothing offered, leaves staging out.
 */
async function askStagingEnvironment(
  seen: DeploymentsSeen,
  productionEnvironment: string | null,
  prompt: Prompt,
  say: (line: string) => void,
  sayUnread: (why: string) => void,
): Promise<string | null> {
  if (!seen.read) sayUnread(seen.why);
  const all = seen.read ? seen.environments.map((environment) => environment.name) : [];
  const names = all.filter((name) => name !== productionEnvironment);
  const offered = names.includes("staging") ? "staging" : null;
  const listed = offered === null && names.length > 0;
  if (listed) {
    const count = names.length === 1 ? "one environment" : `${names.length} environments`;
    say(`This repo's Deployments carry ${count}${names.length < all.length ? " besides production's" : ""}: ${names.map((name, i) => `${i + 1}. ${name}`).join(", ")}.`);
  }
  const question = listed
    ? "Which one do staging's deploys carry? Its number or name, or none to leave staging out: "
    : `The environment staging's deploys carry in GitHub's Deployments, or none to leave staging out${offered === null ? "" : ` [${offered}]`}: `;
  for (;;) {
    const answer = (await prompt.ask(question))?.trim() ?? null;
    if (answer === null || /^(none|no?)$/i.test(answer)) return null;
    const name = answer === "" ? offered : listed && /^\d+$/.test(answer) ? names[Number(answer) - 1] : answer;
    if (name === null) return null;
    if (name === undefined) {
      say(`Give ${names.length === 1 ? "1" : `the number of one of the ${names.length}`}, a name, or none.`);
      continue;
    }
    const refused = stagingRefusal({ url: "https://example.com", environment: name }, productionEnvironment);
    if (refused === null) return name;
    say(`Kit config would refuse that: ${refused}.`);
  }
}

/** The ui.before_url a Kit config's text holds, which Setup offers for production's address. */
function beforeUrlIn(config: string | null): string | null {
  const ui = config === null ? null : jsonObject(config)?.["ui"];
  const before = typeof ui === "object" && ui !== null ? (ui as Record<string, unknown>)["before_url"] : null;
  return typeof before === "string" && productionRefusal({ url: before, environment: null }) === null ? before : null;
}

/**
 * The Operator's time zone, for the Weekly summary and the Kit config's
 * time_zone, offering the one fabrik-runs holds, else this repo's time_zone,
 * else this machine's, so a repo that drifted comes back in step with the
 * store (ADR-0023). Null leaves fabrik-runs out.
 */
async function askTimeZone(state: ProductState, machineTimeZone: string, prompt: Prompt | null, say: (line: string) => void): Promise<string | null> {
  if (prompt === null) return null;
  const caller = state.store.files[STORE_CALLER_PATH];
  const offered = (caller == null ? null : timeZoneIn(caller)) ?? timeZoneInConfig(state.files[KIT_CONFIG_PATH] ?? null) ?? machineTimeZone;
  say("Setup also sets up fabrik-runs, where each Run record goes. The Weekly summary is filed there each Monday at 07:00 your time.");
  for (;;) {
    const answer = await prompt.ask(`Your time zone, or no to leave fabrik-runs out [${offered}]: `);
    if (answer === null || /^no?$/i.test(answer.trim())) return null;
    const timeZone = answer.trim() === "" ? offered : answer.trim();
    if (isTimeZone(timeZone)) return timeZone;
    say(`${timeZone} isn't an IANA time zone, such as Europe/London.`);
  }
}

/** The time_zone a Kit config's text gives, when it's a zone the runtime knows. */
function timeZoneInConfig(config: string | null): string | null {
  return knownTimeZone(config === null ? undefined : jsonObject(config)?.["time_zone"]);
}

/**
 * A Kit config setup wouldn't list the second Subscription in, a rotation of
 * two or more it never adds to or a list that names it already, isn't asked
 * about, and --second-subscription does nothing for it but say so.
 */
async function askSecondSubscription(flag: boolean | undefined, state: ProductState, prompt: Prompt | null, say: (line: string) => void): Promise<boolean> {
  const listed = subscriptionsTheKitReads(state.files[KIT_CONFIG_PATH] ?? null);
  if (!takesSecondSubscription(listed)) {
    const lists =
      listed.length > 1
        ? `${KIT_CONFIG_PATH} already lists ${listed.length} Subscriptions, and Setup leaves a list of two or more as it is`
        : `${KIT_CONFIG_PATH} already lists the second Subscription, "${SECOND_SUBSCRIPTION}"`;
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
