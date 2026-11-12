# The Digest is written by its own role, between the pass and the Merge gate

An agent pull request reaches the Operator at the Merge gate with a pass and a thread: the body the Implementer wrote before any Review, then every Verdict, Retry and note of the Kit's. The **Digest** is the Kit's plain-English account of the pull request as it stands at one head (GLOSSARY.md). It is written by a role of its own, the **Digest writer**, each time the pull request arrives at the Merge gate at a new head.

- **Never the Reviewer.** The Digest's first item can be that a pass was wrong, and the Reviewer is deliberately not shown earlier Verdicts.
- **Between the pass and the gate.** On a pass the Kit starts the Digest writer in place of opening the Merge gate. Landing the Digest posts it, takes the pull request out of draft and requests the Operator's review, so the Operator is told once, when the account is there.
- **The Loop waits for the attempt, never for its success.** The attempt has ten minutes by default. A failure, an overrun or a refused Digest opens the gate with one line saying none could be written. A Digest run is never a Held run and never counts against a Ticket's Retries.
- **A role like the others.** A read-only checkout of the head, no GitHub write credential, and its output posted by the push job (ADR-0002).
- **Kit code counts, the writer words.** Everything countable is worked out by Kit code, including whether the product code changed since the first Verdict, from a fingerprint recorded with each Verdict. The writer judges one thing, whether each thing the Operator asked for is in the head, against a list it cannot skip.
- **Kit code renders the Digest from the writer's fields, and the Console reads it only through the read library.**
- **A comment of its own, found by the head it names.** It is never edited and never in the pull request's body. Older ones are collapsed, and when only `main` moved the last one is carried forward with no model run.
- **Words for the Operator only.** Nothing in the Loop moves because of what a Digest says, and no agent run is ever given one to read. The Operator's Request changes is what acts on it (ADR-0010).

## Considered options

- **The Reviewer writes it on a pass.** One run fewer, but it would be asked to list what its own pass missed, and it would have to be shown the Verdicts it is kept from.
- **Kit code plus a model call with no tools,** as the Scorers' judge is run. The writer has to open files to check each ask against the head and to write the walkthrough.
- **A section of the pull request's body,** as UI evidence is. The body is rewritten whole on every Implement push, and it is what the next Review reads.
- **One Digest per Verdict.** It spends on rounds the Operator never reads; the history compresses best once, at the end.
- **Opening the gate first and adding the Digest when ready.** The Operator would be told about a pull request whose account is still missing.

## Consequences

- The Merge gate opens some minutes after the pass, and the draft holds its `max_in_flight` slot for that time.
- Each arrival costs one more run, less wherever a Digest is carried forward. In the trial a Digest took 20 to 75 seconds and $0.11 to $0.47. Its cost counts toward the Ticket.
- Every Verdict comment carries a fingerprint of the pull request's own change. A pull request whose first Verdict predates it says the comparison could not be established.
- A Request changes on a passed draft waiting on its Digest is acted on at once, so the Merge-gate rule reads such a draft as at the gate.
- Nothing checks a Digest's prose. No Scorer judges it yet: its test is a point in a Request changes that it should have put under Needs your eyes and did not.

Decided in [Where does the Digest sit in the Loop?](https://github.com/jrey8343/fabrik/issues/519), with its contract from [What must the Digest carry for the Console to draw Review's cards?](https://github.com/jrey8343/fabrik/issues/526) and four changes from [Have a model write the prototyped Digests under the Digest writer's rules: are they good enough, do their places resolve, and what does a run cost?](https://github.com/jrey8343/fabrik/issues/571).
