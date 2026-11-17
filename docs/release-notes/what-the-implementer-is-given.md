# Release notes: What the Implementer is given

The notes for the minor release that gives every Implement run the Product repo's Coding standards, holds a Ticket's acceptance criteria to what a run can meet, and runs Design sessions at `high` ([#761](https://github.com/jrey8343/fabrik/issues/761)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

<!-- Filled in once every part below is written. -->

## What changed

<!-- One bullet per Ticket, each written by its own Ticket: #762 (the Coding standards), #763 (the Design session's rule), #764 (the Implementer's out-of-reach criteria), #765 (the Reviewer's Design flaw), #766 (Ticket compliance version 3), #767 (Design at high). -->

- **The Design session's default effort is `high`** ([#767](https://github.com/jrey8343/fabrik/issues/767)). A miss in a Design session costs a Back to design, the sessions are the cheapest runs in the factory ($41 of the $404 spent from 7 to 15 Nov), and the longest turn took 4.1 of its 30 minutes ([#722](https://github.com/jrey8343/fabrik/issues/722)). A Replay can't vary Design, so this goes in without one. A repo's own `roles.design.effort` still wins, and a `null` or missing one takes the default, now `high`. A prototype turn runs on the Design role's model and effort, so it runs at `high` too, within the Implement role's time limit. Every other default stays: `high` for the Review, `medium` for Triage, Implement, the Auditor, the Retro, the Researcher, the Digest writer and the Step-up, and the Design time limit stays 30 minutes. The starter Kit config names `high` for `roles.design`.

## Upgrading

<!-- Written by the Tickets whose change asks anything of a Product repo beyond merging the bump. -->

**Design at `high`** ([#767](https://github.com/jrey8343/fabrik/issues/767)). A Product repo that names no `roles.design.effort`, or names `null`, as gradually-core and Penrith do, takes `high` with the bump alone. One that names `roles.design.effort` outright, as a `.fabrik/config.json` written from an earlier starter does with `"medium"`, keeps that level until its Operator deletes the field, to take the default, or changes it.
