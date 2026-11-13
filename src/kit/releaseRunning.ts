// The Tick's word that a newly pinned release is running (#548): the first
// started Tick on a release says "Fabrik vX is running here" on the pull
// request that moved the caller workflow's pin to it, once. The hidden marker
// in the Fabrik App's comment, keyed by release, is the only state. Pure, no
// I/O: src/github/releaseRunning.ts reads the facts and posts the comment.
import { readable } from "../loop/readable.ts";
import { CALLER_PATH } from "../setup/shims.ts";
import { KIT_REPO } from "./caller.ts";

/** A comment on the pin move's pull request. */
export interface PullComment {
  readonly body: string;
  /** Whether the Fabrik App wrote it: a marker in anyone else's comment counts for nothing. */
  readonly byApp: boolean;
}

/** The newest commit on main that changed the release `fabrik.yml` pins. */
export interface PinMove {
  readonly sha: string;
  /** The release `fabrik.yml` pins at it, or null when it pins no exact release. */
  readonly release: string | null;
  /** The merged pull request it came from, or null for a direct push to main. */
  readonly pull: { readonly number: number; readonly comments: readonly PullComment[] } | null;
}

export interface ReleaseRunningFacts {
  /** The release this Tick runs on, from the Kit workflow ref the caller pinned. */
  readonly running: string;
  /** The newest pin move on main, or null when no commit there brings `fabrik.yml`. */
  readonly move: PinMove | null;
  /** This run's page. */
  readonly runUrl: string;
  /** When this run's first job started, ISO 8601. */
  readonly startedAt: string;
  /** The Operator's time zone from the Kit config (ADR-0023), null for UTC. */
  readonly timeZone: string | null;
}

export interface ReleaseRunningPlan {
  /** The comment to post, or null for none. */
  readonly comment: { readonly pull: number; readonly body: string } | null;
  /** The step summary's line. */
  readonly summary: string;
}

/** The hidden line ending the App's comment that says `release` is running. */
function releaseRunningMarker(release: string): string {
  return `<!-- fabrik:release-running ${release} -->`;
}

export function releaseRunningPlan({ running, move, runUrl, startedAt, timeZone }: ReleaseRunningFacts): ReleaseRunningPlan {
  if (move === null) return { comment: null, summary: `No commit on main brings \`${CALLER_PATH}\`, so nothing is posted.` };
  if (move.release === null) return { comment: null, summary: `\`${CALLER_PATH}\` on main pins no exact Fabrik release, so nothing is posted.` };
  const commit = move.sha.slice(0, 7);
  if (move.release !== running) {
    return {
      comment: null,
      summary: `This Tick runs on Fabrik ${running}, but the newest pin move on main, commit ${commit}, pins ${move.release}, so nothing is posted.`,
    };
  }
  const { pull } = move;
  if (pull === null) {
    return { comment: null, summary: `Fabrik ${running} is running here, but commit ${commit}, which moved the pin to it, came from no pull request, so nothing is posted.` };
  }
  const marker = releaseRunningMarker(running);
  if (pull.comments.some((comment) => comment.byApp && comment.body.includes(marker))) {
    return { comment: null, summary: `Fabrik ${running} is running here, and #${pull.number}, which moved the pin to it, says so already.` };
  }
  return {
    comment: {
      pull: pull.number,
      body: [
        `Fabrik ${running} is running here: the hourly Tick started on it at ${readable(startedAt, timeZone)} ([its run](${runUrl})). [${running}'s release notes](https://github.com/${KIT_REPO}/releases/tag/${running}) say what changed and whether anything needs turning on.`,
        "",
        releaseRunningMarker(running),
      ].join("\n"),
    },
    summary: `Fabrik ${running} is running here, so #${pull.number}, which moved the pin to it, is told.`,
  };
}
