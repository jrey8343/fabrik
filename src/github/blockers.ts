// The blocker rule (ADR-0001, amended in #98 and #771), read from GitHub's
// answer: which of an issue's blocked-by edges still hold it, and how many
// blockers GitHub counts that the read couldn't see. Every reader of an issue's
// blockers goes through it: Dispatch's Ticket and research Decision reads, the
// single-issue snapshot, and the open-issue facts the Standings read, the read
// library's among them. How a Blocker is named lives in src/loop/blockers.ts.
import { inBlockerOrder, type IssueRef } from "../loop/blockers.ts";

/** GitHub's most issues per relationship, and so the most blocked-by edges a read asks for. */
const BLOCKERS_READ = 50;

/** What each read asks of an issue at the other end of a blocked-by edge: whether it still blocks is read from its state, why it is in that state and its repo. */
export const BLOCKER = "number state stateReason repository { nameWithOwner }";

/**
 * An issue's blocked-by edges, as `blockedBy(first: 50) { nodes { … } }`, with
 * each blocker as BLOCKER reads it and `more`, and how many open blockers
 * GitHub counts, among them any in a repo the Fabrik App can't read, which
 * the edges leave out.
 */
export function blockedByFields(more = ""): string {
  return `blockedBy(first: ${BLOCKERS_READ}) { nodes { ${BLOCKER}${more === "" ? "" : ` ${more}`} } }
  issueDependenciesSummary { blockedBy }`;
}

/** An issue's blocked-by edges and GitHub's count of its open blockers, as the open-issue reads ask for them, each blocker's labels left out. */
export const BLOCKED_BY = blockedByFields();

/** An issue at the other end of a blocked-by edge, as BLOCKER reads it. */
export interface RawBlocker {
  number: number;
  state: "OPEN" | "CLOSED";
  /** Why it is in its state, as GitHub's GraphQL names it; null when GitHub records no reason. */
  stateReason: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED" | null;
  repository: { nameWithOwner: string };
}

/** An issue's blocked-by edges, as a read gets them: each blocker as BLOCKER reads it, and whatever more that read asks. */
export interface RawBlockedBy<B extends RawBlocker = RawBlocker> {
  nodes: B[];
}

/** How many open blockers GitHub counts for an issue, whether or not the read can see them. */
export interface RawDependenciesSummary {
  blockedBy: number;
}

/** An issue's Blockers, each once by repo, then number. */
export interface Blockers<R extends IssueRef = IssueRef> {
  /** The ones still open. */
  readonly open: readonly R[];
  /** The ones closed as not planned: their work never landed, so they hold it until the Operator removes the edge. */
  readonly notPlanned: readonly R[];
  /**
   * How many open blockers GitHub counts beyond the ones the read could see,
   * as in a repo the Fabrik App can't read. One closed as not planned there
   * can't be seen or counted.
   */
  readonly hidden: number;
}

/** An edge's blocker by its repo and number. */
export function issueRefOf(edge: RawBlocker): IssueRef {
  return { repo: edge.repository.nameWithOwner, number: edge.number };
}

/**
 * The Blockers at the other end of these edges, in any repo: each one open,
 * or closed as not planned, whose work never landed. One closed as completed
 * or duplicate blocks no more. `summary` gives the hidden ones. Each is read
 * by `refOf`, by default its repo and number.
 */
export function blockersOf(edges: readonly RawBlocker[], summary: RawDependenciesSummary): Blockers;
export function blockersOf<B extends RawBlocker, R extends IssueRef>(edges: readonly B[], summary: RawDependenciesSummary, refOf: (edge: B) => R): Blockers<R>;
export function blockersOf(edges: readonly RawBlocker[], summary: RawDependenciesSummary, refOf: (edge: RawBlocker) => IssueRef = issueRefOf): Blockers {
  const open = edges.filter(({ state }) => state === "OPEN");
  return {
    open: inBlockerOrder(open.map(refOf)),
    notPlanned: inBlockerOrder(edges.filter(({ state, stateReason }) => state === "CLOSED" && stateReason === "NOT_PLANNED").map(refOf)),
    hidden: Math.max(0, summary.blockedBy - open.length),
  };
}

/** Every Blocker these edges hold, open or closed as not planned, each once by repo, then number, and the hidden count. */
export function allBlockersOf(edges: readonly RawBlocker[], summary: RawDependenciesSummary): { readonly blockers: readonly IssueRef[]; readonly hidden: number } {
  const { open, notPlanned, hidden } = blockersOf(edges, summary);
  return { blockers: inBlockerOrder([...open, ...notPlanned]), hidden };
}
