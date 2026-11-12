// The Round read (#640): for one issue in a Design session, made on demand
// when a reader asks and never in a gather, what waits on the Operator there,
// as data: the session's last Round, whether it still waits on their answer,
// a failed turn the Kit handed back with how many have failed in a row, and
// whether a Map may be offered. A reader shows a Round from it, and reads
// again at the moment the Operator answers: it sends the answer only when the
// fresh read gives the same comment, still waiting, so an answer never goes
// to a Round the session has moved past. Read only, with the reader's
// credential.
import type { ReadClient } from "../github/client.ts";
import { ACTOR } from "../github/facts.ts";
import { gatherOpenMaps, loginOf } from "../github/snapshot.ts";
import { currentDesignSessionIn } from "../github/threads.ts";
import type { KitConfigResult } from "../kit/config.ts";
import { stoppedDesignSessionStandingOf } from "../kit/standingOperator.ts";
import { wordStanding } from "../kit/standingWording.ts";
import { NEEDS_DESIGN } from "../loop/labels.ts";
import { mapOfferOf } from "../loop/mapCap.ts";
import { DESIGN_ROUND_MARKER, DESIGN_TURN_FAILED_MARKER, handBackMarkIn, refusedByMapCap } from "../loop/markers.ts";
import { type RoundLine, roundLineIn } from "../loop/roundLine.ts";

/** What waits on the Operator in one issue's Design session, as a Round read gives it. */
export interface RoundRead {
  /** `owner/name`. */
  readonly repo: string;
  readonly issue: number;
  /** When it was read, ISO 8601. */
  readonly readAt: string;
  /**
   * `round` while the session's last Round waits on the Operator's answer;
   * `failed-turn` while a failed turn the Kit handed back does; `nothing`
   * otherwise: a turn is running, the session has ended, a prototype is being
   * built, the Map cap refused a Map, the issue is closed or not in a Design
   * session. `unread` when GitHub refused or failed a request: a reader never
   * sends an answer on it.
   */
  readonly waits: "round" | "failed-turn" | "nothing" | "unread";
  /**
   * The last Round of the issue's current Design session, waiting or not;
   * null when the session has none, the issue isn't in one, or it was unread.
   */
  readonly round: {
    /** Its comment's id: a Round's identity, which a reader compares before it sends an answer. */
    readonly comment: number;
    readonly url: string;
    readonly postedAt: string;
    /** Its number in the session. */
    readonly round: number;
    /** Whether the Operator has not replied after it. */
    readonly waiting: boolean;
    /** Its fields, from its hidden line; null for a Round with none this reader takes, as every Round an earlier release posted. */
    readonly line: RoundLine | null;
  } | null;
  /** The failed turn the Kit's latest word in the session hands back, while the Operator has not replied since; else null. */
  readonly failedTurn: {
    /** The Standing's own sentence for that hand-back, at readAt: never the notice's text, which may quote an agent. */
    readonly sentence: string;
    /** The Actions run the notice is about, from its hidden line; null for a notice that names none, as an earlier release's. */
    readonly run: number | null;
    /** That run's address; null with it. */
    readonly url: string | null;
    /** How many failed-turn notices have followed one another, with no Round between them, since the last Round or the session's start. */
    readonly failedRunning: number;
  } | null;
  /** Whether a reader may offer to chart the issue as a Map: the Map cap has room and the issue has no parent Spec, as a Design turn there would be told. */
  readonly mapMayBeOffered: boolean;
}

/** One comment as the Round's rule reads it: its text, who wrote it, by login (a bot's with `[bot]`), and whether a bot did. */
export interface RoundComment {
  readonly body: string;
  readonly author: string;
  readonly byBot: boolean;
}

/** The one issue, with what tells whether it is in a Design session, its parent and its last 100 comments. */
const ISSUE_QUERY = `
  query ($owner: String!, $name: String!, $issue: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $issue) {
        state
        labels(first: 100) { nodes { name } }
        parent { number }
        comments(last: 100) { nodes { databaseId url body createdAt author ${ACTOR} } }
      }
    }
  }
`;

/** The issue as ISSUE_QUERY reads it. */
interface RawIssue {
  state: "OPEN" | "CLOSED";
  labels: { nodes: { name: string }[] };
  parent: { number: number } | null;
  comments: { nodes: RawComment[] };
}

interface RawComment {
  databaseId: number;
  url: string;
  body: string;
  createdAt: string;
  author: { login: string; __typename: string } | null;
}

/** A comment of the issue's, its author read as the Kit reads one. */
interface Comment extends RoundComment {
  readonly id: number;
  readonly url: string;
  readonly at: string;
}

/**
 * What waits on `operator` in issue `issue` of `repo`, `owner/name`, at
 * `now`: two requests, the issue and the repo's open Maps. `kitConfig` and
 * `operator` are the repo's as the gather gave them. Only the Fabrik App's
 * comments are read as the Kit's: its bot login `appLogin`, or any bot's
 * when that is null, as the gather reads them. A refusal or a failure of
 * either request gives `unread`, and the read never throws.
 */
export async function readRound(
  client: Pick<ReadClient, "graphql">,
  repo: string,
  issue: number,
  kitConfig: KitConfigResult,
  operator: string,
  appLogin: string | null,
  now: string,
): Promise<RoundRead> {
  try {
    return await roundReadOf(client, repo, issue, kitConfig, operator, appLogin, now);
  } catch {
    // A refusal, or a query GitHub failed or never answered.
    return { repo, issue, readAt: now, waits: "unread", round: null, failedTurn: null, mapMayBeOffered: false };
  }
}

