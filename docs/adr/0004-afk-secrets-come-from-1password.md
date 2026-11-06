# AFK secrets come from 1Password, with one service account per job role

Every secret an AFK job needs comes from 1Password at run time, not from repo Actions secrets. That covers the shared `CLAUDE_CODE_OAUTH_TOKEN`, each Product repo's test secrets and the Fabrik App key. The **job is the security boundary, not the step**. GitHub-hosted runners give passwordless `sudo`, so an agent can read every secret its job references out of the runner's worker process memory (that's how the March 2025 `tj-actions/changed-files` compromise stole secrets). So jobs are split by which **read-only service account** they reference. Each Product repo holds three, as Actions secrets:

| Service account | Reads vault | Referenced by |
|---|---|---|
| agent | `Fabrik` (the Claude token) | Triage, Dispatch, Review, the judge |
| implement | `Fabrik` + `Fabrik Sandbox · <product>` (that repo's test secrets) | Implement, and a Design session's prototype turn, which builds and serves the Product too |
| push | `Fabrik App` (App ID + private key, and the `Sentry token`) | the push jobs (ADR-0002), the score-record job among them (ADR-0009), and the Monitor |

Even an agent that dumps memory reaches only the token it already has and, in Implement or a prototype turn, its own repo's test secrets. The Scorers' judge job (#149) is an agent job of this kind: beside the Claude token its job holds only the read-only `github.token` it reads the Ticket with, and no write credential (ADR-0002), so that is all a judge that dumps memory reaches. Kit config in `.fabrik/` lists test secrets as `op://` references. A Kit step resolves them with the service-account token in that step's env only, using `load-secrets-action` in output mode and never `configure`. The agent step then gets just the resolved values.

## Considered options

- **Repo Actions secrets, filtered by a `FABRIK_SANDBOX_` prefix using `toJSON(secrets)`.** Reading `toJSON(secrets)` references every repo secret, the App key included, so the agent job would hold a write credential and break ADR-0002. Passing named secrets explicitly instead means editing `fabrik.yml` for every new test secret. That file is meant never to change between releases, and the App can't push it. Rotating a shared credential would also mean running `gh secret set` once per Product repo.
- **1Password as the source, with a wizard syncing values into Actions secrets.** This removes the runtime dependency, but it still needs explicit secret names to avoid the leak, and the values drift whenever someone forgets to re-sync.
- **One service account per repo.** It's simpler to set up, but any agent job could then read the App key.
- **1Password's OIDC Credential Broker.** It's in preview, documented only for GitHub organizations, and still stores a long-lived integration key.

## Consequences

- 1Password is a hard dependency of every run. It has no SLA, and the action neither retries nor caches. A failed load is an infrastructure failure, not an Execution flaw, so it doesn't use up the Ticket's retries. The one optional load is the Monitor's `Sentry token`, which can't fail its job: production errors are opt-in, so a missing or unreadable token is a quiet dormant note in the step summary, never a failure.
- Service-account permissions can't be changed after creation. The Fabrik setup skill creates the three accounts per repo with `op service-account create`, with no expiry, and stores them with `gh secret set`. 1Password's limit of 100 accounts caps Fabrik at about 33 Product repos.
- Rotating the Claude token is one edit to a 1Password item, and every repo picks it up on its next run. The token is stored as an API Credential with its expiry date, so Watchtower warns three months ahead. That warning only shows inside the app; the backstop is a run failing loudly with `authentication_failed`.
