// A Replay's request (#156): what a `fabrik:replay` issue's body asks for.
// The request is the body's one fenced ```replay block of `name: value`
// lines, naming exactly one variable (`implement.model`, `implement.effort`,
// `review.model`, `review.effort`, or `kit` for a candidate Fabrik commit)
// and, if the Operator likes, `tickets`: up to 10 Ticket numbers to replay in
// place of the default pick. A model or effort is held to Kit config's own
// rules, and a plan's variable is read back by the same rules. The "Replay
// this" link files a replay issue whose request names one variable. The
// Replay module (src/kit/replay.ts) holds the rest. Pure, no I/O.
import { isObject } from "../agent/stream.ts";
import { newIssueUrl } from "../loop/followUps.ts";
import { REPLAY_LABEL } from "../loop/labels.ts";
import { spelled } from "../loop/readable.ts";
import { FULL_SHA } from "../skills/lock.ts";
import { checkEffort, refuseFable } from "./config.ts";
import { REPLAY_ROLES, type ReplayRole } from "./runRecord.ts";

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
export function variableLine(variable: ReplayVariable): string {
  const { key, value } = fieldOf(variable);
  return `${key}: ${value}`;
}

/** A variable that changes one role's setting: its model or its effort. */
type RoleVariable = Extract<ReplayVariable, { readonly kind: "model" | "effort" }>;

/** The role setting a role variable changes, and the value it gives it. */
export function settingOf(variable: RoleVariable): { readonly setting: RoleVariable["kind"]; readonly value: string } {
  return variable.kind === "model" ? { setting: "model", value: variable.model } : { setting: "effort", value: variable.effort };
}

/** The request field naming `variable`, and its value there. */
function fieldOf(variable: ReplayVariable): { readonly key: string; readonly value: string } {
  if (variable.kind === "kit") return { key: KIT_FIELD, value: variable.sha };
  const { setting, value } = settingOf(variable);
  return { key: `${variable.role}.${setting}`, value };
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
export function checkCandidateKit(sha: string): string | null {
  return FULL_SHA.test(sha) ? null : "a candidate Kit must be a Fabrik commit's full 40-character lowercase SHA";
}

/** A Claude model's full name, such as claude-sonnet-5-5, never an alias the CLI resolves. */
const CLAUDE_MODEL = /^claude-[a-z0-9][a-z0-9.[\]-]*$/;

/** Why a replay won't run `model`: Kit config's rule first, then only Claude models, each named in full. */
function refuseModel(model: string): string | null {
  return refuseFable(model) ?? (CLAUDE_MODEL.test(model) ? null : "a replay runs only a Claude model, named in full, such as claude-sonnet-5-5");
}

/** A variable as a plan holds it, held to the same rules as the request's own, or null. */
export function readReplayVariable(value: unknown): ReplayVariable | null {
  if (!isObject(value)) return null;
  const { kind, role, model, effort, sha } = value;
  // Read back through the request field that names it, so it's held to that field's own rules.
  const [key, given] = kind === "kit" ? [KIT_FIELD, sha] : kind === "model" || kind === "effort" ? [`${String(role)}.${kind}`, kind === "model" ? model : effort] : [null, null];
  if (key === null || typeof given !== "string") return null;
  const field = variableField(key);
  return typeof field === "string" || field.check(given) !== null ? null : field.variable(given);
}
