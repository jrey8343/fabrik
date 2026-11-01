# Dispatch is a separate trigger label, not `ready-for-agent`

An Implementer starts when the Kit adds `agent:implement` to a Ticket, not when the Ticket gets `ready-for-agent`. Matt Pocock's `to-spec` and `to-tickets` add `ready-for-agent` to the Spec itself (before it has any Tickets) and to every Ticket (blocked ones included), so a label-add trigger would start an Implementer on a whole Spec, or on Tickets before their blockers have merged. `ready-for-agent` therefore stays a state ("this is ready"), and Dispatch is the Kit's own decision. The Kit adds `agent:implement` only to an open `ready-for-agent` issue with no open blockers, no sub-issues, no open linked pull request and no `agent:implement` already.

## Consequences

- The Kit checks for Tickets to Dispatch whenever an issue closes, after a Design session and on the Fast path. Limits on how many Implementers run at once will plug in here.
- Labels the Kit adds must use a GitHub App token, because labels added with `GITHUB_TOKEN` don't start workflows.
- Matt's skills are used unchanged; only the trigger is Fabrik's.
