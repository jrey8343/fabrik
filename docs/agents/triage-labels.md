# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |
| _(Fabrik addition)_        | `needs-design`       | Needs a Design session with the Operator before an agent can build it (first design or after a failed review) |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

A sub-issue filed with no state label gets no `needs-triage` from Fabrik, since a skill usually files sub-issues with their state: add `needs-triage` for Triage to look at it, or a state label yourself.

## Fabrik's other labels

Fabrik also uses these labels, which aren't triage roles. Skills don't set them; Setup creates them.

**`agent:` labels** start a run. Fabrik adds each itself, and you re-add one to run it again. It comes off as the run starts (`agent:review` comes off with the Review's Verdict), so one still on half an hour after it was added is a run that never started: the hourly tick adds it again once, and if it's still on at a later tick, takes it off and @-mentions you.

| Label             | Goes on                    | Starts                                          |
| ----------------- | -------------------------- | ----------------------------------------------- |
| `agent:implement` | a `ready-for-agent` Ticket | an Implementer, or resumes its PR's run         |
| `agent:design`    | a `needs-design` issue     | a Design session's first turn                   |
| `agent:review`    | an agent PR                | a Review, or resumes one                        |
| `agent:research`  | a research Decision        | a Researcher                                    |
| `agent:replay`    | a replay issue             | the Replay's next Ticket                        |

**`fabrik:` labels** say what an issue is to Fabrik, and `fabrik:step-up` marks a Ticket:

| Label                   | Meaning                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `fabrik:weekly-limit`   | a Kit-owned issue: a Subscription has hit its weekly limit              |
| `fabrik:usage-credits`  | a Kit-owned issue: a Subscription spent usage credits, which must be turned off |
| `fabrik:token-rotation` | a Kit-owned issue: a Claude token was refused and needs rotating        |
| `fabrik:audit`          | the week's Audit, which the Auditor files                               |
| `fabrik:retro`          | the week's Retro, proposing changes to how the factory works            |
| `fabrik:replay`         | your Replay request, re-running merged Tickets with one thing changed   |
| `fabrik:monitor`        | an issue the Monitor filed for a production error or a red `main`       |
| `fabrik:step-up`        | on a Ticket: every Implement run that starts while it's on is a Step-up |

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.
