// Kit-owned issues: a failure that stalls every run in a repo, not just one
// Ticket, buzzes the Operator once through an issue the Kit owns, rather than
// once per Ticket. A dead Claude token gets a "Rotate the Claude token" issue;
// the weekly usage limit gets one per window, which a scheduled tick closes
// after the reset. They don't restart stalled Tickets: each Ticket's own
// failure comment names the trigger label to re-add.
import type { Action, InfrastructureFailure, KitIssueSnapshot, Plan, Snapshot } from "./types.ts";

/** The repo-wide part of any snapshot: who the Operator is and which Kit-owned issues are open. */
type RepoContext = Pick<Snapshot, "kitIssues" | "operator">;

/** The label on the Kit's token-rotation issue, by which the adapter finds it. */
export const TOKEN_ROTATION_LABEL = "fabrik:token-rotation";

/** The label on the Kit's weekly-limit issue. */
export const WEEKLY_LIMIT_LABEL = "fabrik:weekly-limit";

/** Every label that marks an issue as the Kit's own, so the adapter reads it into the snapshot. */
export const KIT_ISSUE_LABELS: readonly string[] = [TOKEN_ROTATION_LABEL, WEEKLY_LIMIT_LABEL];

/** Where in its body the weekly-limit issue records when the limit resets, for the scheduled tick. */
const RESETS_AT_MARKER = "<!-- fabrik:resets-at";

/**
 * Left in the body or comment that buzzed the Operator about a Kit-owned
 * issue, so that later failures on it stay quiet.
 */
const NOTIFIED = "<!-- fabrik:notified -->";

/** The failed run, as the Ticket's failure comment names it. */
export interface StalledRun {
  /** Such as "The Triage run on #7". */
  readonly run: string;
  readonly runUrl: string;
  /** When the weekly limit resets, if known. */
  readonly resetsAt: string | null;
}

export interface RepoWideNotice {
  /** What the Kit does on its own issue. */
  readonly actions: readonly Action[];
  /** A line for the Ticket's failure comment, saying where the Operator hears about it. */
  readonly pointer: string;
}

function notified(issue: KitIssueSnapshot): boolean {
  return [issue.body, ...issue.comments].some((text) => text.includes(NOTIFIED));
}

/** The Kit-owned issue notice for a failure that stalls the whole repo, or null for one that doesn't. */
export function repoWideNotice(
  failure: InfrastructureFailure,
  snapshot: RepoContext,
  stalled: StalledRun,
): RepoWideNotice | null {
  switch (failure) {
    case "dead-token":
      return deadToken(snapshot, stalled);
    case "weekly-limit":
      return weeklyLimit(snapshot, stalled);
    default:
      return null;
  }
}

