# A Spec written from a Check's issue takes its place

ADR-0031 has the Kit heal a red Required check no pull request caused, starting from the check's issue closing as completed: each agent pull request the check holds at the Merge gate is brought up to date. ADR-0035 has that issue's Ticket go first at Dispatch and past `caps.merge_gate`. Triage can also send a Check's issue to `needs-design`, the harder kind of failure, and a Design session then broke the tie between the issue and its check however it ended (#839):

- **A brief** rewrote the issue's body, keeping the Monitor's marker line and the carried lines but not the `fabrik:flaky-check-issue` marker, the body's first line. Closed as completed, the issue was no check's issue to the Kit, so the healing never fired, and while it was open the next red run of the check filed a second Check's issue.
- **A Spec** closed the issue as superseded, which is closing it as completed with its marker still in its body. The Kit took that for the fix landing and brought each held pull request up to date before any Ticket of the Spec had run, spending the move while the check was still red. The Spec and its Tickets carried neither the label nor the marker, so nothing tied them to the check.

This refines ADR-0031 and ADR-0035, which both stay as written:

- **A brief keeps the marker.** An agent brief's or an Operator brief's body opens with the Check's issue's marker line, as it opens with the Monitor's, since the marker is read only as a body's first line. The issue keeps `fabrik:flaky-check`. So it is still the check's open issue, and its closing as completed starts the healing.
- **A Spec takes the Check's issue's place.** The Spec's body opens with the marker line, and the Spec carries `fabrik:flaky-check` beside its category label and `ready-for-agent`, as a Spec already keeps a Sentry group's marker. While it is open, a red run of the check comments on it. Its closing as completed starts the healing, whether the Kit closes it after its last Ticket or the Operator closes it by hand, and ADR-0031's rules apply to it as to any check's issue, its close as not planned included. The Operator mention weighs it as the check's open issue, so it stays quiet while the Spec is `ready-for-agent`.
- **The marker and the label move off the superseded issue.** Before the Check's issue closes as superseded, its body loses the marker line, the rest of it as it was, and `fabrik:flaky-check` comes off. It still closes as completed, like every superseded issue, but neither the issue-closed event nor the tick's read of closed Check's issues takes that close for a fix. At any time one issue carries a given check's marker from that session.
- **Every Ticket filed from an issue carrying `fabrik:flaky-check` carries it**: each Ticket and Operator step of the Spec, and each sibling when a Ticket carrying it is later split. Each `ready-for-agent` one is a check's fix, so ADR-0035's bound of at most one fix per Required check past `caps.merge_gate` becomes the unblocked Tickets of that check's Spec. Blocked-by edges and `max_in_flight` still hold them. The Spec itself has sub-issues, so it is never a check's fix: never released, and never named as a fix that goes first or is under way.
- **A Check's issue never becomes a Map.** A Map outcome on one is a wrong outcome, as a Map on a Ticket under a Spec is, and the turn's "The Map cap" input says so. A red check whose cause isn't known finishes as a Spec whose first Ticket finds the cause.
- **A live session hands a Spec to the async session.** The Kit reads a check's marker only on an issue the Fabrik App opened, and a Spec the live session files is the Operator's. So for a Spec or a Map on a Check's issue the live Design skill stops through its "Stopping before it's finished" comment, and the async session lands the Spec as the Fabrik App. As a backstop, the Kit refuses a live `spec` or `map` outcome on a Check's issue: it says why on the issue, opening the comment like a failed turn's notice, leaves `needs-design` on and closes nothing, so the Operator's reply starts the async turn. A live brief keeps the marker line itself and lands as before.

## Considered options

- **Keep the Check's issue open until the Spec closes.** It would sit open with no state label and no work of its own, and need a new rule to close it.
- **Close the superseded issue as not planned.** It would be the one superseded issue with another close reason, with the marker left on it beside the Spec's.
- **One fix at a time past the cap.** Dispatch would have to know which check a Ticket fixes, which the label can't say.
- **Carry the marker onto a Map.** The Operator closes a Map by hand before any fix exists, its Spec-to-be issues are new issues, and an open Map waits on nobody the Operator mention weighs.
- **Read a check's marker on a Spec the Operator opened.** Anyone can quote a marker in an issue they open, so the Kit reads markers only on the Fabrik App's own issues.

## Consequences

- The healing fires on any completed close of the Spec, fix or not, at the cost of one rebase and one mention. Nothing tells a close with a fix from one without.
- The Operator mention stays quiet for as long as the Spec is open and `ready-for-agent`, a stalled Ticket or a waiting Operator step included.
- The Gate load can stand over `caps.merge_gate` by every unblocked Ticket of a check's Spec, not just one fix per check.
- A Check's issue a session rewrote before this, or one a live session's rewrite dropped the marker from, keeps no marker: nothing restores it.

Decided in [A Design session on a Check's issue drops its marker from a Brief, and closes it as completed for a Spec](https://github.com/jrey8343/fabrik/issues/839).
