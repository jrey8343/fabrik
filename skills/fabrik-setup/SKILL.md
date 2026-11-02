---
name: fabrik-setup
description: Adopt the Fabrik Kit in a Product repo, or repair or migrate an install, then hand the Operator the wizard for the steps only they can take. Run as /fabrik-setup [release] from the Product repo's checkout.
disable-model-invocation: true
---

# Fabrik setup

The Operator is adopting the Fabrik Kit in this Product repo, repairing a broken install, or migrating it to a new major release. All three are the same run: the setup program plans only what the repo is missing, so on a working install it does nothing.

You run with the Operator's own `gh` and `op` sign-ins. Setup creates 1Password service accounts and vaults, sets Actions secrets and protects the default branch, so show the Operator the plan and get their go-ahead before you apply it.

## 1. Check where you are

Stop and tell the Operator what's missing if any of these fails:

- The working directory is the root of the Product repo's clone (`git rev-parse --show-toplevel`), on its default branch, up to date with `origin`, with a clean working tree (`git status --porcelain` prints nothing).
- `gh auth status` succeeds, as someone who administers this repo (`gh repo view --json viewerPermission --jq .viewerPermission` prints `ADMIN`), with the `workflow` scope so the caller workflow can be pushed.
- `op whoami` succeeds, signed in as the Operator, not as a service account (no `OP_SERVICE_ACCOUNT_TOKEN` in the env).
- `node --version` is 24 or later.

## 2. Pick the release

- If `$ARGUMENTS` names a release, use it. It must be an exact tag such as `v1.2.3`.
- Otherwise use Fabrik's latest release: `gh release view --repo jrey8343/fabrik --json tagName --jq .tagName`.
- To migrate a major release, the Operator names the new major's release. Setup never moves a caller workflow back to an earlier major, and within a major it leaves the pin to Dependabot.

Download Fabrik at that release into a temporary folder. Fabrik is public, so this needs no credentials:

```sh
FABRIK=$(mktemp -d)
curl -fsSL "https://codeload.github.com/jrey8343/fabrik/tar.gz/refs/tags/<release>" | tar -xzf - -C "$FABRIK" --strip-components=1
```

## 3. Show the plan

```sh
node "$FABRIK/src/setup/main.ts" . <release>
```

This only reads: the repo's files, its labels, its Actions secret names, its branch protection and rulesets, and your 1Password vault names. Show the Operator its output as it is, then explain anything they'd want to know before saying yes:

- **Files**: the caller workflow and the stable shims (`.claude/settings.json`'s `SessionStart` hook entry and plugin switch, the `.gitignore` lines, the Dependabot entry) are Kit-owned, and setup puts them back when they drift. The starter Kit config (`.fabrik/config.json`), `docs/agents/*` and the `## Agent skills` block are written once and are the Product's from then on.
- **Service accounts**: each is read-only, has no expiry, and its token goes straight into its Actions secret. 1Password shows a token only once, so a missing secret is repaired with a new account. When the plan replaces one, tell the Operator to delete the old account of the same name in 1Password afterwards (Developer → Service accounts).
- **Branch protection** replaces the default branch's current protection: a PR and the gating checks required, with no bypass allowance for anyone. It requires no approving review, on purpose: the Operator works alone and can't approve their own PRs, and a required review would only make them bypass protection on every PR they open.
- **The Merge gate ruleset** (`Fabrik Merge gate`) is what keeps the Fabrik App from merging: on the default branch, only its bypass actors may update the branch, merging a PR included, and its one bypass actor is the repo admin role. The Operator owns the repo, so they're its admin and can merge; the Fabrik App is never an admin, so it can push agent branches but never merge to the default branch. If GitHub's merge button offers to bypass the ruleset, that's this rule recognising the Operator as its bypass actor.
- **For the Operator** lines are things setup couldn't do itself. Pass each one on.

If the plan says there's nothing to do and has no notes, tell the Operator the install is complete, skip to step 5 if they haven't walked the wizard yet, and stop.

Ask the Operator to confirm before you go on.

## 4. Apply it and open the setup PR

1. Create a branch: `git switch -c fabrik/setup-<release>`.
2. Apply the plan: `node "$FABRIK/src/setup/main.ts" . <release> --apply`. If it fails partway, tell the Operator what it printed and run step 3 again: it plans only what's still missing.
3. If it wrote any files, commit them (`git add -A && git commit -m "Set up Fabrik <release>"`), push the branch and open a PR to the default branch with `gh pr create`. Its body lists what setup did, and the notes for the Operator.
4. Tell the Operator to merge that PR themselves, once its gating checks pass: no approving review is required, and as the repo's admin they're the Merge gate ruleset's one bypass actor. The Loop starts once the caller workflow is on the default branch.

## 5. Hand over the wizard

Some steps only the Operator can take: installing the Fabrik App on this repo, storing the App's key and the `claude setup-token` token in 1Password, setting GitHub mobile to push only when it's their move, and watching the repo on All activity. The wizard walks them through each, and is safe to re-run.

It's interactive, so the Operator runs it in their own terminal, from this checkout:

```sh
bash "<the $FABRIK folder>/skills/fabrik-setup/wizard.sh"
```

Print the full path for them. Once the setup PR is merged, later sessions also have it at `.claude/skills/fabrik-setup/wizard.sh`.

## 6. Finish

Tell the Operator:

- What setup did, and each note it left for them.
- To list the CI checks that must pass in `sandbox.checks` in `.fabrik/config.json`, and the Sandbox's `setup`, `build` and `test` commands, then run `/fabrik-setup` again so branch protection requires those checks.
- That re-running `/fabrik-setup` repairs the install (a missing label, secret or shim), and that Kit updates arrive as Dependabot PRs bumping `.github/workflows/fabrik.yml`.

Remove the temporary Fabrik folder once the Operator has finished the wizard.
