# Releasing Fabrik

The Operator cuts every Fabrik release by hand. A Product repo pins one release in its caller workflow (ADR-0003), and each release pins everything under it, so a release tag is the whole version of the Kit a run used.

## What a release pins

| Upstream | Where it's pinned | What bumps it |
|---|---|---|
| Sandcastle (`@ai-hero/sandcastle`) | exact version in `package.json` and `package-lock.json` | Dependabot (npm), weekly |
| The Claude Code CLI (`@anthropic-ai/claude-code`) | exact version in `package.json` and `package-lock.json` | Dependabot (npm), weekly |
| Playwright (`playwright-core`), which UI evidence capture drives | exact version in `package.json` and `package-lock.json`; its Chromium is installed at capture time | Dependabot (npm), weekly |
| Matt Pocock's skills (`mattpocock/skills`) | commit SHA in `skills.lock.json` | `.github/workflows/skills-bump.yml`, weekly |
| The actions the workflows use | commit SHA in each `uses:` line | Dependabot (github-actions), weekly |

`src/release/pins.test.ts` fails CI if Sandcastle, the Claude Code CLI or Playwright isn't pinned at one exact version, or if the CLI's install-script approval in `allowScripts` names a version, which a Dependabot bump would leave behind.

Fabrik consumes the skills and Sandcastle unchanged. If an upstream change misbehaves in the Loop, steer around it with the Kit's prompts or config, hold the bump, or report it upstream. Never patch or fork upstream code into Fabrik.

## Taking upstream bumps

Upstream bumps land on `main` as ordinary PRs and ship in the next release.

- **Dependabot PRs** (Sandcastle, the Claude Code CLI, Playwright, actions): read the upstream changelog, check CI passes, and merge. For a Claude Code CLI bump, look for changes to auth, `apiKeySource`, the `system/init` message or the metered-route env vars, because the metered-billing preflight and the init check depend on them.
- **The skills bump PR** (`fabrik/skills-bump`, titled "Bump Matt Pocock's skills to …"): it opens only when upstream main has moved past the pinned commit. Its body has the compare link, the commits, any skills added or removed, and the upstream diff. Read the diff the way you'd read a change to the Kit's prompts, since that's what it is. Its CI run is started by `workflow_dispatch`, so it shows under the branch's commit. The PR is refreshed in place each week while it's open. Closing it unmerged declines that commit; the next PR opens once upstream moves again. Run the workflow by hand from the Actions tab to check sooner.

## Choosing the version

Fabrik uses semver, counted from what a Product repo has to do:

- **Patch** (`v1.2.3` to `v1.2.4`): fixes and upstream bumps that keep the Loop's behaviour. Merging the Dependabot bump PR is all a Product repo does.
- **Minor** (`v1.2.4` to `v1.3.0`): new behaviour or new Kit config fields. Every new field has a default, so a Product repo still only merges the bump PR, with no Kit config edit. A new Operator setup step keeps the release a minor when it's opt-in: the feature stays dormant until the step is done, the runs note the missing step quietly in the step summary and never fail on it, and the notes' **To turn it on** section names the step ([#139](https://github.com/jrey8343/fabrik/issues/139)).
- **Major** (`v1.3.0` to `v2.0.0`): anything that needs a change in the Product repo beyond the bump: a changed shim (the caller workflow's shape, the session hook entry, the `.gitignore` lines or the Dependabot config), a renamed or removed Kit config field, or a new Operator setup step, such as a new secret or App permission, that the Loop can't run without. Each Product repo migrates by running Setup again, naming the new release (see [Adopting the Kit](../README.md#adopting-the-kit)).

## Cutting a release

1. Make sure `main` is green in CI and holds every bump you want in this release.
2. List what changed since the last release, and pick the version as above:

   ```sh
   git fetch --tags origin
   git log --oneline "$(git describe --tags --abbrev=0 origin/main)..origin/main"
   ```

3. Tag the `main` commit with an exact, annotated tag. Never move or reuse a tag, and never publish a moving major tag such as `v1`: Product repos pin exact tags, and Dependabot proposes each new one.

   ```sh
   git tag -a v1.3.0 -m "Fabrik v1.3.0" origin/main
   git push origin v1.3.0
   ```

4. Publish the GitHub release with notes that say what changed, whether a Product repo needs anything beyond the bump (only for a major), and the pins it carries. A release whose new behaviour waits on an opt-in Operator step gets a **To turn it on** section saying which step turns it on, in which repos, and to turn it on for the Pilot first. Notes drafted ahead of a release are in `docs/release-notes/`, such as [the Run records minor's](release-notes/run-records.md), [the Scorers minor's](release-notes/scorers.md), [the Monitor minor's](release-notes/monitor.md), [the Subscription rotation minor's](release-notes/subscription-rotation.md), [the Product intent minor's](release-notes/product-intent.md), [the Retro minor's](release-notes/retro.md), [the Visual evidence minor's](release-notes/visual-evidence.md), [the Ideas and Maps minor's](release-notes/ideas-and-maps.md), [the UI prototypes minor's](release-notes/ui-prototypes.md), [the Replay minor's](release-notes/replay.md), [the Visual evidence sign-in minor's](release-notes/visual-evidence-sign-in.md) and [the Undelivered Request changes minor's](release-notes/undelivered-request-changes.md), which says what to check in each Product repo before merging its bump.

   ```sh
   jq -r '"- Sandcastle \(.dependencies["@ai-hero/sandcastle"])\n- Claude Code CLI \(.dependencies["@anthropic-ai/claude-code"])\n- Playwright \(.dependencies["playwright-core"])"' package.json
   jq -r '"- Matt Pocock'"'"'s skills at \(.repository)@\(.sha)"' skills.lock.json
   gh release create v1.3.0 --verify-tag --title "Fabrik v1.3.0" --notes-file notes.md
   ```

## Validating on the Pilot

The Pilot is the canary. A release goes to other Product repos only after it has run there.

1. The Pilot's Dependabot config (the Product repo shim) watches `jrey8343/fabrik*` with no cooldown, so it opens a bump PR for the new tag within a day. To get it sooner, use "Check for updates" on the Pilot's Dependabot page.
2. Check the bump PR changes only the `uses:` refs in `.github/workflows/fabrik.yml`, all to the same tag. The Kit fails any run where they disagree.
3. Merge the bump PR. The Loop's events (`issues`, `issue_comment`, `schedule`) run from the default branch, so the new release takes effect only after the merge. Runs on the bump PR itself see only Dependabot secrets and say little about the release.
4. Exercise the release on a real issue: open one in the Pilot (or relabel one `needs-triage`) and walk it as far through the Loop as this release changed. The Kit job's "Peel the Kit's pinned commit" step logs the tag and commit the run used, and each agent job's step summary shows the model and whether the pinned skills loaded. A draft PR nobody merges is harmless.
5. If something is wrong, revert the bump PR in the Pilot. That returns it to the previous release with no other repair. Fix the problem on `main` and cut a patch release, which arrives as a new bump PR.
6. Once the Pilot is healthy on the release, merge the same bump PR in the other Product repos.

## One-time repository settings

- Settings, Actions, General: allow GitHub Actions to create and approve pull requests, so the skills bump can open its PR.
- Dependabot version updates are on (`.github/dependabot.yml` turns them on once it's on `main`).
