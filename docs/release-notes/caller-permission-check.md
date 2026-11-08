# Release notes: A caller that grants too little is caught on the bump PR

The notes for the change that checks a pull request's caller workflow against the release it pins, and keeps a major out of Dependabot ([#422](https://github.com/jrey8343/fabrik/issues/422), ADR-0003's addendum). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- **A bump PR's `loop / Kit` check compares the caller's grants with the new release's asks.** On a pull request that changes `.github/workflows/fabrik.yml`, Dependabot's bump of the pin say, the Kit job reads the caller the PR proposes and the reusable workflows at the release it pins, and compares each caller job's `permissions:` with what the called workflow's jobs ask for. A job that lacks a line, or grants it at a lower level, fails the check, naming the caller's job and the line to add. The PR's pins are checked the same way (one exact release, every workflow it names at that tag). The run reads both as data; nothing from the PR runs.
- **Why it matters:** v1.0.0 asked the `tick` job for `actions: read`, and the Pilot's bump PR merged without it. GitHub checks every `uses:` job of a workflow before any job's `if:`, so every run of the caller, not only the tick, failed at startup with no jobs, no step summary, no check run and no Kit comment: the Loop was dead for a day with nothing to say so. A minor that adds a permission is caught the same way.
- **Dependabot proposes no major.** `templates/dependabot.yml` ignores `version-update:semver-major` for the Kit, so a major arrives only through Setup, which rewrites the caller a major may change. Setup replaces the shim an earlier Setup wrote, unchanged, and notes what to add to an edited one.
- **Why a major:** a shim changed, the Dependabot config. The Loop runs as before on the old shim; what the old shim loses is only that the next major would still come as a bump PR, which the new check now fails rather than lets through. If the release holding this is a major for another reason, that covers it.

## Upgrading

In each Product repo, run Setup again, naming the new release (see [Adopting the Kit](../../README.md#adopting-the-kit)). Its plan replaces the Dependabot shim with the one that ignores a major. Or, in `.github/dependabot.yml`, add to the Fabrik entry:

```yaml
    ignore:
      - dependency-name: "jrey8343/fabrik*"
        update-types: ["version-update:semver-major"]
```

## To check it on the Pilot

1. Open a pull request on the Pilot that takes a line out of the caller's `tick` job's `permissions:` (`actions: read`, say). Check that its `loop / Kit` check fails, with an error and a step summary naming the `tick` job and the line, and that putting the line back turns it green. Close the PR.
2. On the next release's bump PR, check that `loop / Kit` is green before merging.
