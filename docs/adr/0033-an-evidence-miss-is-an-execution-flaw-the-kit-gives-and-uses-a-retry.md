# An Evidence miss is an Execution flaw the Kit gives, and uses a Retry

UI evidence never blocked a pull request or used a retry. That rule let a UI pull request reach the Merge gate showing nothing of its change: when nobody named a route, capture fell back to a default and recorded no miss. For a miss the Implementer caused, the rule is reversed. On a Product repo that uses Evidence shots, the Implementer names what shows its change or says that nothing visible changes. Naming neither, or naming a shot the check didn't produce, is an Evidence miss: the Kit gives an Execution flaw at that head, before the Reviewer runs, and it uses one of the Ticket's two Retries. A failure of the wiring still blocks nothing and uses nothing.

## Considered options

- **Keep a miss advisory.** That is what let 11 of 17 through.
- **A Required check of the Kit's own.** No Kit-made check is ever Required (ADR-0019), and the Operator must still be able to merge.
- **Leave it to the Reviewer.** It costs a Review to find what Kit code knows for certain, and the Reviewer would have no picture to judge.
- **`ready-for-human` when the Retries are used up.** A miss is judged before Review, so the Operator would be handed an unreviewed draft.
- **Close the pull request and send the Ticket back to design when the Retries are used up,** as a third Execution flaw does. A missing picture is not a Design flaw.

## Consequences

- An Evidence miss and the Reviewer's findings share one pool, so a miss can use a Retry a finding would have used.
- With no Retry left, the pull request goes on to Review with the miss shown, and its Digest marks the screen as not proven.
- Under a named check that is red, evidence sends nothing back: the Reviewer's judgment of the check decides the Retry.
- Only a head an Implementer run pushed can be sent back. The Operator's own push never is.
- "Nothing visible changes" is the Implementer's word. The Reviewer checks it against the diff, and nothing else does.
- Route capture is unchanged: it still never blocks a pull request or uses a retry.
