// The caller read (#623): for one pull request, whether the caller workflow it
// proposes would run, in the Kit job's own words, and which release it moves
// the Kit from and to (a Kit bump's two releases). It calls the Kit job's own
// check on a pull request that changes the caller, with the same inputs, on
// the caller where Setup writes it, so the two cannot differ. A reader makes
// it when a screen opens on a Plain pull request, never in a gather; no merge
// waits on it. Read only.
import type { ReadClient, Repo } from "../github/client.ts";
import { checkCallerWorkflow } from "../kit/caller.ts";
import { callerChangeErrors } from "../kit/callerPermissions.ts";
import { CALLER_PATH } from "../setup/shims.ts";

export interface CallerRead {
  /** Whether the head's caller workflow differs from the base's. */
  readonly changes: boolean;
  /** The release the base's caller pins, or null when it has none or pins no exact release. */
  readonly from: string | null;
  /** The release the head's caller pins, or null when it has none or pins no exact release. */
  readonly to: string | null;
  /** The Kit job's own lines, word for word; empty when the caller at that head would run. */
  readonly errors: string[];
}

/** The release a caller pins, by the Kit's own reader of the pin; null for no caller or no exact release. */
function releaseOf(text: string | null): string | null {
  if (text === null) return null;
  const pins = checkCallerWorkflow(text);
  return pins.ok ? pins.release : null;
}

/**
 * What `pullRequest` in `repo` ("owner/name") does to the caller workflow:
 * two file reads in the repo (the base branch's caller and the head's), and
 * one from the Kit's repo for each of its workflows the head's caller names,
 * at the release it pins. "unread" when GitHub refuses or fails any of them.
 */
export async function readCaller(
  client: Pick<ReadClient, "rest" | "fileText">,
  repo: string,
  pullRequest: number,
): Promise<CallerRead | "unread"> {
  try {
    return await callerOf(client, repo, pullRequest);
  } catch {
    // A refusal, or a read GitHub failed, of the pull request, either caller or a Kit workflow.
    return "unread";
  }
}

async function callerOf(client: Pick<ReadClient, "rest" | "fileText">, repo: string, pullRequest: number): Promise<CallerRead> {
  const [owner = "", name = ""] = repo.split("/");
  const product: Repo = { owner, name };
  const pull = (await client.rest("GET", `/repos/${repo}/pulls/${pullRequest}`)) as { head: { sha: string }; base: { ref: string } };
  const headSha = pull.head.sha;
  const [base, head] = await Promise.all([
    client.fileText(product, CALLER_PATH, pull.base.ref),
    client.fileText(product, CALLER_PATH, headSha),
  ]);
  // The Kit job's check reads the head's caller itself: hand it the one already read, so the repo is read twice, not three times.
  const files = {
    fileText: (at: Repo, path: string, ref: string) =>
      at.owner === owner && at.name === name && path === CALLER_PATH && ref === headSha ? Promise.resolve(head) : client.fileText(at, path, ref),
  };
  const errors = await callerChangeErrors(files, product, { path: CALLER_PATH, baseText: base, headSha });
  return { changes: head !== null && head !== base, from: releaseOf(base), to: releaseOf(head), errors };
}
