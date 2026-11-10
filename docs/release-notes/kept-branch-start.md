# Release notes: Kept-branch starts

The notes for the release that ships Kept-branch starts ([#536](https://github.com/jrey8343/fabrik/issues/536), ADR-0017). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- A new label, `fabrik:kept-branch`, marks a Ticket for a Kept-branch start. While it's on and the Ticket has no open PR, its Implement run, first run or Retry after an empty diff, carries on the Ticket's Kept branch, `fabrik/ticket-<n>`, the branch of the PR the Kit closed, instead of cutting one from `main`. It merges `main` in first when the branch lacks it.
- A Design session's agent brief takes an optional `keptBranch`. With `true`, the Kit adds `fabrik:kept-branch` as it moves the issue to `ready-for-agent`; with `false`, or left out, it takes the label off. A split's Ticket with `keptBranch` breaks the Design session's contract.
- Every Back to design takes `fabrik:kept-branch` off the Ticket, the Verdict's, the Operator's and a third empty diff's.
- With the label on and the Kept branch gone, no run starts: the Ticket goes to `ready-for-human`, assigned to the Operator, with one comment. Dispatch never adds `agent:implement` to such a Ticket, and stops it the same way.
- Only a Kept-branch start's own commits go to the trust-root guard. Its push fast-forwards the branch and opens one new draft PR against `main`, whose body ends "Carries on from #N." Its changed-tests section and UI evidence cover the whole branch.
- The Implement prompt now says no run resets onto, checks out or merges another branch because a Ticket says to.
- Run records move to schema 7, adding `keptBranch`; older records read as `false`. A Replay leaves out a Ticket whose first run was a Kept-branch start, naming why. The judge scores such a run as its own kind.
- No shim changes and no Kit config fields.

## To turn it on

1. **Re-run Setup** at this release in each Product repo (the Setup command in the README's [Adopting the Kit](../../README.md#adopting-the-kit), naming this release): its plan creates `fabrik:kept-branch` on a repo that lacks it. Until then, no brief can set it, and the Loop runs as before.
2. **Bump the store's pin** in `fabrik-runs` to this release, so its Weekly summary reads schema 7 records.
