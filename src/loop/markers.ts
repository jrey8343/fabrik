// The markers the Kit's comments open with, and the marker lines it puts in
// issue bodies: a Monitor issue's marker line and the Monitor's note closing
// its red-main issue (#148), an Audit's own, the `From audit #n` line and
// escape marker an Audit candidate's filed issue ends with (#150), and a
// Retro's own (#151). The core writes them; the adapter reads a thread's
// comments back through them into the snapshot (src/github/threads.ts), and
// the body lines are read from the issues themselves, so the Loop's history
// lives on GitHub alone. A marker carrying JSON spells it with markerJson; the
// Replay's markers, which only the Replay module reads and writes, live
// beside its rules (src/kit/replay.ts).
import { type PrototypeRequest, prototypeRequestOf } from "./designOutput.ts";
import type { RequestChangesAnswers } from "./implementOutput.ts";
import type { Strength, VerdictRecord } from "./types.ts";

/** A Verdict comment's first line, carrying its record as JSON. */
export const VERDICT_MARKER = /^<!-- fabrik:verdict (\{.*?\}) -->/;

export function verdictMarker(record: VerdictRecord): string {
  const { verdict, source, requestChanges, conflictRun, requestChangesFirst, leftLoop, headSha } = record;
  // Only a conflict-only run's Verdict says so (#304), and only one that gave way to an undelivered Request
  // changes (#341), so every other marker reads as it always has.
  const fields = {
    verdict,
    source,
    requestChanges,
    ...(conflictRun === true ? { conflictRun } : {}),
    ...(requestChangesFirst === undefined ? {} : { requestChangesFirst }),
    ...(leftLoop === true ? { leftLoop } : {}),
    headSha,
  };
  return `<!-- fabrik:verdict ${JSON.stringify(fields)} -->`;
}

/** The first line of the Kit's note on a PR that a Request-changes run pushed to it. */
export const REQUEST_CHANGES_RUN_MARKER = "<!-- fabrik:request-changes-run -->";

/** What a Request-changes run answered about the review it was started for (#369), as its marker records it. */
export interface RecordedAnswers extends RequestChangesAnswers {
  /** The Request changes review the run was started for, and answers for alone. */
  readonly review: number;
}

/**
 * The second line of a Request-changes run's outcome comment (#369), its push
 * note or its note that it committed nothing (#388), right under that
 * comment's own marker (an older one's empty-diff Verdict carries it too):
 * the run's two answers about the review it was started for. Only the Kit
 * writes that line, so agent text further down can't fake it.
 */
const REQUEST_CHANGES_ANSWERS_MARKER = /^<!-- fabrik:request-changes-answers (\{.*?\}) -->$/;

/** The answers marker line for a Request-changes run's answers about its review, which requestChangesAnswersIn reads back. */
export function requestChangesAnswersMarker({ review, reviewMiss, amendsTicket }: RecordedAnswers): string {
  return `<!-- fabrik:request-changes-answers ${markerJson({ review, reviewMiss, amendsTicket })} -->`;
}

/**
 * A Request-changes run's two answers about the review it was started for,
 * read from the second line of the Kit's comment holding them, or null when
 * that line holds none: every comment from before the answers, and every
 * other comment. Only a bot's comment should be passed in.
 */
export function requestChangesAnswersIn(body: string): RecordedAnswers | null {
  const json = REQUEST_CHANGES_ANSWERS_MARKER.exec(body.split("\n", 2)[1] ?? "")?.[1];
  if (json === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { review, reviewMiss, amendsTicket } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(review) || (review as number) <= 0 || typeof reviewMiss !== "boolean" || typeof amendsTicket !== "boolean") return null;
  return { review: review as number, reviewMiss, amendsTicket };
}

/**
 * The first line of the Kit's note on a PR that a conflict-only run pushed to
 * it (#304): that run's outcome, which ends its time in flight, and marks the
 * next Verdict as from a conflict-only run, which uses no retry.
 */
export const CONFLICT_RUN_MARKER = "<!-- fabrik:conflict-run -->";

