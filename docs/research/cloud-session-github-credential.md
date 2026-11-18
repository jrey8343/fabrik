# What can a cloud session's GitHub credential do, and can a session be given more?

Research for [#798](https://github.com/jrey8343/fabrik/issues/798), a Decision on the map [#796](https://github.com/jrey8343/fabrik/issues/796). Date: 2026-11-19.

**Question.** By default, which identity do pushes and API calls from a cloud session carry and what do they reach? How can the Operator give a session a stronger credential, can the agent read it, and what limits where it goes? How narrowly and how briefly does GitHub let a credential be cut?

**Method.** Desk research only, nothing tried. I read Claude Code's docs at code.claude.com (raw `.md` pages fetched 2026-11-19), GitHub's docs at docs.github.com (fetched the same day), the `gh` manual at cli.github.com, and the Claude GitHub App's public record from GitHub's API (`GET /apps/claude`, last updated 2026-11-16). No repo setting, secret, ruleset or token was read or changed. Anything marked **inferred** is my reasoning from those sources, not a statement in them. "Docs silent" means I looked and found nothing.

**How to read the "inferred" cells.** Anthropic documents the GitHub proxy's limits (attached repos only, no GraphQL, no branch deletion, no tag push) and says "`gh api` calls for attached repositories work". It does not list which REST endpoints pass, and does not say that all do. GitHub documents which permission each endpoint needs. The Claude GitHub App's permission set is published. Putting the three together gives most of the first table, so most of its cells are inferred, and one trial in a real session would settle them.

## Answer

- **A cloud session acts as the Operator, with a credential the agent cannot read.** The Operator's GitHub token stays on Anthropic's servers. A proxy attaches it to git and REST traffic for the repositories attached to the session, and to nothing else.
- **What that credential can do depends on how GitHub was connected, and the connection is one per claude.ai account.** Connected in the browser, it is bounded by the Claude GitHub App's permission set: it can push, open pull requests, write workflow files and labels, and read settings, but it holds no Administration write, Secrets, Variables or Environments permission. Connected with `/web-setup`, it is the Operator's `gh` token with the classic `repo` scope, which GitHub lets do nearly everything the Operator can on a repo.
- **The proxy blocks GraphQL for every credential.** `gh pr` and `gh issue` fail in a cloud session, whichever token backs `gh`. `gh api` and the REST-based subcommands work. `/fabrik-pair` calls `gh issue view`, `gh issue edit`, `gh issue close`, `gh pr list` and `gh pr view`.
- **There is one way to hand a session a different GitHub credential: an environment variable.** `GH_TOKEN` or `GITHUB_TOKEN` set on the cloud environment "passes through to the container unchanged". The agent can read it. A network secret, the mechanism that keeps a key outside the VM, is never attached to GitHub requests.
- **Environment variables and network secrets belong to a cloud environment, not to a session.** Every session in the environment gets them. An edit to a variable reaches a running session only when its VM is next restored or rebuilt.
- **GitHub will mint a token for one repo and a few permissions for an hour: an installation access token.** It is minted by the App itself, with its private key, and it acts as the App, not as the Operator. A user access token can also be cut down to chosen repos and permissions, by the App's client ID and secret, and acts as the Operator; it lives eight hours at most. A fine-grained personal access token is cut by hand in GitHub's settings and lives a day at least.
- **Neither App-minted token can exceed the App's registered permissions.** The Console's App holds no Workflows, Administration or Secrets permission and has no private key ([#517](https://github.com/jrey8343/fabrik/issues/517)).

## Table 1: what a session reaches by default

"Browser" is GitHub connected at claude.ai/code by authorizing the Claude GitHub App. "`/web-setup`" is the Operator's `gh` token sent from a terminal. The last column is GitHub's requirement for the REST call, the same for a GitHub App token and a fine-grained personal access token.

| Operation | Browser connection (Claude GitHub App) | `/web-setup` connection (`gh` token) | Permission GitHub requires |
| :- | :- | :- | :- |
| Identity of pushes and API calls | The Operator's GitHub user (documented) | The Operator's GitHub user (documented) | n/a |
| Clone and fetch | Yes: any public repo, and private repos the App is installed on (documented) | Yes: any repo the token can access (documented) | Contents read |
| Push a branch | Yes (documented). The proxy refuses branch deletion and any push that isn't a branch, such as a tag. It does not limit which branch. Rulesets apply as they apply to the Operator, bypasses included (documented) | Same | Contents write |
| Open a pull request | Yes: the Create PR button, and Claude opens them itself (documented). Which call Claude uses is not stated. `gh pr create` is refused, since `gh pr` uses GraphQL (documented) | Same | Pull requests write |
| Merge a pull request | Yes by REST, subject to rulesets as the Operator (**inferred**: the App holds Contents write) | Yes (**inferred**: `repo` scope) | Contents write |
| Write under `.github/workflows/` | Yes (**inferred**: the App holds Workflows write) | Only if the token has the `workflow` scope, which is not among the three scopes `gh`'s manual calls the minimum. `/web-setup` warns when it is missing (documented) | Workflows write, with Contents write |
| Dispatch or re-run a workflow | Yes (**inferred**: the App holds Actions write) | Yes (**inferred**) | Actions write |
| Read repo settings | Yes (**inferred**: Metadata read and Administration read) | Yes (**inferred**) | Metadata read |
| Change repo settings | No (**inferred**: the App holds Administration read only) | Yes (**inferred**: `repo` scope, the Operator being an admin of the repo) | Administration write |
| Actions secrets and variables | No, not even listing names (**inferred**: the App holds neither Secrets nor Variables) | Yes (**inferred**: GitHub says classic tokens "need the `repo` scope to use this endpoint") | Secrets write; Variables write |
| Environments | List and read only (**inferred**: Actions read covers the reads). No create, no environment secrets or variables | Yes (**inferred**) | Administration write to create or change one; Environments write for its secrets and variables; Actions read to read one |
| Rulesets | Read only (**inferred**) | Yes (**inferred**) | Metadata read to read; Administration write to change |
| Branch protection | Read only (**inferred**: Administration read) | Yes (**inferred**) | Administration read to read; Administration write to change |
| Repository webhooks | Create and change (**inferred**: the App holds Repository hooks write) | Yes (**inferred**: `repo` scope) | Webhooks write |
| Labels | Yes (**inferred**: Issues write) | Yes (**inferred**) | Issues write or Pull requests write |
| Issue dependencies and sub-issues | Yes by REST (**inferred**: Issues write). Both have REST endpoints, so the GraphQL block does not remove them | Yes (**inferred**) | Issues write |
| Projects v2, and anything only in GraphQL | No (documented) | No (documented) | n/a |
| A second repo | Only one attached to the session when it starts. Anything else gets a 403, a public repo's source archive included (documented) | Same | n/a |
| Anything at the account's level | Docs silent. The proxy "serves GitHub API requests for the repositories attached to the session"; nothing says what happens to `/user/...` calls | Docs silent | Account permissions, on user access tokens and fine-grained personal access tokens only |
| `gh` in the VM | Pre-installed. `gh api` and REST-based subcommands work for attached repos. `gh pr`, `gh issue` and other GraphQL subcommands get a 403. `GH_TOKEN` reads `proxy-injected`, and the proxy substitutes the real credential outside the VM (documented) | Same | n/a |

## Table 2: giving a session more

| Way | Where the value lives | Can the agent read it | What limits where it can be sent | Reaches GitHub |
| :- | :- | :- | :- | :- |
| **Change the connection** (`/web-setup` in place of the browser connection, or the reverse) | Anthropic's servers, encrypted, with the claude.ai account | No | The GitHub proxy: attached repos, no GraphQL, no branch deletion, no tag push | Yes. One connection per account, shared by every cloud session; `/web-setup` "replaces that connection". Needs a terminal once. Projects' cloud threads still need the Claude GitHub App |
| **Environment variable** on the cloud environment (`GH_TOKEN`, `GITHUB_TOKEN`, or any other name) | The environment's configuration, and the VM | Yes: "ordinary environment variables that any command Claude runs can read" | Only the environment's network access level. GitHub and the Anthropic API stay reachable at every level | Yes: it "passes through to the container unchanged, so your scripts and GitHub's `gh` CLI use it directly". GraphQL is still refused |
| **Network secret** on the cloud environment | Anthropic's agent proxy, outside the VM | No: "the key doesn't appear in the session's environment variables or in any file" | Attached only to requests whose host matches a host listed on the secret | **No.** GitHub is first on the list of requests that never get a secret |
| **MCP connector** enabled on the session (adjacent, not asked) | Anthropic's servers | Not stated; traffic "travels through Anthropic's servers rather than the session's network" | The connector's own tools. A tool call can wait on the Operator's approval | Not researched here |
| **Self-hosted environment** with a per-session minted `GH_TOKEN` | The Operator's own runner | Yes | The Operator's own network boundary | Yes, but Team and Enterprise only, and it needs a runner the Operator keeps up |

## Table 3: how small and how short-lived GitHub lets a credential be

| | GitHub App user access token | The same, scoped down | Installation access token | Fine-grained personal access token |
| :- | :- | :- | :- | :- |
| Acts as | The Operator, shown with the App's badge | The Operator | The App (a bot) | The Operator |
| Minted by | The App's web or device sign-in, then its refresh token with client ID and secret | `POST /applications/{client_id}/token/scoped`, authenticated with client ID and secret, given an unscoped user access token | `POST /app/installations/{installation_id}/access_tokens`, authenticated with a JWT signed by the App's private key | The Operator, by hand, in GitHub's settings. A link can pre-fill the form. No API creates one (**inferred** from the docs describing no other way) |
| Repos | Every repo both the Operator and the App's installation can reach | One target account, and a chosen list of its repos | A chosen list, up to 500, within the installation | One resource owner, all or chosen repos |
| Permissions | What both the App and the Operator hold | A chosen subset | A chosen subset of the App's | Chosen one by one |
| Ceiling | The App's registered permissions | Same | Same | The Operator's own access. Cannot call the Checks API |
| Shortest life | 8 hours, fixed, when expiry is on. Refresh token: 6 months | Docs silent. The response carries `expires_at`; no page says what it is | 1 hour, fixed | 1 day through the pre-fill link (`expires_in` takes 1 to 366). The form's own minimum is not stated |
| Ended sooner by | `DELETE /applications/{client_id}/token` with client ID and secret; or the Operator revoking the App's authorization | Same (**inferred**: it is a token of the same App) | `DELETE /installation/token`, authenticated with the token itself | The Operator deleting it in settings |
| Account-level calls | Yes, with account permissions | Docs silent | No: about a hundred rows on GitHub's list take a user access token only, `GET /user/repos` among them | Yes, with account permissions |

**One repo, a few permissions, one hour:** yes, as an installation access token, minted by the App with its private key. It is the only one of the four whose life is an hour, and the only one that does not act as the Operator.

Every operation in Table 1 except the GraphQL-only ones has a row on both GitHub's "Permissions required for GitHub Apps" page (marked for user access tokens and installation access tokens) and its "Permissions required for fine-grained personal access tokens" page. So all three kinds can hold Workflows, Administration, Secrets, Variables and Environments, if whoever mints them may grant it.

## Sources, by finding

### The session's identity and where the credential lives

- **The credential stays outside the VM.** "In Anthropic-hosted environments, your GitHub credentials stay encrypted on Anthropic's servers and never enter a session's VM. GitHub operations from the VM go through the GitHub proxy, which attaches the credential on the server side." [GitHub authentication options](https://code.claude.com/docs/en/claude-code-on-the-web.md#github-authentication-options)
- **The VM holds a stand-in.** "The VM holds a short-lived credential scoped to that session, and GitHub traffic goes through an Anthropic proxy that attaches the GitHub credential on the server side." [Cloud execution security](https://code.claude.com/docs/en/security.md#cloud-execution-security). "The git client inside the VM uses a scoped credential, which the proxy verifies and swaps for your actual GitHub token." [GitHub proxy](https://code.claude.com/docs/en/cloud-environments.md#github-proxy)
- **It is the Operator's own token.** The self-hosted docs describe the same proxy as using "the GitHub OAuth token stored for the session's creator". [Use the Anthropic git proxy](https://code.claude.com/docs/en/self-hosted-environments-deploy.md#use-the-anthropic-git-proxy)
- **Actions appear as the Operator.** "Anything a scheduled task does through your connected GitHub identity or connectors appears as you. Commits and pull requests carry your GitHub user". [Scheduled tasks](https://code.claude.com/docs/en/routines.md). Auto-fix replies "are posted using your GitHub account, so they appear under your username, but each reply is labeled as coming from Claude Code". [Auto-fix pull requests](https://code.claude.com/docs/en/claude-code-on-the-web.md#how-claude-responds-to-pr-activity). The first passage is written about scheduled tasks, each run of which is a cloud session; no page says it of a session started by hand, so applying it there is **inferred**.
- **Commits carry a link to the session.** "Commits that Claude creates in a cloud session include a `Claude-Session: <url>` git trailer, and PR bodies include the session URL on its own line." [Link output back to the session](https://code.claude.com/docs/en/cloud-environments.md#link-output-back-to-the-session)
- **Signing keys.** "git credentials and signing keys stay outside the sandbox". [Security and isolation](https://code.claude.com/docs/en/claude-code-on-the-web.md#security-and-isolation). Docs silent on whether a session's commits are signed, and with whose key.

### The two connections

- **The table of the two.** GitHub App: "Any public repository, and private repositories that the Claude GitHub App is installed on". `/web-setup`: "Any repository your `gh` token can access, whether or not the Claude GitHub App is installed". [GitHub authentication options](https://code.claude.com/docs/en/claude-code-on-the-web.md#github-authentication-options)
- **`/web-setup` sends the `gh` token.** "Claude Code reads the token that `gh auth token` prints, asks you to confirm, and sends the token to Anthropic. Anthropic stores it encrypted with your claude.ai account, and your cloud sessions use it for GitHub access until you remove it." "If you already connected GitHub in the browser, `/web-setup` warns you that continuing replaces that connection for your cloud sessions." [Connect from your terminal](https://code.claude.com/docs/en/web-quickstart.md#connect-from-your-terminal)
- **`gh`'s default scopes.** "The minimum required scopes for the token are: repo, read:org, and gist." [gh auth login](https://cli.github.com/manual/gh_auth_login)
- **The `workflow` scope.** "If `/web-setup` says your GitHub CLI token doesn't have the `workflow` scope, you can continue, but GitHub can reject some pushes made with that token, such as pushes that change GitHub Actions workflow files." [Troubleshoot setup](https://code.claude.com/docs/en/web-quickstart.md#troubleshoot-setup)
- **What the classic `repo` scope grants.** "Grants full access to public and private repositories including read and write access to code, commit statuses, repository invitations, collaborators, deployment statuses, and repository webhooks." [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps). For a repository secret: "OAuth tokens and personal access tokens (classic) need the `repo` scope to use this endpoint." [Create or update a repository secret](https://docs.github.com/en/rest/actions/secrets#create-or-update-a-repository-secret)
- **Removing it.** "Disconnecting deletes the GitHub credentials your cloud sessions use, whether they came from the browser or from `/web-setup`". [Remove the `/web-setup` token](https://code.claude.com/docs/en/web-quickstart.md#remove-the-web-setup-token)
- **Inferred: the browser connection is a user access token of the Claude GitHub App.** The docs say "Authorize the Claude GitHub App during web onboarding" and that private repos need the App installed, which is how GitHub describes a user access token: "The app can only access resources in an account where it is installed", and it "is limited to the permissions that both your app and the user have". [Authenticating on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user). No Anthropic page names the token kind.
- **Inferred: `/web-setup` would send a fine-grained personal access token if `gh` were signed in with one.** The docs say only that it reads what `gh auth token` prints.

### The Claude GitHub App's permissions

- **The published set.** Actions read and write; Administration read; Checks read and write; Contents read and write; Dependabot alerts read; Discussions read and write; Issues read and write; Members read; Merge queues read; Metadata read; Pull requests read and write; Repository creation read and write; Repository hooks read and write; Statuses read; Workflows read and write. [GitHub App permissions](https://code.claude.com/docs/en/github-actions.md#github-app-permissions). GitHub's own record of the App (`GET /apps/claude`, updated 2026-11-16) lists the same fifteen and no others. No Secrets, Variables, Environments or Administration write.
- **It cannot be narrowed, and it can grow.** "When you install the app, you accept its full permission set. GitHub doesn't let you accept a subset." "The permission set can also change ahead of the features that use it. When the app requests a permission it didn't have before, GitHub prompts the account owner to approve it". Same page.

### The GitHub proxy

All from [GitHub proxy](https://code.claude.com/docs/en/cloud-environments.md#github-proxy):

- **Every GitHub operation goes through it**, "independent of the environment's access level".
- **Push restrictions.** "the proxy rejects branch deletions and pushes of anything other than a branch, such as a tag. It doesn't limit which branches a push can update. To do that, use branch protection rules or rulesets on GitHub."
- **Repository scope.** "the proxy serves GitHub API requests for the repositories attached to the session. An API request for another repository gets a 403 whose message starts with `GitHub access to` and contains `is not enabled for this session`."
- **GraphQL.** "the proxy rejects requests to GitHub's GraphQL endpoint with a 403 … `gh` subcommands that use GraphQL, such as `gh pr` and `gh issue`, get the same 403. The restriction applies to every request through the proxy regardless of the credentials you supply, so a `GH_TOKEN` you set gets the same 403. Claude can't reach GitHub APIs that exist only in GraphQL, such as Projects v2, through the proxy."

Rulesets and the session's pushes: "GitHub applies them to the GitHub access you connected, so a rule that access can bypass doesn't block a run's push." [Repositories and branch permissions](https://code.claude.com/docs/en/routines.md#repositories-and-branch-permissions); the same is said of sessions on the [security page](https://code.claude.com/docs/en/security.md#cloud-execution-security).

### `gh` and the built-in tools

All from [Work with GitHub issues and pull requests](https://code.claude.com/docs/en/cloud-environments.md#work-with-github-issues-and-pull-requests):

- **Built-in tools.** "Cloud sessions include built-in GitHub tools that let Claude read issues, list pull requests, fetch diffs, and post comments without any setup."
- **A token the Operator sets.** "If you set a token, it passes through to the container unchanged, so your scripts and GitHub's `gh` CLI use it directly." "A token you set is an ordinary environment variable, so anyone who uses the environment can read it".
- **With none set.** "both variables read as the placeholder string `proxy-injected` in the commands Claude runs, and the proxy substitutes your real credentials on outbound GitHub requests. `gh api` calls for attached repositories work without a token of your own, but a script that reads `GITHUB_TOKEN` directly gets the placeholder, not a usable token."
- **`gh` itself.** "GitHub's `gh` CLI is pre-installed. If you need a GitHub operation the built-in tools don't cover, ask Claude to call the REST API with `gh api`. `gh` subcommands that use the REST API, such as `gh workflow list`, work too."

Inferred, and worth a trial: whether the proxy's repository scope also binds a request that carries the Operator's own `GH_TOKEN`. The GraphQL rule is stated to bind it; the repository rule is stated without saying either way. Docs silent on whether `git push` in the VM would ever use a `GH_TOKEN` in place of the proxy's credential.

### Environment variables

From [Set environment variables](https://code.claude.com/docs/en/cloud-environments.md#set-environment-variables):

- **Readable.** "A session reads the environment's values into ordinary environment variables that any command Claude runs can read". "Anyone who uses the environment can read the values."
- **When an edit lands.** "After you edit, add, or remove a variable, an existing session in an Anthropic-hosted environment keeps the values it last read until its VM is next restored or rebuilt". "Its VM pauses on its own once the session is idle, and you can't pause it yourself."
- **Not there for the setup script.** "the script runs before the session sets the environment's environment variables." [Script requirements](https://code.claude.com/docs/en/cloud-environments.md#script-requirements)
- **Set in the app only.** Environments are added and edited "from the environment selector"; `/remote-env` "can't add or edit environments". [Configure your environment](https://code.claude.com/docs/en/cloud-environments.md#configure-your-environment). A running session's environment can be edited from the caret after its title. Docs silent on any API that creates an environment or sets its variables.
- **A link can pick one.** `https://claude.ai/code?prompt=…&repositories=…&environment=…` pre-fills "the prompt, repositories, and environment for a new session". The four parameters are `prompt`, `prompt_url`, `repositories` and `environment`. [Pre-fill sessions](https://code.claude.com/docs/en/web-quickstart.md#pre-fill-sessions)

### Network secrets

From [Add network secrets](https://code.claude.com/docs/en/cloud-environments.md#add-network-secrets):

- **What one is.** "an API key or token you store on a cloud environment so Claude can call that API from any session in the environment without seeing the key. Anthropic's agent proxy adds the key to requests for the hosts you list, after each request leaves the session's VM".
- **Plans.** "Network secrets are available on Pro, Max, Ultra, Team, and Enterprise plans."
- **Which requests get it.** "The agent proxy attaches a secret to a request when the request's host matches one you listed on that secret. Sessions can reach those hosts even when the environment's network access level wouldn't otherwise allow them". "The secret applies in every session that runs in the environment, whoever started it, until you delete it."
- **Never GitHub.** "The agent proxy never attaches a secret you add to these requests: **GitHub**: the GitHub proxy authenticates requests to GitHub instead, so you don't need a network secret for it". Also never: the Anthropic API, the public package registries, and the setup script's requests. [Requests that never get the secret](https://code.claude.com/docs/en/cloud-environments.md#requests-that-never-get-the-credential). Docs silent on which hostnames count as GitHub.
- **Shape.** A header name, a prefix and a value, on a list of hosts; "A leading `*.` matches every subdomain". "You can't view the value again after saving." "To change a secret's hosts or value, delete it and add it again."
- **The API must be public.** "the API accepts connections from the internet, because requests leave from Anthropic's network".

### Where a readable value can be sent

- **Access levels.** None, Limited (the default allowlist plus listed domains) and Full. "Whichever level you pick, sessions can still reach" GitHub through its proxy, enabled MCP connectors, the hosts on network secrets, and the Anthropic API. [Access levels](https://code.claude.com/docs/en/cloud-environments.md#access-levels)
- **A change lands fast.** "its existing sessions follow the new setting within about a minute". [Network access](https://code.claude.com/docs/en/cloud-environments.md#network-access)
- **Even at None.** "When running with network access disabled, Claude Code can still communicate with the Anthropic API, which may allow data to exit the VM." [Security and isolation](https://code.claude.com/docs/en/claude-code-on-the-web.md#security-and-isolation)
- **The default allowlist is wide.** It includes `github.com`, `api.github.com`, `gist.github.com`, the package registries and cloud SDK hosts. [Default allowed domains](https://code.claude.com/docs/en/cloud-environments.md#default-allowed-domains)
- **Inferred:** a token the agent can read can leave by any allowed host, by a branch the session pushes, by a comment it posts, or by the Anthropic-bound channel. No network level closes all four.
- **GitHub revokes some leaks itself.** "If a valid OAuth token, GitHub App token, or personal access token is pushed to a public repository or public gist, the token will be automatically revoked." [Token expiration and revocation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation)

### GitHub's token kinds

- **User access token: who it acts as.** "API requests made by an app on behalf of a user will be attributed to that user." "The app can only access resources that the user has access to… that it has permission to access… in an account where it is installed." [Authenticating on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)
- **User access token: life.** "The user access token expires after eight hours, and the refresh token expires after six months." `expires_in`: "The value will always be `28800` (8 hours)." A refresh needs the client secret "unless the user access token was generated using the device flow". [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- **User access token: scoping down.** "Use a non-scoped user access token to create a repository-scoped and/or permission-scoped user access token. You can specify which repositories the token can access and which permissions are granted to the token." It takes `target` or `target_id`, `repositories` or `repository_ids`, and `permissions`, with Basic authentication by client ID and secret. The response schema has `expires_at`. [Create a scoped access token](https://docs.github.com/en/rest/apps/apps#create-a-scoped-access-token)
- **User access token: revoking one.** "OAuth or GitHub application owners can revoke a single token". [Delete an app token](https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token)
- **Installation access token.** "Installation tokens expire one hour from the time you create them." "you can use the repositories or repository_ids body parameters to specify individual repositories… Up to 500". "use the permissions body parameter to specify the permissions… The installation access token cannot be granted permissions that the app was not granted." "You must use a JWT to access this endpoint." [Create an installation access token for an app](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app). "API requests made by an app installation are attributed to the app." [Authenticating as a GitHub App installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation). Revoked by [`DELETE /installation/token`](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token).
- **Fine-grained personal access token.** "Each token is limited to access resources owned by a single user or organization." "Each token can be further limited to only access specific repositories". Among its gaps: "Using fine-grained personal access token to call the Checks API." "There is a limit of 50 fine-grained personal access tokens you can create." The pre-fill link's `expires_in` is an "Integer between 1 and 366, or `none`", in days. [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- **Git over HTTPS.** "If you want your app to use an installation or user access token to authenticate for HTTP-based Git access, you should request the "Contents" repository permission. If your app specifically needs to access or edit Actions files in the `.github/workflows` directory, request the "Workflows" repository permission." [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- **Raising an App's permissions.** "the owner of each account where the app was installed will be prompted to approve the new permissions. If the account owner does not approve the new permissions, their installation will continue to use the old permissions." Same page.
- **Per-endpoint permissions.** [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) and [Permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens). Table 1's last column is read from these: `POST /repos/{owner}/{repo}/pulls` under Pull requests write; `PUT …/pulls/{pull_number}/merge` under Contents write; `PUT …/contents/{path}` under Contents and Workflows; `PATCH /repos/{owner}/{repo}`, `PUT …/branches/{branch}/protection`, `POST …/rulesets` and `PUT …/environments/{environment_name}` under Administration write; `GET …/rulesets` and `GET /repos/{owner}/{repo}` under Metadata read; `GET …/branches/{branch}/protection` under Administration read; `PUT …/actions/secrets/{secret_name}` under Secrets write; `POST …/actions/variables` under Variables write; `PUT …/environments/{environment_name}/secrets/{secret_name}` under Environments write; `GET …/environments/{environment_name}` under Actions read; `POST …/actions/workflows/{workflow_id}/dispatches` under Actions write; `POST …/labels` under Issues or Pull requests write; `POST …/issues/{issue_number}/dependencies/blocked_by` and `POST …/issues/{issue_number}/sub_issues` under Issues write; `POST …/hooks` under Webhooks write.

### What the Console holds today

From [#517](https://github.com/jrey8343/fabrik/issues/517)'s answer, not re-checked against the App's settings:

- The Console's private GitHub App holds Contents, Pull requests and Issues write; Actions, Deployments, Commit statuses, Checks and Metadata read. "No Workflows, Administration, Webhooks or Secrets."
- "No private key is generated for the App. Nothing can act as the App itself." So it cannot mint an installation access token today.
- It holds the App's client secret, which is what the scoped-token endpoint and a single-token revoke need.
- Its user access token "came with an 8-hour expiry and a refresh token".

## Facts found beside the question

- **A session with several repositories runs no repo hooks.** "in an Anthropic-hosted environment, a session with several repositories doesn't load hooks from any repository's `.claude/settings.json`, so a SessionStart hook you define there doesn't run." [Limitations in cloud sessions](https://code.claude.com/docs/en/cloud-environments.md#limitations-in-cloud-sessions). The Kit installs its skills from a SessionStart hook.
- **Permission modes.** Cloud sessions offer Accept edits, Plan and Auto. "Cloud sessions don't offer Manual or Bypass permissions." [Start a task](https://code.claude.com/docs/en/web-quickstart.md#start-a-task)
- **Waiting on an approval counts as idle.** "A session counts as inactive while it waits for you to approve an MCP connector tool call or to sign in to an MCP server, and it can expire during that wait." [Environment expired](https://code.claude.com/docs/en/claude-code-on-the-web.md#environment-expired)
- **Self-hosted environments** are "in public beta on Team and Enterprise plans". Their docs describe the pattern this map is after, "mint a short-lived, least-scoped token per session from your wrapper script, using the session creator's identity", on a runner the organization keeps up. [Self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments.md); [Configure git](https://code.claude.com/docs/en/self-hosted-environments-deploy.md#configure-git)
- **Workflow files and secrets (inferred).** A credential that can push a workflow file on a branch, or dispatch a workflow, can cause a job to run in the repo's Actions context. Whether that job can read the repo's secrets depends on the workflow's trigger and on environment protection rules, which this research did not read.

## Against the earlier research

`docs/research/remote-surfaces.md` (2026-11-02) said git credentials stay behind a proxy and that network secrets never enter the VM. Both still hold. It did not record the proxy's GraphQL block, its repository scope, the `proxy-injected` placeholder, or that network secrets skip GitHub. Nothing in it was found to be wrong on this question.

## What stays unknown until tried

1. **Whether the proxy passes every REST endpoint for an attached repo.** Table 1's inferred cells all rest on it. One session calling `gh api` for a settings read, a ruleset read, a label write and a secrets list would settle most of them.
2. **Which connection the Operator's account has today**, and so which column of Table 1 applies. Not looked at: it is an account setting.
3. **Account-level calls through the proxy,** such as `GET /user` or creating a repo. Docs silent.
4. **Whether the proxy's repository scope binds a `GH_TOKEN` the Operator set,** and whether `git push` ever uses that token.
5. **A scoped user access token's life,** whether minting one leaves the parent token valid, and whether it can be revoked alone.
6. **Whether a network secret added while a session runs reaches that session,** and how soon. Stated for network access (about a minute) and for variables (next restore), not for secrets.
7. **Whether anything but the app can create a cloud environment or set its variables.** No API is documented.
8. **Whether commits pushed from a session are signed,** and how a ruleset that requires signatures treats them.
9. **Whether the Kit's scripts and skills run without GraphQL.** `/fabrik-pair` uses `gh issue` and `gh pr`; the Kit's own GraphQL use was not surveyed.
