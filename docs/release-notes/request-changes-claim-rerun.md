# Release notes: A Request-changes run left with no Implement job behind it

The notes for the change that restarts a Request-changes run whose claim noted it on a draft with no Implement job behind it ([#387](https://github.com/jrey8343/fabrik/issues/387), ADR-0015). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- **A stalled Request-changes run on a draft is restarted.** If you re-run only a failed "Claim the work" job, the claim notes the Request-changes run and turns the PR to draft, but no Implement job runs for it. The push-to-`main` check and the hourly tick now restart such a run with a fresh `agent:implement` on the Ticket. They do it once the note is more than 10 minutes old and no Implement job is under way anywhere in the repo. A check that can't read the jobs leaves the run alone.
- **The push-to-`main` push job and the tick read workflow runs.** The Fabrik App has no Actions permission (ADR-0002), so each reads them with its job's own read-only `GITHUB_TOKEN`. The push job asks for `actions: read`, which the caller's `loop` job already grants. The tick asks for it too, which the caller's `tick` job now has to grant.
- **Why a major:** the caller workflow's shim changed. Its `tick` job grants `actions: read` as well as `id-token: write`. GitHub refuses to start a called workflow whose job asks for more than its caller grants. So until a Product repo's `fabrik.yml` grants it, **every hourly tick fails before it starts**: the Audit, the Retro, the Replays, the weekly-limit reset, the Monitor and the conflict check all stop. Merging the Dependabot bump alone isn't enough. If this ships in the same release as the Undelivered Request changes notes, that release is a major too, and their "No shim changes" and "Why a minor" lines need changing.

## Upgrading

In each Product repo, run Setup again, naming the new release (see [Adopting the Kit](../../README.md#adopting-the-kit)). It rewrites `.github/workflows/fabrik.yml` from the template. Or, in the bump PR itself, add `actions: read` under the `tick` job's `permissions:`, after `id-token: write`, before you merge it.

## To check it on the Pilot

1. After the upgrade, check that the next hourly tick's run succeeds.
2. On an agent PR at the Merge gate, request changes, and cancel the "Claim the work" job before its step finishes, so its Implement job runs and drops its push. Re-run only the failed jobs. Check that the claim's note appears and the PR goes to draft, and that within the hour, once the run's workflow has finished, a check adds `agent:implement` to the Ticket and the Request-changes run starts.
