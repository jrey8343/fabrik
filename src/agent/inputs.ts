// An agent job's first step: reads what its agent is given, through the job's
// own read-only token, into files its prompt is built from (src/agent/run.ts).
// The agent itself never holds a GitHub token.
//   node <kit>/src/agent/inputs.ts <out dir>
// Run beside the Product checkout at product/, whose Kit config names the Operator.
// Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, and
//   FABRIK_ROLE                  the agent's role: a Design-session turn's also writes map.json, whether
//                                it may offer a Map (readMapOffer), spec-tickets.json, its Spec's other
//                                Tickets (readIssue's otherTickets, #475), and filed-from.json, the pull
//                                request its issue's `From PR` line names, or that there is none
//                                (readFiledFrom, #659), and open-tickets.json, the open Tickets outside
//                                its own Spec (readOpenTickets, #825)
//   FABRIK_ISSUE                 the issue or Ticket: writes issue.json and spec.json (its parent: a Ticket's Spec, a Decision's Map, or null);
//                                a Ticket back in design from an agent PR carries that PR in issue.json's sentBack
//   FABRIK_PULL_REQUEST          optional, a PR: writes pull-request.json, with the Operator's comments on it
//                                in operatorComments (sentBack carries them too, for the closed PR)
//   FABRIK_PULL_REQUEST_COMMENTS "true" for a run on an agent PR (a retry, or a Request-changes run that reads a Verdict that gave way to it), whose PR file carries the PR's comments and their authors' kind
//   FABRIK_REVIEW                optional, a Request-changes run's review on that PR: writes review.json
//   FABRIK_ROLE=triage           also writes recent-issues.json, the Recent issues Triage compares against for a duplicate
//                                (readRecentIssues, #363)
//   FABRIK_AUDIT_COMMIT          for an Auditor run, the pending Audit's marked commit (FABRIK_ISSUE is the
//                                Audit): writes audit.json, the Auditor's inputs (readAuditInputs)
//   FABRIK_ROLE=digest           writes pull-request.json as the Digest writer is given the PR (readDigestPullRequest):
//                                with the Operator's words, every Verdict, the Kit's notes, whether UI evidence exists
//                                and the routes it captured
//   FABRIK_OUT_DIR               optional, where a failed GitHub call leaves its failure report
//                                (AGENT_FAILURE_FILE), for the push job's notice to name (#328)
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { allPages, GitHub, pagesOf, type Repo } from "../github/client.ts";
import { leavingOutDigests } from "../github/digestComments.ts";
import { digestPicturesOf, readDigestThread } from "../github/digestGiven.ts";
import { leavingOutHeldLines } from "../github/heldLines.ts";
import { capturedRoutesOf, evidenceMarkerIn } from "../evidence/uiEvidence.ts";
import { shotsMarkerIn } from "../evidence/shotsEvidence.ts";
import { byAppOf, deferredChangesRequestsOn, gatherAuditSliceFor, gatherOpenMaps, type OpenMap } from "../github/snapshot.ts";
import {
  byTime,
  lineOf,
  operatorsRequestChangesIn,
  readWrittenOn,
  type Written,
  type WrittenComment,
  type WrittenOn,
  type WrittenReview,
  writtenBy,
} from "../github/writtenOn.ts";
import { readKitConfigFromCheckout } from "../kit/checkout.ts";
import { designSessionOf, verdictsIn } from "../github/threads.ts";
import { isAgentPullRequest } from "../loop/agentPullRequest.ts";
import { isStateLabel, KIT_ISSUE_LABELS, READY_FOR_AGENT, type StateLabel } from "../loop/labels.ts";
import { type Audit, auditsIn, lastAudit } from "../loop/audit.ts";
import type { SentBack } from "../loop/backToDesign.ts";
import { withoutChangeLines } from "../loop/changeFingerprint.ts";
import { type DigestFacts, digestFactsOf } from "../loop/digestFacts.ts";
import { mapOfferOf, type MapOfferOf } from "../loop/mapCap.ts";
import { flakyCheckIssueOf, followsSpecIn, followUpIssueOf, fromAuditIn, fromPullRequestIn, openedSpinOffsAmong, spinOffIn, type SpinOffSource } from "../loop/markers.ts";
import { withoutRoundLines } from "../loop/roundLine.ts";
import type { AuditIssueSnapshot, AuditWindow, KitConfig } from "../loop/types.ts";
import { comprehensionDrift, DRIFT_DAYS, type DriftFile } from "./comprehensionDrift.ts";
import { AGENT_FAILURE_FILE, inputsFailureReportFor } from "./failure.ts";
import { operatorCommentId, type OperatorComment, type RequestedChange, type SetAsidePoint, setAsidePoints } from "./operatorComments.ts";

/** What these reads need of a GitHub client. */
export type Reader = Pick<GitHub, "graphql" | "rest">;

const ISSUE_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        number
        title
        body
        author { login __typename }
        labels(first: 100) { nodes { name } }
        parent {
          number
          title
          body
          subIssues(first: 100) {
            nodes {
              number
              title
              state
              labels(first: 100) { nodes { name } }
              closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number state } }
            }
          }
        }
        comments(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { author { login __typename } body createdAt }
        }
      }
    }
  }
