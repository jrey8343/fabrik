// A UI pull request's Review on a Product repo that uses Evidence shots
// (#820): what its Review is started with, whether an Evidence miss at its
// head sends it back, the section its push job writes once the Review's jobs
// have read the named check's artifact, and the findings of the Kit's own
// Execution flaw for a named shot the check didn't produce. The rules that
// land them are in src/loop/review.ts.
import type { ReviewShots, ShotsCollected } from "../evidence/shotsCollect.ts";
import { code, readShotsMarker, type ShotMissOutcome, shotMissSentence, shotsSection, type ShotsRead } from "../evidence/uiEvidence.ts";
import { spelled } from "./readable.ts";
import { MAX_RETRIES, retryNumber } from "./retry.ts";
import type { Action, KitConfig, PullRequestSnapshot } from "./types.ts";

/**
 * The head an Evidence miss sends the pull request back at (ADR-0033): its
 * head, when the Implementer run that wrote its names pushed it and the
 * Ticket has a Retry left, counted as retryAfterFlaw counts it. Null when
 * nothing is sent back: no Retry is left, or the Operator pushed the head, or
 * the Kit's plain rebase made it, or the run pushed none.
 */
export function missSendsBackAt(pullRequest: PullRequestSnapshot): string | null {
  const { shotsMarker, headSha } = pullRequest;
  if (shotsMarker === null || shotsMarker.pushed !== headSha) return null;
  return retryNumber(pullRequest.verdicts, pullRequest.ticketLandedNothing) <= MAX_RETRIES ? headSha : null;
}

/**
 * What a Review of the pull request is started with when its UI evidence
 * comes from Evidence shots: the check and artifact Kit config names, its
 * names and sentence from its marker, and the head a miss is sent back at.
 * Null on a Product repo without `ui.shots`, or a pull request with no shots marker.
 */
export function reviewShotsOf(pullRequest: PullRequestSnapshot, config: KitConfig): ReviewShots | null {
  const shots = config.ui?.shots;
  const marker = pullRequest.shotsMarker;
  if (shots === undefined || marker === null) return null;
  return {
    check: shots.check,
    artifact: shots.artifact,
    names: marker.named.map(({ name }) => name),
    ...(marker.nothingVisible === undefined ? {} : { nothingVisible: marker.nothingVisible }),
    sendsBackAt: missSendsBackAt(pullRequest),
  };
}

/**
 * Why no Review starts at the pull request's head: its Implement run's push
 * gave the Kit's Execution flaw there for naming nothing (#819), whose
 * comment may not have landed yet, so no Reviewer judges that head. Null
 * when a Review may start.
 */
export function whyNothingNamedSentBack(pullRequest: PullRequestSnapshot, config: KitConfig): string | null {
  if (config.ui?.shots === undefined || pullRequest.shotsMarker?.miss !== "nothing-named" || missSendsBackAt(pullRequest) === null) return null;
  return `#${pullRequest.number}'s Evidence miss at ${pullRequest.headSha.slice(0, 7)} sends it back with the Kit's Execution flaw, so no Reviewer judges that head`;
}

/**
 * The evidence section a Review's push job writes once the Review's jobs
 * have read the named check's artifact, `read`, in the Review run whose
 * Evidence page it links, replacing the section its Implement run's push
 * wrote. `sentBack` when the Kit's Execution flaw sends it back in the same
 * plan. None on a Product repo without `ui.shots`, or a pull request with no
 * shots marker.
 */
export function readShotsSectionActions(pullRequest: PullRequestSnapshot, read: ShotsRead | undefined, config: KitConfig, repoUrl: string, sentBack: boolean): Action[] {
  const shots = config.ui?.shots;
  const held = pullRequest.shotsMarker;
  if (shots === undefined || held === null || read === undefined) return [];
  const marker = readShotsMarker(held, read);
  const section = shotsSection({
    check: shots.check,
    artifact: shots.artifact,
    marker,
    missOutcome: missOutcomeOf(marker.miss === "nothing-named", marker.pushed, read.collected, sentBack),
    evidencePage: read.artifact === null ? null : `${repoUrl}/actions/runs/${read.run}/artifacts/${read.artifact}`,
  });
  return [{ kind: "replace-evidence-section", issue: pullRequest.number, section }];
}

/**
 * What came of the pull request's Evidence miss at the head the shots were
 * read at: sent back, or not, because the named check is red (which never
 * decides one that names nothing, judged as its Implement run's push landed),
 * because no Implementer run pushed the head, or because no Retry is left.
 */
function missOutcomeOf(namesNothing: boolean, pushed: string | undefined, collected: ShotsCollected, sentBack: boolean): ShotMissOutcome {
  if (sentBack) return "sent-back";
  if (!namesNothing && collected.red) return "check-red";
  return pushed === collected.head ? "no-retry-left" : "not-pushed";
}

/**
 * The findings of the Kit's own Execution flaw for a named shot the green
 * check didn't produce (#820): each missed name with why, in the Kit's own
 * sentence, and the names of every shot the run did produce, so the Retry
 * whose prompt this is can name one that exists, or add the shot.
 */
export function evidenceMissFindings(collected: ShotsCollected): string {
  const { check, head, produced } = collected;
  const missed = collected.missed.filter(({ why }) => why !== "size-missing");
  return [
    `This pull request changes the UI, and the ${code(check)} check's run at \`${head.slice(0, 7)}\` didn't produce every Evidence shot it names. That is an Evidence miss.`,
    "",
    ...missed.map((miss) => `- ${shotMissSentence(miss, check)}`),
    "",
    produced.length === 0 ? "The run produced no Evidence shot." : `The shots the run did produce: ${spelled(produced.map(code), "and")}.`,
    "",
    "- Name each shot in `shots` exactly as its Journey names it: names are compared exactly, case and spaces included.",
    "- Where the state the change reaches has no shot, add one to the Journey that reaches it, extending a Journey when none does.",
    "- Or, when nothing a person sees changes, say why in `nothingVisible`.",
  ].join("\n");
}
