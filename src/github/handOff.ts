// A review's hand-off, read from GitHub. A run started by `workflow_dispatch`
// with a pull request and a review as its inputs can be started by whoever can
// start a workflow, with any inputs, and its actor is `github-actions[bot]`,
// so it believes neither input. It reads the review the inputs name and plans
// what that review's own event would have planned, or nothing. It holds no
// Loop rules; those all live in src/loop/rules.ts.
import type { LoopEvent } from "../loop/types.ts";
import type { ReadClient, Repo } from "./client.ts";
import { type HandOff, type SubmittedReview, submittedReviewEventFrom } from "./events.ts";

/** The states of a review that was submitted and still stands, as GitHub's REST API writes them: not `DISMISSED`, and not `PENDING`, which was never submitted. */
const SUBMITTED_STATES: readonly string[] = ["CHANGES_REQUESTED", "COMMENTED", "APPROVED"];

/** What the read takes from GitHub's answer for a review, each as GitHub may leave it out. */
interface RestReview {
  readonly id?: unknown;
  readonly node_id?: unknown;
  readonly state?: unknown;
  readonly body?: unknown;
  readonly user?: { readonly login?: unknown; readonly type?: unknown } | null;
  readonly pull_request_url?: unknown;
}

/** The review in GitHub's answer, or null when the answer lacks any part of one the mapping reads. */
function reviewIn(answer: RestReview): SubmittedReview | null {
  const { id, node_id: node, state, body, user } = answer;
  if (typeof id !== "number" || typeof node !== "string" || typeof state !== "string") return null;
  // A review whose author's account is gone has no user, so it is nobody's.
  if (typeof user?.login !== "string" || typeof user.type !== "string") return null;
  return { id, node_id: node, state, body: typeof body === "string" ? body : null, user: { login: user.login, type: user.type } };
}

/**
 * The Loop event of the review a hand-off names, read with `github`, or null
 * when there is nothing to act on. `operator` is the Operator's login: the
 * Kit config's, or the repo's owner when it names none.
 *
 * It gives an event only for a review that is there, is of the pull request
 * the hand-off names, whatever GitHub answers for a review of another one,
 * was submitted and still stands, and was written by the Operator, compared
 * as GitHub compares logins, without regard to case. The event is then the
 * one the review's own `pull_request_review` event stands for, made from
 * GitHub's answer alone: the hand-off gives only the two numbers the read is
 * made with. A read GitHub fails throws, as a failure isn't the answer that
 * the review isn't there.
 */
export async function readHandOff(github: ReadClient, repo: Repo, handOff: HandOff, operator: string): Promise<LoopEvent | null> {
  const pullRequest = `/pulls/${handOff.pullRequest}`;
  const path = `/repos/${repo.owner}/${repo.name}${pullRequest}/reviews/${handOff.review}`;
  const answer = (await github.rest("GET", path, undefined, { allowNotFound: true })) as RestReview | null;
  if (typeof answer !== "object" || answer === null) return null;
  if (typeof answer.pull_request_url !== "string" || !answer.pull_request_url.endsWith(pullRequest)) return null;
  const review = reviewIn(answer);
  if (review === null || !SUBMITTED_STATES.includes(review.state)) return null;
  if (review.user.login.toLowerCase() !== operator.toLowerCase()) return null;
  return submittedReviewEventFrom(handOff.pullRequest, review);
}
