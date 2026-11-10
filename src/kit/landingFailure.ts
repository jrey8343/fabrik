// What the push job or the claim job says when it fails to land what it was
// given (#421): an exception, or a plan the Loop rules core refused to land.
// Setup turns Actions notifications off, so a red job alone tells the
// Operator nothing; this writes the step summary and the comment on the run's
// issue or PR that say what the Kit was doing, what failed and how to recover.
// Any other job that fails, such as the scheduled tick, says in its step
// summary which action failed and what landed before it (#438). A failed
// landing of a first Implement run or a Research run opens with its role's
// failure marker, so Dispatch holds it back as a failed run (#535), and a
// bundle that doesn't verify isn't offered a re-run that only fails again.
// Pure, no I/O: src/main.ts writes and posts what it returns.
import { PlanNotApplied, ReplayTicketTaken } from "../github/apply.ts";
import { UnverifiedBundle } from "../github/branch.ts";
import { GitHubError, gitHubMessageOf, refusalOf } from "../github/client.ts";
import { actionPhrase, describeAction } from "../github/describePlan.ts";
import { RESUME_LABELS } from "../loop/heldRun.ts";
import { IMPLEMENT_RUN_FAILED_MARKER, RESEARCH_RUN_FAILED_MARKER } from "../loop/markers.ts";
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
  /**
   * The first line of the role's failure notice, which the comment opens with
   * when it's said on the issue whose run Dispatch would otherwise release
   * again (#535): a Ticket with no PR, or a research Decision. Absent otherwise.
   */
  readonly marker?: string;
  /**
   * How to run the agent's work again from the start, for when landing it
   * again can't change the outcome (#535). Absent with no agent's work.
   */
  readonly again?: string;
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

/**
 * The failure notice's first line a failed landing's comment carries on the
 * issue it's said on (#535), so the snapshot reads it as the run's failure
 * (#418, #154): a Ticket's first Implement run, or a Research run. A run on a
 * PR needs none, since the open PR holds its Ticket off Dispatch already.
 */
function markerOf(role: AgentRole, onPullRequest: boolean): { readonly marker?: string } {
  if (onPullRequest) return {};
  if (role === "implement") return { marker: IMPLEMENT_RUN_FAILED_MARKER };
  if (role === "research") return { marker: RESEARCH_RUN_FAILED_MARKER };
  return {};
}

/**
 * How to run a role's work on `issue` again from the start: re-add its trigger
 * label, or for a Design-session turn, a prototype turn among them, reply.
 * Nothing for an Audit or Retro run, which the scheduled tick opens again.
 */
function againOf(role: AgentRole, issue: number): { readonly again?: string } {
  if (role === "design") return { again: `Reply on #${issue} to run the turn again.` };
  const label = RESUME_LABELS[role];
  return label === null ? {} : { again: `Re-add \`${label}\` on #${issue} to run it again.` };
}

/** What the push job lands for `input`, from how the jobs before it ended (src/kit/pushJob.ts); null when it lands nothing. */
export function pushLanding(input: PushJobInput, runUrl: string): Landing | null {
  const push = { job: "push", runUrl } as const;
  switch (input.kind) {
    case "agent-result": {
      const run = input.prototype === undefined ? `the ${RUN_NAMES[input.role]} on #${input.issue}` : `the prototype turn on #${input.issue}`;
      const onPullRequest = input.pullRequest !== null || input.prototype !== undefined;
      return {
        ...push,
        doing: run,
        target: input.pullRequest ?? input.issue,
        agentWork: true,
        ...againOf(input.role, input.issue),
        ...markerOf(input.role, onPullRequest),
      };
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
        // A failed Implement run's notice carries its marker on the PR too, holding a conflict-only run off its hourly restart (#424).
        ...markerOf(input.role, input.conflict !== undefined && input.role !== "implement"),
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
  const { cause, lists } = failure.kind === "error" ? unwrapped(failure.error) : { cause: null, lists: [] };
  if (cause instanceof ReplayTicketTaken) {
    return { summary: `${headline}\n\nAnother run claimed #${cause.ticket} on replay #${cause.issue} first, so this run leaves it to that one.`, comment: null };
  }
  const what = failure.kind === "fail" ? `The Loop wouldn't land it (an Infrastructure failure): ${failure.reason}` : whatFailed(cause);
  const again = landing.again === undefined ? "" : ` ${landing.again}`;
  const recovery =
    cause instanceof UnverifiedBundle
      ? `Re-running the job downloads the same bundle, so it fails the same way.${again}`
      : landing.agentWork
        ? `The agent's finished work waits in this run's \`fabrik-agent-result\` artifact, which Actions keeps for ${AGENT_RESULT_DAYS} days. ${RE_RUN} before then to land it.`
        : `${RE_RUN} to try it again.`;
  const rest = [`**What failed:** ${what}`, ...lists, `**To recover:** ${recovery}`];
  const mention = operator === null ? "" : `@${operator} `;
  const opening = landing.marker === undefined ? "" : `${landing.marker}\n`;
  const body = [`${opening}${mention}**The Kit couldn't land ${landing.doing}.** The [${landing.job} job](${landing.runUrl}) failed.`, ...rest].join("\n\n");
  return { summary: [headline, ...rest].join("\n\n"), comment: landing.target === null ? null : { issue: landing.target, body } };
}

/** What a job that lands no run says when it fails, such as the scheduled tick (#438). */
export interface JobFailureReport {
  /** Its step summary. */
  readonly summary: string;
  /** Its `::error` annotation's one line: the action that failed, when its plan failed partway, and the first line of why. */
  readonly annotation: string;
}

/**
 * The step summary and `::error` line a job that lands no run writes when it
 * fails, such as the scheduled tick (#438): what failed and, when its plan
 * failed partway, the action that failed, those already applied and those
 * never applied. It comments nowhere: such a job has no run's issue or PR to
 * say it on.
 */
export function jobFailureReport(error: unknown): JobFailureReport {
  const partial = error instanceof PlanNotApplied ? error : null;
  const { cause, lists } = unwrapped(error);
  const what = whatFailed(cause);
  const headline = partial === null ? "The Loop failed." : "The Loop failed partway through its plan.";
  // One line, as the landing's own `::error` is: a newline would end the workflow command there.
  const firstLine = what.split("\n")[0] ?? what;
  return {
    summary: [headline, `**What failed:** ${what}`, ...lists].join("\n\n"),
    annotation: partial === null ? firstLine : `It failed to ${actionPhrase(partial.failed)}: ${firstLine}`,
  };
}

/** What an error failed on, a plan's own failure for one that failed partway, and the lists of that plan's actions. */
function unwrapped(error: unknown): { readonly cause: unknown; readonly lists: string[] } {
  return error instanceof PlanNotApplied ? { cause: error.cause, lists: actionLists(error) } : { cause: error, lists: [] };
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
