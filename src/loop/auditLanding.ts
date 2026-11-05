// Landing an Audit (#150): when the Auditor's run finishes, its reply fills in
// the pending Audit. The Kit renders every word of layout; the Auditor wrote
// only the candidates' text. The Audit stays silent: no state label, no
// assignee, no mention.
import { isPendingAudit } from "./audit.ts";
import { failAudit } from "./auditFailure.ts";
import { type AuditCandidate, type AuditOutput, parseAuditOutput } from "./auditOutput.ts";
import { auditMarker, auditMarksIn } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import type { AuditWindow, IssueContext, LoopEvent, NamedPullRequestSnapshot, Plan, Strength } from "./types.ts";

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
    actions: [{ kind: "edit-issue-body", issue: issue.number, body: filledBody(output, named, commit, event.window) }],
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
    `The Auditor read the default branch up to \`${short(commit)}\`, ${lookedFirstAt(window)}, and found nothing above Speculative: the repo is clean.`,
    "",
    auditMarker(commit),
  ].join("\n");
}

/** A filled Audit: what it read and what to do, a card per candidate, the Top recommendation, then its audit marker. */
function filledBody(
  { candidates, topRecommendation }: AuditOutput,
  named: readonly NamedPullRequestSnapshot[],
  commit: string,
  window: AuditWindow,
): string {
  return [
    `The Auditor read the default branch up to \`${short(commit)}\`, ${lookedFirstAt(window)}. File the candidates you want, comment here on any you reject so the next Audit knows, and close this Audit when you're done.`,
    ...candidates.flatMap((candidate) => ["", ...card(candidate, keptPullRequests(candidate, named))]),
    "",
    "## Top recommendation",
    "",
    topRecommendation ?? "",
    "",
    auditMarker(commit),
  ].join("\n");
}

const BADGES: Readonly<Record<Strength, string>> = {
  strong: "Strong",
  "worth-exploring": "Worth exploring",
  speculative: "Speculative",
};

/**
 * The PRs a candidate traces to that the Kit can vouch for: each merged agent
 * PR the Auditor named, once, in its order. The rest are dropped silently, so
 * the Auditor can't blame a person's work or invent a PR.
 */
function keptPullRequests(candidate: AuditCandidate, named: readonly NamedPullRequestSnapshot[]): number[] {
  const vouched = new Set(named.filter((pullRequest) => pullRequest.merged && pullRequest.isAgent).map(({ number }) => number));
  return [...new Set(candidate.introducedBy)].filter((number) => vouched.has(number));
}

/** One candidate's card, with the PRs kept from its Introduced by. */
function card(candidate: AuditCandidate, introducedBy: readonly number[]): string[] {
  return [
    `## ${candidate.title}`,
    "",
    `\`${BADGES[candidate.strength]}\``,
    "",
    `**Files:** ${candidate.files.map((file) => `\`${file}\``).join(", ")}`,
    "",
    `**Problem:** ${candidate.problem}`,
    "",
    `**Solution:** ${candidate.solution}`,
    "",
    `**Benefits:** ${candidate.benefits}`,
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
    // Each card ends with its Open as issue link (#207), after Introduced by.
  ];
}

function mermaid(source: string): string[] {
  return ["```mermaid", source, "```"];
}

function lookedFirstAt(window: AuditWindow): string {
  switch (window.kind) {
    case "since-audit":
      return `looking first at what changed since Audit #${window.audit} at \`${short(window.commit)}\``;
    case "last-days":
      return `looking first at the last ${window.days} days`;
  }
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
