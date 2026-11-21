// The setup program's command line. Each question has a flag, and an empty
// value or a --no- form answers no, so the program asks only what the flags
// left out. Anything it doesn't know is refused, with the usage line.
import { setupCommand } from "./finish.ts";

/**
 * How the Operator runs setup: through the bootstrap command, which gives the
 * program the checkout and the release. The bootstrap takes the release first,
 * or as --release=, which it never passes on.
 */
export const SETUP_USAGE =
  `Usage: ${setupCommand("[release | --release=<release>]")} [--account=<1Password account>]` +
  " [--time-zone=<IANA zone> | --no-time-zone] [--second-subscription | --no-second-subscription] [--paused | --no-paused]" +
  " [--production-url=<address> | --no-production] [--production-environment=<Deployments environment>]" +
  " [--staging-url=<address> | --no-staging] [--staging-environment=<Deployments environment>]" +
  " [--plan]";

/** The questions' answers the flags gave. A missing one is unanswered; null or false answers no. */
export interface FlagAnswers {
  readonly timeZone?: string | null;
  readonly secondSubscription?: boolean;
  readonly paused?: boolean;
  /** --production-url=: the production site's address; null, from --no-production or an empty value, declares none. */
  readonly productionUrl?: string | null;
  /** --production-environment=: the environment its deploys carry in GitHub's Deployments; null, from an empty value, names none. */
  readonly productionEnvironment?: string | null;
  /** --staging-url=: the staging site's address; null, from --no-staging or an empty value, declares none. */
  readonly stagingUrl?: string | null;
  /** --staging-environment=: the environment its deploys carry in GitHub's Deployments; null, from an empty value, names none, and staging needs one. */
  readonly stagingEnvironment?: string | null;
}

export interface SetupArgs {
  readonly productDir: string;
  readonly release: string;
  /** --plan: print the plan and exit, changing nothing. */
  readonly plan: boolean;
  /** --account=: the 1Password account, as op's --account takes it. */
  readonly account?: string;
  readonly answers: FlagAnswers;
}

export type ParsedArgs = { readonly ok: true; readonly args: SetupArgs } | { readonly ok: false; readonly error: string };

/** The yes-or-no questions' flags. Each also has a --no- form. */
const YES_OR_NO = new Map<string, "secondSubscription" | "paused">([
  ["--second-subscription", "secondSubscription"],
  ["--paused", "paused"],
]);

/** Production's and staging's flags that take a value, each with the answer it gives and a value to show in its refusal. */
const ADDRESS_OR_ENVIRONMENT = new Map<string, readonly [answer: "productionUrl" | "productionEnvironment" | "stagingUrl" | "stagingEnvironment", suchAs: string]>([
  ["--production-url", ["productionUrl", "https://example.com"]],
  ["--production-environment", ["productionEnvironment", "production"]],
  ["--staging-url", ["stagingUrl", "https://staging.example.com"]],
  ["--staging-environment", ["stagingEnvironment", "staging"]],
]);

export function parseSetupArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const answers: { -readonly [K in keyof FlagAnswers]: FlagAnswers[K] } = {};
  let account: string | undefined;
  let plan = false;
  const refuse = (error: string): ParsedArgs => ({ ok: false, error });

  for (const arg of args) {
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const [flag, value] = splitFlag(arg);
    const yes = YES_OR_NO.get(flag);
    const no = flag.startsWith("--no-") ? YES_OR_NO.get(`--${flag.slice("--no-".length)}`) : undefined;
    const valued = ADDRESS_OR_ENVIRONMENT.get(flag);
    if (flag === "--plan" && value === undefined) plan = true;
    else if (flag === "--account") {
      if (value === undefined || value === "") return refuse("--account= needs a 1Password account, such as my.1password.com.");
      account = value;
    } else if (flag === "--time-zone") {
      if (value === undefined) return refuse("--time-zone takes its value after an =, such as --time-zone=Europe/London.");
      answers.timeZone = value === "" ? null : value;
    } else if (flag === "--no-time-zone" && value === undefined) answers.timeZone = null;
    else if (valued !== undefined) {
      const [answer, suchAs] = valued;
      if (value === undefined) return refuse(`${flag} takes its value after an =, such as ${flag}=${suchAs}.`);
      answers[answer] = value.trim() === "" ? null : value.trim();
    } else if (flag === "--no-production" && value === undefined) answers.productionUrl = null;
    else if (flag === "--no-staging" && value === undefined) answers.stagingUrl = null;
    else if (yes !== undefined) {
      if (value !== undefined && value !== "") return refuse(`${flag} takes no value: give ${flag} for yes, or --no-${flag.slice(2)} for no.`);
      answers[yes] = value === undefined;
    } else if (no !== undefined && value === undefined) answers[no] = false;
    else return refuse(`Unknown flag ${arg}.`);
  }

  const [productDir, release, ...extra] = positionals;
  if (productDir === undefined || release === undefined) return refuse("Setup needs the Product checkout and the release.");
  if (extra.length > 0) return refuse(`Unexpected argument ${extra[0]}: a flag's value goes after its =, such as --time-zone=Europe/London.`);
  return { ok: true, args: { productDir, release, plan, ...(account === undefined ? {} : { account }), answers } };
}

/** A flag and its value, split at the first =; the value is undefined when there's no =. */
function splitFlag(arg: string): [string, string | undefined] {
  const at = arg.indexOf("=");
  return at === -1 ? [arg, undefined] : [arg.slice(0, at), arg.slice(at + 1)];
}
