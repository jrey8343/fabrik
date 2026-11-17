# Release notes: What the Implementer is given

The notes for the minor release that gives every Implement run the Product repo's Coding standards, holds a Ticket's acceptance criteria to what a run can meet, and runs Design sessions at `high` ([#761](https://github.com/jrey8343/fabrik/issues/761)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

<!-- Filled in once every part below is written. -->

## What changed

<!-- One bullet per Ticket, each written by its own Ticket: #762 (the Coding standards), #763 (the Design session's rule), #764 (the Implementer's out-of-reach criteria), #765 (the Reviewer's Design flaw), #766 (Ticket compliance version 3), #767 (Design at high). -->

- **Every Implement run is given the Coding standards** ([#762](https://github.com/jrey8343/fabrik/issues/762)). The whole of a Product repo's `CODING_STANDARDS.md`, from the root of the checkout, now goes inline into the Implementer's prompt, under the same heading and in the same form as the Reviewer's, with nothing cut or summarised. That covers a first run, a Kept-branch start, a Retry (the Step-up included), a Touch-up, a Request-changes run, a conflict-only run and a Replay Arm's Implement run, which gets the file as the Ticket's base commit holds it. The Implement prompt tells the run to build to it in the code it writes or changes, says the Reviewer judges the pull request against the same text, and has it name older code that breaks a rule in its summary instead of fixing it. A repo with no such file gets nothing in its place, a prototype turn gets none, and `.fabrik/review.md` and the review prompt still go to the Reviewer alone. The file stays a Trust-root file that only the Operator changes.

## Upgrading

<!-- Written by the Tickets whose change asks anything of a Product repo beyond merging the bump. -->
