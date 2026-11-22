// A Follow-up that is a fault opens as an issue at the merge (#885,
// ADR-0039). When an agent pull request merges, the Kit opens each fault any
// pass on it named as an issue of its own, which enters at Triage, up to the
// room under `caps.follow_up_issues`, and says so in one quiet comment on
// the pull request. A fault over the cap stays an Open as issue link there,
// and one that is already an issue is not opened again. The comment's mark
// makes it happen once. An idea is never opened: it stays the link its
// Verdict comment gave it (src/loop/followUps.ts). Pure, no I/O.
import type { KitConfig } from "../kit/config.ts";
import { issueTitleOf, oncePerTitle, openAsIssueLink } from "./followUps.ts";
import { joinLinked, type Linked, linkedComment } from "./linked.ts";
import { FOLLOW_UPS_OPENED_MARKER, followUpLeftLine, followUpMarker, followUpOpenedLine, fromPullRequestLine } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import { openAtTriage } from "./openedAtTriage.ts";
import type { Action, CreatedIssue, FollowUpIssuesSnapshot, LoopEvent, PullRequestSnapshot } from "./types.ts";
import type { Fault } from "./verdict.ts";

type PullRequestClosed = Extract<LoopEvent, { kind: "pull-request-closed" }>;

/** The issue a plan creates for the fault at this place among those it opens, counted from 0. */
function followUpIssue(index: number): CreatedIssue {
  return { created: `follow-up:${index + 1}` };
}

/**
 * For an agent pull request that has just merged: opens the faults its
 * passes named as issues, then posts the comment that says what became of
 * each. Nothing for one closed unmerged, one whose passes named no fault,
 * one whose comment is already posted, so a second look at the same merge
 * opens nothing more, and one the snapshot read no issues for.
 *
 * - **Which faults.** Every fault any pass named, in the order named
 *   (`pullRequest.faults`), less one whose trimmed title repeats an earlier
 *   one's.
 * - **Already an issue.** One whose title an issue of this pull request
 *   already has (`issues.ofPullRequest`) is not opened again. When the
 *   Operator opened that issue from its link, the comment names it apart.
 *   When the Fabrik App did, in an earlier plan for this merge that was
 *   only partly applied, the comment records it as the issue the Kit
 *   opened for the fault, as if this plan had: that plan left no comment,
 *   and the comment is where the Retro's evidence and a row read which
 *   issue a fault became.
 * - **The cap.** The rest open in order while fewer than
 *   `caps.follow_up_issues` such issues are open, the ones this plan opens
 *   counted. Each one past that stays an Open as issue link in the comment.
 */
export function openFaults({ merged }: PullRequestClosed, pullRequest: PullRequestSnapshot, issues: FollowUpIssuesSnapshot | null, config: KitConfig): Action[] {
  if (!merged || pullRequest.followUpsOpened || issues === null) return [];
  const faults = oncePerTitle(pullRequest.faults);
  if (faults.length === 0) return [];
  const existing = (fault: Fault) => issues.ofPullRequest.find(({ title }) => title.trim() === issueTitleOf(fault.title.trim()).trim());
  const fresh = faults.filter((fault) => existing(fault) === undefined);
  const room = Math.max(0, config.caps.followUpIssues - issues.open);
  const [opening, left] = [fresh.slice(0, room), fresh.slice(room)];
  // Each fault the Kit opened an issue for, in the order named: the issue this plan opens, or the one an earlier plan of the Kit's did.
  const opened = faults.flatMap((fault): OpenedFault[] => {
    const issue = existing(fault);
    if (issue?.openedBy === "kit") return [{ fault, issue: issue.number }];
    const at = opening.indexOf(fault);
    return at === -1 ? [] : [{ fault, issue: followUpIssue(at) }];
  });
  const already = faults.flatMap((fault) => {
    const issue = existing(fault);
    return issue?.openedBy === "operator" ? [{ fault, issue: issue.number }] : [];
  });
  const { number } = pullRequest;
  return [
    ...opening.map((fault, at) => openFault(followUpIssue(at), fault, number)),
    linkedComment(number, [
      FOLLOW_UPS_OPENED_MARKER,
      ...opened.flatMap(({ fault, issue }): Linked => ["\n", ...followUpOpenedLine(issue, fault.title)]),
      ...left.map(({ title }) => `\n${followUpLeftLine(title)}`),
      "\n",
      ...joinLinked(
        [
          ...(opened.length === 0 ? [] : [openedPart(opened)]),
          ...(left.length === 0 ? [] : [leftPart(left, issues, number, config.caps.followUpIssues)]),
          ...(already.length === 0 ? [] : [alreadyPart(already)]),
        ],
        "\n\n",
      ),
    ]),
  ];
}

/** A fault with the issue the Kit opened for it: one this plan creates, or the number of one already there. */
interface OpenedFault {
  readonly fault: Fault;
  readonly issue: CreatedIssue | number;
}

/**
 * Opens one fault as an issue of its own, as the Kit opens every issue of
 * its own (openAtTriage): with `needs-triage` alone, as a Spin-off is. Its
 * body opens with the Follow-up marker, which names the pull request, then
 * holds the Reviewer's text, and ends with the `From PR` line an issue
 * opened from the link ends with. Its title is cut to what GitHub takes, as
 * that link cuts it. Nothing blocks it: the pull request it was found
 * beside has merged.
 */
function openFault(issue: CreatedIssue, { title, body }: Fault, pullRequest: number): Action {
  return openAtTriage(issue, followUpMarker(pullRequest), { title: issueTitleOf(withoutMentions(title)), body, lines: [fromPullRequestLine(pullRequest)] });
}

/** The comment's part naming each issue the Kit opened for a fault, in this plan or an earlier one. */
function openedPart(opened: readonly OpenedFault[]): Linked {
  return [
    `This pull request merged, so the Kit opened each of these faults its passes named as an issue, which enters at Triage (ADR-0039):\n`,
    ...opened.flatMap(({ fault, issue }): Linked => (typeof issue === "number" ? [`\n- #${issue} ${withoutMentions(fault.title)}`] : ["\n- ", issue, ` ${withoutMentions(fault.title)}`])),
  ];
}

/** The comment's part giving each fault over the cap its Open as issue link. */
function leftPart(left: readonly Fault[], { repoUrl, open }: FollowUpIssuesSnapshot, pullRequest: number, cap: number): Linked {
  const why =
    cap === 0
      ? "`caps.follow_up_issues` is 0, so the Kit opens no fault as an issue. Each of these faults this pull request's passes named stays a link:"
      : `\`caps.follow_up_issues\` is ${cap} and the Kit had ${open} such ${open === 1 ? "issue" : "issues"} open when this pull request merged, so each of these faults its passes named stays a link:`;
  return [
    `${why}\n`,
    ...left.map(({ title, body }) => `\n- ${withoutMentions(title)}: ${openAsIssueLink(repoUrl, withoutMentions(title), withoutMentions(body), pullRequest)}`),
  ];
}

/** The comment's part naming each fault that was an issue already. */
function alreadyPart(already: readonly { readonly fault: Fault; readonly issue: number }[]): Linked {
  return [
    "Already an issue when this pull request merged, so the Kit opened none for it:\n",
    ...already.map(({ fault, issue }) => `\n- #${issue} ${withoutMentions(fault.title)}`),
  ];
}
