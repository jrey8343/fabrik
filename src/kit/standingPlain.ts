// The Standings of Plain pull requests (src/kit/standing.ts; GLOSSARY.md):
// every open pull request in a Product repo that is no agent PR, whoever
// opened it. Each has a kind, told from who opened it and its branch, and a
// Standing with no place on the Loop, read from whether it is a draft,
// whether it merges cleanly and its Required checks. None stops work and none
// turns Stuck: it leaves at its merge or close. The Kit never acts on a
// Request changes, `needs-design` or a comment on one, so none is read.
import { setupBranch } from "../setup/setupBranchName.ts";
import { SKILLS_BUMP_BRANCH } from "../skills/bump.ts";
import { type PlainKind, type Standing, STANDING_SCHEMA, type StandingFacts, type StandingNamed } from "./standing.ts";
import type { GitHubFacts, PlainPullRequestFacts, RequiredCheckFact, RequiredChecksFact } from "./weeklySummary.ts";

/** What a Kit bump's branch starts with: Dependabot's branch for the Dependabot shim's `fabrik` group (templates/dependabot.yml). */
const KIT_BUMP_BRANCH_PREFIX = "dependabot/github_actions/fabrik-";

/** Dependabot's login, as the gather reads a bot's. */
const DEPENDABOT = "dependabot[bot]";

/** What Setup's branches start with: setup's own, `fabrik/setup-<release>`, and an upgrade's. */
const SETUP_BRANCH_PREFIXES = [setupBranch("v"), "fabrik/upgrade-v"] as const;

/** What a Pairing session's branch starts with, before the number of the issue it pairs on (skills/fabrik-pair/SKILL.md). */
export const PAIR_BRANCH_PREFIX = "fabrik/pair-";

/** Each open Plain pull request's Standing, its Required checks read from the repo's Kit facts. */
export function plainStandingsOf({ github, kit, operator, appLogin }: StandingFacts, _now: string): Standing[] {
  return github.plainPullRequests.map((pullRequest) => {
    const base = {
      schema: STANDING_SCHEMA,
      repo: github.repo,
      issue: null,
      pullRequest: pullRequest.number,
      work: "plain",
      place: null,
      stopsWork: false,
      since: sinceOf(pullRequest),
      stuckAt: null,
      awaits: null,
      subscription: null,
    } as const;
    const { decidedAt, ...name } = plainNameOf(pullRequest, plainKindOf(pullRequest, operator, appLogin), kit?.headChecks[pullRequest.headSha] ?? "unread");
    return { ...base, since: decidedAt ?? base.since, ...name };
  });
}

/**
 * Each Pairing session's pull request joined to its issue while that issue is
 * open: one Standing with both numbers. Where the issue has a Standing of its
 * own, that one keeps its work, name and mark and carries in its detail the
 * name the pull request would have had, until that name is `yours-to-merge`:
 * then it takes it, with the mark off, since no Plain pull request stops work.
 * One that carries no pull request is joined first; else one carrying the
 * issue's open agent PR is, the Pairing session's number taking the agent
 * PR's, as the Operator pairing on the issue is its live work. Where the issue
 * has none, the pull request's Standing carries its number. With the issue
 * closed or missing the pull request stands by itself.
 */
export function joinPairing(standings: readonly Standing[], { plainPullRequests, openIssues }: GitHubFacts): Standing[] {
  const replaced = new Map<Standing, Standing | null>();
  for (const pairing of standings) {
    if (pairing.work !== "plain" || pairing.detail.pullRequest !== undefined || !("plain" in pairing.detail) || pairing.detail.plain !== "pairing") continue;
    const headRef = plainPullRequests.find(({ number }) => number === pairing.pullRequest)?.headRef;
    const issue = headRef === undefined ? null : pairedIssueOf(headRef);
    if (issue === null || !openIssues.some(({ number }) => number === issue)) continue;
    const own = standings.filter((standing) => standing.issue === issue && standing !== pairing);
    const unjoined = own.filter((standing) => !replaced.has(standing));
    const joinable = unjoined.find((standing) => standing.pullRequest === null) ?? unjoined[0];
    if (joinable !== undefined) {
      replaced.set(joinable, joined(joinable, pairing));
      replaced.set(pairing, null);
    } else if (own.length === 0) replaced.set(pairing, { ...pairing, issue });
  }
  return standings.flatMap((standing) => {
    const replacement = replaced.get(standing);
    return replacement === undefined ? [standing] : replacement === null ? [] : [replacement];
  });
}

/** An issue's own Standing joined with its Pairing session's pull request's. */
export function joined(own: Standing, pairing: Standing): Standing {
  if (pairing.name === "yours-to-merge") {
    return { ...own, pullRequest: pairing.pullRequest, name: "yours-to-merge", move: "operator", yours: true, stopsWork: false, since: pairing.since, stuckAt: null, awaits: null, detail: { plain: "pairing", pullRequest: "yours-to-merge" } };
  }
  return { ...own, pullRequest: pairing.pullRequest, detail: { ...own.detail, pullRequest: pairing.name } } as Standing;
}

/**
 * Since when it stands so, the latest of: its head, whose checks it is read
 * by; its opening; and when it last left draft or went into it, so one marked
 * ready an hour ago has been ready to merge for an hour.
 */
