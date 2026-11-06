// The Replay (#156), beside the Scorers and the Run record: the request a
// `fabrik:replay` issue's body makes. The request is the body's one fenced
// ```replay block of `name: value` lines, naming exactly one variable
// (`implement.model`, `implement.effort`, `review.model`, `review.effort`, or
// `kit` for a candidate Fabrik commit) and, if the Operator likes, `tickets`:
// up to 10 Ticket numbers to replay in place of the default pick. A model or
// effort is held to Kit config's own rules. The "Replay this" link files a
// replay issue whose request names one variable. What the experiment runs:
// the Tickets it picks from the merged ones, each picked Ticket's two arms,
// and the hidden tests, the merged PR's own, that each arm is measured by.
// Pure, no I/O.
import { type ChangedPath, checkTrustRoot } from "../guard/trust-root.ts";
import { newIssueUrl } from "../loop/followUps.ts";
import { REPLAY_LABEL } from "../loop/labels.ts";
import { spelled } from "../loop/readable.ts";
import type { AgentRole } from "../loop/types.ts";
import { FULL_SHA } from "../skills/lock.ts";
import { checkEffort, type KitConfig, refuseFable } from "./config.ts";
import type { ReplayArm, RunRecord } from "./runRecord.ts";

/** A role whose model or effort a Replay can change. */
export type ReplayRole = Extract<AgentRole, "implement" | "review">;

/**
 * The one thing a Replay's variant arm changes from its baseline: a role's
 * model or effort, or the Fabrik commit whose prompts and Base skills it loads.
 */
export type ReplayVariable =
  | { readonly kind: "model"; readonly role: ReplayRole; readonly model: string }
  | { readonly kind: "effort"; readonly role: ReplayRole; readonly effort: string }
  | { readonly kind: "kit"; readonly sha: string };

/** What a replay issue asks for. */
export interface ReplayRequest {
  readonly variable: ReplayVariable;
  /** The Tickets the Operator listed, in their order; null for the default pick. */
  readonly tickets: readonly number[] | null;
}

export type ReplayRequestResult =
  | { readonly ok: true; readonly request: ReplayRequest }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Reads the request block in a replay issue's body, or says every way it's invalid. */
export function readReplayRequest(body: string): ReplayRequestResult {
  const block = requestBlock(body);
  if (typeof block === "string") return { ok: false, errors: [block] };
  const errors: string[] = [];
  const variables: { readonly key: string; readonly variable: ReplayVariable | undefined }[] = [];
  let tickets: number[] | null = null;
  // A line that names no field may be the variable the Operator meant, so it's never also "no variable".
  let unread = false;
  const given = new Set<string>();
  for (const line of block) {
    const at = line.indexOf(":");
    if (at === -1) {
      errors.push(`${JSON.stringify(line.trim())} isn't a field: write each one as name: value`);
      unread = true;
      continue;
    }
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (given.has(key)) {
      errors.push(`${key} is given twice`);
      continue;
    }
    given.add(key);
    if (key === TICKETS_FIELD) {
      tickets = readTickets(value, errors);
      continue;
    }
    const field = variableField(key);
    if (typeof field === "string") {
      errors.push(field);
      unread = true;
      continue;
    }
    variables.push({ key, variable: readVariable(key, value, field, errors) });
  }
  const [named, ...more] = variables;
  if (named === undefined && !unread) errors.push(`the request names no variable: give one of ${spelled(VARIABLE_FIELDS)}`);
  if (more.length > 0) {
    const keys = spelled(variables.map(({ key }) => key), "and");
    errors.push(`the request names ${variables.length} variables, ${keys}, but a replay changes exactly one`);
  }
  if (errors.length > 0 || named?.variable === undefined) return { ok: false, errors };
  return { ok: true, request: { variable: named.variable, tickets } };
}

/**
 * The "Replay this" link: the Product repo's new-issue form, prefilled with
 * the `fabrik:replay` label and a request block naming `variable`, which
 * readReplayRequest reads back as it, with the default pick of Tickets.
 * `repoUrl` is the Product repo whose Tickets it replays, as https://github.com/owner/name.
 */
