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
// Where it stands: the plan and each Ticket's progress, in hidden markers in
// the Kit's part of the replay issue's body, below the Operator's request.
// The scheduled tick's next step: accept or reject a waiting request, or
// start the next pending Ticket. And what the Operator reads: the results,
// each arm of each Ticket in a row from what the store holds of it, totals
// per arm, the baseline's gap from the original runs, and a headline line
// computed from the totals. Pure, no I/O.
import { type ChangedPath, checkTrustRoot } from "../guard/trust-root.ts";
import { newIssueUrl } from "../loop/followUps.ts";
import { REPLAY_LABEL } from "../loop/labels.ts";
import { withoutMentions } from "../loop/mentions.ts";
import { spelled } from "../loop/readable.ts";
import type { AgentRole, Verdict } from "../loop/types.ts";
import { FULL_SHA, shortSha } from "../skills/lock.ts";
import { checkEffort, type KitConfig, refuseFable } from "./config.ts";
import { SCORERS } from "./rubrics.ts";
import { type ReplayArm, replayPatchPath, type RunRecord } from "./runRecord.ts";
import { storeFileUrl } from "./runStore.ts";
import type { ScoreFile } from "./scorer.ts";

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
  const { picked, leftOut } = pickWith(request, candidates, () => null);
  return { picked, leftOut };
}

/**
 * The pick, with `rule` saying why it leaves out a Ticket that is otherwise
 * eligible, or null when it doesn't. The default pick takes another in its
 * place, and names each one it leaves out by the rule in `ruledOut`.
 */
function pickWith(
  request: Pick<ReplayRequest, "tickets">,
  candidates: readonly ReplayCandidate[],
  rule: (picked: PickedTicket) => string | null,
): ReplayPick & { readonly ruledOut: readonly LeftOutTicket[] } {
  if (request.tickets === null) {
    const ruledOut: LeftOutTicket[] = [];
    const eligible = eligibleOf(request, candidates).flatMap((each) => {
      const reason = rule(each.picked);
      if (reason !== null) ruledOut.push({ ticket: each.picked.ticket, reason });
      return reason === null ? [each] : [];
    });
    return { picked: spreadAcrossCost(eligible).map(({ picked }) => picked), leftOut: [], ruledOut };
  }
  const picked: PickedTicket[] = [];
  const leftOut: LeftOutTicket[] = [];
  for (const ticket of request.tickets) {
    const eligibility = eligibilityOf(candidates.find((candidate) => candidate.ticket === ticket));
    const reason = typeof eligibility === "string" ? eligibility : rule(eligibility.picked);
    if (reason !== null) leftOut.push({ ticket, reason });
    else if (typeof eligibility !== "string") picked.push(eligibility.picked);
  }
  return { picked, leftOut, ruledOut: [] };
}

