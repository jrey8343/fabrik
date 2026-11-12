// The Digest's contract (ADR-0022): the Digest writer's reply, the checks on
// it, the comment Kit code renders from its fields, the hidden lines that
// comment and the no-Digest line open with, and the reading of them back.
// The Loop's rules (src/loop/digest.ts) land a Digest through it, and the
// read library is to read one through it, so this module imports no package
// and nothing that runs an agent or a job. Pure.
import type { DigestFacts, Round } from "./digestFacts.ts";
import { markerJson } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import { GITHUB_COMMENT_LIMIT } from "./roundLine.ts";

/** What a Digest comment's hidden first line opens with. */
export const DIGEST_MARKER = "<!-- fabrik:digest";

/** What a Digest comment's first line names. */
export interface DigestMark {
  /** The head the Digest is written as of, a full sha. */
  readonly head: string;
}

/** A Digest comment's hidden first line, such as `<!-- fabrik:digest {"head":"…"} -->`. */
export function digestMarker({ head }: DigestMark): string {
  return `${DIGEST_MARKER} ${markerJson({ head })} -->`;
}

/** The hidden line the Digest's folds sit under: everything from it down is the folds. */
export const DIGEST_FOLDS_MARKER = "<!-- fabrik:digest-folds -->";

/** What a no-Digest line's hidden first line opens with. */
export const NO_DIGEST_MARKER = "<!-- fabrik:no-digest";

/**
 * How an attempt at a Digest ended with none: the Digest writer's run failed,
 * ran past its time limit, or gave a reply Kit code refused; no Subscription
 * was free to run it; or its run never started.
 */
export const NO_DIGEST_HOWS = ["failed", "timed-out", "refused", "no-subscription", "never-started"] as const;
export type NoDigestHow = (typeof NO_DIGEST_HOWS)[number];

/** Each way, in words for the Operator. */
const HOW_IT_ENDED: Readonly<Record<NoDigestHow, string>> = {
  failed: "the Digest writer's run failed",
  "timed-out": "the Digest writer ran past its time limit",
  refused: "Kit code refused the Digest writer's reply",
  "no-subscription": "no Subscription was free to run the Digest writer",
  "never-started": "the Digest writer's run never started",
};

/** What a no-Digest line says: the head no Digest was written for, how the attempt ended, Kit code's reason for a refusal, and the run. */
export interface NoDigest {
  readonly head: string;
  readonly how: NoDigestHow;
  /** Kit code's reason, on a refusal. It may quote the writer's reply, so it loses its mentions. */
  readonly reason?: string;
  /** The Actions run of the attempt, when one ran. */
  readonly runUrl?: string;
}

/**
 * The no-Digest line: one Kit comment that says no Digest could be written
 * for a head and how, under its hidden line. It mentions nobody.
 */
export function noDigestLine({ head, how, reason, runUrl }: NoDigest): string {
  const why = reason === undefined || reason.trim() === "" ? "" : ` (${withoutMentions(reason.trim())})`;
  return [
    `${NO_DIGEST_MARKER} ${markerJson({ head, how })} -->`,
    `No Digest could be written for this head, \`${head.slice(0, 7)}\`: \`${how}\`, ${HOW_IT_ENDED[how]}${why}.`,
    ...(runUrl === undefined ? [] : ["", `[The run](${runUrl})`]),
  ].join("\n");
}

