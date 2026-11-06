// Landing a Design session's prototype turn (#155): when the prototype job
// ends, the push job pushes the issue's prototype branch and posts the
// prototype round, whose one question, "Which variant?", the Kit writes. A
// prototype round is a round of the same session: it never ends it, and the
// Operator's reply to it starts an ordinary turn.
import { type CaptureFailure, code, type PreviewLink } from "../evidence/uiEvidence.ts";
import { type PreviewConfig, previewNamesPullRequest } from "../kit/config.ts";
import { checkTrustRoot } from "../guard/trust-root.ts";
import { turnStartFrom, whileInSession } from "./design.ts";
import { parsePrototypeTurnOutput, prototypeBranchFor, type PrototypeRoundOutput } from "./designOutput.ts";
import {
  DESIGN_ROUND_MARKER,
  designRoundMarker,
  PROTOTYPE_FAILURE_ROUND_MARKER,
  PROTOTYPE_ROUND_MARKER,
  type PrototypeRequestMarker,
} from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import type { Action, IssueContext, LoopEvent, Plan, PostedComment, StartingComment } from "./types.ts";

type PrototypeRunFinished = Extract<LoopEvent, { kind: "prototype-run-finished" }>;

/** The capture failures that leave nothing to look at: the variants were never served. */
const NOT_SERVED: readonly CaptureFailure[] = ["build-failed", "server-did-not-start"];

/** The prototype round, as the plan posts it for its preview to be linked in. */
const ROUND: PostedComment = { posted: "prototype-round" };

/**
 * The push job's decision on a prototype turn's branch and round. `found` is
 * what the snapshot found of the Operator's reply that approved the
 * prototype: like any Design-session turn, one whose reply was deleted posts
 * nothing. `preview` is Kit config's, whose link the round waits on.
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
  const parsed = parsePrototypeTurnOutput(event.output);
  if (!parsed.ok) {
    return {
      kind: "fail",
      failure: "infrastructure",
      reason: `The prototype turn on #${event.issue} emitted output that breaks its contract: ${parsed.errors.join("; ")}`,
    };
  }
  const own = prototypeBranchFor(event.issue);
  if (event.branch !== own) {
    return { kind: "fail", failure: "infrastructure", reason: `\`${event.branch}\` isn't #${event.issue}'s prototype branch, ${own}` };
  }
  const notNow = whileInSession(event.issue, issue);
  if (notNow !== null) return notNow;
  // The push job reads only the Fabrik App's own requests, so a look-alike another bot posted, which
  // the Kit job took for the App's, isn't pending here; nor is one a round has answered since.
  if (issue.pendingPrototype === null || !sameRequest(issue.pendingPrototype, event.request)) {
    return {
      kind: "nothing",
      reason: `#${event.issue}'s Design session isn't waiting on the prototype request this turn built, so its result is stale`,
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
  const linked = previewOfRound(preview);
  const body = prototypeRound(round, parsed.output, event, operator, linked);
  if (linked.kind !== "pending") return { kind: "act", actions: [push, comment(body)] };
  // The push job polls the preview once the round is posted, and links it there only once it answers.
  return {
    kind: "act",
    actions: [
      push,
      { kind: "comment", issue: event.issue, body, key: ROUND.posted },
      { kind: "link-prototype-preview", issue: event.issue, round: ROUND, template: linked.template, route: event.request.request.route },
    ],
  };
}

/** Kit config's preview as a prototype round has it: none declared, one to link once it answers, or one only a PR can fill in. */
type RoundPreview = { readonly kind: "none" } | { readonly kind: "pending"; readonly template: string } | { readonly kind: "needs-pull-request" };

function previewOfRound(preview: PreviewConfig | null): RoundPreview {
  if (preview === null) return { kind: "none" };
  return previewNamesPullRequest(preview.url) ? { kind: "needs-pull-request" } : { kind: "pending", template: preview.url };
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
    "**1. Which variant?**",
    `➡️ Recommended: ${withoutMentions(output.recommendation)}`,
  ].join("\n");
}

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
 * never the agent's.
 */
export function withVariantPreviews(body: string, preview: Extract<PreviewLink, { kind: "linked" | "never-answered" }>): string | null {
  // An Operator's edit on GitHub may end its lines in \r\n.
  const lines = body.split("\n").map((line) => (line.endsWith("\r") ? { text: line.slice(0, -1), end: "\r" } : { text: line, end: "" }));
  if (!DESIGN_ROUND_MARKER.test(body) || lines[1]?.text.trim() !== PROTOTYPE_ROUND_MARKER) return null;
  // The Kit writes it under the variants, one blank line between.
  const at = lines.findIndex(({ text }, i) => text.trim() === PREVIEW_PENDING && lines[i - 1]?.text.trim() === "" && VARIANT_LINE.test(lines[i - 2]?.text ?? ""));
  if (at === -1) return null;
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
  return url.href.replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
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
