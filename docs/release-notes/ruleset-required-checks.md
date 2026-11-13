# Release notes: Required checks a ruleset adds count

The notes for the minor release that counts a check an active ruleset requires on the default branch as a Required check ([#694](https://github.com/jrey8343/fabrik/issues/694)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

A check an active ruleset requires on the default branch is now a Required check to the Review and to the Required checks read, as it already was to GitHub's merge.

## What changed

- **The branch's Required checks include its rulesets'.** The default branch's own list is now its protection's Required checks, then each check a `required_status_checks` rule of an active ruleset adds, each name once. Repository and organization rulesets both count. A ruleset in `evaluate` or `disabled` doesn't, since GitHub doesn't enforce it. Before, only branch protection's list was read, so a check only a ruleset required was missed.
- **Where it shows.** The Review now waits on such a check and fails on it like any other Required check. The Required checks read judges it on each head, so a head with it red, running or never reported no longer reads as all passed. The hourly tick's Flaky check report at the Merge gate counts it too, since it reads the same list.
- **Matched by name.** A rule that names the app a check must come from is matched by the check's name alone, as branch protection's list is.
- **Rules that can't be read fail the read.** The Review's wait then gives up with the unread-checks notice, and the Required checks read leaves every head unread. Neither falls back to branch protection's list alone.
- **Whether the branch holds admins to its rules is unchanged.** It's still decided from branch protection alone, as the rules endpoint doesn't say who may bypass a rule.
- **No permission changes.** The rules are read with `GET /repos/{owner}/{repo}/rules/branches/{branch}`, which needs only Metadata: read, less than the branch read already needs. Neither the Review checks job's permissions nor any reader's credential changes.
- **Why a minor:** a Review can now wait on, or fail on, a check it didn't before, but a Product repo needs nothing beyond the bump. Neither Product repo had a ruleset requiring a check at triage, so nothing changes for them today.

## Not covered

Setup still writes only branch protection's Required checks and never copies a ruleset's into it. A ruleset's bypass list and its "require branches to be up to date" policy aren't read. The Weekly summary's narrower checks read still reads the Kit config's list.
