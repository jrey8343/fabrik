// The Kit job's closing line (#616): one line of JSON saying what the Kit job
// routed, held and declined included, which the job's last step takes for its
// name, so a reader of Actions knows a run's role, Ticket, pull request, kind,
// Retry number and model the moment the Kit decides, with no credential and
// nothing written (ADR-0002). It carries what the Decisions name and no more,
// and no text a person or an agent wrote: no reason, no prototype brief, none
// of a Replay's model names. Pure, with no runtime import but the Loop's
// types, so the read library can read it anywhere.
import type { RunKind } from "../github/snapshot.ts";
import { AGENT_ROLES, type Action, type AgentRole, type Plan } from "../loop/types.ts";

/** This line's version. A reader takes a line at no other. */
export const KIT_SAID_VERSION = 1;

/** Where the Kit job routes: the agent run's role, a replay's two arms, the push job alone, or nothing. */
export type KitRoute = AgentRole | "replay" | "push" | "none";

const ROUTES: readonly KitRoute[] = [...AGENT_ROLES, "replay", "push", "none"];
const RUN_KINDS: readonly RunKind[] = ["first", "retry", "request-changes", "conflict-only", "prototype"];

/** What the Kit job routed, as its closing step's name says it. */
export interface KitSaid {
  readonly fabrik: typeof KIT_SAID_VERSION;
  /** The Kit job's own route output. Declined is "none", with no run and nothing held. */
  readonly route: KitRoute;
  /** The agent run the plan starts, or null. */
  readonly run: {
    readonly role: AgentRole;
    /** The Ticket of an Implement, Review or Digest run, else the issue the run is on. */
    readonly issue: number | null;
    /** Its agent pull request; null for a first Implement run, a Kept-branch start included. */
    readonly pullRequest: number | null;
    readonly kind: RunKind | null;
    /** 0 unless a Retry. */
    readonly retry: number;
    /** The Kit config's model for the run. */
    readonly model: string;
  } | null;
  /** Each run the plan holds in place of starting: its role and the issue or pull request it is on. */
  readonly held: readonly { readonly role: AgentRole; readonly issue: number }[];
  /** A replay Ticket's two Arms: the replay issue and the Ticket it replays. */
  readonly replay: { readonly issue: number; readonly ticket: number } | null;
}

