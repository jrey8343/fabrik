// Resuming held runs: with rotation on, once a Subscription is free, the held
// runs resume, in the order each was first held (#439). The scheduled tick
// resumes them when it closes a weekly-limit issue at its reset, and on any
// tick that finds a Subscription free some other way, as when the Operator
// closed a usage-credits issue the Loop missed, or listed another
// Subscription. Closing a usage-credits, token-rotation or weekly-limit issue
// resumes them straight away, as does a Kit config change, so a Dispatch check
// never starts a newer Ticket ahead of them. A weekly-limit issue the Operator
// closes by hand, as one whose reset isn't known, which only they can close,
// resumes the runs held on it too, read from the issue itself, since it has
// left the open Kit-owned issues (#440). Held markers may be on any carrier, a
// usage-credits or token-rotation issue as well as a weekly-limit one, and a
// usage-credits or token-rotation issue the Operator closes is read the same
// way, though its runs resume only once a Subscription is free: until then,
// the runs held only on it are held again on a carrier still open, keeping
// their places, since only an open one takes held markers (#470). Should that
// event fail partway, or never run, the scheduled tick reads the carriers
// closed in the last 7 days too, and deals with the runs still waiting on them
// by the same rule, though a hand-closed weekly-limit issue's runs it reads
// resume only once a Subscription is free: that exception is the event's
// (#533). A closed carrier only ever counts toward what waits, never toward
// whether a Subscription is free or where a run is held. A run with a trigger label gets
// it back on the App token, so a normal Loop run starts it on the freed
// Subscription, under Dispatch's max_in_flight cap and the Design session cap
// as usual: each held run kept its slot. A run whose issue or PR has closed,
// or moved on in the Loop, since it was held is dropped instead. An Auditor
// run is no longer held, and the tick can't start one, so a held marker one
// left before that (#268), on a still-pending Audit, fails the Audit. A
// resumed or dropped run's held line on its own issue or PR is edited to say
// so (src/loop/heldLine.ts, #471): the line is never read, so one the Operator
// deleted changes nothing. Every
// carrier read, open or closed, then gets a resumed marker for each run dealt with, so
// that only a later held marker, if the resumed run is refused again, holds it
// again; the marker carries the run's place in the order, so that held again
// it keeps its first place even once the issue its first held marker was on
// has closed, and a closed carrier the tick reads has nothing left waiting
// on it. The plan's own actions, a weekly-limit issue's close among them,
// come last (#438): a plan that fails partway leaves the issue open with its
// held markers, so the next tick deals with what's left rather than drop it. A
// held run whose trigger label is back on its issue or PR, or that the App
// added after its newest held marker, since the resume landed but the plan
// failed before its resumed markers, isn't given it again nor dropped, even
// once the run has started and taken it off: the next tick only leaves its
// markers.
// Pure, no I/O.
import type { HoldEnded } from "./heldLine.ts";
import { auditMarksIn } from "./markers.ts";
import { type HeldRun, type HoldableRun, isCarrier, resumedMarker, runNamed, type Waiting, waitingHeldRuns } from "./heldRun.ts";
import { AUDIT_LABEL, isStateLabel, NEEDS_DESIGN, READY_FOR_AGENT, RESEARCH_DECISION_LABEL, WEEKLY_LIMIT_LABEL } from "./labels.ts";
import { freeSubscriptions, rotationIsOn } from "./subscriptions.ts";
import type { Action, HeldTargetSnapshot, KitConfig, KitIssueSnapshot, Plan, Snapshot } from "./types.ts";
import { failedHeldAudit } from "./weeklyRuns.ts";
import { heldAgain } from "./hold.ts";

/**
 * The Plan with every held run resumed or dropped while a Subscription is
 * free once it lands: the resumes, then the resumed markers, then the Plan's
 * own actions, a weekly-limit issue's close among them. `closed` names a
 * Kit-owned issue already closed, as the one an issue-closed event is about,
 * which the snapshot may still list. The snapshot's closedKitIssue holds it,
 * so the runs held on it are read too (#470). A weekly-limit one is the
 * Operator saying its Subscription works again, so the runs held on it
 * resume, even while another issue keeps that Subscription used up (#440).
 * The tick's closedCarriers, those closed in the last 7 days, are read too,
 * by the ordinary rule (#533). While every Subscription is used up, the runs
 * held only on a closed carrier are held again on an open one. With rotation
 * off, or with no run waiting, it is left as it is.
 */
