// Landing a Design session's prototype turn (#155): when the prototype job
// ends, the push job pushes the issue's prototype branch and posts the
// prototype round, whose one question, "Which variant?", the Kit writes. A
// prototype round is a round of the same session: it never ends it, and the
// Operator's reply to it starts an ordinary turn.
import { type CaptureFailure, code, failureWords, type PreviewLink } from "../evidence/uiEvidence.ts";
import { type PreviewConfig, previewNamesPullRequest } from "../kit/config.ts";
import { checkTrustRoot } from "../guard/trust-root.ts";
import { turnStartFrom, whileInSession } from "./design.ts";
import { prototypeTurnRefused } from "./failures.ts";
import { parsePrototypeTurnOutput, prototypeBranchFor, type PrototypeRoundOutput } from "./designOutput.ts";
import {
  DESIGN_ROUND_MARKER,
  designRoundMarker,
  PROTOTYPE_FAILURE_ROUND_MARKER,
  PROTOTYPE_ROUND_MARKER,
  type PrototypeRequestMarker,
} from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
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
  const start = turnStartFrom(event.request.reply ?? undefined, found);
  if (start.kind === "unchecked-reply") {
    return {
      kind: "fail",
      failure: "infrastructure",
      reason: `The prototype turn on #${event.issue} answers a reply (comment ${start.comment}) the push job didn't check is still there`,
    };
  }
  if (start.kind === "reply" && !start.comment.exists) {
    return {
      kind: "nothing",
      reason: `The Operator's reply that approved the prototype on #${event.issue} (comment ${start.comment.id}) was deleted, so the prototype turn posts nothing`,
    };
  }
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
  // Commits that undo each other built nothing either.
  if (event.changes.net.length === 0) {
    const said = `The prototype turn on #${event.issue} built nothing: its branch has no change of its own, so the Kit pushed nothing and there's nothing to look at. [The run](${event.runUrl}) has what the turn did.`;
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
  if (roundPreview.kind !== "pending") return { kind: "act", actions: [push, comment(body)] };
  // The push job polls the preview once the round is posted, and links it there only once it answers.
  const { route } = event.request.request;
  return {
    kind: "act",
    actions: [
      push,
      { kind: "comment", issue: event.issue, body, key: ROUND_COMMENT.posted },
      { kind: "link-prototype-preview", issue: event.issue, round: ROUND_COMMENT, template: roundPreview.template, route },
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
function prototypeRound(
  round: number,
  output: PrototypeRoundOutput,
  event: PrototypeRunFinished,
  operator: string,
  preview: RoundPreview,
): string {
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
    ...(preview.kind === "none" ? [] : [previewLine(preview), ""]),
    WHICH_VARIANT,
    // On one line, so the round ends where the preview step looks (withVariantPreviews).
    `➡️ Recommended: ${withoutMentions(output.recommendation.trim().replace(/\s*[\r\n]+\s*/g, " "))}`,
  ].join("\n");
}

/** The prototype round's one question, which the Kit writes. */
const WHICH_VARIANT = "**1. Which variant?**";

/** What the round says of its preview until the push job has polled it. */
const PREVIEW_PENDING = "Each variant's preview is linked beside it once the preview deployment answers.";

/** A variant's line in the round, as the Kit writes it, with the variant's letter. */
const VARIANT_LINE = /^- \*\*([A-Z])\.\*\* /;

/**
 * The prototype round with what came of its preview, once the push job has
 * polled it (src/kit/previewLink.ts): each variant's line links the route's
 * page with `?variant=` and the variant's letter, and the line saying the
 * previews are linked once it answers goes; or that line says it never
 * answered. Null when the body isn't a prototype round still waiting on its
 * preview. Every URL is the Kit's, from Kit config and the approved route,
 * never the agent's, and it goes only where the Kit's own lines are, which
 * nothing the agent wrote can stand in for.
 */
export function withVariantPreviews(body: string, preview: Extract<PreviewLink, { kind: "linked" | "never-answered" }>): string | null {
  // An Operator's edit on GitHub may end its lines in \r\n.
  const lines = body.split("\n").map((line) => (line.endsWith("\r") ? { text: line.slice(0, -1), end: "\r" } : { text: line, end: "" }));
  if (!DESIGN_ROUND_MARKER.test(body) || lines[1]?.text.trim() !== PROTOTYPE_ROUND_MARKER) return null;
  // Only where the Kit writes it: the round's fourth line from the end, over its question and the one line of
  // its recommendation, and under the variants, a blank line between each. The agent's intro is above the
  // variants and its recommendation below them, so a copy of this line, or of a variant's, in either is never taken.
  const at = lines.length - 4;
  const kitWroteIt =
    lines[at]?.text.trim() === PREVIEW_PENDING &&
    lines[at + 1]?.text.trim() === "" &&
    lines[at + 2]?.text.trim() === WHICH_VARIANT &&
    lines[at - 1]?.text.trim() === "" &&
    VARIANT_LINE.test(lines[at - 2]?.text ?? "");
  if (!kitWroteIt) return null;
  if (preview.kind === "never-answered") {
    lines[at] = { ...lines[at]!, text: `No preview links: the preview at ${code(preview.url)} never answered.` };
  } else {
    for (let i = at - 2; i >= 0; i--) {
      const line = lines[i]!;
      const letter = VARIANT_LINE.exec(line.text)?.[1];
      if (letter === undefined) break;
      lines[i] = { ...line, text: `${line.text} · [Preview](${variantPreviewUrl(preview.url, letter)})` };
    }
    // The pending line, and the blank line above it.
    lines.splice(at - 1, 2);
  }
  return lines.map(({ text, end }) => `${text}${end}`).join("\n");
}

/** The route's page showing one variant: `?variant=` and its letter, with a `(` or `)` escaped, so it can't end the link early. */
function variantPreviewUrl(page: string, letter: string): string {
  const url = new URL(page);
  url.searchParams.set("variant", letter);
  return withParensEscaped(url.href);
}

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
 * Where the variants can be seen: the gallery, which expires, or, when capture
 * failed after the build, why there's none. Either way the branch holds them.
 */
function galleryLine({ capture, gallery }: PrototypeRunFinished): string {
  if (capture === undefined || capture.outcome === "failed") {
    const why = capture === undefined ? "the prototype job passed out no capture result the push job could read" : `capture failed because ${CAPTURE_FAILED[capture.reason]}`;
    return `There's no gallery: ${why}. The branch holds the variants, and this comment is the prototype's record.`;
  }
  if (gallery === null) return "The Kit kept no gallery of the captures, so this comment is the prototype's record.";
  return `[The gallery](${gallery}) of each variant's screenshots and videos. The gallery expires in about 30 days, so this comment is the prototype's record.`;
}

/** Why a prototype's capture failed, in plain words, the prototype job having captured. */
const CAPTURE_FAILED = failureWords("the prototype job");

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
    .map((segment) => withParensEscaped(encodeURIComponent(segment)))
    .join("/");
}

/** The URL text with each `(` and `)` percent-encoded, which a URL leaves as they are, but which could end a Markdown link. */
function withParensEscaped(url: string): string {
  return url.replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
