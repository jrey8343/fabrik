# Release notes: What the Implementer is given

The notes for the minor release that gives every Implement run the Product repo's Coding standards, holds a Ticket's acceptance criteria to what a run can meet, and runs Design sessions at `high` ([#761](https://github.com/jrey8343/fabrik/issues/761)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

<!-- Filled in once every part below is written. -->

## What changed

<!-- One bullet per Ticket, each written by its own Ticket: #762 (the Coding standards), #763 (the Design session's rule), #764 (the Implementer's out-of-reach criteria), #765 (the Reviewer's Design flaw), #766 (Ticket compliance version 3), #767 (Design at high). -->

- **A Design session holds every acceptance criterion to what a run can meet** ([#763](https://github.com/jrey8343/fabrik/issues/763)). A criterion is one check on a Ticket that a test the Required checks run, or the diff itself, shows is met, and it never asks for a Trust-root change, a GitHub write, a commit, branch or state the run isn't given, a suite or command no Required check runs, or anything only the Operator can do. The rule covers an agent brief's criteria, each Ticket's in a Spec or a split, and a Roll-in's. An async turn is now given the Required checks `sandbox.checks` lists, under "The Required checks", and a live session reads them from the Kit config in its checkout; both read `.github/workflows/` for what each runs. A test no Required check runs is moved where one does or dropped, and a workflow change to bring it in becomes an Operator step that blocks the Ticket. The Glossary gains **Acceptance criterion**.

## Upgrading

<!-- Written by the Tickets whose change asks anything of a Product repo beyond merging the bump. -->
