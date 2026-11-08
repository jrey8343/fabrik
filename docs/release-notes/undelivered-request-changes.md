# Release notes: Undelivered Request changes

The notes for the minor release that acts on a Request changes GitHub never delivered, and marks every Request-changes run on its PR ([#341](https://github.com/jrey8343/fabrik/issues/341), ADR-0015). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- **Every Request-changes run is marked on its PR.** The Kit posts a note naming the run's reviews as it starts it, `<!-- fabrik:request-changes-run-started <reviews> -->`, mentioning nobody. Only a Kit note puts a run in flight: that note, the undelivered note below, or an Execution flaw that gave way to the reviews. A run is in flight until it pushes, is given a Verdict or ends, until the PR leaves draft, or until the Operator dismisses every review it names. The old rule, that a run was in flight while the latest Verdict was a pass on the head the Operator's latest review was on, is gone.
- **An undelivered Request changes is acted on.** GitHub starts no workflow for a review on a PR that conflicts with its base. So the push-to-`main` check and the hourly tick look for an Operator Request changes on an agent PR out of draft that no run was started for. Once one is more than 10 minutes old (on a PR that merges cleanly, older than the Implement job's timeout), they post one `<!-- fabrik:undelivered-request-changes <ids> -->` note naming and linking each such review, put the PR back in draft and start its Request-changes run, which uses no retry. While one waits, the Kit doesn't rebase the PR itself.
- **A Request-changes run on a conflicting PR merges `main` in**, never rebasing, and its fix comment lists each conflicted file. If what it built still conflicts, it committed nothing, or the trust-root guard refuses it, the Kit says why on the PR, adds `ready-for-human` and takes the PR out of draft, never closing it.
- **An Execution flaw gives way to an unbuilt Request changes.** It calls for no Retry, never counts toward the Ticket's two, and starts the Request-changes run itself, which fixes its findings too.
- **Dismissing every review a run is for ends that run**, and its work isn't pushed. The PR goes back to the Merge gate, saying so, or gets a Review if its head moved since its last Verdict.
- No shim changes and no Kit config fields.

## Before merging the bump PR

A Request-changes run that a Kit before this release (`v0.6.0` or earlier) started has no started note, so this release doesn't count it as in flight. If that run is stalled by an Infrastructure failure, or held until a weekly reset, when the bump lands, re-adding `agent:implement` or the reset resuming held runs only removes the label. The PR is a draft, so the tick and the conflict check skip it. It stays in draft, holding a `max_in_flight` slot, until you act on it.

So, in each Product repo, before you merge its bump PR, look for an open agent PR in draft for a Request changes: a draft on a `fabrik/ticket-<n>` branch whose latest review from you requests changes, with no Kit push note (`<!-- fabrik:request-changes-run -->`) or Verdict after that review. This lists the candidates:

```sh
gh pr list --draft --json number,headRefName,latestReviews \
  --jq '.[] | select(.headRefName | startswith("fabrik/ticket-")) | select(any(.latestReviews[]; .state == "CHANGES_REQUESTED")) | .number'
```

For each one, either let its run finish first, or mark the PR ready for review. Then merge the bump.

## If one is stuck after the upgrade

Re-adding `agent:implement` won't resume it. Instead:

- **Mark the PR ready for review.** That frees its `max_in_flight` slot straight away. The next hourly tick, or the next push to `main`, finds your Request changes with no run started for it, as for an undelivered one. It posts the note that says no Request-changes run is under way, linking your review, puts the PR back in draft and adds `agent:implement`, which starts the Request-changes run on the Step-up model, using no retry. It reads all your Request changes on the PR, so there's nothing to resubmit. A review stuck since before the upgrade is already past the wait above, so the first check after you mark the PR ready acts on it.
- **Or push to it.** A push to the draft starts a Review of the new head. A pass hands the PR back to you at the Merge gate and counts your Request changes as settled, since the Reviewer read it as part of the Ticket. An Execution flaw gives way to it, uses no retry, and starts its Request-changes run. So push only when your push builds what you asked for. Otherwise mark the PR ready for review.

This only matters for a run started on the earlier Kit. Every run this release starts carries its note, so re-adding `agent:implement` resumes it as before.

## To check it on the Pilot

1. Before merging the Pilot's bump PR, run the command above. Act on any PR it lists, as above.
2. After the bump, request changes on a passed agent PR. Check that a `<!-- fabrik:request-changes-run-started … -->` note naming your review appears on the PR as its run starts.
