---
name: fabrik-live-design
description: Take an issue's Fabrik Design session live with the Operator, then publish its outcome and post it to the issue so the Loop carries on. Run as /fabrik-live-design <issue number>.
disable-model-invocation: true
---

# Live Design session

The Operator is taking the Design session on issue `$ARGUMENTS` live, in this cloud or local session, instead of answering numbered rounds on the issue. It must end the way an async session does, so the Loop can carry on: the issue becomes its agent brief or its Operator brief, or a Spec and its Tickets (some of which may be Operator steps) replace it.

This session runs with the Operator's own GitHub credentials, so you publish the outcome yourself with `gh` (see `docs/agents/issue-tracker.md`). If `gh auth status` fails, stop and tell the Operator before doing anything else.

## Before you start

1. Read the issue and its whole thread: `gh issue view <n> --json number,title,body,labels,comments,state`.
2. Check that it's open and labelled `needs-design`. If it isn't, it's not in a Design session: tell the Operator and stop.
3. Earlier rounds the Kit posted start with `<!-- fabrik:design-round N -->`. The Operator's replies to them are decisions already made. An answer of `yes` takes every recommendation in that round.
4. Read `GLOSSARY.md` and `docs/adr/` if they exist, and use the repo's terms.

## While the session runs

- **Post nothing to the issue until the end, and change none of its labels.** Every comment the Operator's account posts on a `needs-design` issue starts an async turn, and the Kit moves the labels when your outcome comment lands.
- Grill the Operator as `.claude/skills/grilling/SKILL.md` describes: one decision at a time, each with your recommended answer. Never ask what the repository can answer.
- **Facts only the Operator can fetch** (IDs, prices or settings held in another system) don't hold the session up. Settle the decisions without them and end with a Spec in which an Operator step gathers the facts and commits them, through its Pairing session's pull request, to a file in the Product repo that the code reads. The step's last task names that file and the shape the Tickets expect. Only the Tickets that read that file are blocked by it. If the Operator says they have the facts to hand, take them now and add no step.

## Ending the session

Do exactly one of these, once nothing that matters is open or the Operator wants to stop. Every comment and issue you write here contains no @-mentions.

Some lines of the issue's old body mark it for something that reads it later, so carry them forward into the body you write in its place, each exactly as the old body had it:

- Keep any `<!-- fabrik:monitor … -->` line as the first line of the issue's rewritten body (`gh issue edit`), and nothing else of the Monitor's. The Monitor finds the error it filed the issue for by that line, and would file it again without it.
- Carry any `From audit #<n>` line, `<!-- fabrik:escape … -->` line and `From retro #<n>` or `From retro <owner>/<repo>#<n>` line into the rewritten brief or the Spec that supersedes it. After everything else, its `<sub>` line included, add a blank line and then each of those lines, in the old body's order. The next Audit reads `From audit` to skip the issue, the Weekly summary counts the escape line as an Architectural escape, and the next Retro reads `From retro` to skip the proposal the issue was filed from, so all of them must survive the rewrite.
- Carry only lines outside fenced code blocks. A fenced block opens on a line starting with `` ``` `` or `~~~` and ends on the line that closes that fence; indenting a line leaves it outside one. A line inside one is quoted data, such as the Sentry error title a Monitor issue quotes, never a line to carry, whatever it says. A fence that never closes quotes nothing, so the lines after it are carried as usual: a filed Audit candidate whose body was cut short inside a code block ends with its `From audit` and escape lines below that open fence, and both are carried.

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

### The whole issue is Operator work that fits one sitting: an Operator brief

Use this when only the Operator can do the work (a secret, a repo setting, a trust-root edit) and it needs no pull request from an Implementer.

1. Rewrite the issue's body as its Operator brief (`gh issue edit <n> --body-file …`), in this shape. Each step is one action the Operator takes:

   ```
   ## Operator brief

   <what needs doing and why, the decisions the session made>

   ## Steps

   - [ ] <one action the Operator takes>

   <sub>Written by a live Fabrik Design session. The original issue is in this issue's edit history.</sub>
   ```

2. Post the outcome comment last. Its first line is exactly the marker:

   ```
   <!-- fabrik:live-outcome operator-brief -->
   **Design session finished live.** This issue is now an Operator brief, ready for a Pairing session.

   <the decisions the session made, briefly>
   ```

### The work is bigger: a Spec and its Tickets

1. Write the Spec as `.claude/skills/to-spec/SKILL.md` does, and slice it into Tickets as `.claude/skills/to-tickets/SKILL.md` does. Publish them with `gh`, skipping any step in those skills that asks for labels other than these:
   - The Spec, and every Ticket, gets this issue's category label (`bug` or `enhancement`) and `ready-for-agent`, set with `--label` when you create it, so Intake never sends it to Triage.
   - A piece only the Operator can do, that later Tickets must wait for or that belongs to no one pull request, is an **Operator step** instead of a Ticket. It gets the category label and `ready-for-human` (never `ready-for-agent`), is assigned to the Operator (`--assignee <operator>`), and its body ends with its steps as a task list under `## Steps`, one `- [ ]` line per action the Operator takes. A Spec may be made only of Operator steps.
   - Each Ticket and Operator step is a sub-issue of the Spec (`gh issue create --parent <spec>`).
   - Each blocker is a native blocked-by edge (see **Blocking** in `docs/agents/issue-tracker.md`), in either direction between Tickets and Operator steps. Add every edge before step 2: your outcome comment starts Dispatch, which releases any Ticket with no open blocker.
   - End the Spec's body with `<sub>Written by a live Fabrik Design session on #<n>, which this Spec supersedes.</sub>`, then any lines it carries forward from this issue's body.
2. Post the outcome comment last. Its first line is exactly the marker:

   ```
   <!-- fabrik:live-outcome spec -->
   **Design session finished live.** This issue is superseded by the Spec #<spec> and its <count> Tickets.

   <the decisions the session made, briefly>
   ```

   When some of the new items are Operator steps, count them too, as the Kit does: `and its 2 Tickets and 1 Operator step`, or `and its 2 Operator steps` when there are no Tickets. The assignment is what notifies the Operator, so still mention nobody.

3. Don't close the issue or remove its labels. The Kit does that when it sees the comment.

### Stopping before it's finished

Post one comment, with no marker, that lists every decision the session made and the questions still open. That comment counts as the Operator's answer, so the async session takes its next turn from there and posts the next round.

## What the Kit does with the outcome

The Fabrik App sees the marker on the Operator's comment. For `brief` it swaps `needs-design` for `ready-for-agent`; for `spec` it removes `needs-design` and closes this issue as completed. Either way it then runs a Dispatch check, so the new Tickets start as they would after an async session. Dispatch never releases an Operator step: it's `ready-for-human`.

For `operator-brief` it swaps `needs-design` for `ready-for-human` and assigns the issue to the Operator, ready for a Pairing session. It runs no Dispatch check.
