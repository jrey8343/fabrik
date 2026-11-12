// The Required checks read (#622): how each Required check stands on the heads
// a reader asks about, and whether the default branch holds admins to its
// rules, judged as GitHub judges a merge (#540). The Required checks are the
// branch's own list, read from the branch itself, which a credential with no
// Administration permission can do: never GitHub's rollup of every check on
// the head, and never the Kit config's list alone. This is not the Review's
// wait, which counts a skipped check as red: passed here is what GitHub
// accepts for a merge. The Weekly summary keeps its own narrower read
// (gatherHeadChecks, src/github/facts.ts). It never throws: a head GitHub
// refuses or fails is "unread", and the others are still given.
import { allPages, type ReadClient, type Repo } from "../github/client.ts";
import type { RequiredChecksFact } from "../kit/weeklySummary.ts";
import type { Row } from "./rows.ts";

/** What a read of a repo's Required checks says. */
export interface RequiredChecksRead {
  /** The repo read, `owner/name`. */
  readonly repo: string;
  /** Its default branch, whose Required checks these are. */
  readonly branch: string;
  /** When it was read, ISO 8601. */
  readonly readAt: string;
  /** The branch's own list of Required checks, in its order. */
  readonly required: readonly string[];
  /** Whether the branch holds admins to its rules: `unknown` when it requires no checks, or when it could not be read. */
  readonly holdsAdmins: "yes" | "no" | "unknown";
  /** Each head asked about, by its sha: each Required check on it, in the branch's order, or unread. */
  readonly heads: Readonly<Record<string, readonly HeadCheck[] | "unread">>;
}

/** One Required check, as it stands on a head. */
export interface HeadCheck {
  readonly name: string;
  readonly is: "passed" | "running" | "failing" | "never-reported";
  /** The deciding report's own page; null for a check never reported, or a status that gave none. */
  readonly url: string | null;
  /** When the deciding report was made, ISO 8601: a check run's completion, or its start while it runs; null for a check never reported. */
  readonly at: string | null;
}

/**
 * How each Required check of `owner/name`'s default branch stands on each of
 * `heads`, and whether the branch holds admins to its rules, read at `now`.
 * Two REST requests for the branch, and two for each head while each list
 * fits a page: its check runs and its commit statuses. With none required,
 * each head has an empty list, which a reader takes as all passed, and its
 * reports are not read. A branch that could not be read leaves every head
 * unread.
 */
export async function readRequiredChecks(client: Pick<ReadClient, "rest">, repo: string, heads: readonly string[], now: string): Promise<RequiredChecksRead> {
  const target = repoOf(repo);
  const branch = await readBranch(client, target);
  const asked = [...new Set(heads)];
  if (branch.kind === "unread") {
    return { repo, branch: branch.name ?? "", readAt: now, required: [], holdsAdmins: "unknown", heads: Object.fromEntries(asked.map((sha) => [sha, "unread"])) };
  }
  const read = await Promise.all(asked.map(async (sha) => [sha, branch.required.length === 0 ? [] : await readHead(client, target, sha, branch.required)] as const));
  return { repo, branch: branch.name, readAt: now, required: branch.required, holdsAdmins: branch.holdsAdmins, heads: Object.fromEntries(read) };
}

/**
 * The heads a checks read is asked about, from rows, each once, from its
 * `detail.head`: each agent pull request's at the Merge gate, and each open
 * Plain pull request's that is not a draft, a Pairing session's joined to its
 * issue's row included. A draft agent pull request's is never one.
 */
export function headsToCheck(rows: readonly Row[]): string[] {
  const heads = rows.flatMap(({ standing }) => {
    const { head } = standing.detail;
    if (head === undefined) return [];
    const plain = standing.detail.pullRequest !== undefined ? standing.detail.pullRequest !== "draft" : standing.work === "plain" ? standing.name !== "draft" : null;
    return (plain ?? standing.place === "merge-gate") ? [head] : [];
  });
  return [...new Set(heads)];
}

/**
 * The Required checks fact of the Standing rule (Spec: Standing) for one
 * head, from a checks read: each Required check on it with when its deciding
 * report was made, an empty list when none is required, or unread when the
 * read holds the head as unread or does not hold it.
 */
export function requiredChecksFactOf(read: RequiredChecksRead, head: string): RequiredChecksFact {
  const checks = read.heads[head];
  if (checks === undefined || checks === "unread") return "unread";
  return checks.map(({ name, is, at }) => ({ name, is, at }));
}

/** `owner/name` as a Repo. */
function repoOf(repo: string): Repo {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, name };
}

