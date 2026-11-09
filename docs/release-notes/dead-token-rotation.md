# Release notes: a dead token is used up

The notes for the patch release that makes Subscription rotation move runs off a Subscription whose token is dead ([#433](https://github.com/jrey8343/fabrik/issues/433)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- **With Subscription rotation on, a dead token on one Subscription no longer stalls every run.** A run whose token is refused (`authentication_failed`), as when a `claude setup-token` token reaches its expiry date, opens that Subscription's own "Rotate the Claude token of the `<name>` Subscription" issue, assigned to the Operator, and is re-run on the next free Subscription with no comment on its Ticket. Until then a second Subscription's dead token was commented onto the first's rotation issue, and every run kept failing on the dead one while the other sat idle.
- **The Kit skips a Subscription with an open rotation issue** until the Operator stores a new token and closes the issue, as it does for an open usage-credits issue. A dead token now counts as used up: with no other Subscription free, the refused run is held while a weekly-limit issue is open, and otherwise gets the usual failure comment. The Kit job step summary names a dead token among the reasons a run was held, and the Replay tick starts no replay while any rotation issue is open.
- **With one Subscription listed, nothing changes**: the one rotation issue stalls the repo as before.

## Upgrading

A rotation issue opened before this release names no Subscription, so the Kit reads it as the first listed one's and skips that Subscription while it is open. If such an issue is open for another Subscription, rotate that token and close the issue; the next refusal opens a fresh, named one.
