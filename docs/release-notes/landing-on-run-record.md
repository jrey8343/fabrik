# Release notes: a failed landing on the Run record

The notes for the release that records how the push job's landing of a run ended ([#487](https://github.com/jrey8343/fabrik/issues/487), ADR-0009). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- Run records move to schema 9, adding `landing`: null when the push job landed the run, else how its landing failed. It names the Loop step's outcome, the class of failure (`refused`, with `rate-limited` or `missing-permission`; `github`, a 5xx or a call GitHub never answered; `missing-file`; or `kit`), the plan's action that failed, the GitHub request, its status and GitHub's `x-github-request-id`, and for a plan the Loop wouldn't land, its reason. Older records read as `landing: null`.
- A run whose agent succeeded and whose landing then failed no longer reads as a success: its `jobResult` stays the agent job's, and `landing` says the landing failed.
- The Weekly summary's Metrics table gains **Landings failed**, the week's runs whose landing failed against last week's, apart from the runs whose agent failed.
- The failure comment, step summary and `landing-failed` hand-back are worded as before.
- No shim changes and no Kit config fields.

## Upgrading

**Bump the store's pin** in `fabrik-runs` to this release, with the Pilot, so its Weekly summary reads schema 9 records. Until then it leaves them out, and says how many.
