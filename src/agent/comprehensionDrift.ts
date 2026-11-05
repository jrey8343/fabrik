// Comprehension drift (#150, from the Monitor's #82): the files the factory
// keeps changing without anyone writing down what it learned, which the
// Auditor looks at first. Pure, no I/O: src/agent/inputs.ts gathers the PRs.
import { isAgentPullRequest } from "../loop/agentPullRequest.ts";

/** One merged PR's changes, as the Audit's inputs step read them. */
export interface MergedPullRequestChanges {
  /** When it merged, as an ISO 8601 time. */
  readonly mergedAt: string;
  readonly headRef: string;
  readonly authorIsBot: boolean;
  /** The repo paths it changed. */
  readonly files: readonly string[];
}

/** A file in drift, and how many merged agent PRs changed it in the 30 days. */
export interface DriftFile {
  readonly path: string;
  readonly changes: number;
}

/** More changes than this in the 30 days is drift. */
const DRIFT_CHANGES = 5;

/** How far back drift looks from the Audit. */
export const DRIFT_DAYS = 30;

const DAY_MS = 86_400_000;

/** The directory a repo path is in, or "" at the root. */
function directoryOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

const isMarkdown = (path: string): boolean => /\.md$/i.test(path);

/** An ADR or the glossary: a change to either writes down what was learned, wherever the drift is. */
const isRepoWideDoc = (path: string): boolean =>
  (path.startsWith("docs/adr/") && isMarkdown(path)) || path.split("/").at(-1) === "GLOSSARY.md";

/**
 * The files merged agent PRs changed more than 5 times in the 30 days up to
 * `at`, most changed first, leaving out each one whose matching doc changed
 * in those days: an ADR, `GLOSSARY.md`, or a Markdown file in its own
 * directory. That reading of "matching doc" is the Kit's, kept simple and
 * cheap (#150). Only agent PRs count, for changes and docs alike: any other PR
 * given counts for nothing.
 */
export function comprehensionDrift(pullRequests: readonly MergedPullRequestChanges[], at: string): DriftFile[] {
  const end = Date.parse(at);
  const start = end - DRIFT_DAYS * DAY_MS;
  const inDays = pullRequests.filter((pr) => {
    const mergedAt = Date.parse(pr.mergedAt);
    return mergedAt >= start && mergedAt <= end && isAgentPullRequest(pr);
  });
  const changes = new Map<string, number>();
  for (const pullRequest of inDays) {
    for (const path of new Set(pullRequest.files)) changes.set(path, (changes.get(path) ?? 0) + 1);
  }
  const changed = [...changes.keys()];
  if (changed.some(isRepoWideDoc)) return [];
  const documented = new Set(changed.filter(isMarkdown).map(directoryOf));
  return [...changes]
    .filter(([path, count]) => count > DRIFT_CHANGES && !documented.has(directoryOf(path)))
    .map(([path, count]) => ({ path, changes: count }))
    .sort((a, b) => b.changes - a.changes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