/** The JSON a comment's first line holds after `marker`, or null when its first line isn't that marker's. */
function firstLineOf(body: string, marker: string): Record<string, unknown> | null {
  const [first = ""] = body.split("\n");
  if (!first.startsWith(`${marker} `) || !first.endsWith(" -->")) return null;
  try {
    const value: unknown = JSON.parse(first.slice(marker.length + 1, -" -->".length));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The head a Digest comment's first line names, or null for any other comment. Only a comment the Fabrik App wrote is a Digest: the caller checks that. */
export function digestMarkIn(body: string): DigestMark | null {
  const head = firstLineOf(body, DIGEST_MARKER)?.["head"];
  return typeof head === "string" ? { head } : null;
}

/** The head and how a no-Digest line's first line names, or null for any other comment. */
export function noDigestIn(body: string): Pick<NoDigest, "head" | "how"> | null {
  const { head, how } = firstLineOf(body, NO_DIGEST_MARKER) ?? {};
  const known = NO_DIGEST_HOWS.find((one) => one === how);
  return typeof head === "string" && known !== undefined ? { head, how: known } : null;
}

/** Whether a comment is a Digest or a no-Digest line, by its first line. */
export function isDigestComment(body: string): boolean {
  return digestMarkIn(body) !== null || noDigestIn(body) !== null;
}

/**
 * The Digest writer's reply: the fields Kit code renders the Digest from.
 * The writer words them; Kit code lays them out.
 */
export interface DigestReply {
  /** What changes for the End user, in plain English. */
  readonly whatItDoes: string;
  /** How the pull request got to this head: Kit code's counts, worded, ending with Kit code's fact about the product code. */
  readonly howItGotHere: string;
  /** Which of the Follow-ups Kit code listed to show, by Kit code's ids for them (`f1`, `f2`, …). */
  readonly followUps: readonly string[];
  /** The first fold, as Markdown: how the change works, and the order to read it in. */
  readonly walkthrough: string;
  /** The second fold, as Markdown: what the Implementer decided that the Ticket did not settle, and what was left alone. */
  readonly decided: string;
  /** The one line under Kit code's table of the rounds, in the third fold. */
  readonly roundsLine: string;
}

export type DigestReplyResult = { readonly ok: true; readonly output: DigestReply } | { readonly ok: false; readonly errors: readonly string[] };

/** The reply's fields that are text, in the order a refusal names them. */
const TEXT_FIELDS = ["whatItDoes", "howItGotHere", "walkthrough", "decided", "roundsLine"] as const satisfies readonly (keyof DigestReply)[];

/** Whether a value is text with something in it. */
function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Checks an already-parsed value against the reply's shape, naming every
 * problem. The agent job and the push job both call it. Whether the
 * Follow-ups it names are ones Kit code listed is checked where the facts
 * are, in the push job (digestCommentOf).
 */
export function readDigestReply(value: unknown): DigestReplyResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, errors: ["The Digest writer's reply must be a JSON object"] };
  const fields = value as Record<string, unknown>;
  const { followUps } = fields;
  const named = Array.isArray(followUps) && followUps.every(isText);
  const errors = [
    ...TEXT_FIELDS.filter((field) => !isText(fields[field])).map((field) => `${field} must be non-empty text`),
    ...(named ? [] : ["followUps must be a list of Follow-up ids"]),
  ];
  if (errors.length > 0 || !named) return { ok: false, errors };
  const [whatItDoes, howItGotHere, walkthrough, decided, roundsLine] = TEXT_FIELDS.map((field) => fields[field] as string) as [string, string, string, string, string];
  return { ok: true, output: { whatItDoes, howItGotHere, followUps: followUps.map((id) => id.trim()), walkthrough, decided, roundsLine } };
}

/** Parses the text the Digest writer emitted, then checks it. */
export function parseDigestReply(text: string): DigestReplyResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`The Digest writer's reply is not valid JSON: ${(error as Error).message}`] };
  }
  return readDigestReply(value);
}

/**
 * Everything Kit code hands the contract beyond the writer's reply, which no
 * agent wrote: where the Digest goes and what it is written as of.
 */
export interface DigestGiven {
  /** The Product repo's web address, such as `https://github.com/acme/shop`. */
  readonly repoUrl: string;
  readonly pullRequest: number;
  /** The head the Digest is written as of, a full sha. */
  readonly headSha: string;
  /** The Actions run that wrote it, which the Digest ends by linking. */
  readonly runUrl: string;
  /** Kit code's facts, from the push job's own read of the pull request's thread: the Follow-ups a reply may name, and the rounds. */
  readonly facts: DigestFacts;
}

/** A Digest's comment, or why Kit code refuses the reply, as a clause with no full stop. */
export type DigestComment = { readonly ok: true; readonly body: string } | { readonly ok: false; readonly refused: string };

/** A fold: a `<details>` block GitHub renders collapsed under its title. */
function fold(title: string, markdown: string): string[] {
  return ["<details>", `<summary>${title}</summary>`, "", markdown, "", "</details>"];
}

/** Who a round was, as the rounds table says it. */
const WHO: Readonly<Record<Round["who"], string>> = {
  implementer: "The Implementer",
  reviewer: "The Reviewer",
  "required-checks": "Red Required checks",
  kit: "The Kit",
  operator: "The Operator",
};

/** What the Kit gave a Verdict of its own for. */
const KIT_VERDICT_FOR: Readonly<Record<NonNullable<Round["why"]>, string>> = {
  "retry-changed-nothing": "a Retry that changed nothing",
  "broken-run": "a Broken run",
};