/** The eligible Tickets the pick chooses from: every eligible candidate for the default pick, or the listed ones, in the order listed. */
function eligibleOf(request: Pick<ReplayRequest, "tickets">, candidates: readonly ReplayCandidate[]): Eligible[] {
  const considered = request.tickets?.map((ticket) => candidates.find((candidate) => candidate.ticket === ticket)) ?? candidates;
  return considered.flatMap((candidate) => {
    const eligibility = eligibilityOf(candidate);
    return typeof eligibility === "string" ? [] : [eligibility];
  });
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

/** A replay issue, as the tick reads it. */
export interface ReplayIssue {
  readonly number: number;
  readonly open: boolean;
  /** Who filed it: only the Operator's replay issues count. */
  readonly author: string;
  /** Its body as it stands: the Operator's request, with the Kit's part below it once accepted. */
  readonly body: string;
  /** The Fabrik App's own comments on it, oldest first: what the tick has said about its request already. */
  readonly comments: readonly string[];
}

/** Whether this tick has spare capacity for a replay Ticket, as the rules core's spare-capacity gate weighs it, or why not. */
export type ReplayCapacity = { readonly spare: true } | { readonly spare: false; readonly why: string };

/** A Product repo's Kit config at a Ticket's baseSha, as resolveKitConfig read it there. */
export type BaseKitConfig = { readonly ok: true; readonly config: Pick<KitConfig, "roles"> } | { readonly ok: false; readonly errors: readonly string[] };

/** What accepting a waiting request weighs. */
export interface ReplayAcceptance {
  /** This Product repo's merged Tickets, as pickReplayTickets weighs them. */
  readonly candidates: readonly ReplayCandidate[];
  /** The Kit config at each baseSha that replayReads names, keyed by that sha. */
  readonly baseConfigs: Readonly<Record<string, BaseKitConfig>>;
  /** Whether each candidate Kit sha that replayReads names is a commit in the Fabrik repo, keyed by that sha. */
  readonly fabrikCommits: Readonly<Record<string, boolean>>;
}

/** What the tick's replay step weighs. */
export interface ReplayTick {
  /** The Operator's GitHub login. */
  readonly operator: string;
  /** The `fabrik:replay` issues, in any order. */
  readonly issues: readonly ReplayIssue[];
  readonly capacity: ReplayCapacity;
  /** What accepting a waiting request weighs, or null when the adapter read none. */
  readonly acceptance: ReplayAcceptance | null;
}

/** What the tick does next for the Replays. */
export type ReplayStep =
  | { readonly kind: "nothing"; readonly reason: string }
  /** Writes the request's plan into the issue's body, which becomes `body`. */
  | { readonly kind: "accept"; readonly issue: number; readonly body: string }
  /** Comments on the issue, once, saying why its request can't run. */
  | { readonly kind: "reject"; readonly issue: number; readonly comment: string }
  /** Starts the issue's next pending Ticket, both arms: the one nextReplayTicket names. */
  | { readonly kind: "start"; readonly issue: number; readonly ticket: number };

/**
 * The tick's next step for the Replays, weighing only the Operator's open
 * replay issues, oldest first. A waiting request comes first: one that
 * doesn't read, names a candidate Kit that isn't a Fabrik commit, or picks no
 * eligible Ticket is rejected with one comment, never twice for the same
 * problem, and read again on the next tick; a valid one is accepted, its plan
 * written into the body. With none to act on, the oldest accepted issue's
 * next pending Ticket starts, unless a replay Ticket is in progress on any of
 * them, or the tick has no spare capacity.
 */
export function nextReplayStep(tick: ReplayTick): ReplayStep {
  const issues = operatorsOpenIssues(tick);
  if (issues.length === 0) return { kind: "nothing", reason: "No open replay issue is the Operator's" };
  const accepted: { readonly issue: number; readonly marks: ReplayMarks }[] = [];
  for (const issue of issues) {
    const marks = replayMarksIn(issue.body);
    if (marks !== null) {
      accepted.push({ issue: issue.number, marks });
      continue;
    }
    const step = requestStep(issue, tick.acceptance);
    if (step !== null) return step;
  }
  for (const { issue, marks } of accepted) {
    const running = marks.progress.find(({ state }) => state === "in-progress");
    if (running !== undefined) {
      return { kind: "nothing", reason: `#${running.ticket} is in progress on replay #${issue}, and one replay Ticket runs at a time` };
    }
  }
  const next = accepted.flatMap(({ issue, marks }) => {
    const planned = nextReplayTicket(marks);
    return planned === null ? [] : [{ issue, ticket: planned.ticket }];
  })[0];
  if (next === undefined) return { kind: "nothing", reason: "No replay Ticket is waiting to run" };
  if (!tick.capacity.spare) return { kind: "nothing", reason: tick.capacity.why };
  return { kind: "start", ...next };
}

/** The Ticket a Replay runs next: the first in its plan still waiting to run, or null when none is. */
export function nextReplayTicket({ plan, progress }: ReplayMarks): PlannedTicket | null {
  const waiting = (ticket: number) => {
    const state = progress.find((each) => each.ticket === ticket)?.state;
    return state === "pending" || state === "retried";
  };
  return plan.tickets.find(({ ticket }) => waiting(ticket)) ?? null;
}

/**
 * What the adapter reads for the tick's replay step beyond the replay issues
 * themselves: only what accepting a waiting request weighs, and nothing at
 * all while no valid request waits.
 */
export interface ReplayReads {
  /** Whether a valid request waits to be accepted, so the acceptance facts are read, the candidates first. */
  readonly acceptance: boolean;
  /** Each candidate Kit sha a waiting request names, to check is a commit in the Fabrik repo. */
  readonly fabrikShas: readonly string[];
  /** Each baseSha whose Kit config a waiting request's pick weighs, from the candidates: none until they're read. */
  readonly baseShas: readonly string[];
}

/**
 * What the adapter reads for the tick's replay step, ReplayAcceptance's facts:
 * asked first with no candidates, to learn whether to read them, then again
 * with them, to learn whose Kit config to read.
 */
export function replayReads(tick: Pick<ReplayTick, "operator" | "issues">, candidates: readonly ReplayCandidate[] | null): ReplayReads {
  const requests = operatorsOpenIssues(tick).flatMap((issue) => {
    const read = replayMarksIn(issue.body) === null ? readReplayRequest(issue.body) : null;
    return read?.ok === true ? [read.request] : [];
  });
  const fabrikShas = requests.flatMap(({ variable }) => (variable.kind === "kit" ? [variable.sha] : []));
  const baseShas = candidates === null ? [] : requests.flatMap((request) => eligibleOf(request, candidates).map(({ picked }) => picked.baseSha));
  return { acceptance: requests.length > 0, fabrikShas: [...new Set(fabrikShas)], baseShas: [...new Set(baseShas)] };
}

/** The open replay issues the Operator filed, oldest first: no one else's count, nor a closed one. */
function operatorsOpenIssues({ operator, issues }: Pick<ReplayTick, "operator" | "issues">): ReplayIssue[] {
  return issues.filter((issue) => issue.open && issue.author === operator).toSorted((a, b) => a.number - b.number);
}

/**
 * What to do with a waiting request: reject it, accept it, or null when it
 * was rejected already for the same problem. Nothing, when the acceptance
 * facts lack one that replayReads names.
 */
function requestStep(issue: ReplayIssue, acceptance: ReplayAcceptance | null): ReplayStep | null {
  const read = readReplayRequest(issue.body);
  if (!read.ok) return rejection(issue, rejectedRequest(read.errors));
  const { request } = read;
  const missing = (fact: string): ReplayStep => ({ kind: "nothing", reason: `Replay #${issue.number}'s request waits on ${fact}, which the tick didn't read` });
  if (acceptance === null) return missing("its acceptance facts");
  if (request.variable.kind === "kit") {
    const { sha } = request.variable;
    const commit = acceptance.fabrikCommits[sha];
    if (commit === undefined) return missing(`whether ${shortSha(sha)} is a Fabrik commit`);
    if (!commit) return rejection(issue, rejectedRequest([`kit is ${sha}, which isn't a commit in the Fabrik repo`]));
  }
  const unread = eligibleOf(request, acceptance.candidates).find(({ picked }) => acceptance.baseConfigs[picked.baseSha] === undefined);
  if (unread !== undefined) return missing(`the Kit config at ${shortSha(unread.picked.baseSha)}`);
  const { plan, ruledOut } = planOf(request, acceptance);
  if (plan.tickets.length === 0) return rejection(issue, noEligibleTicket(plan, ruledOut));
  const progress = plan.tickets.map(({ ticket }): TicketProgress => ({ ticket, state: "pending" }));
  return { kind: "accept", issue: issue.number, body: replayBody(issue.body, { plan, progress }) };
}

/**
 * The comment rejecting a request whose plan has no Ticket: each listed
 * Ticket left out, or what the default pick looks for, with each eligible
 * Ticket it left out for what its arms would run.
 */
function noEligibleTicket({ leftOut }: ReplayPlan, ruledOut: readonly LeftOutTicket[]): string {
  const why =
    leftOut.length === 0
      ? [
          "This replay has no Ticket to run, so nothing runs: no merged Ticket here can be replayed. A Ticket can be once its PR merged, was never reverted and changed no Trust-root file, built from a first Implement run whose Run record has a baseSha.",
          ...(ruledOut.length === 0 ? [] : ["", "These were, but were left out:", "", ...ruledOut.map(leftOutLine)]),
        ]
      : ["This replay has no Ticket to run, so nothing runs: none of the Tickets it lists can be replayed.", "", ...leftOut.map(leftOutLine)];
  return [...why, "", EDIT_TO_FIX].join("\n");
}

/** A Ticket left out, as a list item. */
function leftOutLine({ ticket, reason }: LeftOutTicket): string {
  return `- #${ticket}: ${withoutMentions(reason)}`;
}

/** A reject step commenting `comment` on the issue, or null when the Kit has said that there already. */
function rejection(issue: ReplayIssue, comment: string): ReplayStep | null {
  const said = issue.comments.some((each) => each.replaceAll("\r\n", "\n").trim() === comment.trim());
  return said ? null : { kind: "reject", issue: issue.number, comment };
}

/** The comment rejecting a request for these errors. */
function rejectedRequest(errors: readonly string[]): string {
  const problems = errors.length === 1 ? "a problem" : "problems";
  return [`This replay can't run: its request has ${problems}.`, "", ...errors.map((error) => `- ${withoutMentions(error)}`), "", EDIT_TO_FIX].join("\n");
}

/** How a rejection comment ends. */
const EDIT_TO_FIX = "Edit the request in the issue body, and the Kit reads it again on its next hourly tick.";

/**
 * The request's plan, from the Tickets it picks and each one's Kit config at
 * its baseSha, which its baseline runs: a Ticket whose Kit config there no
 * longer resolves, or already runs the variable as the variant would, so that
 * its two arms would be the same, is left out with why.
 */
function planOf(request: ReplayRequest, acceptance: ReplayAcceptance): { readonly plan: ReplayPlan; readonly ruledOut: readonly LeftOutTicket[] } {
  const { variable } = request;
  const { picked, leftOut, ruledOut } = pickWith(request, acceptance.candidates, ({ baseSha }) => {
    const base = acceptance.baseConfigs[baseSha];
    // Never unread: requestStep weighs no request until every base it picks from is read.
    if (base === undefined) return null;
    if (!base.ok) return `its Kit config at ${shortSha(baseSha)} doesn't resolve under this Kit release: ${base.errors.join("; ")}`;
    const runs = alreadyRuns(base.config, variable);
    return runs === null ? null : `its Kit config at ${shortSha(baseSha)} already runs ${runs}, so its two arms would be the same`;
  });
  const tickets = picked.flatMap((ticket) => {
    const base = acceptance.baseConfigs[ticket.baseSha];
    return base?.ok === true ? [{ ...ticket, arms: replayArms(base.config, variable) }] : [];
  });
  return { plan: { variable, tickets, leftOut }, ruledOut };
}

/** What the base Kit config already runs as the variable's variant would, in words; null when the variant changes it. */
function alreadyRuns(base: Pick<KitConfig, "roles">, variable: ReplayVariable): string | null {
  switch (variable.kind) {
    case "model":
      return base.roles[variable.role].model === variable.model ? `${ROLE_WORDS[variable.role]} on ${variable.model}` : null;
    case "effort":
      return base.roles[variable.role].effort === variable.effort ? `${ROLE_WORDS[variable.role]} at effort ${variable.effort}` : null;
    case "kit":
      // The baseline loads the pinned release's prompts, never a candidate's.
      return null;
  }
}

// The Kit's part of a replay issue's body: below the Operator's request, from
// a hidden start line to the end of the body, the results for the Operator to
// read, then the hidden markers that hold them: the plan, written once when
// the request is accepted, the results last shown, and each Ticket's
// progress. The Kit only ever rewrites its own part, so the Operator's text
// above it stays theirs.

/** What a Replay runs: the variable, and each picked Ticket with its arms. */
export interface ReplayPlan {
  readonly variable: ReplayVariable;
  /** In the order they run. */
  readonly tickets: readonly PlannedTicket[];
  /** Each listed Ticket left out, with why. */
  readonly leftOut: readonly LeftOutTicket[];
}

/** A picked Ticket, with what each of its arms runs it with. */
export interface PlannedTicket extends PickedTicket {
  readonly arms: ReplayArms;
}

/**
 * Where a planned Ticket's replay stands: waiting to run, the first time or
 * again after one Infrastructure failure; in progress in a run, which retries
 * one when `retrying` names it; or finished, done or failed.
 */
export type ReplayProgress =
  | { readonly state: "pending" }
  | { readonly state: "retried"; readonly reason: string }
  | { readonly state: "in-progress"; readonly run: number; readonly retrying: string | null }
  | { readonly state: "done"; readonly run: number }
  | { readonly state: "failed"; readonly run: number; readonly reason: string };

/** A planned Ticket's progress. */
export type TicketProgress = { readonly ticket: number } & ReplayProgress;

/** What a replay issue's markers hold: its plan, and each planned Ticket's progress, in plan order. */
export interface ReplayMarks {
  readonly plan: ReplayPlan;
  readonly progress: readonly TicketProgress[];
}

/** How a Ticket's run ended, as its replay-record job saw it. */
export type ReplayTicketEnd =
  /** Both arms ran, whatever their gates and Verdicts. */
  | { readonly kind: "done" }
  /** It was refused on a Subscription's weekly limit, which costs the Replay time, never the Ticket. */
  | { readonly kind: "weekly-limit" }
  /** Any other Infrastructure failure, with why. */
  | { readonly kind: "infrastructure"; readonly reason: string };

/**
 * The body with Ticket `ticket` marked in progress in run `run`, or null
 * when it isn't in the body's plan waiting to run, as when another run
 * claimed it first.
 */
export function withTicketStarted(body: string, ticket: number, run: number): string | null {
  return withProgress(body, ticket, (progress): ReplayProgress | null => {
    if (progress.state === "pending") return { state: "in-progress", run, retrying: null };
    if (progress.state === "retried") return { state: "in-progress", run, retrying: progress.reason };
    return null;
  });
}

/**
 * The body with run `run` of Ticket `ticket` ended so: done; back to pending
 * after a weekly-limit refusal; after any other Infrastructure failure,
 * waiting to run again the first time and failed the second. Null when the
 * Ticket isn't in progress in that run.
 */
export function withTicketFinished(body: string, ticket: number, run: number, end: ReplayTicketEnd): string | null {
  return withProgress(body, ticket, (progress): ReplayProgress | null => {
    if (progress.state !== "in-progress" || progress.run !== run) return null;
    const { retrying } = progress;
    switch (end.kind) {
      case "done":
        return { state: "done", run };
      case "weekly-limit":
        return retrying === null ? { state: "pending" } : { state: "retried", reason: retrying };
      case "infrastructure":
        return retrying === null ? { state: "retried", reason: end.reason } : { state: "failed", run, reason: end.reason };
    }
  });
}

/** The body with Ticket `ticket`'s progress changed by `next`, or null when it has no plan holding that Ticket, or `next` changes nothing. */
function withProgress(body: string, ticket: number, next: (progress: ReplayProgress) => ReplayProgress | null): string | null {
  const marks = replayMarksIn(body);
  const at = marks?.progress.findIndex((each) => each.ticket === ticket) ?? -1;
  const changed = marks === null || at === -1 ? null : next(marks.progress[at]!);
  return marks === null || changed === null ? null : replayBody(body, { ...marks, progress: marks.progress.with(at, { ticket, ...changed }) });
}

/** The hidden line the Kit's part opens with. */
const KIT_PART_START = "<!-- fabrik:replay-start -->";

/** The plan's marker line, carrying it as JSON. */
const PLAN_MARKER = /^<!-- fabrik:replay-plan (\{.*\}) -->$/;

/** How a marker's JSON spells the characters that could end its HTML comment early or mention someone. */
const MARKER_ESCAPES: Readonly<Record<string, string>> = { "<": "\\u003c", ">": "\\u003e", "@": "\\u0040" };

/** A marker's value as one line of JSON that can neither end its HTML comment early nor mention anyone. */
function markerJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>@]/g, (c) => MARKER_ESCAPES[c] ?? c);
}

