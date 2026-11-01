# The Kit is referenced at one pinned Fabrik version, and skills are fetched at run time

A Product repo doesn't hold a copy of the Kit. It has one caller workflow, `.github/workflows/fabrik.yml`, whose `uses: jrey8343/fabrik/...@vX.Y.Z` lines pin a single Fabrik release. The Loop's workflows, prompts and scripts run from Fabrik at that tag, and each Fabrik release pins its upstreams in turn (Sandcastle, the Claude Code CLI and Matt Pocock's skills at a commit SHA).

Skills don't come in through the plugin system. They're fetched at that pinned version into a gitignored `.claude/skills/`. In Actions a Kit step does the fetch before `claude` starts. In cloud and local sessions a `SessionStart` hook does it, and the hook reads the version from `fabrik.yml`. The plugin route doesn't work: plugins a repo declares in `.claude/settings.json` are silently ignored by `claude -p` on a fresh runner, because no trust prompt appears there. claude.ai/code cloud sessions don't honour them at all. Server-managed settings would fix this, but they need a Team or Enterprise plan. Committing copies of the skills would work everywhere, but it vendors upstream, which Fabrik rules out.

## Considered options

- **Copy the Kit into each Product repo** (Sandcastle-style). Every update rewrites `.github/workflows/`, which the Fabrik App can't push. Local copies would also invite quiet edits that drift into a fork.
- **Moving major tag (`@v1`)**. Updates would land with no PR, but a bad release would break every Product repo at once, and you couldn't tell which version a run used.
- **Plugins declared in repo settings**, or **committed skill copies with a hash lockfile** (Warp, Kody). Both are rejected for the reasons above.

## Consequences

- Fabrik is a public repo, so cloud-session hooks can fetch it without credentials, and no cross-repo Actions access setting is needed.
- Kit updates are Dependabot `github-actions` PRs that bump `fabrik.yml`. The Operator merges them like any other PR. Reverting one PR rolls a release back.
- The other files the Kit owns in a Product repo are shims that never change between releases: the hook entry, the `.gitignore` lines and the Dependabot config. Only a major release re-runs the setup skill.
- Product repos disable the `mattpocock-skills` plugin at project scope, so local, Actions and cloud sessions all run the same pinned skills.
- It's undocumented whether a cloud `SessionStart` hook's skills load in that same session. If they don't, the fallback is `reloadSkills` or one manual `/reload-skills`.
