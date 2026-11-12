// The capture step's timeout and the Implement job's that follows from it,
// apart from capture itself (src/evidence/capture.ts), so the recovery waits
// that count on the Implement job's length (src/loop/recoveryWaits.ts) need
// nothing capture does. Pure, no I/O.

/**
 * The capture step's own timeout-minutes in loop.yml: a Kit constant, so a
 * slow build or server can never hold the Implement job past its budget.
 */
export const CAPTURE_TIMEOUT_MINUTES = 20;

/** Room in the Implement job beyond its agent's and capture's timeouts, for its other steps. */
const JOB_STEPS_MINUTES = 10;

/**
 * The Implement job's timeout-minutes, which the Kit job passes out: the
 * agent step stops at the role's own timeout, so this is long enough for
 * capture after it too, and a slow capture never cancels the job before
 * its result uploads.
 */
export function implementJobTimeoutMinutes(implementTimeoutMinutes: number): number {
  return implementTimeoutMinutes + CAPTURE_TIMEOUT_MINUTES + JOB_STEPS_MINUTES;
}