/** A job's step as Actions lists it. */
export interface ActionsStep {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

type StartAgentRun = Extract<Action, { kind: "start-agent-run" }>;
type StartReplay = Extract<Action, { kind: "start-replay" }>;
type HoldAgentRun = Extract<Action, { kind: "hold-agent-run" }>;

function actionsOf(plan: Plan | null): readonly Action[] {
  return plan?.kind === "act" ? plan.actions : [];
}

/**
 * Where the Kit job routes `plan` (null for an event the Loop doesn't act on):
 * the agent run's role, "replay", "push" for a plan that acts with no agent
 * run (a hold-only plan included), and "none" for one that does nothing.
 */
export function routeOf(plan: Plan | null): KitRoute {
  if (plan === null || plan.kind === "nothing") return "none";
  const actions = actionsOf(plan);
  const run = actions.find((action): action is StartAgentRun => action.kind === "start-agent-run");
  if (run !== undefined) return run.role;
  if (actions.some((action) => action.kind === "start-replay")) return "replay";
  return "push";
}

function kindOf(run: StartAgentRun): RunKind | null {
  if (run.requestChanges !== undefined) return "request-changes";
  if (run.conflict !== undefined) return "conflict-only";
  if ((run.retry ?? 0) > 0) return "retry";
  if (run.role === "implement") return "first";
  if (run.prototype !== undefined) return "prototype";
  return null;
}

/**
 * The line for `plan` (null for an event the Loop doesn't act on); `ticket` is
 * the Ticket the snapshot's pull request was cut for, which a Review is of,
 * and a Digest run too.
 */
export function kitSaidOf(plan: Plan | null, ticket: number | null): KitSaid {
  const actions = actionsOf(plan);
  const run = actions.find((action): action is StartAgentRun => action.kind === "start-agent-run");
  const replay = actions.find((action): action is StartReplay => action.kind === "start-replay");
  const held = actions.filter((action): action is HoldAgentRun => action.kind === "hold-agent-run");
  // A Review's subject is the pull request itself, whose Ticket the snapshot names; a Digest run reads the same way.
  const onPullRequest = run?.role === "review" || run?.role === "digest";
  return {
    fabrik: KIT_SAID_VERSION,
    route: routeOf(plan),
    run:
      run === undefined
        ? null
        : {
            role: run.role,
            issue: onPullRequest ? ticket : run.issue,
            pullRequest: onPullRequest ? run.issue : run.role === "implement" ? (run.pullRequest ?? null) : null,
            kind: kindOf(run),
            retry: run.retry ?? 0,
            model: run.model,
          },
    held: held.map(({ role, issue }) => ({ role, issue })),
    // Never the Ticket's Arms, whose model names come from the replay issue's body.
    replay: replay === undefined ? null : { issue: replay.issue, ticket: replay.ticket.ticket },
  };
}

/**
 * What a Kit job routed, read from its steps as Actions lists them: the line
 * its closing step is named, or null. It takes the line only from a step that
 * completed with success and whose name parses as a line at this version. A
 * step not yet completed is named with the workflow file's unevaluated text, a
 * skipped one's name is never worked out, a job from a release before the
 * closing step has none, and a line at a version this release doesn't know is
 * never guessed at: each gives null. Fields a later release adds are left out.
 */
export function kitSaidIn(steps: readonly ActionsStep[]): KitSaid | null {
  for (const step of steps) {
    if (step.status !== "completed" || step.conclusion !== "success") continue;
    const said = kitSaidFrom(step.name);
    if (said !== null) return said;
  }
  return null;
}

function kitSaidFrom(name: string): KitSaid | null {
  if (!name.startsWith("{")) return null;
  let line: unknown;
  try {
    line = JSON.parse(name);
  } catch {
    return null;
  }
  if (!isRecord(line) || line["fabrik"] !== KIT_SAID_VERSION) return null;
  const { route, run, held, replay } = line;
  if (!ROUTES.includes(route as KitRoute) || !Array.isArray(held)) return null;
  const readRun = run === null ? null : runFrom(run);
  const readHeld = held.map(heldFrom);
  const readReplay = replay === null ? null : replayFrom(replay);
  if (readRun === undefined || readReplay === undefined || readHeld.includes(undefined)) return null;
  return {
    fabrik: KIT_SAID_VERSION,
    route: route as KitRoute,
    run: readRun,
    held: readHeld.filter((entry) => entry !== undefined),
    replay: readReplay,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRole(value: unknown): value is AgentRole {
  return AGENT_ROLES.includes(value as AgentRole);
}

/** The run a line names, or undefined when it isn't one. */
function runFrom(value: unknown): KitSaid["run"] | undefined {
  if (!isRecord(value)) return undefined;
  const { role, issue, pullRequest, kind, retry, model } = value;
  if (!isRole(role) || !isNumber(retry) || typeof model !== "string") return undefined;
  if ((issue !== null && !isNumber(issue)) || (pullRequest !== null && !isNumber(pullRequest))) return undefined;
  if (kind !== null && !RUN_KINDS.includes(kind as RunKind)) return undefined;
  return { role, issue, pullRequest, kind: kind as RunKind | null, retry, model };
}

/** A held run a line names, or undefined when it isn't one. */
function heldFrom(value: unknown): KitSaid["held"][number] | undefined {
  if (!isRecord(value) || !isRole(value["role"]) || !isNumber(value["issue"])) return undefined;
  return { role: value["role"], issue: value["issue"] };
}

/** The replay a line names, or undefined when it isn't one. */
function replayFrom(value: unknown): KitSaid["replay"] | undefined {
  if (!isRecord(value) || !isNumber(value["issue"]) || !isNumber(value["ticket"])) return undefined;
  return { issue: value["issue"], ticket: value["ticket"] };
}