`;

interface IssueQueryResult {
  repository: {
    issue: {
      number: number;
      title: string;
      body: string;
      author: { login: string; __typename: string } | null;
      labels: { nodes: { name: string }[] };
      parent: {
        number: number;
        title: string;
        body: string;
        subIssues: {
          nodes: {
            number: number;
            title: string;
            state: "OPEN" | "CLOSED";
            labels: { nodes: { name: string }[] };
            closedByPullRequestsReferences: { nodes: { number: number; state: "OPEN" | "CLOSED" | "MERGED" }[] };
          }[];
        };
      } | null;
      comments: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { author: { login: string; __typename: string } | null; body: string; createdAt: string }[];
      };
    } | null;
  };
}

/**
 * One of the Spec's other Tickets, as a Design session on a Ticket under it is
 * given them (#475): its state label, if it has one, whether it's open, and
 * its pull request, if any: the merged one, else the open one, else the
 * latest closed one.
 */
export interface SpecTicket {
  readonly number: number;
  readonly title: string;
  readonly stateLabel: StateLabel | null;
  readonly open: boolean;
  readonly pullRequest: { readonly number: number; readonly state: "open" | "closed" | "merged" } | null;
}

type SubIssue = NonNullable<NonNullable<IssueQueryResult["repository"]["issue"]>["parent"]>["subIssues"]["nodes"][number];

function specTicketOf(ticket: SubIssue): SpecTicket {
  return {
    number: ticket.number,
    title: ticket.title,
    stateLabel: stateLabelOf(ticket.labels.nodes),
    open: ticket.state === "OPEN",
    pullRequest: pullRequestOf(ticket.closedByPullRequestsReferences.nodes),
  };
}

function stateLabelOf(labels: readonly { name: string }[]): StateLabel | null {
  return labels.map(({ name }) => name).find(isStateLabel) ?? null;
}

/** The pull request a Ticket is told of by: the merged one that closes it, else the open one, else the latest closed one. */
function pullRequestOf(pullRequests: readonly { number: number; state: "OPEN" | "CLOSED" | "MERGED" }[]): SpecTicket["pullRequest"] {
  const pullRequest =
    pullRequests.find(({ state }) => state === "MERGED") ?? pullRequests.find(({ state }) => state === "OPEN") ?? pullRequests.at(-1) ?? null;
  return pullRequest === null ? null : { number: pullRequest.number, state: pullRequest.state === "MERGED" ? "merged" : pullRequest.state === "OPEN" ? "open" : "closed" };
}

/**
 * The issue as `gh issue view --json number,title,body,author,labels,comments`
 * shapes it, every comment included, its parent Spec, and the Spec's other
 * Tickets, in `otherTickets` (none with no parent). It names the
 * Operator's login once, in `operator`, and each comment carries `byBot` and
 * `isOperator`, so the agent can tell the Kit's comments and the Operator's
 * from anyone else's (#426). When the issue's current Design session follows
 * the Kit's note that the Ticket came back from an agent PR, the issue also
 * carries `sentBack`: what that closed PR was judged on and what it built
 * (see readSentBack). `body` is the issue's body once more, as GitHub has it,
 * for the step's own reads of its lines (readFiledFrom), and `check` the
 * Required check it is the Check's issue for (#839), read only on an issue a
 * bot opened, as this job takes any bot for the App (byAppOf), else null.
 * Read the same way, a Spin-off (#883) carries `spinOff`, where it came
 * from, which Triage's prompt and its output contract go by; any other issue
 * has no such field. An issue the Kit opened for a Follow-up that is a fault
 * (#885) carries `followUp`, the pull request whose pass named the fault,
 * which Triage's prompt goes by.
 */
export async function readIssue(
  github: Reader,
  repo: Repo,
  number: number,
  operator: string,
): Promise<{ issue: unknown; body: string; check: string | null; spec: { number: number; title: string; body: string } | null; otherTickets: SpecTicket[] }> {
  const comments: IssueComment[] = [];
  let after: string | null = null;
  let issue: NonNullable<IssueQueryResult["repository"]["issue"]>;
  do {
    const data: IssueQueryResult = await github.graphql<IssueQueryResult>(ISSUE_QUERY, { owner: repo.owner, name: repo.name, number, after });
    if (data.repository.issue === null) throw new Error(`Issue #${number} not found`);
    issue = data.repository.issue;
    comments.push(...issue.comments.nodes);
    after = issue.comments.pageInfo.hasNextPage ? issue.comments.pageInfo.endCursor : null;
  } while (after !== null);
  // GraphQL gives a bot's login without its `[bot]`, so the login alone can't tell the Kit's comments from a person's (#426).
  const authoredComments = comments.map(({ author, body, createdAt }) => {
    const byBot = author?.__typename === "Bot";
    return {
      author: author === null ? null : { login: author.login },
      // A Round's hidden line is for readers of the Kit, never an agent (#635): the thread is as it was without it.
      body: withoutRoundLines(body),
      createdAt,
      byBot,
      isOperator: !byBot && author?.login === operator,
    };
  });
  // Only the App's note counts, as in the core's snapshot, so quoting one can't fake a return. This job doesn't know the
  // App's login, so it takes any bot's note for the App's (byAppOf).
  const { sentBack } = designSessionOf(comments.map(({ author, body }) => ({ body, byApp: byAppOf(author, null) })));
  // Anyone can quote a Spin-off's marker in an issue they open, so it is read only on a bot's (ADR-0037).
  const spinOff = byAppOf(issue.author, null) ? spinOffIn(issue.body) : null;
  // Likewise the marker of a Follow-up the Kit opened (#885).
  const followUp = byAppOf(issue.author, null) ? followUpIssueOf(issue.body) : null;
  return {
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      author: issue.author === null ? { login: "ghost" } : { login: issue.author.login },
      labels: issue.labels.nodes,
      operator,
      comments: authoredComments,
      ...(spinOff === null ? {} : { spinOff }),
      ...(followUp === null ? {} : { followUp: { pullRequest: followUp } }),
      ...(sentBack === null ? {} : { sentBack: await readSentBack(github, repo, sentBack, operator) }),
    },
    body: issue.body,
    check: byAppOf(issue.author, null) ? flakyCheckIssueOf(issue.body) : null,
    spec: issue.parent === null ? null : { number: issue.parent.number, title: issue.parent.title, body: issue.parent.body },
    otherTickets: (issue.parent?.subIssues.nodes ?? []).filter((ticket) => ticket.number !== issue.number).map(specTicketOf),
  };
}

type IssueComment = NonNullable<IssueQueryResult["repository"]["issue"]>["comments"]["nodes"][number];

/** Past this many characters, the sent-back PR's diff is cut short; its file list stays whole. */
export const SENT_BACK_DIFF_LIMIT = 60_000;

/**
 * The agent PR a Ticket came back from, for the Design session that follows:
 * what sent it back (every Verdict the Fabrik App gave it, oldest first, or
 * the Operator's reviews when the Operator did), the Operator's comments on it
 * either way, and what its kept branch built (its commits, its changed files,
 * and its diff against the base branch, cut short past SENT_BACK_DIFF_LIMIT).
 * Nobody else's comments are included.
 */
export async function readSentBack(github: Reader, repo: Repo, sentBack: SentBack, operator: string): Promise<unknown> {
  const path = `/repos/${repo.owner}/${repo.name}/pulls/${sentBack.pullRequest}`;
  const pullRequest = (await github.rest("GET", path)) as {
    number: number;
    title: string;
    base: { ref: string };
    head: { ref: string; sha: string };
  };
  const byOperator = sentBack.verdictUrl === null;
  const [verdicts, operatorReviews, operatorComments, commits, files] = await Promise.all([
    byOperator ? [] : verdictsOn(github, repo, sentBack.pullRequest),
    byOperator ? operatorReviewsOn(github, path, operator) : [],
    readOperatorComments(github, repo, sentBack.pullRequest, operator),
    allPages<{ sha: string; commit: { message: string } }>(github, `${path}/commits`),
    allPages<{ filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string }>(
      github,
      `${path}/files`,
    ),
  ]);
  const fullDiff = files
    .map((file) =>
      [
        `diff --git a/${file.previous_filename ?? file.filename} b/${file.filename}`,
        file.patch ?? "(No textual diff: a binary file, or too large for GitHub to show.)",
      ].join("\n"),
    )
    .join("\n");
  const truncated = fullDiff.length > SENT_BACK_DIFF_LIMIT;
  return {
    pullRequest: {
      number: pullRequest.number,
      title: pullRequest.title,
      baseRefName: pullRequest.base.ref,
      headRefName: pullRequest.head.ref,
      headRefOid: pullRequest.head.sha,
    },
    sentBackBy: byOperator ? "operator" : "verdict",
    verdicts,
    operatorReviews,
    operatorComments,
    commits: commits.map(({ sha, commit }) => ({ sha, message: commit.message })),
    files: files.map(({ filename, status, additions, deletions }) => ({ filename, status, additions, deletions })),
    diff: truncated
      ? `${fullDiff.slice(0, SENT_BACK_DIFF_LIMIT)}\n[Diff truncated at ${SENT_BACK_DIFF_LIMIT} of ${fullDiff.length} characters; every changed file is listed in files.]`
      : fullDiff,
    diffTruncated: truncated,
  };
}

