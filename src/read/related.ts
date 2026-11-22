// What a row carries beside an agent pull request (#619): the issues that
// could still be rolled in to it, its candidates, and each Roll-in owed on it
// (#664, ./owedRollIn.ts); the open issues that only mention it; and the
// Follow-ups its pass named, each a fault or an idea, on a merged pull
// request's row too, where a fault's issue is the one the Kit opened at the
// merge (#885). Each is said by the Kit's own readers, never
// guessed: a candidate's `From PR` line by the reader of that line, an owed
// Roll-in by the Loop's owed rule, a Follow-up by the reader of a Verdict's
// Follow-ups. Decided in #530 and #574. Pure, no I/O: worked out from a
// gather's facts (./gather.ts).
import { verdictsIn } from "../github/threads.ts";
import { verdictsOn } from "../kit/retroEvidence.ts";
import type { OpenIssueFacts, OpenPullRequestFacts } from "../kit/weeklySummary.ts";
import { followUpsIn } from "../loop/followUps.ts";
import {
  AUDIT_LABEL,
  DECISION_TYPES,
  decisionLabel,
  FLAKY_CHECK_LABEL,
  isKitIssueLabel,
  MAP_LABEL,
  MONITOR_LABEL,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  REPLAY_LABEL,
  RETRO_LABEL,
} from "../loop/labels.ts";
import { followUpsOpenedIn, fromPullRequestIn, type RollInText } from "../loop/markers.ts";
import { namesIssue } from "../loop/owedRollIn.ts";
import type { FollowUp } from "../loop/verdict.ts";
import type { Facts, MergedFollowUpsFacts } from "./gather.ts";
import { owedOn } from "./owedRollIn.ts";

/** An issue related to an open agent pull request: one that could still be rolled in to it, or one whose Roll-in the Operator settled and has not sent. */
export type Related =
  | { readonly issue: number; readonly title: string; readonly kind: "candidate" }
  | {
      readonly issue: number;
      readonly title: string;
      readonly kind: "owed";
      /** When the Roll-in was settled: the closing comment's time. */
      readonly at: string;
      /** The closing comment. */
      readonly url: string;
      /** What to build, as the session gave it, or null when the comment's hidden line holds none this release can read. */
      readonly text: RollInText | null;
    };

/** The kinds of issue never related to a pull request, whatever their `From PR` line says. */
export type NeverRelatedKind = "audit" | "retro" | "monitor" | "replay" | "kit-owned" | "map" | "decision" | "spec";

/** Each kind told by a label of its own, in the order they are looked for. */
const KIND_LABELS: readonly (readonly [NeverRelatedKind, (label: string) => boolean])[] = [
  ["audit", (label) => label === AUDIT_LABEL],
  ["retro", (label) => label === RETRO_LABEL],
  ["monitor", (label) => label === MONITOR_LABEL],
  ["replay", (label) => label === REPLAY_LABEL],
  ["kit-owned", (label) => isKitIssueLabel(label) || label === FLAKY_CHECK_LABEL],
  ["map", (label) => label === MAP_LABEL],
  ["decision", (label) => DECISION_TYPES.some((type) => decisionLabel(type) === label)],
];

/**
 * The kind of issue `issue` is when it is never related to a pull request: an
 * Audit, a Retro, a Monitor issue, a Replay, any other Kit-owned issue (one
 * carrying a Kit-owned label or the Flaky check label, or one the Fabrik App
 * opened, any bot when its login `appLogin` is not known), a Map, a Decision
 * or a Spec (an issue with sub-issues in the `ready-for-agent` or
 * `ready-for-human` state, GLOSSARY.md). Null for any other issue, a Ticket
 * waiting for Dispatch among them. The pull request's own Ticket and an issue
 * with an open pull request of its own are told per pull request, not here.
 */
