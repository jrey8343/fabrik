// The Deployments read (#633): for one Product repo, whether each merge a
// reader asks about has been deployed to the environment its Kit config's
// production block names, read from GitHub's Deployments (ADR-0021). A merge
// is live when GitHub shows a successful Deployment in that environment, of
// the merge commit or a later commit that contains it. It is made over REST
// with the reader's own credential, which needs Deployments read; no Kit job
// makes it.
import type { ReadClient } from "../github/client.ts";

/** What a Deployments read of one repo says about the merges it was asked about. */
export interface DeploymentsRead {
  /** The repo read, `owner/name`. */
  readonly repo: string;
  /** The environment read, the name Kit config's production block gives. */
  readonly environment: string;
  /** When it was read, ISO 8601. */
  readonly readAt: string;
  /** Each merge asked about, by its merge commit: how its deploy stands, or unread. */
  readonly merges: Readonly<Record<string, DeployOf | "unread">>;
}

/** How one merge's deploy stands. */
export interface DeployOf {
  readonly is: "none" | "running" | "succeeded" | "failed";
  /** GitHub's id of the Deployment that decided it; null for none. */
  readonly deployment: number | null;
  /** The commit that Deployment deployed; null for none. */
  readonly commit: string | null;
  /** When it came to be so, ISO 8601; null for none. */
  readonly at: string | null;
  /** A failed deploy's log, when it is an `https` address; else null. */
  readonly log: string | null;
}

/** One merge a Deployments read is asked about. */
export interface MergeToRead {
  /** The commit the merge made on the default branch. */
  readonly mergeCommit: string;
  /** When it merged, ISO 8601. */
  readonly mergedAt: string;
}

/**
 * Whether each of `merges` has been deployed to `environment` in `repo`, read
 * at `now`. Asked about none, it makes no request.
 */
export async function readDeployments(
  _client: Pick<ReadClient, "rest">,
  repo: string,
  environment: string,
  merges: readonly MergeToRead[],
  now: string,
): Promise<DeploymentsRead> {
  if (merges.length === 0) return { repo, environment, readAt: now, merges: {} };
  throw new Error("not yet");
}
