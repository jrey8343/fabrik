# How can third-party credentials reach a remote session without living in it?

Research for [#800](https://github.com/jrey8343/fabrik/issues/800), a Decision on the map [#796](https://github.com/jrey8343/fabrik/issues/796). Date: 2026-11-19.

**Question.** An Operator session's work reaches past GitHub: Cloudflare, 1Password, Sentry, and whatever else a `ready-for-human` issue names. For each system, which patterns keep a credential short-lived or out of the session's reach, what does each cost to run, and which need the Console to grow a part?

**Method.** Desk research only, against primary sources fetched on 2026-11-19: the Claude Code docs at code.claude.com (raw `.md` pages), the connector docs at claude.com/docs, 1Password's developer docs (now at 1password.dev), Cloudflare's developer docs and API reference, Sentry's docs, and four of Anthropic's published posts on agents and prompt injection. In the repo I read ADR-0004 and `skills/fabrik-pair/SKILL.md`. No credential, vault item or token was created, read or changed, and no vendor API was called. Anything marked **inferred** is my reasoning from the docs, not something a doc states. Where the docs say nothing, this file says so.

This file decides nothing. It records what each vendor's credentials allow, and the options that leaves.

**The patterns, named once.** The rest of the file uses these names.

| | Pattern | Where the credential is |
| :- | :- | :- |
| **Env** | An environment variable on the cloud environment | In the session. The baseline the other patterns are measured against. |
| **Mint** | A broker outside the session creates a short-lived, narrow credential when asked | Outside, until the broker hands one over. Then in the session, for its lifetime. |
| **Attach** | A proxy outside the session's sandbox adds the secret to matching requests | Outside. The session can use it and can't read it. |
| **Act** | An MCP server performs the act itself | Outside. The session sees a tool, never a credential. |
| **Tap** | The Operator approves on a phone before any of the above happens | Not a place for a credential. A gate in front of one. |
| **Job** | A GitHub Actions job performs the act, as the Kit's AFK jobs do today | In the job, outside the session. |

## Answer

- **A cloud session already ships two of the patterns with no part from the Console.** A network secret is **Attach**: "Anthropic's agent proxy adds the key to requests for the hosts you list, after each request leaves the session's VM, so the key itself stays outside the VM." A claude.ai connector is **Act**: its traffic "travels through Anthropic's servers rather than the session's network", and "the session's proxy authenticates to the connector with the authorization you granted in claude.ai." Both are standing grants. Neither expires, neither can be cut narrower than a host or a tool, and a network secret is added by hand in claude.ai.
- **Cloudflare is the only one of the three whose credentials a broker can mint.** A token takes an `expires_on` timestamp, a list of permission groups, account or zone resources and a client IP condition, and one token can create and delete others by API. Sentry's integration tokens "do not expire automatically", and the Sentry pages read show no API that creates a token. 1Password says outright that "a service account can't create another service account."
- **1Password is the odd one out for Attach too.** A service account token is a bundle of decryption keys that the client uses itself, not a header a proxy can add (**inferred**). The only header-shaped 1Password credential belongs to a Connect server the Operator would have to host.
- **Every pattern leaves the session able to use the power while it holds it.** Attach and Act keep the secret from being copied out. They don't stop a steered agent from spending it. Only **Tap**, or a credential cut so narrow that misuse is cheap, limits that.
- **A tap can happen in two places.** In the Claude app, through a prompt Claude Code is documented to show on every call of a tool an MCP server marks `anthropic/requiresUserInteraction`, in every permission mode. Or in the Console, where a broker holds its answer until the Operator approves a web push. The first needs no push of the Console's and has no documented push of Anthropic's. The second needs the Console to grow the broker.

### Per system

| System | Mint | Attach (network secret) | Act (MCP) | Short-lived by the vendor's own means |
| :- | :- | :- | :- | :- |
| **Cloudflare** | Yes, by API. Needs a standing token that can create tokens, held outside the session. **Console part:** a mint-and-revoke broker. | Yes. A bearer token for `api.cloudflare.com`. No Console part. | Cloudflare's own API MCP server over OAuth, added as a connector. No Console part. Or named acts on a Console-hosted server. | Yes: `expires_on` to the second, set by API. |
| **1Password** | No. Only a signed-in person creates a service account or a Connect token. | Not with a service account (**inferred**). Yes in form with a self-hosted Connect server. | No remote 1Password MCP server is documented. A Console-hosted one would need a 1Password client that runs on a Worker, which the docs don't cover. | Partly: `--expires-in` at creation, by a person. Connect tokens: 30, 90 or 180 days. |
| **Sentry** | No API for it in the pages read. | Yes. A bearer token for `sentry.io`. No Console part. | Sentry's own MCP server over OAuth, added as a connector. No Console part. | No, for its three token types. OAuth access tokens last 30 days. |

### What each costs to run

| Pattern | Standing power, and where it sits | Setup | Each use | Console part |
| :- | :- | :- | :- | :- |
| **Env** | The credential, readable by "any command Claude runs" | Paste once in claude.ai | None | None |
| **Attach** | The credential, in Anthropic's agent proxy, for every session in that environment "until you delete it" | Add once per credential in claude.ai. To change it, "delete it and add it again." | None | None |
| **Act**, vendor's connector | An OAuth grant held by claude.ai | Connect once at claude.ai/customize/connectors | A prompt in the Claude app if the tool is set to need approval | None |
| **Act**, Console-hosted server | The vendor credential, as a Worker secret in the Console | Build the server; add it as a custom connector; OAuth between claude.ai and the Console | Whatever the server asks for | An MCP endpoint, an OAuth authorization server, the vendor calls |
| **Mint** | A token that can create tokens, as a Worker secret in the Console | Create the minting token by hand once | One API call to mint, one to delete | A broker, and a way to deliver the result |
| **Tap**, in the Claude app | Nothing extra | Mark the tool, or commit an ask rule | One answer in the conversation | None, or one annotation on a Console-hosted tool |
| **Tap**, in the Console | Nothing extra | Build it | One tap on a web push | A pending-approval store, a push, an approve screen, a gate in front of the mint or the act |
| **Job** | The Kit's 1Password service accounts, as Actions secrets (ADR-0004) | A workflow per kind of act | A workflow run, minutes of Actions time | A dispatch, if the Console is what starts it |

## What a cloud session gives a credential

These facts hold for an Anthropic-hosted cloud session, the first host on the map's list. They come from [Configure cloud environments](https://code.claude.com/docs/en/cloud-environments.md), [Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web.md), [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp.md) and [Choose a permission mode](https://code.claude.com/docs/en/permission-modes.md).

### Env: an environment variable lives in the session

- "A session reads the environment's values into ordinary environment variables that any command Claude runs can read". "Anyone who uses the environment can read the values." ([Set environment variables](https://code.claude.com/docs/en/cloud-environments.md#set-environment-variables))
- A token set as `GH_TOKEN` "passes through to the container unchanged". The docs treat that as the thing to avoid: "the proxy path keeps the credential out of the environment configuration and the session VM." ([Work with GitHub issues and pull requests](https://code.claude.com/docs/en/cloud-environments.md#work-with-github-issues-and-pull-requests))
- A server in the repo's `.mcp.json` loads in a single-repo cloud session, and Claude Code "loads project-scoped servers without asking" there. Its `headers` can expand `${VAR}` from the environment, so a credential passed that way is an environment variable first. ([Project scope](https://code.claude.com/docs/en/mcp.md#project-scope), [Environment variable expansion](https://code.claude.com/docs/en/mcp.md#environment-variable-expansion-in-mcp-json))

### Attach: network secrets

All from [Add network secrets](https://code.claude.com/docs/en/cloud-environments.md#add-network-secrets).

- **What it is.** "A network secret is an API key or token you store on a cloud environment so Claude can call that API from any session in the environment without seeing the key."
- **Plans.** "Network secrets are available on Pro, Max, Ultra, Team, and Enterprise plans." A self-hosted environment "doesn't have network secrets".
- **It matches on host, and nothing narrower is documented.** "The agent proxy attaches a secret to a request when the request's host matches one you listed on that secret." The form takes "Allowed websites" and "Custom headers". The docs describe no filter by method or path. **Inferred:** a network secret gives the session every operation the stored credential allows on that host.
- **It is per environment, not per session.** "The secret applies in every session that runs in the environment, whoever started it, until you delete it."
- **It has no expiry of its own, and no edit.** "You add secrets one at a time. To change a secret's hosts or value, delete it and add it again." The docs describe no expiry field.
- **It is added by hand.** The documented way in is the **Edit cloud environment** dialog at claude.ai/code. The docs describe no API or CLI that adds or deletes a network secret. `/remote-env` "can't add or edit environments."
- **The value can't be read back.** "You can't view the value again after saving." In a session, "the key doesn't appear in the session's environment variables or in any file."
- **Its hosts bypass the network allowlist.** "Sessions can reach those hosts even when the environment's network access level wouldn't otherwise allow them".
- **Requests that never get one:** GitHub (its own proxy), the Anthropic API and public package registries, setup script requests, and Claude Code's telemetry export.
- **The API must be public.** "the API accepts connections from the internet, because requests leave from Anthropic's network".
- **Other header shapes.** "For a header like `X-Api-Key` that takes the bare value, change the name and clear the prefix". Other secret types exist; the page doesn't list them.

GitHub's proxy is the same idea with more in it: "the git client inside the VM uses a scoped credential, which the proxy verifies and swaps for your actual GitHub token", and it rejects some operations outright ([GitHub proxy](https://code.claude.com/docs/en/cloud-environments.md#github-proxy)). Nothing documented lets a user give a network secret that kind of per-operation rule.

### Act: connectors and other MCP servers

- **Connector traffic never enters the session's network.** "MCP connectors you enable on a session or scheduled task work without adding their hosts to **Allowed domains**, because connector traffic travels through Anthropic's servers rather than the session's network." ([Network access](https://code.claude.com/docs/en/cloud-environments.md#network-access))
- **The connector's credential stays with claude.ai.** "For a connector delivered to a cloud session, Claude Code doesn't run a sign-in flow, because the session's proxy authenticates to the connector with the authorization you granted in claude.ai." ([Authenticate with remote MCP servers](https://code.claude.com/docs/en/mcp.md#authenticate-with-remote-mcp-servers))
- **Any remote MCP server can be a connector.** "You can add any third-party connector as a custom connector as long as you have the URL of its remote MCP server." It works on "Free, Pro, Max, Ultra, Team, and Enterprise plans". ([Add a connector that isn't in the directory](https://claude.com/docs/connectors/custom/add-unlisted))
- **How a connector authenticates.** OAuth 2.0, a static request header, or nothing. The static header is "in beta and available to a limited set of organizations." "A machine-to-machine `client_credentials` grant isn't supported". ([Authentication for connectors](https://claude.com/docs/connectors/building/authentication))
- **Per-tool permissions exist in claude.ai.** "under **Tool permissions**, choose **Always allow**, **Needs approval**, or **Blocked** for each group of tools or for a single tool". ([Get started with connectors](https://claude.com/docs/connectors/getting-started))
- **A connector is all-or-nothing per account unless switched off.** For a scheduled task, "all of your connected connectors are included by default", and "Claude can use an included connector during a run, including writes." ([scheduled tasks](https://code.claude.com/docs/en/routines.md#connectors))

### Tap: prompts that reach a person

- **Modes.** Cloud sessions offer "Accept edits, Plan, and Auto". "Bypass permissions isn't available." ([Switch permission modes](https://code.claude.com/docs/en/permission-modes.md#switch-permission-modes))
- **A tool can demand a person on every call.** An MCP server marks a tool with `_meta["anthropic/requiresUserInteraction"]` set to `true`. "Claude Code shows that tool's permission prompt on every call Claude makes, even in `acceptEdits`, `auto`, and `bypassPermissions` permission modes, and doesn't offer a 'don't ask again' option for it." Allow rules "don't skip the prompt either." The docs name its purpose: "a consent or access-grant step where auto-approval would mean no human ever agreed." ([Require approval for a specific tool](https://code.claude.com/docs/en/mcp.md#require-approval-for-a-specific-tool))
- **An ask rule prompts even in auto mode**, and the repo can carry one. But for Bash it is not a boundary: "a deny or ask rule covers the invocation Claude usually produces and isn't a security boundary around the program." ([Permission prompts during a run](https://code.claude.com/docs/en/routines.md#permission-prompts-during-a-run), [What a Bash rule doesn't match](https://code.claude.com/docs/en/permissions.md#what-a-bash-rule-doesnt-match))
- **Waiting counts as idle.** "A session counts as inactive while it waits for you to approve an MCP connector tool call or to sign in to an MCP server, and it can expire during that wait." ([Environment expired](https://code.claude.com/docs/en/claude-code-on-the-web.md#environment-expired))
- **An MCP server can ask the Operator a question mid-call.** In a cloud session an elicitation request "appears as a card at claude.ai/code or in the Desktop app's **Code** tab". "If you see no card in either place, you can't answer the request there." The page doesn't name the mobile app. ([Answer an elicitation request in a cloud session](https://code.claude.com/docs/en/mcp.md#answer-an-elicitation-request-in-a-cloud-session))
- **No phone push is documented for a waiting cloud session.** The mobile page describes pushes for Remote Control and for Dispatch only. ([Get push notifications](https://code.claude.com/docs/en/mobile.md#get-push-notifications))
- **A tool call can't simply hang until a tap.** For an HTTP or connector server, a call "that sends no response and no progress notification for the idle window aborts"; the window "defaults to five minutes". A per-request timer also "covers each request through to the server's first response byte". ([Time limits on MCP tool calls](https://code.claude.com/docs/en/mcp.md#time-limits-on-mcp-tool-calls)) **Inferred:** a Console-hosted tool that waits on a tap has to send progress notifications, answer as an MCP task, or return at once and be asked again.
- **Channels' permission relay is not for cloud sessions as documented.** A channel "runs on the same machine as Claude Code. Claude Code spawns it as a subprocess". It is a research preview started with a CLI flag. ([Channels reference](https://code.claude.com/docs/en/channels-reference.md))
- **A hook is a guard inside the session, not a gate outside it.** A repo's hooks run in cloud sessions, and a `PreToolUse` hook of type `http` can POST the call to a URL and answer `deny` or `ask`. But "a timed-out `command`, `http`, or `mcp_tool` hook doesn't block the tool call" unless `onFailure: "block"` is set, and the hook is a file in the repo the session works in. ([Hooks reference](https://code.claude.com/docs/en/hooks.md#timeouts))

## 1Password

Sources: [1Password Service Accounts](https://www.1password.dev/service-accounts), [Get started](https://www.1password.dev/service-accounts/get-started), [security](https://www.1password.dev/service-accounts/security), [manage](https://www.1password.dev/service-accounts/manage-service-accounts), [rate limits](https://www.1password.dev/service-accounts/rate-limits), the [`op service-account`](https://www.1password.dev/cli/reference/management-commands/service-account) reference, [Connect security](https://www.1password.dev/connect/security), [Manage Connect](https://www.1password.dev/connect/manage-connect), [Credential Broker](https://www.1password.dev/brokered-access) and [Use 1Password with AI agents](https://www.1password.dev/security-for-ai).

### What a service account can be held to

- **Vaults, not items.** "You control which vaults and Environments are accessible and which actions the service account can perform." Permissions per vault are `read_items`, `write_items` ("requires `read_items`") and `share_items`. No item-level scope is documented.
- **Read or write, fixed at birth.** "Service account permissions, vault access, and Environment access are immutable." "You can't add vault access to a generated service account after creation."
- **Some vaults are off limits.** "You can't grant a service account access to your built-in Personal, Private, or Employee vault, or your default Shared vault."
- **It can expire.** `--expires-in duration`: "Set how long the service account is valid for in (s)econds, (m)inutes, (h)ours, (d)ays, or (w)eeks." Rotation can also end the old token "**now** (immediately), in **1 hour**, or in **3 days**." Revoking "immediately removes its access".
- **It can't be approved per use.** The docs describe no approval step on a service account's reads. Where 1Password does prompt a person, the prompt comes from the desktop app: the Environments MCP server "runs locally on your computer as part of the 1Password desktop app", and "Remote-only MCP clients aren't currently supported." The NVIDIA OpenShell integration, which gives an agent placeholders and a time limit, requires "1Password for Mac or 1Password for Linux". The map rules a running machine out.
- **It can't mint.** "A service account can't create another service account." Owners and administrators create them, on 1Password.com or with the CLI.
- **Its use is visible.** "You can see what items a service account accesses by creating a usage report".
- **Limits.** "You can create up to 100 service accounts." On an individual or Families account: 1,000 reads and 100 writes an hour per token, and 1,000 requests a day per account. Teams: 5,000 a day. Business: 50,000 a day.
- **The token is key material.** "1Password creates the service account token by serializing the Account Unlock Key (AUK), Secure Remote Password (SRP), and the personal keyset into a JSON Web Token". "The AUK encrypts the personal keyset, and 1Password uses the personal keyset to encrypt and decrypt vaults." **Inferred:** whatever uses a service account token holds it in its own memory and decrypts with it, so a header-adding proxy can't stand in for it. The Attach pattern doesn't fit a service account.

### The other 1Password credentials

- **Connect server.** "A self-hosted REST API you deploy in your own infrastructure", on Docker or Kubernetes. Requests carry "an `Authorization` header containing an authorization token", so it fits Attach in form (**inferred**), if the server is reachable from the internet. A token's expiry is "30, 90, or 180 days". "You can't use a Connect server access token to create another Connect server access token." It is a box with upkeep, which the map puts last.
- **Credential Broker (public preview).** "No token at all — access is verified per run using your CI/CD platform's OIDC identity". "Secrets are only accessible after a workload has been verified, and only remain accessible for the duration of the workflow." It needs 1Password Business, supports "GitHub Actions and custom OIDC workflows", is "only supported in the 1Password JavaScript SDK", and still has an integration key "required to decrypt secrets in your team's workflows". The Claude Code docs describe a signed session identity token only for self-hosted environments: "Every session in a self-hosted environment receives a signed JSON Web Token (JWT) in the `CLAUDE_CODE_SESSION_ACCESS_TOKEN` environment variable", and those environments "are in public beta on Team and Enterprise plans" ([Verify session identity in self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments-identity.md)). **Inferred:** an Anthropic-hosted cloud session has no documented OIDC identity to present, so the Credential Broker serves an Actions job, not a cloud session.
- **Item share links.** `op item share` takes `--expires-in`, `--view-once` and `--emails`, and needs `share_items`. It time-limits a copy of one item. Whoever opens the link then holds the secret.

### What the Kit does with one today

From [ADR-0004](../adr/0004-afk-secrets-come-from-1password.md):

- Each Product repo holds three **read-only** service accounts as Actions secrets, split by job role, because the "job is the security boundary, not the step".
- Setup creates them "with `op service-account create`, with no expiry".
- "A Kit step resolves them with the service-account token in that step's env only, using `load-secrets-action` in output mode". "The agent step then gets just the resolved values."
- The ADR turned the Credential Broker down as "in preview, documented only for GitHub organizations, and still stores a long-lived integration key." The custom OIDC path is newer than that sentence. The integration key remains.
- A Pairing session today uses the Operator's own `op` in their terminal: `skills/fabrik-pair/SKILL.md` checks a step with "`op item get` for a 1Password item". That is the Operator's own sign-in, not a service account.

### What that leaves for 1Password

- **Job.** A dispatched Actions job that references a service account and performs the act is the one pattern here that needs nothing new from 1Password and no box. **Inferred** from how ADR-0004's jobs already work. Who may dispatch it is GitHub's question, and so #798's.
- **A session may not need to read 1Password at all (inferred).** 1Password is where the other systems' credentials are kept. If Cloudflare's are minted and Sentry's attached, what is left is writing a new secret back, which a `write_items` account outside the session could do.
- **A short-lived account per session** exists in the product (`--expires-in`) but only a person can create one, on 1Password.com or with a signed-in CLI. Whether the web wizard is usable on a phone is not documented.
- **A Console that reads 1Password itself** would hold a service account token as a Worker secret. The SDKs are "for Go, JavaScript, and Python"; the docs don't say whether the JavaScript one runs on a Cloudflare Worker.

## Cloudflare

Sources: [Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [Create tokens via API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/), [Restrict tokens](https://developers.cloudflare.com/fundamentals/api/how-to/restrict-tokens/), [Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/), [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/), [API token templates](https://developers.cloudflare.com/fundamentals/api/reference/template/), the API reference for [creating](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/) and [deleting](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/delete/) an account token, [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/), [Wrangler's system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) and [Cloudflare's own MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/).

### How narrowly a token is cut

- **By permission.** "Most permissions offer `Edit` or `Read` access. `Edit` is full CRUDL (create, read, update, delete, list) access". Permissions come as named groups per product, such as Workers Scripts, Workers KV Storage, D1 and DNS.
- **By resource, down to an account or a zone.** "API token policies support three resource types: `User`, `Account`, and `Zone`." A zone can be named singly. **Inferred:** a token that may edit Workers scripts may edit every Worker in the account, because no narrower resource is documented for them. R2 is the documented exception: object permissions can be scoped "to a set of buckets".
- **By deny.** A policy's `effect` is `allow` or `deny`, evaluated "1. Explicit `DENY` Policies; 2. Explicit `ALLOW` Policies; 3. Implicit `DENY ALL`."
- **By client IP.** A `request.ip` condition with `in` and `not_in` CIDR lists.
- **Not every product takes an account token.** The compatibility matrix marks Workers, Workers KV, D1, R2, Durable Objects, DNS and Pages as supported, and Registrar, Page Rules and Turnstile as not.

### Expiry

- "By default, tokens do not expire and are long lived."
- By API, "you can set the time at which a token becomes active with `not_before` and the time when it expires with `expires_on`. Both of these fields take UTC timestamps". In the dashboard, "Dates selected are defined as 00:00 UTC of that day. For finer grained time selection, use the API."

### One token minting others

- **It is documented and meant.** "Generate new API tokens on the fly via the API. Before you can do this, you must create an API token in the Cloudflare dashboard that can create subsequent tokens."
- **Account-owned tokens.** `POST /accounts/{account_id}/tokens` accepts the permission `Account API Tokens Write`. `DELETE /accounts/{account_id}/tokens/{token_id}` takes the same. Creating them in the dashboard needs "API Token Provisioning capabilities or Super Administrator status", and "Account members may only grant account API tokens permissions which are a subset of their own account permissions."
- **User-owned tokens.** `POST /user/tokens` accepts `API Tokens Write`, which is "not available in any other template or in the Custom Token builder" than **Create additional tokens**.
- **The minting token is the dangerous one.** "Make sure you safeguard the new token because it can create tokens with access to any of a user's resources." Cloudflare "highly recommends that you do not grant other permissions to the token", and limiting it "via client IP address filtering or TTL".
- **Rolling** a token "will invalidate the previous token, but the access and permissions will be the same".
- **R2 only:** "To issue short-lived, scoped credentials derived from an API token, use temporary credentials."

### What that leaves for Cloudflare

- **Mint.** A broker holding one minting token can cut a token for one act: a few permission groups, one account or zone, an `expires_on` minutes ahead, and delete it afterwards. Every call is a documented endpoint. That the Console's Worker can make them is **inferred** from their being plain HTTPS requests with a bearer token.
- **Mint, without the result reaching the session (inferred).** Wrangler documents a `CLOUDFLARE_API_BASE_URL` variable whose default is `https://api.cloudflare.com/client/v4`. A broker that also proxies the API could have Wrangler point at it, and add the minted token itself. The session would then hold only its way of reaching the broker, and a network secret can carry that. No doc describes this arrangement; it is two documented parts put together.
- **Attach.** A bearer token for `api.cloudflare.com` as a network secret works as documented for any `curl`. Wrangler reads its token from `CLOUDFLARE_API_TOKEN`. Whether Wrangler runs with a placeholder there while the agent proxy supplies the real header is not documented; the docs show that placeholder trick only for GitHub.
- **Act, with Cloudflare's own server.** "The Cloudflare API MCP server at `https://mcp.cloudflare.com/mcp` is the only MCP server you need to work with Cloudflare. It provides access to the entire Cloudflare API". "When you connect, you will be redirected to Cloudflare to authorize via OAuth and select the permissions to grant to your agent." It has two working tools, `search()` and `execute()`. **Inferred:** a per-tool permission on `execute` gates a DNS read and a Worker deploy alike, so the tool list can't tell a small act from a large one. How long that OAuth grant lasts is not stated on the page.
- **A token that can deploy a Worker can read what that Worker holds (inferred).** A Worker's code reads its secrets through "the `env` parameter passed to your Worker's `fetch` event handler", so code deployed to a Worker runs beside that Worker's secrets. For work on `fabrik-console`, a credential that can deploy the Console reaches everything the Console holds. The map's Notes quote the Console's own rule that "unmerged code never runs beside a credential that can reach production"; a minting token in the Console is such a credential.

## Sentry

Sources: [Auth Tokens](https://docs.sentry.io/account/auth-tokens/), [Authentication](https://docs.sentry.io/api/auth/), [Permissions & Scopes](https://docs.sentry.io/api/permissions/), [Internal Integrations](https://docs.sentry.io/integrations/integration-platform/internal-integration/) and the Sentry MCP server's own page at [mcp.sentry.dev](https://mcp.sentry.dev/llms.txt).

- **Three token types, all wide across projects.** Organization tokens "are bound to an organization, and have access to all projects within that organization", with "a limited set of permissions" that "aren't customizable". Internal integration tokens are also org-wide and "can be created with a custom set of permissions". Personal tokens "are bound to a user, and have access to all organizations and projects that user has access to."
- **Scopes cut by verb, not by project.** For issues: `event:read` for GET, `event:write` for PUT, `event:admin` for DELETE. Likewise `project:` and `org:`.
- **No expiry.** Internal integration tokens "do not expire automatically, but you can manually revoke them as needed." The Auth Tokens page gives no expiry for organization or personal tokens.
- **No minting by API in the pages read.** Each type is created in Sentry's settings. An internal integration holds "up to 20 tokens at a time".
- **OAuth is the short-lived route.** "Access tokens expire after 30 days. Use the refresh token to obtain new tokens". "The access token only provides access to the specific organization the user selected during the OAuth flow." It needs a client registered with Sentry ("Your registered client ID"). A device flow exists for "headless environments".
- **Sentry runs its own MCP server.** "All connections use OAuth." The URL can be "scoped to one organization" or "scoped to one project". The page says that when scoped, "tools automatically default to the constrained org/project and unnecessary discovery tools are hidden". It calls that a default, and doesn't say it is enforced.
- **What the Kit does today.** The Monitor's Sentry token lives in 1Password and is read by the push job's service account (ADR-0004).

**What that leaves.** Attach works with no Console part: a read-scoped internal integration token as a network secret for `sentry.io`. So does Act, with Sentry's server as a connector. Neither is short-lived. Mint has nothing to call.

## The general case: what a system must offer

| Pattern | The system must offer | Cloudflare | 1Password | Sentry |
| :- | :- | :- | :- | :- |
| **Mint** | An API that creates a credential, with an expiry, a scope narrower than the minter's, and a revoke | Yes | No | Not documented |
| **Attach** | A credential that travels as a request header to a public host | Yes | Connect only | Yes |
| **Act**, vendor's server | A remote MCP server with OAuth | Yes | No | Yes |
| **Act**, Console's server | Acts that are plain HTTPS calls a Worker can make with a held credential | Yes (**inferred**) | Not documented for a Worker | Yes (**inferred**) |
| **Tap** | Nothing from the vendor | n/a | n/a | n/a |

For a system outside these three, the same three questions sort it: can a credential be created by API with an expiry; does it travel as a header; does the vendor run a remote MCP server. A system that answers no to all three leaves Env, Job, or a Console-hosted server that holds its credential.

## Which patterns need the Console to grow a part

| Option | New in the Console | Already there |
| :- | :- | :- |
| Network secret per vendor | Nothing | n/a |
| Vendor's connector | Nothing | n/a |
| Tap in the Claude app on a vendor's connector | Nothing. The setting is claude.ai's. | n/a |
| Console-hosted MCP server that acts | A remote MCP endpoint; an OAuth authorization server claude.ai can sign in to (or the beta static header); the vendor credentials as Worker secrets | The Worker, the Durable Object, the Operator's sign-in |
| Tap in the Claude app on a Console tool | One annotation, `anthropic/requiresUserInteraction` | n/a |
| Tap in the Console | A pending-approval record, an approve screen, a gate before the mint or the act, and an answer to the five-minute idle window | Web push |
| Cloudflare mint broker | A minting token as a Worker secret; mint and delete calls; a delivery path | The Worker |
| Job | A dispatch per kind of act, if the Console starts it | The Operator's GitHub user access token, subject to #798 |

Two things about a tap that the docs let me say:

- **Where the prompt is drawn matters (inferred).** A prompt in the Claude app sits in the conversation the agent is writing. A Console push is drawn by the Console from what the broker received, on a channel the session can't write to. The docs don't compare the two.
- **A tap on every act is the thing Anthropic says wears out.** See the next section.

## Untrusted text beside power

An Operator session reads text someone else wrote: an issue body, a Monitor issue's quoted error message, a log, a web page. Production error text can carry whatever an End user typed (**inferred**). What Anthropic has published about an agent that holds real power while reading such text:

- **The risk is stated plainly.** "their behavior can be influenced by the content they process: files, webpages, or user input. This is sometimes called prompt injection." ([Securely deploying AI agents](https://code.claude.com/docs/en/agent-sdk/secure-deployment.md))
- **The first answer is where the credential is.** "if credentials never enter the sandbox, they can't be exfiltrated, regardless of whether the cause is a user, a model finding a “creative” path, or an attacker." ([How we contain Claude across products](https://www.anthropic.com/engineering/how-we-contain-claude), 2026-05-25)
- **Cloud sessions were built that way for git.** "We've designed this sandbox to ensure that sensitive credentials (such as git credentials or signing keys) are never inside the sandbox with Claude Code. This way, even if the code running in the sandbox is compromised, the user is kept safe from further harm." ([Beyond permission prompts](https://www.anthropic.com/engineering/claude-code-sandboxing), 2025-10-20)
- **The proxy is the documented way to do that.** "The recommended approach is to run a proxy outside the agent's security boundary that injects credentials into outgoing requests." And for other services: "Provide access through an MCP server or custom tool that routes requests to a service running outside the agent's security boundary." ([Securely deploying AI agents](https://code.claude.com/docs/en/agent-sdk/secure-deployment.md#credential-management))
- **An allowed host is a grant of power, not a filter.** After an exfiltration through an approved domain: "it may be better conceptualized as a capability grant. Every function reachable through any domain on an allowlist is now an attack surface." And: "If the agent has permissive credentials for an allowed domain, ensure it cannot use that domain to trigger other network requests or to exfiltrate data." (the containment post; the secure deployment guide)
- **Narrow power is deployable where wide power isn't.** "Granularly limiting tool permissions can help limit the blast radius. An agent with read-only DB access, for instance, can be deployed far more broadly than one that writes to prod." (the containment post)
- **Model-level defences are strong and not complete.** "Claude Opus 4.7 holds attack success to roughly 0.1% on single attempts, and around 5–6% after 100 adaptive attempts." "protection in the model layer will never be 100% effective, which is why it can't stand alone." (the containment post) "A 1% attack success rate—while a significant improvement—still represents meaningful risk." ([Mitigating the risk of prompt injections in browser use](https://www.anthropic.com/research/prompt-injection-defenses), 2025-11-24)
- **Auto mode is a layer, not the boundary.** It misses about 17% of overeager actions, and "is not a drop-in replacement for careful human review on high-stakes infrastructure." ([How we built Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode), 2026-03-25) Its default block list already covers much of an Operator session's work: "Production deploys and migrations", "Granting IAM or repo permissions", "Writing to a secret manager, or changing DNS records or TLS certificates", "Printing a live credential or token into the transcript or a file". ([What the classifier blocks by default](https://code.claude.com/docs/en/permission-modes.md#what-the-classifier-blocks-by-default))
- **A human approving each step wears out.** "Our telemetry showed users approved roughly 93% of permission prompts. The more approvals a user sees, the less attention they pay to each". (the containment post)
- **A trusted tool still returns untrusted text.** "Tool output is an attack surface even when the tool is trusted." "once a poisoned tool return has steered the agent into exfiltrating data, the log just shows a successful, authorized API call." (the containment post)
- **A remote tool can change after it was approved.** "A remote tool—a hosted MCP server, a cloud connector—can change behavior at any point after you've approved it". (the containment post) That bears on a vendor's connector.
- **What you build yourself is the weak part.** "Be wary of custom components." "the standard primitives held while our own work around them exposed flaws." "Our custom allowlist proxy was the piece that failed." (the containment post) That bears on a Console-built broker or proxy.
- **The order Anthropic gives.** "Design for containment at the environment layer first, then steer behavior at the model layer." "The deterministic boundary is what gets hit when everything probabilistic misses." (the containment post)
- **On who decides.** Users "can configure permissions (e.g., always allow, needs approval, block) for each action Claude takes", and Anthropic encourages customers "to think carefully about which tools and data they provide to an agent, which permissions they grant, and which environments they let the agents operate in." ([Trustworthy agents in practice](https://www.anthropic.com/research/trustworthy-agents), 2026-04-09)

None of these posts addresses the exact case of an agent holding an admin credential for a third-party system while reading a quoted production error. The statements above are the nearest published guidance.

## What stays unknown

1. **Whether network secrets can be managed by anything but the claude.ai dialog.** No API or CLI is documented, so a per-session or expiring network secret has no documented way to exist.
2. **Whether the agent proxy replaces an `Authorization` header a tool already sent.** It decides whether Wrangler or `sentry-cli` can run on a placeholder token. Documented for GitHub only.
3. **Which network secret types exist beyond Bearer and custom headers.** The page points at a list without giving it.
4. **Whether a personal account's "Needs approval" setting on a connector tool is enforced in a cloud session.** The Claude Code docs describe the every-call prompt as an organization's control. The `requiresUserInteraction` annotation is documented without that limit.
5. **Whether a permission prompt or an elicitation card in a cloud session can be answered from the iOS app,** and whether anything notifies the phone. No push is documented.
6. **How long a session waits on a prompt before it expires.** The docs say it can, not when.
7. **Whether a token minted by an account-owned Cloudflare token is bounded by the minter's own policies.** For user tokens the docs say it isn't. For account tokens they bound the member, and are silent on the token.
8. **Whether Cloudflare enforces a lower bound on `expires_on`,** and how long an OAuth grant to Cloudflare's or Sentry's MCP server lasts.
9. **Whether Sentry has any API that creates a token,** and whether its MCP server's URL scoping is enforced or only a default.
10. **Whether 1Password's JavaScript SDK runs on a Cloudflare Worker,** and whether the service account wizard on 1Password.com works on a phone.
11. **Which addresses a cloud session's requests leave from.** Anthropic publishes outbound ranges "for example, when making MCP tool calls to external servers". The cloud session docs say only "from Anthropic's network". It decides whether a Cloudflare IP condition could pin a token to cloud sessions at all, and those ranges are shared by every Anthropic customer.
12. **None of this was run.** Every "works" above is the docs' word. The combinations marked inferred are untested.

## Sources

Claude Code and Claude (fetched 2026-11-19):

- [Configure cloud environments](https://code.claude.com/docs/en/cloud-environments.md)
- [Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web.md)
- [Security](https://code.claude.com/docs/en/security.md)
- [Choose a permission mode](https://code.claude.com/docs/en/permission-modes.md)
- [Configure permissions](https://code.claude.com/docs/en/permissions.md)
- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp.md)
- [Hooks reference](https://code.claude.com/docs/en/hooks.md)
- [Channels reference](https://code.claude.com/docs/en/channels-reference.md)
- [Automate work with scheduled tasks](https://code.claude.com/docs/en/routines.md)
- [Claude Code on mobile](https://code.claude.com/docs/en/mobile.md)
- [Securely deploying AI agents](https://code.claude.com/docs/en/agent-sdk/secure-deployment.md)
- [Add a connector that isn't in the directory](https://claude.com/docs/connectors/custom/add-unlisted)
- [Get started with connectors](https://claude.com/docs/connectors/getting-started)
- [Authentication for connectors](https://claude.com/docs/connectors/building/authentication)
- [IP addresses](https://platform.claude.com/docs/en/api/ip-addresses)

Anthropic's published guidance:

- [Beyond permission prompts: making Claude Code more secure and autonomous](https://www.anthropic.com/engineering/claude-code-sandboxing) (2025-10-20)
- [Mitigating the risk of prompt injections in browser use](https://www.anthropic.com/research/prompt-injection-defenses) (2025-11-24)
- [How we built Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode) (2026-03-25)
- [Trustworthy agents in practice](https://www.anthropic.com/research/trustworthy-agents) (2026-04-09)
- [How we contain Claude across products](https://www.anthropic.com/engineering/how-we-contain-claude) (2026-05-25)

1Password (1password.dev, fetched 2026-11-19):

- [Service Accounts](https://www.1password.dev/service-accounts), [Get started](https://www.1password.dev/service-accounts/get-started), [security](https://www.1password.dev/service-accounts/security), [manage](https://www.1password.dev/service-accounts/manage-service-accounts), [rate limits](https://www.1password.dev/service-accounts/rate-limits)
- [`op service-account`](https://www.1password.dev/cli/reference/management-commands/service-account), [`op item`](https://www.1password.dev/cli/reference/management-commands/item)
- [Secrets Automation](https://www.1password.dev/secrets-automation), [Connect security](https://www.1password.dev/connect/security), [Manage Connect](https://www.1password.dev/connect/manage-connect), [Get started with Connect](https://www.1password.dev/connect/get-started)
- [Credential Broker](https://www.1password.dev/brokered-access), [custom workflows](https://www.1password.dev/brokered-access/custom-workflow)
- [Use 1Password with AI agents](https://www.1password.dev/security-for-ai), [Environments MCP server](https://www.1password.dev/environments/mcp-server), [NVIDIA OpenShell](https://www.1password.dev/environments/nvidia-openshell), [SDKs](https://www.1password.dev/sdks)

Cloudflare (fetched 2026-11-19):

- [Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [Create tokens via API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/), [Restrict tokens](https://developers.cloudflare.com/fundamentals/api/how-to/restrict-tokens/), [Roll tokens](https://developers.cloudflare.com/fundamentals/api/how-to/roll-token/)
- [Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/), [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/), [API token templates](https://developers.cloudflare.com/fundamentals/api/reference/template/)
- API reference: [create an account token](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/), [delete an account token](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/delete/), [create a user token](https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/create/)
- [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/), [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Wrangler system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/)
- [Cloudflare's own MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)

Sentry (fetched 2026-11-19):

- [Auth Tokens](https://docs.sentry.io/account/auth-tokens/), [Authentication](https://docs.sentry.io/api/auth/), [Permissions & Scopes](https://docs.sentry.io/api/permissions/), [Internal Integrations](https://docs.sentry.io/integrations/integration-platform/internal-integration/)
- [Sentry MCP server](https://mcp.sentry.dev/llms.txt)

This repo:

- [ADR-0004: AFK secrets come from 1Password](../adr/0004-afk-secrets-come-from-1password.md)
- `skills/fabrik-pair/SKILL.md`
- [Which Anthropic surfaces let the Operator reach Claude Code from anywhere?](remote-surfaces.md) (2026-11-02), as a starting point only
