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
// their places, since a closed one is no longer read (#470). A run with a trigger label gets
// it back on the App token, so a normal Loop run starts it on the freed
// Subscription, under Dispatch's max_in_flight cap and the Design session cap
// as usual: each held run kept its slot. A run whose issue or PR has closed,
// or moved on in the Loop, since it was held is dropped instead. An Auditor
// run is no longer held, and the tick can't start one, so a held marker one
// left before that (#268), on a still-pending Audit, fails the Audit. A
// resumed or dropped run's held line on its own issue or PR is edited to say
// so (src/loop/heldLine.ts, #471): the line is never read, so one the Operator
// deleted changes nothing. Every
// carrier then gets a resumed marker for each run dealt with, so
// that only a later held marker, if the resumed run is refused again, holds it
// again; the marker carries the run's place in the order, so that held again
// it keeps its first place even once the issue its first held marker was on
// has closed. Only when every carrier closes in one tick is no open
// issue left to carry it, and a run held again then takes a new place. The
// plan's own actions, a weekly-limit issue's close among them, come last
// (#438): a plan that fails partway leaves the issue open with its held
// markers, so the next tick deals with what's left rather than drop it. A
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
 * resume, even while another issue keeps that Subscription used up (#440). While every Subscription is used up, or with
 * rotation off, or with no run held, it is left as it is.
 */
export function resumingHeldRuns(plan: Plan, snapshot: Snapshot, config: KitConfig, closed: number | null = null): Plan {
  if (plan.kind === "fail" || !rotationIsOn(config)) return plan;
  const planned = plan.kind === "act" ? plan.actions : [];
  // A carrier closed by hand has left kitIssues, so the snapshot holds it apart (#440, #470).
  const closedCarrier = snapshot.closedKitIssue?.number === closed ? snapshot.closedKitIssue : null;
  const handClosed = closedCarrier?.labels.includes(WEEKLY_LIMIT_LABEL) === true ? closedCarrier : null;
  const limits = [...snapshot.kitIssues.filter((issue) => issue.number !== closed), ...(closedCarrier === null ? [] : [closedCarrier])]
    .filter(isCarrier)
    .sort((a, b) => a.number - b.number);
  const closing = new Set(planned.flatMap((action) => (action.kind === "close" ? [action.issue] : [])));
  const stillOpen = snapshot.kitIssues.filter((issue) => issue.number !== closed && !closing.has(issue.number));
  // The Operator closing a weekly-limit issue says its Subscription works again, whatever else is open (#440).
  if (handClosed === null && freeSubscriptions(stillOpen, config).length === 0) return strandedHeldAgain(plan, limits, stillOpen);
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
    // A hold takes the trigger label off, so one back on means the run was given it already. One the App
    // added since the run was held means so too, even once the run has started and taken it off, or has
    // closed its issue or PR since (#438).
    const backOn = on?.open === true && run.label !== null && on.labels.includes(run.label);
    if (on !== undefined && (backOn || givenBackSince(entry, on))) {
      // Its held line too, in case the edit was what failed: one already edited is left as it is.
      if (run.label !== null) resumes.push(heldLineEnded(entry, { kind: "resumed" }));
      dealtWith.push(entry);
      continue;
    }
    const reason = on === undefined ? `GitHub no longer has #${run.issue}` : movedOn(run, on);
    if (reason !== null || on === undefined) {
      resumes.push({ kind: "drop-held-run", role: run.role, issue: run.issue, reason: reason ?? "" });
      // An issue GitHub no longer has has no held line left to edit.
      if (on !== undefined && run.label !== null) resumes.push(heldLineEnded(entry, { kind: "dropped", reason: reason ?? "" }));
    } else if (run.label !== null) {
      // The line first: the label may start a run held again, whose own new line this edit must leave alone.
      resumes.push(heldLineEnded(entry, { kind: "resumed" }), { kind: "add-labels", issue: run.issue, labels: [run.label] });
    } else {
      // Only an Auditor run has no trigger label: a Retro run was never held, so movedOn dropped it.
      resumes.push(...failedHeldAudit(on));
    }
    dealtWith.push(entry);
  }
  // On every carrier still open, so that a run held again keeps its
  // place even once the issue its held markers were on has closed, and so that
  // one the plan fails to close resumes nothing again. One already closed is no
  // longer read.
  const why = limits.some((issue) => closing.has(issue.number) && issue.labels.includes(WEEKLY_LIMIT_LABEL))
    ? "A Subscription's weekly limit reset, so the Kit has dealt with the runs held here."
    : "A Subscription is free again, so the Kit has dealt with the runs held here.";
  const markers = limits.filter((issue) => issue.number !== closed).flatMap((issue): Action[] => {
    const here = dealtWith.map(({ run, markers: counts }) =>
      resumedMarker({ role: run.role, issue: run.issue, held: counts.get(issue.number) ?? 0, order: run.order ?? null }),
    );
    if (here.length === 0) return [];
    const body = [why, "", ...here].join("\n");
    return [{ kind: "comment", issue: issue.number, body }];
  });
  // The plan's own actions, a close among them, last (#438): closed, the issue's held markers are no longer read, so whatever hadn't landed would be dropped.
  const notes = plan.kind === "act" ? plan.notes : undefined;
  return { kind: "act", actions: [...resumes, ...markers, ...planned], ...(notes === undefined ? {} : { notes }) };
}

/** The edit saying a held run's hold ended, on the held line its newest held marker put on its issue or PR (#471). */
function heldLineEnded({ run, newest }: Waiting, ended: HoldEnded): Action {
  return { kind: "end-held-line", role: run.role, issue: newest.lineOn, on: newest.on, ended };
}

/**
 * While no Subscription is free, the Plan with the runs held only on a
 * carrier that has closed, or that the Plan closes, held again on one still
 * open, in their places: closed, its held markers are no longer read, so
 * nothing would ever resume them (#470).
 */
function strandedHeldAgain(plan: Plan, carriers: readonly KitIssueSnapshot[], stillOpen: readonly KitIssueSnapshot[]): Plan {
  const open = new Set(stillOpen.map((issue) => issue.number));
  const stillHeld = new Set(waitingHeldRuns(carriers.filter((issue) => open.has(issue.number))).map(({ run }) => `${run.role}:${run.issue}`));
  const stranded = waitingHeldRuns(carriers).flatMap(({ run }): HoldableRun[] =>
    run.label === null || stillHeld.has(`${run.role}:${run.issue}`) ? [] : [{ ...run, label: run.label }],
  );
  const again = heldAgain(stranded, stillOpen);
  if (again.length === 0) return plan;
  // Before the Plan's own actions, a close among them, as for a resume (#438).
  const planned = plan.kind === "act" ? plan.actions : [];
  const notes = plan.kind === "act" ? plan.notes : undefined;
  return { kind: "act", actions: [...again, ...planned], ...(notes === undefined ? {} : { notes }) };
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
 * research Decision.
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
  }
}