export function replayThisUrl(repoUrl: string, variable: ReplayVariable): string {
  const line = variableLine(variable);
  // The block goes in as the trailer, the part of the body newIssueUrl never cuts.
  return newIssueUrl(repoUrl, `Replay ${line}`, "", [REQUEST_FENCE, line, "```"].join("\n"), [REPLAY_LABEL]);
}

/** The request block's line naming `variable`. */
function variableLine(variable: ReplayVariable): string {
  switch (variable.kind) {
    case "model":
      return `${variable.role}.model: ${variable.model}`;
    case "effort":
      return `${variable.role}.effort: ${variable.effort}`;
    case "kit":
      return `${KIT_FIELD}: ${variable.sha}`;
  }
}

/** The fence line that opens a request block. */
const REQUEST_FENCE = "```replay";

/** The lines inside the body's request block, or why there's no one block to read. */
function requestBlock(body: string): readonly string[] | string {
  const lines = body.split("\n").map((line) => line.trimEnd());
  const opens = lines.filter((line) => line === REQUEST_FENCE).length;
  if (opens === 0) return `the body has no ${REQUEST_FENCE} block: put the request in one, naming one variable, such as review.effort: high`;
  if (opens > 1) return `the body has ${opens} ${REQUEST_FENCE} blocks, but a request is one`;
  const open = lines.indexOf(REQUEST_FENCE);
  const close = lines.indexOf("```", open + 1);
  if (close === -1) return `the ${REQUEST_FENCE} block is never closed with \`\`\``;
  return lines.slice(open + 1, close).filter((line) => line.trim() !== "");
}

/** The most Tickets a request may list. */
export const MAX_LISTED_TICKETS = 10;

/** The field that lists Tickets, which a request may leave out for the default pick. */
const TICKETS_FIELD = "tickets";