function sinceOf({ createdAt, headCommittedAt, draftChangedAt }: PlainPullRequestFacts): string {
  return [headCommittedAt, draftChangedAt].reduce<string>((latest, at) => (at !== null && Date.parse(at) > Date.parse(latest) ? at : latest), createdAt);
}

/** What a Plain pull request's Standing is named, with its move and detail. */
export type PlainName = { [N in PlainNames]: Pick<StandingNamed<N>, "name" | "move" | "yours" | "detail"> }[PlainNames];
type PlainNames = "draft" | "conflicts" | "check-failing" | "waiting-on-checks" | "yours-to-merge";

/** A Plain pull request's name for its Required checks alone: never a draft, nor one in conflict. */
export type PlainChecksName = Exclude<PlainName, { readonly name: "draft" | "conflicts" }>;

/**
 * Its name, the first that holds: a draft; one that cannot merge cleanly (one
 * GitHub hasn't worked out merges cleanly); else its name for its Required
 * checks (plainNameForChecks), with when the report that decided it was made.
 */
function plainNameOf({ draft, mergeable }: PlainPullRequestFacts, plain: PlainKind, checks: RequiredChecksFact): PlainName & { readonly decidedAt: string | null } {
  if (draft) return { name: "draft", move: "nobody", yours: false, detail: { plain }, decidedAt: null };
  if (mergeable === false) return { name: "conflicts", move: "operator", yours: true, detail: { plain }, decidedAt: null };
  const { name, decidedAt } = plainNameForChecks(plain, checks);
  return { ...name, decidedAt };
}

/**
 * The name of a Plain pull request out of draft and merging cleanly, for the
 * Required checks on its head, the first that holds: a Required check
 * failing; one running; one never reported on its head; else ready, every one
 * passed, an empty list (none required) included. A running check comes
 * before one not yet reported, so a fresh push is not the Operator's before
 * its checks start. With the checks unread, as when the Kit config lists
 * none, it waits on checks it could not read: never ready. `decidedAt` is
 * when the report that decided it was made, where the fact gives it: the
 * check it names, or the last to pass; null when no report decided it.
 */
export function plainNameForChecks(plain: PlainKind, checks: RequiredChecksFact): { readonly name: PlainChecksName; readonly decidedAt: string | null } {
  const operators = { move: "operator", yours: true } as const;
  if (checks === "unread") return { name: { name: "waiting-on-checks", move: "kit", yours: false, detail: { plain, check: null, checksUnread: true } }, decidedAt: null };
  const first = (is: RequiredCheckFact["is"]) => checks.find((check) => check.is === is);
  const failing = first("failing");
  if (failing !== undefined) return { name: { name: "check-failing", ...operators, detail: { plain, check: failing.name, checkIs: "failing" } }, decidedAt: failing.at ?? null };
  const running = first("running");
  if (running !== undefined) return { name: { name: "waiting-on-checks", move: "kit", yours: false, detail: { plain, check: running.name, checksUnread: false } }, decidedAt: running.at ?? null };
  const unreported = first("never-reported");
  if (unreported !== undefined) return { name: { name: "check-failing", ...operators, detail: { plain, check: unreported.name, checkIs: "never-reported" } }, decidedAt: null };
  return { name: { name: "yours-to-merge", ...operators, detail: { plain } }, decidedAt: lastPassedAt(checks) };
}

/** When the last of these passed checks passed, or null when there are none or one gives no time. */
function lastPassedAt(checks: readonly RequiredCheckFact[]): string | null {
  const times = checks.map(({ at }) => at ?? null);
  if (times.length === 0 || times.includes(null)) return null;
  return times.reduce<string | null>((latest, at) => (latest === null || (at !== null && Date.parse(at) > Date.parse(latest)) ? at : latest), null);
}

/**
 * What kind of Plain pull request it is, from who opened it and its branch:
 * Dependabot's Kit bump, the Operator's from Setup, the Fabrik App's Skills
 * bump, the Operator's from a Pairing session, whose body closes the issue
 * its branch names, whatever else it closes; or any other.
 */
export function plainKindOf({ author, headRef, closes }: PlainPullRequestFacts, operator: string, appLogin: string): PlainKind {
  if (author === DEPENDABOT && headRef.startsWith(KIT_BUMP_BRANCH_PREFIX)) return "kit-bump";
  if (author === operator && SETUP_BRANCH_PREFIXES.some((prefix) => headRef.startsWith(prefix))) return "setup";
  if (author === appLogin && headRef.startsWith(`${SKILLS_BUMP_BRANCH}/`)) return "skills-bump";
  const paired = pairedIssueOf(headRef);
  if (author === operator && paired !== null && closes.includes(paired)) return "pairing";
  return "other";
}

/** The issue a Pairing session's branch names, or null for any other branch. */
export function pairedIssueOf(headRef: string): number | null {
  const number = headRef.startsWith(PAIR_BRANCH_PREFIX) ? headRef.slice(PAIR_BRANCH_PREFIX.length) : "";
  return /^[1-9][0-9]*$/.test(number) ? Number(number) : null;
}
