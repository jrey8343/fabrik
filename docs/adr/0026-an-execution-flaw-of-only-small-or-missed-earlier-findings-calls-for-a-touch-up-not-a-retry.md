# An Execution flaw of only Small or missed-earlier findings calls for a Touch-up, not a Retry

Every Execution flaw used one of a Ticket's two Retries, whatever it found, and the third sent the Ticket back to design. Ten Verdicts named nothing but small things: a comment or doc the change left stale, a body that no longer matched the branch, or a bug in code an earlier Review had read and passed over. Each spent a Retry, and two Tickets went back to design for them (#717).

The Reviewer now tags each finding (#749): `[small: body]` or `[small: comment]` for a Small finding, and `[missed earlier]` for a behaviour bug in settled code, which only a later Review can find (ADR-0025). An untagged finding counts. A Reviewer's Execution flaw with at least one finding, every one tagged, calls for a Touch-up instead of a Retry: an Implement run on the same branch that fixes them, on the same model as the run whose push the flaw judged, using none of the Ticket's Retries. The Kit counts the tags from the Verdict's items and writes them in its marker, so the call is made from the pull request alone, and the Touch-up's number goes in the marker too.

A pull request gets two Touch-ups, counted from its Verdicts as Retries are. A third all-tagged flaw counts like any other: it calls for the next Retry, or sends the Ticket back to design when the Retries are used up. The precedence on an Execution flaw is an unbuilt Request changes first (#341), then a Ticket no longer `ready-for-agent` starting nothing (#416), then a Touch-up while one is left, then a Retry, then Back to design. A Verdict from red checks, an empty diff or a Broken run never calls for one. A Touch-up is in flight, held, restarted, deferred to and refused exactly as a Retry is, and its push is Reviewed under the later-Review rules before it can reach the Merge gate. One that commits nothing, or is a Broken run, gets today's Verdict, which counts, except one whose findings are all `[small: body]` (#751): its prompt says so, from the tags, and it may commit nothing. The Kit then replaces the body with its `summary`, posts its `fix` under a note naming the head, which ends it but is no push, and starts the Review of that head, which may give that head a second Verdict: the one exception to one Verdict per head.

A Touch-up carries the Step-up reason of the last Kit run that pushed to the pull request, which that run's push note records (#746), so it never drops to a cheaper model on the same pull request (#464) and never takes a Step-up of its own. The run that opened the pull request left no note, so a Touch-up after it carries the reason the Retry rules gave that run: none for a first run, `retry` for a Retry 2 that opened it. `fabrik:step-up` still reads as `marked` as it starts, and taking the label off still drops it back (ADR-0014).

## Considered options

- **One count for every flaw.** Simple, but it is the count that spent the ten Retries above on stale comments and earlier misses.
- **Widening "small" to standards rules.** A standards finding can hide real work, and the Reviewer would be tempted to call a costly finding small to spare the Ticket. Small stays a stale comment or doc no criterion asks for, or the body.
- **Kit code deciding a finding's kind.** The Kit can't tell a stale comment from a wrong one without judging the code. The Reviewer judges and tags; the Kit only counts the tags, and a finding it can't read as an item counts.
- **Passing with the fix unreviewed.** A pass that left its small findings to the Implementer would let an agent push reach the Merge gate unreviewed. A Touch-up's push is Reviewed like any other.

## Consequences

- The tags become a Run-record field the Weekly summary reads: each Review record has its findings counted by tag, and each Implement record has its Touch-up number, `retry` 0 on a Touch-up.
- A second pool of two caps the loop: a Reviewer that keeps finding small things gets two Touch-ups, then the flaws count again.
- Touch-ups per merged PR keeps the yardstick honest: Retries per merged PR can't fall just because runs were renamed.
- A Touch-up is no Retry for Yield, the Retries rows, or a Ticket's first run.