/** Every Verdict the Fabrik App posted on the PR, oldest first, each with its comment, whole but for its change line. */
async function verdictsOn(github: Reader, repo: Repo, pullRequest: number): Promise<GivenVerdict[]> {
  return verdictsAmong(await allPages<Pick<WrittenComment, "body" | "user">>(github, `/repos/${repo.owner}/${repo.name}/issues/${pullRequest}/comments`));
}

/** The Verdicts among a PR's conversation, as verdictsOn gives them. */
export function verdictsAmong(conversation: readonly Pick<WrittenComment, "body" | "user">[]): GivenVerdict[] {
  // Only a bot's markers count, as in the core's snapshot, so nobody can plant a Verdict by quoting one.
  return conversation.flatMap(({ body, user }) => {
    if (user?.type !== "Bot" || body === null) return [];
    const [record] = verdictsIn([body]);
    // Without its change line (#643), which is hashes for Kit code and says nothing to an agent.
    return record === undefined ? [] : [{ verdict: record.verdict, source: record.source, headSha: record.headSha, comment: withoutChangeLines(body) }];
  });
}

/** The Operator's submitted reviews on the PR, oldest first, each with its inline comments. */
async function operatorReviewsOn(github: Reader, path: string, operator: string): Promise<unknown[]> {
  const reviews = await allPages<WrittenReview & { commit_id: string }>(
    github,
    `${path}/reviews`,
  );
  const theirs = reviews.filter((review) => review.user?.login === operator && review.state !== "PENDING");
  return Promise.all(
    theirs.map(async (review) => ({
      state: review.state,
      body: review.body ?? "",
      commitId: review.commit_id,
      submittedAt: review.submitted_at ?? null,
      comments: (
        await allPages<{ path: string; line: number | null; body: string }>(github, `${path}/reviews/${review.id}/comments`)
      ).map(({ path: file, line, body }) => ({ path: file, line, body })),
    })),
  );
}

/**
 * The Operator's comments on the PR, oldest first, each as it stands now: its
 * conversation comments, its inline review comments, and the bodies of its
 * reviews that aren't Request changes (nor still pending, nor empty). Every
 * page of each list is read. Bots' comments and other humans' are left out,
 * so commenting on a PR can't steer an agent (ADR-0007).
 */
export async function readOperatorComments(
  github: Reader,
  repo: Repo,
  pullRequest: number,
  operator: string,
): Promise<OperatorComment[]> {
  return (await readOperatorFeedback(github, repo, pullRequest, operator)).operatorComments;
}

/**
 * What the Operator wrote on the PR: its comments, as readOperatorComments
 * gives them, and its Request changes reviews, oldest first, each with its
 * own inline comments (which stay among the comments too) and kept even when
 * its body is empty. Those amend the Ticket for the PR (ADR-0010). Other
 * people's reviews, and the Operator's still pending, are left out. Which
 * reviews are the Operator's Request changes, and which line comments are in
 * each, is the one rule a Digest's asks are read by too
 * (operatorsRequestChangesIn). `written` is everything written on the PR,
 * when the caller has read it already. And the points of those Request
 * changes the Kit opened as Spin-offs (#884), read from the marker lines of
 * the Kit's notes on the PR, each with the Operator's words it came from.
 * Only a bot's note counts, as this job takes any bot for the App (byAppOf),
 * so nobody plants one by quoting a marker.
 */
async function readOperatorFeedback(
  github: Reader,
  repo: Repo,
  pullRequest: number,
  operator: string,
  deferred: readonly number[] = [],
  written?: WrittenOn,
): Promise<{ operatorComments: OperatorComment[]; requestedChanges: RequestedChange[]; spinOffs: SetAsidePoint[] }> {
  const all = written ?? (await readWrittenOn(github, repo, pullRequest));
  const { conversation, lineComments: inline, reviews } = all;
  const theirs = writtenBy(operator);
  // A review deferred while a Retry was in flight (#427), and its inline comments, aren't this run's to read.
  const notDeferred = (one: Written & { pull_request_review_id?: number | null }): boolean =>
    !deferred.includes(one.id) && (one.pull_request_review_id == null || !deferred.includes(one.pull_request_review_id));
  const comments: OperatorComment[] = [
    ...conversation.filter(theirs).map((c) => ({
      id: operatorCommentId("conversation", c.id),
      url: c.html_url,
      where: { kind: "conversation" as const },
      createdAt: c.created_at,
      body: c.body ?? "",
    })),
    ...inline.filter((c) => theirs(c) && notDeferred(c)).map((c) => ({
      id: operatorCommentId("inline", c.id),
      url: c.html_url,
      where: { kind: "inline" as const, path: c.path, line: lineOf(c) },
      createdAt: c.created_at,
      body: c.body ?? "",
    })),
    ...reviews
      .filter((r) => theirs(r) && r.state !== "CHANGES_REQUESTED" && r.state !== "PENDING" && (r.body ?? "").trim() !== "")
      .map((r) => ({
        id: operatorCommentId("review", r.id),
        url: r.html_url,
        where: { kind: "review" as const, state: r.state },
        createdAt: r.submitted_at ?? "",
        body: r.body ?? "",
      })),
  ];
  // One dismissed since no longer says what it asked, so no run is given it.
  const requestedChanges: RequestedChange[] = operatorsRequestChangesIn(all, operator)
    .filter(({ review, dismissed }) => !dismissed && notDeferred(review))
    .map(({ review: r, lineComments }) => ({
      id: operatorCommentId("review", r.id),
      url: r.html_url,
      submittedAt: r.submitted_at ?? "",
      body: r.body ?? "",
      comments: lineComments.map((c) => ({
        id: operatorCommentId("inline", c.id),
        url: c.html_url,
        path: c.path,
        line: lineOf(c),
        body: c.body ?? "",
      })),
    }));
  const opened = openedSpinOffsAmong(conversation.filter(({ user }) => user?.type === "Bot").map(({ body }) => body ?? ""));
  return { operatorComments: comments.sort(byTime((c) => c.createdAt)), requestedChanges, spinOffs: setAsidePoints(opened, requestedChanges) };
}

const PULL_REQUEST_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        number
        title
        body
        baseRefName
        headRefName
        headRefOid
        comments(last: 100) { nodes { body author { __typename } } }
      }
    }
  }
