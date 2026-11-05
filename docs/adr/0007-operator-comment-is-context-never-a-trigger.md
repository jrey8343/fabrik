# An Operator comment is context, never a trigger

An Operator comment on an agent pull request never starts a run or changes the pull request's state. The next agent run that reads the pull request (a Review, a retry, a Request-changes run, or the Design session for a Ticket sent back from it) weighs it as the Operator's own words, and its output names the comments it weighed. When the comment arrives, the Kit's only response is a 👀 reaction. We chose this so the Merge gate keeps one entry point for asking for work, the Request-changes review, and the Kit never has to guess from free text whether "is this right?" means "change it". The cost is that a comment left after a Pass, with no run coming, is never acted on. The Operator asks for changes with Request changes.

## Considered options

- **Treat a comment as a light Request changes.** That's cheaper for the Operator to type. But every remark would cost a run, intent would have to be guessed, and the Merge gate would gain a second, looser way in.
- **Have the Kit answer the comment.** That would make a PR conversation into an ad-hoc HITL channel, alongside the Design session and the Pairing session.

## Consequences

- An Operator comment that lands after a run read its inputs is not re-run. Leaving it out of that run's list of weighed comments shows it was missed.
- An Operator comment settles questions and corrects claims, but it never widens scope. A retry that is asked for more than its findings says so in its fix comment and doesn't build it. When the comment conflicts with the Ticket, the Ticket wins.
- Only the Operator's comments are read, never another human's or a bot's, so commenting on a pull request can't steer an agent.
