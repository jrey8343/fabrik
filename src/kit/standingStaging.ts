// The Standing at Staging (#855, ADR-0038): in a Product repo whose Kit
// config declares `staging`, a merged agent pull request stands at Staging
// from its merge until a production Deployment that contains it has started,
// and at Production from then on (./standingProduction.ts). It is on staging
// once a staging Deployment that contains it has succeeded and every Main
// check is green on the commit of the newest such Deployment. Like the
// Standing at Production it reads facts only the read library fills, so no
// Kit job works out a Standing past the merge, and nothing in the Loop waits
// on it. Pure, no I/O.
import type { DeploymentsRead, DeployOf } from "../read/deployments.ts";
import type { MainCheckOf, MainChecksRead } from "../read/mainChecks.ts";
import { type Standing, STANDING_SCHEMA, type StandingFacts, type StandingNamed } from "./standing.ts";
import {
  deployIn,
  isProductionStanding,
  type MergedLastDayFacts,
  noDeployAtOf,
  type ProductionDetail,
  type ProductionName,
  type ProductionStanding,
  productionStandingOf,
  productionStandingsOf,
  stillStands,
} from "./standingProduction.ts";

/** The names a merged agent pull request's Standing can have at Staging. */
export type StagingName = Exclude<ProductionName, "live"> | "on-staging";

/** A merged agent pull request's Standing at Staging. */
export type StagingStanding = StandingNamed<StagingName> & { readonly place: "staging"; readonly detail: { readonly staging: StagingDetail } };

/** A merged agent pull request's Standing, at Staging, at Production or at no place. */
export type MergedStanding = ProductionStanding | StandingNamed<"on-staging">;

/** Whether a Standing is a merged agent pull request's, whatever its place and name. */
export function isMergedStanding(standing: Standing): standing is MergedStanding {
  return standing.name === "on-staging" || isProductionStanding(standing);
}

/** Whether a merged agent pull request needs a Staging trial, and why: it carries UI evidence, or it changes no screen. */
export type StagingTrial = { readonly needed: true; readonly why: "ui-evidence" } | { readonly needed: false; readonly why: "no-screen" };

/**
 * What a merged agent pull request's Standing carries in a repo that declares
 * `staging`, at Staging and at Production alike, beside what every merged
 * pull request's does: what a join needs to settle it with no facts.
 */
export interface StagingDetail {
  /** `staging.environment`. */
  readonly environment: string;
  /** `production.environment`, or null where Kit config tracks no production deploys: it then never moves to Production. */
  readonly production: string | null;
  /** Whether it needs a Staging trial, and why. Only on staging is that the Operator's move. */
  readonly trial: StagingTrial;
  /** The Main checks the commit on staging must pass: those `monitor.main_checks` names, none with them off. */
  readonly mainChecks: readonly string[];
  /**
   * The Main check its name turns on at Staging, after a staging deploy that
   * succeeded: on `deploying`, the first not green on the commit on staging;
   * on `deploy-failed`, the first red, whose page is its `log`. Null on any
   * other, and at Production.
   */
  readonly check: string | null;
  /** On `deploying` at Staging: whether the deploy succeeded and the Main checks of its commit could not be read. False on any other. */
  readonly checksUnread: boolean;
}

/**
 * The Standing of each agent pull request merged in the last 24 hours: in a
 * repo whose valid Kit config declares `staging`, at Staging; in any other,
 * as the Standing at Production gives it, unchanged.
 */
export function mergedStandingsOf(facts: StandingFacts, now: string): Standing[] {
  const config = facts.kit?.config;
  if (facts.mergedLastDay === undefined || config === undefined || !config.ok || config.config.staging === null) return productionStandingsOf(facts, now);
  const { repo } = facts.github;
  const { staging, production, monitor } = config.config;
  return facts.mergedLastDay
    .filter(({ mergedAt }) => stillStands(mergedAt, now))
    .map((merge) => {
      const context: StagingDetail = {
        environment: staging.environment,
        production: production?.environment ?? null,
        trial: facts.needTrial?.includes(merge.number) === true ? { needed: true, why: "ui-evidence" } : { needed: false, why: "no-screen" },
        mainChecks: monitor.redMain ? monitor.mainChecks : [],
        check: null,
        checksUnread: false,
      };
      const promoted = promotedStandingOf(repo, merge, context, facts.deployments ?? null);
      return promoted ?? stagingStandingOf(repo, merge, context, deployIn(facts.stagingDeployments ?? null, repo, staging.environment, merge.mergeCommit), facts.mainChecks ?? null);
    });
}

/**
 * One merge's Standing at Production in a repo that declares `staging`, with
 * production's names, once a Deployments read of the production environment
 * shows one that contains it has started; null until then, when it is at
 * Staging: with none started, with production's Deployments unread, or in a
 * repo that tracks no production deploys. So `merged` and `no-deploy-seen`
 * are never said at Production in such a repo.
 */
