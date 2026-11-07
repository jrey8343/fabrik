# Setup runs in the Operator's terminal, not in an agent session

Setup was a skill, `/fabrik-setup`, that a local Claude session ran with the Operator's `gh` and `op` sign-ins. On the second Product repo (gradually-core#207) that got in the way at every step. The skill can't exist in a repo before the Kit lands, so the Operator had to copy it into `~/.claude/skills/` by hand, where it then went stale. A session that limits 1Password to one vault with `OP_SERVICE_ACCOUNT_TOKEN` is exactly the kind setup can't run in. Auto mode can refuse `op` calls partway through. Long paths got pasted between the session and a terminal. Apart from suggesting Visual evidence answers, everything the skill did was fixed steps.

So Setup is a program the Operator runs in their own terminal, with no agent taking part. One command, a small bootstrap script on Fabrik's `main` branch, downloads the chosen release (the latest by default) into a temporary folder and runs that release's setup program. That program does the checks, asks its questions (each also a flag), shows the plan, applies it on the Operator's yes, runs the wizard, and opens the setup PR. It asks for the merge only once the App is installed, its key stored and the Claude token stored. Running it again repairs an install or migrates it to a new major release. The `/fabrik-setup` skill is removed. Visual evidence, the one step that needs judgment, moves to its own skill, `/fabrik-visual-evidence`, which runs in a session once the Kit is in the repo and writes its answers through a Kit program.

## Considered options

- **Keep the skill and add a bootstrap that makes it available.** This fixes the first step only. The 1Password limit, auto-mode refusals and pasted paths stay, for no gain, since the agent's only judgment call is Visual evidence.
- **A Claude Code plugin that gives every repo `/fabrik-setup`.** No copying, but it's still agent-led, and it needs its own way to pin the release beside the caller workflow's (ADR-0003).
- **An npm package (`npx`).** Every release would need an npm publish step, and running the repo itself with `npx github:` installs the whole Kit's runtime dependencies just to run setup.

## Consequences

- Nothing about setup lives on the Operator's machine between runs, so there's no copy to go stale. The program offers to delete an old `~/.claude/skills/fabrik-setup/`, and the `SessionStart` hook warns while one exists.
- The release pin works as before: the bootstrap only fetches, and everything that acts runs from the chosen release.
- Before planning, the plan names the 1Password account it uses. One 1Password account per Product is a normal setup, with its own App key, Claude token and rotation.
- The wizard runs before the setup PR merges, so the Kit's first runs have their App and token, and setup can list a second Subscription in the same PR.
