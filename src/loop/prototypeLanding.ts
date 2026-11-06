// Landing a Design session's prototype turn (#155): when the prototype job
// ends, the push job pushes the issue's prototype branch and posts the
// prototype round, whose one question, "Which variant?", the Kit writes. A
// prototype round is a round of the same session: it never ends it, and the
// Operator's reply to it starts an ordinary turn.
import { type CaptureFailure, code } from "../evidence/uiEvidence.ts";
import { checkTrustRoot } from "../guard/trust-root.ts";
import { parsePrototypeTurnOutput, type PrototypeRoundOutput } from "./designOutput.ts";
import { designRoundMarker, PROTOTYPE_FAILURE_ROUND_MARKER, PROTOTYPE_ROUND_MARKER } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import type { Action, IssueContext, LoopEvent, Plan } from "./types.ts";

type PrototypeRunFinished = Extract<LoopEvent, { kind: "prototype-run-finished" }>;

/** The capture failures that leave nothing to look at: the variants were never served. */
const NOT_SERVED: readonly CaptureFailure[] = ["build-failed", "server-did-not-start"];

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
  const comment = (body: string): Action => ({ kind: "comment", issue: event.issue, body });
  const failed = (said: string): Action => comment(failureRound(round, operator, said));
  // Every commit counts, and both ends of a rename, so nothing hides behind a later revert or a move.
  const guard = checkTrustRoot([...event.changes.net, ...event.changes.commits]);
  if (guard.kind === "refuse") {
    const said = [
      `The prototype turn's branch for #${event.issue} changes files that steer or judge the agents, so the Kit didn't push it (ADR-0005):`,
      "",
      ...guard.paths.map((path) => `- \`${path}\``),
      "",
      `Only the Operator changes these. [The run](${event.runUrl}) has what the turn did.`,
    ].join("\n");
    return { kind: "act", actions: [failed(said)] };
  }
  // Commits that undo each other built nothing either.
  if (event.changes.net.length === 0) {
    const said = `The prototype turn on #${event.issue} built nothing: its branch has no change of its own, so the Kit pushed nothing and there's nothing to look at. [The run](${event.runUrl}) has what the turn did.`;
    return { kind: "act", actions: [failed(said)] };
  }
  const push: Action = { kind: "push-prototype-branch", issue: event.issue };
  const { capture } = event;
  if (capture?.outcome === "failed" && NOT_SERVED.includes(capture.reason)) {
    // The branch is still worth a look: it holds what the agent wrote.
    const said = `The Kit pushed the variants the prototype turn wrote to [\`${event.branch}\`](${branchUrl(event)}), but ${captureFailed(capture.reason, event.runUrl)}, and nothing to look at. [The run](${event.runUrl}) has the log.`;
    return { kind: "act", actions: [push, failed(said)] };
  }
  return { kind: "act", actions: [push, comment(prototypeRound(round, parsed.output, event, operator))] };
}

/**
 * A prototype failure round: a round too, with the next round's marker, the
 * failure marker under it and the one @-mention, saying what stopped the
 * prototype. Its one question is the Kit's, and it recommends carrying on, so
 * that `yes` never spends another prototype turn's Sandbox time.
 */
function failureRound(round: number, operator: string, said: string): string {
  return [
    designRoundMarker(round),
    PROTOTYPE_FAILURE_ROUND_MARKER,
    `@${operator} **Design session, round ${round}: the prototype failed.** Reply with how you'd go on, or \`yes\` to take the recommendation.`,
    "",
    said,
    "",
    "**1. Carry on without a prototype, or try again?**",
    "➡️ Recommended: Carry on without a prototype. Trying again spends another prototype turn's Sandbox time, and may fail the same way.",
  ].join("\n");
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
    `[The prototype branch](${branchUrl(event)}) · ${galleryLine(event)}`,
    "",
    ...variantLines(output, event),
    "",
    "**1. Which variant?**",
    `➡️ Recommended: ${withoutMentions(output.recommendation)}`,
  ].join("\n");
}

/**
 * Where the variants can be seen: the gallery, which expires, or, when capture
 * failed after the build, why there's none. Either way the branch holds them.
 */
function galleryLine({ capture, gallery, runUrl }: PrototypeRunFinished): string {
  if (capture === undefined || capture.outcome === "failed") {
    const why = capture === undefined ? "the prototype job passed out no capture result the push job could read" : captureFailed(capture.reason, runUrl);
    return `There's no gallery: ${why}. The branch holds the variants, and this comment is the prototype's record.`;
  }
  if (gallery === null) return "The Kit kept no gallery of the captures, so this comment is the prototype's record.";
  return `[The gallery](${gallery}) of each variant's screenshots and videos. The gallery expires in about 30 days, so this comment is the prototype's record.`;
}

/** Why a prototype's capture failed, in plain words: its own, since a PR's (FAILURE_WORDS) speak of the Implement job. */
function captureFailed(reason: CaptureFailure, runUrl: string): string {
  switch (reason) {
    case "build-failed":
      return "`sandbox.build` failed, so there was no build to serve";
    case "server-did-not-start":
      return "the dev server wouldn't start: nothing answered at `ui.url` once `ui.serve` ran";
    case "timeout":
      return "capture ran out of time";
    case "no-variants":
      return "capture found no variant to capture in the turn's output";
    case "no-routes":
      return "capture found no route to capture";
    case "error":
      return `capture hit an error the Kit didn't expect, which [the run](${runUrl}) shows`;
    case "no-result":
      return "capture left no result the push job could read";
  }
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