/**
 * How the Kit records an attempt to bring an agent PR up to date with the
 * default branch (#304), on the PR, as its note's first line, carrying the
 * default branch head it tried: `rebased` when the mechanical rebase was
 * clean and pushed, `conflict-run` when it conflicted and a conflict-only run
 * started. Either way the Kit tries that PR no more until the head moves.
 * An attempt on a draft whose push GitHub never reviewed (#389) ends with
 * `unreviewed-draft`, so the Verdict that follows is marked as that push's
 * own would have been, never as a conflict-only run's.
 */
const CONFLICT_ATTEMPT_MARKER = /^<!-- fabrik:conflict-attempt ([0-9a-f]{40}) (rebased|conflict-run)( unreviewed-draft)? -->/;

/** What a conflict attempt's note records: the default branch head, how the attempt went, and whether it was on a draft. */
export interface ConflictAttempt {
  readonly main: string;
  readonly outcome: "rebased" | "conflict-run";
  /** True on a draft whose push GitHub never reviewed (#389); absent on a PR at the Merge gate, as on every older note. */
  readonly unreviewedDraft?: true;
}

export function conflictAttemptMarker({ main, outcome, unreviewedDraft }: ConflictAttempt): string {
  return `<!-- fabrik:conflict-attempt ${main} ${outcome}${unreviewedDraft === true ? " unreviewed-draft" : ""} -->`;
}

/** The conflict attempt a comment's first line records, or null when it records none. */
export function conflictAttemptIn(body: string): ConflictAttempt | null {
  const match = CONFLICT_ATTEMPT_MARKER.exec(body);
  if (match === null) return null;
  return {
    main: match[1] as string,
    outcome: match[2] as ConflictAttempt["outcome"],
    ...(match[3] === undefined ? {} : { unreviewedDraft: true as const }),
  };
}

/**
 * The first line of the Kit's note that a conflict-only run ended without
 * pushing (#304): it failed, changed nothing, or was refused. It ends the
 * run's time in flight, and hands the PR to the Operator.
 */
export const CONFLICT_RUN_ENDED_MARKER = "<!-- fabrik:conflict-run-ended -->";

/**
 * The first line of the Kit's note on an undelivered Request changes (#341):
 * the Operator's reviews no run had started for, by id. The note starts their
 * Request-changes run, and the Kit never notes the same review twice.
 */
const UNDELIVERED_MARKER = /^<!-- fabrik:undelivered-request-changes ([1-9][0-9]*(?:,[1-9][0-9]*)*) -->/;

export function undeliveredMarker(reviews: readonly number[]): string {
  return `<!-- fabrik:undelivered-request-changes ${reviews.join(",")} -->`;
}

/**
 * The first line of the Kit's note that it started the Request-changes run for
 * the Operator's review GitHub delivered (#341), and for any earlier one of
 * theirs no run was started for, by id. Like the undelivered note, it marks
 * that run in flight, so every Request-changes run the Kit starts is read from
 * the PR's comments alone.
 */
const STARTED_MARKER = /^<!-- fabrik:request-changes-run-started ([1-9][0-9]*(?:,[1-9][0-9]*)*) -->/;

export function requestChangesRunStartedMarker(reviews: readonly number[]): string {
  return `<!-- fabrik:request-changes-run-started ${reviews.join(",")} -->`;
}

/**
 * The review ids a note that started a Request-changes run names, from its
 * first line: an undelivered-review note's, or a delivered review's started
 * note's. Null when it's neither.
 */
export function startedReviewsIn(body: string): number[] | null {
  const match = UNDELIVERED_MARKER.exec(body) ?? STARTED_MARKER.exec(body);
  return match === null ? null : (match[1] as string).split(",").map(Number);
}

/**
 * The first line of the Kit's note that a Request-changes run told to merge
 * main in ended without pushing (#341): it couldn't bring main in, or was
 * refused. It carries the default branch head it was against, which counts as
 * that head's conflict attempt, ends the run's time in flight, and hands the PR
 * to the Operator.
 */
const REQUEST_CHANGES_RUN_ENDED_MARKER = /^<!-- fabrik:request-changes-run-ended ([0-9a-f]{40}) -->/;

export function requestChangesRunEndedMarker(main: string): string {
  return `<!-- fabrik:request-changes-run-ended ${main} -->`;
}

/** The default branch head a Request-changes run's ended note names, or null when it isn't one. */
export function requestChangesRunEndedIn(body: string): string | null {
  return REQUEST_CHANGES_RUN_ENDED_MARKER.exec(body)?.[1] ?? null;
}

