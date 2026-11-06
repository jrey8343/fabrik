// Resuming held runs: with rotation on, when the scheduled tick closes a
// weekly-limit issue at its reset, which frees its Subscription, the same
// tick resumes every held run, in the order it was first held. A run with a
// trigger label gets it back on the App token, so a normal Loop run starts it
// on the freed Subscription, under Dispatch's max_in_flight cap and the
// Design session cap as usual. A held Auditor run, which has none, the tick
// starts itself on its pending Audit. A run whose issue or PR has closed, or
// moved on in the Loop, since it was held is dropped instead. A weekly-limit
// issue that stays open gets a resumed marker for each run dealt with, so
// that only a later held marker, if the resumed run is refused again, holds
// it again, in its first place. Pure, no I/O.
import { auditMarksIn } from "./markers.ts";
import { startAuditorRun } from "./audit.ts";
import { type HeldRun, heldRunsIn, RUN_NAMES, resumedMarker, resumedRunsIn } from "./heldRun.ts";
import { AUDIT_LABEL, isStateLabel, NEEDS_DESIGN, READY_FOR_AGENT, WEEKLY_LIMIT_LABEL } from "./labels.ts";
import { rotationIsOn } from "./subscriptions.ts";
import type { Action, HeldTargetSnapshot, KitConfig, KitIssueSnapshot, Plan, Snapshot } from "./types.ts";

/** A held run still waiting, and how many held markers for it each open weekly-limit issue carries. */
interface Waiting {
  readonly run: HeldRun;
  readonly markers: ReadonlyMap<number, number>;
}

/**
 * The scheduled tick's Plan, with every held run resumed or dropped when it
 * closes a weekly-limit issue. Before any reset, or with rotation off, it is
 * left as it is.
 */
export function resumingHeldRuns(tick: Plan, snapshot: Snapshot, config: KitConfig): Plan {
  if (tick.kind !== "act" || !rotationIsOn(config)) return tick;
  const limits = snapshot.kitIssues.filter((issue) => issue.labels.includes(WEEKLY_LIMIT_LABEL));
  const closing = new Set(
    tick.actions.flatMap((action) => (action.kind === "close" ? [action.issue] : [])).filter((number) =>
      limits.some((issue) => issue.number === number),
    ),
  );
  if (closing.size === 0) return tick;
  const waiting = waitingIn(limits);
  if (waiting.length === 0) return tick;
  if (snapshot.held === null) {
    return { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the issues and PRs held runs are on" };
  }
  const resumes: Action[] = [];
  const dealtWith: Waiting[] = [];
  let auditorStarted = false;
  for (const entry of waiting) {
    const { run } = entry;
    const on = snapshot.held.find((target) => target.number === run.issue);
    const reason = on === undefined ? `GitHub no longer has #${run.issue}` : movedOn(run, on);
    if (reason !== null || on === undefined) {
      resumes.push({ kind: "drop-held-run", role: run.role, issue: run.issue, reason: reason ?? "" });
    } else if (run.label !== null) {
      resumes.push({ kind: "add-labels", issue: run.issue, labels: [run.label] });
    } else {
      // A Loop run starts at most one agent run, so a second held Auditor run waits for the next reset.
      if (auditorStarted) continue;
      const start = startAuditorRun(on, config);
      if (start.kind === "act") resumes.push(...start.actions);
      else resumes.push({ kind: "drop-held-run", role: run.role, issue: run.issue, reason: start.reason });
      auditorStarted = true;
    }
    dealtWith.push(entry);
  }
  const markers = limits
    .filter((issue) => !closing.has(issue.number))
    .flatMap((issue): Action[] => {
      const here = dealtWith.flatMap(({ run, markers: counts }) => {
        const held = counts.get(issue.number);
        return held === undefined ? [] : [resumedMarker({ role: run.role, issue: run.issue, held })];
      });
      if (here.length === 0) return [];
      const body = ["A Subscription's weekly limit reset, so the Kit has dealt with the runs held here.", "", ...here].join("\n");
      return [{ kind: "comment", issue: issue.number, body }];
    });
  return { kind: "act", actions: [...tick.actions, ...resumes, ...markers] };
}

/**
 * The held runs still waiting on these weekly-limit issues, in the order each
 * was first held: an issue's held markers for a run past the count its last
 * resumed marker covers still hold it. Issues are read oldest first, each
 * body before its comments.
 */
function waitingIn(limits: readonly KitIssueSnapshot[]): Waiting[] {
  const first = new Map<string, HeldRun>();
  const counts = new Map<string, Map<number, { held: number; resumed: number }>>();
  for (const issue of limits) {
    for (const text of [issue.body, ...issue.comments]) {
      for (const run of heldRunsIn(text)) {
        const key = keyOf(run);
        if (!first.has(key)) first.set(key, run);
        const count = countOn(counts, key, issue.number);
        count.held += 1;
      }
      for (const run of resumedRunsIn(text)) {
        const count = countOn(counts, keyOf(run), issue.number);
        count.resumed = Math.max(count.resumed, run.held);
      }
    }
  }
  return [...first].flatMap(([key, run]) => {
    const onIssues = [...(counts.get(key) ?? new Map<number, { held: number; resumed: number }>())];
    if (!onIssues.some(([, count]) => count.held > count.resumed)) return [];
    return [{ run, markers: new Map(onIssues.map(([number, count]) => [number, count.held])) }];
  });
}

function keyOf({ role, issue }: Pick<HeldRun, "role" | "issue">): string {
  return `${role}:${issue}`;
}

function countOn(
  counts: Map<string, Map<number, { held: number; resumed: number }>>,
  key: string,
  issue: number,
): { held: number; resumed: number } {
  const byIssue = counts.get(key) ?? new Map<number, { held: number; resumed: number }>();
  counts.set(key, byIssue);
  const count = byIssue.get(issue) ?? { held: 0, resumed: 0 };
  byIssue.set(issue, count);
  return count;
}

/**
 * Why a held run's issue or PR is no longer in the state it was held in, or
 * null while it still is. A Triage run was held on an issue with no state
 * label (needs-triage came off), a Design-session turn on a needs-design one,
 * an Implement run on a ready-for-agent Ticket, a Review on a draft agent PR,
 * and an Auditor run on the App's pending Audit.
 */
function movedOn(run: HeldRun, on: HeldTargetSnapshot): string | null {
  const name = `The ${RUN_NAMES[run.role]} run's`;
  if (!on.open) return `${name} #${on.number} is closed`;
  switch (run.role) {
    case "triage": {
      const state = on.labels.find(isStateLabel);
      return state === undefined ? null : `${name} #${on.number} has moved on to ${state}`;
    }
    case "design":
      return on.labels.includes(NEEDS_DESIGN) ? null : `${name} #${on.number} is no longer in ${NEEDS_DESIGN}`;
    case "implement":
      return on.labels.includes(READY_FOR_AGENT) ? null : `${name} #${on.number} is no longer ${READY_FOR_AGENT}`;
    case "review":
      return on.draft === true ? null : `${name} #${on.number} is no longer a draft`;
    case "audit":
      return on.byApp && on.labels.includes(AUDIT_LABEL) && auditMarksIn(on.body).pending
        ? null
        : `${name} #${on.number} is no longer a pending Audit`;
  }
}