`;

interface PullRequestQueryResult {
  repository: {
    pullRequest: {
      number: number;
      title: string;
      body: string;
      baseRefName: string;
      headRefName: string;
      headRefOid: string;
      comments: { nodes: { body: string; author: { __typename: string } | null }[] };
    } | null;
  };
}

/**
 * The PR: for a Review, what it judges (never its other comments: only a later
 * Review is given its earlier Verdicts and fix comments, apart, by src/agent/laterReview.ts);
 * for a retry, its number, title, body and comments with
 * their authors' kind, so only the Fabrik App's Verdicts count as findings.
 * Either way, the Operator's comments on it come apart, in `operatorComments`,
 * and, on a PR the Operator requested changes on, its Request changes reviews
 * in `requestedChanges`, which amend the Ticket (ADR-0010). Those `deferred`
 * while a Retry was in flight (#427) are left out, with their inline comments:
 * the Verdict that ends the Retry gives way to them, so its Review never
 * judges against them, nor does a Retry build them. `written` is everything
 * written on the PR, when the caller has read it already (readWrittenOn).
 */
export async function readPullRequest(
  github: Reader,
  repo: Repo,
  number: number,
  {
    withComments,
    operator,
    deferred = [],
    written,
  }: { readonly withComments: boolean; readonly operator: string; readonly deferred?: readonly number[]; readonly written?: WrittenOn },
): Promise<unknown> {
  const [data, { operatorComments, requestedChanges, spinOffs }] = await Promise.all([
    github.graphql<PullRequestQueryResult>(PULL_REQUEST_QUERY, { owner: repo.owner, name: repo.name, number }),
    readOperatorFeedback(github, repo, number, operator, deferred, written),
  ]);
  const pullRequest = data.repository.pullRequest;
  if (pullRequest === null) throw new Error(`Pull request #${number} not found`);
  const { title, body, baseRefName, headRefName, headRefOid, comments } = pullRequest;
  // Only a PR the Operator requested changes on carries them, so every other PR's input is as it always was. Likewise
  // the points of them the Kit opened as Spin-offs (#884), which every later run and Review is given.
  const amended = { ...(requestedChanges.length === 0 ? {} : { requestedChanges }), ...(spinOffs.length === 0 ? {} : { spinOffs }) };
  // A Verdict among the comments keeps its marker and loses its change line (#643), which says nothing to an agent.
  const kept = comments.nodes.map((comment) => ({ ...comment, body: withoutChangeLines(comment.body) }));
  return withComments
    ? { number, title, body, comments: kept, operatorComments, ...amended }
    : { number, title, body, baseRefName, headRefName, headRefOid, operatorComments, ...amended };
}

/** A Verdict as the Digest writer is given it: what it was, who gave it, the head it judged, and its whole comment. */
export interface GivenVerdict {
  readonly verdict: string;
  readonly source: string;
  readonly headSha: string;
  readonly comment: string;
}

/** The pull request as the Digest writer is given it (ADR-0022). */
export interface DigestPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** The branch it merges into, which the writer reads the change against. */
  readonly baseRefName: string;
  /** The Operator's comments, as the Reviewer is given them. */
  readonly operatorComments: readonly OperatorComment[];
  /** The Operator's Request changes with their line comments, as the Reviewer is given them; absent when there are none. */
  readonly requestedChanges?: readonly RequestedChange[];
  /** The points of those Request changes the Kit opened as Spin-offs (#884), as the Reviewer is given them; absent when there are none. */
  readonly spinOffs?: readonly SetAsidePoint[];
  /** Every Verdict the Fabrik App gave it, oldest first. */
  readonly verdicts: readonly GivenVerdict[];
  /** The Kit's own notes on its thread, oldest first: every comment of the Kit's that is no Verdict, held lines left out. */
  readonly kitNotes: readonly string[];
  /** Whether its body's evidence marker names screenshots its Implement run kept. */
  readonly uiEvidence: boolean;
  /**
   * The routes its UI evidence captured, as its body's evidence marker names
   * them, in the marker's order (capturedRoutesOf): the routes an item may
   * name as its picture. None with no UI evidence, and with a marker that
   * names no routes, as one written before markers recorded them.
   */
  readonly capturedRoutes: readonly string[];
  /**
   * On a pull request whose UI evidence is Evidence shots, the named shots
   * the check's run produced, in the names' order (digestPicturesOf): the
   * only names an item may name as its picture, in place of captured routes.
   * Read from the shots marker only in a body the Fabrik App wrote, and
   * absent on any other pull request, so a route pull request's input is as
   * it was.
   */
  readonly producedShots?: readonly string[];
  /** Kit code's facts, worked out from its thread (src/loop/digestFacts.ts), which the writer words and never contradicts. */
  readonly facts: DigestFacts;
}

/**
 * The PR as the Digest writer is given it: its title, body and base branch;
 * the Operator's Request changes with their line comments and the Operator's
 * comments, as readPullRequest gives a Reviewer them, `deferred` ones left
 * out; every Verdict with the head it judged; the Kit's own notes on the
 * thread, oldest first, among its latest hundred comments; whether UI
 * evidence exists; and the routes it captured, as the evidence marker names
 * them, or, on a pull request whose UI evidence is Evidence shots, the named
 * shots that were produced, as the shots marker says, each read only from a
 * body a bot wrote, as the push job reads them again to check each
 * item's picture against. Nobody else's words are in it, and nothing from the run
 * store: no transcript and no Run record. The Verdicts and the notes come
 * only from what readPullRequest and verdictsOn hand back, so whatever those
 * keep from an agent is kept from this one. Beside them go Kit code's facts,
 * worked out from the thread as the push job reads it again to render the
 * Digest (readDigestThread): they are counts and names of Kit code's own,
 * so a Verdict's fingerprint is behind them and its hidden line is not in them.
 *
 * What was written on the PR is read once (readWrittenOn), and the
 * Operator's words, the Verdicts and the facts are all worked out from that
 * one read: the asks among the facts are then the very Request changes and
 * line comments the writer's input heads, id for id.
 */
