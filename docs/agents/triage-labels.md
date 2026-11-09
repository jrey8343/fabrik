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

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.
