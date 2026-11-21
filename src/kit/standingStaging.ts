// The Standing at Staging (#855, ADR-0038): in a Product repo whose Kit
// config declares `staging`, a merged agent pull request stands at Staging
// from its merge until a production Deployment that contains it has started,
// and at Production from then on (./standingProduction.ts). It is on staging
// once a staging Deployment that contains it has succeeded and every Main
// check is green on the commit of the newest such Deployment. Once the
// Operator's own label gives its Staging trial a result (#856,
// ./trialResult.ts) it takes the result's name, on staging or not. One that
// needs a trial and has no result stands, at Staging and at Production
// alike, until it has one or production takes it, which a production
// Deployment that failed or is still running has not; every other for 24
// hours, from its result or from its merge. At Production those, and one
// that is Live, stand for 24 hours from the production Deployment that gave
// the name, so one promoted days after its merge is Live for a day from the
// Deployment that took it (#857).
// Like the Standing at Production it reads facts only the read library
// fills, so no Kit job works out a Standing past the merge, and nothing in
// the Loop waits on it. Pure, no I/O.
import type { ShotsMarker } from "../evidence/shotsEvidence.ts";
import type { EvidenceMarker } from "../evidence/uiEvidence.ts";
import type { DeploymentsRead, DeployOf } from "../read/deployments.ts";
import type { MainCheckOf, MainChecksRead } from "../read/mainChecks.ts";
import type { KitConfig } from "./config.ts";
import { type Standing, STANDING_SCHEMA, type StandingFacts, type StandingNamed } from "./standing.ts";
import {
  deployIn,
  isProductionStanding,
  MERGED_STANDS_HOURS,
  type MergedLastDayFacts,
  noDeployAtOf,
  type ProductionDetail,
  type ProductionName,
  type ProductionStanding,
  productionStandingOf,
  productionStandingsOf,
  stillStands,
} from "./standingProduction.ts";
import { closesATrialProblem, type TrialFacts, type TrialResultGiven, trialResultOf } from "./trialResult.ts";

/** The names a Staging trial's result gives a merged agent pull request's Standing (#856). */
type TrialName = "trial-accepted" | "trial-problem";

/** The names a merged agent pull request's Standing can have at Staging. */
export type StagingName = Exclude<ProductionName, "live"> | "on-staging" | TrialName;

/** A merged agent pull request's Standing at Staging. */
export type StagingStanding = StandingNamed<StagingName> & { readonly place: "staging"; readonly detail: { readonly staging: StagingDetail } };

/** A merged agent pull request's Standing, at Staging, at Production or at no place. */
export type MergedStanding = ProductionStanding | StandingNamed<"on-staging" | TrialName>;

/** Whether a Standing is a merged agent pull request's, whatever its place and name. */
export function isMergedStanding(standing: Standing): standing is MergedStanding {
  return standing.name === "on-staging" || isTried(standing) || isProductionStanding(standing);
}

/** Whether a Standing is one a Staging trial's result names: settled, so no deploy and no check moves it. */
export function isTried(standing: Standing): standing is StandingNamed<TrialName> {
  return standing.name === "trial-accepted" || standing.name === "trial-problem";
}

/**
 * Whether a merged agent pull request needs a Staging trial, and why: it
 * carries UI evidence, or, with none that asks, it closes a Trial problem
 * (#856); or it changes no screen.
 */
export type StagingTrial = { readonly needed: true; readonly why: "ui-evidence" | "closes-trial-problem" } | { readonly needed: false; readonly why: "no-screen" };

/**
 * Whether a merged agent pull request needs a Staging trial, from the marker
 * the Kit wrote on it: one the Kit treated as a UI pull request does, which
 * carries an evidence marker or a shots marker, a failed capture's and an
 * Evidence miss's included, unless its Implementer said nothing visible
 * changes. Every other changes no screen.
 */
export function asksAStagingTrial(evidence: EvidenceMarker | undefined, shots: ShotsMarker | undefined): boolean {
  if (shots?.nothingVisible !== undefined) return false;
  return evidence !== undefined || shots !== undefined;
}

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
  /**
   * Its Staging trial's result (#856, ./trialResult.ts), or null while it is
   * untried: accepted or a problem, since when, its Trial problems, each with
   * whether it is open, none being a problem with no issue named, and, where
   * it was accepted through its fix, the merged pull requests that are the
   * fix. At Staging it decides the name; at Production it is carried along.
   */
  readonly result: TrialResultGiven | null;
  /**
   * When its Standing at Staging ends, ISO 8601: 24 hours from its result,
   * or, untried, from its merge; null for one that needs a Staging trial,
   * has no result and production has not taken, which waits on the Operator:
   * it stands, at Staging and at Production alike, until it has a result or
   * a production Deployment that contains it has succeeded. With a time
   * here, one at Production stands by the production Deployment that gave
   * it its name, whatever the time (mergedStillStands).
   */
  readonly standsUntil: string | null;
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

