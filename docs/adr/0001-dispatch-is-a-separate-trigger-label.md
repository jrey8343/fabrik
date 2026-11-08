# Dispatch is a separate trigger label, not `ready-for-agent`

An Implementer starts when the Kit adds `agent:implement` to a Ticket, not when the Ticket gets `ready-for-agent`. Matt Pocock's `to-spec` and `to-tickets` add `ready-for-agent` to the Spec itself (before it has any Tickets) and to every Ticket (blocked ones included), so a label-add trigger would start an Implementer on a whole Spec, or on Tickets before their blockers have merged. `ready-for-agent` therefore stays a state ("this is ready"), and Dispatch is the Kit's own decision. The Kit adds `agent:implement` only to an open `ready-for-agent` issue with no open blockers, no sub-issues, no open linked pull request and no `agent:implement` already.

## Consequences

- The Kit checks for Tickets to Dispatch whenever an issue closes, after a Design session, on the Fast path and when a push to the default branch changes the Kit config. `max_in_flight` caps how many Implementers run at once, and `0` pauses Dispatch.
- Labels the Kit adds must use a GitHub App token, because labels added with `GITHUB_TOKEN` don't start workflows.
- Matt's skills are used unchanged; only the trigger is Fabrik's.

**Amended (#98):** a blocker closed as *not planned* counts as a blocker too. Its work never landed, so the Ticket it blocks stays blocked until the Operator removes the blocked-by edge. A blocker closed any other way (completed, duplicate) no longer blocks.

**Amended (#417):** GitHub fires `labeled` only for a label newly added, so a trigger label left on (a claim job that failed before taking `agent:implement` off) made every later add, the Kit's or the Operator's, start nothing. Dispatch still adds `agent:implement` only to a Ticket without it. But when any plan adds a trigger label already on, and it was last added over ten minutes ago, the adapter takes it off and adds it again so its event fires, and the step summary says so. One added more recently is left alone: its run is still starting and will take it off, and a second event would start a second run. A role that declines a trigger label (`agent:implement`, `agent:review`, `agent:design`, `agent:research`) takes it off and comments one line saying why nothing started. A first Implement run's landing takes off an `agent:implement` its claim left on, so it stops holding a `max_in_flight` slot.

**Amended (#418):** adding `ready-for-agent` to an open issue also runs a Dispatch check, and so does the hourly tick. The label still starts nothing itself: the check weighs it as any other, so a blocked Ticket or a Spec stays put. Without this, a Ticket the Operator marked ready by hand, or one left waiting while every slot was full, waited for some unrelated issue to close.
