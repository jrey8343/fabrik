// The Digest's contract (ADR-0022): the Digest writer's reply, the checks on
// it, the comment Kit code renders from its fields, the hidden lines that
// comment and the no-Digest line open with, and the reading of them back.
// The Loop's rules (src/loop/digest.ts) land a Digest through it, and the
// read library is to read one through it, so this module imports no package
// and nothing that runs an agent or a job. Pure.
import type { DigestAsk, DigestFacts, Round } from "./digestFacts.ts";
import { MAX_PLACES, type NamedPlace, PLACE_KINDS } from "./digestPlaces.ts";
import { markerJson } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import { GITHUB_COMMENT_LIMIT } from "./roundLine.ts";

/** What a Digest comment's hidden first line opens with. */
export const DIGEST_MARKER = "<!-- fabrik:digest";

/** What a Digest comment's first line names. */
export interface DigestMark {
  /** The head the Digest is written as of, a full sha. */
  readonly head: string;
  /**
   * Kit code's ids of the asks the Digest answered (src/loop/digestFacts.ts):
   * the Operator's Request changes and their line comments, never a
   * criterion, in the order Kit code listed them. They are the same at every
   * head, so a later list can be compared with this one.
   */
  readonly asks: readonly string[];
}

/** A Digest comment's hidden first line, such as `<!-- fabrik:digest {"head":"…","asks":["review-8"]} -->`. */
export function digestMarker({ head, asks }: DigestMark): string {
  return `${DIGEST_MARKER} ${markerJson({ head, asks })} -->`;
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

/**
 * What a Digest comment's first line names, or null for any other comment:
 * its head, and the asks it answered, none when the line records none. Only
 * a comment the Fabrik App wrote is a Digest: the caller checks that.
 */
export function digestMarkIn(body: string): DigestMark | null {
  const { head, asks } = firstLineOf(body, DIGEST_MARKER) ?? {};
  if (typeof head !== "string") return null;
  return { head, asks: Array.isArray(asks) && asks.every((id) => typeof id === "string") ? asks : [] };
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

/** How the writer answers an ask: the thing asked for is in the head, is not, or the writer could not tell. */
export const ASK_ANSWERS = ["in-head", "not-in-head", "could-not-tell"] as const;
export type AskAnswer = (typeof ASK_ANSWERS)[number];

/** How the writer checked an ask: by a test, an end-to-end test, reading the code, a search of it, or Required checks. */
export const CHECKED_BY = ["test", "end-to-end-test", "reading", "search", "required-checks"] as const;
export type CheckedBy = (typeof CHECKED_BY)[number];

/**
 * The kinds of item under Needs your eyes, in the order a Digest shows them:
 * something the Operator asked for that is not in the head, what only the
 * Operator can judge, and what was not proven. There is no fourth.
 */
export const ITEM_KINDS = ["asked-not-here", "yours-to-judge", "not-proven"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** The most items Needs your eyes holds. */
export const MAX_ITEMS = 4;

/** The most words a suggested request may run to; a longer one is dropped. */
export const MAX_SUGGESTED_REQUEST_WORDS = 40;

/** The most words Needs your eyes, What it does and How it got here may come to between them; a Digest over it is refused. */
export const MAX_TOP_WORDS = 180;

/** The writer's own id for a criterion of the Ticket's that it adds to the asks: `c1`, `c2`, … */
const CRITERION_ID = /^c[1-9]\d*$/;

/** The writer's answer to one ask: one of Kit code's, by its id, or a criterion of the Ticket's the writer adds under an id of its own. */
export interface DigestAnswer {
  /** Kit code's id for the ask (src/loop/digestFacts.ts), or the writer's own for a criterion: `c1`, `c2`, … */
  readonly id: string;
  /** On a criterion only: the criterion, as any Request changes amended it, in one line. */
  readonly criterion?: string;
  readonly answer: AskAnswer;
  /** Where the writer looked. */
  readonly where: string;
  readonly checkedBy: CheckedBy;
}

/** One item under Needs your eyes. */
export interface DigestItem {
  readonly kind: ItemKind;
  /** The claim, which the Digest shows in bold. */
  readonly claim: string;
  /** One or two sentences on what is true at this head and why it is the Operator's to judge. */
  readonly sentence: string;
  /** On an asked-not-here item: the ids of the asks it is about. Empty on every other kind. */
  readonly asks: readonly string[];
  /**
   * The lines the item is about: none, or up to three places in the head.
   * The item points at them and never quotes them. Kit code checks each
   * against the head before the Digest lands (src/loop/digestPlaces.ts).
   */
  readonly places: readonly NamedPlace[];
  /**
   * A request the Operator could send as it stands: an instruction that
   * would get the thing built or shown. Never on a yours-to-judge item. It
   * is not rendered on GitHub.
   */
  readonly suggestedRequest: string | null;
}

/**
 * The Digest writer's reply: the fields Kit code renders the Digest from.
 * The writer words them; Kit code lays them out.
 */
export interface DigestReply {
  /** The writer's answer to every ask: each of Kit code's, and each criterion of the Ticket's, which the writer adds. */
  readonly asks: readonly DigestAnswer[];
  /** Needs your eyes: at most four items. None is the "Nothing" case. */
  readonly items: readonly DigestItem[];
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` when it is one of `known`, or an error under `where` naming them. */
function oneOf<T extends string>(value: unknown, known: readonly T[], where: string, errors: string[]): T | undefined {
  const found = known.find((one) => one === value);
  if (found === undefined) errors.push(`${where} must be one of ${known.join(", ")}, not ${JSON.stringify(value)}`);
  return found;
}

/** One answer of the reply's `asks`, or null with what is wrong with it added to `errors`. */
function readAnswer(value: unknown, where: string, errors: string[]): DigestAnswer | null {
  if (!isObject(value)) {
    errors.push(`${where} must be an object`);
    return null;
  }
  const errorsBefore = errors.length;
  const { id, criterion, where: looked } = value;
  if (!isText(id)) errors.push(`${where}.id must be non-empty text`);
  // A criterion is the writer's own to state: Kit code holds no list of them to look its id up in.
  const ofCriterion = isText(id) && CRITERION_ID.test(id.trim());
  if (ofCriterion && !isText(criterion)) errors.push(`${where}.criterion must be non-empty text, the criterion in one line`);
  const answer = oneOf(value["answer"], ASK_ANSWERS, `${where}.answer`, errors);
  if (!isText(looked)) errors.push(`${where}.where must be non-empty text`);
  const checkedBy = oneOf(value["checkedBy"], CHECKED_BY, `${where}.checkedBy`, errors);
  if (errors.length > errorsBefore || answer === undefined || checkedBy === undefined) return null;
  return { id: (id as string).trim(), ...(ofCriterion ? { criterion: criterion as string } : {}), answer, where: looked as string, checkedBy };
}

/** One place of an item's `places`, or null with what is wrong with it added to `errors`. A line number that is wrong is no broken shape: the place is dropped when the Digest lands. */
function readPlace(value: unknown, where: string, errors: string[]): NamedPlace | null {
  if (!isObject(value)) {
    errors.push(`${where} must be an object`);
    return null;
  }
  const errorsBefore = errors.length;
  const { path, start, end } = value;
  if (!isText(path)) errors.push(`${where}.path must be non-empty text`);
  if (!Number.isInteger(start)) errors.push(`${where}.start must be a whole number`);
  if (!Number.isInteger(end)) errors.push(`${where}.end must be a whole number`);
  const as = oneOf(value["as"], PLACE_KINDS, `${where}.as`, errors);
  if (errors.length > errorsBefore || as === undefined) return null;
  return { path: (path as string).trim(), start: start as number, end: end as number, as };
}

/** An item's `places`, with what is wrong with them added to `errors`: a list of at most three. */
function readPlaces(value: unknown, where: string, errors: string[]): NamedPlace[] {
  if (!Array.isArray(value)) {
    errors.push(`${where} must be a list of at most ${MAX_PLACES} places`);
    return [];
  }
  if (value.length > MAX_PLACES) errors.push(`${where} must be a list of at most ${MAX_PLACES} places, not ${value.length}`);
  return value.map((place, index) => readPlace(place, `${where}[${index}]`, errors)).filter((place) => place !== null);
}

/** One item of the reply's `items`, or null with what is wrong with it added to `errors`. */
function readItem(value: unknown, where: string, errors: string[]): DigestItem | null {
  if (!isObject(value)) {
    errors.push(`${where} must be an object`);
    return null;
  }
  const errorsBefore = errors.length;
  const { claim, sentence, asks, suggestedRequest } = value;
  const kind = oneOf(value["kind"], ITEM_KINDS, `${where}.kind`, errors);
  if (!isText(claim)) errors.push(`${where}.claim must be non-empty text`);
  if (!isText(sentence)) errors.push(`${where}.sentence must be non-empty text`);
  if (!Array.isArray(asks) || !asks.every(isText)) errors.push(`${where}.asks must be a list of ask ids`);
  const places = readPlaces(value["places"], `${where}.places`, errors);
  if (suggestedRequest !== null && typeof suggestedRequest !== "string") errors.push(`${where}.suggestedRequest must be text or null`);
  if (errors.length > errorsBefore || kind === undefined) return null;
  return {
    kind,
    claim: claim as string,
    sentence: sentence as string,
    asks: (asks as string[]).map((id) => id.trim()),
    places,
    suggestedRequest: isText(suggestedRequest) ? suggestedRequest : null,
  };
}

/** The ids `ids` holds more than once, each named once, in the order first repeated. */
function repeatedIn(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
}

/** Ids as a refusal names them. */
function named(ids: readonly string[]): string {
  return ids.map((id) => `\`${id}\``).join(", ");
}

/**
 * Checks an already-parsed value against the reply's shape, naming every
 * problem. The agent job and the push job both call it. What takes Kit
 * code's facts to check is checked where they are, in the push job
 * (digestCommentOf): that every ask of Kit code's is answered, that the
 * items cover the asks not in the head, and that the Follow-ups named are
 * ones Kit code listed.
 */
export function readDigestReply(value: unknown): DigestReplyResult {
  if (!isObject(value)) return { ok: false, errors: ["The Digest writer's reply must be a JSON object"] };
  const fields = value;
  const errors: string[] = [];
  const { asks, items, followUps } = fields;
  if (!Array.isArray(asks)) errors.push("asks must be a list of answers");
  const answers = (Array.isArray(asks) ? asks : []).map((answer, index) => readAnswer(answer, `asks[${index}]`, errors)).filter((answer) => answer !== null);
  const twice = repeatedIn(answers.map(({ id }) => id));
  if (twice.length > 0) errors.push(`asks uses an id twice: ${named(twice)}`);
  if (!Array.isArray(items)) errors.push(`items must be a list of at most ${MAX_ITEMS} items`);
  else if (items.length > MAX_ITEMS) errors.push(`items must be a list of at most ${MAX_ITEMS} items, not ${items.length}`);
  const read = (Array.isArray(items) ? items : []).map((item, index) => readItem(item, `items[${index}]`, errors)).filter((item) => item !== null);
  errors.push(...TEXT_FIELDS.filter((field) => !isText(fields[field])).map((field) => `${field} must be non-empty text`));
  const shown = Array.isArray(followUps) && followUps.every(isText);
  if (!shown) errors.push("followUps must be a list of Follow-up ids");
  if (errors.length > 0 || !shown) return { ok: false, errors };
  const [whatItDoes, howItGotHere, walkthrough, decided, roundsLine] = TEXT_FIELDS.map((field) => fields[field] as string) as [string, string, string, string, string];
  return { ok: true, output: { asks: answers, items: read, whatItDoes, howItGotHere, followUps: followUps.map((id) => id.trim()), walkthrough, decided, roundsLine } };
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
  /** Kit code's facts, from the push job's own read of the pull request's thread: the asks a reply must answer, the Follow-ups it may name, and the rounds. */
  readonly facts: DigestFacts;
}

/** A Digest's comment, or why Kit code refuses the reply: each reason a clause with no full stop, with "; " between two. */
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

/** The writer's plain text on one line, with no mention in it. */
function oneLine(words: string): string {
  return withoutMentions(words.trim().replace(/\s+/g, " "));
}

/** The writer's words as a cell of one of Kit code's tables: one line, with no mention, and no pipe that would end the cell. */
function cell(words: string): string {
  return oneLine(words).replace(/\|/g, "\\|");
}

/**
 * Needs your eyes: each item as its bold claim and its sentence, in the
 * order given, or "Nothing." when there is none. An item's suggested request
 * is not rendered: it is for the Console, which reads it as data.
 */
function needsYourEyes(items: readonly DigestItem[]): string[] {
  return items.length === 0 ? ["Nothing."] : items.map(({ claim, sentence }) => `- **${oneLine(claim)}** ${oneLine(sentence)}`);
}

/** Each answer, as the criteria table says it. One that is not "in the head" is marked, in bold. */
const ANSWERED: Readonly<Record<AskAnswer, string>> = {
  "in-head": "In the head",
  "not-in-head": "**Not in the head**",
  "could-not-tell": "**Could not tell**",
};

/** How an ask was checked, as the criteria table says it. */
const CHECKED: Readonly<Record<CheckedBy, string>> = {
  test: "A test",
  "end-to-end-test": "An end-to-end test",
  reading: "Reading",
  search: "A search",
  "required-checks": "Required checks",
};

/** An ask of the Operator's, as the criteria table names it to the Operator: a link to it, and for a line comment where it is. */
function askedFor({ what, url, path, line }: DigestAsk): string {
  if (what === "request-changes") return `Your [Request changes](${url})`;
  const on = path === undefined ? "" : ` on \`${cell(path)}\`${typeof line === "number" ? `, line ${line}` : ""}`;
  return `Your [line comment](${url})${on}`;
}

/**
 * Kit code's table of every ask: the Operator's, in the order Kit code
 * listed them, then the criteria the writer added, in the writer's order.
 * Each has its answer, how it was checked and where the writer looked. What
 * was asked is Kit code's own words for one of the Operator's asks, and the
 * writer's one line for a criterion.
 */
function criteriaTable(answers: readonly DigestAnswer[], asks: readonly DigestAsk[]): string[] {
  const row = (asked: string, { answer, checkedBy, where }: DigestAnswer): string => `| ${asked} | ${ANSWERED[answer]} | ${CHECKED[checkedBy]} | ${cell(where)} |`;
  const rows = [
    ...asks.flatMap((ask) => answers.filter(({ id }) => id === ask.id).map((answer) => row(askedFor(ask), answer))),
    ...answers.filter(({ id }) => !asks.some((ask) => ask.id === id)).map((answer) => row(`Criterion: ${cell(answer.criterion ?? "")}`, answer)),
  ];
  if (rows.length === 0) return ["No ask was listed: the Operator requested no changes, and the Digest writer named no criterion."];
  return ["| Asked for | Answer | How it was checked | Where the writer looked |", "| --- | --- | --- | --- |", ...rows];
}

/**
 * Why Kit code refuses a reply over its answers, each reason a clause, or
 * none: an ask of Kit code's it leaves unanswered, and an answer under an id
 * that is neither one of Kit code's nor a criterion's. A criterion is the
 * writer's own to add, so Kit code cannot tell that one was left out.
 */
function answersRefused(answers: readonly DigestAnswer[], asks: readonly DigestAsk[]): string[] {
  const unanswered = asks.filter((ask) => !answers.some(({ id }) => id === ask.id)).map(({ id }) => id);
  const unknown = answers.filter(({ id }) => !CRITERION_ID.test(id) && !asks.some((ask) => ask.id === id)).map(({ id }) => id);
  return [
    ...(unanswered.length === 0 ? [] : [`the reply left ${unanswered.length === 1 ? "an ask" : "asks"} unanswered: ${named(unanswered)}`]),
    ...(unknown.length === 0 ? [] : [`the reply answers under an id that is neither an ask Kit code listed nor a criterion's: ${named(unknown)}`]),
  ];
}

/** Each kind of item, as a refusal names it. */
const KIND_SAID: Readonly<Record<ItemKind, string>> = {
  "asked-not-here": "asked for and not here",
  "yours-to-judge": "yours to judge",
  "not-proven": "not proven",
};

/**
 * Why Kit code refuses a reply over its items, each reason a clause, or
 * none. The items must cover the answers: every ask answered "not in the
 * head" or "could not tell", a criterion's included, is named by an
 * asked-for-and-not-here item. Such an item names at least one ask, each one
 * answered and none answered "in the head"; an item of another kind names
 * none. An item is named by its place in the reply.
 */
function itemsRefused(items: readonly DigestItem[], answers: readonly DigestAnswer[]): string[] {
  const asks = (ids: readonly string[]): string => `${ids.length === 1 ? "an ask" : "asks"}`;
  const covered = new Set(items.flatMap((item) => (item.kind === "asked-not-here" ? item.asks : [])));
  const uncovered = answers.filter(({ id, answer }) => answer !== "in-head" && !covered.has(id)).map(({ id }) => id);
  return [
    ...(uncovered.length === 0 ? [] : [`no asked-for-and-not-here item names ${asks(uncovered)} answered not in the head or could not tell: ${named(uncovered)}`]),
    ...items.flatMap((item, index) => {
      const said = `item ${index + 1}, ${KIND_SAID[item.kind]},`;
      const ids = [...new Set(item.asks)];
      if (item.kind !== "asked-not-here") return ids.length === 0 ? [] : [`${said} names ${asks(ids)}: ${named(ids)}`];
      if (ids.length === 0) return [`${said} names no ask`];
      const unanswered = ids.filter((id) => !answers.some((answer) => answer.id === id));
      const inHead = ids.filter((id) => answers.some((answer) => answer.id === id && answer.answer === "in-head"));
      return [
        ...(unanswered.length === 0 ? [] : [`${said} names ${asks(unanswered)} the reply does not answer: ${named(unanswered)}`]),
        ...(inHead.length === 0 ? [] : [`${said} names ${asks(inHead)} answered in the head: ${named(inHead)}`]),
      ];
    }),
  ];
}

/** How many words a text runs to: a word is a run of characters between spaces. */
function wordsIn(text: string): number {
  return text.split(/\s+/).filter((word) => word !== "").length;
}

/**
 * The reply's items as a Digest carries them: in kind order, what the
 * Operator asked for that is not here first, then what is theirs to judge,
 * then what was not proven, keeping the writer's order within a kind. A
 * suggested request is dropped, and its item kept, on an item that is the
 * Operator's to judge, where no run could act on it, and when it runs past
 * its 40 words. Whether one is an instruction is the prompt's to hold.
 */
export function digestItemsOf(reply: Pick<DigestReply, "items">): DigestItem[] {
  return ITEM_KINDS.flatMap((kind) => reply.items.filter((item) => item.kind === kind)).map((item) => {
    const { suggestedRequest } = item;
    const kept = suggestedRequest !== null && item.kind !== "yours-to-judge" && wordsIn(suggestedRequest) <= MAX_SUGGESTED_REQUEST_WORDS;
    return kept ? item : { ...item, suggestedRequest: null };
  });
}

/**
 * Why Kit code refuses a reply over its length, or nothing: Needs your eyes,
 * What it does and How it got here coming to more than 180 words between
 * them. The count is over each item's claim and sentence and the two texts,
 * never a heading, a link or a suggested request. Each section has a cap of
 * its own, which the prompt gives the writer and nothing here holds: a
 * section a few words over still lands.
 */
function wordsRefused({ items, whatItDoes, howItGotHere }: DigestReply): string[] {
  const words = [...items.flatMap(({ claim, sentence }) => [claim, sentence]), whatItDoes, howItGotHere].reduce((count, text) => count + wordsIn(text), 0);
  if (words <= MAX_TOP_WORDS) return [];
  return [`Needs your eyes, What it does and How it got here come to ${words} words between them, over the ${MAX_TOP_WORDS} a Digest's top may hold`];
}

/** Why Kit code refuses a reply over the Follow-ups it names, or nothing: one Kit code did not list. */
function followUpsRefused(shown: readonly string[], listed: DigestFacts["followUps"]): string[] {
  const unlisted = [...new Set(shown)].filter((id) => !listed.some((followUp) => followUp.id === id));
  return unlisted.length === 0 ? [] : [`the reply names ${unlisted.length === 1 ? "a Follow-up" : "Follow-ups"} Kit code did not list: ${named(unlisted)}`];
}

/**
 * The Digest's comment, rendered from the writer's fields and Kit code's
 * facts with only what GitHub renders in a pull request: its hidden first
 * line naming the head, an opening line naming the pull request and that
 * head and the asks answered, an opening line naming the pull request and
 * that head, Needs your eyes, What it does, How it got here and the
 * Follow-ups the reply names, then, under the folds line, the four folds,
 * and last a link to the run. Every mention is taken out, as a Verdict's
 * findings lose theirs.
 *
 * Refused, never cut, saying every reason: a reply that leaves an ask of Kit
 * code's unanswered or answers under an id that is no ask's; one whose items
 * do not cover every ask that is not in the head, or name an ask they may
 * not; one naming a Follow-up Kit code did not list; one whose top runs
 * over its 180 words; and a comment too long for GitHub.
 *
 * Put right, and the Digest lands: items out of kind order, and a suggested
 * request where none may stand (digestItemsOf).
 */
export function digestCommentOf(reply: DigestReply, given: DigestGiven): DigestComment {
  const text = (field: string): string => withoutMentions(field.trim());
  const { repoUrl, pullRequest, headSha, runUrl, facts } = given;
  const refusals = [
    ...answersRefused(reply.asks, facts.asks),
    ...itemsRefused(reply.items, reply.asks),
    ...followUpsRefused(reply.followUps, facts.followUps),
    ...wordsRefused(reply),
  ];
  if (refusals.length > 0) return { ok: false, refused: refusals.join("; ") };
  const items = digestItemsOf(reply);
  const body = [
    digestMarker({ head: headSha, asks: facts.asks.map(({ id }) => id) }),
    `**Digest** of #${pullRequest}, written as of [\`${headSha.slice(0, 7)}\`](${repoUrl}/pull/${pullRequest}/commits/${headSha}).`,
    "",
    "### Needs your eyes",
    "",
    ...needsYourEyes(items),
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
    ...fold("The criteria and how each was checked", criteriaTable(reply.asks, facts.asks).join("\n")),
    "",
    `[The run](${runUrl})`,
  ].join("\n");
  if (body.length > GITHUB_COMMENT_LIMIT) {
    return { ok: false, refused: `the Digest would be ${body.length} characters, over GitHub's limit of ${GITHUB_COMMENT_LIMIT} for a comment` };
  }
  return { ok: true, body };
}