export async function readDigestPullRequest(
  github: Reader,
  repo: Repo,
  number: number,
  { operator, deferred = [] }: { readonly operator: string; readonly deferred?: readonly number[] },
): Promise<DigestPullRequest> {
  const written = await readWrittenOn(github, repo, number);
  const [read, rest, thread] = await Promise.all([
    readPullRequest(github, repo, number, { withComments: true, operator, deferred, written }),
    github.rest("GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`),
    readDigestThread(github, repo, number, operator, deferred, written),
  ]);
  const verdicts = verdictsAmong(written.conversation);
  // Only a body a bot wrote counts, as the push job's read of the Loop's snapshot takes it (digestSnapshotOn), so nobody
  // else can name a route as captured or a shot as produced. This job holds no App token, so it knows no App login.
  const openedBy = (rest as { user?: { type?: string } | null }).user;
  const byApp = openedBy?.type === "Bot";
  const shots = byApp ? shotsMarkerIn((read as { body: string }).body) : null;
  const routes = byApp ? evidenceMarkerIn((read as { body: string }).body) : null;
  const { comments, ...pullRequest } = read as Pick<DigestPullRequest, "number" | "title" | "body" | "operatorComments" | "requestedChanges" | "spinOffs"> & {
    comments: { body: string; author: { __typename: string } | null }[];
  };
  return {
    ...pullRequest,
    baseRefName: (rest as { base: { ref: string } }).base.ref,
    verdicts,
    // Only a bot's comments are the Kit's, as only a bot's markers are read; its Verdicts are given apart, whole.
    kitNotes: comments.filter(({ body, author }) => author?.__typename === "Bot" && verdictsIn([body]).length === 0).map(({ body }) => body),
    uiEvidence: (routes?.artifact ?? null) !== null,
    capturedRoutes: capturedRoutesOf(routes),
    ...(shots === null ? {} : { producedShots: digestPicturesOf(null, shots).pictures }),
    facts: digestFactsOf(thread),
  };
}

/** The Operator's review requesting changes, its inline comments included. */
export async function readReview(github: Reader, repo: Repo, pullRequest: number, review: number): Promise<unknown> {
  const path = `/repos/${repo.owner}/${repo.name}/pulls/${pullRequest}/reviews/${review}`;
  const comments = await allPages<unknown>(github, `${path}/comments`);
  return { review: await github.rest("GET", path), comments };
}

// --- A Design-session turn's Map inputs (#154) -------------------------------

/** Where the inputs step writes what a Design-session turn is told of the Map cap, beside issue.json. */
export const MAP_INPUTS_FILE = "map.json";

/** What a Design-session turn is told of the Map cap (src/loop/mapCap.ts), each open Map named by its number and title. */
export type MapOffer = MapOfferOf<OpenMap>;

/**
 * Whether this turn may offer a Map, by the Map cap's own predicate
 * (mapOfferOf), which refuses as the push job's landing does
 * (src/loop/design.ts): never on a Ticket under `spec`, its parent, nor on
 * the Check's issue for `check` (#839), for both of which it reads no open
 * Maps; otherwise while the open Maps leave the cap room. So the turn isn't
 * asked a question the Operator can't say yes to.
 */
export async function readMapOffer(
  github: Pick<Reader, "graphql">,
  repo: Repo,
  config: Pick<KitConfig, "caps">,
  spec: { readonly number: number } | null,
  check: string | null = null,
): Promise<MapOffer> {
  const readsMaps = spec === null && check === null;
  return mapOfferOf(spec?.number ?? null, check, readsMaps ? await gatherOpenMaps(github, repo) : [], config);
}

// --- A Design-session turn's Spec Tickets (#475) ---------------------------

/** Where the inputs step writes a Design-session turn's Spec's other Tickets (readIssue's otherTickets), beside issue.json. */
export const SPEC_TICKETS_FILE = "spec-tickets.json";

// --- A Design-session turn's open Tickets (#825) ----------------------------

/** Where the inputs step writes a Design-session turn's open Tickets outside its own Spec, beside issue.json. */
export const OPEN_TICKETS_FILE = "open-tickets.json";

/**
 * An open Ticket outside the issue's own Spec, as a Design session is given
 * it (#825): its Spec, or null for a Fast-path Ticket, its state label, and
 * its pull request, chosen as a SpecTicket's is.
 */
export interface OpenTicket {
  readonly number: number;
  readonly title: string;
  readonly spec: number | null;
  readonly stateLabel: StateLabel | null;
  readonly pullRequest: SpecTicket["pullRequest"];
}

/** An open issue as the open-Tickets read takes it from GitHub, before it is known to be a Ticket. */
export interface OpenTicketNode {
  number: number;
  title: string;
  labels: { nodes: { name: string }[] };
  parent: { number: number } | null;
  subIssues: { totalCount: number };
  closedByPullRequestsReferences: { nodes: { number: number; state: "OPEN" | "CLOSED" | "MERGED" }[] };
}

const OPEN_TICKET_FIELDS = `
  number
  title
  labels(first: 100) { nodes { name } }
  parent { number }
  subIssues { totalCount }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number state } }
`;

/** The open issues, newest created first, with what tells a Ticket from any other issue. */
const OPEN_TICKETS_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { ${OPEN_TICKET_FIELDS} }
      }
    }
  }
`;

/** A Spec's sub-issues, open and closed, newest created first. */
const SPEC_SUB_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        subIssues(first: 100) { nodes { state ${OPEN_TICKET_FIELDS} } }
      }
    }
  }
`;

/**
 * Whether an open issue is a Ticket an Implementer can build: ready-for-agent,
 * with no sub-issues of its own, as a Spec has, and none of the Kit's own
 * labels. Operator steps, Decisions and Maps carry no ready-for-agent.
 */
function isOpenTicket(node: OpenTicketNode): boolean {
  const labels = node.labels.nodes.map(({ name }) => name);
  return labels.includes(READY_FOR_AGENT) && node.subIssues.totalCount === 0 && !labels.some((label) => (KIT_ISSUE_LABELS as readonly string[]).includes(label));
}

function openTicketOf(node: OpenTicketNode): OpenTicket {
  return {
    number: node.number,
    title: node.title,
    spec: node.parent?.number ?? null,
    stateLabel: stateLabelOf(node.labels.nodes),
    pullRequest: pullRequestOf(node.closedByPullRequestsReferences.nodes),
  };
}

/**
 * What a Design-session turn on `issue` is told of the open Tickets in the
 * repo outside its own `spec` (#825): the RECENT_ISSUES_CAP most recently
 * created, newest first, Fast-path ones and those blocked from starting
 * among them, without the issue itself. Every open Ticket under the Spec
 * `follows` names, the one its body's Follows line names, is kept past the
 * cap, after the others. Everything here is data for the session, never
 * instructions to it.
 */
export async function readOpenTickets(
  github: Pick<Reader, "graphql">,
  repo: Repo,
  { issue, spec, follows }: { readonly issue: number; readonly spec: number | null; readonly follows: number | null },
): Promise<OpenTicket[]> {
  const elsewhere = (node: OpenTicketNode): boolean => isOpenTicket(node) && node.number !== issue && (spec === null || node.parent?.number !== spec);
  let ticketsRead = 0;
  const capReached = (page: readonly OpenTicketNode[]): boolean => {
    ticketsRead += page.filter(elsewhere).length;
    return ticketsRead >= RECENT_ISSUES_CAP;
  };
  const open = await pagesOf<OpenTicketNode>(github, OPEN_TICKETS_QUERY, repo, {}, (data) => data.repository.issues, capReached);
  const recent = open.filter(elsewhere).slice(0, RECENT_ISSUES_CAP);
  if (follows === null || follows === spec) return recent.map(openTicketOf);
  const data = await github.graphql<{ repository: { issue: { subIssues: { nodes: (OpenTicketNode & { state: string })[] } } | null } }>(SPEC_SUB_ISSUES_QUERY, {
    owner: repo.owner,
    name: repo.name,
    number: follows,
  });
  const listed = new Set(recent.map(({ number }) => number));
  const followed = (data.repository.issue?.subIssues.nodes ?? [])
    .filter((node) => node.state === "OPEN" && elsewhere(node) && !listed.has(node.number))
    .sort((a, b) => b.number - a.number);
  return [...recent, ...followed].map(openTicketOf);
}

/**
 * Writes what only a Design-session turn is given of its issue's body, on a
 * Design turn alone: the open Tickets outside its own Spec (#825), reading the
 * Spec its Follows line names, and the pull request its `From PR` line names,
 * or that there is none (#659), read afresh on every turn and always written.
 * A prototype turn's job runs this step as the Design role too, and hands its
 * agent nothing of either file.
 */
export async function writeDesignInputs(
  github: Reader,
  repo: Repo,
  outDir: string,
  role: string | undefined,
  issue: { readonly number: number; readonly body: string; readonly spec: { readonly number: number } | null; readonly spinOff?: SpinOffSource | null },
): Promise<void> {
  if (role !== "design") return;
  const openTickets = await readOpenTickets(github, repo, { issue: issue.number, spec: issue.spec?.number ?? null, follows: followsSpecIn(issue.body) });
  await writeFile(join(outDir, OPEN_TICKETS_FILE), JSON.stringify(openTickets));
  await writeFile(join(outDir, FILED_FROM_FILE), JSON.stringify(await readFiledFrom(github, repo, issue.body, issue.spinOff ?? null)));
}