/** The default branch, its Required checks and whether it holds admins to its rules; or unread, with its name when that much was read. */
type BranchRead =
  | { readonly kind: "read"; readonly name: string; readonly required: readonly string[]; readonly holdsAdmins: RequiredChecksRead["holdsAdmins"] }
  | { readonly kind: "unread"; readonly name: string | null };

interface RawBranch {
  readonly protected?: boolean;
  readonly protection?: {
    readonly required_status_checks?: {
      readonly enforcement_level?: string;
      readonly contexts?: readonly string[];
      readonly checks?: readonly { readonly context: string }[];
    } | null;
  } | null;
}

/**
 * The default branch as the branch itself gives it. Its enforcement level
 * says whether it holds admins to its rules: `everyone` yes, `non_admins` no,
 * and a branch with no protection no. A protected branch that requires no
 * checks reads `off` whatever it does about admins, so that is unknown.
 */
async function readBranch(client: Pick<ReadClient, "rest">, repo: Repo): Promise<BranchRead> {
  let name: string;
  try {
    name = ((await client.rest("GET", `/repos/${repo.owner}/${repo.name}`)) as { default_branch: string }).default_branch;
  } catch {
    return { kind: "unread", name: null };
  }
  let branch: RawBranch;
  try {
    branch = (await client.rest("GET", `/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(name)}`)) as RawBranch;
  } catch {
    return { kind: "unread", name };
  }
  if (branch.protected !== true) return { kind: "read", name, required: [], holdsAdmins: "no" };
  const checks = branch.protection?.required_status_checks ?? null;
  const required = [...new Set(checks?.checks?.map(({ context }) => context) ?? checks?.contexts ?? [])];
  const level = checks?.enforcement_level;
  const holdsAdmins = required.length === 0 ? "unknown" : level === "everyone" ? "yes" : level === "non_admins" ? "no" : "unknown";
  return { kind: "read", name, required, holdsAdmins };
}

interface RawCheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly html_url: string | null;
}

interface RawStatus {
  readonly id: number;
  readonly context: string;
  readonly state: string;
  readonly target_url: string | null;
  readonly created_at: string;
}

/** One report on a head, a check run or a commit status, as the judging rule reads it. */
interface Report {
  readonly name: string;
  readonly is: Exclude<HeadCheck["is"], "never-reported">;
  readonly url: string | null;
  readonly at: string | null;
  readonly id: number;
}

/** Each Required check on one head, from its check runs and its commit statuses; unread when either could not be read. */
async function readHead(client: Pick<ReadClient, "rest">, repo: Repo, sha: string, required: readonly string[]): Promise<readonly HeadCheck[] | "unread"> {
  const path = `/repos/${repo.owner}/${repo.name}/commits/${sha}`;
  let reports: Report[];
  try {
    const [runs, statuses] = await Promise.all([
      allPages<RawCheckRun>(client, `${path}/check-runs?filter=all`, (page) => (page as { check_runs: RawCheckRun[] }).check_runs),
      allPages<RawStatus>(client, `${path}/statuses`),
    ]);
    reports = [...runs.map(reportOfCheckRun), ...statuses.map(reportOfStatus)];
  } catch {
    return "unread";
  }
  return required.map((name) => {
    const latest = reports.filter((report) => report.name === name).reduce<Report | null>((newest, report) => (newest === null || isLater(report, newest) ? report : newest), null);
    return latest === null ? { name, is: "never-reported", url: null, at: null } : { name, is: latest.is, url: latest.url, at: latest.at };
  });
}

/** Whether `report` was made after `than`: by its time, then, where that ties or one has none, by the order GitHub numbered them. */
function isLater(report: Report, than: Report): boolean {
  const by = report.at === null || than.at === null ? 0 : Date.parse(report.at) - Date.parse(than.at);
  return by !== 0 ? by > 0 : report.id > than.id;
}

/** A check run's report: passed on success, skipped or neutral; running until it completes; failing on any other conclusion. Made when it completed, or started while it runs. */
function reportOfCheckRun({ id, name, status, conclusion, started_at, completed_at, html_url }: RawCheckRun): Report {
  const is = status !== "completed" ? "running" : conclusion === "success" || conclusion === "skipped" || conclusion === "neutral" ? "passed" : "failing";
  return { name, is, url: html_url, at: completed_at ?? started_at, id };
}

/** A commit status's report: passed on success, running while pending, failing on any other state. */
function reportOfStatus({ id, context, state, target_url, created_at }: RawStatus): Report {
  const is = state === "success" ? "passed" : state === "pending" ? "running" : "failing";
  return { name: context, is, url: target_url, at: created_at, id };
}