export function resumingHeldRuns(plan: Plan, snapshot: Snapshot, config: KitConfig, closed: number | null = null): Plan {
  if (plan.kind === "fail" || !rotationIsOn(config)) return plan;
  const planned = plan.kind === "act" ? plan.actions : [];
  // A carrier closed by hand has left kitIssues, so the snapshot holds it apart (#440, #470).
  const closedCarrier = snapshot.closedKitIssue?.number === closed ? snapshot.closedKitIssue : null;
  const handClosed = closedCarrier?.labels.includes(WEEKLY_LIMIT_LABEL) === true ? closedCarrier : null;
  const open = snapshot.kitIssues.filter((issue) => issue.number !== closed);
  // The tick reads the Carriers closed in the last 7 days too, should the event have failed to deal with their runs (#533).
  const byNumber = new Map<number, KitIssueSnapshot>();
  for (const issue of [...open, ...(closedCarrier === null ? [] : [closedCarrier]), ...(snapshot.closedCarriers ?? [])]) {
    if (!byNumber.has(issue.number)) byNumber.set(issue.number, issue);
  }
  const limits = [...byNumber.values()].filter(isCarrier).sort((a, b) => a.number - b.number);
  const closing = new Set(planned.flatMap((action) => (action.kind === "close" ? [action.issue] : [])));
  const stillOpen = snapshot.kitIssues.filter((issue) => issue.number !== closed && !closing.has(issue.number));
  // The Operator closing a weekly-limit issue says its Subscription works again, whatever else is open (#440).
  if (handClosed === null && freeSubscriptions(stillOpen, config).length === 0) return strandedHeldAgain(plan, limits, stillOpen, snapshot.held, config.timeZone);
  const waiting = waitingHeldRuns(limits);
  if (waiting.length === 0) return plan;
  if (snapshot.held === null) {
    return { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the issues and PRs held runs are on" };
  }
  const resumes: Action[] = [];
  const dealtWith: Waiting[] = [];
  for (const entry of waiting) {
    const { run } = entry;
    const on = snapshot.held.find((target) => target.number === run.issue);
    if (on !== undefined && givenBack(entry, on)) {
      // Its held line too, in case the edit was what failed: one already edited is left as it is.
      if (run.label !== null) resumes.push(heldLineEnded(entry, { kind: "resumed" }, config.timeZone));
      dealtWith.push(entry);
      continue;
    }
    const reason = on === undefined ? `GitHub no longer has #${run.issue}` : movedOn(run, on);
    if (reason !== null || on === undefined) {
      resumes.push({ kind: "drop-held-run", role: run.role, issue: run.issue, reason: reason ?? "" });
      // An issue GitHub no longer has has no held line left to edit.
      if (on !== undefined && run.label !== null) resumes.push(heldLineEnded(entry, { kind: "dropped", reason: reason ?? "" }, config.timeZone));
    } else if (run.label !== null) {
      // The line first: the label may start a run held again, whose own new line this edit must leave alone.
      resumes.push(heldLineEnded(entry, { kind: "resumed" }, config.timeZone), { kind: "add-labels", issue: run.issue, labels: [run.label] });
    } else {
      // Only an Auditor run has no trigger label: a Retro run was never held, so movedOn dropped it.
      resumes.push(...failedHeldAudit(on));
    }
    dealtWith.push(entry);
  }
  // On every carrier read, open or closed, so that a run held again keeps its
  // place even once the issue its held markers were on has closed, so that one
  // the plan fails to close resumes nothing again, and so that the tick,
  // reading a closed one, finds nothing left waiting on it (#533).
  const why = limits.some((issue) => closing.has(issue.number) && issue.labels.includes(WEEKLY_LIMIT_LABEL))
    ? "A Subscription's weekly limit reset, so the Kit has dealt with the runs held here."
    : "A Subscription is free again, so the Kit has dealt with the runs held here.";
  const markers = limits.flatMap((issue): Action[] => {
    const here = dealtWith.map(({ run, markers: counts }) =>
      resumedMarker({ role: run.role, issue: run.issue, held: counts.get(issue.number) ?? 0, order: run.order ?? null }),
    );
    if (here.length === 0) return [];
    const body = [why, "", ...here].join("\n");
    return [{ kind: "comment", issue: issue.number, body }];
  });
  // The plan's own actions, a close among them, last (#438): open, the issue's held markers are read on every tick, not only for 7 days.
  const notes = plan.kind === "act" ? plan.notes : undefined;
  return { kind: "act", actions: [...resumes, ...markers, ...planned], ...(notes === undefined ? {} : { notes }) };
}

/** The edit saying a held run's hold ended, on the held line its newest held marker put on its issue or PR (#471). */
function heldLineEnded({ run, newest }: Waiting, ended: HoldEnded, timeZone: string | null): Action {
  return { kind: "end-held-line", role: run.role, issue: newest.lineOn, on: newest.on, ended, timeZone };
}

/**
 * While no Subscription is free, the Plan with the runs held only on a
 * carrier that has closed, or that the Plan closes, held again on one still
 * open, in their places: the tick reads a closed one only for 7 days, so past
 * that nothing would resume them (#470, #533).
 */
function strandedHeldAgain(
  plan: Plan,
  carriers: readonly KitIssueSnapshot[],
  stillOpen: readonly KitIssueSnapshot[],
  held: readonly HeldTargetSnapshot[] | null,
  timeZone: string | null,
): Plan {
  const open = new Set(stillOpen.map((issue) => issue.number));
  const stillHeld = new Set(waitingHeldRuns(carriers.filter((issue) => open.has(issue.number))).map(({ run }) => `${run.role}:${run.issue}`));
  // One the event already gave back, as a hand-closed weekly-limit issue's (#440), before failing, isn't held again (#533).
  const wasGivenBack = (entry: Waiting) => {
    const on = held?.find((target) => target.number === entry.run.issue);
    return on !== undefined && givenBack(entry, on);
  };
  const stranded = waitingHeldRuns(carriers).flatMap((entry): HoldableRun[] => {
    const { run } = entry;
    return run.label === null || stillHeld.has(`${run.role}:${run.issue}`) || wasGivenBack(entry) ? [] : [{ ...run, label: run.label }];
  });
  const again = heldAgain(stranded, stillOpen, timeZone);
  if (again.length === 0) return plan;
  // Before the Plan's own actions, a close among them, as for a resume (#438).
  const planned = plan.kind === "act" ? plan.actions : [];
  const notes = plan.kind === "act" ? plan.notes : undefined;
  return { kind: "act", actions: [...again, ...planned], ...(notes === undefined ? {} : { notes }) };
}

/**
 * Whether a held run was given its trigger label back already. A hold takes
 * it off, so one back on means so. One the App added since the run was held
 * means so too, even once the run has started and taken it off, or has
 * closed its issue or PR since (#438).
 */
function givenBack(entry: Waiting, on: HeldTargetSnapshot): boolean {
  const { run } = entry;
  const backOn = on.open && run.label !== null && on.labels.includes(run.label);
  return backOn || givenBackSince(entry, on);
}

/**
 * Whether the App added the held run's trigger label to its issue or PR after
 * its newest held marker was posted: the tick resumed it, and a plan that
 * failed before its resumed markers left it waiting (#438). Unknown times say
 * no, so a run is never dropped for want of them.
 */
function givenBackSince({ run, heldAt }: Waiting, on: HeldTargetSnapshot): boolean {
  const labeledAt = run.label === null ? undefined : on.labeledAt?.[run.label];
  return heldAt !== null && labeledAt !== undefined && Date.parse(labeledAt) > Date.parse(heldAt);
}

/**
 * Why a held run's issue or PR is no longer in the state it was held in, or
 * null while it still is. A Triage run was held on an issue with no state
 * label (needs-triage came off), a Design-session turn on a needs-design one,
 * an Implement run on a ready-for-agent Ticket, a Review on a draft agent PR,
 * an Auditor run on the App's pending Audit, and a Researcher run on a
 * research Decision. A Retro run and a Digest run are never held, so a held
 * marker naming one is always dropped.
 */
function movedOn(run: HeldRun, on: HeldTargetSnapshot): string | null {
  const name = `The ${runNamed(run.role)}'s`;
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
    case "retro":
      // A Retro run fails rather than wait for a reset, since the tick can't start one (src/loop/failures.ts).
      return `The Kit never holds a Retro run, so it starts none on #${on.number}`;
    case "research":
      // Its Map isn't read here: agent:research, given back, starts nothing under a closed one (src/loop/research.ts).
      return on.labels.includes(RESEARCH_DECISION_LABEL) ? null : `${name} #${on.number} is no longer a research Decision`;
    case "digest":
      // A Digest run opens the Merge gate with the no-Digest line rather than wait for a Subscription (src/loop/digest.ts).
      return `The Kit never holds a Digest run, so it starts none on #${on.number}`;
  }
}
