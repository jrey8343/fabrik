# The Kit is referenced at one pinned Fabrik version, and skills are fetched at run time

A Product repo doesn't hold a copy of the Kit. It has one caller workflow, `.github/workflows/fabrik.yml`, whose `uses: jrey8343/fabrik/...@vX.Y.Z` lines pin a single Fabrik release. The Loop's workflows, prompts and scripts run from Fabrik at that tag, and each Fabrik release pins its upstreams in turn (Sandcastle, the Claude Code CLI and Matt Pocock's skills at a commit SHA).

Skills don't come in through the plugin system. They're fetched at that pinned version into a gitignored `.claude/skills/`. In Actions a Kit step does the fetch before `claude` starts. In cloud and local sessions a `SessionStart` hook does it, and the hook reads the version from `fabrik.yml`. The plugin route doesn't work: plugins a repo declares in `.claude/settings.json` are silently ignored by `claude -p` on a fresh runner, because no trust prompt appears there. claude.ai/code cloud sessions don't honour them at all. Server-managed settings would fix this, but they need a Team or Enterprise plan. Committing copies of the skills would work everywhere, but it vendors upstream, which Fabrik rules out.

## Considered options

- **Copy the Kit into each Product repo** (Sandcastle-style). Every update rewrites `.github/workflows/`, which the Fabrik App can't push. Local copies would also invite quiet edits that drift into a fork.
- **Moving major tag (`@v1`)**. Updates would land with no PR, but a bad release would break every Product repo at once, and you couldn't tell which version a run used.
- **Plugins declared in repo settings**, or **committed skill copies with a hash lockfile** (Warp, Kody). Both are rejected for the reasons above.

## Consequences

- Fabrik is a public repo, so cloud-session hooks can fetch it without credentials, and no cross-repo Actions access setting is needed.
- Kit updates within a major are Dependabot `github-actions` PRs that bump `fabrik.yml`. The Operator merges them like any other PR. Reverting one PR rolls a release back.
- A major arrives only through Setup, never as a bump: the Dependabot shim ignores `version-update:semver-major` for the Kit. A major may change the caller workflow's shape, such as a job's `permissions:`, which a bump can't carry, and a caller that grants a called job less than it asks fails every run at startup, whatever the event, with nothing to say why (#422). Setup at the new major rewrites the caller.
- The other files the Kit owns in a Product repo are shims that change only with a major: the hook entry, the `.gitignore` lines and the Dependabot config. Only a major release re-runs Setup.
- Product repos disable the `mattpocock-skills` plugin at project scope, so local, Actions and cloud sessions all run the same pinned skills.
- It's undocumented whether a cloud `SessionStart` hook's skills load in that same session. If they don't, the fallback is `reloadSkills` or one manual `/reload-skills`.

## Addendum: a Replay's candidate Kit sha lays prompts and Base skills over the pinned release

A Replay whose variable is a candidate Kit sha refines "the Loop's workflows, prompts and scripts run from Fabrik at that tag" for its variant arm alone. That arm's jobs still check out the Kit at the pinned release, and then lay exactly two things over the checkout from the candidate commit: the role prompts, `prompts/<role>.md`, and the Base skills lock, `skills.lock.json`, so the agents read the candidate's prompts and fetch its Base skills. Everything else stays the pinned release's: the workflows and composite actions, the Kit's programs, the Scorers' rubrics under `prompts/scorers/`, and Fabrik's own skills. The candidate must be a commit on a branch of `jrey8343/fabrik`, read with the job's read-only token, so no prompt comes from anywhere else, and the arm's Run record still names the pinned release as its `kitSha`, beside the candidate in its `replay` field.

This refines the decision rather than contradicting it. A Product repo still pins one Fabrik release, and that release alone decides what runs, with which credentials and under which rubrics. The candidate changes only the text an agent reads, only in an experiment the Operator files on their own replay issue, and never in a live run. Testing a prompt or Base-skill change before it merges, such as a Retro proposal, needs nothing more, and laying the candidate's workflows or programs too would let an unmerged commit change what an AFK job does with its credentials. Decided in [Spec: Replay](https://github.com/jrey8343/fabrik/issues/156).

## Addendum: a pull request that changes the caller is checked against the release it pins

A pull request that changes `.github/workflows/fabrik.yml`, a Dependabot bump of its pin or an Operator's edit, starts the Loop's `pull_request_target` run with the base branch's Kit. That run's Kit job reads the caller the PR proposes, at the PR's head, and the reusable workflows at the release it pins, and compares each caller job's `permissions:` with what the jobs of the workflow it calls ask for. A job granting less than a called job asks, or a line it lacks, fails the PR's `loop / Kit` check, naming the caller's job and the line to add. The run reads both as data, with the job's read-only token; the PR's code never runs. So a release that asks a caller job for a new permission, a minor that adds one too, is seen on the bump PR, before the merge, where before it was seen as a grey run list once every run had started failing (#422). The Kit's own CI makes the same comparison between the caller templates it ships and the workflows it holds, so a Kit change that asks for more than the template grants fails before it's released.
