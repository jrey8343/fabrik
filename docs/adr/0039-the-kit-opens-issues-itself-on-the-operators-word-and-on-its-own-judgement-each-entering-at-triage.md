# The Kit opens issues itself, on the Operator's word and on its own judgement, each entering at Triage

The Kit could not open an issue for new work. Wherever new work turned up, it rendered an "Open as issue" link and waited for the Operator to click it (#882):

- **A Design session** that decided some work belonged in an issue of its own wrote an Operator step carrying `newIssue` (#825). The Operator then took a Pairing session only to open that issue.
- **A Request changes** had no way to say "do this, but as its own issue". Every point is built on the pull request (ADR-0010), so work the Operator wanted kept apart either held the pull request or went through a Design session's Operator step.
- **A Follow-up** the Reviewer names on a pass was a link (#101). In the Pilot, 27 issues were opened from these links, each by hand.

#101 chose links over filing because filing "adds work for the Operator". In practice the Operator opened them anyway, so the link was the work.

The Kit now opens issues itself, under two rules:

- **On the Operator's word: a Spin-off.** Work the Operator's words put outside the piece at hand is opened as an issue of its own. A Design session opens one from an answer of the Operator's that states or implies it, such as "not now" for work still wanted, and opens nothing the Operator never spoke to. A Request changes opens one when the Operator asks for it in words.
- **On the Kit's own judgement: a Follow-up that is a fault.** The Reviewer sorts each Follow-up into a fault, something already wrong that it can show, or an idea. The Kit opens each fault's issue when the pull request merges, under a cap. An idea stays a link.

The two rules differ because who asked differs. The Operator's word needs no bar: the Operator has already said the work is wanted, so no agent weighs whether it is, and Triage may set a Spin-off aside only as a duplicate of a named issue. The Kit's own judgement needs a bar and a cap: nobody asked for a Follow-up's issue, so the Reviewer has to show the fault, anything it cannot show stays an idea and a link, and a cap bounds how many such issues are open at once, so fixes that name more faults cannot fill the Merge gate.

Every issue the Kit opens this way shares four things:

- **It enters at Triage.** It is opened with `needs-triage`, as a Check's issue is, and never with `ready-for-agent`. Triage stays the one judge of whether work can be built without design, and its duplicate check comes with it.
- **It carries a marker, not a label.** A marker line in the body says what the issue is and where it came from. Kit code reads it only from issues the Fabrik App wrote (ADR-0037). No new label means no Setup step.
- **Same repo only.** The Kit opens it in the Product repo the work is in.
- **No agent gains a credential.** Each source is a new field in a role's output, which the Kit parses and applies.

A Design session's Spin-offs are the first part built (#883):

- **Any finish but a Map can carry them**: an agent brief, an Operator brief, a Spec, a split, a Roll-in and not planned. A Map's open questions are its Decisions.
- **The Kit opens each in the plan that finishes the session.** Its body opens with the marker line, which names the session's issue, and, when the finish writes a Spec or a split, ends with a `Follows` line naming that Spec and its Tickets.
- **A Spin-off may wait on work not yet built**, by native blocked-by edges: on the Tickets the finish writes, on an open Ticket, and, on an agent brief, on the issue the brief rewrites.
- **The closing comment names each one** and the answer it rests on, so the Operator can see why each exists.
- **Triage sets a Spin-off aside only as a duplicate of a named issue.** Both sides of its contract refuse a `wontfix` on one that names no original.

This reverses #825's "The Operator still opens it from the link": the `newIssue` Operator step and its link go, and the contract refuses the field by name. It also reverses #101's "nothing auto-filed", for faults only. ADR-0007 and ADR-0010 stand: an Operator comment still triggers nothing, and a point of a Request changes is built on the pull request unless the Operator's own words ask for it to be separate.

The Request changes and Follow-up parts are built in later Tickets. A Request changes' Spin-offs come with #884, and Follow-ups that are faults with #885, which adds its part to this record.

## Considered options

- **One power for all sources.** The Operator's word needs no bar; the Kit's judgement needs a bar and a cap.
- **Born `ready-for-agent`.** Triage is already the judge of what can be built without design, and its duplicate check comes with it.
- **A label to mark what the Kit opened.** A new label is a new Setup step in every Product repo. A marker line needs none, and the Kit already reads markers only on the Fabrik App's own issues.
- **Opening every Follow-up.** Ideas would reach Design sessions the Operator never asked for.
- **Opening a Follow-up at the pass.** A pull request can pass more than once, and its fix would start beside an open pull request on the same code.
- **An Operator comment as a trigger.** ADR-0007 stands.
- **An agent judging a requested change unrelated.** ADR-0010 stands.
- **Filing power for the Implementer.** The Reviewer reads its summary and is the one judge.
- **A veto on a fault before merge.** A decision per Follow-up on every pull request is the work #101 avoided.
- **A new metric.** The Retro's evidence is enough to tune the bar.

## Consequences

- No Operator step or Pairing session exists only to open an issue. An Operator step already open that carries an Open as issue link keeps it and is worked as before.
- Triage runs at once on a Spin-off that waits on Tickets not yet built: the blocked-by edges hold Dispatch, not Triage or the Design queue.
- A Spin-off blocked by a Ticket that is closed as not planned stays held, as any work behind such a Blocker does.
- A Design session that later rewrites a Spin-off drops its marker line. Triage, the marker's one reader, has sorted the issue by then.
- The agent-inputs job doesn't know the Fabrik App's login, so it takes any bot's issue that opens with the marker for a Spin-off, as it does for a Check's issue. The push job, which knows the login, reads the marker only on the App's own.
- A live Design session files as the Operator, so nothing it opens is a Spin-off to the Kit.

Decided in [Spec: The Kit opens issues itself](https://github.com/jrey8343/fabrik/issues/882).
