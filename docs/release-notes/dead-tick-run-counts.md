# Release notes: a Dead-tick issue counts the runs that never started

The notes for the minor release that has the daily Tick check count a dead Tick's never-started runs ([#554](https://github.com/jrey8343/fabrik/issues/554)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- **A new Dead-tick issue says how many runs of `fabrik.yml` never started since the Tick died.** When the daily Tick check opens a Dead-tick issue, it reads the repo's `fabrik.yml` runs created since the last started Tick (or, when no Tick ever started, since `fabrik.yml` came to `main`). After the last-Tick text, the issue says, for example, "**14 runs of `fabrik.yml` since then never started**, 9 of them on issue, comment, pull request or push events, so nothing the Loop does on an event has run either: no Triage, Design, Implement or Review." A never-started run is one GitHub refused at startup, on any event. The events clause appears only when some of those runs weren't scheduled ones. So the issue now says whether only the Tick is down or the whole Loop is.
- **It says when the workflow is most likely disabled.** A disabled workflow creates no runs, while a refused one creates runs that never start. When GitHub created no scheduled run of `fabrik.yml` since the Tick died, the issue says so, and its first step becomes "Check that the workflow is enabled", ahead of reading the newest run's error.
- The count is written once, when the issue opens, and never edited after. The check reads a repo's runs only when it's about to open that repo's issue: never for a live Tick, nor while its issue is open. When to call a Tick dead, the issue's title, labels and assignee, the issue in `fabrik-runs` for an unreachable repo, and how the issue closes are all unchanged.
- The check mints a second Fabrik App token, with only Actions read on every installed repo, in a step that's allowed to fail. Its main token is unchanged.
- **No new App permission.** The App asked for Actions: read in the Weekly summary's Loop health release ([#460](https://github.com/jrey8343/fabrik/issues/460)). Until the Operator accepts it, the second token's mint fails, and the check opens and closes issues exactly as before, with no count. Its step summary says the run counts are unread and why. It says the same, with GitHub's message, when GitHub won't list a repo's runs.
- **Why a minor:** it's new behaviour that needs nothing from a Product repo. The Product caller, its permissions, the shims and the Kit config are as they were, and the Weekly summary's tokens and output are unchanged.

## To turn it on

The check runs from `fabrik-runs`, so turning it on is only bumping the store's caller to this release.

1. **Bump the Pilot's store caller first.** Merge `fabrik-runs`' Dependabot bump to this release, or re-run Setup in the Pilot at this release. If you haven't yet accepted the Fabrik App's Actions: read, accept it in the installation's settings.
2. **Check it the next morning.** The store's Actions tab has a green Tick check job. A Dead-tick issue opened from then on has the run count, unless its step summary says the counts are unread. To see it, disable the Pilot's `fabrik.yml` workflow for a little over a day: the issue the next check opens says GitHub created no scheduled run, so the workflow is most likely disabled, and leads its steps with checking it's enabled.
3. **Then the other Product repos.** The bumped store caller already covers them, with nothing to merge in any of them.
