// An agent job's first step: reads what its agent is given, through the job's
// own read-only token, into files its prompt is built from (src/agent/run.ts).
// The agent itself never holds a GitHub token.
//   node <kit>/src/agent/inputs.ts <out dir>
// Run beside the Product checkout at product/, whose Kit config names the Operator.
// Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, and
//   FABRIK_ROLE                  the agent's role: a Design-session turn's also writes map.json, whether
//                                it may offer a Map (readMapOffer)
//   FABRIK_ISSUE                 the issue or Ticket: writes issue.json and spec.json (its parent: a Ticket's Spec, a Decision's Map, or null);
//                                a Ticket back in design from an agent PR carries that PR in issue.json's sentBack
//   FABRIK_PULL_REQUEST          optional, a PR: writes pull-request.json, with the Operator's comments on it
//                                in operatorComments (sentBack carries them too, for the closed PR)
//   FABRIK_PULL_REQUEST_COMMENTS "true" for a retry, whose PR file carries the PR's comments and their authors' kind
//   FABRIK_REVIEW                optional, a Request-changes run's review on that PR: writes review.json
//   FABRIK_AUDIT_COMMIT          for an Auditor run, the pending Audit's marked commit (FABRIK_ISSUE is the
//                                Audit): writes audit.json, the Auditor's inputs (readAuditInputs)
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { allPages, GitHub, pagesOf, type Repo } from "../github/client.ts";
import { gatherAuditSliceFor, gatherOpenMaps, type OpenMap } from "../github/snapshot.ts";
import { readKitConfigFromCheckout } from "../kit/checkout.ts";
import { designSessionOf, verdictsIn } from "../github/threads.ts";
import { isAgentPullRequest } from "../loop/agentPullRequest.ts";
import { type Audit, auditsIn, lastAudit } from "../loop/audit.ts";
import type { SentBack } from "../loop/backToDesign.ts";
import { mapCapFull } from "../loop/mapCap.ts";
import { fromAuditIn } from "../loop/markers.ts";
import type { AuditIssueSnapshot, AuditWindow, KitConfig } from "../loop/types.ts";
import { comprehensionDrift, DRIFT_DAYS, type DriftFile } from "./comprehensionDrift.ts";
import { operatorCommentId, type OperatorComment } from "./operatorComments.ts";

/** What these reads need of a GitHub client. */
export type Reader = Pick<GitHub, "graphql" | "rest">;

const ISSUE_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        number
        title
        body
        author { login }
        labels(first: 100) { nodes { name } }
        parent { number title body }
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
      author: { login: string } | null;
      labels: { nodes: { name: string }[] };
      parent: { number: number; title: string; body: string } | null;
      comments: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { author: { login: string; __typename: string } | null; body: string; createdAt: string }[];
      };
    } | null;
  };
}

/**
 * The issue as `gh issue view --json number,title,body,author,labels,comments`
 * shapes it, every comment included, and its parent Spec. When the issue's
 * current Design session follows the Kit's note that the Ticket came back from
 * an agent PR, the issue also carries `sentBack`: what that closed PR was
 * judged on and what it built (see readSentBack).
 */
export async function readIssue(
  github: Reader,
  repo: Repo,
  number: number,
  operator: string,
): Promise<{ issue: unknown; spec: { number: number; title: string; body: string } | null }> {
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
  // Only a bot's note counts, as in the core's snapshot, so quoting one can't fake a return.
  const { sentBack } = designSessionOf(
    comments.map((comment) => ({ body: comment.body, byBot: comment.author?.__typename === "Bot" })),
  );
  return {
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      author: issue.author === null ? { login: "ghost" } : { login: issue.author.login },
      labels: issue.labels.nodes,
      comments: comments.map(({ author, body, createdAt }) => ({ author: author === null ? null : { login: author.login }, body, createdAt })),
      ...(sentBack === null ? {} : { sentBack: await readSentBack(github, repo, sentBack, operator) }),
    },
    spec: issue.parent,
  };
}

type IssueComment = NonNullable<IssueQueryResult["repository"]["issue"]>["comments"]["nodes"][number];

/** Past this many characters, the sent-back PR's diff is cut short; its file list stays whole. */
export const SENT_BACK_DIFF_LIMIT = 60_000;

interface RestUser {
  readonly login: string;
  readonly type: string;
}

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

/** Every Verdict the Fabrik App posted on the PR, oldest first, each with its whole comment. */
async function verdictsOn(github: Reader, repo: Repo, pullRequest: number): Promise<unknown[]> {
  const comments = await allPages<{ body: string; user: RestUser | null }>(
    github,
    `/repos/${repo.owner}/${repo.name}/issues/${pullRequest}/comments`,
  );
  // Only a bot's markers count, as in the core's snapshot, so nobody can plant a Verdict by quoting one.
  return comments.flatMap(({ body, user }) => {
    if (user?.type !== "Bot") return [];
    const [record] = verdictsIn([body]);
    return record === undefined ? [] : [{ verdict: record.verdict, source: record.source, headSha: record.headSha, comment: body }];
  });
}