// --- The pull request a Design-session turn's issue was filed from (#659) -----

/** Where the inputs step writes the pull request a Design-session turn's issue was filed from, beside issue.json. */
export const FILED_FROM_FILE = "filed-from.json";

/**
 * The pull request an issue's `From PR` line names, as a Design-session turn
 * is told of it: where it stands, and its description. None when the body has
 * no such line outside code, or the line names no pull request in this repo:
 * an issue's number, or a number that doesn't exist.
 */
export type FiledFrom =
  | { readonly kind: "none" }
  | {
      readonly kind: "pull-request";
      readonly number: number;
      readonly title: string;
      readonly body: string;
      readonly state: "open" | "merged" | "closed";
      readonly draft: boolean;
      readonly headSha: string;
      readonly headRef: string;
      readonly baseRef: string;
      /** Whether it is an agent pull request, by the Kit's own test (isAgentPullRequest). */
      readonly isAgent: boolean;
      /**
       * On a Spin-off the Operator asked, in a Request changes on this pull
       * request, to be an issue of its own (#884): true, so no Roll-in back
       * onto it is on offer. Absent on every other issue.
       */
      readonly setAside?: true;
    };

/**
 * FILED_FROM_FILE's FiledFrom as its readers take it, the turn's prompt and
 * the Design job's fetch (#660), or an error: neither guesses where the pull
 * request stands from a file it can't read.
 */
export function filedFromOf(value: unknown): FiledFrom {
  const read = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (read["kind"] === "none") return { kind: "none" };
  const { number, title, body, state, draft, headSha, headRef, baseRef, isAgent } = read;
  if (
    read["kind"] === "pull-request" &&
    typeof number === "number" &&
    typeof title === "string" &&
    typeof body === "string" &&
    (state === "open" || state === "merged" || state === "closed") &&
    typeof draft === "boolean" &&
    typeof headSha === "string" &&
    typeof headRef === "string" &&
    typeof baseRef === "string" &&
    typeof isAgent === "boolean"
  ) {
    return { kind: "pull-request", number, title, body, state, draft, headSha, headRef, baseRef, isAgent, ...(read["setAside"] === true ? { setAside: true } : {}) };
  }
  throw new Error(`${FILED_FROM_FILE} doesn't say which pull request this issue was filed from`);
}

/** A pull request as the REST API returns it: the fields a FiledFrom is read from. */
interface RestFiledFrom {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged: boolean;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { type: string } | null;
}

/**
 * The pull request the first `From PR` line outside code in `issueBody`
 * names (fromPullRequestIn), read afresh on every turn. A body with no such
 * line reads nothing. GitHub answers 404 for a number that is an issue's or
 * that doesn't exist, which is no failure: the turn runs as it would with no
 * line. Any other failed read throws, and fails the turn before its agent
 * starts. `spinOff` is where the issue came from when it is a Spin-off
 * (readIssue): one set aside from a Request changes on the very pull request
 * the line names is marked so (#884), since the Operator asked for its work
 * to be apart from that pull request.
 */
export async function readFiledFrom(github: Pick<Reader, "rest">, repo: Repo, issueBody: string, spinOff: SpinOffSource | null = null): Promise<FiledFrom> {
  const number = fromPullRequestIn(issueBody);
  if (number === null) return { kind: "none" };
  const pull = (await github.rest("GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`, undefined, { allowNotFound: true })) as RestFiledFrom | null;
  if (pull === null) return { kind: "none" };
  return {
    kind: "pull-request",
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    state: pull.merged ? "merged" : pull.state === "open" ? "open" : "closed",
    draft: pull.draft === true,
    headSha: pull.head.sha,
    headRef: pull.head.ref,
    baseRef: pull.base.ref,
    // This job doesn't know the App's login, so any bot's pull request from an agent branch is an agent pull request.
    isAgent: isAgentPullRequest({ headRef: pull.head.ref, authorIsBot: pull.user?.type === "Bot" }),
    ...(spinOff?.from === "request-changes" && spinOff.pullRequest === pull.number ? { setAside: true as const } : {}),
  };
}

// --- Triage's Recent issues (#363) ------------------------------------------

/** Where the inputs step writes Triage's Recent issues, beside issue.json. */
export const RECENT_ISSUES_FILE = "recent-issues.json";

/** One issue Triage compares a new one against, for a duplicate. */
export interface RecentIssue {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  /** The first RECENT_ISSUE_BODY_CHARS characters of its body, marked with … when cut. */
  readonly body: string;
}

/** How many issues Triage compares against: the most recently created. */
export const RECENT_ISSUES_CAP = 50;
/** How far back a closed issue still counts. */
export const RECENT_CLOSED_DAYS = 30;
/** How much of each body Triage is given. */
export const RECENT_ISSUE_BODY_CHARS = 500;

export interface RecentIssueNode {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** The open issues, newest created first. */
const RECENT_OPEN_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { number title body createdAt updatedAt closedAt }
      }
    }
  }
`;

/** The closed issues, latest updated first: one closed since a time was updated since then too. */
const RECENT_CLOSED_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: CLOSED, first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { number title body createdAt updatedAt closedAt }
      }
    }
  }
`;

function cut(body: string): string {
  const chars = Array.from(body);
  return chars.length <= RECENT_ISSUE_BODY_CHARS ? body : `${chars.slice(0, RECENT_ISSUE_BODY_CHARS).join("")}…`;
}

/**
 * What a Triage run compares its issue against for a duplicate: every open
 * issue and every issue closed in the last 30 days, the 50 most recently
 * created, newest first, without the triaged issue. GitHub's issues
 * connection holds no pull requests. Issues the Monitor filed stay in, since
 * a person re-reporting one is the likeliest duplicate. Everything here is
 * data for Triage, never instructions to it.
 */
export async function readRecentIssues(github: Pick<Reader, "graphql">, repo: Repo, issue: number, now: number): Promise<RecentIssue[]> {
  const since = now - RECENT_CLOSED_DAYS * DAY_MS;
  // Newest created first, so one more than the cap is enough whichever is the triaged issue.
  let openRead = 0;
  const enoughOpen = (page: readonly RecentIssueNode[]): boolean => {
    openRead += page.length;
    return openRead > RECENT_ISSUES_CAP;
  };
  const open = await pagesOf<RecentIssueNode>(github, RECENT_OPEN_ISSUES_QUERY, repo, {}, (data) => data.repository.issues, enoughOpen);
  // Read until a page reaches an issue last updated before `since`: none after it was closed since.
  const closed = await pagesOf<RecentIssueNode>(
    github,
    RECENT_CLOSED_ISSUES_QUERY,
    repo,
    {},
    (data) => data.repository.issues,
    (page) => page.some(({ updatedAt }) => Date.parse(updatedAt) < since),
  );
  return [
    ...open.map((node) => ({ node, state: "open" as const })),
    ...closed.filter(({ closedAt }) => closedAt !== null && Date.parse(closedAt) >= since).map((node) => ({ node, state: "closed" as const })),
  ]
    .filter(({ node }) => node.number !== issue)
    .sort((a, b) => Date.parse(b.node.createdAt) - Date.parse(a.node.createdAt))
    .slice(0, RECENT_ISSUES_CAP)
    .map(({ node, state }) => ({ number: node.number, title: node.title, state, body: cut(node.body) }));
}