export function neverRelatedKindOf(issue: Pick<OpenIssueFacts, "author" | "labels" | "subIssues">, appLogin: string | null): NeverRelatedKind | null {
  const labelled = KIND_LABELS.find(([, carries]) => issue.labels.some(carries))?.[0];
  if (labelled !== undefined) return labelled;
  if (appLogin === null ? issue.author.endsWith("[bot]") : issue.author === appLogin) return "kit-owned";
  const inState = issue.labels.includes(READY_FOR_AGENT) || issue.labels.includes(READY_FOR_HUMAN);
  return inState && issue.subIssues.length > 0 ? "spec" : null;
}

/** An issue that could still be rolled in to an open agent pull request. */
interface Candidate {
  readonly issue: number;
  readonly title: string;
  /** The open agent pull request its `From PR` line names. */
  readonly pullRequest: number;
}

/**
 * Every candidate in the repo: each open issue the Operator opened whose body
 * has a whole line `From PR #n`, where `n` is an open agent pull request,
 * unless it is a kind never related, that pull request's own Ticket, or an
 * issue with an open pull request of its own, agent or Plain.
 */
function candidatesOf({ github, operator, appLogin, issueBodies }: Facts): Candidate[] {
  const withPullRequests = new Set([
    ...github.openPullRequests.flatMap(({ ticket }) => (ticket === null ? [] : [ticket])),
    ...github.plainPullRequests.flatMap(({ closes }) => closes),
  ]);
  return github.openIssues.flatMap((issue) => {
    const { number, title, author } = issue;
    if (author !== operator || neverRelatedKindOf(issue, appLogin) !== null || withPullRequests.has(number)) return [];
    const body = issueBodies.find((bodied) => bodied.issue === number)?.body;
    const named = body === undefined ? null : fromPullRequestIn(body);
    const pullRequest = github.openPullRequests.find((open) => open.number === named);
    if (pullRequest === undefined || namedInRequestChanges(pullRequest, operator, github.repo, number)) return [];
    return [{ issue: number, title, pullRequest: pullRequest.number }];
  });
}

/**
 * Whether a Request changes of the Operator's on `pullRequest`, not dismissed,
 * names issue `issue` of `repo`, `owner/name`, in the review's own text: by
 * its number after a `#`, or by its link. A comment pinned to a line is not
 * read.
 */
function namedInRequestChanges(pullRequest: OpenPullRequestFacts, operator: string, repo: string, issue: number): boolean {
  return pullRequest.reviews.some(({ author, state, body }) => author === operator && state === "changes-requested" && namesIssue(body, repo, issue));
}

/**
 * The issues related to open agent pull request `pullRequest`: those that
 * could still be rolled in to it, its candidates, in the order of the open
 * issues, then each Roll-in owed on it (./owedRollIn.ts), lowest issue
 * number first.
 */
export function relatedOf(facts: Facts, pullRequest: number): Related[] {
  const candidates = candidatesOf(facts)
    .filter((candidate) => candidate.pullRequest === pullRequest)
    .map(({ issue, title }): Related => ({ issue, title, kind: "candidate" }));
  const owed = owedOn(facts, pullRequest).map(({ issue, title, at, url, text }): Related => ({ issue, title, kind: "owed", at, url, text }));
  return [...candidates, ...owed];
}

/**
 * The open issues that only mention open agent pull request `pullRequest`:
 * each issue in the same repo that GitHub cross-references to it, once, in
 * the order GitHub lists them, but for a candidate, which is under related,
 * and the pull request's own Ticket, which the Kit's own comments
 * cross-reference to it. A closed issue's, another repo's and a pull
 * request's cross-reference is none.
 */
export function mentionsOf(facts: Facts, pullRequest: number): { readonly issue: number; readonly title: string }[] {
  const { github, crossReferences } = facts;
  const ticket = github.openPullRequests.find(({ number }) => number === pullRequest)?.ticket ?? null;
  const related = new Set(relatedOf(facts, pullRequest).map(({ issue }) => issue));
  const mentions: { readonly issue: number; readonly title: string }[] = [];
  for (const { pullRequest: referenced, issue, title, open, repo } of crossReferences) {
    const inRepo = repo.toLowerCase() === github.repo.toLowerCase();
    if (referenced !== pullRequest || !open || !inRepo || issue === ticket || related.has(issue) || mentions.some((mention) => mention.issue === issue)) continue;
    mentions.push({ issue, title });
  }
  return mentions;
}

