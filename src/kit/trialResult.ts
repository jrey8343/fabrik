// A Staging trial's result (#856, ADR-0038): what the Operator's own labels
// on a merged pull request say of it, and whether a problem they found has
// been fixed and its fix accepted. The one rule for it: the Standing at
// Staging (./standingStaging.ts) names a merged pull request by it, and
// anything else that says a pull request's result says it by calling this,
// for the same facts. Nothing in the Loop reads it. Pure, no I/O.
import { TRIAL_ACCEPTED_LABEL, TRIAL_LABELS, type TrialLabel } from "../loop/labels.ts";
import type { LabelEvent } from "./weeklySummary.ts";

/** What the rule reads of one merged pull request, agent or Plain. */
export interface TrialPullRequestFacts {
  readonly pullRequest: number;
  /** Its label events, in the order GitHub's timeline has them. */
  readonly labelEvents: readonly LabelEvent[];
  /** The issues of its repo GitHub records it as closing. */
  readonly closes: readonly number[];
}

/** A Trial problem: an issue whose body carries the line naming the merged pull request it was found on (trialProblemLine). */
export interface TrialProblemFacts {
  readonly issue: number;
  /** The pull request its line names. */
  readonly pullRequest: number;
  readonly title: string;
  readonly open: boolean;
  /** How it was closed, as GitHub names the reason; null while it is open, or closed with no reason given. */
  readonly closedAs: "completed" | "not_planned" | "duplicate" | null;
}

/** What the rule reads of one Product repo: its merged pull requests, as far back as its reader gathered them, and the Trial problems that name or are closed by one. */
export interface TrialFacts {
  readonly pullRequests: readonly TrialPullRequestFacts[];
  readonly problems: readonly TrialProblemFacts[];
}

/** One of a pull request's Trial problems, as a result names it. */
export interface TrialProblemNamed {
  readonly issue: number;
  readonly open: boolean;
}

/**
 * A Staging trial's result, once the Operator has given one. `at` is when it
 * came to be so, ISO 8601: their labelling, or the acceptance of its fix.
 * `problems` are its Trial problems, lowest first; none is a problem with no
 * issue named. `fix`, on an accepted one, is the merged pull requests that
 * closed its Trial problems where it was accepted through them, lowest
 * first, and null where the Operator's own label accepted it.
 */
export type TrialResultGiven =
  | { readonly is: "accepted"; readonly at: string; readonly problems: readonly TrialProblemNamed[]; readonly fix: readonly number[] | null }
  | { readonly is: "problem"; readonly at: string; readonly problems: readonly TrialProblemNamed[] };

/** A merged pull request's Staging trial result: untried until the Operator gives one. */
export type TrialResult = { readonly is: "untried" } | TrialResultGiven;

const UNTRIED = { is: "untried" } as const;

/**
 * Merged pull request `pullRequest`'s Staging trial result, by `operator`'s
 * own labels. Only a label event on one of the two trial labels whose actor
 * is the Operator is read: anyone else's is ignored, the Fabrik App's
 * included. The result is the label of their latest labelling of either, and
 * untried if they have removed that label since, whatever the other label
 * says. Nothing checks when a label was put on, or that a Trial problem
 * exists.
 *
 * A problem reads as accepted once it is fixed: the pull request has a Trial
 * problem, every one of them is closed as completed, each has at least one
 * merged pull request GitHub records as closing it, and each of those is
 * accepted by this same rule, since the last of them was. Any other ending
 * of a Trial problem leaves it a problem until the Operator labels it
 * accepted: one closed as not planned or as a duplicate, one closed with no
 * pull request, and one whose fix the facts hold nothing of. A pull request
 * the facts hold nothing of is untried.
 */
export function trialResultOf(pullRequest: number, facts: TrialFacts, operator: string): TrialResult {
  return resultOf(pullRequest, facts, operator, new Set());
}

/** Whether merged pull request `pullRequest` closes a Trial problem, whichever pull request that was found on: one that does always needs a Staging trial. */
export function closesATrialProblem(pullRequest: number, { pullRequests, problems }: TrialFacts): boolean {
  const closes = pullRequests.find((held) => held.pullRequest === pullRequest)?.closes ?? [];
  return problems.some(({ issue }) => closes.includes(issue));
}

/** The result of `pullRequest`, reached through the fixes of `through`: a pull request met again on the way is no accepted fix, so links that go round end. */
function resultOf(pullRequest: number, facts: TrialFacts, operator: string, through: ReadonlySet<number>): TrialResult {
  const labelled = labelledOf(facts.pullRequests.find((held) => held.pullRequest === pullRequest)?.labelEvents ?? [], operator);
  if (labelled === null) return UNTRIED;
  const found = facts.problems.filter((problem) => problem.pullRequest === pullRequest).toSorted((a, b) => a.issue - b.issue);
  const problems = found.map(({ issue, open }) => ({ issue, open }));
  if (labelled.label === TRIAL_ACCEPTED_LABEL) return { is: "accepted", at: labelled.at, problems, fix: null };
  const stillAProblem = { is: "problem", at: labelled.at, problems } as const;
  if (found.length === 0) return stillAProblem;
  const onTheWay = new Set([...through, pullRequest]);
  const fix = new Set<number>();
  let at = labelled.at;
  for (const problem of found) {
    if (problem.open || problem.closedAs !== "completed") return stillAProblem;
    const closers = facts.pullRequests.filter(({ closes }) => closes.includes(problem.issue)).map((closer) => closer.pullRequest);
    if (closers.length === 0) return stillAProblem;
    for (const closer of closers) {
      const result = onTheWay.has(closer) ? UNTRIED : resultOf(closer, facts, operator, onTheWay);
      if (result.is !== "accepted") return stillAProblem;
      if (Date.parse(result.at) > Date.parse(at)) at = result.at;
      fix.add(closer);
    }
  }
  return { is: "accepted", at, problems, fix: [...fix].toSorted((a, b) => a - b) };
}

/**
 * The Operator's latest labelling of either trial label among `labelEvents`,
 * by time and, within one second, by the order GitHub's timeline has them in
 * (two labels put on in one request share a time); null with none, or when
 * they have removed that label since.
 */
function labelledOf(labelEvents: readonly LabelEvent[], operator: string): { readonly label: TrialLabel; readonly at: string } | null {
  const theirs = labelEvents
    .flatMap((event) => {
      const label = TRIAL_LABELS.find((name) => name === event.label);
      return label === undefined || !isOperator(event.actor, operator) ? [] : [{ ...event, label }];
    })
    // A stable sort: events of one second keep the timeline's order.
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latest = theirs.findLastIndex(({ action }) => action === "labeled");
  const labelling = theirs[latest];
  if (labelling === undefined) return null;
  const removedSince = theirs.slice(latest + 1).some(({ action, label }) => action === "unlabeled" && label === labelling.label);
  return removedSince ? null : { label: labelling.label, at: labelling.at };
}

/**
 * Whether a label event's actor is the Operator. GitHub tells logins apart
 * whatever their case, and Kit config's `operator` is typed by hand: read
 * strictly, one typed in another case would have every label of theirs
 * ignored, with nothing to say why.
 */
function isOperator(actor: string, operator: string): boolean {
  return actor.toLowerCase() === operator.toLowerCase();
}
