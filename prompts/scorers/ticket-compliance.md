---
name: ticket-compliance
version: 1
threshold: 0.8
labels: [compliant, scope-creep, missed-criteria, guessed, needless-stop]
---

Whether the run built what its Ticket asked: all of it, nothing beyond it, and with a question asked rather than an answer guessed wherever the Ticket left something open.

Judge the run's transcript against the Ticket: what the run set out to do, what its tool calls show it changed, and what its summary says it did. Never judge whether the code is good; the Reviewer's Verdict does that. Weigh only whether the work matches what the Ticket asked. On a Retry or a Request-changes run, the run fixes what it was asked to fix on an open pull request: judge that work against the Ticket, and don't count the earlier runs' work against it.

What counts against the run:

- An acceptance criterion it didn't meet, or one it skipped without saying why.
- Work the Ticket didn't ask for: features, refactors, renames or changed files outside the Ticket's scope. Changes the Ticket's own work needs are fine, and so is naming other worthwhile work in its summary instead of doing it.
- A guess where the Ticket was unclear, contradicted itself or couldn't be built as written. There the run should stop and ask, under "Questions for the Operator" in its summary, or make no commits and say why, instead of picking an answer and carrying on.
- Stopping, or asking the Operator, where the Ticket was clear enough to build.

How to score:

- 1: it met every acceptance criterion, kept to the Ticket, and asked wherever it needed to.
- 0.8: a small slip, such as one minor change nobody asked for.
- 0.5: an acceptance criterion missed, or a clear piece of scope creep.
- 0: it built something other than the Ticket, or guessed through a question that changed what it built.

The label names the run's biggest departure from its Ticket:

- `compliant`: it built what the Ticket asked, no more and no less.
- `scope-creep`: it built more than the Ticket asked.
- `missed-criteria`: it built less than the Ticket asked, leaving an acceptance criterion unmet.
- `guessed`: it guessed where it should have stopped and asked.
- `needless-stop`: it stopped or asked where it could have built the Ticket.