/** The Tickets `tickets` lists, or null with the reason in `errors`. */
function readTickets(value: string, errors: string[]): number[] | null {
  if (value === "") {
    errors.push(`${TICKETS_FIELD} has no value`);
    return null;
  }
  const listed = value.split(/[\s,]+/).filter((item) => item !== "");
  const errorsBefore = errors.length;
  const tickets: number[] = [];
  for (const item of listed) {
    if (!TICKET.test(item)) {
      errors.push(`${TICKETS_FIELD} lists ${JSON.stringify(item)}, which isn't a Ticket number`);
      continue;
    }
    const ticket = Number(item.replace(/^#/, ""));
    if (tickets.includes(ticket)) errors.push(`${TICKETS_FIELD} lists #${ticket} twice`);
    else tickets.push(ticket);
  }
  if (listed.length > MAX_LISTED_TICKETS) {
    errors.push(`${TICKETS_FIELD} lists ${listed.length} Tickets, but a replay takes at most ${MAX_LISTED_TICKETS}`);
  }
  return errors.length === errorsBefore ? tickets : null;
}

/** A Ticket's number, with or without its #. */
const TICKET = /^#?[1-9][0-9]*$/;

/** The roles whose model or effort a Replay can change. */
const REPLAY_ROLES: readonly ReplayRole[] = ["implement", "review"];

/** The field that names a candidate Kit as the variable. */
const KIT_FIELD = "kit";

/** The fields that each name a variable, one of which a request gives. */
const VARIABLE_FIELDS: readonly string[] = [...REPLAY_ROLES.flatMap((role) => [`${role}.model`, `${role}.effort`]), KIT_FIELD];

/** How a variable field reads its value: the check it's held to, and the variable it names. */
interface VariableField {
  readonly check: (value: string) => string | null;
  readonly variable: (value: string) => ReplayVariable;
}

/** The variable `field` names with `value`, or undefined with the reason in `errors`. */
function readVariable(key: string, value: string, field: VariableField, errors: string[]): ReplayVariable | undefined {
  if (value === "") {
    errors.push(`${key} has no value`);
    return undefined;
  }
  const refusal = field.check(value);
  if (refusal !== null) {
    errors.push(`${key} is ${JSON.stringify(value)}: ${refusal}`);
    return undefined;
  }
  return field.variable(value);
}

/** How the field `key` reads its value, or why no variable field is named `key`. */
function variableField(key: string): VariableField | string {
  if (key === KIT_FIELD) return { check: checkCandidateKit, variable: (sha) => ({ kind: "kit", sha }) };
  const [role = "", setting, ...rest] = key.split(".");
  if (rest.length === 0 && (setting === "model" || setting === "effort")) {
    if (!isReplayRole(role)) return `${key} names the ${role} role, but a replay changes only ${spelled(REPLAY_ROLES)}`;
    if (setting === "model") return { check: refuseModel, variable: (model) => ({ kind: "model", role, model }) };
    return { check: checkEffort, variable: (effort) => ({ kind: "effort", role, effort }) };
  }
  return `${key} isn't a request field: give ${spelled(VARIABLE_FIELDS)}, and ${TICKETS_FIELD} if you like`;
}

function isReplayRole(role: string): role is ReplayRole {
  return (REPLAY_ROLES as readonly string[]).includes(role);
}

/** Why `sha` can't be a candidate Kit. Whether it is a commit in the Fabrik repo is the adapter's check. */
function checkCandidateKit(sha: string): string | null {
  return FULL_SHA.test(sha) ? null : "a candidate Kit must be a Fabrik commit's full 40-character lowercase SHA";
}

/** A Claude model's full name, such as claude-sonnet-5-5, never an alias the CLI resolves. */
const CLAUDE_MODEL = /^claude-[a-z0-9][a-z0-9.[\]-]*$/;

/** Why a replay won't run `model`: Kit config's rule first, then only Claude models, each named in full. */
function refuseModel(model: string): string | null {
  return refuseFable(model) ?? (CLAUDE_MODEL.test(model) ? null : "a replay runs only a Claude model, named in full, such as claude-sonnet-5-5");
}

/** A Ticket a Replay might run, with what the pick weighs of it. */
export interface ReplayCandidate {
  readonly ticket: number;
  /** The PR that closed the Ticket, or null when none merged. */
  readonly merged: MergedTicketPullRequest | null;
  /** The store's Run records whose subject is the Ticket, of any role. */
  readonly records: readonly RunRecord[];
  /** How many times the Operator stepped into the Ticket's path between Dispatch and the merge. */
  readonly humanTouches: number;
  /** When the Ticket and its Spec were last edited, ISO 8601; null for one never edited, or no Spec. */
  readonly lastEdited: { readonly ticket: string | null; readonly spec: string | null };
}

/** The PR that closed a Ticket, merged. */
export interface MergedTicketPullRequest {
  readonly number: number;
  /** ISO 8601. */
  readonly mergedAt: string;
  /** Whether a later change reverted it. */
  readonly reverted: boolean;
  /** Every file it changed. */
  readonly files: readonly MergedFile[];
}

/** A Ticket a Replay runs. */
export interface PickedTicket {
  readonly ticket: number;
  /** Its merged PR. */
  readonly pullRequest: number;
  /** Its first Implement run's base, which both arms start from. */
  readonly baseSha: string;
  readonly flags: readonly ReplayFlag[];
}

/**
 * Why a picked Ticket's results need weighing: the original only merged with
 * the Operator's Human touches, its Ticket or Spec was edited after its first
 * Implement run started, so the arms' rebuilt input may differ from the
 * original's, or its merged PR has no hidden tests to measure the arms by.
 */
export type ReplayFlag = "human-touches" | "edited-input" | "no-hidden-tests";

/** Which Tickets a Replay runs, in the order it runs them. */
export interface ReplayPick {
  readonly picked: readonly PickedTicket[];
  /** Each listed Ticket the Replay won't run, in the order listed, with why. */
  readonly leftOut: readonly LeftOutTicket[];
}

/** A listed Ticket a Replay won't run. */
export interface LeftOutTicket {
  readonly ticket: number;
  /** Why, a clause to show the Operator after the Ticket's number. */
  readonly reason: string;
}

/** How many Tickets the default pick takes. */
export const DEFAULT_PICK_SIZE = 5;

/**
 * The Tickets a request's Replay runs, from the candidates. A Ticket is
 * eligible when its PR merged and stayed merged, an Implementer built it from
 * a first Implement run whose record has a `baseSha`, and its merged PR
 * changed no Trust-root file. A listed pick is the listed Tickets that are
 * eligible, in the order listed, with each one left out named with why. The
 * default pick ranks the eligible Tickets by original cost, splits them into
 * thirds, and takes the most recent from each third in turn until it has 5.
 */
export function pickReplayTickets(request: Pick<ReplayRequest, "tickets">, candidates: readonly ReplayCandidate[]): ReplayPick {
  if (request.tickets === null) {
    const eligible = candidates.flatMap((candidate) => {
      const eligibility = eligibilityOf(candidate);
      return typeof eligibility === "string" ? [] : [eligibility];
    });
    return { picked: spreadAcrossCost(eligible).map(({ picked }) => picked), leftOut: [] };
  }
  const picked: PickedTicket[] = [];
  const leftOut: LeftOutTicket[] = [];
  for (const ticket of request.tickets) {
    const eligibility = eligibilityOf(candidates.find((candidate) => candidate.ticket === ticket));
    if (typeof eligibility === "string") leftOut.push({ ticket, reason: eligibility });
    else picked.push(eligibility.picked);
  }
  return { picked, leftOut };
}

/** An eligible Ticket, with what the default pick ranks it by. */
interface Eligible {
  readonly picked: PickedTicket;
  /** The summed cost of its Implement-family and Review runs, in USD. */
  readonly cost: number;
  /** When its PR merged, in ms. */
  readonly mergedAt: number;
}

/** Up to DEFAULT_PICK_SIZE of `eligible`: the most recent of each third of their cost, cheapest third first, in turn. */
function spreadAcrossCost(eligible: readonly Eligible[]): Eligible[] {
  const byCost = eligible.toSorted((a, b) => a.cost - b.cost || b.mergedAt - a.mergedAt);
  const thirds = [0, 1, 2].map((third) =>
    byCost
      .slice(Math.floor((third * byCost.length) / 3), Math.floor(((third + 1) * byCost.length) / 3))
      .toSorted((a, b) => b.mergedAt - a.mergedAt || b.picked.ticket - a.picked.ticket),
  );
  const picked: Eligible[] = [];
  for (let turn = 0; picked.length < Math.min(DEFAULT_PICK_SIZE, eligible.length); turn++) {
    for (const third of thirds) {
      const next = third[turn];
      if (next !== undefined && picked.length < DEFAULT_PICK_SIZE) picked.push(next);
    }
  }
  return picked;
}

/** The candidate as an eligible Ticket, or why it isn't one. */
function eligibilityOf(candidate: ReplayCandidate | undefined): Eligible | string {
  const merged = candidate?.merged ?? null;
  if (candidate === undefined || merged === null) return "no merged PR closed it";
  if (merged.reverted) return `its merged PR #${merged.number} was reverted`;
  const guard = checkTrustRoot(merged.files);
  if (guard.kind === "refuse") {
    const files = guard.paths.length === 1 ? "a Trust-root file" : "Trust-root files";
    return `its merged PR #${merged.number} changed ${files}, ${spelled(guard.paths, "and")}, which no agent may change`;
  }
  // A past Replay's runs on the Ticket are never the original's.
  const originalRuns = candidate.records.filter((record) => record.replay === null && (record.role === "implement" || record.role === "review"));
  const implementRuns = originalRuns.filter((record) => record.role === "implement");
  if (implementRuns.length === 0) return "the store holds no Implement run of it";
  const first = firstRunOf(implementRuns);
  if (first?.baseSha == null) return "the store has no baseSha for its first Implement run";
  const flags: ReplayFlag[] = [];
  if (candidate.humanTouches > 0) flags.push("human-touches");
  if (editedSince(candidate.lastEdited, startOf(first))) flags.push("edited-input");
  if (hiddenTests(merged.files).length === 0) flags.push("no-hidden-tests");
  return {
    picked: { ticket: candidate.ticket, pullRequest: merged.number, baseSha: first.baseSha, flags },
    cost: originalRuns.reduce((sum, record) => sum + (record.totalCostUsd ?? 0), 0),
    mergedAt: Date.parse(merged.mergedAt),
  };
}

/**
 * A Ticket's first Implement run, the one that cut the branch it merged: the
 * last of its runs that wasn't a Retry, Step-up or Request-changes run, since
 * a first run that failed for its Subscription is run again as a first run.
 */
function firstRunOf(implementRuns: readonly RunRecord[]): RunRecord | undefined {
  const first = implementRuns.filter((record) => record.retry === 0 && !record.stepUp && !record.requestChanges);
  return first.toSorted((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt)).at(-1);
}

/** About when a run started, in ms: its end less its agent's duration, or its end when it has none. */
function startOf(record: RunRecord): number {
  return Date.parse(record.endedAt) - (record.durationMs ?? 0);
}

/** Whether the Ticket or its Spec was last edited after `start`. */
function editedSince(lastEdited: ReplayCandidate["lastEdited"], start: number): boolean {
  return [lastEdited.ticket, lastEdited.spec].some((at) => at !== null && Date.parse(at) > start);
}

/** A role's model and effort, as a Replay arm runs it; a null effort passes no --effort, as in Kit config. */
export type ReplayRoleSettings = Pick<KitConfig["roles"][ReplayRole], "model" | "effort">;

/** What one arm of a Replay runs a Ticket with. */
export interface ReplayArmSettings {
  readonly implement: ReplayRoleSettings;
  readonly review: ReplayRoleSettings;
  /**
   * The candidate Kit sha whose prompts and Base skills the arm loads over
   * the pinned release, or null for the pinned release's own.
   */
  readonly candidateSha: string | null;
}

/** What each of a Replay's arms runs a Ticket with. */
export type ReplayArms = Readonly<Record<ReplayArm, ReplayArmSettings>>;

/**
 * A picked Ticket's two arms: the baseline, run with the models and efforts
 * its Kit config held at its `baseSha`, and the variant, differing from the
 * baseline only in `variable`. Both arms load the pinned release's prompts
 * and Base skills unless the variable is a candidate Kit.
 */
export function replayArms(base: Pick<KitConfig, "roles">, variable: ReplayVariable): ReplayArms {
  const { implement, review } = base.roles;
  const baseline: ReplayArmSettings = {
    implement: { model: implement.model, effort: implement.effort },
    review: { model: review.model, effort: review.effort },
    candidateSha: null,
  };
  return { baseline, variant: varied(baseline, variable) };
}

/** `baseline` with `variable` changed. */
function varied(baseline: ReplayArmSettings, variable: ReplayVariable): ReplayArmSettings {
  switch (variable.kind) {
    case "model":
      return { ...baseline, [variable.role]: { ...baseline[variable.role], model: variable.model } };
    case "effort":
      return { ...baseline, [variable.role]: { ...baseline[variable.role], effort: variable.effort } };
    case "kit":
      return { ...baseline, candidateSha: variable.sha };
  }
}

/** One file a merged PR changed, as its diff names it: a rename also carries the path it moved from. */
export interface MergedFile extends ChangedPath {
  /** Whether the PR removed it, so it isn't in the merged tree. */
  readonly removed: boolean;
}

/**
 * A merged PR's hidden tests: the files it added or changed that a fixed Kit
 * list of test-path conventions names as tests, which a Replay lays over each
 * arm's diff. None means "no hidden tests", never a pass.
 */
export function hiddenTests(files: readonly MergedFile[]): string[] {
  return files.flatMap(({ path, removed }) => (!removed && isTestPath(path) ? [path] : []));
}

/** The file names a test takes: `*.test.*`, `*.spec.*`, `*_test.*` and `test_*.*`. */
const TEST_NAMES: readonly RegExp[] = [/^.+\.test\..+$/, /^.+\.spec\..+$/, /^.+_test\..+$/, /^test_.+\..+$/];

/** The folders everything under which is a test's, at any depth. */
const TEST_FOLDERS: readonly string[] = ["test", "tests", "__tests__"];

function isTestPath(path: string): boolean {
  const folders = path.split("/");
  const name = folders.pop() ?? "";
  return TEST_NAMES.some((pattern) => pattern.test(name)) || folders.some((folder) => TEST_FOLDERS.includes(folder));
}
