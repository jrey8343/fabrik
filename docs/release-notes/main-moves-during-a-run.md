# Release notes: a run that brought `main` in lands though `main` moved while it ran

The notes for the patch release that stops a move of `main` during a run on a pull request's branch from discarding the run ([#861](https://github.com/jrey8343/fabrik/issues/861)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

A conflict-only run that rebased its pull request onto `main` and resolved the conflicts is no longer handed back as not having rebased because `main` moved while it ran: its branch is pushed, and Review starts.

## What changed

- **`main` as the run started counts.** An agent job can't fetch, so a run on its pull request's branch brings in `main` as its checkout held it. The push job used to count `main` as brought in only when the branch held `main` as it was when the run ended, so any push to `main` during the run undid it. Now the branch counts when it holds, and the pull request's head didn't, either `main` as it is when the run ends or `main` as the Kit job read it before the run started. A head only the agent job names still never counts.
- **A conflict-only run lands.** With `main` having moved during the run, its branch is pushed, its push note is posted and Review starts, as when `main` didn't move. The note names the head the run was started for, which the branch holds. On a Product repo whose `main` moves more often than a conflict-only run takes, such a run used to never land, each one handed back with its resolution discarded.
- **Nothing new after the push.** A pushed head that still conflicts with the newer `main` gets that head's own attempt (ADR-0011), which starts from the pushed branch and its resolution. One that merges cleanly with it is only behind `main`, which the Kit leaves alone.
- **The hand-back that remains says what the push job found.** A conflict-only run whose branch holds neither head is still handed back. Its notice now says the branch "holds `main` neither as the run started nor as it is now", where it said the run "didn't rebase onto `main`". The notice's markers are unchanged, so the Standing reads it as the same hand-back.
- **Retries and Request-changes runs.** A run with no change of its own that merged in `main` as it started, with `main` moving meanwhile, has brought the pull request up to date and is pushed, where it was read as an empty diff. How a Request-changes run told to merge `main` in is judged is unchanged.
- **Why a patch:** it fixes the push job to count what it already worked out, and needs nothing from a Product repo beyond the bump.

## Not covered

- The push job doesn't rebase a run's branch forward onto the newer `main` before it pushes.
- When the Kit job read no `main` head before the run, or a force-push took that head out of `main`'s history, only `main` as it is when the run ends counts, as before.
- A run discarded before this release isn't recovered from its artifact.