export function promotedStandingOf(
  repo: string,
  merge: Pick<MergedLastDayFacts, "number" | "ticket" | "mergeCommit" | "mergedAt">,
  context: StagingDetail,
  production: DeploymentsRead | null,
): ProductionStanding | null {
  if (context.production === null) return null;
  const deploy = deployIn(production, repo, context.production, merge.mergeCommit);
  if (deploy === "unread" || deploy.is === "none") return null;
  return productionStandingOf(repo, merge, context.production, deploy, { ...context, check: null, checksUnread: false });
}

/**
 * One merge's Standing at Staging, for what its staging Deployments and the
 * Main checks of the commit on staging say, before it is read at a time
 * (standingAt). The Deployments name it as they do at Production, but a
 * success is on staging only with every Main check `context` names green on
 * the commit of the newest successful Deployment that contains the merge:
 * one red there reads as a failed deploy, since its run ended and carrying
 * its page as the log; one not green yet, or the checks unread, as deploying
 * since that Deployment succeeded. On staging it stands since the first
 * deploy that contained it, the Operator's move when it needs a Staging
 * trial, which never stops work; every other name is nobody's move. The
 * rule and the join with staging (src/read/joinStaging.ts) both build it
 * here, which is why they agree.
 */
export function stagingStandingOf(
  repo: string,
  merge: Pick<MergedLastDayFacts, "number" | "ticket" | "mergeCommit" | "mergedAt">,
  context: StagingDetail,
  deploy: DeployOf | "unread",
  mainChecks: MainChecksRead | null,
): StagingStanding {
  const base = {
    schema: STANDING_SCHEMA,
    repo,
    issue: merge.ticket,
    pullRequest: merge.number,
    work: "ticket",
    place: "staging",
    move: "nobody",
    yours: false,
    stopsWork: false,
    stuckAt: null,
    awaits: null,
    subscription: null,
  } as const;
  const detail: ProductionDetail & { readonly staging: StagingDetail } = {
    mergeCommit: merge.mergeCommit,
    mergedAt: merge.mergedAt,
    environment: context.environment,
    noDeployAt: null,
    deployment: null,
    log: null,
    deploysUnread: false,
    staging: { ...context, check: null, checksUnread: false },
  };
  if (deploy === "unread") return { ...base, name: "merged", since: merge.mergedAt, detail: { ...detail, deploysUnread: true } };
  const decided = { ...detail, deployment: deploy.deployment };
  switch (deploy.is) {
    case "none":
      return { ...base, name: "merged", since: merge.mergedAt, detail: { ...detail, noDeployAt: noDeployAtOf(merge.mergedAt) } };
    case "running":
      return { ...base, name: "deploying", since: deploy.at ?? merge.mergedAt, detail: decided };
    case "failed":
      return { ...base, name: "deploy-failed", since: deploy.at ?? merge.mergedAt, detail: { ...decided, log: deploy.log } };
    case "succeeded": {
      // The commit on staging: the newest successful Deployment's, where the read gives it.
      const onStaging = deploy.newest ?? { deployment: deploy.deployment, commit: deploy.commit, at: deploy.at ?? merge.mergedAt };
      const deployed = { ...detail, deployment: onStaging.deployment };
      const waiting = (staging: Pick<StagingDetail, "check" | "checksUnread">) =>
        ({ ...base, name: "deploying", since: onStaging.at, detail: { ...deployed, staging: { ...detail.staging, ...staging } } }) as const;
      const checks = mainChecksOn(mainChecks, repo, onStaging.commit, context.mainChecks);
      if (checks === "unread") return waiting({ check: null, checksUnread: true });
      const red = checks.find(({ is }) => is === "red");
      if (red !== undefined) {
        return { ...base, name: "deploy-failed", since: red.at ?? onStaging.at, detail: { ...deployed, log: red.url, staging: { ...detail.staging, check: red.name } } };
      }
      const notGreen = checks.find(({ is }) => is !== "green");
      if (notGreen !== undefined) return waiting({ check: notGreen.name, checksUnread: false });
      // An untried change on staging is in the Operator's queue, and holds nothing up.
      const theirs = context.trial.needed ? ({ move: "operator", yours: true } as const) : {};
      return { ...base, ...theirs, name: "on-staging", since: deploy.at ?? merge.mergedAt, detail: deployed };
    }
  }
}

/**
 * How each of the Main checks `named` stands on `commit` in a Main checks
 * read of `repo`, in their order: unread when there is no read, it is of
 * another repo, it leaves the commit out or gives it as unread, or it lacks
 * one of them. None named is none to read.
 */
function mainChecksOn(read: MainChecksRead | null, repo: string, commit: string | null, named: readonly string[]): readonly MainCheckOf[] | "unread" {
  if (named.length === 0) return [];
  const held = commit === null || read === null || read.repo !== repo ? undefined : read.commits[commit];
  if (held === undefined || held === "unread") return "unread";
  const checks = named.flatMap((name) => held.find((check) => check.name === name) ?? []);
  return checks.length === named.length ? checks : "unread";
}
