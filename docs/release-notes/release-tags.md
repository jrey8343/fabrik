# Release notes: Release tags and Setup's bootstrap

These are the notes for this part of the major that carries the Kit's Operator sessions ([Spec: Release tags and Setup's bootstrap: `setup.sh` fetched at the release it runs, and the releasing guide that reads the tag hold before it uses it](https://github.com/jrey8343/fabrik/issues/916)): Setup's command fetches `setup.sh` at the release it runs, never from `main`, and a release tag in `fabrik` is made only with the Operator's release key and is never moved or deleted. Each of the major's five parts has its own notes. Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- **Setup's command fetches `setup.sh` at the release it runs, never from `main`** ([#936](https://github.com/jrey8343/fabrik/issues/936)). The README and `setup.sh`'s header give it in two forms. For Fabrik's latest release, the first line asks `gh` for the latest release's tag, and the second fetches `setup.sh` at that tag and names the release to it:

  ```sh
  v=$(gh release view --repo jrey8343/fabrik --json tagName --jq .tagName) &&
    curl -fsSL "https://raw.githubusercontent.com/jrey8343/fabrik/$v/setup.sh" | bash -s -- "$v"
  ```

  For a release named, as an exact tag, it is named in both places, in the URL and after the `--`:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/<release>/setup.sh | bash -s -- <release>
  ```

  Every command Setup prints names its release in both places too: its closing lines, the setup PR's body, its plan's notes and its usage line, which names `<release>`. `setup.sh` itself does what it did: it still takes the release first or as `--release=`, still asks `gh` for the latest when none is named, still refuses a tag that isn't exact, and Setup's flags still go after the release. A test fails when anything the Kit ships fetches `setup.sh` at a ref that is no release, such as a branch.
- **A release tag in `fabrik` is made only with the Operator's release key, and none is ever moved or deleted** ([#937](https://github.com/jrey8343/fabrik/issues/937)). Two tag rulesets cover every tag: one refuses moving and deleting, and nobody may bypass it; the other refuses creating, and only a deploy key, the release key, may bypass it. Immutable releases is on. A release from this major on is immutable once published: its tag can't be moved or deleted by anyone and its name can't be used again. Every earlier release is held by the rulesets alone, since immutable releases covers none of them. The hold was put on by hand ([Operator step: put the hold on `fabrik`'s release tags](https://github.com/jrey8343/fabrik/issues/866)).
- **The releasing guide reads the hold before every release** ([#937](https://github.com/jrey8343/fabrik/issues/937)). Step 1 reads the two tag rulesets, the immutable releases setting and the count of deploy keys, and stops if any is off. Step 2 reads what `main` gained since the last tag as what the release ships, so a commit you don't recognise stops the release until you know where it came from. Step 3 pushes the tag with the release key through its host alias, `git@fabrik-release:jrey8343/fabrik.git`, which 1Password asks you to approve. The guide's one-time settings hold the two rulesets, immutable releases, the release key and its host alias, with the commands that put them there, how to replace a lost key, and the way past when the key can't be used.

## Why

A release tag reaches every Product repo's runs on its default branch, so cutting one is the factory's production deploy, and a cloud session could reach both routes to it with no merge anywhere. A session can't make, move or delete a tag itself, but it can push a branch whose workflow does, with the run's own token: on a throwaway repo such a run made a tag, moved one and published a release in fourteen seconds. And Setup's command piped `setup.sh` from `main` into bash in the Operator's terminal, beside the Operator's whole `gh` token, while `main` stays open to a session.

## Upgrading

- **A Product repo needs nothing for this part** beyond the major's own Setup run, whose command is the new one.
- **Drop any saved Setup command that fetches `setup.sh` from `main`,** from a shell's history say. It still works, since `setup.sh` stays on `main`, where each tag is cut from, and it is the route this part closes.

## What the Console needs

- **Only its pin moved, for this part.** This part changes nothing the read library exports. This line is a guess until the release is checked against the Console (step 4 of [releasing.md](../releasing.md)), and that run's answer replaces it. Beside it, the Console's Operator-steps wizard, `tools/operator-steps.sh`, prints Setup's command from `main`, which is the Console's to change.

## Why no major of its own

This part changes no shim, no Kit config key, no label, no permission and nothing the read library exports, so by itself it would need no major. It rides the one major that carries the Kit's five Operator sessions Specs ([How are the Specs cut, and who builds them?](https://github.com/jrey8343/fabrik/issues/874)), and a Product repo takes it with that major's Setup run, which it makes anyway. Nothing is dormant, so there is no section to turn it on.

## Known limits

- **Releases before `v1.0.0` have no `setup.sh` at their tag,** so the named form fails for one with curl's 404. Setup did not exist then.
- **The latest form stops at `gh`'s own words when `gh` is signed out,** before `setup.sh` runs, where the old form reached `setup.sh`'s message.
