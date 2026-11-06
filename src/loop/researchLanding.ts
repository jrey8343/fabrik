// Landing a research run (#154): when a Researcher run finishes, its findings
// land on the Decision and its Map. The Kit pushes the throwaway branch that
// holds the findings file, posts the Researcher's answer on the Decision as its
// resolution, closes it, and appends one line to the Map's Decisions so far.
// It never touches the rest of the Map, or any other Decision.
import { checkTrustRoot } from "../guard/trust-root.ts";
import { RESEARCH_LABEL } from "./labels.ts";
import { RESEARCH_RUN_FAILED_MARKER } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import { whyNotResearchable } from "./research.ts";
import { parseResearchOutput, type ResearchOutput } from "./researchOutput.ts";
import { researchOfBranch } from "./researchPaths.ts";
import type { Action, IssueContext, LoopEvent, Plan } from "./types.ts";

type ResearchRunFinished = Extract<LoopEvent, { kind: "research-run-finished" }>;

/** The key the resolution is posted under, so the Map's line links to it. */
const RESOLUTION = "resolution";

const CHECK_DISPATCH: Action = { kind: "check-dispatch" };

/** The push job's decision on a Researcher run's branch and reply. */
export function landResearch(event: ResearchRunFinished, { issue, operator }: IssueContext): Plan {
  const parsed = parseResearchOutput(event.output);
  if (!parsed.ok) {
    return {
      kind: "fail",
      failure: "infrastructure",
      reason: `The Researcher on #${event.issue} emitted output that breaks its contract: ${parsed.errors.join("; ")}`,
    };
  }
  const research = researchOfBranch(event.branch);
  if (research === null || research.decision !== event.issue) {
    return { kind: "fail", failure: "infrastructure", reason: `\`${event.branch}\` isn't #${event.issue}'s research branch` };
  }
  // A Decision closed, relabelled or taken off its Map during the run, or whose Map closed, is the Operator's call now.
  const stale = whyNotResearchable(issue);
  const map = issue.parentIssue;
  if (stale !== null || map === null) {
    return { kind: "nothing", reason: `${stale ?? `#${issue.number} isn't a sub-issue of a Map`}, so the Researcher's findings aren't landed` };
  }
  // Every commit counts, and both ends of a rename, so nothing hides behind a later revert or a move.
  const changes = [...event.changes.net, ...event.changes.commits];
  const guard = checkTrustRoot(changes);
  if (guard.kind === "refuse") {
    const why = `The Researcher's branch for #${event.issue} changes files that steer or judge the agents, so the Kit didn't push it (ADR-0005):`;
    return refuse(event, operator, why, guard.paths);
  }
  const findings = research.findingsPath;
  const touched = changes.flatMap(({ path, from }) => (from === undefined ? [path] : [from, path]));
  const others = [...new Set(touched.filter((path) => path !== findings))];
  if (others.length > 0) {
    const why = `The Researcher's branch for #${event.issue} changes more than its findings file, \`${findings}\`, the one file a research run may change, so the Kit didn't push it:`;
    return refuse(event, operator, why, others);
  }
  // The resolution links the findings file on the branch, so the branch must hold it.
  if (!event.changes.net.some(({ path }) => path === findings)) {
    const why = `The Researcher's branch for #${event.issue} doesn't write its findings file, \`${findings}\`, so there's nothing to land.`;
    return refuse(event, operator, why);
  }
  const { gist, keyFacts } = silenced(parsed.output);
  return {
    kind: "act",
    actions: [
      { kind: "push-branch", branch: event.branch },
      { kind: "comment", issue: issue.number, key: RESOLUTION, body: resolution(gist, keyFacts, findings, event) },
      { kind: "close", issue: issue.number, reason: "completed" },
      {
        kind: "append-to-decisions-so-far",
        issue: map.number,
        // As `/wayfinder` writes it: the Decision, linking its resolution, then the gist.
        line: [`- [${linkText(issue.title)}](`, { posted: RESOLUTION }, `): ${gist}`],
      },
      CHECK_DISPATCH,
    ],
  };
}

/**
 * A branch the Kit won't land: nothing is pushed, and the Decision gets the
 * research failure notice, which Dispatch reads as its last run failing, so
 * only the Operator re-adding agent:research runs it again. It says why, and
 * lists the paths to blame, if any. The run no longer holds a slot.
 */
function refuse({ issue, runUrl }: ResearchRunFinished, operator: string, why: string, paths: readonly string[] = []): Plan {
  const body = [
    RESEARCH_RUN_FAILED_MARKER,
    `@${operator} ${why}`,
    ...(paths.length === 0 ? [] : ["", ...paths.map((path) => `- \`${path}\``)]),
    "",
    `The Decision stays open. Re-add the \`${RESEARCH_LABEL}\` label to run it again.`,
    "",
    `[The run](${runUrl})`,
  ].join("\n");
  return {
    kind: "act",
    actions: [
      // Off now, so that adding it back is a fresh label event that starts the Researcher.
      { kind: "remove-label", issue, label: RESEARCH_LABEL },
      { kind: "comment", issue, body },
      CHECK_DISPATCH,
    ],
  };
}

/** The Researcher's reply with an @-mention in none of it. */
function silenced({ gist, keyFacts }: ResearchOutput): ResearchOutput {
  return { gist: withoutMentions(gist), keyFacts: keyFacts.map(withoutMentions) };
}

/**
 * A title as a link's text: it mentions nobody, and its brackets and
 * backslashes are escaped, so it can't end the link early.
 */
function linkText(title: string): string {
  return withoutMentions(title).replace(/[[\]\\]/g, (character) => `\\${character}`);
}

/**
 * The resolution comment: the answer, the facts it rests on, each one list
 * item however many lines it runs to, and links to the findings file on its
 * branch and to the run.
 */
function resolution(
  gist: string,
  keyFacts: readonly string[],
  findingsPath: string,
  { branch, repoUrl, runUrl }: ResearchRunFinished,
): string {
  return [
    `The Researcher's answer: ${gist}`,
    "",
    "Key facts:",
    "",
    ...keyFacts.map((fact) => `- ${fact.trim().replace(/\r?\n/g, "\n  ")}`),
    "",
    `[The findings](${repoUrl}/blob/${branch}/${findingsPath}) · [The run](${runUrl})`,
  ].join("\n");
}
