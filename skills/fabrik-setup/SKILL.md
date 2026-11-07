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
- `op` reaches the Operator's 1Password account, not a service account (no `OP_SERVICE_ACCOUNT_TOKEN` in the env):
  - If `op account list` shows more than one account, ask the Operator which one holds this Product's secrets, and set `OP_ACCOUNT=<its URL>` on every `op` and setup command from here on, the wizard included.
  - Check with `op vault list`, not `op whoami`. With the 1Password app's CLI integration, each of your shell commands is a new terminal-less session, so `op whoami` always says "account is not signed in"; `op vault list` asks the app to authorize, and succeeds when the app is unlocked. If it fails, ask the Operator to unlock the 1Password app and turn on Settings → Developer → Integrate with 1Password CLI. Never ask them to `eval $(op signin)`: that session lives only in their shell.
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

## 3. Ask the Operator's time zone and opt-in steps

Setup also sets up `fabrik-runs`, the private repo every Product repo shares for Run records and the Weekly summary (ADR-0009). It needs the Operator's time zone, because the Weekly summary is filed each Monday at 07:00 their time, and its week runs Monday to Monday there.

- If `fabrik-runs` already has its caller workflow, offer the time zone it holds as the default: `gh api repos/jrey8343/fabrik-runs/contents/.github/workflows/weekly-summary.yml --jq .content | base64 -d | grep timezone:`.
- Otherwise offer this machine's: `node -p 'Intl.DateTimeFormat().resolvedOptions().timeZone'`.

Ask the Operator to confirm it or give another IANA time zone name, such as `Europe/London`. If they'd rather not set up the store yet, leave `--time-zone` off both setup commands below: the Loop runs as before, and each run's step summary has one line saying no Run record was written.

Then ask whether they want a second Subscription: a second Claude account the Kit fails over to when the first reaches its weekly limit, so runs wait only once both are used up. If they do, add `--second-subscription` to both setup commands below. It's opt-in: without it setup says nothing about Subscriptions.

Then ask whether to install with Dispatch paused. Once the setup PR merges, Dispatch starts releasing every open `ready-for-agent` issue to an Implementer, up to the starter's `max_in_flight` at a time. First count them: `gh issue list --label ready-for-agent --state open --limit 1000 --json number --jq length` (a repo without the label has none). When there are any, tell the Operator how many before asking. If they want it paused, add `--paused` to both setup commands below: the starter Kit config is written with `max_in_flight: 0`, so no Implementer starts until they raise it. It changes only the starter: when `.fabrik/config.json` already exists, setup leaves it alone, and the plan's note gives its `max_in_flight` so the Operator can set it to `0` by hand.

Setup doesn't ask about Visual evidence. The starter Kit config has it off, and the Operator turns it on later with `/fabrik-visual-evidence` (see step 7).

## 4. Show the plan

```sh
node "$FABRIK/src/setup/main.ts" . <release> --time-zone=<their time zone> [--second-subscription] [--paused]
```

This only reads: the repo's files, its labels, its Actions secret names, its branch protection and rulesets, your 1Password vault names and the `Fabrik` vault's item names, and whether `fabrik-runs` exists, is private, and has its caller workflow, Dependabot entry and Actions secret. Show the Operator its output as it is, then explain anything they'd want to know before saying yes:

