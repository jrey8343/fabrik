# Release notes: Claude Docs no longer stops an Operator session

The notes for the patch release in which an Operator session's connector check passes Claude Docs ([#996](https://github.com/jrey8343/fabrik/issues/996)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

An Operator session no longer stops at its first words on Claude Docs. Claude Docs is a connector that comes with every Claude account, and the Operator can't disconnect it. Every session stopped on it: the first real one, on a gradually-core issue, opened with "Stopped before any work: this session holds a connector the repo doesn't name", and waited for "go on".

## What changed

- **`fabrik-operator-session`'s connector check knows Claude Docs.** Step 3 of "Before any work" names Claude Docs by its tools (`mcp__Claude_Docs__*`) as the one connector that comes with the account. It stops nothing: the session says in one line that Claude Docs is there and that it won't call it, and goes on.
- **Any other connector still stops the session.** A connector that the repo's `.fabrik/operator-session.md` doesn't name stops it, as before, until the Operator says to go on or starts again.
- **The session still calls none of Claude Docs' tools.** It calls no tool of a connector the file doesn't name, Claude Docs' included. Claude Docs reaches only the Operator's own Docs, never GitHub, production or customers' records.
- **The README's checklist, on each Subscription, says so.** Claude Docs can't be disconnected at `claude.ai/customize/connectors`, and it stops no session.
- **Why a patch:** it fixes a check that could never pass. The skill is installed by the hook at the release the caller pins, so the bump PR brings it. No caller, shim, Kit config field, secret or permission changes, and the read library is unchanged.