/**
 * What the markers in a replay issue's body hold, read only from the Kit's
 * part, or null when it holds no plan that reads: the Kit hasn't accepted the
 * request. A plan reads only as the Kit writes one, every value one a request
 * and Kit config could give, so an edited marker can't run anything a
 * request couldn't ask for. A Ticket whose progress marker doesn't read is
 * pending.
 */
export function replayMarksIn(body: string): ReplayMarks | null {
  const lines = body
    .slice(kitPartAt(body) ?? body.length)
    .split("\n")
    .map((line) => line.trim());
  const planJson = lines.map((line) => PLAN_MARKER.exec(line)?.[1]).find((json) => json !== undefined);
  const plan = planJson === undefined ? null : readPlan(parsed(planJson));
  if (plan === null) return null;
  const marked = lines.flatMap((line) => {
    const json = PROGRESS_MARKER.exec(line)?.[1];
    const progress = json === undefined ? null : readProgress(parsed(json));
    return progress === null ? [] : [progress];
  });
  // A Ticket with no progress marker of its own hasn't started.
  const progress = plan.tickets.map(({ ticket }): TicketProgress => marked.find((each) => each.ticket === ticket) ?? { ticket, state: "pending" });
  return { plan, progress };
}

/** A marker's JSON, or undefined when it doesn't parse. */
function parsed(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** The plan as its marker holds it: each Ticket's baseline only, since its variant is the baseline with the variable changed. */
function storedPlan({ variable, tickets, leftOut }: ReplayPlan): unknown {
  return {
    variable,
    tickets: tickets.map(({ ticket, pullRequest, baseSha, flags, arms }) => ({
      ticket,
      pullRequest,
      baseSha,
      flags,
      baseline: { implement: arms.baseline.implement, review: arms.baseline.review },
    })),
    leftOut,
  };
}

/** The plan a marker holds (storedPlan), or null when any of it is a value the Kit wouldn't write. */
function readPlan(value: unknown): ReplayPlan | null {
  if (!isObject(value) || !Array.isArray(value.tickets) || !Array.isArray(value.leftOut)) return null;
  const variable = readVariableValue(value.variable);
  if (variable === null) return null;
  const tickets = value.tickets.map((ticket) => readPlannedTicket(ticket, variable));
  const leftOut = value.leftOut.map((each) => (isObject(each) && isId(each.ticket) && typeof each.reason === "string" ? { ticket: each.ticket, reason: each.reason } : null));
  if (tickets.includes(null) || leftOut.includes(null)) return null;
  const planned = tickets.filter((ticket) => ticket !== null);
  if (new Set(planned.map(({ ticket }) => ticket)).size !== planned.length) return null;
  return { variable, tickets: planned, leftOut: leftOut.filter((each) => each !== null) };
}

/** A variable as a plan holds it, held to the same rules as the request's own, or null. */
function readVariableValue(value: unknown): ReplayVariable | null {
  if (!isObject(value)) return null;
  const { kind, role, model, effort, sha } = value;
  if (kind === "kit") return typeof sha === "string" && checkCandidateKit(sha) === null ? { kind, sha } : null;
  if (typeof role !== "string" || !isReplayRole(role)) return null;
  if (kind === "model") return typeof model === "string" && refuseModel(model) === null ? { kind, role, model } : null;
  if (kind === "effort") return typeof effort === "string" && checkEffort(effort) === null ? { kind, role, effort } : null;
  return null;
}

/** A planned Ticket as a plan holds it, its arms rebuilt from its baseline and the variable, or null. */
function readPlannedTicket(value: unknown, variable: ReplayVariable): PlannedTicket | null {
  if (!isObject(value) || !isId(value.ticket) || !isId(value.pullRequest) || !Array.isArray(value.flags) || !isObject(value.baseline)) return null;
  const { ticket, pullRequest, baseSha, flags } = value;
  if (typeof baseSha !== "string" || !FULL_SHA.test(baseSha)) return null;
  if (!flags.every((flag) => REPLAY_FLAGS.includes(flag)) || new Set(flags).size !== flags.length) return null;
  const implement = readRoleSettings(value.baseline.implement);
  const review = readRoleSettings(value.baseline.review);
  if (implement === null || review === null) return null;
  const baseline: ReplayArmSettings = { implement, review, candidateSha: null };
  return { ticket, pullRequest, baseSha, flags: REPLAY_FLAGS.filter((flag) => flags.includes(flag)), arms: { baseline, variant: varied(baseline, variable) } };
}

/** A role's model and effort as Kit config could give them, or null. */
function readRoleSettings(value: unknown): ReplayRoleSettings | null {
  if (!isObject(value)) return null;
  const { model, effort } = value;
  if (typeof model !== "string" || model.trim() === "" || refuseFable(model) !== null) return null;
  if (!(effort === null || (typeof effort === "string" && checkEffort(effort) === null))) return null;
  return { model, effort };
}

/** A Ticket's progress as its marker holds it, or null when it doesn't read. */
function readProgress(value: unknown): TicketProgress | null {
  if (!isObject(value) || !isId(value.ticket)) return null;
  const { ticket, state, run, reason, retrying } = value;
  if (state === "pending") return { ticket, state };
  if (state === "retried") return typeof reason === "string" ? { ticket, state, reason } : null;
  if (!isId(run)) return null;
  if (state === "in-progress") return retrying === null || typeof retrying === "string" ? { ticket, state, run, retrying } : null;
  if (state === "done") return { ticket, state, run };
  if (state === "failed") return typeof reason === "string" ? { ticket, state, run, reason } : null;
  return null;
}

/** Every flag, in the order a picked Ticket carries them. */
const REPLAY_FLAGS: readonly ReplayFlag[] = ["human-touches", "edited-input", "no-hidden-tests"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A Ticket, PR or run number: a whole number above zero. */
function isId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** A planned Ticket's progress marker line, carrying it as JSON. */
const PROGRESS_MARKER = /^<!-- fabrik:replay-ticket (\{.*\}) -->$/;

/** Where the Kit's part of the body starts: its start line, the last one. */
function kitPartAt(body: string): number | null {
  const starts = [...body.matchAll(/^<!-- fabrik:replay-start -->\r?$/gm)];
  return starts.at(-1)?.index ?? null;
}

/**
 * The body with its Kit's part written for `marks`, the Operator's part
 * above it as it was, and the results it last showed (withReplayResults)
 * still shown for each Ticket done.
 */
export function replayBody(body: string, marks: ReplayMarks): string {
  return withKitPart(body, marks, shownResultsIn(body), true);
}

// A Replay's results: each done Ticket's arms, as the store holds their runs,
// beside the original runs of the Ticket they replay.

/**
 * How an arm's gates ended: the Sandbox's setup, build and tests, from Kit
 * config at the Ticket's baseSha, run in turn on the arm's diff. Kit config
 * with no test command tests nothing, which is never a pass.
 */
export type ReplayGates = "passed" | "setup-failed" | "build-failed" | "tests-failed" | "no-test-command";

/**
 * How the merged PR's tests did, laid over an arm's diff: never a pass when
 * the PR has none, Kit config has no test command, or they never ran because
 * the arm's setup or build failed first, which counts as failing them.
 */
export type ReplayHiddenTests = "passed" | "failed" | "no-hidden-tests" | "no-test-command" | "not-run";

/** One arm's gates and hidden tests in one run, as its replay gates job passed them out. */
export interface ReplayArmGates {
  readonly ticket: number;
  readonly arm: ReplayArm;
  /** The workflow run the arm ran in. */
  readonly run: number;
  readonly gates: ReplayGates;
  readonly hiddenTests: ReplayHiddenTests;
}

/** An arm's gates as its gates job, or the store, holds them, or null for anything that doesn't read as one. */
export function readReplayArmGates(value: unknown): ReplayArmGates | null {
  if (!isObject(value)) return null;
  const { ticket, arm, run, gates, hiddenTests } = value;
  if (!isId(ticket) || !isId(run) || !(arm === "baseline" || arm === "variant")) return null;
  if (!isKeyOf(GATES_WORDS, gates) || !isKeyOf(HIDDEN_TESTS_WORDS, hiddenTests)) return null;
  return { ticket, arm, run, gates, hiddenTests };
}

/** What a Replay's results are read from: its arms' outcomes, and the original runs they replay. */
export interface ReplayOutcomes {
  /** Whether the replay issue is open: closing it cancels every Ticket not yet finished. */
  readonly open: boolean;
  /**
   * The store's Run records of the Product repo whose subject is one of the
   * plan's Tickets, of every role and Replay: each arm's Implement and Review
   * runs, and the original runs they're compared with.
   */
  readonly records: readonly RunRecord[];
  /** The store's score files of those runs. */
  readonly scoreFiles: readonly ScoreFile[];
  /** Each done Ticket's arms' gates. */
  readonly gates: readonly ReplayArmGates[];
}

/**
 * The body with its Kit's part rewritten to show the Replay's results from
 * `outcomes`, or null when it holds no plan: each arm of each Ticket in a row
 * of its own, a Ticket not done showing where it stands. Its Operator's part,
 * the request at the top, stays as it was.
 */
export function withReplayResults(body: string, outcomes: ReplayOutcomes): string | null {
  const marks = replayMarksIn(body);
  if (marks === null) return null;
  const results = marks.progress.flatMap((progress) => (progress.state === "done" ? [ticketResultOf(progress.ticket, progress.run, outcomes)] : []));
  return withKitPart(body, marks, results, outcomes.open);
}

/** Whether a replay issue's results are in: its request accepted, and every Ticket in its plan done or failed. */
export function replayResultsIn(body: string): boolean {
  const marks = replayMarksIn(body);
  return marks !== null && marks.progress.length > 0 && marks.progress.every(({ state }) => state === "done" || state === "failed");
}

/** What one arm of a done Ticket measured; null for what the store holds nothing of. */
interface ArmResult {
  readonly gates: ReplayGates | null;
  readonly hiddenTests: ReplayHiddenTests | null;
  /** Its Review's Verdict, `none` when the Review gave none. */
  readonly verdict: Verdict | "none" | null;
  /** Its Implement run's score under each Scorer, in SCORERS' order. */
  readonly scores: readonly (number | null)[];
  /** What its Implement and Review runs spent together. */
  readonly costUsd: number | null;
  readonly turns: number | null;
  readonly durationMs: number | null;
  /** Its patch's store path. */
  readonly patch: string | null;
}

/** What a Ticket's original run measured: its first Implement run and that run's Review, which the arms replay. */
type OriginalResult = Pick<ArmResult, "verdict" | "costUsd" | "turns" | "durationMs">;

/** What a done Ticket's arms measured, in the run they ran in, and what its original run did. */
interface TicketResult {
  readonly ticket: number;
  readonly run: number;
  readonly arms: Readonly<Record<ReplayArm, ArmResult>>;
  readonly original: OriginalResult;
}

/** What Ticket `ticket`'s arms measured in run `run`, from `outcomes`. */
function ticketResultOf(ticket: number, run: number, outcomes: ReplayOutcomes): TicketResult {
  const armResult = (arm: ReplayArm): ArmResult => {
    const ofArm = (each: Pick<RunRecord, "runId" | "role" | "replay">, role: ReplayRole) =>
      each.role === role && each.runId === run && each.replay?.ticket === ticket && each.replay.arm === arm;
    const implement = latest(outcomes.records.filter((record) => ofArm(record, "implement")));
    const review = latest(outcomes.records.filter((record) => ofArm(record, "review")));
    const scored = outcomes.scoreFiles.filter((file) => ofArm(file, "implement")).toSorted((a, b) => Date.parse(a.scoredAt) - Date.parse(b.scoredAt)).at(-1);
    const gates = outcomes.gates.find((each) => each.ticket === ticket && each.arm === arm && each.run === run);
    return {
      gates: gates?.gates ?? null,
      hiddenTests: gates?.hiddenTests ?? null,
      verdict: review === undefined ? null : (review.verdict ?? "none"),
      scores: SCORERS.map((scorer) => scored?.entries?.find((entry) => entry.scorer === scorer)?.score ?? null),
      ...spentBy([implement, review]),
      patch: implement?.replay == null ? null : replayPatchPath(implement.repo, implement.replay),
    };
  };
  return { ticket, run, arms: { baseline: armResult("baseline"), variant: armResult("variant") }, original: originalOf(ticket, outcomes.records) };
}

/**
 * What Ticket `ticket`'s original run did: its first Implement run, the one
 * the arms replay, and the first Review after it, never a Retry or a past
 * Replay's runs.
 */
function originalOf(ticket: number, records: readonly RunRecord[]): OriginalResult {
  const original = records.filter((record) => record.replay === null && record.issue === ticket);
  const first = firstRunOf(original.filter((record) => record.role === "implement"));
  const review =
    first === undefined
      ? undefined
      : original
          .filter((record) => record.role === "review" && Date.parse(record.endedAt) > Date.parse(first.endedAt))
          .toSorted((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt))[0];
  return { verdict: review === undefined ? null : (review.verdict ?? "none"), ...spentBy([first, review]) };
}

/** The last of a run's records, by attempt, then by when it ended. */
function latest(records: readonly RunRecord[]): RunRecord | undefined {
  return records.toSorted((a, b) => a.runAttempt - b.runAttempt || Date.parse(a.endedAt) - Date.parse(b.endedAt)).at(-1);
}

/** What runs spent together: their cost, turns and duration, each unknown when any run's is, or a run is missing. */
function spentBy(runs: readonly (RunRecord | undefined)[]): Pick<ArmResult, "costUsd" | "turns" | "durationMs"> {
  const sum = (figure: (record: RunRecord) => number | null) =>
    runs.reduce<number | null>((total, run) => {
      const value = run === undefined ? null : figure(run);
      return total === null || value === null ? null : total + value;
    }, 0);
  return { costUsd: sum((run) => run.totalCostUsd), turns: sum((run) => run.turns), durationMs: sum((run) => run.durationMs) };
}

/** The body with its Kit's part written for `marks`, showing `results` for its done Tickets, the Operator's part above it as it was. */
function withKitPart(body: string, marks: ReplayMarks, results: readonly TicketResult[], open: boolean): string {
  const at = kitPartAt(body);
  const operatorPart = body.slice(0, at ?? body.length);
  // A blank line sets the Kit's part apart, put in once, when it's first written.
  const separator = at !== null || operatorPart === "" ? "" : operatorPart.endsWith("\n") ? "\n" : "\n\n";
  const markers = [
    `<!-- fabrik:replay-plan ${markerJson(storedPlan(marks.plan))} -->`,
    ...(results.length === 0 ? [] : [`<!-- fabrik:replay-results ${markerJson(results)} -->`]),
    ...marks.progress.map((progress) => `<!-- fabrik:replay-ticket ${markerJson(progress)} -->`),
  ];
  return `${operatorPart}${separator}${[KIT_PART_START, ...resultsLines(marks, results, open), ...markers].join("\n")}\n`;
}

/**
 * The results the body last showed, from its results marker, so a rewrite
 * for a Ticket's progress keeps them until withReplayResults reads them from
 * the store again. A result that doesn't read as the Kit writes one is left
 * out, its Ticket showing no figure: the marker only ever shows a figure,
 * never runs anything.
 */
function shownResultsIn(body: string): TicketResult[] {
  const json = body
    .slice(kitPartAt(body) ?? body.length)
    .split("\n")
    .map((line) => RESULTS_MARKER.exec(line.trim())?.[1])
    .find((each) => each !== undefined);
  const stored = json === undefined ? undefined : parsed(json);
  return Array.isArray(stored) ? stored.flatMap((each) => readTicketResult(each) ?? []) : [];
}

/** The results marker line, carrying the results shown as JSON. */
const RESULTS_MARKER = /^<!-- fabrik:replay-results (\[.*\]) -->$/;

function readTicketResult(value: unknown): TicketResult | null {
  if (!isObject(value) || !isId(value.ticket) || !isId(value.run) || !isObject(value.arms)) return null;
  const baseline = readArmResult(value.arms.baseline);
  const variant = readArmResult(value.arms.variant);
  const original = readOriginalResult(value.original);
  if (baseline === null || variant === null || original === null) return null;
  return { ticket: value.ticket, run: value.run, arms: { baseline, variant }, original };
}

function readArmResult(value: unknown): ArmResult | null {
  const original = readOriginalResult(value);
  if (original === null || !isObject(value)) return null;
  const { gates, hiddenTests, scores, patch } = value;
  if (!(gates === null || isKeyOf(GATES_WORDS, gates)) || !(hiddenTests === null || isKeyOf(HIDDEN_TESTS_WORDS, hiddenTests))) return null;
  if (!Array.isArray(scores) || scores.length !== SCORERS.length || !scores.every((score) => score === null || isScore(score))) return null;
  if (!(patch === null || (typeof patch === "string" && PATCH_PATH.test(patch)))) return null;
  return { ...original, gates, hiddenTests, scores, patch };
}

function readOriginalResult(value: unknown): OriginalResult | null {
  if (!isObject(value)) return null;
  const { verdict, costUsd, turns, durationMs } = value;
  if (!(verdict === null || isKeyOf(VERDICT_WORDS, verdict))) return null;
  if (![costUsd, durationMs].every((figure) => figure === null || (typeof figure === "number" && Number.isFinite(figure) && figure >= 0))) return null;
  if (!(turns === null || (Number.isSafeInteger(turns) && (turns as number) >= 0))) return null;
  return { verdict, costUsd: costUsd as number | null, turns: turns as number | null, durationMs: durationMs as number | null };
}

function isKeyOf<K extends string>(words: Readonly<Record<K, string>>, value: unknown): value is K {
  return typeof value === "string" && Object.hasOwn(words, value);
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

/** An arm's patch's store path as replayPatchPath gives it, which a link can hold as it is. */
const PATCH_PATH = /^replays\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[1-9][0-9]*\/[1-9][0-9]*-(?:baseline|variant)\.patch$/;

/**
 * The Replay as the Operator reads it: a headline line of the variant's
 * totals against the baseline's, a row for each arm of each Ticket, in the
 * plan's order, the totals and the baseline's gap from the original runs,
 * then each Ticket left out. The totals and headline wait for a Ticket done.
 */
function resultsLines({ plan, progress }: ReplayMarks, results: readonly TicketResult[], open: boolean): string[] {
  const { variable } = plan;
  const rows = plan.tickets.map((planned) => {
    const state = progress.find(({ ticket }) => ticket === planned.ticket) ?? { state: "pending" };
    const result = state.state === "done" ? results.find(({ ticket, run }) => ticket === planned.ticket && run === state.run) : undefined;
    return { planned, state, result };
  });
  const done = rows.flatMap(({ result }) => (result === undefined ? [] : [result]));
  const totals = done.length === 0 ? null : totalsOf(done);
  const headline = totals === null ? [] : comparison(totals.variant, totals.baseline);
  return [
    "## Replay results",
    "",
    ...(headline.length === 0 ? [] : [`**variant: ${headline.join("; ")}**`, ""]),
    `Each Ticket runs twice from the commit its first Implement run started from: a baseline as it was built, and a variant with \`${variableLine(variable)}\`. Cost, turns and duration are its Implement and Review runs' together.`,
    "",
    ...tableHead(["Ticket", "Arm", "Gates", "Verdict", "Hidden tests", ...SCORERS.map(scorerWords), "Cost", "Turns", "Duration", "Patch", "Flags"]),
    ...rows.flatMap(({ planned, state, result }) => ARMS.map((arm) => armRow(planned, arm, variable, result?.arms[arm] ?? null, state, open))),
    ...(totals === null ? [] : ["", ...totalsLines(totals, done.length)]),
    ...(plan.leftOut.length === 0 ? [] : ["", "Left out:", "", ...plan.leftOut.map(leftOutLine)]),
    "",
  ];
}

/** How many of some arms' measures passed, of those measured. */
interface Tally {
  readonly passed: number;
  readonly of: number;
}

/** An arm's totals over the Tickets done, or the original runs': these have no gates, hidden tests or scores. */
interface Totals {
  readonly gates: Tally | null;
  readonly verdicts: Tally;
  readonly hiddenTests: Tally | null;
  /** The mean score under each Scorer, in SCORERS' order, over the runs it scored. */
  readonly scores: readonly (number | null)[] | null;
  /** What every run spent together, unknown when any run's is. */
  readonly costUsd: number | null;
  readonly turns: number | null;
  readonly durationMs: number | null;
}

/**
 * Each arm's totals over the Tickets done, and the original runs': a gate,
 * Verdict or hidden test counts only where it was measured, so no test
 * command, no hidden tests and a Review with no Verdict are never passes,
 * nor failures. Hidden tests never run because the setup or build failed
 * first count as failed.
 */
function totalsOf(done: readonly TicketResult[]): Readonly<Record<ReplayArm | "original", Totals>> {
  const verdicts = (each: readonly OriginalResult[]) => tally(each.map(({ verdict }) => verdict), ["pass"], ["none"]);
  const spent = (each: readonly OriginalResult[]) => ({
    costUsd: sumOf(each.map(({ costUsd }) => costUsd)),
    turns: sumOf(each.map(({ turns }) => turns)),
    durationMs: sumOf(each.map(({ durationMs }) => durationMs)),
  });
  const armTotals = (arm: ReplayArm): Totals => {
    const arms = done.map((result) => result.arms[arm]);
    return {
      gates: tally(arms.map(({ gates }) => gates), ["passed"], ["no-test-command"]),
      verdicts: verdicts(arms),
      hiddenTests: tally(arms.map(({ hiddenTests }) => hiddenTests), ["passed"], ["no-hidden-tests", "no-test-command"]),
      scores: SCORERS.map((_, i) => meanOf(arms.flatMap(({ scores }) => scores[i] ?? []))),
      ...spent(arms),
    };
  };
  const originals = done.map(({ original }) => original);
  return { baseline: armTotals("baseline"), variant: armTotals("variant"), original: { gates: null, verdicts: verdicts(originals), hiddenTests: null, scores: null, ...spent(originals) } };
}

/** How many of `values` are among `passes`, of those that were measured: neither null nor among `unmeasured`. */
function tally<T>(values: readonly (T | null)[], passes: readonly T[], unmeasured: readonly T[]): Tally {
  const measured = values.filter((value): value is T => value !== null && !unmeasured.includes(value));
  return { passed: measured.filter((value) => passes.includes(value)).length, of: measured.length };
}

/** The sum of figures, unknown when any is: never a guessed total. */
function sumOf(figures: readonly (number | null)[]): number | null {
  return figures.reduce<number | null>((total, figure) => (total === null || figure === null ? null : total + figure), 0);
}

function meanOf(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The Totals section: a row for each arm and the original runs, then the baseline's gap from the original. */
function totalsLines(totals: Readonly<Record<ReplayArm | "original", Totals>>, done: number): string[] {
  const row = (name: string, { gates, verdicts, hiddenTests, scores, costUsd, turns, durationMs }: Totals) =>
    tableRow([
      name,
      tallyWords(gates),
      tallyWords(verdicts),
      tallyWords(hiddenTests),
      ...SCORERS.map((_, i) => orNone(scores?.[i] ?? null, (score) => score.toFixed(2))),
      orNone(costUsd, dollars),
      orNone(turns, String),
      orNone(durationMs, minutes),
    ]);
  const gap = comparison(totals.baseline, totals.original);
  return [
    "### Totals",
    "",
    `Over the ${done === 1 ? "1 Ticket" : `${done} Tickets`} done, beside the original: each one's first Implement run and its Review.`,
    "",
    ...tableHead(["Arm", "Gates", "Pass Verdicts", "Hidden tests", ...SCORERS.map(scorerWords), "Cost", "Turns", "Duration"]),
    row("baseline", totals.baseline),
    row("variant", totals.variant),
    row("original", totals.original),
    "",
    `Baseline vs original: ${gap.length === 0 ? "the store holds nothing of the original runs to compare." : `${gap.join("; ")}.`}`,
  ];
}

function tallyWords(tally: Tally | null): string {
  return tally === null || tally.of === 0 ? NONE : `${tally.passed}/${tally.of}`;
}

/**
 * How `these` totals compare with `those`, measure by measure, from the
 * totals alone: each count both have measured something of, then each
 * figure's change where both are known.
 */
function comparison(these: Totals, those: Totals): string[] {
  const counts: [string, Tally | null, Tally | null][] = [
    ["gates", these.gates, those.gates],
    ["pass Verdicts", these.verdicts, those.verdicts],
    ["hidden tests", these.hiddenTests, those.hiddenTests],
  ];
  const figures: [string, number | null, number | null][] = [
    ["cost", these.costUsd, those.costUsd],
    ["turns", these.turns, those.turns],
    ["duration", these.durationMs, those.durationMs],
  ];
  return [
    ...counts.flatMap(([name, a, b]) => (a === null || b === null || (a.of === 0 && b.of === 0) ? [] : [`${name} ${a.passed}/${a.of} vs ${b.passed}/${b.of}`])),
    ...figures.flatMap(([name, a, b]) => (a === null || b === null || b === 0 ? [] : [`${name} ${percentChange(a, b)}`])),
  ];
}

/** The change from `from` to `to`, in whole percent, signed: `+12%`, `−38%` or `0%`. */
function percentChange(to: number, from: number): string {
  const change = Math.round(((to - from) / from) * 100);
  return change === 0 ? "0%" : change > 0 ? `+${change}%` : `−${-change}%`;
}

/** The two arms, in the order the results show them. */
const ARMS: readonly ReplayArm[] = ["baseline", "variant"];

/** One arm of a planned Ticket as a row: what it measured, or where its Ticket stands while it has no result. */
function armRow(planned: PlannedTicket, arm: ReplayArm, variable: ReplayVariable, result: ArmResult | null, progress: ReplayProgress, open: boolean): string {
  const ticket = `#${planned.ticket} (merged in #${planned.pullRequest})`;
  const flags = planned.flags.length === 0 ? NONE : planned.flags.map((flag) => FLAG_WORDS[flag]).join(", ");
  const settings = armWords(arm, planned.arms[arm], variable);
  if (result === null) {
    const state = open || progress.state === "done" || progress.state === "failed" ? progressWords(progress) : "cancelled";
    // A failure's reason is the one cell not of the Kit's own words, so a pipe in it can't split the row.
    return tableRow([ticket, settings, state.replaceAll("|", "\\|"), ...Array.from({ length: 6 + SCORERS.length }, () => NONE), flags]);
  }
  return tableRow([
    ticket,
    settings,
    result.gates === null ? NONE : GATES_WORDS[result.gates],
    result.verdict === null ? NONE : VERDICT_WORDS[result.verdict],
    result.hiddenTests === null ? NONE : HIDDEN_TESTS_WORDS[result.hiddenTests],
    ...result.scores.map((score) => orNone(score, (value) => value.toFixed(2))),
    orNone(result.costUsd, dollars),
    orNone(result.turns, String),
    orNone(result.durationMs, minutes),
    result.patch === null ? NONE : `[patch](${storeFileUrl(result.patch)})`,
    flags,
  ]);
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** A table's heading row, and the delimiter row under it, a cell for each heading. */
function tableHead(headings: readonly string[]): string[] {
  return [tableRow(headings), tableRow(headings.map(() => "---"))];
}

/** What a cell shows for a figure the store holds nothing of. */
const NONE = "–";

function orNone(value: number | null, format: (value: number) => string): string {
  return value === null ? NONE : format(value);
}

function dollars(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** A run's time in whole minutes. */
function minutes(ms: number): string {
  return ms < 60_000 ? "under 1 min" : `${Math.round(ms / 60_000)} min`;
}

/** A Scorer's name as a column heading: `ticket-compliance` as Ticket compliance. */
function scorerWords(scorer: string): string {
  const words = scorer.replaceAll("-", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** An arm, with how it runs what the variable changes: a candidate Kit's baseline is always the pinned release. */
function armWords(arm: ReplayArm, settings: ReplayArmSettings, variable: ReplayVariable): string {
  switch (variable.kind) {
    case "model":
      return `${arm}, ${settings[variable.role].model}`;
    case "effort": {
      const { effort } = settings[variable.role];
      return `${arm}, ${effort === null ? "default effort" : `effort ${effort}`}`;
    }
    case "kit":
      return settings.candidateSha === null ? arm : `${arm}, Kit ${shortSha(settings.candidateSha)}`;
  }
}

const GATES_WORDS: Readonly<Record<ReplayGates, string>> = {
  passed: "passed",
  "setup-failed": "setup failed",
  "build-failed": "build failed",
  "tests-failed": "tests failed",
  "no-test-command": "no test command",
};

const HIDDEN_TESTS_WORDS: Readonly<Record<ReplayHiddenTests, string>> = {
  passed: "passed",
  failed: "failed",
  "no-hidden-tests": "no hidden tests",
  "no-test-command": "no test command",
  "not-run": "not run",
};

const VERDICT_WORDS: Readonly<Record<Verdict | "none", string>> = {
  pass: "pass",
  "execution-flaw": "Execution flaw",
  "design-flaw": "Design flaw",
  none: "none",
};

/** How the results name each flag. */
const FLAG_WORDS: Readonly<Record<ReplayFlag, string>> = {
  "human-touches": "Human touches",
  "edited-input": "edited input",
  "no-hidden-tests": "no hidden tests",
};

/** A Ticket's progress, as its rows show it while it has no result. */
function progressWords(progress: ReplayProgress): string {
  switch (progress.state) {
    case "pending":
      return "pending";
    case "retried":
      return `pending, to run again after an Infrastructure failure: ${shownReason(progress.reason)}`;
    case "in-progress":
      return progress.retrying === null ? `in progress in run ${progress.run}` : `in progress in run ${progress.run}, its one retry`;
    case "done":
      return "done";
    case "failed":
      return `failed: ${shownReason(progress.reason)}`;
  }
}

/** A failure's reason on one line, mentioning nobody. */
function shownReason(reason: string): string {
  return withoutMentions(reason.replace(/\s+/g, " ").trim());
}

const ROLE_WORDS: Readonly<Record<ReplayRole, string>> = { implement: "Implement", review: "Review" };
