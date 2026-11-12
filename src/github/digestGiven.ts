// The push job's read of what Kit code hands the Digest's contract beside the
// Digest writer's reply (DigestGiven, src/loop/digestContract.ts): what no
// agent wrote. src/main.ts reads it once the Digest job has succeeded, and
// the event that lands the Digest carries it, so the rules core renders the
// comment with no I/O of its own.
import type { DigestGiven } from "../loop/digestContract.ts";
import type { ReadClient, Repo } from "./client.ts";

/** What the push job already knows of a Digest when its run ends: where it goes, the head it is written as of, and its run. */
export interface DigestWritten {
  /** The Product repo's web address. */
  readonly repoUrl: string;
  readonly pullRequest: number;
  /** The head the Kit job's plan started the run at. */
  readonly headSha: string;
  /** The push job's own Actions run attempt. */
  readonly runUrl: string;
}

/**
 * What Kit code hands the contract for the Digest of `written.pullRequest`
 * at `written.headSha`. So far that is only what the push job knows already,
 * so nothing is read through `github`: it and `repo` are here for what the
 * contract is given from the pull request's thread and its head.
 */
export async function readDigestGiven(_github: ReadClient, _repo: Repo, written: DigestWritten): Promise<DigestGiven> {
  const { repoUrl, pullRequest, headSha, runUrl } = written;
  return { repoUrl, pullRequest, headSha, runUrl };
}
