# Release notes: What the Implementer is given

The notes for the minor release that gives every Implement run the Product repo's Coding standards, holds a Ticket's acceptance criteria to what a run can meet, and runs Design sessions at `high` ([#761](https://github.com/jrey8343/fabrik/issues/761)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

<!-- Filled in once every part below is written. -->

## What changed

<!-- One bullet per Ticket, each written by its own Ticket: #762 (the Coding standards), #763 (the Design session's rule), #764 (the Implementer's out-of-reach criteria), #765 (the Reviewer's Design flaw), #766 (Ticket compliance version 3), #767 (Design at high). -->

- **Every Implement run is given the Coding standards** ([#762](https://github.com/jrey8343/fabrik/issues/762)). The whole of a Product repo's `CODING_STANDARDS.md`, from the root of the checkout, now goes inline into the Implementer's prompt, under the same heading and in the same form as the Reviewer's, with nothing cut or summarised. That covers a first run, a Kept-branch start, a Retry (the Step-up included), a Touch-up, a Request-changes run, a conflict-only run and a Replay Arm's Implement run, which gets the file as the Ticket's base commit holds it. The Implement prompt tells the run to build to it in the code it writes or changes, says the Reviewer judges the pull request against the same text, and has it name older code that breaks a rule in its summary instead of fixing it. A repo with no such file gets nothing in its place, a prototype turn gets none, and `.fabrik/review.md` and the review prompt still go to the Reviewer alone. The file stays a Trust-root file that only the Operator changes.
- **A Design session holds every acceptance criterion to what a run can meet** ([#763](https://github.com/jrey8343/fabrik/issues/763)). A criterion is one check on a Ticket that a test the Required checks run, or the diff itself, shows is met, and it never asks for a Trust-root change, a GitHub write, a commit, branch or state the run isn't given, a suite or command no Required check runs, or anything only the Operator can do. The rule covers an agent brief's criteria, each Ticket's in a Spec or a split, and a Roll-in's. An async turn is now given the Required checks `sandbox.checks` lists, under "The Required checks", and a live session reads them from the Kit config in its checkout; both read `.github/workflows/` for what each runs. A test no Required check runs is moved where one does or dropped, and a workflow change to bring it in becomes an Operator step that blocks the Ticket. The Glossary gains **Acceptance criterion**.

## Upgrading

<!-- Written by the Tickets whose change asks anything of a Product repo beyond merging the bump. -->