/** What a round was, as the rounds table says it. A Retry's row adds its number. */
const WHAT: Readonly<Record<Round["what"], string>> = {
  "first-run": "The first run",
  retry: "Retry",
  "request-changes-run": "A Request-changes run",
  "conflict-only-run": "A conflict-only run",
  rebase: "A rebase onto `main`",
  pass: "Pass",
  "execution-flaw": "Execution flaw",
  "design-flaw": "Design flaw",
  "request-changes": "Request changes",
  "infrastructure-failure": "An Infrastructure failure",
  "broken-run": "A Broken run",
};

/** A Verdict's effect on the code, as the rounds table says it. */
const EFFECT: Readonly<Record<NonNullable<Round["effect"]>, string>> = {
  "product-code": "Product code",
  "tests-only": "Tests only",
  none: "None",
  "not-known": "Not known",
};

/**
 * Kit code's table of the rounds, oldest first: who, what, and each
 * Verdict's effect on the code against the Verdict before it, left blank on
 * the first Verdict and on every row that is no Verdict. Every cell is Kit
 * code's own words: nothing an agent wrote is in it.
 */
function roundsTable(rounds: readonly Round[]): string[] {
  return [
    "| Who | What | Effect on the code |",
    "| --- | --- | --- |",
    ...rounds.map(({ who, what, retry, why, effect }) => {
      const by = why === undefined ? WHO[who] : `${WHO[who]}, for ${KIT_VERDICT_FOR[why]}`;
      const was = retry === undefined ? WHAT[what] : `${WHAT[what]} ${retry}`;
      return `| ${by} | ${was} |${effect === null ? "" : ` ${EFFECT[effect]}`} |`;
    }),
  ];
}

/**
 * The Follow-ups section: each Follow-up the reply names, once, in the order
 * Kit code listed them, as one line with its title and its Open as issue
 * link; or that none is named.
 */
function followUpLines(shown: readonly string[], listed: DigestFacts["followUps"]): string[] {
  const lines = listed.filter(({ id }) => shown.includes(id)).map(({ title, url }) => `- ${withoutMentions(title)}: [Open as issue](${url})`);
  return lines.length === 0 ? ["None named."] : lines;
}

/**
 * The Digest's comment, rendered from the writer's fields and Kit code's
 * facts with only what GitHub renders in a pull request: its hidden first
 * line naming the head, an opening line naming the pull request and that
 * head, What it does, How it got here and the Follow-ups the reply names,
 * then, under the folds line, the folds, and last a link to the run. Every
 * mention is taken out, as a Verdict's findings lose theirs.
 *
 * Refused, never cut: a reply naming a Follow-up Kit code did not list, and
 * a comment too long for GitHub.
 */
export function digestCommentOf(reply: DigestReply, given: DigestGiven): DigestComment {
  const text = (field: string): string => withoutMentions(field.trim());
  const { repoUrl, pullRequest, headSha, runUrl, facts } = given;
  const unlisted = [...new Set(reply.followUps)].filter((id) => !facts.followUps.some((listed) => listed.id === id));
  if (unlisted.length > 0) {
    const ids = unlisted.map((id) => `\`${id}\``).join(", ");
    return { ok: false, refused: `the reply names ${unlisted.length === 1 ? "a Follow-up" : "Follow-ups"} Kit code did not list: ${ids}` };
  }
  const body = [
    digestMarker({ head: headSha }),
    `**Digest** of #${pullRequest}, written as of [\`${headSha.slice(0, 7)}\`](${repoUrl}/pull/${pullRequest}/commits/${headSha}).`,
    "",
    "### What it does",
    "",
    text(reply.whatItDoes),
    "",
    "### How it got here",
    "",
    text(reply.howItGotHere),
    "",
    "### Follow-ups",
    "",
    ...followUpLines(reply.followUps, facts.followUps),
    "",
    DIGEST_FOLDS_MARKER,
    ...fold("Walk me through it", text(reply.walkthrough)),
    "",
    ...fold("Decided without you, and left alone", text(reply.decided)),
    "",
    // Kit code's table, then the writer's one closing line, and nothing else.
    ...fold("The rounds", [...roundsTable(facts.rounds), "", text(reply.roundsLine).replace(/\s+/g, " ")].join("\n")),
    "",
    `[The run](${runUrl})`,
  ].join("\n");
  if (body.length > GITHUB_COMMENT_LIMIT) {
    return { ok: false, refused: `the Digest would be ${body.length} characters, over GitHub's limit of ${GITHUB_COMMENT_LIMIT} for a comment` };
  }
  return { ok: true, body };
}
