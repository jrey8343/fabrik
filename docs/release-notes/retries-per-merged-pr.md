# Release notes: Retries per merged PR

The notes for the minor release that measures Retries per merged PR ([#736](https://github.com/jrey8343/fabrik/issues/736), part of [#734](https://github.com/jrey8343/fabrik/issues/734)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- The Weekly summary's Metrics table gains **Retries per merged PR**, straight after the Yield rows: for each agent PR merged in the week, the Retries on its Ticket's whole path that ended before the week's end, on any of its PRs, averaged to one decimal, then last week's and the change. A merged PR with no Ticket counts 0.
- A Retry counts once for its Ticket, PR and Retry number, so one started again after a failed landing is one Retry, here and in the existing **Retries** row, which could count it twice before.
- No Run-record change, no shim change and no Kit config fields.

## Upgrading

**Bump the store's pin** in `fabrik-runs` to this release, with the Pilot, since the Weekly summary runs from the store's caller. Nothing changes in a Product repo.
