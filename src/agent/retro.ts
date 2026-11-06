// A Retro run's own context (#151): the headings its inputs arrive under, after
// the pending Retro's issue, which prompts/retro.md names. The Retro works in
// a read-only checkout of the default branch, holds no GitHub credential and
// runs none of the code. The agent job (#226) sets the evidence bundle and the
// Kit's role prompts and rubrics out under these headings.

/** The heading over the pending Retro's own issue in the Retro's prompt. */
export const RETRO_ISSUE_HEADING = "The pending Retro";

/** The heading each of the Retro's inputs is set out under, in the order the prompt reads them. */
export const RETRO_SECTIONS = {
  window: "The window",
  escapes: "Architectural escapes",
  feedback: "Operator feedback",
  followUps: "Follow-ups on passing Verdicts",
  lowScores: "Low-scoring runs",
  sample: "The sample",
  streaks: "The streak table",
  closedRetros: "The last closed Retros",
  filedProposals: "Open issues filed from Retros",
  kit: "The Kit's role prompts and rubrics",
} as const;