// --- An Auditor run's inputs (#150) -----------------------------------------

/** The Audit an Auditor run fills in: the pending one, at the commit its audit marker names. */
export interface PendingAudit {
  readonly number: number;
  /** The marked commit, which the job checks out. */
  readonly commit: string;
}

/** An agent PR merged in the hot-spot window, which is all the Auditor may name under "Introduced by". */
export interface MergedAgentPullRequest {
  readonly number: number;
  readonly title: string;
  readonly mergeCommit: string | null;
  readonly headRefName: string;
  readonly mergedAt: string;
  /** The repo paths it changed. */
  readonly files: readonly string[];
}

/** One of the last closed Audits that had candidates, which the Auditor doesn't repeat itself against. */
export interface ClosedAudit {
  readonly number: number;
  readonly title: string;
  readonly commit: string | null;
  /** How the Operator closed it: completed when they filed something, not planned otherwise. */
  readonly closedAs: AuditIssueSnapshot["stateReason"];
  /** The filled Audit, its candidates' cards included. */
  readonly body: string;
  /** What the Operator wrote on it, oldest first: context, never a trigger (ADR-0007). */
  readonly operatorComments: readonly { readonly url: string; readonly createdAt: string; readonly body: string }[];
}

/** An open issue filed from an Audit, whose candidate the Auditor skips while it's open. */
export interface FiledCandidate {
  readonly number: number;
  readonly title: string;
  /** The Audit its `From audit #n` line names. */
  readonly fromAudit: number;
  readonly body: string;
}

/** Where the inputs step writes an Auditor run's inputs, beside issue.json. */
export const AUDIT_INPUTS_FILE = "audit.json";

/** What an Auditor run is given beyond the pending Audit's own issue, written to AUDIT_INPUTS_FILE. */
export interface AuditInputs {
  /** The pending Audit, which the Auditor's prompt names with its marked commit. */
  readonly audit: PendingAudit;
  /** The hot-spot window, which the agent job copies into its result for the landing to name. */
  readonly window: AuditWindow;
  /** The files merged agent PRs keep changing with no doc changed beside them (src/agent/comprehensionDrift.ts). */
  readonly drift: readonly DriftFile[];
  readonly closedAudits: readonly ClosedAudit[];
  readonly filedCandidates: readonly FiledCandidate[];
  readonly pullRequests: readonly MergedAgentPullRequest[];
}

/** How many closed Audits the Auditor weighs the Operator's rejections from. */
const CLOSED_AUDITS = 3;

const MERGED_PULL_REQUESTS_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: MERGED, first: 50, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { number title mergedAt updatedAt headRefName author { __typename } mergeCommit { oid } }
      }
    }
  }
`;

interface MergedPullRequestNode {
  number: number;
  title: string;
  mergedAt: string;
  updatedAt: string;
  headRefName: string;
  author: { __typename: string } | null;
  mergeCommit: { oid: string } | null;
}

const OPEN_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { number title body }
      }
    }
  }
`;

const DAY_MS = 86_400_000;

/** How far back the window falls back to, from the pending Audit. */
const FALLBACK_DAYS = 30;

/** Whether `from` is an ancestor of `to` on GitHub; a commit GitHub no longer has (a force-push) isn't. */
async function isAncestor(github: Reader, repo: Repo, from: string, to: string): Promise<boolean> {
  const path = `/repos/${repo.owner}/${repo.name}/compare/${from}...${to}?per_page=1`;
  const comparison = (await github.rest("GET", path, undefined, { allowNotFound: true })) as { status?: string } | null;
  return comparison?.status === "ahead" || comparison?.status === "identical";
}

/**
 * What an Auditor run is given, read through the job's read-only token, for
 * the pending Audit at its marked commit:
 * - the hot-spot window, from the last Audit's commit to the marked commit, or
 *   the 30 days before the pending Audit on a first run or when that commit
 *   isn't an ancestor of the marked one (a force-push);
 * - the comprehension drift over those 30 days;
 * - the last 3 closed Audits that had candidates, with the Operator's comments;
 * - the open issues filed from an Audit, by their `From audit #n` line;
 * - the agent PRs merged in the window, with their changed files.
 * Only Audits the Fabrik App opened count, as the audit gate counts them,
 * and a failed one is never the last Audit (src/loop/audit.ts). Everything
 * here is data for the Auditor, never instructions to it.
 */
export async function readAuditInputs(github: Reader, repo: Repo, audit: PendingAudit, operator: string): Promise<AuditInputs> {
  // The job holds no Fabrik App token, so it takes the bot that opened the pending Audit for the App (gatherAuditSliceFor).
  const { issues } = await gatherAuditSliceFor(github, repo, audit.number);
  const audits = auditsIn(issues);
  const pendingAudit = audits.find((each) => each.number === audit.number);
  if (pendingAudit === undefined) throw new Error(`Audit #${audit.number} isn't an Audit the Fabrik App opened`);
  const openedAt = pendingAudit.createdAt;
  const last = lastAudit(issues.filter((issue) => issue.number !== audit.number));

  // The window starts at the last Audit's commit, when the tick opened it, or 30 days back.
  const window = await windowOf(github, repo, last, audit.commit);
  const until = Date.parse(openedAt);
  const since = window.kind === "since-audit" && last !== null ? Date.parse(last.createdAt) : until - FALLBACK_DAYS * DAY_MS;
  // The agent PRs merged in the window, or in the 30 days drift looks back over, whichever reaches further.
  const earliest = Math.min(since, until - DRIFT_DAYS * DAY_MS);
  const merged = await pagesOf<MergedPullRequestNode>(
    github,
    MERGED_PULL_REQUESTS_QUERY,
    repo,
    {},
    (data) => data.repository.pullRequests,
    (page) => page.some((pr) => Date.parse(pr.updatedAt) < earliest),
  );
  const byApp = (pr: MergedPullRequestNode): boolean => pr.author?.__typename === "Bot";
  const agentPullRequests = await Promise.all(
    merged
      .filter((pr) => {
        const at = Date.parse(pr.mergedAt);
        return at >= earliest && at <= until && isAgentPullRequest({ headRef: pr.headRefName, authorIsBot: byApp(pr) });
      })
      .map(async (pr) => {
        const changed = await allPages<{ filename: string }>(github, `/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/files`);
        return { pr, files: changed.map((file) => file.filename) };
      }),
  );
  const drift = comprehensionDrift(
    agentPullRequests.map(({ pr, files }) => ({ mergedAt: pr.mergedAt, headRef: pr.headRefName, authorIsBot: byApp(pr), files })),
    openedAt,
  );
  const pullRequests = agentPullRequests
    .filter(({ pr }) => Date.parse(pr.mergedAt) > since)
    .map(({ pr, files }) => ({
      number: pr.number,
      title: pr.title,
      mergeCommit: pr.mergeCommit?.oid ?? null,
      headRefName: pr.headRefName,
      mergedAt: pr.mergedAt,
      files,
    }));
  const closedAudits = await Promise.all(
    audits
      .filter((each) => !each.open && each.filled)
      .slice(0, CLOSED_AUDITS)
      .map(async ({ number, commit }) => {
        const issue = issues.find((each) => each.number === number);
        return {
          number,
          title: issue?.title ?? "",
          commit,
          closedAs: issue?.stateReason ?? null,
          body: issue?.body ?? "",
          operatorComments: await operatorCommentsOnIssue(github, repo, number, operator),
        };
      }),
  );
  const open = await pagesOf<{ number: number; title: string; body: string }>(github, OPEN_ISSUES_QUERY, repo, {}, (data) => data.repository.issues);
  const filedCandidates = open.flatMap(({ number, title, body }) => {
    const fromAudit = fromAuditIn(body);
    return fromAudit === null ? [] : [{ number, title, fromAudit, body }];
  });
  return { audit, window, drift, closedAudits, filedCandidates, pullRequests };
}