/** No merged pull request's label events and no Trial problem: every merge untried. */
const NO_TRIALS: TrialFacts = { pullRequests: [], problems: [] };

/**
 * An agent pull request a production Deployment took in the last 24 hours,
 * as only the read library's gather keeps it, in a repo that declares
 * `staging` (#857): what lets it be Live for 24 hours from that Deployment,
 * however long before it merged.
 */
export interface PromotedFacts extends MergedLastDayFacts {
  /**
   * The production Deployment that took it: the first to succeed whose
   * commit holds its merge. GitHub's id of it, or null where it gives none;
   * the commit it deployed; and when it succeeded, ISO 8601.
   */
  readonly by: { readonly deployment: number | null; readonly commit: string; readonly at: string };
}

/**
 * The Standing of each merged agent pull request the facts hold: in a repo
 * whose valid Kit config declares `staging`, at Staging, of those merged in
 * the last 24 hours and those production has not taken (`unpromoted`), and
 * at Production of those a production Deployment took in the last 24 hours
 * (`promoted`, #857), each once, while it still stands (mergedStillStands);
 * in any other, as the Standing at Production gives it, unchanged.
 */
export function mergedStandingsOf(facts: StandingFacts, now: string): Standing[] {
  const config = facts.kit?.config;
  if (config === undefined || !config.ok || config.config.staging === null) return productionStandingsOf(facts, now);
  const { repo } = facts.github;
  const { environment } = config.config.staging;
  return mergesAtStagingOf(facts, config.config).flatMap(({ merge, context, by }) => {
    const promoted = promotedStandingOf(repo, merge, context, facts.deployments ?? null, by);
    const standing = promoted ?? stagingStandingOf(repo, merge, context, deployIn(facts.stagingDeployments ?? null, repo, environment, merge.mergeCommit), facts.mainChecks ?? null);
    return mergedStillStands(standing, now) ? [standing] : [];
  });
}

/**
 * The Standing at Staging of each merged agent pull request the facts hold,
 * in a repo whose valid Kit config declares `staging`: what the rule says of
 * it at Staging for these facts, whether or not it still stands and whether
 * or not a production Deployment has started on it, before it is read at a
 * time (standingAt). None in any other repo. Anything else that says where
 * a merged pull request is at Staging says it through this, as the promote
 * list does (src/read/promoteList.ts, #857), so it can't say otherwise.
 */
export function stagingStandingsOf(facts: StandingFacts): StagingStanding[] {
  const config = facts.kit?.config;
  if (config === undefined || !config.ok || config.config.staging === null) return [];
  const { repo } = facts.github;
  const { environment } = config.config.staging;
  return mergesAtStagingOf(facts, config.config).map(({ merge, context }) =>
    stagingStandingOf(repo, merge, context, deployIn(facts.stagingDeployments ?? null, repo, environment, merge.mergeCommit), facts.mainChecks ?? null),
  );
}

/**
 * Each merged agent pull request the facts hold in a repo that declares
 * `staging`, once: those merged in the last 24 hours, those production has
 * not taken, then those a production Deployment took in the last 24 hours;
 * with what its Standing carries there (StagingDetail), and, for one of the
 * last, the Deployment that took it.
 */
function mergesAtStagingOf(
  facts: StandingFacts,
  { staging, production, monitor }: KitConfig,
): { readonly merge: MergedLastDayFacts; readonly context: StagingDetail; readonly by: PromotedFacts["by"] | null }[] {
  if (staging === null) return [];
  const unpromoted = facts.unpromoted ?? [];
  const promoted = facts.promoted ?? [];
  const waiting = new Set(unpromoted.map(({ number }) => number));
  const trials = facts.trials ?? NO_TRIALS;
  const lastDay = (facts.mergedLastDay ?? []).filter(({ number }) => !waiting.has(number));
  const held = new Set([...lastDay, ...unpromoted].map(({ number }) => number));
  return [...lastDay, ...unpromoted, ...promoted.filter(({ number }) => !held.has(number))].map((merge) => {
    const trial = stagingTrialOf(merge.number, facts.needTrial ?? [], trials);
    const given = trialResultOf(merge.number, trials, facts.operator);
    const result = given.is === "untried" ? null : given;
    const context: StagingDetail = {
      environment: staging.environment,
      production: production?.environment ?? null,
      trial,
      result,
      // Untried and needing a trial, it waits on the Operator for as long as production leaves it.
      standsUntil: result !== null ? dayAfter(result.at) : trial.needed && waiting.has(merge.number) ? null : dayAfter(merge.mergedAt),
      mainChecks: monitor.redMain ? monitor.mainChecks : [],
      check: null,
      checksUnread: false,
    };
    return { merge, context, by: promoted.find(({ number }) => number === merge.number)?.by ?? null };
  });
}

