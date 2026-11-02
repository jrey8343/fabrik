---
name: fabrik-live-design
description: Take an issue's Fabrik Design session live with the Operator, then publish its outcome and post it to the issue so the Loop carries on. Run as /fabrik-live-design <issue number>.
disable-model-invocation: true
---

# Live Design session

The Operator is taking the Design session on issue `$ARGUMENTS` live, in this cloud or local session, instead of answering numbered rounds on the issue. It must end the way an async session does, so the Loop can carry on: the issue becomes its agent brief, or a Spec and its Tickets replace it.

This session runs with the Operator's own GitHub credentials, so you publish the outcome yourself with `gh` (see `docs/agents/issue-tracker.md`). If `gh auth status` fails, stop and tell the Operator before doing anything else.

## Before you start

1. Read the issue and its whole thread: `gh issue view <n> --json number,title,body,labels,comments,state`.
2. Check that it's open and labelled `needs-design`. If it isn't, it's not in a Design session: tell the Operator and stop.
3. Earlier rounds the Kit posted start with `<!-- fabrik:design-round N -->`. The Operator's replies to them are decisions already made. An answer of `yes` takes every recommendation in that round.
4. Read `GLOSSARY.md` and `docs/adr/` if they exist, and use the repo's terms.

## While the session runs

- **Post nothing to the issue until the end, and change none of its labels.** Every comment the Operator's account posts on a `needs-design` issue starts an async turn, and the Kit moves the labels when your outcome comment lands.
- Grill the Operator as `.claude/skills/grilling/SKILL.md` describes: one decision at a time, each with your recommended answer. Never ask what the repository can answer.

## Ending the session

Do exactly one of these, once nothing that matters is open or the Operator wants to stop. Every comment and issue you write here contains no @-mentions.

### The work fits one pull request: an agent brief

1. Rewrite the issue's body as its agent brief (`gh issue edit <n> --body-file …`), following `.claude/skills/triage/AGENT-BRIEF.md`, in this shape:

   ```
   ## Agent brief

   <what to build and why, the decisions the session made, what's out of scope>

   ## Acceptance criteria

   - [ ] <one check a test could make>

   <sub>Written by a live Fabrik Design session. The original issue is in this issue's edit history.</sub>
   ```

2. Post the outcome comment last. Its first line is exactly the marker, with nothing before it:

   ```
   <!-- fabrik:live-outcome brief -->
   **Design session finished live.** This issue is now its agent brief, ready for an Implementer.

   <the decisions the session made, briefly>
   ```

### The work is bigger: a Spec and its Tickets

1. Write the Spec as `.claude/skills/to-spec/SKILL.md` does, and slice it into Tickets as `.claude/skills/to-tickets/SKILL.md` does. Publish them with `gh`, skipping any step in those skills that asks for labels other than these:
   - The Spec, and every Ticket, gets this issue's category label (`bug` or `enhancement`) and `ready-for-agent`, set with `--label` when you create it, so Intake never sends it to Triage.
   - Each Ticket is a sub-issue of the Spec (`gh issue create --parent <spec>`).
   - Each blocker is a native blocked-by edge (see **Blocking** in `docs/agents/issue-tracker.md`). Add every edge before step 2: your outcome comment starts Dispatch, which releases any Ticket with no open blocker.
   - End the Spec's body with `<sub>Written by a live Fabrik Design session on #<n>, which this Spec supersedes.</sub>`.
2. Post the outcome comment last. Its first line is exactly the marker:

   ```
   <!-- fabrik:live-outcome spec -->
   **Design session finished live.** This issue is superseded by the Spec #<spec> and its <count> Tickets.

   <the decisions the session made, briefly>
   ```

3. Don't close the issue or remove its labels. The Kit does that when it sees the comment.

### Stopping before it's finished

Post one comment, with no marker, that lists every decision the session made and the questions still open. That comment counts as the Operator's answer, so the async session takes its next turn from there and posts the next round.

## What the Kit does with the outcome

The Fabrik App sees the marker on the Operator's comment. For `brief` it swaps `needs-design` for `ready-for-agent`; for `spec` it removes `needs-design` and closes this issue as completed. Either way it then runs a Dispatch check, so the new Tickets start as they would after an async session.
