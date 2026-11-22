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

A Request changes' Spin-offs are the second part built (#884):

- **Only a Request changes asks for one.** An Operator comment still triggers nothing (ADR-0007). The Merge gate keeps one entry point for asking for work, and a comment that could open an issue would be a second one, hidden among words every run reads as context.
- **Only the Operator's words set a point aside.** A point is set aside when the Operator says, in the review's own words or in a comment on the code in it, that the work is to be its own issue, in whatever words: "open this separately", "as its own issue", "in a different ticket". A point without such words is built, however large or unrelated (ADR-0010): an agent that may judge a requested change unrelated may leave unbuilt what the Operator asked for, which is what ADR-0010 exists to prevent. So the Request-changes run recognises an instruction and never weighs whether the work belongs, and where it can't tell, it builds.
- **The run returns each in `spinOffs`**, with a title, a body that stands alone and quotes the Operator's words, and `from`: the id of the review, or of the comment on the code in one, that asked for it. The run's own review is headed by its id for this. A `from` the run was not given is refused twice: by the agent job, against the ids its prompt headed, and by the push job, against its own read of the pull request's reviews. No other run's output is read for them.
- **The Kit opens each in the plan that lands the run.** On a push and on a run that committed nothing alike, each is opened with `needs-triage`, the marker line naming the pull request and the review, a `From PR` line, and a blocked-by edge to the pull request's Ticket, so Dispatch holds it until that Ticket closes as completed and it is never built on a `main` that lacks the pull request's work. The run's note lists each by number and title with a link to the Operator's words, which is the push job's own, and records each on a marker line. That line is where every later run, Review and Digest reads them.
- **A run of only Spin-offs returns the pull request to the Merge gate with no Review.** Kit code cannot read a point, so it goes by asks, as a Digest does: a review's own words when it has any, and each comment on the code in it. The pull request goes back to the gate, on the pass it had, only when the run committed nothing, the head did not move, its latest Verdict is a pass on that head, the run returned a Spin-off, and every ask of every review the run read is named by a Spin-off's `from`. Its note is still the run's outcome, so the reviews are settled and nothing starts the run again. Anything short of that is handed back, as a Request-changes run that committed nothing always was, with its Spin-offs opened all the same: a wrong call here would skip a Review.
- **The Reviewer is given each beside the Operator's words.** A point properly set aside is no part of the Ticket as amended, and never a finding for being unbuilt. One the words did not ask to separate is an unbuilt requested change, an Execution flaw. The Reviewer checks the Implementer's reading of the Operator's words, which is a reading of words and never a judgement of whether the work belongs.
- **The Digest shows each under its ask.** Kit code's facts name, on each ask, the Spin-offs opened from it. The writer answers for what was to be built, and has one more answer, set aside, for an ask none of which was. Kit code takes that answer only on an ask it opened a Spin-off from, so the writer cannot set a point aside either.

