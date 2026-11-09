// What the push job or the claim job says when it fails to land what it was
// given (#421): an exception, or a plan the Loop rules core refused to land.
// Setup turns Actions notifications off, so a red job alone tells the
// Operator nothing; this writes the step summary and the comment on the run's
// issue or PR that say what the Kit was doing, what failed and how to recover.
// Pure, no I/O: src/main.ts writes and posts what it returns.
import { PlanNotApplied, ReplayTicketTaken } from "../github/apply.ts";
import { GitHubError, gitHubMessageOf, refusalOf } from "../github/client.ts";
import { describeAction } from "../github/describePlan.ts";
import type { Action, AgentRole } from "../loop/types.ts";
import type { PushJobInput } from "./pushJob.ts";

/** What a push job or claim job was landing, and where its failure is said. */
export interface Landing {
  readonly job: "push" | "claim";
  /** What it was landing, such as "the Implement run on #12". */
  readonly doing: string;
  /** The issue or PR the run is for, which a failure comments on; null when there's none, as for a push to main. */
  readonly target: number | null;
  /** Whether an agent's finished work waits in the run's `fabrik-agent-result` artifact for a re-run to land. */
  readonly agentWork: boolean;
  /** The Actions run attempt, which the comment links to. */
  readonly runUrl: string;
}

/** How a landing failed: an exception, or a `fail` plan. */
export type LandingFailure =
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "fail"; readonly failure: "infrastructure"; readonly reason: string };

/** How long the agent jobs keep their `fabrik-agent-result` artifact (`retention-days` in loop.yml). */
const AGENT_RESULT_DAYS = 7;

const RUN_NAMES: Readonly<Record<AgentRole, string>> = {
  triage: "Triage run",
  design: "Design session's turn",
  implement: "Implement run",
  review: "Review",
  audit: "Audit run",
  retro: "Retro run",
  research: "Research run",
};

/** What the push job lands for `input`, from how the jobs before it ended (src/kit/pushJob.ts); null when it lands nothing. */
export function pushLanding(input: PushJobInput, runUrl: string): Landing | null {
  const push = { job: "push", runUrl } as const;
  switch (input.kind) {
    case "agent-result": {
      const run = input.prototype === undefined ? `the ${RUN_NAMES[input.role]} on #${input.issue}` : `the prototype turn on #${input.issue}`;
      return { ...push, doing: run, target: input.pullRequest ?? input.issue, agentWork: true };
    }
    case "review":
      return {
        ...push,
        doing: input.withResult ? `the Review of #${input.pullRequest}` : `the red required checks on #${input.pullRequest}`,
        target: input.pullRequest,
        agentWork: input.withResult,
      };
    case "agent-failure":
      return {
        ...push,
        doing: `the failure notice of the ${RUN_NAMES[input.role]} on #${input.issue}`,
        target: input.conflict?.pullRequest ?? input.issue,
        agentWork: false,
      };
    case "actions-event":
      return { ...push, doing: "the push to the default branch", target: null, agentWork: false };
    case "nothing":
      return null;
  }
}

/** What the claim job lands: the claim of the issue its run is for, when the event names one. */
export function claimLanding(issue: number | null, runUrl: string): Landing {
  return {
    job: "claim",
    doing: issue === null ? "the claim of the run the Kit job started" : `the claim of #${issue}, taking its trigger label off as its run starts`,
    target: issue,
    agentWork: false,
    runUrl,
  };
}

/** The comment a failed landing posts: on the run's issue or PR, this body. */
export interface LandingFailureComment {
  readonly issue: number;
  readonly body: string;
}

const RE_RUN = "Open the run and choose **Re-run jobs → Re-run failed jobs**";

/**
 * The step summary a failed landing writes, and the comment it posts on the
 * run's issue or PR, when it has one. The comment @-mentions `operator`, as a
 * failed Kit run's notice does, when the Kit config naming them has loaded. A
 * replay claim another run won first needs nothing of the Operator, so it
 * only says so in the summary.
 */
export function landingFailureReport(
  landing: Landing,
  failure: LandingFailure,
  operator: string | null = null,
): { readonly summary: string; readonly comment: LandingFailureComment | null } {
  const headline = `The ${landing.job} job failed landing ${landing.doing}.`;
  const cause = failure.kind === "error" && failure.error instanceof PlanNotApplied ? failure.error.cause : failure.kind === "error" ? failure.error : null;
  if (cause instanceof ReplayTicketTaken) {
    return { summary: `${headline}\n\nAnother run claimed #${cause.ticket} on replay #${cause.issue} first, so this run leaves it to that one.`, comment: null };
  }
  const what = failure.kind === "fail" ? `The Loop wouldn't land it (an Infrastructure failure): ${failure.reason}` : whatFailed(cause);
  const partial = failure.kind === "error" && failure.error instanceof PlanNotApplied ? actionLists(failure.error) : [];
  const recovery = landing.agentWork
    ? `The agent's finished work waits in this run's \`fabrik-agent-result\` artifact, which Actions keeps for ${AGENT_RESULT_DAYS} days. ${RE_RUN} before then to land it.`
    : `${RE_RUN} to try it again.`;
  const rest = [`**What failed:** ${what}`, ...partial, `**To recover:** ${recovery}`];
  const mention = operator === null ? "" : `@${operator} `;
  const body = [`${mention}**The Kit couldn't land ${landing.doing}.** The [${landing.job} job](${landing.runUrl}) failed.`, ...rest].join("\n\n");
  return { summary: [headline, ...rest].join("\n\n"), comment: landing.target === null ? null : { issue: landing.target, body } };
}

function actionLists(error: PlanNotApplied): string[] {
  const list = (title: string, actions: readonly Action[]) =>
    actions.length === 0 ? [] : [`${title}\n\n${actions.map(describeAction).join("\n")}`];
  return [...list("It failed to:", [error.failed]), ...list("Already applied:", error.applied), ...list("Never applied:", error.unapplied)];
}

/** What failed, told apart as GitHub's refusal, GitHub's own failure, a file that wasn't there or the Kit's own failure. */
export function whatFailed(cause: unknown): string {
  if (cause instanceof GitHubError) {
    const request = cause.request === "" ? "a call" : `\`${cause.request}\``;
    const said = gitHubMessageOf(cause);
    switch (refusalOf(cause)) {
      case "rate-limited":
        return `GitHub rate-limited the Fabrik App on ${request}: ${said}`;
      case "missing-permission":
        return `The Fabrik App lacks a permission ${request} needs: ${said}`;
      case null:
        if (cause.status === 0) return `GitHub never answered ${request}: ${said}`;
        if (cause.status >= 500) return `GitHub failed ${request} with a ${cause.status}, its own failure rather than the Kit's: ${said}`;
        return `GitHub refused ${request} with a ${cause.status}: ${said}`;
    }
  }
  if (cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT") {
    const path = (cause as NodeJS.ErrnoException).path ?? "A file the job reads";
    return `\`${path}\` wasn't there to read: for the agent's result, the step that downloads its artifact didn't fetch it.`;
  }
  return `The Kit failed: ${cause instanceof Error ? cause.message : String(cause)}`;
}
