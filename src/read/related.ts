// What a row carries beside an agent pull request (#619): the issues that
// could still be rolled in to it, its candidates; the open issues that only
// mention it; and the Follow-ups its pass named. Each is said by the Kit's own
// readers, never guessed: a candidate's `From PR` line by the reader of that
// line, a Follow-up by the reader of a Verdict's Follow-ups. Decided in #530
// and #574. Pure, no I/O: worked out from a gather's facts (./gather.ts).
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
import { fromPullRequestIn } from "../loop/markers.ts";
import type { Facts } from "./gather.ts";

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
  const byNumber = new RegExp(`(?<![\\w/])#${issue}(?!\\d)`);
  const byLink = new RegExp(`https://github\\.com/${escaped(repo)}/issues/${issue}(?!\\d)`, "i");
  return pullRequest.reviews.some(
    ({ author, state, body }) => author === operator && state === "changes-requested" && (byNumber.test(body) || byLink.test(body)),
  );
}

/** `text` with every character a regular expression gives a meaning to escaped. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The issues that could still be rolled in to open agent pull request `pullRequest`, in the order of the open issues. */
export function relatedOf(facts: Facts, pullRequest: number): { readonly issue: number; readonly title: string; readonly kind: "candidate" }[] {
  return candidatesOf(facts)
    .filter((candidate) => candidate.pullRequest === pullRequest)
    .map(({ issue, title }) => ({ issue, title, kind: "candidate" }));
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

/**
 * The Follow-ups the pass on open agent pull request `pullRequest`'s head
 * named, in the Verdict's order, each with its title, its body and the
 * number of the related issue that has exactly its title, compared as the
 * Retro's evidence compares a filed Follow-up's, else null. None when the
 * latest Verdict on its head is not a pass, or it has none there. A Verdict
 * is read from a bot's comment alone, so quoting one fakes nothing.
 */
export function followUpsOf(facts: Facts, pullRequest: number): { readonly title: string; readonly body: string; readonly filedAs: number | null }[] {
  const open = facts.github.openPullRequests.find(({ number }) => number === pullRequest);
  if (open === undefined) return [];
  const onHead = open.comments.filter((comment) => verdictsOn([comment]).some(({ record }) => record.headSha === open.headSha)).at(-1);
  if (onHead === undefined || verdictsOn([onHead]).at(-1)?.record.verdict !== "pass") return [];
  const related = relatedOf(facts, pullRequest);
  return followUpsIn(onHead.body).map(({ title, body }) => ({
    title,
    body,
    filedAs: related.find((issue) => issue.title.trim() === title.trim())?.issue ?? null,
  }));
}

/** The open agent pull request issue `issue` could be rolled in to, or null. */
export function relatedToOf(facts: Facts, issue: number): number | null {
  return candidatesOf(facts).find((candidate) => candidate.issue === issue)?.pullRequest ?? null;
}