/**
 * The first line of the Kit's note that a Request-changes run, not told to
 * merge main in, committed nothing (#388): its outcome, with no Verdict. It
 * ends the run's time in flight and settles the Request changes the run read,
 * as its push would, and marks the next Verdict as from a Request-changes run,
 * which uses no retry. Unlike the ended note, it records no conflict attempt.
 */
export const REQUEST_CHANGES_RUN_EMPTY_MARKER = "<!-- fabrik:request-changes-run-empty -->";

/** The first line of the Kit's note on a PR that a Retry pushed to it: the Retry's outcome, which ends its time in flight. */
export const RETRY_PUSH_MARKER = "<!-- fabrik:retry-push -->";

/**
 * The first line of the Kit's note that the Retry a PR's latest Verdict called
 * for never started, and won't, as its Ticket has left `ready-for-agent`
 * (#416): no Retry is in flight from it.
 */
export const RETRY_ENDED_MARKER = "<!-- fabrik:retry-ended -->";

/** How the note of a Retry's push opened before it carried RETRY_PUSH_MARKER, so older PRs read the same. */
export const UNMARKED_RETRY_PUSH = "The Implementer pushed a fix for the Execution flaw to ";

/** The first line of the Kit's comment on a Ticket whose Implement run changed nothing. */
export const EMPTY_DIFF_MARKER = "<!-- fabrik:empty-diff -->";

/** A Design-session round's first line. */
export const DESIGN_ROUND_MARKER = /^<!-- fabrik:design-round (\d+) -->/;

export function designRoundMarker(round: number): string {
  return `<!-- fabrik:design-round ${round} -->`;
}

/**
 * The first line of the Kit's failure notice for a Design-session turn, and
 * of its refusal of a Map the Map cap holds (src/loop/design.ts): the session
 * keeps its slot while that notice is the Operator's move (#147).
 */
export const DESIGN_TURN_FAILED_MARKER = "<!-- fabrik:design-turn-failed -->";

/**
 * The first line of the Kit's failure notice for a Researcher run on a
 * Decision (#154): while that notice is the Decision's latest run's word,
 * Dispatch leaves it for the Operator to re-add agent:research.
 */
export const RESEARCH_RUN_FAILED_MARKER = "<!-- fabrik:research-run-failed -->";

/** How the comment that ends a Design session starts, either way it ends. */
export const SESSION_FINISHED = "**Design session finished.**";

/**
 * Opens the comment a live Design session ends with. Only the start of a
 * comment counts, so quoting it doesn't.
 */
export const LIVE_OUTCOME_MARKER = /^<!-- fabrik:live-outcome (\S+) -->/;

/** The first line of the Kit's note that a Ticket came back to design from an agent PR. */
export const BACK_TO_DESIGN_MARKER = /^<!-- fabrik:back-to-design ([1-9][0-9]*) (https:\/\/\S+|operator) -->/;

/**
 * A prototype request's first line (#155), carrying as JSON what the Operator
 * approved and, when a reply of theirs started the turn, that reply.
 */
const PROTOTYPE_REQUEST_MARKER = /^<!-- fabrik:prototype-request (\{.*\}) -->(?:\n|$)/;

/** What a prototype request's marker says. */
export interface PrototypeRequestMarker {
  /** What the prototype turn of the session builds. */
  readonly request: PrototypeRequest;
  /**
   * The id of the Operator's reply that started the turn which asked for it,
   * so the prototype turn posts nothing once the Operator deleted it; null
   * when agent:design started that turn.
   */
  readonly reply: number | null;
}

/** How a marker's JSON spells the characters that could end its HTML comment early or mention someone. */
const ESCAPED: Readonly<Record<string, string>> = { "<": "\\u003c", ">": "\\u003e", "@": "\\u0040" };

/**
 * A marker's value as one line of JSON that can neither end its HTML
 * comment early nor mention anyone: `<`, `>` and `@` spelled as escapes,
 * which JSON.parse reads back as they were.
 */
export function markerJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>@]/g, (c) => ESCAPED[c] ?? c);
}

