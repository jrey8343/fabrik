# A retry rebases onto a moved branch, and every Execution flaw counts

A Retry builds on whatever its PR's branch holds when it lands. If the branch moved while the Retry ran, the Kit rebases the Retry's own commits onto the new head and pushes. If the rebase conflicts, the Kit says so on the PR and starts the same Retry again on the new head, using no retry. Every Execution flaw counts toward a Ticket's two Retries, whoever pushed the flawed head, so the Operator's red pushes count too. While a Retry is in flight, from the Verdict that calls for it until it pushes, ends in an empty diff or is refused, a Review on any other head posts no Verdict. The Retry's push starts the next Review, which judges the combined head. This holds after an Infrastructure failure too: the Retry stays in flight until the Operator re-adds `agent:implement`. Request-changes runs follow the same rules and still use no retry. An Execution flaw on a Request-changes run's push still calls for a Retry, though, and counts like any other (#393), and so does one on a conflict-only run's push (#415), so no Retry number is ever started twice on one PR. The two Retries are one pool per Ticket: an empty diff before the PR opened used one, so the PR's Verdicts count on from it (#415).

We chose this because of jrey8343/penrith-physiotherapy-sports-centre#33. Retry 1 started from 8158cba. While it ran, the Operator pushed a deliberately red 471641d, and Review posted a second Execution flaw on it. That started retry 2 while retry 1 was still in flight. Retry 1 then saw the head had moved, dropped its work and reported success. One more red Operator head used up the Ticket's retries, and the Ticket went back to design after one Implementer attempt that landed. The limit is meant to bound Implementer attempts. Counting flaws bounds attempts only if each flaw starts exactly one attempt and no attempt's work is lost, which is what the in-flight rule and the rebase give.

## Considered options

- **Don't count flaws on heads the Operator pushed.** This fixes the count, but it leaves the overlap and the dropped work in place. It would also take away the Operator's way of forcing a Step-up in a live check: push a red head.
- **Discard a Retry whose branch moved, and restart it on the new head.** This is simpler, since there's no rebase. But it throws away a finished Implementer attempt every time the Operator touches the branch, and a long Retry could be discarded over and over.
- **Let the new head supersede the Retry, and stop counting the superseded flaw.** This makes counting depend on which flaws "really" ran, so the count can no longer be read from the Verdicts alone.

## Consequences

- The trust-root guard (ADR-0005) judges only the Retry's own commits. Commits the Operator pushed in between are the Operator's, so they may touch trust-root files.
- Whether a Retry is in flight is read from the PR's comments: the latest Verdict is an Execution flaw with a Retry left, and no Retry outcome follows it. So the Retry's push comment carries a marker.
- An Operator push while a Retry is stalled after an Infrastructure failure gets no Verdict until the Retry is resumed.
