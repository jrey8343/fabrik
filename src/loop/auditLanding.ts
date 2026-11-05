// Landing an Audit (#150): when the Auditor's run finishes, its reply fills in
// the pending Audit. The Kit renders every word of layout; the Auditor wrote
// only the candidates' text. The Audit stays silent: no state label, no
// assignee, no mention.
import { shortSha } from "../skills/lock.ts";
import { isPendingAudit, TOP_RECOMMENDATION_HEADING } from "./audit.ts";
import { failAudit } from "./auditFailure.ts";
import { type AuditCandidate, type AuditOutput, parseAuditOutput } from "./auditOutput.ts";
import { newIssueUrl } from "./followUps.ts";
import { auditMarker, auditMarksIn, escapeMarker, fromAuditLine } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import { type AuditWindow, type IssueContext, type LoopEvent, type NamedPullRequestSnapshot, type Plan, STRENGTH_LABELS, STRENGTHS } from "./types.ts";

type AuditFinished = Extract<LoopEvent, { kind: "audit-run-finished" }>;

/**
 * The Auditor's reply, rendered into its Audit, the issue in `context`, given
 * the PRs the reply named. A reply that breaks the contract fails the Audit,
 * never files it half-formed, and a result for an Audit that's no longer
 * pending lands nothing: closing a pending Audit cancels it.
 */
