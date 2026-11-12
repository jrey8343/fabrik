// Landing a Design session's prototype turn (#155): when the prototype job
// ends, the push job pushes the issue's prototype branch and posts the
// prototype round, whose one question, "Which variant?", the Kit writes. A
// prototype round is a round of the same session: it never ends it, and the
// Operator's reply to it starts an ordinary turn.
import { type CaptureFailure, code, failureWords, withParensEscaped } from "../evidence/uiEvidence.ts";
import { type PreviewConfig, previewNamesPullRequest } from "../kit/config.ts";
import { checkTrustRoot } from "../guard/trust-root.ts";
import { replyNotThere, turnStartFrom, whileInSession } from "./design.ts";
import { prototypeTurnRefused } from "./failures.ts";
import { parsePrototypeTurnOutput, prototypeBranchFor, type PrototypeRoundOutput } from "./designOutput.ts";
import {
  designRoundMarker,
  PROTOTYPE_FAILURE_ROUND_MARKER,
  PROTOTYPE_ROUND_MARKER,
  type PrototypeRequestMarker,
} from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import { GITHUB_COMMENT_LIMIT, ROUND_LINE_VERSION, roundLineOf, withoutRoundLines } from "./roundLine.ts";
import type { Action, BranchChanges, IssueContext, LoopEvent, Plan, PostedComment, StartingComment } from "./types.ts";

type PrototypeRunFinished = Extract<LoopEvent, { kind: "prototype-run-finished" }>;

/** The capture failures that leave nothing to look at: the variants were never served. */
const NOT_SERVED: readonly CaptureFailure[] = ["build-failed", "server-did-not-start"];

/** The prototype round's comment, as the plan posts it for its preview to be linked in. */
const ROUND_COMMENT: PostedComment = { posted: "prototype-round" };

/**
 * The push job's decision on a prototype turn's branch and round. `found` is
 * what the snapshot found of the Operator's reply that approved the
 * prototype: like any Design-session turn, one whose reply was deleted posts
 * nothing, and so does a result the session no longer waits on. A result it
 * still waits on but can't land, whose output breaks its contract or whose
 * branch moved, gets the Design-session turn's failure notice, never silence.
 * `preview` is Kit config's, whose link the round waits on.
 */
