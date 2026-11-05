# Product repos pin Extra skills per role, and the Base skills stay with the Kit

This amends ADR-0003. Fabrik's `skills.lock.json` keeps pinning the Base skills, which are Matt Pocock's skills from one Skills source, and they move only with a Kit release. A Product repo that needs more pins its own Skills sources in `.fabrik/skills.lock.json`, a list of `{repository, sha}`. It gives Extra skills from those sources to roles one at a time in `.fabrik/config.json`, as `roles.<role>.skills`. Only triage, design, implement and review take picks. Each AFK run installs the Base skills plus only its own role's Extra skills, and its prompt gets one fixed line naming them. The phase instruction files say when to use them. A local or Pairing session installs every pick, because the Operator is at the wheel. Sources must be public. A pick that names an unpinned source is a Kit config error, and so is a pinned source no role picks from, or a skill whose name collides with a Base skill, a Kit skill or another Extra skill.

We chose this because gradually-core needs event storming and Deciders from `jrey8343/skills`, and the Pilot needs neither. Claude chooses skills by their description, so a skill that is installed can fire in any role. Installing per role keeps an Implementer from storming events because a Spec mentioned a domain event. Pinning per Product repo means a fix to the Operator's own skills reaches the repos that use it without a Fabrik release.

## Considered options

- **Make Fabrik's lock a list of every source.** It has one lockfile and one bump. But every Product repo would get every source, and bumping the Operator's skills would need a Kit release.
- **Install every Extra skill for every run, and only name the picks in the prompt.** This is simpler to fetch, but off-domain skills stay one description match away in every role.
- **Let an Extra skill override a Base skill of the same name.** That would allow local variants. But the prompts open Base skills by path, such as `.claude/skills/triage/SKILL.md`, so an override would quietly change how the Kit behaves.

## Consequences

- Picks and pins are split like a manifest and its lockfile. The Operator writes picks by hand and adds a source's first pin by hand or through `/fabrik-setup`. After that, the bump rewrites the pins.
- The Product repo's weekly bump runs from the Kit's schedule and pushes with the Fabrik App token. It opens one PR per source on a fixed branch, `fabrik/skills-bump/<owner>-<name>`. Its body shows only the diff under the picked skills' folders, lists other changes upstream in one line, and flags a picked skill removed upstream as breaking. A week in which no picked skill changed opens no PR.
- No guard changes: `.fabrik/` and `.claude/skills/` are already trust-root files (ADR-0005), so agents can't change either the pins or the installed skills.
- A private Skills source would need a credential and a second vault item (ADR-0004). It waits until a real one turns up.