/** A Follow-up as a row carries it: its title, its body, its kind, and the issue it was filed as, whoever opened that, or null. */
export type RowFollowUp = FollowUp & { readonly filedAs: number | null };

/**
 * The Follow-ups the pass on open agent pull request `pullRequest`'s head
 * named, in the Verdict's order, each with its title, its body, its kind
 * (#885) and the number of the related issue, a candidate or an owed
 * Roll-in's, that has exactly its title, compared as the Retro's evidence
 * compares a filed Follow-up's, else null. None when the latest Verdict on
 * its head is not a pass, or it has none there. A Verdict is read from a
 * bot's comment alone, so quoting one fakes nothing.
 *
 * On a merged agent pull request the gather read the comments of (those
 * merged in the last 24 hours), the Follow-ups its last Verdict named, when
 * that is a pass (mergedFollowUpsOf). `filedAs` is then the issue the Kit
 * opened for it at the merge, as the Kit's comment there records it, by the
 * same comparison of titles; else the open issue the Operator opened whose
 * `From PR` line names the pull request and whose title is its own; else
 * null. None on any other pull request.
 */
export function followUpsOf(facts: Facts, pullRequest: number): RowFollowUp[] {
  const open = facts.github.openPullRequests.find(({ number }) => number === pullRequest);
  if (open === undefined) return mergedFollowUps(facts, pullRequest);
  const onHead = open.comments.filter((comment) => verdictsOn([comment]).some(({ record }) => record.headSha === open.headSha)).at(-1);
  if (onHead === undefined || verdictsOn([onHead]).at(-1)?.record.verdict !== "pass") return [];
  const related = relatedOf(facts, pullRequest);
  return followUpsIn(onHead.body).map(({ title, body, kind }) => ({
    title,
    body,
    kind,
    filedAs: related.find((issue) => issue.title.trim() === title.trim())?.issue ?? null,
  }));
}

/** A merged pull request's Follow-ups, from what the gather read of its comments: none in facts kept from a release that read none. */
function mergedFollowUps({ github, operator, issueBodies, mergedFollowUps: read }: Facts, pullRequest: number): RowFollowUp[] {
  const merged = (read as Facts["mergedFollowUps"] | undefined)?.find((each) => each.pullRequest === pullRequest);
  if (merged === undefined) return [];
  const byOperator = github.openIssues.filter(({ number, author }) => author === operator && fromPullRequestIn(issueBodies.find(({ issue }) => issue === number)?.body ?? "") === pullRequest);
  return merged.named.map(({ title, body, kind }) => {
    const sameTitle = (other: { readonly title: string }) => other.title.trim() === title.trim();
    return { title, body, kind, filedAs: (kind === "fault" ? merged.opened.find(sameTitle)?.issue : undefined) ?? byOperator.find(sameTitle)?.number ?? null };
  });
}

/**
 * What the comments of merged agent pull request `pullRequest` say of its
 * Follow-ups (#885), as the facts keep it: those its last Verdict named,
 * when that is a pass, each with its kind, and each fault the Kit opened as
 * an issue at the merge, as its comment there records. Null when it named
 * none. Read from a bot's comments alone, as a Verdict is.
 */
export function mergedFollowUpsOf(pullRequest: number, comments: readonly { readonly body: string; readonly byBot: boolean }[]): MergedFollowUpsFacts | null {
  const byBots = comments.filter(({ byBot }) => byBot).map(({ body }) => body);
  const last = byBots.findLast((body) => verdictsIn([body]).length > 0);
  const named = last === undefined || verdictsIn([last])[0]?.verdict !== "pass" ? [] : followUpsIn(last);
  if (named.length === 0) return null;
  return { pullRequest, named, opened: byBots.flatMap((body) => followUpsOpenedIn(body)?.opened ?? []) };
}

/** The open agent pull request issue `issue` could be rolled in to, or null. */
export function relatedToOf(facts: Facts, issue: number): number | null {
  return candidatesOf(facts).find((candidate) => candidate.issue === issue)?.pullRequest ?? null;
}
