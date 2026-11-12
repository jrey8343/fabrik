// The Standings of work the Kit handed back (src/kit/standing.ts): the
// Operator's at once, from the moment the Kit says so, read from the Kit's own
// notice on GitHub, with no clock and no Run record. A notice says which
// hand-back it is on its hidden last line (src/loop/markers.ts); one from an
// earlier release, with no such line, is recognised by a sentence or marker it
// has carried in every release (src/__fixtures__/handBackWordings.ts).
import { TRIGGER_LABELS } from "../loop/labels.ts";
import {
  CONFLICT_RUN_ENDED_MARKER,
  DESIGN_TURN_FAILED_MARKER,
  type HandBackMark,
  handBackMarkIn,
  refusedByMapCap,
  REQUEST_CHANGES_RUN_EMPTY_MARKER,
  requestChangesRunEndedIn,
  RESEARCH_RUN_FAILED_MARKER,
  RETRY_ENDED_MARKER,
  stuckTriggerGaveUpMarker,
} from "../loop/markers.ts";
import { TRIGGER_ROLES } from "../loop/triggerSweep.ts";
import type { AgentRole } from "../loop/types.ts";

/** How a failure notice has named each role's run, in every release: "The Implement run on #7 failed:". */
const FAILED_RUN = /(?:^|\s)The (Triage|Implement|Review|Audit|Retro|Research) run on #\d+ failed:/m;
const FAILED_TURN = /(?:^|\s)The (?:Design-session turn(?: run)?|prototype turn) on #\d+ failed:/m;

/** How a failed landing has named the run it was landing, in every release. */
const LANDING_RUNS: readonly (readonly [RegExp, AgentRole])[] = [
  [/couldn't land (?:the failure notice of )?the Implement run on #/, "implement"],
  [/couldn't land (?:the failure notice of )?the Research run on #/, "research"],
  [/couldn't land (?:the failure notice of )?the Triage run on #/, "triage"],
  [/couldn't land (?:the failure notice of )?the (?:Design session's turn|prototype turn) on #/, "design"],
  [/couldn't land (?:the failure notice of )?the Review(?: run)? (?:of|on) #|couldn't land the red required checks on #/, "review"],
];

const LANDING_FAILED = "**The Kit couldn't land ";

/**
 * Which hand-back the Fabrik App's notice is, or null for one that hands
 * nothing back: its hidden line, or, for a notice from an earlier release,
 * what it has always said. An old notice names no failure. Read only from the
 * Fabrik App's own comments, so a person quoting one changes nothing.
 */
export function handBackOfNotice(body: string): HandBackMark | null {
  const marked = handBackMarkIn(body);
  if (marked !== null) return marked;
  const lines = body.split("\n");
  if (body.includes(LANDING_FAILED)) {
    const role = LANDING_RUNS.find(([named]) => named.test(body))?.[1];
    return { kind: "landing-failed", ...(role === undefined ? {} : { role }) };
  }
  const swept = TRIGGER_LABELS.find((label) => lines.includes(stuckTriggerGaveUpMarker(label)));
  if (swept !== undefined) {
    const role = TRIGGER_ROLES[swept];
    return { kind: "trigger-swept", ...(role === null ? {} : { role }) };
  }
  if (body.startsWith(DESIGN_TURN_FAILED_MARKER)) return { kind: refusedByMapCap(body) ? "map-cap-refused" : "design-turn-failed", role: "design" };
  if (body.startsWith(RESEARCH_RUN_FAILED_MARKER)) return { kind: "research-failed", role: "research" };
  if (body.startsWith(CONFLICT_RUN_ENDED_MARKER)) return { kind: "conflict-run-unlanded", role: "implement" };
  if (requestChangesRunEndedIn(body) !== null) return { kind: "request-changes-unlanded", role: "implement" };
  // The note on a head that moved hands nothing back: Review runs on it.
  if (body.startsWith(REQUEST_CHANGES_RUN_EMPTY_MARKER) && body.includes("so your requested changes aren't built")) return { kind: "request-changes-empty", role: "implement" };
  if (body.startsWith(RETRY_ENDED_MARKER)) return { kind: "retry-never-started", role: "implement" };
  if (body.includes("This is a Broken run") && body.includes("so the Loop won't run it again")) return { kind: "broken-run-no-retry", role: "implement" };
  if (body.includes("This is an Infrastructure failure, so ")) return infrastructureFailureOf(body);
  if (body.includes("was closed unmerged by hand, so the Kit won't start another Implement run")) return { kind: "closed-by-hand", role: "implement" };
  if (/but its Kept branch `[^`]+` is gone, so the Kit started no Implement run/.test(body)) return { kind: "kept-branch-gone", role: "implement" };
  return null;
}

/**
 * An old failure notice, by the run it names: a Design-session turn's and a
 * Research run's are their own hand-backs, and an Audit's or Retro's hands
 * nothing back, as the scheduled tick opens the next.
 */
function infrastructureFailureOf(body: string): HandBackMark | null {
  if (FAILED_TURN.test(body)) return { kind: "design-turn-failed", role: "design" };
  const named = FAILED_RUN.exec(body)?.[1];
  switch (named) {
    case undefined:
      return { kind: "infrastructure-failure" };
    case "Audit":
    case "Retro":
      return null;
    case "Research":
      return { kind: "research-failed", role: "research" };
    default:
      return { kind: "infrastructure-failure", role: named.toLowerCase() as AgentRole };
  }
}
