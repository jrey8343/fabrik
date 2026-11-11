# Fabrik

A software factory: a kit that lets one Operator run an agent-driven engineering loop in their own product repositories, taking work from idea to merged pull request.

## The factory

**Fabrik**:
The factory as a whole: the Kit, the Loop it runs, and the conventions that bind them.
_Avoid_: the tool, the platform, the system

**Kit**:
The portable bundle of skills, conventions and orchestration that a Product repo adopts to run the Loop. A thing a repo takes on, not a service it calls.
_Avoid_: framework, service, template

**Kit config**:
The settings a Product repo owns that tell the Kit how to work there, such as how to build and test it in a Sandbox.
_Avoid_: Fabrik config, settings, manifest

**Skills source**:
A public repository of skills, pinned at one commit, that agents' skills come from.
_Avoid_: skills repo, plugin, marketplace

**Base skills**:
The skills the Kit pins for every Product repo and every role, from one Skills source that moves only with a Kit release.
_Avoid_: core skills, default skills

**Extra skill**:
A skill a Product repo pins from its own Skills source and gives to particular roles on top of the Base skills.
_Avoid_: custom skill, plugin, add-on

**Subscription**:
A Claude account whose token the Kit runs agents on. The Kit may hold several, used one after another in a fixed order as each is used up.
_Avoid_: account, plan, token (the token is the Subscription's credential, not the Subscription)

**Subscription rotation**:
Running agents on the next listed Subscription once one is used up. It is on when two or more Subscriptions are listed, and off with one.
_Avoid_: failover, load balancing, round-robin

**Used up**:
Of a Subscription: unusable until something changes, because it has reached its weekly limit, has been caught spending usage credits, or its token was refused as dead.
_Avoid_: exhausted, rate-limited, out

**Product repo**:
A repository holding a real product that has adopted the Kit, where the Loop's work actually lands.
_Avoid_: target repo, client repo, project

**Pilot**:
The first Product repo used to prove the Kit against real stakes: Penrith Physiotherapy & Sports Centre.
_Avoid_: test repo, demo

**Kit adoption**:
A repository becoming a Product repo: its tracker, checks and skills brought into line with the Loop, the Kit installed, and its first Tickets run through the Loop.
_Avoid_: cutover, migration, onboarding

**Setup**:
The program the Operator runs in their own terminal to adopt, repair or migrate the Kit in a repository, with no agent taking part.
_Avoid_: installer, CLI, bootstrap, `/fabrik-setup`

**Console**:
The Operator's own app for seeing what the factory is doing across their Product repos and making their moves at the Merge gate. It shows what GitHub and the Run records hold and is never a record itself: the Loop runs the same without it.
_Avoid_: control plane, dashboard, inbox, app

## The product

**Product intent**:
Who a Product repo's product serves, why it exists, how its success is measured, and what it deliberately doesn't do.
_Avoid_: product vision, goals, requirements

**Vision**:
A Product repo's written statement of its Product intent, which only the Operator changes.
_Avoid_: mission, strategy, PRD

**Roadmap**:
A Product repo's Now / Next / Later list of what it means to build, kept by the Operator by hand. Not a Map.
_Avoid_: backlog, plan, Map

**End user**:
A person the product in a Product repo serves, as its Vision describes them; never the Operator.
_Avoid_: user, avatar, persona, customer

## People and agents

**Operator**:
The single human who runs Fabrik across their Product repos: answers HITL sessions and owns every merge.
_Avoid_: user, admin, developer

**Implementer**:
An agent that turns one ready ticket into a pull request inside a Sandbox, typically on a lighter model.
_Avoid_: worker, coder, builder

**Reviewer**:
An agent on a frontier model that judges an Implementer's pull request against the ticket and the Product repo's standards.
_Avoid_: checker, critic, QA

**Auditor**:
An agent on a frontier model that reads a Product repo's recent changes on a schedule and files deepening opportunities as one Audit, changing nothing.
_Avoid_: architect, critic

**Researcher**:
An agent that resolves one research Decision on a Map by reading primary sources and recording its findings, deciding nothing.
_Avoid_: investigator, scout

**Digest writer**:
An agent on a frontier model that writes the Digest of a pull request the Reviewer has passed, before it reaches the Operator, judging nothing and changing nothing.
_Avoid_: summariser, narrator, reporter

## The loop

**Loop**:
The end-to-end path a piece of work takes in Fabrik, from idea to a pull request the Operator has merged.
_Avoid_: pipeline, workflow, Real Engineering Loop (Matt Pocock's term, not Fabrik's)

**Standing**:
Where one piece of work is on the Loop, or between its merge and production, and whose move is next, as the Kit reads it from GitHub.
_Avoid_: status, state, stage

**Stuck**:
A Standing in which the next move is the Kit's, nothing is running or held, and the Kit has made no sign for longer than its own recoveries take. Work the Kit has handed to the Operator is waiting on the Operator, never Stuck.
_Avoid_: stalled, hung, idle, stale

**AFK**:
Work an agent drives alone, with no human in the exchange.
_Avoid_: autonomous, background

**HITL**:
Work that only resolves through a live exchange with the Operator speaking for themselves; an agent never stands in for the Operator's side.
_Avoid_: interactive, manual

**Tick**:
The Kit's hourly scheduled run in a Product repo, which drives the Loop's timed work: the stuck-trigger sweep, the Audit, Retro, Replay and conflict gates, closing Weekly-limit issues, Dispatch, the Design queue, the Skills bump and the Monitor. A Tick has started once its jobs run; one GitHub refuses at startup, or never fires, hasn't.
_Avoid_: watchdog, heartbeat, cron

**Monitor**:
The Kit's scheduled check of a Product repo's production errors and default-branch CI that files one issue per problem for Triage, fixing nothing and never reopening what the Operator closed. When a Sentry token that once read dies, it files a `ready-for-human` issue asking the Operator to rotate it instead.
_Avoid_: alerting, watcher, monitor agent

**Intake**:
The rule that gives a new issue `needs-triage`, unless a skill made it or it already has a state, so Triage sees it. A sub-issue with no state gets one quiet line instead, saying which label to add.
_Avoid_: inbox, new-issue hook

**Triage**:
The AFK step that sorts each incoming issue (not ones the Loop's own skills create) into its next state: straight to an Implementer, into design with the Operator, or set aside. An issue it sets aside as a duplicate of one of the Recent issues closes as GitHub's *duplicate*, naming that issue, the original; any other it sets aside closes as *not planned*.
_Avoid_: sorting

**Recent issues**:
What Triage compares a new issue against for a duplicate: the 50 most recently created of the open issues and those closed in the last 30 days, the Monitor's included. The issue a duplicate names among them is its **original**.
_Avoid_: comparison set, candidate list

**Design session**:
A HITL grilling between the Operator and an agent that turns an issue needing design (first time or after a failed review) into one or more ready tickets, charts it as a Map when its destination is too foggy for one session, or ends as not planned when the Operator decides it won't be built: the issue gets `wontfix` and closes as not planned.
_Avoid_: redesign, planning meeting

**Spec**:
A design written up in a Design session, the parent of the Tickets that build it. The Kit recognises a Spec by its `ready-for-agent` or `ready-for-human` state label; any other parent (a Map, or an issue a Product repo keeps open to track its work) is not one, and Spec closing leaves it open.
_Avoid_: PRD, plan

**Ticket**:
One issue an Implementer can turn into a single pull request.
_Avoid_: task, story

**Map**:
An issue charting the way to a destination still in fog, whose children are Decisions rather than Tickets.
_Avoid_: epic, roadmap

**Decision**:
One child question of a Map, resolved by research, a prototype, a grilling or a task, never by a pull request.
_Avoid_: ticket, task

**Operator step**:
A piece of a Spec only the Operator can do, such as a trust-root edit, a secret, a repo setting or facts fetched from another system, which Tickets can wait on or which can wait on them.
_Avoid_: manual ticket, human task, ready-for-human Ticket, "For the Operator" section

**Operator brief**:
An issue rewritten by a Design session as Operator work that needs no Ticket, ready for a Pairing session.
_Avoid_: manual brief, human brief

**Pairing session**:
The Operator working through an issue only they can do with an agent beside them, step by step, ending with what was done recorded on the issue.
_Avoid_: walkthrough, hand-off

**Audit**:
The issue an Auditor files: up to three refactoring candidates for the Operator to file as issues or set aside, closed by the Operator when done.
_Avoid_: architecture review, report

**Retro**:
The issue an agent files each week proposing up to three changes to how the factory works in a Product repo, each with its evidence, closed by the Operator when done.
_Avoid_: retrospective, factory-tune, self-improvement run

**Fast path**:
Triage sending an issue straight to an Implementer, skipping the Design session.
_Avoid_: fast-track, easy fix

**Dispatch**:
The Kit releasing a ready, unblocked Ticket to an Implementer, or an unblocked research Decision on an open Map to the Researcher.
_Avoid_: kick off, assign

**Verdict**:
The Reviewer's judgment on a pull request: pass, Execution flaw or Design flaw.
_Avoid_: approval, review result

**Execution flaw**:
A Verdict that the right design was built wrongly, so the Implementer can fix it.
_Avoid_: bug, failing review

**Flaky check**:
A Required check that has reported both failure and success on the same head commit, in any order and whoever re-ran it. A check red on one head and green on another is never flaky: the code changed. An Execution flaw from a check found flaky on the head it judged no longer counts toward a Ticket's Retries, and the Operator hears of each Flaky check so the Product's suite gets fixed.
_Avoid_: flake, intermittent failure

**Retry**:
An Implementer run that fixes an Execution flaw on its Ticket's open pull request, building on whatever the branch holds when it lands, the Operator's pushes included. A Ticket gets two before the next Execution flaw counts as a Design flaw, whoever pushed the flawed head, in one pool: an empty diff or a Broken run before its pull request opened uses one, and the Verdicts on the pull request count on from there. A Request-changes run or a conflict-only run isn't a Retry, but an Execution flaw on its push calls for one and counts. An Execution flaw that gives way to the Operator's Request changes no run has built calls for no Retry and never counts toward the two. Nor does one on a Ticket no longer `ready-for-agent`. Nor does one from a Flaky check. A Request changes the Operator submits on the draft while a Retry is in flight is deferred until the Verdict on its push: neither that Review nor a Retry is given it, and a pass or an Execution flaw on that push gives way to it, so it never costs a Retry. The Retry after an empty diff or a Broken run has no pull request to build on: it starts where the first run did, from `main`, or on the Kept branch for a Kept-branch start.
_Avoid_: rerun, attempt

**Design flaw**:
A Verdict that the Ticket itself, as any Request changes amended it, is wrong, so it needs a Design session. A Request changes that leaves the Ticket contradicting itself can ground one; its size alone never does.
_Avoid_: bad spec, rejection

**Back to design**:
Sending a Ticket that can't be built as designed to a new Design session: after a Design flaw, a third Execution flaw, or the Operator's `needs-design` on its pull request, the Kit closes that pull request unmerged, keeping its branch as the Kept branch, and moves the Ticket to `needs-design`. It takes the Ticket's Kept-branch start mark off, so the Design session decides afresh where the next run starts.
_Avoid_: rejection, bounce

**Follow-up**:
Work the Reviewer names on a pass that deserves its own issue but lies outside the Ticket's scope, left for the Operator to open as an issue or ignore.
_Avoid_: nit, suggestion

**Infrastructure failure**:
A run that fails for a reason outside the work itself, such as the model provider, the Sandbox or a credential. It is never a Broken run, and it never counts against a Ticket's retries.
_Avoid_: crash, error, flake

**Broken run**:
An Implement run whose work the Kit can't land because of what the agent did: its output breaks the run's contract, it left its branch, or it built on commits its branch didn't start from. On a Ticket's first run or a Retry it's an Execution flaw the Kit gives, like an empty diff, and the next run starts where it did; on a Request-changes or conflict-only run it uses no retry and waits for the Operator.
_Avoid_: contract failure, agent crash, bad output

**Held run**:
An agent run the Kit neither starts nor fails while every Subscription is used up, and resumes by itself, in the order it was first held, once one is free. It is named on its carrier, and quietly on its own issue or PR as well. An Auditor or Retro run is never held: its Audit or Retro fails, and a later Tick opens the next one.
_Avoid_: paused run, queued run, stalled run

**Held line**:
The one quiet comment a Held run puts on its own issue or PR, mentioning nobody, saying which issue it's held on and until when. It is edited, never deleted, once the run resumes or is dropped, and nothing reads it: the held markers on its carrier stay the record.
_Avoid_: hold notice, held comment

**Weekly-limit issue**:
A Kit-owned issue saying a Subscription has reached its weekly limit, open until that limit resets.
_Avoid_: rate-limit issue, quota issue

**Dead-tick issue**:
A Kit-owned `ready-for-human` issue saying a Product repo's Tick hasn't started for more than a day, open until a Tick starts again. A Product repo the Fabrik App can no longer reach gets one beside the Run records instead, where the Weekly summary is filed, open until the App reaches it again.
_Avoid_: stale-schedule issue

**Usage-credits issue**:
A Kit-owned issue telling the Operator to turn usage credits off on a Subscription caught spending them, which stays unusable until the Operator closes it.
_Avoid_: overage issue, billing issue

**Carrier**:
An open weekly-limit, usage-credits or token-rotation issue, which names Held runs with held markers while every Subscription is used up. A weekly-limit issue carries them when one is open, else the one already carrying Held runs, else the most recently opened. Its close may free a Subscription and resume them.
_Avoid_: holder, held issue

**Step-up**:
An Implementer run on a stronger model than its role's default, after a failed review, at the Operator's request, or on a Ticket marked for a Stepped-up start.
_Avoid_: escalation, upgrade

**Stepped-up start**:
A Ticket marked, by the Design session that wrote it or by the Operator, so that its Implement runs are Step-ups while the mark stays, from its first run on. Its Retries count as any Ticket's do, with no further Step-up to fall back on.
_Avoid_: pre-escalation, Opus Ticket, heavy Ticket

**Kept branch**:
The agent branch of a pull request the Kit closed unmerged: by Back to design, a trust-root refusal of a Retry, or the Operator closing it by hand. It stays on the remote, with the work that pull request built, until a Kept-branch start carries on it or a later first run from `main` replaces it.
_Avoid_: old branch, stale branch, closed branch

**Kept-branch start**:
A Ticket marked, by the Design session that rewrote it or by the Operator, so that its next Implement run with no open pull request carries on its Kept branch instead of starting from `main`, merging `main` in first when the branch lacks it. The Retry after its empty diff or Broken run carries on it too, and only the run's own commits are judged. The mark stays until the next Back to design takes it off. With the mark on and the Kept branch gone, the Ticket goes to the Operator and no run starts. A split's Tickets never carry on one.
_Avoid_: resume (a held run resumes), reuse, restart on the branch

**Sandbox**:
An isolated environment where an Implementer, or a Design session's prototype turn, does its work on a branch, holding no production secrets.
_Avoid_: container, VM, workspace

**Trust-root file**:
A file in a Product repo that steers how agents behave or how their work is judged, so agents may never change it. An agent in a Pairing session counts as the Operator, so it may.
_Avoid_: config file, protected file

**Coding standards**:
A Product repo's written rules for how its code should look, which the Reviewer judges against and only the Operator changes.
_Avoid_: style guide, conventions, review instructions

**Merge gate**:
The rule that only the Operator merges a pull request into a Product repo's main branch, and only at a head whose Required checks have passed. Nothing reaches that branch any other way: neither agents nor the Operator push to it.
_Avoid_: approval, sign-off

**Required check**:
A check the Merge gate needs passed on a pull request's head: those the Kit config lists, plus any the main branch already required.
_Avoid_: gating check, status check

**Request changes**:
The Operator's review asking for changes on an agent pull request at the Merge gate, which amends the Ticket for that pull request: the Implementer builds it, also bringing `main` in by merging it when the pull request conflicts with it, and the Reviewer judges against the Ticket as amended, a later one winning over an earlier one and over the Ticket. However large the change, it's built: sending a Ticket to a Design session instead is Send it back. One GitHub never delivered, as on a pull request that conflicts with `main`, the Kit finds and builds all the same.
_Avoid_: change request, revision, feedback

**Roll-in**:
The Operator's Request changes that carries another issue's work onto an agent pull request at the Merge gate, so that it is built there and never becomes a Ticket of its own. A Design session can finish by settling one; only the Operator sends it.
_Avoid_: fold in, absorb, merge into

**Conflict-only run**:
An Implementer run, on the Step-up model, that brings an agent pull request up to date with main once a plain rebase by the Kit conflicted too: one at the Merge gate that main moved under and left conflicting, a draft one whose push GitHub never reviewed because it conflicts with main, or a draft one whose Review passed while it conflicts with main, which stays in draft until the pass on its up-to-date head opens the Merge gate. It rebases onto main, resolves the conflicts and changes nothing else. It's neither a Retry nor a Request changes, so it uses no retry and adds no requirement. Each pull request gets one attempt per main head. An Execution flaw on its push calls for a Retry and counts like any other.
_Avoid_: rebase run, conflict retry

**Send it back**:
The Operator's move at the Merge gate that closes an agent pull request unmerged and sends its Ticket to a Design session, for a change too large or too foggy to build as a Request changes.
_Avoid_: reject, redesign

**Operator comment**:
A comment the Operator leaves on an agent pull request, which every later agent run reading that pull request weighs as the Operator's own words, never as a request for work: a change the Operator wants built still goes through Request changes.
_Avoid_: PR feedback, reply

**UI evidence**:
The screenshots, and preview link if the Product repo has one, that the Kit captures for a pull request changing a Product repo's UI, so the Operator and the Reviewer can see what was built.
_Avoid_: visual proof, screenshots, artifacts

**Digest**:
The Kit's plain-English account of an agent pull request as it stands at one head, written each time it arrives at the Merge gate and kept on the pull request for the Operator: what was decided and why, what was left out of scope, what needs follow-up, and which parts deserve the Operator's own eyes.
_Avoid_: PR summary, brief, report, changelog

**Capture identity**:
A named kind of user that UI evidence views a route as, signed in to the Sandbox's own server with fake credentials.
_Avoid_: role, persona, test user

**Prototype**:
Throwaway variants of one UI route that a Design session builds on a branch that is never merged, so the Operator can choose a design by looking at it.
_Avoid_: mockup, spike, preview

**Evidence page**:
The single HTML page the Kit uploads beside a pull request's UI evidence, or a Prototype's variants, so the Operator can open every capture from GitHub in one click.
_Avoid_: gallery, screenshot page

**Gallery**:
The Console's view of one Product repo's Prototypes and the UI evidence of its pull requests. It shows only what still has screenshots and keeps none itself.
_Avoid_: evidence page (the Kit's own page), album, roll

## Measuring the factory

**Run record**:
The durable account of one AFK agent run in one role: its model, cost, outcome and transcript, written once when the run ends and never changed.
_Avoid_: run log, telemetry, step summary

**Scorer**:
A Kit-owned rubric that a judge model applies to one finished run's transcript, scoring 0–1 how the run worked, never what it built.
_Avoid_: eval, grader, judge

**Human touch**:
Each time the Operator steps into a Ticket's path between Dispatch and merge: a push to its branch, a Request changes, a Retry or Step-up they asked for, or a Pairing session or Operator step on it. The merge, Design-session answers and Operator comments are not touches.
_Avoid_: intervention, manual fix

**Architectural escape**:
An Audit candidate the Operator files as an issue that traces back to merged agent pull requests: structural decay that passed Review. Counted against those pull requests, never against a candidate the Operator set aside.
_Avoid_: architecture regression, design debt

**Review miss**:
A point in a Request changes asking for what a pass should already have caught: something the Ticket as it then stood, its Spec or the Product repo's standards required. A point that amends the Ticket, or only asks for a rebase, is none, and unlike an Architectural escape it's caught at the Merge gate, before merge.
_Avoid_: missed flaw, false pass, escape

**Replay**:
An experiment the Operator starts that re-runs merged Tickets from their original base commit, once as before and once with one thing changed, to compare the two. A Ticket whose first run was a Kept-branch start can't be rebuilt from its base commit, so a Replay leaves it out, saying why.
_Avoid_: benchmark, eval, rerun

**Arm**:
One of a Replay's two runs of a Ticket, each one Implement run and its Review: the **baseline**, run as the Ticket was built then, or the **variant**, run with the one thing the Replay changes. A Replay's variant is an Arm, never one of a Prototype's variants.
_Avoid_: leg, treatment, control, experiment group

**Hidden tests**:
The test files a Ticket's merged pull request added or changed, which an Arm never sees while it works and is measured by afterwards. A merged pull request with none has no hidden tests, which is never a pass.
_Avoid_: held-out tests, answer tests, merged tests

**Candidate Kit sha**:
A Fabrik commit not yet released, such as a Retro proposal's, whose prompts and Base skills a Replay's variant loads in place of the pinned release's.
_Avoid_: candidate Kit, Kit variant, prompt branch

**Weekly summary**:
The one issue filed each week across all of the Operator's Product repos: the factory's metrics, everything waiting on the Operator, held by a cap, or stuck, and whether each repo's Loop is running.
_Avoid_: inbox, Operator inbox, dashboard, report