/**
 * A prototype request as one line of JSON: its route, variant count and
 * brief, and the reply that asked for it, which parsePrototypeRequest reads
 * back. Its marker holds it (prototypeRequestMarker), and so does the Kit
 * job's output that carries it to the prototype job (src/kit/jobs.ts), whose
 * GITHUB_OUTPUT lines can't hold a newline, which JSON escapes.
 */
export function prototypeRequestJson(marker: PrototypeRequestMarker): string {
  return JSON.stringify(prototypeRequestValue(marker));
}

/** What a prototype request's JSON holds, in the order it holds it. */
function prototypeRequestValue({ request: { route, variants, brief }, reply }: PrototypeRequestMarker): unknown {
  return { route, variants, brief, reply };
}

/**
 * A prototype request from its JSON (prototypeRequestJson): null when it
 * doesn't parse, or holds a request the Design turn output contract wouldn't
 * take (prototypeRequestOf), or a reply that isn't a comment id.
 */
export function parsePrototypeRequest(json: string): PrototypeRequestMarker | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const request = prototypeRequestOf(value);
  if (request === null) return null;
  const { reply = null } = value as Record<string, unknown>;
  if (reply !== null && !(Number.isSafeInteger(reply) && (reply as number) > 0)) return null;
  return { request, reply: reply as number | null };
}

/**
 * The marker a prototype request opens with, on one line, which
 * prototypeRequestIn reads back. Its JSON is markerJson's, so a brief can
 * neither end the HTML comment early nor mention anyone.
 */
export function prototypeRequestMarker(marker: PrototypeRequestMarker): string {
  return `<!-- fabrik:prototype-request ${markerJson(prototypeRequestValue(marker))} -->`;
}

/**
 * What a prototype request's marker says, read from the comment's first line,
 * so quoting one further down doesn't count; null when the comment opens with
 * no marker, or with one parsePrototypeRequest doesn't take.
 */
export function prototypeRequestIn(body: string): PrototypeRequestMarker | null {
  const json = PROTOTYPE_REQUEST_MARKER.exec(body)?.[1];
  return json === undefined ? null : parsePrototypeRequest(json);
}

/**
 * The line the Kit puts right under a prototype request's marker (#155), by
 * editing the request's comment, once the request's prototype turn starts,
 * and takes out again if that turn is refused on its Subscription and held or
 * re-run, so agent:design starts the prototype turn only while none has
 * started (src/loop/design.ts). The comment's own second line is its
 * "**Prototype requested.**" lead-in, so nothing the agent wrote can stand
 * where this goes.
 */
const PROTOTYPE_STARTED_MARKER = "<!-- fabrik:prototype-started -->";

/** Whether a prototype request's comment carries the line its prototype turn's start left on it. */
export function prototypeStartedIn(body: string): boolean {
  return body.split("\n", 2)[1] === PROTOTYPE_STARTED_MARKER;
}

/** A prototype request's comment, marked as its prototype turn having started, or not: the line under its marker put in or taken out. */
export function withPrototypeStarted(body: string, started: boolean): string {
  if (prototypeStartedIn(body) === started) return body;
  const [marker = "", ...rest] = body.split("\n");
  return [marker, ...(started ? [PROTOTYPE_STARTED_MARKER, ...rest] : rest.slice(1))].join("\n");
}

/**
 * The line a prototype round (#155) carries right under its round marker,
 * the round's first line, so the round still counts as a round. A round
 * ends its session's pending prototype request (src/github/threads.ts).
 */
export const PROTOTYPE_ROUND_MARKER = "<!-- fabrik:prototype-round -->";

/**
 * The line a prototype failure round (#155) carries in the same place: the
 * round that says what stopped a prototype turn and asks whether to carry
 * on without one. It too ends the session's pending prototype request.
 */
export const PROTOTYPE_FAILURE_ROUND_MARKER = "<!-- fabrik:prototype-failed -->";

/** The heading of a Map's Decisions so far: one line under it per Decision resolved. */
export const DECISIONS_SO_FAR_HEADING = "## Decisions so far";

/** What a Monitor issue's marker line says it tracks (#148): a Sentry group, or red main. */
export type MonitorMarker = { readonly kind: "sentry"; readonly group: string } | { readonly kind: "red-main" };

/**
 * A Monitor issue's marker line, naming the Sentry group or the red main it
 * tracks. Only the line itself counts, never the Monitor block's markers.
 */