export function applyPrototypeTurn(
  event: PrototypeRunFinished,
  { issue, operator }: IssueContext,
  found: StartingComment | null,
  preview: PreviewConfig | null,
): Plan {
  const gone = replyNotThere(turnStartFrom(event.request.reply ?? undefined, found), {
    unchecked: (comment) => `The prototype turn on #${event.issue} answers a reply (comment ${comment}) the push job didn't check is still there`,
    deleted: (comment) => `The Operator's reply that approved the prototype on #${event.issue} (comment ${comment}) was deleted, so the prototype turn posts nothing`,
  });
  if (gone !== null) return gone;
  const notNow = whileInSession(event.issue, issue);
  if (notNow !== null) return notNow;
  // The push job reads only the Fabrik App's own requests, so a look-alike another bot posted, which the Kit
  // job took for the App's, isn't one here; nor is one a round has answered since. One another turn's failure
  // notice ended as pending still is: its prototype turn was already building it.
  if (!issue.unansweredPrototypes.some((request) => sameRequest(request, event.request))) {
    return {
      kind: "nothing",
      reason: `#${event.issue}'s Design session isn't waiting on the prototype request this turn built, so its result is stale`,
    };
  }
  // What the push job can't land is the prototype turn's Infrastructure failure, as its agent job failing would be.
  const refused = (how: string) => prototypeTurnRefused(event.issue, operator, how, event.runUrl);
  const parsed = parsePrototypeTurnOutput(event.output);
  if (!parsed.ok) {
    // The notice's one line may quote the output, so it mentions nobody and stays one line.
    const errors = withoutMentions(parsed.errors.join("; ").replace(/\s+/g, " "));
    return refused(`its output broke the prototype turn's output contract (${errors})`);
  }
  const own = prototypeBranchFor(event.issue);
  if (event.branch !== own) return refused(`it built \`${event.branch}\`, which isn't #${event.issue}'s prototype branch, ${own}`);
  const { moved } = event.changes;
  if (moved !== undefined) {
    return refused(`${movedWhileItRan(own, moved)}, and the Kit only ever fast-forwards a prototype branch from the head its turn started on, so it pushed nothing`);
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
  // Commits that undo each other built nothing either. The turn's intro says why, if it gave a reason (#429).
  if (event.changes.net.length === 0) {
    const said = [
      `The prototype turn on #${event.issue} built nothing: its branch has no change of its own, so the Kit pushed nothing and there's nothing to look at. [The run](${event.runUrl}) has what the turn did.`,
      "",
      "**What the prototype turn said:**",
      "",
      withoutMentions(parsed.output.intro).trim(),
    ].join("\n");
    return { kind: "act", actions: [failed(said)] };
  }
  const push: Action = { kind: "push-prototype-branch", issue: event.issue };
  const { capture } = event;
  if (capture?.outcome === "failed" && NOT_SERVED.includes(capture.reason)) {
    // The branch is still worth a look: it holds what the agent wrote.
    const said = `The Kit pushed the variants the prototype turn wrote to [\`${event.branch}\`](${branchUrl(event)}), but ${CAPTURE_FAILED[capture.reason]}, and nothing to look at. [The run](${event.runUrl}) has the log.`;
    return { kind: "act", actions: [push, failed(said)] };
  }
  const roundPreview = previewOfRound(preview);
  const body = prototypeRound(round, parsed.output, event, operator, roundPreview);
  // A refused letter changes nothing on GitHub: the round lands as it would have, and the step summary says why its line advises none.
  const notes = refusedLetter(event.issue, parsed.output);
  if (roundPreview.kind !== "pending") return { kind: "act", actions: [push, comment(body)], ...notes };
  // The push job polls the preview once the round is posted, and links it there only once it answers.
  const { route } = event.request.request;
  return {
    kind: "act",
    actions: [
      push,
      { kind: "comment", issue: event.issue, body, key: ROUND_COMMENT.posted },
      { kind: "link-prototype-preview", issue: event.issue, round: ROUND_COMMENT, template: roundPreview.template, route },
    ],
    ...notes,
  };
}

/** The plan's note of an advised letter the output reader refused, as it isn't one of the round's variants'; nothing when it refused none. */
function refusedLetter(issue: number, { variants, refusedRecommended }: PrototypeRoundOutput): { notes?: string[] } {
  if (refusedRecommended === undefined) return {};
  const letters = variants.map(({ letter }) => letter);
  const named = letters.length === 1 ? letters.join("") : `${letters.slice(0, -1).join(", ")} or ${letters.at(-1)}`;
  return {
    notes: [
      `The prototype round on #${issue} advises no variant by letter: the prototype turn's recommended, ${refusedRecommended}, isn't one of its variants' letters (${named})`,
    ],
  };
}

/** Kit config's preview as a prototype round has it: none declared, one to link once it answers, or one only a PR can fill in. */
type RoundPreview = { readonly kind: "none" } | { readonly kind: "pending"; readonly template: string } | { readonly kind: "needs-pull-request" };

function previewOfRound(preview: PreviewConfig | null): RoundPreview {
  if (preview === null) return { kind: "none" };
  return previewNamesPullRequest(preview.url) ? { kind: "needs-pull-request" } : { kind: "pending", template: preview.url };
}

/** How the prototype branch moved while its turn ran: on from where the turn started, there when the turn cut it afresh, or gone. */
function movedWhileItRan(branch: string, { from, to }: NonNullable<BranchChanges["moved"]>): string {
  if (to === null) return `\`${branch}\` was deleted while it ran`;
  if (from === null) return `\`${branch}\` was pushed, at ${to.slice(0, 7)}, while it ran, though the turn cut it afresh`;
  return `\`${branch}\` moved from ${from.slice(0, 7)} to ${to.slice(0, 7)} while it ran`;
}

function sameRequest({ request: a, reply: replyA }: PrototypeRequestMarker, { request: b, reply: replyB }: PrototypeRequestMarker): boolean {
  return a.route === b.route && a.variants === b.variants && a.brief === b.brief && replyA === replyB;
}

/**
 * A prototype failure round: a round too, with the next round's marker, the
 * failure marker under it and the one @-mention, saying what stopped the
 * prototype. Its one question is the Kit's, and it recommends carrying on, so
 * that `yes` never spends another prototype turn's Sandbox time.
 */
function failureRound(round: number, operator: string, said: string): string {
  return withinCommentLimit(
    [
      designRoundMarker(round),
      PROTOTYPE_FAILURE_ROUND_MARKER,
      roundLineOf({
        v: ROUND_LINE_VERSION,
        kind: "prototype-failed",
        round,
        intro: said,
        questions: [{ question: CARRY_ON_QUESTION, recommendation: CARRY_ON }],
        otherAnswers: [TRY_AGAIN],
      }),
      `@${operator} **Design session, round ${round}: the prototype failed.** Reply with how you'd go on, or \`yes\` to take the recommendation.`,
      "",
      said,
      "",
      `**1. ${CARRY_ON_QUESTION}**`,
      `➡️ Recommended: ${CARRY_ON}`,
    ].join("\n"),
  );
}

/** A prototype failure round's one question, which the Kit writes. */
const CARRY_ON_QUESTION = "Carry on without a prototype, or try again?";

/** What the Kit recommends on a prototype failure round. */
const CARRY_ON = "Carry on without a prototype. Trying again spends another prototype turn's Sandbox time, and may fail the same way.";

/** The answer the Kit offers on a prototype failure round beside its recommendation. */
const TRY_AGAIN = "Try again";

/**
 * The prototype round: a round, so it opens with the next round's marker and
 * carries the session's one @-mention, with the prototype marker under it.
 * The agent's text mentions nobody. The Evidence page expires, so the round itself
 * describes each variant and links its component on the branch at the head
 * the push left, which outlives it.
 */
function prototypeRound(
  round: number,
  output: PrototypeRoundOutput,
  event: PrototypeRunFinished,
  operator: string,
  preview: RoundPreview,
): string {
  const intro = withoutMentions(output.intro);
  const variants = variantsOf(output, event);
  // On one line, so the round ends where the preview step looks (withVariantPreviews, src/kit/previewLink.ts).
  const recommendation = withoutMentions(output.recommendation.trim().replace(/\s*[\r\n]+\s*/g, " "));
  return withinCommentLimit(
    [
      designRoundMarker(round),
      PROTOTYPE_ROUND_MARKER,
      roundLineOf({
        v: ROUND_LINE_VERSION,
        kind: "prototype",
        round,
        intro,
        questions: [{ question: WHICH_VARIANT_QUESTION, recommendation }],
        route: event.request.request.route,
        ...(output.recommended === undefined ? {} : { recommended: output.recommended }),
        variants: variants.map(({ letter, summary, component }) => ({ letter, summary, component, preview: null })),
        captures: event.captures,
      }),
      `@${operator} **Design session, round ${round}: the prototype.** Reply with the variant you'd build, and any changes to it, or \`yes\` to take the recommendation.`,
      "",
      intro,
      "",
      `[The prototype branch](${branchUrl(event)}) · ${evidencePageLine(event)}`,
      "",
      ...variants.map(({ letter, summary, path, component }) => `- **${letter}.** ${summary} [${code(path)}](${component})`),
      "",
      ...(preview.kind === "none" ? [] : [previewLine(preview), ""]),
      WHICH_VARIANT,
      `➡️ Recommended: ${recommendation}`,
    ].join("\n"),
  );
}

/** A round that, with its hidden line, would pass GitHub's limit for a comment, posted without the line, as it would have been; one within it as it is. */
function withinCommentLimit(body: string): string {
  return body.length <= GITHUB_COMMENT_LIMIT ? body : withoutRoundLines(body);
}

/** The prototype round's one question, as its hidden line holds it. */
const WHICH_VARIANT_QUESTION = "Which variant?";

/** The prototype round's one question, which the Kit writes. */
export const WHICH_VARIANT = `**1. ${WHICH_VARIANT_QUESTION}**`;

/** What the round says of its preview until the push job has polled it and linked it (src/kit/previewLink.ts). */
export const PREVIEW_PENDING = "Each variant's preview is linked beside it once the preview deployment answers.";

/** A variant's line in the round, as the Kit writes it (variantLines), with the variant's letter. */
export const VARIANT_LINE = /^- \*\*([A-Z])\.\*\* /;

/** What the round says of the preview Kit config declares. */
function previewLine(preview: Exclude<RoundPreview, { kind: "none" }>): string {
  switch (preview.kind) {
    case "pending":
      return PREVIEW_PENDING;
    case "needs-pull-request":
      return "There's no preview for prototypes: Kit config's `preview.url` names the pull request, as `{pr}`, and a prototype has none.";
  }
}

/**
 * Where the variants can be seen: the Evidence page, which expires, or, when capture
 * failed after the build, why there's none. Either way the branch holds them.
 */
function evidencePageLine({ capture, evidencePage }: PrototypeRunFinished): string {
  if (capture === undefined || capture.outcome === "failed") {
    const why = capture === undefined ? "the prototype job passed out no capture result the push job could read" : `capture failed because ${CAPTURE_FAILED[capture.reason]}`;
    return `There's no Evidence page: ${why}. The branch holds the variants, and this comment is the prototype's record.`;
  }
  if (evidencePage === null) return "The Kit kept no Evidence page of the captures, so this comment is the prototype's record.";
  return `[The Evidence page](${evidencePage}) of each variant's screenshots and videos. The Evidence page expires in about 30 days, so this comment is the prototype's record.`;
}

/** Why a prototype's capture failed, in plain words, the prototype job having captured. */
const CAPTURE_FAILED = failureWords("the prototype job");

/** Each variant: its letter, its summary with no mention, its component's path, and its component's address on the branch at the pushed head. */
function variantsOf(
  { variants }: PrototypeRoundOutput,
  { repoUrl, headSha }: PrototypeRunFinished,
): { letter: string; summary: string; path: string; component: string }[] {
  return variants.map(({ letter, summary, component }) => ({
    letter,
    summary: withoutMentions(summary),
    path: component,
    component: `${repoUrl}/blob/${headSha}/${pathInUrl(component)}`,
  }));
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
    .map((segment) => withParensEscaped(encodeURIComponent(segment)))
    .join("/");
}