/** The Operator's submitted reviews on the PR, oldest first, each with its inline comments. */
async function operatorReviewsOn(github: Reader, path: string, operator: string): Promise<unknown[]> {
  const reviews = await allPages<{ id: number; user: RestUser | null; state: string; body: string | null; commit_id: string; submitted_at?: string }>(
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
  const base = `/repos/${repo.owner}/${repo.name}`;
  interface Written {
    readonly id: number;
    readonly user: RestUser | null;
    readonly body: string | null;
    readonly html_url: string;
  }
  const [conversation, inline, reviews] = await Promise.all([
    allPages<Written & { created_at: string }>(github, `${base}/issues/${pullRequest}/comments`),
    allPages<Written & { created_at: string; path: string; line: number | null; original_line?: number | null }>(
      github,
      `${base}/pulls/${pullRequest}/comments`,
    ),
    allPages<Written & { state: string; submitted_at?: string | null }>(github, `${base}/pulls/${pullRequest}/reviews`),
  ]);
  const theirs = (written: Written): boolean => written.user?.login === operator && written.user.type !== "Bot";
  const comments: OperatorComment[] = [
    ...conversation.filter(theirs).map((c) => ({
      id: operatorCommentId("conversation", c.id),
      url: c.html_url,
      where: { kind: "conversation" as const },
      createdAt: c.created_at,
      body: c.body ?? "",
    })),
    ...inline.filter(theirs).map((c) => ({
      id: operatorCommentId("inline", c.id),
      url: c.html_url,
      where: { kind: "inline" as const, path: c.path, line: c.line ?? c.original_line ?? null },
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
  return comments.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
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
 * The PR: for a Review, what it judges (never its other comments, so earlier
 * Verdicts don't steer it); for a retry, its number, title, body and comments with
 * their authors' kind, so only the Fabrik App's Verdicts count as findings.
 * Either way, the Operator's comments on it come apart, in `operatorComments`.
 */
export async function readPullRequest(
  github: Reader,
  repo: Repo,
  number: number,
  { withComments, operator }: { readonly withComments: boolean; readonly operator: string },
): Promise<unknown> {
  const [data, operatorComments] = await Promise.all([
    github.graphql<PullRequestQueryResult>(PULL_REQUEST_QUERY, { owner: repo.owner, name: repo.name, number }),
    readOperatorComments(github, repo, number, operator),
  ]);
  const pullRequest = data.repository.pullRequest;
  if (pullRequest === null) throw new Error(`Pull request #${number} not found`);
  const { title, body, baseRefName, headRefName, headRefOid, comments } = pullRequest;
  return withComments
    ? { number, title, body, comments: comments.nodes, operatorComments }
    : { number, title, body, baseRefName, headRefName, headRefOid, operatorComments };
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

/**
 * What a Design-session turn is told of the Map cap: it may offer a Map; or
 * the cap is full, at `cap` (0 stops new Maps), and these open Maps hold it;
 * or the issue is a Ticket under the Spec `spec`, which never becomes a Map.
 */
export type MapOffer =
  | { readonly kind: "may-offer" }
  | { readonly kind: "cap-full"; readonly cap: number; readonly openMaps: readonly OpenMap[] }
  | { readonly kind: "under-a-spec"; readonly spec: number };

/**
 * Whether this turn may offer a Map, refusing as the push job's landing does
 * (src/loop/design.ts): never on a Ticket under `spec`, its parent; otherwise
 * while the open Maps leave the cap room (src/loop/mapCap.ts). So the turn
 * isn't asked a question the Operator can't say yes to.
 */
export async function readMapOffer(
  github: Pick<Reader, "graphql">,
  repo: Repo,
  config: Pick<KitConfig, "caps">,
  spec: { readonly number: number } | null,
): Promise<MapOffer> {
  if (spec !== null) return { kind: "under-a-spec", spec: spec.number };
  const openMaps = await gatherOpenMaps(github, repo);
  const full = mapCapFull(openMaps.map(({ number }) => number), config);
  return full ? { kind: "cap-full", cap: config.caps.maps, openMaps } : { kind: "may-offer" };
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
  const comments = await allPages<{ user: RestUser | null; body: string | null; created_at: string; html_url: string }>(
    github,
    `/repos/${repo.owner}/${repo.name}/issues/${issue}/comments`,
  );
  return comments
    .filter((comment) => comment.user?.login === operator && comment.user.type !== "Bot")
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

async function main(outDir: string): Promise<void> {
  const [owner, name] = (process.env["GITHUB_REPOSITORY"] ?? "").split("/");
  if (owner === undefined || name === undefined) throw new Error("GITHUB_REPOSITORY is not owner/name");
  const token = process.env["GH_TOKEN"];
  if (token === undefined || token === "") throw new Error("GH_TOKEN is not set");
  const repo = { owner, name };
  const github = new GitHub(token, process.env["GITHUB_API_URL"]);
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
  const { issue, spec } = await readIssue(github, repo, issueNumber, operator);
  await writeFile(join(outDir, "issue.json"), JSON.stringify(issue));
  await writeFile(join(outDir, "spec.json"), JSON.stringify(spec));
  // A turn on an invalid Kit config fails before its agent starts (src/agent/run.ts), so it's told nothing of Maps.
  if (process.env["FABRIK_ROLE"] === "design" && resolved.ok) {
    await writeFile(join(outDir, MAP_INPUTS_FILE), JSON.stringify(await readMapOffer(github, repo, resolved.config, spec)));
  }
  if (pullRequest !== null) {
    const withComments = process.env["FABRIK_PULL_REQUEST_COMMENTS"] === "true";
    await writeFile(
      join(outDir, "pull-request.json"),
      JSON.stringify(await readPullRequest(github, repo, pullRequest, { withComments, operator })),
    );
    if (review !== null) await writeFile(join(outDir, "review.json"), JSON.stringify(await readReview(github, repo, pullRequest, review)));
  }
  if (auditCommit !== "") {
    const inputs = await readAuditInputs(github, repo, { number: issueNumber, commit: auditCommit }, operator);
    await writeFile(join(outDir, AUDIT_INPUTS_FILE), JSON.stringify(inputs));
  }
}

if (import.meta.main) {
  const outDir = process.argv[2];
  if (outDir === undefined) {
    console.error("Usage: node src/agent/inputs.ts <out dir>");
    process.exitCode = 2;
  } else {
    main(outDir).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}
