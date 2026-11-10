# A Stepped-up start is a label the Kit reads at every Implement run

In the baseline week (#346), 7 of 20 Tickets' first attempts went on to a Step-up, after $7.95 of default-model work and one or two Retry cycles of waiting. The Design session already runs on the Step-up model and reads the code before it writes a Ticket, so it can judge when work is heavy. A Design session or the Operator marks such a Ticket with the `fabrik:step-up` label, and every Implement run that starts while the label is on the Ticket is a Step-up. That covers the first run, the Retries and Request-changes runs. Adding the label mid-chain steps up the next run, and removing it drops back to the default model, except for the second Retry and a Retry called for by a flaw on a conflict-only or Request-changes run's push, which step up regardless (#464). A marked Ticket still gets two Retries before the next Execution flaw counts as a Design flaw. It has no further Step-up to fall back on, because three failures on the strongest model mean the Ticket needs a Design session. Triage's Fast path never marks a Ticket. A Design session that writes or rewrites a Ticket sets or clears the mark again, weighing any chain that failed before.

Every Run record whose run used the Step-up model says so (`stepUp: true`) and records why: `retry`, `marked`, `request-changes` or `conflict-only`. A Replay takes a Ticket's first run by its place in the chain, not by whether it Stepped up, so a marked Ticket can be replayed. Its baseline arm runs as it was built, on the Step-up model, and no Replay arm reads the label. A Replay over marked Tickets with `implement.model` set to the default model therefore measures how many marks weren't needed.

## Considered options

- **A Quick call with Jev at Dispatch (#350).** Cut: it needed a new vendor and secret, and it couldn't read the code, so its ceiling was below the Design session's.
- **Start every Ticket on the Step-up model.** Roughly break-even on the baseline week, and it pays the Step-up price for the 13 in 20 Tickets that never needed it.
- **A line in the Ticket body.** The Kit would have to parse it, a Request changes amending the Ticket blurs whether it still holds, and the Operator can't toggle it in one click or see who set it.
- **Read the mark only at Dispatch.** This fixes the model for the whole chain, and it leaves the Operator only ADR-0006's red-head push as a way to step up a Ticket mid-chain.

## Consequences

- `request-changes` and `conflict-only` runs, which always ran on the Step-up model, now record `stepUp: true`. The weekly summary breaks Step-ups down by reason so the count doesn't jump unexplained, and the Scorer, which scores every Step-up, now always scores these runs and every marked first run.
- The Design session's judgment is the thing to watch. After about 10 marked Tickets or 4 weeks, a Replay with the default model measures the false-positive rate, at about $0.68 per unneeded mark on the baseline's medians.
