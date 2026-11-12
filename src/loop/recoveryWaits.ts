// The recovery waits (#603): how long each recovery the hourly Tick runs
// leaves work alone before the Kit moves it on itself, in one record, as a
// function of Kit config. Each recovery reads its wait from here, and the
// Stuck bar is built from the record, so work turns Stuck only once every
// recovery has had its turn, and a recovery added to the record is counted
// with no other change.
//
// The Tick's other parts wait on no clock of the Kit's before moving work on,
// so none is here: the audit and retro gates wait for a day of the week, the
// held-run resume and the weekly-limit close for a Subscription's reset (held
// work is never Stuck), the Flaky-check sweep and closing merged Tickets act
// on what they read at once, and the replay step's release of a run past its
// limit moves a Replay, which never turns Stuck between its steps.
import { implementJobTimeoutMinutes } from "../evidence/capture.ts";
import type { KitConfig } from "./types.ts";

/** Each recovery the Tick runs that waits on a clock before the Kit moves work on. */
export type Recovery = "stuckTrigger" | "unstartedRetry" | "undeliveredRequestChanges" | "unreviewedDraft";

/**
 * How long a trigger label stays on, in minutes, before the stuck-trigger
 * sweep (src/loop/triggerSweep.ts) counts it as having no run behind it,
 * when no job of its role is under way: well past the 10 minutes the
 * adapter's cycle waits (#417), and the time a claim takes.
 */
export const STUCK_TRIGGER_MINUTES = 30;

/**
 * How long a Request changes waits for GitHub to deliver it before the Kit
 * counts it as undelivered (src/loop/undelivered.ts), and how long a
 * Request-changes run's note is left before the Kit counts the run as
 * stalled. On a pull request that merges cleanly the undelivered check waits
 * the Implement job's timeout instead, when that is longer.
 */
export const UNDELIVERED_GRACE_MINUTES = 10;

/**
 * Each recovery's wait, in minutes, at this Kit config:
 * - the stuck-trigger sweep: STUCK_TRIGGER_MINUTES;
 * - the unstarted-Retry check (src/loop/retry.ts): the Implement job's
 *   timeout, after which a Retry that started has ended;
 * - the undelivered-Request-changes check: the longer of its grace and the
 *   Implement job's timeout, which it waits on a pull request that merges
 *   cleanly, where a run may be working that never noted it;
 * - the unreviewed-draft check (src/loop/conflicts.ts, #389, ADR-0016): a
 *   Review is two jobs, the wait for the pull request's Required checks and
 *   the Reviewer's, each given the Review role's timeout, so one that started
 *   has ended after twice it.
 */
export function recoveryWaits(config: KitConfig): Readonly<Record<Recovery, number>> {
  const implementJob = implementJobTimeoutMinutes(config.roles.implement.timeoutMinutes);
  return {
    stuckTrigger: STUCK_TRIGGER_MINUTES,
    unstartedRetry: implementJob,
    undeliveredRequestChanges: Math.max(UNDELIVERED_GRACE_MINUTES, implementJob),
    unreviewedDraft: 2 * config.roles.review.timeoutMinutes,
  };
}

/**
 * The Tick's interval, in minutes: the caller template runs the scheduled Kit
 * workflow hourly, which a test holds it to (src/loop/recoveryWaits.test.ts).
 */
export const TICK_MINUTES = 60;

/**
 * The Stuck bar for a Product repo, in minutes, at its Kit config: the
 * slowest recovery's wait plus two Ticks, one for the recovery's own Tick to
 * come round and one for GitHub running the hourly schedule late. Work the
 * Kit has made no sign on for this long is past every recovery. It reads the
 * record's values without naming them, so a recovery added to the record is
 * counted with no change here.
 */
export function stuckBarMinutes(config: KitConfig): number {
  return Math.max(...Object.values(recoveryWaits(config))) + 2 * TICK_MINUTES;
}