/** When the weekly-limit issue says the limit resets, or null if it doesn't say. */
function resetsAtOf(issue: KitIssueSnapshot): string | null {
  const start = issue.body.indexOf(RESETS_AT_MARKER);
  if (start === -1) return null;
  const end = issue.body.indexOf("-->", start);
  const value = issue.body.slice(start + RESETS_AT_MARKER.length, end === -1 ? undefined : end).trim();
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/** The scheduled tick: closes the weekly-limit issue once its reset time has passed. */
export function scheduledTick(now: string, { kitIssues }: Snapshot): Plan {
  const open = kitIssues.find((issue) => issue.labels.includes(WEEKLY_LIMIT_LABEL));
  if (open === undefined) return { kind: "nothing", reason: "No weekly-limit issue is open" };
  const resetsAt = resetsAtOf(open);
  if (resetsAt === null) {
    return { kind: "nothing", reason: `#${open.number} doesn't say when the weekly limit resets, so the Operator closes it` };
  }
  if (Date.parse(now) < Date.parse(resetsAt)) {
    return { kind: "nothing", reason: `The weekly limit in #${open.number} resets at ${readable(resetsAt)}` };
  }
  return {
    kind: "act",
    actions: [
      {
        kind: "comment",
        issue: open.number,
        body: `The weekly usage limit reset at ${readable(resetsAt)}, so the Kit is closing this issue. Stalled Tickets stay stalled until their trigger label is re-added.`,
      },
      { kind: "close", issue: open.number, reason: "completed" },
    ],
  };
}

/** Such as "2026-11-09 04:00 UTC". */
function readable(iso: string): string {
  const at = new Date(iso).toISOString();
  return `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
}

function weeklyLimit({ kitIssues, operator }: RepoContext, stalled: StalledRun): RepoWideNotice {
  const { resetsAt } = stalled;
  const open = kitIssues.find((issue) => issue.labels.includes(WEEKLY_LIMIT_LABEL));
  const openResetsAt = open === undefined ? null : resetsAtOf(open);
  // A later reset time than the open issue's means its window is over: this is a new one.
  const newWindow =
    open !== undefined && openResetsAt !== null && resetsAt !== null && Date.parse(resetsAt) > Date.parse(openResetsAt);
  if (open !== undefined && !newWindow) {
    const body = notified(open)
      ? `${stalled.run} stalled on the limit too. [The run](${stalled.runUrl})`
      : [
          `@${operator} ${stalled.run} hit the weekly usage limit${resetsAt === null ? "" : `, which resets at ${readable(resetsAt)}`}. Until then every agent run in this repo stalls. [The run](${stalled.runUrl})`,
          "",
          NOTIFIED,
        ].join("\n");
    return {
      actions: [{ kind: "comment", issue: open.number, body }],
      pointer: `The Kit is tracking this in #${open.number}.`,
    };
  }
  const title =
    resetsAt === null ? "The weekly usage limit is reached" : `The weekly usage limit is reached until ${readable(resetsAt)}`;
  const when =
    resetsAt === null
      ? "When it resets isn't known, so close this issue yourself once agent runs work again."
      : `It resets at ${readable(resetsAt)}.`;
  return {
    actions: [
      ...(open === undefined ? [] : [{ kind: "close" as const, issue: open.number, reason: "completed" as const }]),
      {
        kind: "open-issue",
        title,
        body: [
          // The @-mention is this issue's one notification.
          `@${operator} ${stalled.run} hit the weekly usage limit. ${when} Until then every agent run in this repo stalls, and the Kit comments here about each one.`,
          "",
          `${resetsAt === null ? "" : "The Kit closes this issue after the reset. "}It doesn't restart stalled Tickets: re-add the trigger label named in each Ticket's failure comment.`,
          "",
          `[The first stalled run](${stalled.runUrl})`,
          "",
          NOTIFIED,
          ...(resetsAt === null ? [] : [`${RESETS_AT_MARKER} ${resetsAt} -->`]),
        ].join("\n"),
        labels: [WEEKLY_LIMIT_LABEL],
        assignees: [],
      },
    ],
    pointer: "The Kit has opened a weekly-limit issue for the Operator.",
  };
}

function deadToken({ kitIssues, operator }: RepoContext, stalled: StalledRun): RepoWideNotice {
  const open = kitIssues.find((issue) => issue.labels.includes(TOKEN_ROTATION_LABEL));
  if (open === undefined) {
    return {
      actions: [
        {
          kind: "open-issue",
          title: "Rotate the Claude token",
          body: [
            `The Claude token that every Fabrik run in this repo uses was refused (\`authentication_failed\`). ${stalled.run} was the first to fail, and no agent run can start until the token is rotated.`,
            "",
            "1. Run `claude setup-token` and save the new token, with its expiry date, in the `Claude token` item in the Fabrik 1Password vault.",
            "2. Re-add the trigger label on each Ticket the Kit commented on, to run it again.",
            "3. Close this issue, so that the next dead token opens a fresh one.",
            "",
            `[The first refused run](${stalled.runUrl})`,
            "",
            NOTIFIED,
          ].join("\n"),
          labels: ["ready-for-human", TOKEN_ROTATION_LABEL],
          // The assignment is this issue's one notification.
          assignees: [operator],
        },
      ],
      pointer: "The Kit has opened a Rotate the Claude token issue for the Operator.",
    };
  }
  const body = notified(open)
    ? `${stalled.run} was refused too. [The run](${stalled.runUrl})`
    : [
        `@${operator} The Claude token was refused (\`authentication_failed\`), so no agent run in this repo can start until it's rotated. ${stalled.run} was the first to fail. [The run](${stalled.runUrl})`,
        "",
        NOTIFIED,
      ].join("\n");
  return {
    actions: [{ kind: "comment", issue: open.number, body }],
    pointer: `The Kit is tracking this in #${open.number}.`,
  };
}
