# The push job refuses agent changes to trust-root files

Agents never change the files that steer agents. If an Implementer's commits touch a trust-root file, the push job (ADR-0002) refuses the branch, just as GitHub already refuses `.github/workflows/` because the App has no `workflows` permission. Trust-root files are AGENTS.md, CLAUDE.md, any `.claude/settings*` file, skills, the Kit's prompts, the Product repo's `.fabrik/` Kit config and phase files, and anything under `docs/product/` at the repo root, where its Vision and Roadmap live. A Ticket that really needs one of these edits goes to `ready-for-human`. We chose a hard refusal because the threat is a slow one: a prompt-injected or confused agent quietly weakens the review prompt or a hook, and the Operator merges it on a tired evening. From then on every later run is compromised, and the Merge gate is the only thing standing in the way. The check is a path check in a job that never runs Product code, so the agent can't get around it. It also matches Fast-path test 5, which keeps the same files away from Triage's Fast path.

## Considered options

- **Allow the change, but label the PR and give the Reviewer a hostile-review pass.** Agents could keep AGENTS.md and the prompts up to date. But the Reviewer is itself steered by a trust-root file, and a pass from it adds little against a change written to fool it.
- **Rely on the Merge gate alone.** This adds no mechanism, but it leans on the Operator spotting a one-line prompt change in a large diff.

## Consequences

- A Pairing session counts as the Operator, not as an agent: the Operator is beside it at every step, it runs on their own credentials, and its file changes go out in a pull request that only the Operator merges. So it may change trust-root files. The push job never sees its branch.
- An Implementer run that ends with an empty diff is an Execution flaw, never a pass. A path guard can't pass by default on a diff that has nothing in it.
- Pilot groundwork that wires a new check into CI edits `.github/workflows/`. That edit is always a `ready-for-human` Ticket, even when an agent writes the code the check runs.
- The guard covers only what reaches `main`. Within a single run, an agent with `sudo` can still edit `.claude/settings*` and Claude Code reloads it. That stays contained by the job boundary (ADR-0004), not by this guard.