const MONITOR_MARKER = /^<!-- fabrik:monitor (?:sentry:(\S+)|red-main) -->$/m;

/** The Monitor marker in this body, or null when it has none. */
export function monitorMarkerIn(body: string): MonitorMarker | null {
  const match = MONITOR_MARKER.exec(body);
  if (match === null) return null;
  const group = match[1];
  return group === undefined ? { kind: "red-main" } : { kind: "sentry", group };
}

/** The marker line a Monitor issue's body opens with, for what it tracks. */
export function monitorMarkerLine(marker: MonitorMarker): string {
  return marker.kind === "sentry" ? `<!-- fabrik:monitor sentry:${marker.group} -->` : "<!-- fabrik:monitor red-main -->";
}

/**
 * The first line of the Monitor's note closing its red-main issue once the
 * default branch is green: its only comment, which tells its own close apart
 * from anyone else's.
 */
export const RED_MAIN_GREEN_MARKER = "<!-- fabrik:monitor-green -->";

/**
 * An Architectural escape's record (#150): `<!-- fabrik:escape <strength> #<pr> #<pr> -->`,
 * the hidden line an Audit candidate's prefilled issue body ends with when it
 * traces to merged agent PRs. It can sit anywhere in a body, since a Design
 * session's rewrite carries it forward, and the Operator may paste one by hand.
 */
const ESCAPE_MARKER = /<!--\s*fabrik:escape(\s[^>]*?)?\s*-->/;

/**
 * A line that is an escape marker and nothing else, matched against the line
 * with its outer whitespace trimmed: the line a Design session's rewrite
 * carries forward (src/loop/carriedLines.ts).
 */
export const ESCAPE_MARKER_LINE = new RegExp(`^${ESCAPE_MARKER.source}$`);

/** What an escape marker says, read as written. */
export interface EscapeMarker {
  /** The word in the Strength's place, known or not, or null when the marker opens with a PR. */
  readonly strength: string | null;
  /** The PR numbers it names, in order. */
  readonly pullRequests: readonly number[];
}

/** The escape marker for a candidate of this Strength that traces to these merged agent PRs, which escapeMarkerIn reads back. */
export function escapeMarker(strength: Strength, pullRequests: readonly number[]): string {
  return `<!-- fabrik:escape ${[strength, ...pullRequests.map((pullRequest) => `#${pullRequest}`)].join(" ")} -->`;
}

/** The first escape marker in `body`, or null if it has none. */
export function escapeMarkerIn(body: string): EscapeMarker | null {
  const match = ESCAPE_MARKER.exec(body);
  if (match === null) return null;
  const words = (match[1] ?? "").split(/\s+/).filter((word) => word !== "");
  const first = words[0];
  return {
    strength: first === undefined || first.startsWith("#") ? null : first,
    pullRequests: words.flatMap((word) => {
      const pullRequest = /^#([1-9][0-9]*)$/.exec(word);
      return pullRequest === null ? [] : [Number(pullRequest[1])];
    }),
  };
}

/**
 * The line an Audit candidate's filed issue ends with, naming the Audit it
 * came from (#150), matched against a whole line with its outer whitespace
 * trimmed. A Design session's rewrite carries it forward.
 */
export const FROM_AUDIT_LINE = /^From audit #([1-9][0-9]*)$/;

/** The `From audit #n` line for a candidate filed from Audit #`audit`, which fromAuditIn reads back. */
export function fromAuditLine(audit: number): string {
  return `From audit #${audit}`;
}

/**
 * The Audit the first `From audit #n` line in `body` names, or null if it has
 * none. A line quoted as code isn't one (see linesOutsideCode).
 */
export function fromAuditIn(body: string): number | null {
  return numberOnFirstLineIn(body, FROM_AUDIT_LINE);
}

/**
 * The line a Follow-up's filed issue ends with, naming the PR whose pass
 * listed it (src/loop/followUps.ts), matched against a whole line with its
 * outer whitespace trimmed.
 */
export const FROM_PULL_REQUEST_LINE = /^From PR #([1-9][0-9]*)$/;

/** The `From PR #n` line for a Follow-up on PR #`pullRequest`'s pass, which fromPullRequestIn reads back. */
export function fromPullRequestLine(pullRequest: number): string {
  return `From PR #${pullRequest}`;
}

