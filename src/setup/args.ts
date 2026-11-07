// The setup program's command line. Each question has a flag, and an empty
// value or a --no- form answers no, so the program asks only what the flags
// left out. Anything it doesn't know is refused, with the usage line.
import type { VisualEvidenceAnswers } from "./plan.ts";

export const SETUP_USAGE =
  "Usage: node src/setup/main.ts <product checkout> <release> [--account=<1Password account>]" +
  " [--time-zone=<IANA zone> | --no-time-zone] [--second-subscription | --no-second-subscription] [--paused | --no-paused]" +
  " [--ui-path=<glob>]... [--ui-serve=<command>] [--ui-url=<url>] [--ui-before-url=<url>] [--ui-default-route=<route>]... [--preview-url=<template>]" +
  " [--plan | --apply]";

/** The questions' answers the flags gave. A missing one is unanswered; null or false answers no. */
export interface FlagAnswers {
  readonly timeZone?: string | null;
  readonly secondSubscription?: boolean;
  readonly paused?: boolean;
}

export interface SetupArgs {
  readonly productDir: string;
  readonly release: string;
  /** --plan: print the plan and exit, changing nothing. */
  readonly plan: boolean;
  /** --apply: carry the plan out, as the setup skill's step 5 does. */
  readonly apply: boolean;
  /** --account=: the 1Password account, as op's --account takes it. */
  readonly account?: string;
  readonly answers: FlagAnswers;
  readonly visualEvidence?: VisualEvidenceAnswers;
}

export type ParsedArgs = { readonly ok: true; readonly args: SetupArgs } | { readonly ok: false; readonly error: string };

/** The yes-or-no questions' flags. Each also has a --no- form. */
const YES_OR_NO = new Map<string, "secondSubscription" | "paused">([
  ["--second-subscription", "secondSubscription"],
  ["--paused", "paused"],
]);

const VISUAL_EVIDENCE_FLAGS = ["ui-path", "ui-serve", "ui-url", "ui-before-url", "ui-default-route", "preview-url"];

export function parseSetupArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const answers: { timeZone?: string | null; secondSubscription?: boolean; paused?: boolean } = {};
  const visualEvidence: string[] = [];
  let account: string | undefined;
  let plan = false;
  let apply = false;
  const refuse = (error: string): ParsedArgs => ({ ok: false, error });

  for (const arg of args) {
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const [flag, value] = splitFlag(arg);
    const yes = YES_OR_NO.get(flag);
    const no = flag.startsWith("--no-") ? YES_OR_NO.get(`--${flag.slice("--no-".length)}`) : undefined;
    if (flag === "--plan" && value === undefined) plan = true;
    else if (flag === "--apply" && value === undefined) apply = true;
    else if (flag === "--account") {
      if (value === undefined || value === "") return refuse("--account= needs a 1Password account, such as my.1password.com.");
      account = value;
    } else if (flag === "--time-zone") {
      if (value === undefined) return refuse("--time-zone takes its value after an =, such as --time-zone=Europe/London.");
      answers.timeZone = value === "" ? null : value;
    } else if (flag === "--no-time-zone" && value === undefined) answers.timeZone = null;
    else if (yes !== undefined) {
      if (value !== undefined && value !== "") return refuse(`${flag} takes no value: give ${flag} for yes, or --no-${flag.slice(2)} for no.`);
      answers[yes] = value === undefined;
    } else if (no !== undefined && value === undefined) answers[no] = false;
    else if (VISUAL_EVIDENCE_FLAGS.includes(flag.slice(2)) && value !== undefined) visualEvidence.push(arg);
    else return refuse(`Unknown flag ${arg}.`);
  }

  if (plan && apply) return refuse("--plan prints the plan and changes nothing, so it can't go with --apply.");
  const [productDir, release, ...extra] = positionals;
  if (productDir === undefined || release === undefined) return refuse("Setup needs the Product checkout and the release.");
  if (extra.length > 0) return refuse(`Unexpected argument ${extra[0]}: a flag's value goes after its =, such as --time-zone=Europe/London.`);
  const visual = visualEvidenceAnswers(visualEvidence);
  return {
    ok: true,
    args: {
      productDir,
      release,
      plan,
      apply,
      ...(account === undefined ? {} : { account }),
      answers,
      ...(visual === undefined ? {} : { visualEvidence: visual }),
    },
  };
}

/** A flag and its value, split at the first =; the value is undefined when there's no =. */
function splitFlag(arg: string): [string, string | undefined] {
  const at = arg.indexOf("=");
  return at === -1 ? [arg, undefined] : [arg.slice(0, at), arg.slice(at + 1)];
}

/** Every value given as --<name>=<value>, in order. */
function flagValues(args: readonly string[], name: string): string[] {
  const prefix = `--${name}=`;
  return args.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
}

/** The Visual evidence step's answers, when any of its flags is given. A missing ui flag is left blank for the planner to name. */
function visualEvidenceAnswers(args: readonly string[]): VisualEvidenceAnswers | undefined {
  if (VISUAL_EVIDENCE_FLAGS.every((name) => flagValues(args, name).length === 0)) return undefined;
  const last = (name: string) => flagValues(args, name).at(-1);
  const beforeUrl = last("ui-before-url");
  const previewUrl = last("preview-url");
  return {
    paths: flagValues(args, "ui-path"),
    serve: last("ui-serve") ?? "",
    url: last("ui-url") ?? "",
    ...(beforeUrl === undefined ? {} : { beforeUrl }),
    defaultRoutes: flagValues(args, "ui-default-route"),
    ...(previewUrl === undefined ? {} : { previewUrl }),
  };
}
