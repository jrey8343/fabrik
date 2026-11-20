# A check's fix goes first at Dispatch and passes the Merge-gate cap

ADR-0031 has the Kit heal a red Required check no pull request caused: the check's issue goes to Triage, and when it closes as completed the Kit brings each held pull request up to date. That healing starts from the issue closing. But the agent pull requests the red check holds, at the Merge gate or on their way there as drafts, are what fill `caps.merge_gate` (ADR-0023). With the cap full, Dispatch released no Ticket, the Check's issue's own Ticket among them. The fix waited for room only the fix could make, so the healing never started, and the more pull requests the check held, the more surely it didn't (#838).

A **check's fix** is an open `ready-for-agent` Ticket that carries `fabrik:flaky-check`, so a Check's issue Triage routed. The label is the whole test: not the issue's body marker, which a Design session's Brief drops, and not whether the check holds a pull request right now, which needs Verdicts read. This refines ADR-0023, which stays as written:

- **It goes first.** Dispatch weighs every check's fix ahead of every other candidate, Tickets and research Decisions alike, lowest issue number first among them. Everything else stays lowest issue number first.
- **It passes `caps.merge_gate`, at any value, `0` included.** So the cap is a hard bound but for at most one fix per Required check with an open Check's issue.
- **It is still counted.** Once released, its work counts toward the Gate load like any Ticket's, so the Gate load can stand over the cap, and the Tickets behind it wait until it is back under.
- **Everything else still holds it.** `max_in_flight` holds it, and `0` pauses it. Every other eligibility test holds it as it holds any Ticket, and a held run of it resumes in the order it was first held.
- **The Operator is told.** While a Ticket waits for room at the Merge gate, the waiting Ticket's Standing, Dispatch's reason and the Weekly summary's Merge-gate line name each check's fix Dispatch would release now ("#50 fixes a red check and goes first") and each already under way: dispatched, with an Implement run under way or held, or with an open pull request ("#50 fixes a red check and is under way"). A fix that is neither, as one a Blocker holds or whose last run failed, isn't named, since saying it goes first would be untrue. The fix itself never waits for the Merge gate.

## Considered options

- **Leave pull requests held only by an Unrelated failure out of the Gate load** while the check's issue is open. Dispatch would keep releasing Tickets into the same red check, all of which reach the Operator at once when the fix lands, and every Dispatch check would read Verdicts, which ADR-0023 already turned down.
- **Let the fix pass `max_in_flight` too.** That cap clears by itself: a draft passed with an Unrelated failure leaves draft for the gate, freeing its slot.
- **Let the fix take no room at the gate.** Counting it means the cap is passed only when the gate was already full, and by one Ticket per check.

## Consequences

- The Gate load can stand over `caps.merge_gate`, by at most one fix per Required check with an open Check's issue, while a red check holds the gate.
- A `waiting-for-slot` Standing with `slot: "merge-gate"` carries `checksFixes`, with the fixes that go first and those under way, while there is either: a new field on the read library, removing nothing.
- The Monitor's red-`main` and Main-check issues get no place at the front (ADR-0025). If Triage closes a Check's issue as a duplicate of the Monitor's issue, the fix has no place, and ADR-0031 has the Kit mention the Operator.
- A Spec a Design session writes from a Check's issue gets no place for its Tickets unless they carry the label (#839).

Decided in [A Flaky check issue's Ticket waits behind the pull requests its red check holds](https://github.com/jrey8343/fabrik/issues/838).