/**
 * Whether merged pull request `pullRequest` needs a Staging trial, and why:
 * one of `needTrial`, whose UI evidence asks (asksAStagingTrial), first,
 * then one that closes a Trial problem, UI evidence or not; every other
 * changes no screen. The one rule for it, whoever says whether a merged pull
 * request needs a trial.
 */
export function stagingTrialOf(pullRequest: number, needTrial: readonly number[], trials: TrialFacts): StagingTrial {
  if (needTrial.includes(pullRequest)) return { needed: true, why: "ui-evidence" };
  return closesATrialProblem(pullRequest, trials) ? { needed: true, why: "closes-trial-problem" } : { needed: false, why: "no-screen" };
}

/** 24 hours after `at`, ISO 8601: how long a settled Standing past the merge stands. */
function dayAfter(at: string): string {
  return new Date(Date.parse(at) + MERGED_STANDS_HOURS * 60 * 60 * 1000).toISOString();
}

/**
 * Whether a merged agent pull request's Standing still stands at `now`, from
 * what it carries alone, so the rule and a join with no facts agree. In a
 * repo that declares no `staging`: up to and at 24 hours from its merge. In
 * one that does, one that waits on the Operator, which has no `standsUntil`,
 * stands whatever its name and place until production has taken it: a
 * production Deployment that contains it and failed, or is still running,
 * has not. Every other stands, at Staging, up to and at its `standsUntil`;
 * and at Production, as one that waits on the Operator does once it is
 * Live, up to and at 24 hours from the production Deployment that gave it
 * its name, its `since` (#857), so one promoted days after its merge is Live
 * for a day from the Deployment that took it.
 */
export function mergedStillStands({ place, name, since, detail }: MergedStanding, now: string): boolean {
  if (detail.staging === undefined) return stillStands(detail.mergedAt, now);
  const { standsUntil } = detail.staging;
  if (standsUntil === null && name !== "live") return true;
  if (place !== "staging" || standsUntil === null) return stillStands(since, now);
  return Date.parse(now) <= Date.parse(standsUntil);
}

/**
 * One merge's Standing at Production in a repo that declares `staging`, with
 * production's names, once a Deployments read of the production environment
 * shows one that contains it has started; null until then, when it is at
 * Staging: with none started, with production's Deployments unread, or in a
 * repo that tracks no production deploys. So `merged` and `no-deploy-seen`
 * are never said at Production in such a repo.
 *
 * `by` is the gather's own word that a production Deployment took the merge
 * (PromotedFacts, #857): where the read is missing or says nothing of the
 * merge, it is Live by that Deployment, since it succeeded. A read that
 * answers for the merge decides, being the nearer look.
 */
export function promotedStandingOf(
  repo: string,
  merge: Pick<MergedLastDayFacts, "number" | "ticket" | "mergeCommit" | "mergedAt">,
  context: StagingDetail,
  production: DeploymentsRead | null,
  by: PromotedFacts["by"] | null = null,
): ProductionStanding | null {
  if (context.production === null) return null;
  const read = deployIn(production, repo, context.production, merge.mergeCommit);
  const deploy = read !== "unread" || by === null ? read : ({ is: "succeeded", deployment: by.deployment, commit: by.commit, at: by.at, log: null } as const);
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
 * trial, which never stops work; every other name is nobody's move.
 *
 * One whose Staging trial has a result (`context.result`, #856) takes the
 * result's name instead, since the result, whatever its deploys and their
 * checks say and whether or not it is on staging: it is settled, and a
 * later deploy never moves it. The rule and the joins
 * (src/read/joinStaging.ts, src/read/joinDeployments.ts) all build it here,
 * which is why they agree.
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
  if (context.result !== null) return { ...base, name: context.result.is === "accepted" ? "trial-accepted" : "trial-problem", since: context.result.at, detail };
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