A Follow-up that is a fault is the third part built (#885):

- **Faults, and not ideas.** The Reviewer marks each Follow-up a fault or an idea. A fault is something already wrong: a bug, a test that is missing or fails, a doc that is stale. Its body says where it is, by file and line, and what shows it is wrong, so whoever reads the issue can check it against the code without the pull request. Anything else is an idea, and so is a problem the Reviewer cannot show that way. An idea opened by the Kit would reach Triage, and from there Design sessions the Operator never asked for, so an idea stays the link it was. A Follow-up given no kind is an idea: the bar is met by showing the fault, never by default.
- **At the merge, and not at the pass.** A pull request can pass more than once, and each pass may name the same fault or another. A fault opened at the pass would start its fix beside an open pull request on the same code, and one named on a pull request that never merges would be a fault in code `main` never held. So the plan for the merge gathers every fault any pass named, in the order named, drops one whose trimmed title repeats an earlier one's, and opens the rest. The Verdict comment says so beside each fault, in place of a link, and lists its faults after its ideas: a reader pinned to an earlier release ends each item at its link, so it reads every idea and stops at the first fault. A Plain pull request has no Verdict and a pull request closed unmerged did not land, so nothing opens for either.
- **What each is opened with.** `needs-triage` alone, the marker line naming the pull request as the body's first line, the Reviewer's text, and the `From PR` line an issue opened from a link ends with. It is no sub-issue and nothing blocks it: the pull request it was found beside has merged.
- **A cap, and no veto.** `caps.follow_up_issues`, 5 by default, which a Product repo can only lower as its other caps, counts the open issues the Fabrik App wrote whose first line is the marker. A merge opens its faults only up to the room under it, and a fault over it stays an Open as issue link in the Kit's comment on the merged pull request. At 0 the Kit opens none. The cap is what keeps fixes that name more faults from filling the Merge gate. There is no veto before the merge. A decision per Follow-up on every pull request is the work #101 avoided. The Operator closes an issue they don't want, and nothing reopens it.
- **One the Operator already opened is left out.** By the rule that already read a Follow-up as opened: an issue the Operator opened whose `From PR` line names the pull request and whose trimmed title is the fault's, open or closed.
- **Once.** The Kit posts one comment on the merged pull request, which mentions nobody: each issue it opened, each fault left over the cap with its link, and each that was an issue already. Its first line, `<!-- fabrik:follow-ups-opened -->`, is what a second look at the same merge reads, from an event or a Tick, and with it nothing more is opened. It is posted whenever a pass named a fault, so the rule rests on that one line. A plan applied only in part leaves no comment, so the next look also leaves out a fault that the Fabrik App already opened for this pull request, by the marker and the title.
- **Triage sorts it as any issue.** Its input says the issue is a Follow-up the Kit opened and names its pull request. Nobody asked for it, so Triage may set it aside, which it may not do to a Spin-off.
- **The Digest shows every fault.** Kit code lists them itself, each with a line saying it opens at the merge. The writer chooses only among the ideas, a reply that names a fault's id is refused, and its choice gates nothing.
- **The Retro's evidence says what became of each.** A fault carries the issue the Kit opened and its state label, or how it closed and whether the Operator or Triage closed it, or that it stayed a link over the cap. Faults the Operator keeps closing as not planned point at the Reviewer's bar or at the cap, and the Retro is where either is tuned.

This reverses #825's "The Operator still opens it from the link": the `newIssue` Operator step and its link go, and the contract refuses the field by name. It also reverses #101's "nothing auto-filed", for faults only: an idea, an Audit candidate and a Retro proposal are still links the Operator opens. ADR-0007 and ADR-0010 stand: an Operator comment still triggers nothing, and a point of a Request changes is built on the pull request unless the Operator's own words ask for it to be separate.

## Considered options

- **One power for all sources.** The Operator's word needs no bar; the Kit's judgement needs a bar and a cap.
- **Born `ready-for-agent`.** Triage is already the judge of what can be built without design, and its duplicate check comes with it.
- **A label to mark what the Kit opened.** A new label is a new Setup step in every Product repo. A marker line needs none, and the Kit already reads markers only on the Fabrik App's own issues.
- **Opening every Follow-up.** Ideas would reach Design sessions the Operator never asked for.
- **Opening a Follow-up at the pass.** A pull request can pass more than once, and its fix would start beside an open pull request on the same code.
- **An Operator comment as a trigger.** ADR-0007 stands.
- **An agent judging a requested change unrelated.** ADR-0010 stands.
- **The run saying, in a field of its own, that its review asked only for Spin-offs.** An agent's word would then decide whether a Review is skipped. Kit code decides it from the asks it read itself, and hands the pull request back when it can't tell.
- **Counting the points in a review.** A point is free text, and nothing but an agent can count them. An ask is something Kit code already lists, by GitHub's own ids.
- **Filing power for the Implementer.** The Reviewer reads its summary and is the one judge.
- **A veto on a fault before merge.** A decision per Follow-up on every pull request is the work #101 avoided.
- **The Digest writer choosing which faults to show.** A fault left out of the Digest would still open at the merge, unseen. Kit code shows every fault, so what the Operator reads at the Merge gate is what the merge opens.
- **A cap on each pull request's faults.** It would bound one merge and not what stands open in front of the Operator, which is what an attention cap is for.
- **Finding the Kit's Follow-up issues by a search.** GitHub's search lags an issue just opened, so a second look could miss the first look's issues. The Kit reads the open issues and the pull request's cross-references instead.
- **A new metric.** The Retro's evidence is enough to tune the bar.

## Consequences

- No Operator step or Pairing session exists only to open an issue. An Operator step already open that carries an Open as issue link keeps it and is worked as before.
- Triage runs at once on a Spin-off that waits on Tickets not yet built: the blocked-by edges hold Dispatch, not Triage or the Design queue.
- A Spin-off blocked by a Ticket that is closed as not planned stays held, as any work behind such a Blocker does.
- A Design session that later rewrites a Spin-off drops its marker line. Triage, the marker's one reader, has sorted the issue by then.
- A Design session that rewrites a Follow-up issue keeps its marker line, and a Spec written from one carries it: the cap reads the marker for as long as the issue is open.
- The agent-inputs job doesn't know the Fabrik App's login, so it takes any bot's issue that opens with the marker for a Spin-off, as it does for a Check's issue. The push job, which knows the login, reads the marker only on the App's own.
- A live Design session files as the Operator, so nothing it opens is a Spin-off to the Kit.
- Kit code goes by asks, not by points. One ask can hold a point to build and a point to set aside, and once a Spin-off names that ask it counts as set aside. A run that committed nothing on such a review goes back to the Merge gate with the other point unbuilt and no Review to find it. The run's note, which lists what was set aside, and the Reviewer's check on the next push are what catch it.
- A Request-changes run that ends without landing, as on a trust-root refusal or a conflict with `main` it did not resolve, opens no Spin-off: the Operator's Request changes still stands, and its next run returns them.
- A plan that fails after opening a Spin-off and before posting the run's note leaves the run in flight, and the landing that follows opens the Spin-off again. Triage's duplicate check is what catches the second one.
- A Spin-off whose Request changes is dismissed later is no longer given to later runs, as the Request changes itself is not. Its issue stays.
- A Design session on a Request changes' Spin-off is told of the pull request it was set aside from, and that a Roll-in onto it is not on offer.
- A fault has no link on its Verdict. One named on a pull request that closes unmerged, or whose merge the Kit's plan never saw, is words on that Verdict and nothing more, and the Operator opens it by hand if they want it.
- Only the merge's own event opens a pull request's faults. No Tick looks at merged pull requests yet, so the comment's mark guards a second look that nothing takes today.
- A Verdict posted before a Follow-up had a kind lists links alone, so every Follow-up on it is an idea, and nothing opens for it at the merge.
- A fault the Operator opened and has since retitled is not known as opened, and the merge opens it.
- The cap is read as the merge is planned. Two pull requests that merge at the same moment can each read the count before the other's issues exist, and between them open more than the room.
- An issue the Fabrik App opens is Kit-owned to the read library, so a Follow-up issue Triage sent to an Implementer is a Ticket to its outcomes only once an agent pull request names it, as a Spin-off is.

Decided in [Spec: The Kit opens issues itself](https://github.com/jrey8343/fabrik/issues/882).