/** The Operator's comments on an issue, oldest first; bots' and other people's are left out. */
async function operatorCommentsOnIssue(
  github: Reader,
  repo: Repo,
  issue: number,
  operator: string,
): Promise<ClosedAudit["operatorComments"]> {
  const comments = await allPages<WrittenComment>(github, `/repos/${repo.owner}/${repo.name}/issues/${issue}/comments`);
  return comments
    .filter(writtenBy(operator))
    .map((comment) => ({ url: comment.html_url, createdAt: comment.created_at, body: comment.body ?? "" }));
}

/**
 * What changed since the last Audit's commit, up to the marked commit; or the
 * 30 days up to the marked commit on a first run, or when that commit isn't
 * an ancestor of the marked one (a force-push).
 */
async function windowOf(github: Reader, repo: Repo, last: Audit | null, to: string): Promise<AuditWindow> {
  if (last === null || last.commit === null || !(await isAncestor(github, repo, last.commit, to))) {
    return { kind: "last-days", days: FALLBACK_DAYS };
  }
  return { kind: "since-audit", audit: last.number, commit: last.commit };
}

function optionalNumber(name: string): number | null {
  const text = process.env[name] ?? "";
  if (text === "") return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} is not a number`);
  return n;
}

/** Where the agent job checks out the Product repo, beside the Kit at kit/. */
const PRODUCT_DIR = "product";

/**
 * The client every agent's inputs are read through. No agent is handed a
 * held line (#471), and no agent run is given a Digest or a no-Digest line
 * (ADR-0022), the Digest writer's own included: both are left out of every
 * GraphQL answer, which is how these reads take a thread's comments.
 */
export function agentInputsClient<Client extends Pick<Reader, "graphql">>(github: Client): Client {
  return leavingOutDigests(leavingOutHeldLines(github));
}

async function main(outDir: string): Promise<void> {
  const [owner, name] = (process.env["GITHUB_REPOSITORY"] ?? "").split("/");
  if (owner === undefined || name === undefined) throw new Error("GITHUB_REPOSITORY is not owner/name");
  const token = process.env["GH_TOKEN"];
  if (token === undefined || token === "") throw new Error("GH_TOKEN is not set");
  const repo = { owner, name };
  const github = agentInputsClient(new GitHub(token, process.env["GITHUB_API_URL"]));
  const issueNumber = optionalNumber("FABRIK_ISSUE");
  if (issueNumber === null) throw new Error("FABRIK_ISSUE is not set");
  const pullRequest = optionalNumber("FABRIK_PULL_REQUEST");
  const review = optionalNumber("FABRIK_REVIEW");
  const auditCommit = process.env["FABRIK_AUDIT_COMMIT"] ?? "";
  if (auditCommit !== "" && !/^[0-9a-f]{40}$/.test(auditCommit)) throw new Error("FABRIK_AUDIT_COMMIT is not a full commit SHA");

  // The Kit config from the Product checkout beside the Kit's. The Operator is
  // its `operator`, as the Loop's snapshot names them, or else the repo's owner.
  const resolved = await readKitConfigFromCheckout(PRODUCT_DIR);
  const operator = (resolved.ok ? resolved.config.operator : null) ?? owner;
  const { issue, body, check, spec, otherTickets } = await readIssue(github, repo, issueNumber, operator);
  await writeFile(join(outDir, "issue.json"), JSON.stringify(issue));
  await writeFile(join(outDir, "spec.json"), JSON.stringify(spec));
  if (process.env["FABRIK_ROLE"] === "design") await writeFile(join(outDir, SPEC_TICKETS_FILE), JSON.stringify(otherTickets));
  // A Spin-off says where it came from (readIssue), which the pull request it was set aside from is read by (#884).
  const spinOff = (issue as { spinOff?: SpinOffSource }).spinOff ?? null;
  await writeDesignInputs(github, repo, outDir, process.env["FABRIK_ROLE"], { number: issueNumber, body, spec, spinOff });
  // A turn on an invalid Kit config fails before its agent starts (src/agent/run.ts), so it's told nothing of Maps.
  if (process.env["FABRIK_ROLE"] === "design" && resolved.ok) {
    await writeFile(join(outDir, MAP_INPUTS_FILE), JSON.stringify(await readMapOffer(github, repo, resolved.config, spec, check)));
  }
  if (process.env["FABRIK_ROLE"] === "triage") {
    await writeFile(join(outDir, RECENT_ISSUES_FILE), JSON.stringify(await readRecentIssues(github, repo, issueNumber, Date.now())));
  }
  if (pullRequest !== null) {
    const withComments = process.env["FABRIK_PULL_REQUEST_COMMENTS"] === "true";
    // A Review or a Retry isn't given the Operator's Request changes deferred while a Retry was in flight (#427); their run is.
    const deferred = review === null ? await deferredChangesRequestsOn(github, repo, pullRequest, operator) : [];
    // The Digest writer is given the PR as no other role is: with every Verdict and the Kit's notes (ADR-0022).
    const given =
      process.env["FABRIK_ROLE"] === "digest"
        ? await readDigestPullRequest(github, repo, pullRequest, { operator, deferred })
        : await readPullRequest(github, repo, pullRequest, { withComments, operator, deferred });
    await writeFile(join(outDir, "pull-request.json"), JSON.stringify(given));
    if (review !== null) await writeFile(join(outDir, "review.json"), JSON.stringify(await readReview(github, repo, pullRequest, review)));
  }
  if (auditCommit !== "") {
    const inputs = await readAuditInputs(github, repo, { number: issueNumber, commit: auditCommit }, operator);
    await writeFile(join(outDir, AUDIT_INPUTS_FILE), JSON.stringify(inputs));
  }
}

/**
 * Leaves the failure report for a failed GitHub call in `failureDir`, so the
 * push job's notice names the request and GitHub's answer rather than a
 * crash. Any other error leaves none, and the push job reads that as a crash.
 */
export async function reportFailure(error: unknown, failureDir: string): Promise<void> {
  const report = inputsFailureReportFor(error);
  if (report === null || failureDir === "") return;
  await mkdir(failureDir, { recursive: true });
  await writeFile(join(failureDir, AGENT_FAILURE_FILE), JSON.stringify(report));
}

if (import.meta.main) {
  const outDir = process.argv[2];
  if (outDir === undefined) {
    console.error("Usage: node src/agent/inputs.ts <out dir>");
    process.exitCode = 2;
  } else {
    main(outDir).catch(async (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
      await reportFailure(error, process.env["FABRIK_OUT_DIR"] ?? "");
    });
  }
}
