// An agent job's first step: reads what its agent is given, through the job's
// own read-only token, into files its prompt is built from (src/agent/run.ts).
// The agent itself never holds a GitHub token.
//   node <kit>/src/agent/inputs.ts <out dir>
// Run beside the Product checkout at product/, whose Kit config names the Operator.
// Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, and
//   FABRIK_ISSUE                 the issue or Ticket: writes issue.json and spec.json (its parent Spec, or null);
//                                a Ticket back in design from an agent PR carries that PR in issue.json's sentBack
//   FABRIK_PULL_REQUEST          optional, a PR: writes pull-request.json
//   FABRIK_PULL_REQUEST_COMMENTS "true" for a retry, whose PR file carries the PR's comments and their authors' kind
//   FABRIK_REVIEW                optional, a Request-changes run's review on that PR: writes review.json
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitHub, type Repo } from "../github/client.ts";
import { readKitConfigFromCheckout } from "../kit/checkout.ts";
import { designSessionOf, verdictsIn } from "../github/threads.ts";
import type { SentBack } from "../loop/backToDesign.ts";

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
): Promise<{ issue: unknown; spec: unknown }> {
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

/** Every item of a paginated REST list. */
async function allPages<T>(github: Reader, path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const batch = (await github.rest("GET", `${path}?per_page=100&page=${page}`)) as T[];
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

interface RestUser {
  readonly login: string;
  readonly type: string;
}

/**
 * The agent PR a Ticket came back from, for the Design session that follows:
 * what sent it back (every Verdict the Fabrik App gave it, oldest first, or
 * the Operator's reviews when the Operator did), and what its kept branch
 * built (its commits, its changed files, and its diff against the base branch,
 * cut short past SENT_BACK_DIFF_LIMIT). Nobody else's comments are included.
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
  const [verdicts, operatorReviews, commits, files] = await Promise.all([
    byOperator ? [] : verdictsOn(github, repo, sentBack.pullRequest),
    byOperator ? operatorReviewsOn(github, path, operator) : [],
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
 * The PR: for a Review, what it judges (never its comments, so earlier
 * Verdicts don't steer it); for a retry, its number, title, body and comments with
 * their authors' kind, so only the Fabrik App's Verdicts count as findings.
 */
export async function readPullRequest(github: Reader, repo: Repo, number: number, withComments: boolean): Promise<unknown> {
  const data = await github.graphql<PullRequestQueryResult>(PULL_REQUEST_QUERY, { owner: repo.owner, name: repo.name, number });
  const pullRequest = data.repository.pullRequest;
  if (pullRequest === null) throw new Error(`Pull request #${number} not found`);
  const { title, body, baseRefName, headRefName, headRefOid, comments } = pullRequest;
  return withComments
    ? { number, title, body, comments: comments.nodes }
    : { number, title, body, baseRefName, headRefName, headRefOid };
}

/** The Operator's review requesting changes, its inline comments included. */
export async function readReview(github: Reader, repo: Repo, pullRequest: number, review: number): Promise<unknown> {
  const path = `/repos/${repo.owner}/${repo.name}/pulls/${pullRequest}/reviews/${review}`;
  const comments = await allPages<unknown>(github, `${path}/comments`);
  return { review: await github.rest("GET", path), comments };
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
 * The Operator, as the Loop's snapshot names them: the Kit config's
 * `operator`, from the Product checkout beside the Kit's, or else the repo's owner.
 */
async function operatorOf(productDir: string, owner: string): Promise<string> {
  const resolved = await readKitConfigFromCheckout(productDir);
  return (resolved.ok ? resolved.config.operator : null) ?? owner;
}

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

  const { issue, spec } = await readIssue(github, repo, issueNumber, await operatorOf(PRODUCT_DIR, owner));
  await writeFile(join(outDir, "issue.json"), JSON.stringify(issue));
  await writeFile(join(outDir, "spec.json"), JSON.stringify(spec));
  if (pullRequest !== null) {
    const withComments = process.env["FABRIK_PULL_REQUEST_COMMENTS"] === "true";
    await writeFile(join(outDir, "pull-request.json"), JSON.stringify(await readPullRequest(github, repo, pullRequest, withComments)));
    if (review !== null) await writeFile(join(outDir, "review.json"), JSON.stringify(await readReview(github, repo, pullRequest, review)));
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
