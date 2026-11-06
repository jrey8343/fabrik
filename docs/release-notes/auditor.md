# Release notes: the Auditor and Architectural escapes

The notes for the minor release that ships the Auditor ([#150](https://github.com/jrey8343/fabrik/issues/150)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- Once a week each Product repo gets an Audit. From 00:00 UTC on `audit.day` (Sunday by default), the scheduled tick opens a pending Audit, a `fabrik:audit` issue from the Fabrik App, and its opening starts the Auditor in the Loop workflow's new Audit job. The Auditor (Opus 5.5, 45 minutes by default, `roles.audit`, plus `.fabrik/audit.md` when present) reads the default branch in a read-only checkout with the Base skills alone. It fills the Audit with at most 3 deepening opportunities, each with an **Open as issue** link, or closes it as clean when nothing scores above Speculative. The README's Audit section has the whole of it.
- The Audit changes nothing in the repo: no branch, no PR, no state label, and no mention or assignee, so it never pushes to the Operator's phone. It surfaces in the Weekly summary instead. A failed Auditor run closes its Audit as not planned with one line saying why, and a later tick tries again, until two runs have failed that week. No new Audit opens while one is open, while the weekly-limit issue is open, or when the default branch hasn't moved since the last one.
- Filing a candidate that traces to merged agent PRs records an Architectural escape against them, through a hidden marker in the prefilled issue body. The Weekly summary gains the architectural escape rate over the trailing 90 days beside last week's, a by-Strength line, each repo's escapes filed that week with the Review run that missed each, and each repo's open Audit in Waiting on you.
- New Kit config fields, each with a default: `audit.day` and `roles.audit`. No shim change, no new secret, no new App permission and no setup step, so a Product repo only merges the bump PR. `/fabrik-setup` now also creates the `fabrik:audit` label.

## It starts on taking the release

There's nothing to turn on: the Audit starts once a Product repo merges the bump PR, on its next `audit.day`. To keep it out of a repo, such as one you aren't developing, set `"audit": { "day": null }` in that repo's `.fabrik/config.json` before you merge the bump PR.

1. **Take it in the Pilot first.** Merge this release's bump PR in the Pilot only. To see an Audit before Sunday, set `audit.day` there to today's UTC day and set it back once the Audit has opened. Then check:
   - an `issues.opened` event from the App's pending Audit starts the Loop workflow and routes to the Audit job, and the pending Audit carries the `fabrik:audit` label;
   - the Audit fills in, or closes as clean, with no mention or assignee, and the next hourly tick opens no second Audit;
   - one Auditor run's cost and duration, from its Run record in `fabrik-runs`, noted on [#214](https://github.com/jrey8343/fabrik/issues/214), to check the 45-minute default timeout.
2. Once the Pilot is healthy, merge the bump PR in the other Product repos.
