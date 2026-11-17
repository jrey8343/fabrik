# Release notes: What the Implementer is given

The notes for the minor release that gives every Implement run the Product repo's Coding standards, holds a Ticket's acceptance criteria to what a run can meet, and runs Design sessions at `high` ([#761](https://github.com/jrey8343/fabrik/issues/761)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

<!-- Filled in once every part below is written. -->

## What changed

<!-- One bullet per Ticket, each written by its own Ticket: #762 (the Coding standards), #763 (the Design session's rule), #764 (the Implementer's out-of-reach criteria), #765 (the Reviewer's Design flaw), #766 (Ticket compliance version 3), #767 (Design at high). -->

- An Implementer that finds an acceptance criterion no run can meet no longer commits nothing. `prompts/implement.md` names what makes one: a Trust-root change, a GitHub write, a commit, branch or state the run wasn't given, a suite or command no Required check runs, something only the Operator can do, or a literal no output can satisfy. The run builds the rest of the Ticket, commits it, and names each such criterion, quoted, with the reason, in its summary under **Criteria no run can meet**, so the pull request opens, its Required checks run, and it is Reviewed as any is. It never works around one: no Trust-root edit, no `gh` or API call, no result claimed for a command it didn't run. A Ticket with nothing buildable without one still ends in no commits, with the reason in the summary. The rule holds on a first run, a Kept-branch start, a Retry, a Touch-up and a Request-changes run, and on a run on a pull request the heading stays in its body while the criterion is unmet. "Questions for the Operator" stays the one heading for questions. The Kit does nothing with the new heading ([#764](https://github.com/jrey8343/fabrik/issues/764)).

## Upgrading

<!-- Written by the Tickets whose change asks anything of a Product repo beyond merging the bump. -->