- **Files**: the caller workflow and the stable shims (`.claude/settings.json`'s `SessionStart` hook entry and plugin switch, the `.gitignore` lines, the Dependabot entry) are Kit-owned, and setup puts them back when they drift. The starter Kit config (`.fabrik/config.json`), `docs/agents/*` and the `## Agent skills` block are written once and are the Product's from then on.
- **Service accounts**: each is read-only, has no expiry, and its token goes straight into its Actions secret. 1Password shows a token only once, so a missing secret is repaired with a new account. When the plan replaces one, tell the Operator to delete the old account of the same name in 1Password afterwards (Developer → Service accounts).
- **Branch protection** replaces the default branch's current protection: a PR and the gating checks required, with no bypass allowance for anyone. It requires no approving review, on purpose: the Operator works alone and can't approve their own PRs, and a required review would only make them bypass protection on every PR they open.
- **The Merge gate ruleset** (`Fabrik Merge gate`) is what keeps the Fabrik App from merging: on the default branch, only its bypass actors may update the branch, merging a PR included, and its one bypass actor is the repo admin role. The Operator owns the repo, so they're its admin and can merge; the Fabrik App is never an admin, so it can push agent branches but never merge to the default branch. If GitHub's merge button offers to bypass the ruleset, that's this rule recognising the Operator as its bypass actor.
- **The `fabrik-runs` store** holds a Run record for every agent run in every Product repo: what ran, how it ended, the Verdict, the tokens and cost, and the run's gzipped transcript. Each Monday morning a workflow there files one Weekly summary issue covering the whole factory, which mentions the Operator once, and closes last week's. The plan creates it as a private repo when it's missing, because a transcript can hold whatever an agent echoed; it never makes a public one private, and leaves a note instead. It writes the store's caller workflow (the Weekly summary's schedule in the Operator's time zone, pinned to this release, and runnable by hand from its Actions tab) and its Dependabot entry, and creates a read-only service account for the `Fabrik App` vault, stored as the store's `FABRIK_OP_PUSH_TOKEN` secret. It's set up once and shared by every Product repo, so on a second Product repo the plan changes nothing there. Records start landing once the Fabrik App is installed on `fabrik-runs`, which is a wizard stage.
- **A second Subscription** starts with steps only the Operator can take, so the plan gives them as a note: the wizard's "A second Subscription" stage creates the second account's token with `claude setup-token`, saves it as the `Claude token 2` API Credential with its expiry date in the `Fabrik` vault, and checks usage credits are off on every account. Once that item exists, setup lists it in `subscriptions` in `.fabrik/config.json` itself, after `Claude token`: the plan shows it as a write of `.fabrik/config.json`. Here the wizard comes after the setup PR, so setup lists it the next time it runs (see step 7). It needs no new service account: the agent and implement accounts already read the `Fabrik` vault. Once the item exists and is listed, the plan says nothing more about it.
- **Dispatch paused**, when the Operator asked for it, shows as the starter Kit config's write saying Dispatch is paused. Without `--paused`, a repo with open `ready-for-agent` issues gets a note giving their count, since Dispatch starts on them as soon as the setup PR merges.
- **For the Operator** lines are things setup couldn't do itself. Pass each one on.

If the plan says there's nothing to do and has no notes, tell the Operator the install is complete, skip to step 6 if they haven't walked the wizard yet, and stop.

Ask the Operator to confirm before you go on.

## 5. Apply it and open the setup PR

1. Create a branch: `git switch -c fabrik/setup-<release>`.
2. Apply the plan, with the same time zone and opt-ins: `node "$FABRIK/src/setup/main.ts" . <release> --time-zone=<their time zone> [--second-subscription] [--paused] --apply`. If it fails partway, tell the Operator what it printed and run step 4 again: it plans only what's still missing. The store's files are committed straight to `fabrik-runs`, not in the setup PR.
3. If it wrote any files, commit them (`git add -A && git commit -m "Set up Fabrik <release>"`), push the branch and open a PR to the default branch with `gh pr create`. Its body lists what setup did, and the notes for the Operator.
4. Tell the Operator to merge that PR themselves, once its gating checks pass: no approving review is required, and as the repo's admin they're the Merge gate ruleset's one bypass actor. The Loop starts once the caller workflow is on the default branch.

## 6. Hand over the wizard

Some steps only the Operator can take: installing the Fabrik App on this repo and on `fabrik-runs`, with Checks: read accepted; storing the App's key, the `claude setup-token` token and, when the repo reports to Sentry, a Sentry token in 1Password; when they want one, a second Subscription's token, with usage credits off on every account; checking Visual evidence is on, when they want it; setting GitHub mobile to push only when it's their move, and watching the repo on All activity. The wizard walks them through each, and is safe to re-run.

It's interactive, so the Operator runs it in their own terminal, from this checkout:

```sh
bash "<the $FABRIK folder>/skills/fabrik-setup/wizard.sh"
```

Print the full path for them. Once the setup PR is merged, later sessions also have it at `.claude/skills/fabrik-setup/wizard.sh`.

## 7. Finish

Tell the Operator:

- What setup did, and each note it left for them.
- To list the CI checks that must pass in `sandbox.checks` in `.fabrik/config.json`, and the Sandbox's `setup`, `build` and `test` commands, then run `/fabrik-setup` again so branch protection requires those checks.
- When they asked for a second Subscription, that once the wizard has stored its token, running `/fabrik-setup` again with a yes to a second Subscription lists it in `subscriptions` in `.fabrik/config.json`. They don't edit the list by hand.
- That once the Fabrik App is on `fabrik-runs`, each agent run's push job writes its Run record there, and they can run the Weekly summary by hand from the Actions tab of `fabrik-runs` (Fabrik weekly summary, Run workflow) instead of waiting for Monday.
- That to give roles Extra skills from their own Skills sources, they pin each source by hand in `.fabrik/skills.lock.json` (`[{ "repository": "owner/name", "sha": "<full commit SHA>" }]`), pick skills under `roles.<role>.skills` in `.fabrik/config.json` (`"owner/name/skill"`, for triage, design, implement or review), and say when to use each in that phase's `.fabrik/<phase>.md`. The README's Extra skills section has the details; the Kit's weekly bump PRs keep the pins current after that.
- That the Monitor files an issue for Triage when the default branch goes red, once the Fabrik App's Checks: read is accepted, and for each production error Sentry reports, once `monitor.errors` in `.fabrik/config.json` names the provider, org and project (`{ "provider": "sentry", "org": "<org slug>", "project": "<project slug>" }`) and the wizard has stored the Sentry token. Until then each source stays dormant, with a quiet note in the hourly tick's step summary.
- That with Visual evidence on, each PR whose diff touches `ui.paths` gets an evidence section linking a gallery of its screenshots, and the Reviewer sees them. Once the setup PR is merged, they turn it on, or change its answers, by running `/fabrik-visual-evidence` in a Claude session in this repo. It suggests each answer from the repo and opens a PR with them.
- When they installed with Dispatch paused, that no Implementer starts until they set `max_in_flight` in `.fabrik/config.json` above `0`, once the tracker's `ready-for-agent` issues are ones they want built. A push to the default branch that changes it resumes Dispatch straight away.
- That re-running `/fabrik-setup` repairs the install (a missing label, secret or shim), and that Kit updates arrive as Dependabot PRs bumping `.github/workflows/fabrik.yml`.

Remove the temporary Fabrik folder once the Operator has finished the wizard.
