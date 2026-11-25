// The Start check's name for a workflow file, and how long it holds. Pure, with no imports.

/**
 * The Start check for a Held workflow: the check run only the Console's own
 * GitHub App makes, on the default branch's head at the Operator's tap, named
 * for that one workflow file, which the workflow's first job reads before it
 * takes any role. Nothing in the Kit makes, reads or waits on one: the Console
 * makes it and starts nothing, and the Held workflow's own first job reads it.
 * It takes a workflow file's name as `console.held_workflows` lists it, and
 * does not check it, since Kit config already has.
 */
export function startCheckName(workflowFile: string): string {
  return `Start ${workflowFile} from the Console`;
}

/**
 * How old a Start check may be, in minutes, counted from its `completed_at`
 * to the job's own clock, when a Held workflow's first job reads it.
 */
export const START_CHECK_MINUTES = 15;
