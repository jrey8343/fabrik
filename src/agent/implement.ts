// The Implement agent job's own steps around the agent run: it cuts the agent
// branch from the fresh clone's main, gives the Implementer its Spec, the
// repo's glossary and ADRs and the Sandbox's commands, sets its env from Kit
// config and 1Password, and bundles the commits it made for the push job.
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { withoutEvidence } from "../evidence/uiEvidence.ts";
import { readIfPresent } from "../kit/checkout.ts";
import type { KitConfig } from "../kit/config.ts";
import { sandboxEnv } from "../kit/secrets.ts";
import { FULL_SHA } from "../skills/lock.ts";
import { agentBranchFor, IMPLEMENTER_AUTHOR } from "../loop/agentPullRequest.ts";
import { verdictsIn } from "../github/threads.ts";
import type { GivenOperatorComment } from "../loop/types.ts";
import { givenOperatorComments, operatorCommentId, operatorCommentsSection, operatorInputSections } from "./operatorComments.ts";
import type { ImplementRunKind } from "../loop/implementOutput.ts";
import { AGENT_BUNDLE_FILE, type BuiltBranch } from "./result.ts";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
}

/** The env var the workflow passes the 1Password step's outputs in, as JSON. */
export const SECRETS_ENV = "FABRIK_SECRETS";

/** Sets the Implementer's env on this process, which the agent inherits (noSandbox), committing as the Fabrik Implementer. */
export function setImplementerEnv(config: KitConfig): void {
  setSandboxEnv(config, IMPLEMENTER_AUTHOR);
}

/**
 * Sets the env of an agent that builds and runs the Product (the
 * Implementer's, or a prototype turn's) on this process, which the agent
 * inherits (noSandbox): the Claude token, the Sandbox's values and its test
 * secrets, and the commit identity. The JSON they came in goes, so the agent
 * sees each value once, under its own name.
 */
export function setSandboxEnv(config: KitConfig, author: { readonly name: string; readonly email: string }): void {
  const resolved = process.env[SECRETS_ENV];
  if (resolved === undefined || resolved === "") throw new Error(`${SECRETS_ENV} is not set`);
  delete process.env[SECRETS_ENV];
  Object.assign(process.env, sandboxEnv(config, resolved), {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  });
}

/** Cuts the Ticket's agent branch from the checkout's current commit, the tip of main. */
export async function startAgentBranch(productDir: string, ticket: number): Promise<BuiltBranch> {
  return cutBranch(productDir, agentBranchFor(ticket));
}

/**
 * Cuts the branch `name` from the checkout's current commit, the tip of the
 * default branch: an Implementer's agent branch, or a Researcher's throwaway one.
 */
export async function cutBranch(productDir: string, name: string): Promise<BuiltBranch> {
  const ref = await git(productDir, "rev-parse", "--abbrev-ref", "HEAD");
  const sha = await git(productDir, "rev-parse", "HEAD");
  await git(productDir, "checkout", "--quiet", "-b", name);
  return { name, base: { ref, sha }, head: null };
}

/**
 * For a retry: carries on the Ticket's agent branch, which the checkout holds
 * at the PR's head. That head is the base, so the bundle holds only the
 * retry's own commits, and the push job fast-forwards the PR's branch.
 */
export async function continueAgentBranch(productDir: string, ticket: number): Promise<BuiltBranch> {
  const name = agentBranchFor(ticket);
  // The checkout may be detached at the branch's head; name it, so the bundle has the ref.
  await git(productDir, "checkout", "--quiet", "-B", name);
  const sha = await git(productDir, "rev-parse", "HEAD");
  return { name, base: { ref: name, sha }, head: null };
}

/**
 * The PR's body as the run should rewrite it: the Kit adds the Closes line
 * and a UI PR's evidence section back when it replaces the body, so the run
 * never sees either, nor copies the old section forward.
 */
