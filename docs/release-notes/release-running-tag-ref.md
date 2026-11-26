# Release notes: the first Tick on a new release says so again

The notes for the patch release whose Tick reads the release it runs on as the bare tag the caller pins ([#906](https://github.com/jrey8343/fabrik/issues/906)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

The first hourly Tick on a newly pinned release comments "Fabrik vX is running here" on the pull request that moved the pin, as [#548](https://github.com/jrey8343/fabrik/issues/548) meant it to. Since that shipped, no Tick had: each read its own release as `refs/tags/vX`, never equal to the `vX` the caller pins, and its Release running summary said "This Tick runs on Fabrik refs/tags/vX, but the newest pin move on main … pins vX, so nothing is posted."

## What changed

- **The Tick reads its release as the bare tag.** The scheduled tick takes its Kit workflow ref from the OIDC token's `job_workflow_ref` claim, which GitHub words with the full ref, `…/schedule.yml@refs/tags/vX`. The Kit now drops the leading `refs/tags/` before it compares the release with the caller's pin or names it, so the Release running job posts on the pin move's pull request, once, and its step summary names `vX`.
- **A Dead-tick issue's closing comment names the release as `vX`** too, where it said "on Fabrik refs/tags/vX": the scheduled tick's release comes from the same ref.
- **A Kit ref of any other shape is taken as it is.** A branch (`refs/heads/…`, even one named like a tag) or a commit SHA is never read as the pinned release, so it posts nothing.
- **The first Tick on this patch comments on its own bump PR.** A pull request that moved the pin to an earlier release, and got no comment then, gets none now: the Tick only looks at the newest pin move.
- **Why a patch:** it fixes a comment that never came. No caller, shim, Kit config field, secret, permission or Fabrik App permission changes, and the read library is unchanged. A Product repo merges the bump PR.
