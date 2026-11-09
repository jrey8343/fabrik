---
name: ticket-compliance
version: 2
threshold: 0.8
labels: [compliant, scope-creep, missed-criteria, guessed, needless-stop]
---

Whether the run built what it was asked, its Ticket as any Request changes amended it: all of it, nothing beyond it, and with a question asked rather than an answer guessed wherever the Ticket left something open.

Judge the run's transcript against what it was asked: what the run set out to do, what its tool calls show it changed, and what its summary says it did. Never judge whether the code is good; the Reviewer's Verdict does that. Weigh only whether the work matches what it was asked. The run section says what kind of run it was and gives what its prompt carried beyond the Ticket:

- A first run was asked for the Ticket alone.
- A Request changes amends the Ticket for its pull request, and wins over the Ticket where they differ, however much it changes or widens the scope. On a Request-changes run, and on any run after one, judge against the Ticket as amended: building what the Operator asked for is never scope creep, and dropping what they asked to drop is never a missed criterion.
- A Retry fixes the latest Verdict's findings on an open pull request: judge that fix against the Ticket as any Request changes amended it.
- A conflict-only run was asked only to rebase the branch onto `main`, resolve the conflicts and change nothing else: judge it on that rebase alone, never on the Ticket's acceptance criteria, which the pull request's earlier runs built.

On any run on an open pull request, don't count the earlier runs' work against it.

What counts against the run:

- An acceptance criterion it was asked to meet and didn't, or one it skipped without saying why.
- Work it wasn't asked for: features, refactors, renames or changed files outside the scope it was asked to build. Changes the Ticket's own work needs are fine, and so is naming other worthwhile work in its summary instead of doing it.
- A guess where the Ticket was unclear, contradicted itself or couldn't be built as written. There the run should stop and ask, under "Questions for the Operator" in its summary, or make no commits and say why, instead of picking an answer and carrying on.
- Stopping, or asking the Operator, where the Ticket was clear enough to build.

How to score:

- 1: it met every acceptance criterion it was asked to meet, kept to what it was asked, and asked wherever it needed to.
- 0.8: a small slip, such as one minor change nobody asked for.
- 0.5: an acceptance criterion missed, or a clear piece of scope creep.
- 0: it built something other than what it was asked, or guessed through a question that changed what it built.

The label names the run's biggest departure from what it was asked:

- `compliant`: it built what it was asked, no more and no less.
- `scope-creep`: it built more than it was asked.
- `missed-criteria`: it built less than it was asked, leaving an acceptance criterion it was asked to meet unmet.
- `guessed`: it guessed where it should have stopped and asked.
- `needless-stop`: it stopped or asked where it could have built the Ticket.