async function roundReadOf(
  client: Pick<ReadClient, "graphql">,
  repo: string,
  issue: number,
  kitConfig: KitConfigResult,
  operator: string,
  appLogin: string | null,
  now: string,
): Promise<RoundRead> {
  const [owner = "", name = ""] = repo.split("/");
  const [read, openMaps] = await Promise.all([
    client.graphql<{ repository: { issue: RawIssue | null } }>(ISSUE_QUERY, { owner, name, issue }),
    gatherOpenMaps(client, { owner, name }),
  ]);
  const raw = read.repository.issue;
  if (raw === null) throw new Error(`#${issue} is not an issue of ${repo}`);
  // A Design turn on an invalid Kit config fails before its agent starts, so it would chart no Map.
  const mapMayBeOffered = kitConfig.ok && mapOfferOf(raw.parent?.number ?? null, openMaps, kitConfig.config).kind === "may-offer";
  const base = { repo, issue, readAt: now, mapMayBeOffered };
  // A closed issue, or one that has left Design, has no session for a Round to wait in.
  const inSession = raw.state === "OPEN" && raw.labels.nodes.some(({ name: label }) => label === NEEDS_DESIGN);
  if (!inSession) return { ...base, waits: "nothing", round: null, failedTurn: null };
  const comments = raw.comments.nodes.map(({ databaseId, url, body, createdAt, author }): Comment => ({
    id: databaseId,
    url,
    body,
    at: createdAt,
    author: loginOf(author),
    byBot: author?.__typename === "Bot",
  }));
  const session = sessionOf(comments, operator, appLogin);
  const round =
    session.round === null
      ? null
      : {
          comment: session.round.id,
          url: session.round.url,
          postedAt: session.round.at,
          round: Number(DESIGN_ROUND_MARKER.exec(session.round.body)?.[1]),
          waiting: session.waiting,
          line: roundLineIn(session.round.body),
        };
  const failedTurn = session.failed === null ? null : failedTurnOf(session.failed, session.failedRunning, issue, repo, now);
  const waits = failedTurn !== null ? "failed-turn" : session.waiting && session.latest === session.round ? "round" : "nothing";
  return { ...base, waits, round, failedTurn };
}

/** The sentence, the run and the count of a failed turn, the sentence worded from the Standing the rule gives the notice. */
function failedTurnOf(notice: Comment, failedRunning: number, issue: number, repo: string, now: string): NonNullable<RoundRead["failedTurn"]> {
  // Its sentence names no time of day, so the zone it would be told in is any.
  const { sentence } = wordStanding(stoppedDesignSessionStandingOf(issue, repo, notice), now, "UTC");
  const run = handBackMarkIn(notice.body)?.run ?? null;
  return { sentence, run, url: run === null ? null : `https://github.com/${repo}/actions/runs/${run}`, failedRunning };
}

/** Where an issue's current Design session stands, from its comments oldest first. */
interface Session<C extends RoundComment> {
  /** Its last Round, the Fabrik App's. */
  readonly round: C | null;
  /** Whether the Operator has not replied after that Round. */
  readonly waiting: boolean;
  /** The Fabrik App's latest word in the session. */
  readonly latest: C | null;
  /** The App's notice of a failed turn, when it is that latest word and the Operator has not replied since. */
  readonly failed: C | null;
  /** The failed-turn notices in a row since the last Round or the session's start. */
  readonly failedRunning: number;
}

function sessionOf<C extends RoundComment>(comments: readonly C[], operator: string, appLogin: string | null): Session<C> {
  const session = currentDesignSessionIn(comments.map((comment) => ({ comment, body: comment.body, byApp: appLogin === null ? comment.byBot : comment.author === appLogin })));
  // The Operator, told by login as when a reply starts a turn: never a bot.
  const repliedAfter = (index: number) => session.slice(index + 1).some(({ comment }) => !comment.byBot && comment.author === operator);
  let round = -1;
  let latest = -1;
  let failedRunning = 0;
  session.forEach(({ body, byApp }, index) => {
    if (!byApp) return;
    latest = index;
    if (DESIGN_ROUND_MARKER.test(body)) {
      round = index;
      failedRunning = 0;
    } else if (isFailedTurn(body)) {
      failedRunning += 1;
    }
  });
  const at = (index: number) => session[index]?.comment ?? null;
  const failed = latest !== -1 && isFailedTurn(session[latest]?.body ?? "") && !repliedAfter(latest) ? at(latest) : null;
  return { round: at(round), waiting: round !== -1 && !repliedAfter(round), latest: at(latest), failed, failedRunning };
}

/** Whether the Fabrik App's comment is its notice that a Design-session turn failed: the Map cap's refusal opens the same way and is not one. */
function isFailedTurn(body: string): boolean {
  return body.startsWith(DESIGN_TURN_FAILED_MARKER) && !refusedByMapCap(body);
}

/**
 * Whether the last Round of an issue's current Design session waits on the
 * Operator, from its comments oldest first: no reply of theirs, by login and
 * never a bot's, since it. Only the Fabrik App's comments are read as the
 * Kit's, its bot login `appLogin`, or any bot's when that is null. The Round
 * read's own rule, for a reader that holds the comments already.
 */
export function roundWaitsIn(comments: readonly RoundComment[], operator: string, appLogin: string | null): boolean {
  return sessionOf(comments, operator, appLogin).waiting;
}
