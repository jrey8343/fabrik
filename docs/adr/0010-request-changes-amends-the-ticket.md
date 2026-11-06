# A Request changes amends the Ticket for its pull request

A Request changes review from the Operator, together with its inline comments, amends the Ticket for that pull request. The Implementer's Request-changes run builds it, even where it conflicts with an acceptance criterion, and says which criteria it amended. Every later Review and Retry on that pull request reads the Operator's Request changes reviews as part of the Ticket. A later review wins over an earlier one, and either wins over the Ticket. An amendment may change scope or widen it. The record is the pull request's reviews, and the Kit never rewrites the Ticket. However large the change, it's built: the Operator's route to a Design session is Send it back. No agent judges a requested change too large. A Design flaw stays available only when the amended Ticket contradicts itself, so that no pull request could meet it.

We chose this because of jrey8343/penrith-physiotherapy-sports-centre#59. The Operator asked for Declan Price to be removed from Clinical Pilates, and the Request-changes run removed him. The Reviewer never saw the review, because the Operator's `CHANGES_REQUESTED` reviews were left out of its input. Following ADR-0007's "the Ticket wins", it gave an Execution flaw. A Retry, which couldn't see the review either, put Declan back, and the PR passed with the Operator's decision undone. Request changes is the one way the Operator asks for work at the Merge gate (ADR-0007), so an agent must never be able to override it.

## Considered options

- **Let an agent judge size, and send a large change to Design.** The Implementer could refuse one, or the Reviewer could give a Design flaw. But agents would be second-guessing how big a change the Operator meant, and the Operator already has Send it back.
- **Rewrite the Ticket body with each amendment.** That keeps one contract in one place. But the Kit would be editing the Operator's Ticket, and two records could drift apart. Every reader that needs the amendment (Review, Retry, a Design session after Send it back, the Retro) already reads the pull request's reviews.

## Consequences

- ADR-0007's "When the comment conflicts with the Ticket, the Ticket wins" applies to Operator comments only, never to a Request changes.
- A Retry's fix of an Execution flaw can never undo a requested change, because it judges the same amended Ticket the Reviewer does.
- A Ticket's text no longer tells the whole contract for a pull request that had a Request changes. Readers of a merged PR need its reviews too.
