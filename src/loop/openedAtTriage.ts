// The issue the Kit opens itself, whatever it opens it for (ADR-0039): a
// Spin-off, on the Operator's word (src/loop/spinOffs.ts), or a Follow-up
// that is a fault, on the Kit's own judgement (src/loop/followUpIssues.ts).
// Every such issue enters at Triage and carries a marker, not a label. Pure,
// no I/O.
import { NEEDS_TRIAGE } from "./labels.ts";
import { withoutMentions } from "./mentions.ts";
import type { Action, CreatedIssue, FollowedSpec, OpenTicketRef } from "./types.ts";

/** What an issue the Kit opens holds, beside its marker. */
export interface OpenedAtTriage {
  readonly title: string;
  /** The agent's text, which may be empty. */
  readonly body: string;
  /** Lines the Kit writes after the text, each after a blank line, such as a `From PR` line. */
  readonly lines?: readonly string[];
}

/**
 * Opens one issue as the Fabrik App, the way ADR-0039 has the Kit open every
 * issue of its own. It enters at Triage: it is opened with `needs-triage`,
 * as a Check's issue is, and no other label, so Triage gives it its
 * category, and its `labeled` event starts the run. Its body opens with
 * `marker`, the line that says what the issue is and where it came from,
 * then holds the agent's text, which mentions nobody, then each of `lines`
 * after a blank line. With no text, the lines follow the marker directly.
 * It is no sub-issue, and waits, by native blocked-by edges, on `blockedBy`
 * alone. `follows`, when given, is the Spec whose `Follows` line the adapter
 * ends the body with.
 */
export function openAtTriage(
  issue: CreatedIssue,
  marker: string,
  { title, body, lines = [] }: OpenedAtTriage,
  blockedBy: readonly (CreatedIssue | OpenTicketRef)[] = [],
  follows: FollowedSpec | null = null,
): Action {
  const text = withoutMentions(body);
  return {
    kind: "create-issue",
    key: issue.created,
    title: withoutMentions(title),
    body: [marker, ...(text === "" ? lines : [text, ...lines.flatMap((line) => ["", line])])].join("\n"),
    labels: [NEEDS_TRIAGE],
    parent: null,
    blockedBy,
    ...(follows === null ? {} : { follows }),
  };
}