/** The PR the first `From PR #n` line in `body` names, or null if it has none. A line quoted as code isn't one. */
export function fromPullRequestIn(body: string): number | null {
  return numberOnFirstLineIn(body, FROM_PULL_REQUEST_LINE);
}

/**
 * The line an issue filed from a Retro's proposal ends with, naming the Retro
 * it came from (#151), matched against a whole line with its outer whitespace
 * trimmed: `From retro #n` on an issue in the Retro's own Product repo, and
 * `From retro <owner>/<repo>#n`, naming that repo, on one filed anywhere else,
 * the Kit's repo or a Skills source, where a bare #n would link to that repo's
 * own issue. The next Retro skips a proposal while its issue is open.
 */
export const FROM_RETRO_LINE = /^From retro (?:([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+))?#([1-9][0-9]*)$/;

/**
 * The `From retro` line for a proposal filed from Retro #`retro`, which
 * fromRetroIn reads back: bare on an issue in the Retro's own Product repo,
 * and naming that repo, `repo` as owner/name, on one filed anywhere else.
 */
export function fromRetroLine(retro: number, repo: string | null = null): string {
  return `From retro ${repo ?? ""}#${retro}`;
}

/** The Retro a `From retro` line names: its number, and its Product repo, as owner/name, when the line names one. */
export interface FromRetro {
  readonly retro: number;
  /** Null for the bare `From retro #n`, which names a Retro in the repo the issue is on. */
  readonly repo: string | null;
}

/** The Retro the first `From retro` line in `body` names, in either form, or null if it has none. A line quoted as code isn't one. */
export function fromRetroIn(body: string): FromRetro | null {
  const match = firstLineIn(body, FROM_RETRO_LINE);
  return match === null ? null : { retro: Number(match[2]), repo: match[1] ?? null };
}

/** The number `line` captures from the first line outside code in `body` it matches, its outer whitespace trimmed, or null. */
function numberOnFirstLineIn(body: string, line: RegExp): number | null {
  const match = firstLineIn(body, line);
  return match === null ? null : Number(match[1]);
}

/** What `line` matches on the first line outside code in `body` it matches, its outer whitespace trimmed, or null. */
function firstLineIn(body: string, line: RegExp): RegExpExecArray | null {
  return (
    linesOutsideCode(body)
      .map((each) => line.exec(each.trim()))
      .find((each) => each !== null) ?? null
  );
}

/**
 * The lines of a Markdown body outside its fenced code blocks: the only lines
 * read as a `From audit` line, or carried forward as a marker line by a
 * Design session's rewrite (src/loop/carriedLines.ts). A line quoted as code
 * is data, such as the Sentry error title a Monitor issue fences (#148),
 * never a marker line. A fence that never closes quotes nothing: a filed
 * Audit candidate's body cut short to fit its link (src/loop/followUps.ts)
 * can leave one open above the trailer it ends with.
 */
export function linesOutsideCode(body: string): string[] {
  return fencedRunsOf(body).runs.flatMap(({ code, lines }) => (code ? [] : lines));
}

/** A run of a Markdown body's lines: one fenced code block, its fence lines included, or lines outside any. */
export interface MarkdownRun {
  readonly code: boolean;
  readonly lines: readonly string[];
}

/**
 * A Markdown body's lines in runs, each one fenced code block or the lines
 * between them, as linesOutsideCode reads them. A fence that never closes
 * quotes nothing there, but GitHub renders everything after it as code:
 * `open` is the first such fence, or null when every fence closes.
 */
export function fencedRunsOf(body: string): { readonly runs: readonly MarkdownRun[]; readonly open: string | null } {
  const lines = body.split("\n");
  const runs: { code: boolean; lines: string[] }[] = [];
  const add = (code: boolean, added: readonly string[]) => {
    const last = runs.at(-1);
    if (last !== undefined && !last.code && !code) last.lines.push(...added);
    else runs.push({ code, lines: [...added] });
  };
  let open: string | null = null;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? "";
    const fence = fenceOpenedBy(line);
    const closing = fence === null ? -1 : lines.findIndex((each, i) => i > at && closesFence(fence, each));
    if (closing === -1) {
      open ??= fence;
      add(false, [line]);
    } else {
      add(true, lines.slice(at, closing + 1));
      at = closing;
    }
  }
  return { runs, open };
}

