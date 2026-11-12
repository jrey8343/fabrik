// The Standing at Production (#634): a merged agent pull request keeps a
// Standing for 24 hours after its merge, in a Product repo whose Kit config
// declares `production`, so a reader can follow it to the point where it is
// live (ADR-0021). The Loop still ends at the merge; only the Standing goes
// on. It reads two facts that only the read library fills: the agent pull
// requests its gather keeps from the last 24 hours, and a Deployments read
// (src/read/deployments.ts). The Weekly summary's gather fills neither, so no
// Kit job works out a Standing past the merge. Pure, no I/O.
import type { DeploymentsRead, DeployOf } from "../read/deployments.ts";
import { type Standing, STANDING_SCHEMA, type StandingFacts, type StandingNamed } from "./standing.ts";

/** How long after its merge, in minutes, a merge no deploy has started for reads as no deploy seen. */
export const NO_DEPLOY_SEEN_MINUTES = 60;

/** How long after its merge, in hours, a merged agent pull request keeps its Standing. */
export const MERGED_STANDS_HOURS = 24;

/** An agent pull request merged in the last 24 hours, as the read library's gather keeps it. */
export interface MergedLastDayFacts {
  readonly number: number;
  readonly title: string;
  /** The Ticket it closes, or null. */
  readonly ticket: number | null;
  /** Its merge commit's sha, or null when GitHub gives none. */
  readonly mergeCommit: string | null;
  /** ISO 8601. */
  readonly mergedAt: string;
}

/** The names a merged agent pull request's Standing can have. */
const PRODUCTION_NAMES = ["deploying", "live", "deploy-failed", "no-deploy-seen", "merged"] as const;
export type ProductionName = (typeof PRODUCTION_NAMES)[number];

/** A merged agent pull request's Standing: at Production, or with no place in a repo that tracks no deploys. */
export type ProductionStanding = StandingNamed<ProductionName>;

/** Whether a Standing is a merged agent pull request's. */
export function isProductionStanding(standing: Standing): standing is ProductionStanding {
  return (PRODUCTION_NAMES as readonly string[]).includes(standing.name);
}

/** What every Standing at Production's wording is made of. */
export interface ProductionDetail {
  /** The merge commit, or null when GitHub gave none. */
  readonly mergeCommit: string | null;
  /** When it merged, ISO 8601. */
  readonly mergedAt: string;
  /** The environment Kit config names, or null when it declares only an address. */
  readonly environment: string | null;
  /** On a tracked `merged` Standing whose Deployments were read and held none: when it turns `no-deploy-seen`, ISO 8601. Else null. */
  readonly noDeployAt: string | null;
  /** GitHub's id of the Deployment that decided its name, or null. */
  readonly deployment: number | null;
  /** A failed deploy's log, an `https` address, or null. */
  readonly log: string | null;
  /** Whether its Deployments could not be read: the read was missing, unread for this merge, or there is no merge commit to ask about. */
  readonly deploysUnread: boolean;
}

const MINUTE = 60 * 1000;

/** When a merge at `mergedAt` turns `no-deploy-seen`, ISO 8601, if none has started by then. */
function noDeployAtOf(mergedAt: string): string {
  return new Date(Date.parse(mergedAt) + NO_DEPLOY_SEEN_MINUTES * MINUTE).toISOString();
}

/** Whether a merge at `mergedAt` still keeps its Standing at `now`: up to and at its 24 hours. */
export function stillStands(mergedAt: string, now: string): boolean {
  return Date.parse(now) <= Date.parse(mergedAt) + MERGED_STANDS_HOURS * 60 * MINUTE;
}

/**
 * The Standing of each agent pull request merged in the last 24 hours, in a
 * repo whose valid Kit config declares `production`; none when the merges
 * were not read, with no such block, or with an invalid Kit config. Read at
 * `now` before standingAt reads it later.
 */
export function productionStandingsOf(facts: StandingFacts, now: string): Standing[] {
  const config = facts.kit?.config;
  if (facts.mergedLastDay === undefined || config === undefined || !config.ok || config.config.production === null) return [];
  const { repo } = facts.github;
  const { environment } = config.config.production;
  return facts.mergedLastDay
    .filter(({ mergedAt }) => stillStands(mergedAt, now))
    .map((merge) => productionStandingOf(repo, merge, environment, deployIn(facts.deployments ?? null, repo, environment, merge.mergeCommit)));
}

/**
 * What a Deployments read says of one merge in `repo`'s `environment`:
 * unread when there is no read, it is of another repo or environment, it
 * leaves the merge out or gives it as unread, or the merge has no commit.
 */
export function deployIn(read: DeploymentsRead | null, repo: string, environment: string | null, mergeCommit: string | null): DeployOf | "unread" {
  if (mergeCommit === null || read === null || read.repo !== repo || read.environment !== environment) return "unread";
  return read.merges[mergeCommit] ?? "unread";
}

/** One merge's Standing, for what its Deployments say, before it is read at a time (standingAt). */
export function productionStandingOf(
  repo: string,
  merge: Pick<MergedLastDayFacts, "number" | "ticket" | "mergeCommit" | "mergedAt">,
  environment: string | null,
  deploy: DeployOf | "unread",
): ProductionStanding {
  const base = {
    schema: STANDING_SCHEMA,
    repo,
    issue: merge.ticket,
    pullRequest: merge.number,
    work: "ticket",
    place: environment === null ? null : "production",
    move: "nobody",
    yours: false,
    stopsWork: false,
    stuckAt: null,
    awaits: null,
    subscription: null,
  } as const;
  const detail: ProductionDetail = {
    mergeCommit: merge.mergeCommit,
    mergedAt: merge.mergedAt,
    environment,
    noDeployAt: null,
    deployment: null,
    log: null,
    deploysUnread: false,
  };
  if (environment === null) return { ...base, name: "merged", since: merge.mergedAt, detail };
  if (deploy === "unread") return { ...base, name: "merged", since: merge.mergedAt, detail: { ...detail, deploysUnread: true } };
  const decided = { ...detail, deployment: deploy.deployment };
  switch (deploy.is) {
    case "none":
      return { ...base, name: "merged", since: merge.mergedAt, detail: { ...detail, noDeployAt: noDeployAtOf(merge.mergedAt) } };
    case "running":
      return { ...base, name: "deploying", move: "kit", since: deploy.at ?? merge.mergedAt, detail: decided };
    case "succeeded":
      return { ...base, name: "live", since: deploy.at ?? merge.mergedAt, detail: decided };
    case "failed":
      return { ...base, name: "deploy-failed", since: deploy.at ?? merge.mergedAt, detail: { ...decided, log: deploy.log } };
  }
}

/** A `merged` Standing as it reads at `now`: `no-deploy-seen` once its `noDeployAt` has passed, since then; else as it is. */
export function productionAt(standing: StandingNamed<"merged">, now: string): Standing {
  const { noDeployAt } = standing.detail;
  if (noDeployAt === null || Date.parse(now) < Date.parse(noDeployAt)) return standing;
  return { ...standing, name: "no-deploy-seen", since: noDeployAt, detail: { ...standing.detail, noDeployAt: null } };
}
