# Release notes: the Sandbox builds before the agent starts

The notes for the patch release that runs `sandbox.build` before the agent starts in every run that builds a branch ([#703](https://github.com/jrey8343/fabrik/issues/703)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

An Implement run and a prototype turn now start with the Product's dependencies installed: the Sandbox runs `sandbox.build` after `sandbox.setup`, before the agent starts.

## What changed

- **`sandbox.build` runs before the agent.** For an Implement run (first, Retry, Step-up and Request-changes alike), a Replay arm's Implement run and a Design session's prototype turn, the Sandbox's ready hook runs `sandbox.setup`, then `sandbox.build`, then the metered-billing preflight, each only if the one before it passed. A `null` command is skipped. Before, only `sandbox.setup` ran, so in a Product repo whose `build` installs its dependencies the agent started with none, and its first typecheck, lint or test failed.
- **A failing build fails the run before the agent takes a turn**, as a failing `setup` already did.
- **The prompts say so.** The Implementer's and the prototype turn's "Build:" line says the Kit ran it before the agent started, and to run it again after changing the dependencies or to test what it built.
- **Every other run is unchanged.** Triage and a Design session's other turns run `setup` alone. The Reviewer, the Auditor, the Retro, the Researcher, the Digest writer and a Replay arm's Reviewer run neither. Replay's gates and capture still run `build` as before, so it may run twice in a run.
- **Why a patch:** no Kit config field, shim or setup step changes. A Product repo merges the bump PR.
