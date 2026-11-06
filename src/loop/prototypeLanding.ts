// Landing a Design session's prototype turn (#155): when the prototype job
// ends, the push job pushes the issue's prototype branch and posts the
// prototype round, whose one question, "Which variant?", the Kit writes. A
// prototype round is a round of the same session: it never ends it, and the
// Operator's reply to it starts an ordinary turn.
import { code } from "../evidence/uiEvidence.ts";
import { parsePrototypeTurnOutput, type PrototypeRoundOutput } from "./designOutput.ts";
import { designRoundMarker, PROTOTYPE_ROUND_MARKER } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import type { IssueContext, LoopEvent, Plan } from "./types.ts";

type PrototypeRunFinished = Extract<LoopEvent, { kind: "prototype-run-finished" }>;

/** The push job's decision on a prototype turn's branch and round. */
export function applyPrototypeTurn(event: PrototypeRunFinished, { issue, operator }: IssueContext): Plan {
  const parsed = parsePrototypeTurnOutput(event.output);
  if (!parsed.ok) {
    return {
      kind: "fail",
      failure: "infrastructure",
      reason: `The prototype turn on #${event.issue} emitted output that breaks its contract: ${parsed.errors.join("; ")}`,
    };
  }
  const round = issue.designRounds + 1;
  return {
    kind: "act",
    actions: [
      { kind: "push-prototype-branch", issue: event.issue },
      { kind: "comment", issue: event.issue, body: prototypeRound(round, parsed.output, event, operator) },
    ],
  };
}

/**
 * The prototype round: a round, so it opens with the next round's marker and
 * carries the session's one @-mention, with the prototype marker under it.
 * The agent's text mentions nobody. The gallery expires, so the round itself
 * describes each variant and links its component on the branch at the head
 * the push left, which outlives it.
 */
function prototypeRound(round: number, output: PrototypeRoundOutput, event: PrototypeRunFinished, operator: string): string {
  return [
    designRoundMarker(round),
    PROTOTYPE_ROUND_MARKER,
    `@${operator} **Design session, round ${round}: the prototype.** Reply with the variant you'd build, and any changes to it, or \`yes\` to take the recommendation.`,
    "",
    withoutMentions(output.intro),
    "",
    `[The prototype branch](${branchUrl(event)}) · [The gallery](${event.gallery}) of each variant's screenshots and videos. The gallery expires in about 30 days, so this comment is the prototype's record.`,
    "",
    ...variantLines(output, event),
    "",
    "**1. Which variant?**",
    `➡️ Recommended: ${withoutMentions(output.recommendation)}`,
  ].join("\n");
}

/** Each variant: its letter, its summary, and its component on the branch at the pushed head. */
function variantLines({ variants }: PrototypeRoundOutput, { repoUrl, headSha }: PrototypeRunFinished): string[] {
  return variants.map(
    ({ letter, summary, component }) =>
      `- **${letter}.** ${withoutMentions(summary)} [${code(component)}](${repoUrl}/blob/${headSha}/${pathInUrl(component)})`,
  );
}

function branchUrl({ repoUrl, branch }: PrototypeRunFinished): string {
  return `${repoUrl}/tree/${branch}`;
}

/**
 * A repo path as a URL's path: each segment percent-encoded, parentheses
 * too, so agent text can't end the Markdown link early.
 */
function pathInUrl(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}