export function landAudit(event: AuditFinished, context: IssueContext, named: readonly NamedPullRequestSnapshot[] | null): Plan {
  const { issue } = context;
  if (named === null) {
    return { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the PRs the Auditor named" };
  }
  const { commit } = auditMarksIn(issue.body);
  if (!isPendingAudit(issue) || commit === null) {
    return { kind: "nothing", reason: `#${issue.number} is no longer a pending Audit, so its Auditor's result is stale` };
  }
  const parsed = parseAuditOutput(event.output);
  if (!parsed.ok) {
    // The failed Audit's one line may quote the reply, so it mentions nobody and stays one line.
    const errors = withoutMentions(parsed.errors.join("; ").replace(/\s+/g, " "));
    const how = `its reply broke the Audit output contract (${errors})`;
    return failAudit(context, { failure: "missing-output", how, runUrl: event.runUrl, resetsAt: null });
  }
  const output = silenced(parsed.output);
  // A clean week still leaves an Audit on the record, which closes itself.
  if (!output.candidates.some((candidate) => candidate.strength !== "speculative")) {
    return {
      kind: "act",
      actions: [
        { kind: "edit-issue-body", issue: issue.number, body: cleanBody(commit, event.window) },
        { kind: "close", issue: issue.number, reason: "completed" },
      ],
    };
  }
  return {
    kind: "act",
    actions: [{ kind: "edit-issue-body", issue: issue.number, body: filledBody(output, named, commit, event) }],
  };
}

/** The Auditor's output with an @-mention in none of its text, Mermaid source and paths included. */
function silenced({ candidates, topRecommendation }: AuditOutput): AuditOutput {
  return {
    candidates: candidates.map((candidate) => ({
      ...candidate,
      title: withoutMentions(candidate.title),
      files: candidate.files.map(withoutMentions),
      problem: withoutMentions(candidate.problem),
      solution: withoutMentions(candidate.solution),
      benefits: withoutMentions(candidate.benefits),
      before: withoutMentions(candidate.before),
      after: withoutMentions(candidate.after),
    })),
    topRecommendation: topRecommendation === null ? null : withoutMentions(topRecommendation),
  };
}

/** A clean Audit: one line, then its audit marker. */
function cleanBody(commit: string, window: AuditWindow): string {
  return [
    `The Auditor read the default branch up to \`${shortSha(commit)}\`, ${lookedFirstAt(window)}, and found nothing above Speculative: the repo is clean.`,
    "",
    auditMarker(commit),
  ].join("\n");
}

/** A filled Audit: what it read and what to do, a card per candidate Strongest first, the Top recommendation, then its audit marker. */
function filledBody(
  { candidates, topRecommendation }: AuditOutput,
  named: readonly NamedPullRequestSnapshot[],
  commit: string,
  { issue: audit, window, repoUrl }: AuditFinished,
): string {
  return [
    `The Auditor read the default branch up to \`${shortSha(commit)}\`, ${lookedFirstAt(window)}. File the candidates you want, comment here on any you reject so the next Audit knows, and close this Audit when you're done.`,
    ...strongestFirst(candidates).flatMap((candidate) => ["", ...card(candidate, keptPullRequests(candidate, named), repoUrl, audit)]),
    "",
    TOP_RECOMMENDATION_HEADING,
    "",
    topRecommendation ?? "",
    "",
    auditMarker(commit),
  ].join("\n");
}

/** The candidates Strongest first, keeping the Auditor's order among those of one Strength. */
function strongestFirst(candidates: readonly AuditCandidate[]): AuditCandidate[] {
  return candidates.toSorted((a, b) => STRENGTHS.indexOf(a.strength) - STRENGTHS.indexOf(b.strength));
}

/**
 * The PRs a candidate traces to that the Kit can vouch for: each merged agent
 * PR the Auditor named, once, in its order. The rest are dropped silently, so
 * the Auditor can't blame a person's work or invent a PR.
 */
function keptPullRequests(candidate: AuditCandidate, named: readonly NamedPullRequestSnapshot[]): number[] {
  const vouched = new Set(named.filter((pullRequest) => pullRequest.merged && pullRequest.isAgent).map(({ number }) => number));
  return [...new Set(candidate.introducedBy)].filter((number) => vouched.has(number));
}

/** One candidate's card, with the PRs kept from its Introduced by, ending with its Open as issue link. */
function card(candidate: AuditCandidate, introducedBy: readonly number[], repoUrl: string, audit: number): string[] {
  return [
    `## ${candidate.title}`,
    "",
    `\`${STRENGTH_LABELS[candidate.strength]}\``,
    "",
    ...described(candidate),
    "",
    "**Before**",
    "",
    ...mermaid(candidate.before),
    "",
    "**After**",
    "",
    ...mermaid(candidate.after),
    "",
    `**Introduced by:** ${introducedBy.length === 0 ? "No merged agent PR" : introducedBy.map((n) => `#${n}`).join(", ")}`,
    "",
    `[Open as issue](${openAsIssue(candidate, introducedBy, repoUrl, audit)})`,
  ];
}

/** A candidate's Files, Problem, Solution and Benefits, as its card and the issue it opens both show them. */
function described(candidate: AuditCandidate): string[] {
  return [
    `**Files:** ${candidate.files.map((file) => `\`${file}\``).join(", ")}`,
    "",
    `**Problem:** ${candidate.problem}`,
    "",
    `**Solution:** ${candidate.solution}`,
    "",
    `**Benefits:** ${candidate.benefits}`,
  ];
}

/**
 * The Product repo's new-issue form, prefilled with the candidate, its
 * diagrams left on the Audit to keep the link short. Its trailer names the
 * Audit, so the next one skips the filed issue, and when the candidate traces
 * to merged agent PRs, the escape marker that filing it records. A Design
 * session's rewrite carries both lines forward (src/loop/carriedLines.ts).
 */
function openAsIssue(candidate: AuditCandidate, introducedBy: readonly number[], repoUrl: string, audit: number): string {
  const body = [...described(candidate), "", `**Strength:** ${STRENGTH_LABELS[candidate.strength]}`].join("\n");
  const trailer = [fromAuditLine(audit), ...(introducedBy.length === 0 ? [] : [escapeMarker(candidate.strength, introducedBy)])];
  return newIssueUrl(repoUrl, candidate.title, body, trailer.join("\n"));
}

function mermaid(source: string): string[] {
  return ["```mermaid", source, "```"];
}

function lookedFirstAt(window: AuditWindow): string {
  switch (window.kind) {
    case "since-audit":
      return `looking first at what changed since Audit #${window.audit} at \`${shortSha(window.commit)}\``;
    case "last-days":
      return `looking first at the last ${window.days} days`;
  }
}
