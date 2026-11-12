// The push job's read of an agent PR's change fingerprint (#643), with git:
// GitHub's API leaves the patch out of a large file. The head and the default
// branch are fetched into an empty repository, as for the push job's branch
// work (src/github/branch.ts): nothing is checked out, and nothing from the
// Product repo runs. The fingerprint itself is pure (src/loop/changeFingerprint.ts).
import { type ChangeFingerprint, changeFingerprintOf, changeIn } from "../loop/changeFingerprint.ts";
import type { Plan, Snapshot } from "../loop/types.ts";
import { emptyRepository, MAIN_REF, type Remote } from "./branch.ts";
import { verdictsIn } from "./threads.ts";

/**
 * The diff a fingerprint is made from, spelled out so no setting of the
 * runner's changes it: no context, rename detection off, so a moved file is
 * its lines removed at one path and added at another, and full index lines,
 * which name a binary file's content.
 */
const DIFF = [
  "-c",
  "core.quotePath=false",
  "diff",
  "--no-renames",
  "--unified=0",
  "--inter-hunk-context=0",
  "--full-index",
  "--diff-algorithm=myers",
  "--submodule=short",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
] as const;

/**
 * The fingerprint of the PR's own change at `headSha`: that head against its
 * merge base with the default branch as it is now, so what the default branch
 * gained since the PR last met it is no part of it. The diff is read as the
 * bytes git prints, never as text: a file's lines are in whatever encoding
 * the file is, and reading them as UTF-8 would make two edits of a line that
 * is none look the same. Rejects when it can't be read: a fetch fails, or
 * the head shares no history with the default branch.
 */
export async function readChangeFingerprint(headSha: string, remote: Remote): Promise<ChangeFingerprint> {
  const { git, url } = await emptyRepository(remote);
  await git("fetch", "--quiet", "--no-tags", url, `+HEAD:${MAIN_REF}`);
  await git("fetch", "--quiet", "--no-tags", url, headSha);
  const base = await git("merge-base", MAIN_REF, headSha).then(
    (out) => out.trim(),
    () => {
      throw new Error(`${headSha.slice(0, 7)} has no merge base with the default branch`);
    },
  );
  return changeFingerprintOf(await git.bytes(...DIFF, base, headSha));
}

/** A plan, and why the Verdict it posts carries no change fingerprint; null when it carries one or the plan posts no Verdict. */
export interface PlannedWithChange {
  readonly plan: Plan;
  readonly unread: string | null;
}

/**
 * The plan for a snapshot, with the PR's change fingerprint on the Verdict it
 * posts. No snapshot holds the fingerprint until it's read, so the snapshot
 * is planned first without it; only a plan that posts a Verdict has `read`
 * fetch anything, and the snapshot is then planned again holding it. A
 * Verdict never fails for want of one: when it can't be read, the first plan
 * stands, and `unread` says why for the step summary.
 */
export async function planWithChange(
  snapshot: Snapshot,
  plan: (snapshot: Snapshot) => Plan,
  read: (headSha: string) => Promise<ChangeFingerprint>,
): Promise<PlannedWithChange> {
  const first = plan(snapshot);
  const verdict = verdictPostedIn(first);
  const { pullRequest } = snapshot;
  if (verdict === null || pullRequest === null) return { plan: first, unread: null };
  const without = (why: string): PlannedWithChange => ({
    plan: first,
    unread: `The Verdict on #${pullRequest.number} was posted without a change fingerprint: ${why}.`,
  });
  if (verdict.headSha !== pullRequest.headSha) {
    return without(`it is on ${verdict.headSha.slice(0, 7)}, which the pull request has moved on from`);
  }
  let change: ChangeFingerprint;
  try {
    change = await read(pullRequest.headSha);
  } catch (error) {
    return without(`the fingerprint could not be read at ${pullRequest.headSha.slice(0, 7)} (${error instanceof Error ? error.message : String(error)})`);
  }
  const second = plan({ ...snapshot, pullRequest: { ...pullRequest, change } });
  const recorded = verdictPostedIn(second);
  if (recorded === null || !recorded.change) return without("the comment had no room for its line");
  return { plan: second, unread: null };
}

/** The Verdict a plan posts: the head it is on, and whether its comment records a fingerprint; null when it posts none. */
function verdictPostedIn(plan: Plan): { readonly headSha: string; readonly change: boolean } | null {
  if (plan.kind !== "act") return null;
  for (const action of plan.actions) {
    if (action.kind !== "comment") continue;
    const [record] = verdictsIn([action.body]);
    if (record !== undefined) return { headSha: record.headSha, change: changeIn(action.body) !== null };
  }
  return null;
}
