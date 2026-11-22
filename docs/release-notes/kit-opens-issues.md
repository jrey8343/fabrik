# Release notes: The Kit opens issues itself

The notes for the minor release in which the Kit opens issues itself ([#882](https://github.com/jrey8343/fabrik/issues/882), ADR-0039), so that work the Operator has already asked for becomes an issue without the Operator opening it by hand. Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

This draft holds the first of the Spec's three parts, a Design session's Spin-offs ([#883](https://github.com/jrey8343/fabrik/issues/883)). A Request changes that asks for a Spin-off ([#884](https://github.com/jrey8343/fabrik/issues/884)) and a Follow-up that is a fault ([#885](https://github.com/jrey8343/fabrik/issues/885)) add their parts here as they are built.

## Release-note line

A Design session now opens the issue for work you put off in an answer: a Spin-off, opened with `needs-triage` as the session finishes and named in its closing comment, so no Operator step and no Pairing session exists only to open an issue.

## What changed

- **A Design session opens its Spin-offs.** A Spin-off is work the Operator's answers put outside the session's outcome, which the Kit opens as an issue of its own. Any finish but a Map can carry them, in `spinOffs`: an agent brief, an Operator brief, a Spec, a split, a Roll-in and not planned. A round and a Map take none, and an output that gives one there is refused.
- **Only on the Operator's word.** The session writes a Spin-off when an answer of the Operator's states or implies that some work is wanted but is not part of this outcome, such as "not now", "later" or "leave that out of this one". It writes none for work the Operator did not speak to, none for work an open Ticket already holds, which the closing comment names instead, and it asks no question only to confirm one. Work the session designed fully is still a Ticket of its Spec.
- **What the Kit opens each one with.** The Kit opens each Spin-off in the plan that finishes the session, as the Fabrik App, in the same repo, with `needs-triage` and no other label, as a Check's issue is opened, so a Triage run follows. Its body opens with one hidden line, `<!-- fabrik:spin-off {"from":"design","issue":<n>} -->`, which says it is a Spin-off and names the issue whose Design session it came from. There is no new label: Kit code reads that line only as the first line of an issue the Fabrik App opened. When the finish writes a Spec or a split, the body ends `Follows #<Spec> (its Tickets: …)`, naming the Spec and its Tickets by the numbers the Kit gave them, so a Design session on the Spin-off is given those Tickets.
- **It can wait on work not yet built.** Each Spin-off has a `blockedBy`, under the rules of a Ticket's, which the Kit writes as native blocked-by edges: the key of a Ticket or an Operator step of the same Spec or split, the number of an open Ticket in "The open Tickets", and, on an agent brief, the issue the brief rewrites. A number not in "The open Tickets" is refused by the agent job, as a Ticket's is. The edges hold Dispatch, not Triage, which runs at once.
- **The closing comment names each one.** It ends with a list of the Spin-offs the Kit opened: for each, its number, its title and its `restsOn` line, the one line of the session's output that names the Operator's answer it rests on, written as `Rests on: …` under the title. The session writes neither the list nor the links. A Spin-off mentions nobody and is assigned to nobody.
- **Triage never sets one aside on its own judgement.** Triage's input marks a Spin-off with `spinOff`, and its prompt says a Spin-off exists because the Operator asked for it: it goes to the Fast path, a Design session or `ready-for-human`. A `wontfix` on a Spin-off with no `duplicateOf` is refused, by the agent job, which asks Triage once to put it right, and again by the push job. One that names an original closes as a duplicate, as any issue does.
- **No Operator step opens an issue.** An Operator step's `newIssue` is refused, with a message that names `spinOffs`, and the Kit writes no Open as issue link on an Operator step. An Operator step already open keeps the link its body has.
- **Why a minor:** it's new behaviour that needs nothing from a Product repo beyond the bump. No new label, no Setup step, no new App permission and no new Kit config field is needed, and the read library removes nothing.

## Upgrading

- **Nothing beyond the bump.** The Fabrik App already opens a Spec's Tickets, so it needs no new permission to open a Spin-off.
- **A Product repo's own `.fabrik/design.md`.** If it tells the session to write an Operator step that opens an issue, or names `newIssue`, reword it: such an output is now refused, and the turn fails after its one chance to put it right.
- **Operator steps already open** that carry an Open as issue link are worked as before: open the issue from the link.

## What does not change

- **A Follow-up, an Audit candidate and a Retro proposal** are still links the Operator opens.
- **An Operator comment still triggers nothing** (ADR-0007), and every point of a Request changes is still built on the pull request (ADR-0010).
- **A live Design session** files as the Operator, so nothing it opens is a Spin-off to the Kit, and Triage sorts it like any other issue.
- **A Map** carries no Spin-off: its open questions are its Decisions.

## Known limits

- **A Design session that later rewrites a Spin-off drops its hidden line.** Triage has sorted the issue by then, and nothing else reads the line.
- **Triage runs before the work a Spin-off waits on is built.** Its brief or its Design session is written against the code as it stands, and Dispatch holds the Ticket until its Blockers land.
- **A Spin-off blocked by a Ticket that is closed as not planned stays held**, as any work behind such a Blocker does, until the Operator removes the edge.
