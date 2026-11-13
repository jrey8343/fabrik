# The Merge-gate cap counts work on its way to the gate

A pass takes an agent pull request out of draft to the Merge gate, where it waits on the Operator. `max_in_flight` counts open agent draft PRs, so a PR stops counting the moment it reaches the gate, and Dispatch releases more work while passed PRs pile up, each with its own review request. The README calls `caps` the attention budget. Every factory practice we follow puts a limit on the work waiting for a human to review it.

`caps.merge_gate` (default 3, a cap like the others, so it can only be lowered) is a **hard bound** on the agent PRs waiting on the Operator. Dispatch releases a Ticket only if its PR could fit at the gate:

- **Gate load** is the open agent PRs out of draft (at the gate) plus the Ticket work on its way there: open agent draft PRs, Implement runs for a Ticket with no open agent PR, and Tickets dispatched and waiting or held. A passed draft waiting on its Digest counts once, as a draft, and so does a draft with a Retry or Request-changes run under way: the run is its PR's work. An Implement run whose job names no Ticket counts, as nothing shows it has a PR.
- **Free Ticket slots** are the lesser of `max_in_flight` minus what's in flight and `caps.merge_gate` minus the gate load.
- **Research runs and Decisions count for neither**, as they never reach the gate, and still release while it holds Tickets.
- **`0` holds Tickets while any agent PR is at or on its way to the gate.** With nothing there a Ticket still goes, one at a time, so `0` holds as `1` does and only words its hold differently; it is no pause, unlike `max_in_flight: 0`.
- **A Request changes frees nothing**: the PR moves from the gate back to work on its way there. A merge or a close frees a slot, and `pull-request-closed` already runs a Dispatch check.
- **It is its own cap, apart from `max_in_flight`**: `max_in_flight` stays agent work in flight, and `caps.merge_gate` is the attention budget. When both hold a Ticket, its Standing and the Weekly summary name the Merge gate, since that is the cap the Operator can clear.

## Considered options

- **A soft cap: count only the PRs at the gate.** It is simpler, but it lets up to `max_in_flight` more PRs arrive after the gate is full, since work already on its way counts nowhere. Only the hard bound keeps the promise that at most 3 PRs wait on the Operator.
- **Count the gate inside `max_in_flight`.** One number would then mix agent throughput with the Operator's attention, and lowering it to spare the Operator would also starve research.
- **Count only PRs with a passing Verdict on their head and no review by the Operator.** It would need Verdicts and reviews read on every Dispatch check. Every open agent PR out of draft is waiting on the Operator anyway.

## Consequences

- At the default 3, the Kit releases fewer Tickets once two or three PRs are waiting on the Operator, while research goes on.
- Dispatch's nothing reason, the Weekly summary's Held line and the `waiting-for-slot` Standing (`slot: "merge-gate"`) name the PRs at the gate and the work on its way.
- A Dispatch snapshot now names its open agent PRs by number, draft and out of draft, and counts the Implement runs with no PR apart from the rest. Dispatch's reason and the Weekly summary both name a draft by its PR and other work on its way by its Ticket.
- `max_in_flight` still counts a Retry or Request-changes run beside its draft, as it did before; only the gate leaves it out.

Decided in [The Merge-gate queue is uncounted and uncapped](https://github.com/jrey8343/fabrik/issues/459).
