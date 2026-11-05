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

**Product repo**:
A repository holding a real product that has adopted the Kit, where the Loop's work actually lands.
_Avoid_: target repo, client repo, project

**Pilot**:
The first Product repo used to prove the Kit against real stakes: Penrith Physiotherapy & Sports Centre.
_Avoid_: test repo, demo

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

## The loop

**Loop**:
The end-to-end path a piece of work takes in Fabrik, from idea to a pull request the Operator has merged.
_Avoid_: pipeline, workflow, Real Engineering Loop (Matt Pocock's term, not Fabrik's)

**AFK**:
Work an agent drives alone, with no human in the exchange.
_Avoid_: autonomous, background

**HITL**:
Work that only resolves through a live exchange with the Operator speaking for themselves; an agent never stands in for the Operator's side.
_Avoid_: interactive, manual

**Intake**:
The rule that gives a new issue `needs-triage`, unless a skill made it or it already has a state, so Triage sees it.
_Avoid_: inbox, new-issue hook

**Triage**:
The AFK step that sorts each incoming issue (not ones the Loop's own skills create) into its next state: straight to an Implementer, into design with the Operator, or set aside.
_Avoid_: sorting

**Design session**:
A HITL grilling between the Operator and an agent that turns an issue needing design (first time or after a failed review) into one or more ready tickets, or ends as not planned when the Operator decides it won't be built: the issue gets `wontfix` and closes as not planned.
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

**Fast path**:
Triage sending an issue straight to an Implementer, skipping the Design session.
_Avoid_: fast-track, easy fix

**Dispatch**:
The Kit releasing a ready, unblocked Ticket to an Implementer.
_Avoid_: kick off, assign

**Verdict**:
The Reviewer's judgment on a pull request: pass, Execution flaw or Design flaw.
_Avoid_: approval, review result

**Execution flaw**:
A Verdict that the right design was built wrongly, so the Implementer can fix it.
_Avoid_: bug, failing review

**Retry**:
An Implementer run that fixes an Execution flaw on its Ticket's open pull request, building on whatever the branch holds when it lands, the Operator's pushes included. A Ticket gets two before the next Execution flaw counts as a Design flaw, whoever pushed the flawed head.
_Avoid_: rerun, attempt

**Design flaw**:
A Verdict that the Ticket itself is wrong, so it needs a Design session.
_Avoid_: bad spec, rejection

**Infrastructure failure**:
A run that fails for a reason outside the work itself, such as the model provider, the Sandbox or a credential, rather than anything the Implementer built. It never counts against a Ticket's retries.
_Avoid_: crash, error, flake

**Step-up**:
An Implementer run on a stronger model than its role's default, after a failed review or at the Operator's request.
_Avoid_: escalation, upgrade

**Sandbox**:
An isolated environment where an Implementer does its work on a branch, holding no production secrets.
_Avoid_: container, VM, workspace

**Trust-root file**:
A file in a Product repo that steers how agents behave or how their work is judged, so agents may never change it. An agent in a Pairing session counts as the Operator, so it may.
_Avoid_: config file, protected file

**Merge gate**:
The rule that only the Operator merges a pull request into a Product repo's main branch; agents never push to it.
_Avoid_: approval, sign-off

**Operator comment**:
A comment the Operator leaves on an agent pull request, which every later agent run reading that pull request weighs as the Operator's own words, never as a request for work: a change the Operator wants built still goes through Request changes.
_Avoid_: PR feedback, reply

## Measuring the factory

**Run record**:
The durable account of one AFK agent run in one role: its model, cost, outcome and transcript, written once when the run ends and never changed.
_Avoid_: run log, telemetry, step summary

**Human touch**:
Each time the Operator steps into a Ticket's path between Dispatch and merge: a push to its branch, a Request changes, a Retry or Step-up they asked for, or a Pairing session or Operator step on it. The merge, Design-session answers and Operator comments are not touches.
_Avoid_: intervention, manual fix

**Architectural escape**:
An Audit candidate the Operator files as an issue that traces back to merged agent pull requests: structural decay that passed Review. Counted against those pull requests, never against a candidate the Operator set aside.
_Avoid_: architecture regression, design debt
