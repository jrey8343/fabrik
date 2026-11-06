// The push job's preview step (#153; .github/actions/link-preview): once Run
// the Loop has pushed a UI PR whose Kit config declares preview.url, it polls
// the URL that template filled in to (src/github/apply.ts) until it answers,
// for PREVIEW_POLL_MINUTES at most, then edits the PR's evidence section to
// link it, or to say it never answered. It fetches only that URL: never a
// hosting provider's API, and it waits on no deployment status.
//
// Its prototype preview step (#155; .github/actions/link-prototype-preview)
// does the same for a prototype round, once Run the Loop has pushed
// prototype/<issue> and posted the round: it polls the route's page there,
// then edits the round to link it beside each variant, or to say it never
// answered.
import type { PreviewToLink, PrototypePreviewToLink } from "../github/apply.ts";
import type { GitHub, Repo } from "../github/client.ts";
import { type PreviewLink, withPreviewLink } from "../evidence/uiEvidence.ts";
import { withVariantPreviews } from "../loop/prototypeLanding.ts";

/**
 * How long the preview step polls before it says the preview never answered:
 * a Kit constant, short enough that the step's own timeout in loop.yml, and
 * the Run record step after it, fit in the push job's 10 minutes. A host whose
 * preview builds for longer gets the never-answered note.
 */
export const PREVIEW_POLL_MINUTES = 4;

/** How long the step waits between polls. */
const POLL_INTERVAL_MS = 15_000;

/** How long one poll waits for the preview to answer before it counts as no answer. */
const REQUEST_TIMEOUT_MS = 10_000;

/** What polling needs: the HTTP status a URL answers with (throwing when nothing answers), and a clock. */
export interface PreviewPoller {
  status(url: string): Promise<number>;
  wait(ms: number): Promise<void>;
  now(): number;
}

/** The preview to link, as Run the Loop handed it on, and the Actions run whose evidence section waits on it. */
export interface PreviewToPoll extends PreviewToLink {
  readonly run: number;
}

/** What came of it: the section links the preview, says it never answered, or no longer waits on it, so it's left as it was. */
export type PreviewLinkOutcome = { readonly kind: "linked" } | { readonly kind: "never-answered" } | { readonly kind: "unchanged" };

/**
 * Polls the preview until it answers, then edits the PR's body, read once the
 * polling is done, so its evidence section links the preview, or says it never
 * answered. Only the section `run` wrote changes, and only while it still
 * waits on the preview; the rest of the body stays as it was.
 */
export async function linkPreview(
  github: Pick<GitHub, "rest">,
  repo: Repo,
  { pullRequest, url, run }: PreviewToPoll,
  poller: PreviewPoller,
): Promise<PreviewLinkOutcome> {
  const answered = await answersWithin(url, PREVIEW_POLL_MINUTES * 60_000, poller);
  const path = `/repos/${repo.owner}/${repo.name}/pulls/${pullRequest}`;
  const { body } = (await github.rest("GET", path)) as { body: string | null };
  const preview: PreviewLink = answered ? { kind: "linked", url } : { kind: "never-answered", url };
  const edited = withPreviewLink(body ?? "", run, preview);
  if (edited === null) return { kind: "unchanged" };
  await github.rest("PATCH", path, { body: edited });
  return { kind: answered ? "linked" : "never-answered" };
}

/**
 * Polls a prototype round's preview until it answers, then edits the round,
 * read once the polling is done, so each variant's line links its preview, or
 * the round says the preview never answered. Only the line the Kit wrote to
 * say the previews are linked once it answers changes it, and only while the
 * round still says so; the rest of the round stays as it was.
 */
export async function linkPrototypePreview(
  github: Pick<GitHub, "rest">,
  repo: Repo,
  { round, url }: PrototypePreviewToLink,
  poller: PreviewPoller,
): Promise<PreviewLinkOutcome> {
  const answered = await answersWithin(url, PREVIEW_POLL_MINUTES * 60_000, poller);
  const path = `/repos/${repo.owner}/${repo.name}/issues/comments/${round}`;
  const { body } = (await github.rest("GET", path)) as { body: string | null };
  const edited = withVariantPreviews(body ?? "", answered ? { kind: "linked", url } : { kind: "never-answered", url });
  if (edited === null) return { kind: "unchanged" };
  await github.rest("PATCH", path, { body: edited });
  return { kind: answered ? "linked" : "never-answered" };
}

/**
 * Whether the URL answers with a page (a 2xx, once redirects are followed)
 * within `budgetMs`, polling it at once, then every POLL_INTERVAL_MS, and one
 * last time when the budget runs out. Anything else, a 404 from a host still
 * building, a server error, a sign-in or no answer at all, counts as not yet.
 */
async function answersWithin(url: string, budgetMs: number, poller: PreviewPoller): Promise<boolean> {
  const deadline = poller.now() + budgetMs;
  for (;;) {
    const status = await poller.status(url).catch(() => null);
    if (status !== null && status >= 200 && status <= 299) return true;
    const left = deadline - poller.now();
    if (left <= 0) return false;
    await poller.wait(Math.min(POLL_INTERVAL_MS, left));
  }
}

/**
 * The status the URL answers with once redirects are followed, as the
 * Operator's browser would get it, giving up after REQUEST_TIMEOUT_MS. It reads
 * no more of the page than its status.
 */
export async function httpStatus(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<number> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  await response.body?.cancel();
  return response.status;
}

/** The step summary's line for what came of the preview. */
export function previewLinkSummary(pullRequest: number, url: string, outcome: PreviewLinkOutcome): string {
  switch (outcome.kind) {
    case "linked":
      return `Linked #${pullRequest}'s preview deployment, which answered at ${url}.`;
    case "never-answered":
      return `#${pullRequest}'s preview at ${url} never answered in ${PREVIEW_POLL_MINUTES} minutes, so its evidence section says so.`;
    case "unchanged":
      return `#${pullRequest}'s body holds no evidence section of this run waiting on its preview, so the Kit left it as it was.`;
  }
}

/** The prototype preview step's summary line for what came of the round's preview. */
export function prototypePreviewSummary(round: number, url: string, outcome: PreviewLinkOutcome): string {
  switch (outcome.kind) {
    case "linked":
      return `Linked each variant's preview in the prototype round, comment ${round}, as its preview answered at ${url}.`;
    case "never-answered":
      return `The prototype's preview at ${url} never answered in ${PREVIEW_POLL_MINUTES} minutes, so its round, comment ${round}, says so.`;
    case "unchanged":
      return `Comment ${round} is no prototype round waiting on its preview, so the Kit left it as it was.`;
  }
}
