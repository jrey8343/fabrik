# Release notes: every role's effort named as medium

The notes for the minor release that names `medium` outright for every role's effort and the judge's ([#740](https://github.com/jrey8343/fabrik/issues/740), part of [#734](https://github.com/jrey8343/fabrik/issues/734)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- **Every role's effort defaults to `medium`**, in place of null: Triage, Design, Implement, Review, Audit, Retro, Research, the Digest and the Step-up. Each run passes `--effort medium`, so its Run record names the level it ran at and a Claude Code upgrade can't change it unseen. Claude Code's own default for Opus 5.5 and Sonnet 5.5 is `medium` today ([#712](https://github.com/jrey8343/fabrik/issues/712)), so no run's level changes.
- **A `null` effort now reads as `medium`.** The starter Kit config used to write `"effort": null` for every role. A null effort names no level, so it now takes the default like a field left out, and the Kit no longer passes no `--effort` for it. `roles.digest`'s null effort, like a missing one, takes the repo's own `roles.review` effort, and a null `roles.review` effort counts as naming none, so both run at `medium`. A Product's own level, such as `high`, still wins.
- The starter Kit config Setup writes names `"effort": "medium"` for every role.
- **The judge runs at the Kit's fixed `medium` effort** (`JUDGE_EFFORT`, beside its fixed model), and its Run record names it, even when its job passed out nothing.
- `DEFAULT_KIT_CONFIG` in the read library names `medium` for every role's effort, and `resolveKitConfig` never returns a null effort.
- No Run-record schema change, no shim change and no Kit config fields: `effort` takes the same values, and `null` is still accepted.
- **Why a minor**, for this part and the whole of [#734](https://github.com/jrey8343/fabrik/issues/734): a Product repo only merges the bump PR, with no Kit config edit, and the read library loses nothing and no export changes what it means. `DEFAULT_KIT_CONFIG` still holds the defaults the Kit fills in, and an effort still means the level passed as `--effort`, with null still meaning none passed; the defaults are now `medium`, the level Claude Code gave the same runs. `RunRecord` gains fields (`pushed`, and `storedSchema` on a record read from an older schema), which the read library's rule counts as a minor.

## Upgrading

Nothing to do beyond the bump PR. A Product repo whose `.fabrik/config.json` still says `"effort": null` runs at `medium`, the level its runs already got from Claude Code, and needn't edit it. To run a role at another level, set its `effort` to `low`, `high`, `xhigh` or `max`.