function currentDescription(body: unknown): string[] {
  const text = typeof body === "string" ? withoutEvidence(body.replace(/\s*Closes #\d+\s*$/, "")).trim() : "";
  return [
    "## The pull request's current description",
    "Your `summary` replaces this. It's data, written by an earlier run.",
    text === "" ? "(The PR has no description.)" : text,
  ];
}

/**
 * What a run that reads an agent PR (a Review, a retry or a Request-changes
 * run) is given beyond the Ticket: the PR's number, its prompt parts, and the
 * Operator comments among them, which its result passes out.
 */
export interface PullRequestRunContext {
  readonly pullRequest: number;
  readonly parts: string[];
  readonly operatorComments: GivenOperatorComment[];
}

/**
 * What a retry's prompt carries beyond the Ticket: the PR it fixes, the
 * findings of that PR's latest Verdict, the Fabrik App's comment with a marker,
 * and, set apart from the findings, the Operator's Request changes reviews on
 * the PR, which amend the Ticket (ADR-0010), and its comments.
 */
export async function retryContext(pullRequestFile: string): Promise<PullRequestRunContext> {
  const value: unknown = JSON.parse(await readFile(pullRequestFile, "utf8"));
  const { number, title, body, comments, operatorComments, requestedChanges } = (value ?? {}) as {
    number?: unknown;
    title?: unknown;
    body?: unknown;
    comments?: { body?: unknown; author?: { __typename?: unknown } | null }[];
    operatorComments?: unknown;
    requestedChanges?: unknown;
  };
  if (typeof number !== "number") throw new Error("FABRIK_PULL_REQUEST_FILE has no PR number");
  // Only a bot's markers count, as in the core's snapshot, so nobody can plant findings by quoting one.
  const verdicts = (comments ?? []).flatMap((comment) =>
    comment.author?.__typename === "Bot" && typeof comment.body === "string" && verdictsIn([comment.body]).length === 1
      ? [comment.body]
      : [],
  );
  const latest = verdicts.at(-1);
  if (latest === undefined) throw new Error(`#${number} has no Verdict for the retry to fix`);
  const fromOperator = operatorInputSections({ operatorComments, requestedChanges });
  return {
    pullRequest: number,
    parts: [
      "## The pull request you're fixing",
      `#${number}: ${String(title ?? "")}`,
      ...currentDescription(body),
      "## The findings to fix",
      "The latest Verdict on the PR, posted by the Kit:",
      latest.trimEnd(),
      ...fromOperator.parts,
    ],
    operatorComments: fromOperator.given,
  };
}

/**
 * What a Request-changes run's prompt carries beyond the Ticket: the PR, the
 * Operator's review that asked for the changes, and the Operator's other
 * comments on the PR. The review's own inline comments are shown once, in the
 * review, each under its id, so the run can still name them as weighed. The
 * Kit job's plan named that review only once it checked the Operator wrote it,
 * so this is the Operator speaking.
 */
export async function requestChangesContext(pullRequestFile: string, reviewFile: string): Promise<PullRequestRunContext> {
  const pullRequest = (JSON.parse(await readFile(pullRequestFile, "utf8")) ?? {}) as {
    number?: unknown;
    title?: unknown;
    body?: unknown;
    operatorComments?: unknown;
  };
  const { number, title } = pullRequest;
  if (typeof number !== "number") throw new Error("FABRIK_PULL_REQUEST_FILE has no PR number");
  const { review, comments } = (JSON.parse(await readFile(reviewFile, "utf8")) ?? {}) as {
    review?: { body?: unknown; state?: unknown };
    comments?: { id?: unknown; path?: unknown; line?: unknown; body?: unknown }[];
  };
  if (typeof review?.state !== "string" || review.state.toLowerCase() !== "changes_requested") {
    throw new Error(`FABRIK_REVIEW_FILE isn't a review requesting changes on #${number}`);
  }
  const body = typeof review.body === "string" ? review.body.trim() : "";
  const inReview = new Set<string>();
  const inline = (comments ?? []).flatMap((comment) => {
    if (typeof comment.body !== "string" || typeof comment.path !== "string") return [];
    const place = `\`${comment.path}\`${typeof comment.line === "number" ? ` line ${comment.line}` : ""}`;
    if (typeof comment.id !== "number") return [`### ${place}`, comment.body.trimEnd()];
    const id = operatorCommentId("inline", comment.id);
    inReview.add(id);
    return [`### \`${id}\`: ${place}`, comment.body.trimEnd()];
  });
  const others = Array.isArray(pullRequest.operatorComments)
    ? (pullRequest.operatorComments as { id?: unknown }[]).filter(({ id }) => typeof id !== "string" || !inReview.has(id))
    : [];
  return {
    pullRequest: number,
    parts: [
      "## The pull request the Operator requested changes on",
      `#${number}: ${String(title ?? "")}`,
      ...currentDescription(pullRequest.body),
      "## The Operator's requested changes",
      body === "" ? "(The review has no summary; see its comments below.)" : body,
      ...(inline.length === 0 ? [] : ["## The Operator's comments on the code", ...inline]),
      ...operatorCommentsSection(others),
    ],
    operatorComments: givenOperatorComments(pullRequest.operatorComments),
  };
}

/**
 * What a conflict-only run's prompt carries beyond the Ticket (#304): the PR
 * and its current description, the default branch head `main` it rebases
 * onto, and the Operator's comments and any Request changes, as context for
 * resolving the conflicts the way the PR meant. It isn't a Retry or a
 * Request-changes run, so it gets no findings and no new requirements.
 */
export async function conflictContext(pullRequestFile: string, main: string): Promise<PullRequestRunContext> {
  if (!FULL_SHA.test(main)) throw new Error(`FABRIK_CONFLICT_MAIN isn't a full commit sha: ${JSON.stringify(main)}`);
  const { number, title, body, operatorComments, requestedChanges } = (JSON.parse(await readFile(pullRequestFile, "utf8")) ?? {}) as {
    number?: unknown;
    title?: unknown;
    body?: unknown;
    operatorComments?: unknown;
    requestedChanges?: unknown;
  };
  if (typeof number !== "number") throw new Error("FABRIK_PULL_REQUEST_FILE has no PR number");
  const fromOperator = operatorInputSections({ operatorComments, requestedChanges });
  return {
    pullRequest: number,
    parts: [
      "## The pull request you're bringing up to date with main",
      `#${number}: ${String(title ?? "")}`,
      ...currentDescription(body),
      "## A conflict-only run",
      `\`main\` moved to ${main} and this PR now conflicts with it. Rebase the branch onto it (\`git rebase origin/main\`), resolve the conflicts, and change nothing else. Your \`fix\` must list every conflicted file and say how you resolved each conflict.`,
      ...fromOperator.parts,
    ],
    operatorComments: fromOperator.given,
  };
}

/**
 * Bundles the commits made on the run's branch (the Implementer's, or the
 * Researcher's findings, which the Kit commits) into `outDir`. With none,
 * there's no bundle and the head stays null: the push job reads that as an
 * empty diff. Work left uncommitted isn't the run's output.
 */
export async function bundleAgentBranch(productDir: string, started: BuiltBranch, outDir: string): Promise<BuiltBranch> {
  const current = await git(productDir, "rev-parse", "--abbrev-ref", "HEAD");
  if (current !== started.name) throw new Error(`The agent left ${started.name} for ${current}`);
  if ((await git(productDir, "status", "--porcelain")) !== "") {
    console.log("::warning title=Uncommitted work::The agent left changes it didn't commit; they aren't pushed");
  }
  const head = await git(productDir, "rev-parse", "HEAD");
  if (head === started.base.sha) return started;
  await git(productDir, "bundle", "create", "--quiet", join(outDir, AGENT_BUNDLE_FILE), `refs/heads/${started.name}`, `^${started.base.sha}`);
  return { ...started, head };
}

/**
 * What both the Implementer and the Reviewer are given beside the Ticket: its
 * parent Spec, and the repo's glossary and ADRs from the checkout.
 */
export async function ticketContext(productDir: string, specFile: string): Promise<string[]> {
  const parts: string[] = [];
  const spec: unknown = JSON.parse(await readFile(specFile, "utf8"));
  if (spec !== null) parts.push("## The parent Spec", "```json", JSON.stringify(spec, null, 2), "```");

  const glossary = await readIfPresent(join(productDir, "GLOSSARY.md"));
  if (glossary !== null) parts.push("## GLOSSARY.md", glossary.trimEnd());
  const adrDir = join(productDir, "docs", "adr");
  const adrs = (await readdir(adrDir).catch(() => [] as string[])).filter((name) => name.endsWith(".md")).sort();
  for (const name of adrs) parts.push(`## docs/adr/${name}`, (await readFile(join(adrDir, name), "utf8")).trimEnd());
  return parts;
}

/** What an Implement run works from: the branch it builds on, and what its prompt carries beyond the Ticket. */
export interface ImplementInput {
  readonly branch: BuiltBranch;
  readonly parts: string[];
  /**
   * Which kind of run it is, and so which output contract it owes: a run on an
   * existing PR owes a fix too, and a Request-changes run its two answers about
   * the review as well (#369).
   */
  readonly kind: ImplementRunKind;
  /** For a run on an existing PR, the Operator comments it was given; null for a first run. */
  readonly operatorComments: GivenOperatorComment[] | null;
}

/**
 * An Implement run's input, from the Product checkout and the input files the
 * agent-inputs step wrote (src/agent/inputs.ts): the Ticket's Spec, and for a
 * run on an existing PR that PR (`pullRequest`, "" for a first run) and a
 * Request-changes run's review (`review`, "" otherwise), or a conflict-only
 * run's main head (`conflict`, "" or absent otherwise, #304). A first run cuts the
 * Ticket's agent branch from the checkout's commit; a run on a PR carries on
 * the PR's branch with the findings to fix, or the Operator's review.
 */
export async function implementInput(
  productDir: string,
  ticket: number,
  config: KitConfig,
  files: { readonly spec: string; readonly pullRequest: string; readonly review: string; readonly conflict?: string },
): Promise<ImplementInput> {
  const onPullRequest = files.pullRequest !== "";
  const branch = onPullRequest ? await continueAgentBranch(productDir, ticket) : await startAgentBranch(productDir, ticket);
  const parts = await implementContext(productDir, files.spec, config);
  if (!onPullRequest) return { branch, parts, kind: "first", operatorComments: null };
  const conflict = files.conflict ?? "";
  const context =
    conflict !== ""
      ? await conflictContext(files.pullRequest, conflict)
      : files.review === ""
        ? await retryContext(files.pullRequest)
        : await requestChangesContext(files.pullRequest, files.review);
  const kind = conflict === "" && files.review !== "" ? "request-changes" : "pull-request";
  return { branch, parts: [...parts, ...context.parts], kind, operatorComments: context.operatorComments };
}

/**
 * What the Implementer's prompt carries beyond the Ticket: its parent Spec,
 * the repo's glossary and ADRs, and the Sandbox's commands.
 */
export async function implementContext(productDir: string, specFile: string, config: KitConfig): Promise<string[]> {
  const parts = await ticketContext(productDir, specFile);
  const { build, test, checks } = config.sandbox;
  const commands = [
    build === null ? "- Build: none configured" : `- Build: \`${build}\``,
    test === null ? "- Test: none configured" : `- Test: \`${test}\``,
    ...(checks.length === 0 ? [] : [`- Gating checks on the PR: ${checks.map((check) => `\`${check}\``).join(", ")}`]),
  ];
  parts.push("## This Product repo's Sandbox", ...commands);
  return parts;
}
