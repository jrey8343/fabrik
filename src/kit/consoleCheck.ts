// The Console check's name. Pure, with no imports.

/**
 * The Console check: the check run only the Console's own GitHub App makes,
 * on the one head it is about to merge, which GitHub requires before any
 * merge into a covered Product repo's default branch. It is not a Required
 * check: nothing waits on it, re-runs it or names it as in the way (ADR-0019).
 */
export const CONSOLE_CHECK = "Merge from the Console";
