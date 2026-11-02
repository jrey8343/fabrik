// An agent job's first step: reads what its agent is given, through the job's
// own read-only token, into files its prompt is built from (src/agent/run.ts).
// The agent itself never holds a GitHub token.
//   node <kit>/src/agent/inputs.ts <out dir>
// Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, and
//   FABRIK_ISSUE                 the issue or Ticket: writes issue.json and spec.json (its parent Spec, or null)
//   FABRIK_PULL_REQUEST          optional, a PR: writes pull-request.json
//   FABRIK_PULL_REQUEST_COMMENTS "true" for a retry, whose PR file carries the PR's comments and their authors' kind
//   FABRIK_REVIEW                optional, a Request-changes run's review on that PR: writes review.json
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitHub, type Repo } from "../github/client.ts";

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
          nodes { author { login } body createdAt }
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
        nodes: { author: { login: string } | null; body: string; createdAt: string }[];
      };
    } | null;
  };
}

/** The issue as `gh issue view --json number,title,body,author,labels,comments` shapes it, every comment included, and its parent Spec. */
export async function readIssue(github: Reader, repo: Repo, number: number): Promise<{ issue: unknown; spec: unknown }> {
  const comments: unknown[] = [];
  let after: string | null = null;
  let issue: NonNullable<IssueQueryResult["repository"]["issue"]>;
  do {
    const data: IssueQueryResult = await github.graphql<IssueQueryResult>(ISSUE_QUERY, { owner: repo.owner, name: repo.name, number, after });
    if (data.repository.issue === null) throw new Error(`Issue #${number} not found`);
    issue = data.repository.issue;
    comments.push(...issue.comments.nodes);
    after = issue.comments.pageInfo.hasNextPage ? issue.comments.pageInfo.endCursor : null;
  } while (after !== null);
  return {
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      author: issue.author ?? { login: "ghost" },
      labels: issue.labels.nodes,
      comments,
    },
    spec: issue.parent,
  };
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
 * Verdicts don't steer it); for a retry, its number, title and comments with
 * their authors' kind, so only the Fabrik App's Verdicts count as findings.
 */
export async function readPullRequest(github: Reader, repo: Repo, number: number, withComments: boolean): Promise<unknown> {
  const data = await github.graphql<PullRequestQueryResult>(PULL_REQUEST_QUERY, { owner: repo.owner, name: repo.name, number });
  const pullRequest = data.repository.pullRequest;
  if (pullRequest === null) throw new Error(`Pull request #${number} not found`);
  const { title, body, baseRefName, headRefName, headRefOid, comments } = pullRequest;
  return withComments
    ? { number, title, comments: comments.nodes }
    : { number, title, body, baseRefName, headRefName, headRefOid };
}

/** The Operator's review requesting changes, its inline comments included. */
export async function readReview(github: Reader, repo: Repo, pullRequest: number, review: number): Promise<unknown> {
  const path = `/repos/${repo.owner}/${repo.name}/pulls/${pullRequest}/reviews/${review}`;
  const comments: unknown[] = [];
  for (let page = 1; ; page++) {
    const batch = (await github.rest("GET", `${path}/comments?per_page=100&page=${page}`)) as unknown[];
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return { review: await github.rest("GET", path), comments };
}

function optionalNumber(name: string): number | null {
  const text = process.env[name] ?? "";
  if (text === "") return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} is not a number`);
  return n;
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

  const { issue, spec } = await readIssue(github, repo, issueNumber);
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
