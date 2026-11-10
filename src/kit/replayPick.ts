// Which Tickets a Replay runs (#156), and how: the pick from the merged
// Tickets a request weighs, each picked Ticket's two arms, the baseline as
// it was built and the variant with the request's variable changed, how a
// plan or the Kit job's outputs hold the arms, and the hidden tests, the
// merged PR's own, that each arm is measured by. The Replay module
// (src/kit/replay.ts) holds the rest. Pure, no I/O.
import { isObject } from "../agent/stream.ts";
import { type ChangedPath, checkTrustRoot } from "../guard/trust-root.ts";
import { isTestPath } from "../loop/changedTests.ts";
import { spelled } from "../loop/readable.ts";
import { checkEffort, type KitConfig, refuseFable } from "./config.ts";
import { checkCandidateKit, type ReplayRequest, type ReplayVariable, settingOf } from "./replayRequest.ts";
import { firstRunOf, isLive, type ReplayArm, type ReplayRole, type RunRecord } from "./runRecord.ts";

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
  /** Whether its first Implement run was a Stepped-up start (ADR-0014), so its baseline runs on the Step-up model. */
  readonly steppedUp: boolean;
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
export function pickWith(
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
export function eligibleOf(request: Pick<ReplayRequest, "tickets">, candidates: readonly ReplayCandidate[]): Eligible[] {
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
  const originalRuns = candidate.records.filter((record) => isLive(record) && (record.role === "implement" || record.role === "review"));
  const implementRuns = originalRuns.filter((record) => record.role === "implement");
  if (implementRuns.length === 0) return "the store holds no Implement run of it";
  const first = firstRunOf(implementRuns);
  if (first?.baseSha == null) return "the store has no baseSha for its first Implement run";
  // Its baseSha is the Kept branch's head, and what the closed PR built on it isn't in the Ticket (#536).
  if (first.keptBranch) return "its first Implement run carried on a Kept branch, so its baseSha can't rebuild it";
  const flags: ReplayFlag[] = [];
  if (candidate.humanTouches > 0) flags.push("human-touches");
  if (editedSince(candidate.lastEdited, startOf(first))) flags.push("edited-input");
  if (hiddenTests(merged.files).length === 0) flags.push("no-hidden-tests");
  return {
    picked: { ticket: candidate.ticket, pullRequest: merged.number, baseSha: first.baseSha, flags, steppedUp: first.stepUp },
    cost: originalRuns.reduce((sum, record) => sum + (record.totalCostUsd ?? 0), 0),
    mergedAt: Date.parse(merged.mergedAt),
  };
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
 * its Kit config held at its `baseSha` (Implement on the Step-up's for a
 * Stepped-up start), and the variant, differing from the baseline only in
 * `variable`. Both arms load the pinned release's prompts
 * and Base skills unless the variable is a candidate Kit.
 */
export function replayArms(base: Pick<KitConfig, "roles">, variable: ReplayVariable, steppedUp = false): ReplayArms {
  const { implement, review, stepUp } = base.roles;
  const baseline: ReplayArmSettings = {
    // A marked Ticket was built on the Step-up model, so its baseline runs on it. No arm reads the label.
    implement: steppedUp ? { model: stepUp.model, effort: stepUp.effort } : { model: implement.model, effort: implement.effort },
    review: { model: review.model, effort: review.effort },
    candidateSha: null,
  };
  return { baseline, variant: varied(baseline, variable) };
}

/** `baseline` with `variable` changed. */
export function varied(baseline: ReplayArmSettings, variable: ReplayVariable): ReplayArmSettings {
  if (variable.kind === "kit") return { ...baseline, candidateSha: variable.sha };
  const { setting, value } = settingOf(variable);
  return { ...baseline, [variable.role]: { ...baseline[variable.role], [setting]: value } };
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

/** Every flag, in the order a picked Ticket carries them. */
export const REPLAY_FLAGS: readonly ReplayFlag[] = ["human-touches", "edited-input", "no-hidden-tests"];

/**
 * Each arm's settings as the Kit writes them, the Kit job's `replay-arms`
 * output among them (src/kit/jobs.ts), or null for anything else: each
 * role's model and effort as Kit config could give them, and a candidate Kit
 * sha a request could name, or none.
 */
export function readReplayArms(value: unknown): ReplayArms | null {
  if (!isObject(value)) return null;
  const baseline = readArmSettings(value["baseline"]);
  const variant = readArmSettings(value["variant"]);
  return baseline === null || variant === null ? null : { baseline, variant };
}

/** One arm's settings, as readReplayArms reads them, or null. */
export function readArmSettings(value: unknown): ReplayArmSettings | null {
  if (!isObject(value)) return null;
  const implement = readRoleSettings(value["implement"]);
  const review = readRoleSettings(value["review"]);
  const { candidateSha } = value;
  if (implement === null || review === null) return null;
  if (!(candidateSha === null || (typeof candidateSha === "string" && checkCandidateKit(candidateSha) === null))) return null;
  return { implement, review, candidateSha };
}

/** A role's model and effort as Kit config could give them, or null. */
function readRoleSettings(value: unknown): ReplayRoleSettings | null {
  if (!isObject(value)) return null;
  const { model, effort } = value;
  if (typeof model !== "string" || model.trim() === "" || refuseFable(model) !== null) return null;
  if (!(effort === null || (typeof effort === "string" && checkEffort(effort) === null))) return null;
  return { model, effort };
}