/** The fence a line opens a fenced code block with, as CommonMark reads it, or null when it opens none. */
function fenceOpenedBy(line: string): string | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) return null;
  const [, fence = "", info = ""] = match;
  // A backtick fence's info string has no backtick: such a line is inline code.
  return fence.startsWith("`") && info.includes("`") ? null : fence;
}

/** Whether a line closes the block `fence` opened: the same character, at least as many, and nothing after. */
function closesFence(fence: string, line: string): boolean {
  const closing = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/.exec(line)?.[1];
  return closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length;
}

/**
 * An Audit's marker line (#150): `<!-- fabrik:audit <sha> -->`, the commit the
 * Audit reads, which was the default branch's head when the tick opened it.
 * Its body keeps the line through every state.
 */
export function auditMarker(sha: string): string {
  return `<!-- fabrik:audit ${sha} -->`;
}

/** The marker line on an Audit still waiting on its run. */
export const AUDIT_PENDING_MARKER = "<!-- fabrik:audit-pending -->";

/** The marker line on an Audit whose run failed, in place of the pending one. */
export const AUDIT_FAILED_MARKER = "<!-- fabrik:audit-failed -->";

const AUDIT_MARKER = /^<!-- fabrik:audit ([0-9a-f]{40}) -->$/;

/** What an Audit's body says through its marker lines. Only a body the Fabrik App wrote is read for them. */
export interface AuditMarks {
  /** The commit its audit marker names, or null when it has none. */
  readonly commit: string | null;
  readonly pending: boolean;
  readonly failed: boolean;
}

/** The Audit marker lines in `body`, each matched against a whole line with its outer whitespace trimmed. */
export function auditMarksIn(body: string): AuditMarks {
  const { value: commit, pending, failed } = weeklyMarksIn(body, AUDIT_MARKER, AUDIT_PENDING_MARKER, AUDIT_FAILED_MARKER);
  return { commit, pending, failed };
}

/**
 * A Retro's marker line (#151): `<!-- fabrik:retro <window-end> -->`, the end
 * of the window the Retro reads, which is the time of the tick that opened
 * it, so the next Retro's window starts where this one's ended. Its body
 * keeps the line through every state.
 */
export function retroMarker(windowEnd: string): string {
  return `<!-- fabrik:retro ${new Date(windowEnd).toISOString()} -->`;
}

/** The marker line on a Retro still waiting on its run. */
export const RETRO_PENDING_MARKER = "<!-- fabrik:retro-pending -->";

/** The marker line on a Retro whose run failed, in place of the pending one. */
export const RETRO_FAILED_MARKER = "<!-- fabrik:retro-failed -->";

const RETRO_MARKER = /^<!-- fabrik:retro (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z) -->$/;

/** What a Retro's body says through its marker lines. Only a body the Fabrik App wrote is read for them. */
export interface RetroMarks {
  /** The end of the window it reads, as an ISO 8601 time, from its retro marker; null when it has none. */
  readonly windowEnd: string | null;
  readonly pending: boolean;
  readonly failed: boolean;
}

/** The Retro marker lines in `body`, each matched against a whole line with its outer whitespace trimmed. */
export function retroMarksIn(body: string): RetroMarks {
  const { value, pending, failed } = weeklyMarksIn(body, RETRO_MARKER, RETRO_PENDING_MARKER, RETRO_FAILED_MARKER);
  const windowEnd = value === null || Number.isNaN(Date.parse(value)) ? null : value;
  return { windowEnd, pending, failed };
}

/**
 * The marker lines in `body` of an issue a weekly gate opens pending for its
 * run (src/loop/weeklyGate.ts), an Audit or a Retro: the value its own
 * `marker` captures, and whether it has the pending or the failed line. Each
 * is matched against a whole line with its outer whitespace trimmed.
 */
function weeklyMarksIn(body: string, marker: RegExp, pending: string, failed: string) {
  const lines = body.split("\n").map((line) => line.trim());
  const value = lines.map((line) => marker.exec(line)?.[1]).find((each) => each !== undefined) ?? null;
  return { value, pending: lines.includes(pending), failed: lines.includes(failed) };
}
