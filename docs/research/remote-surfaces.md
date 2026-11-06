# Which Anthropic surfaces let the Operator reach Claude Code from anywhere?

Research for [#7](https://github.com/jrey8343/fabrik/issues/7). Date: 2026-11-02.

**Question.** Which Anthropic surfaces let the Operator reach Claude Code from anywhere (iPhone, web, terminal), and what can each do in Fabrik's Loop?

**Method.** Desk research only. I read the current Claude Code docs at code.claude.com (raw `.md` pages fetched 2026-11-02), and the `anthropics/claude-code-action` repo (`main`, last commit 2026-10-31: `action.yml`, `docs/capabilities-and-limitations.md`, `docs/faq.md`). I also read the local `../sandcastle` clone (`docs/guide/`) to check what a Sandbox needs. Nothing was installed or run. Anything marked **inferred** is my reasoning from the docs, not a documented capability.

## Answer

- **Every surface below runs on the Operator's claude.ai subscription.** None needs a Console API key, and most can't use one. Two surfaces run with the laptop shut and need no ops: cloud sessions (including runs that cloud scheduled tasks, formerly *routines*, start) and GitHub Actions.
- **Two surfaces can start work from a GitHub label.** Cloud scheduled tasks have a GitHub trigger that covers `issue.labeled`, and `claude-code-action` has a `label_trigger` input that fires on `issues: labeled`. Cloud sessions, the iOS app, Remote Control and Slack can't.
- **The iOS app is a client, not a place where code runs.** Its Code tab drives cloud sessions, Projects, Remote Control sessions and Dispatch.
- **Push notifications are the weak spot.** Only Remote Control and Desktop Dispatch send native phone pushes. A cloud session started from the web, the app, a scheduled task or Slack doesn't document one. Slack notifies through Slack, and the Action notifies through GitHub.
- **No Anthropic surface knows about Sandcastle.** A Sandbox has to be launched by whatever host runs Sandcastle: the Operator's machine (Remote Control), a GitHub Actions runner, or (inferred, unverified) Docker inside a cloud-session VM. Note that a cloud session is already an isolated VM, so it could serve as the Sandbox itself.

## Comparison

| Surface | Where the agent runs | Uses the Max/Ultra subscription | GitHub event trigger (label, comment) | Multi-round HITL | Sandcastle Sandboxes | Push to the Operator | Plan and availability limits |
| :- | :- | :- | :- | :- | :- | :- | :- |
| **Claude Code on the web** (cloud sessions, claude.ai/code) | Anthropic-managed VM, one per session (Ubuntu 24.04, 4 vCPU, 16 GB). Keeps running with the laptop shut. | Yes. Counts toward plan limits, with no separate VM charge. | No trigger to *start* a session. Auto-fix lets a running session react to CI failures and review comments on one PR. | Yes: a full chat on web, iOS, Desktop and terminal (`--cloud` / `--teleport`). | Not built in. Docker is in the VM, so Sandcastle's `docker()` provider could plausibly run there (inferred). | None documented. | Pro, Max, Ultra, Team, and Enterprise (premium seat). Shares rate limits. Commands get a 2–10 min foreground timeout plus 30 min in the background. Idle VMs pause and may be reclaimed. Clone, push and PR need GitHub. |
| **Claude iOS app** (Code tab) | Nowhere: it is a client for cloud sessions, Projects, Remote Control and Dispatch. | Needs a claude.ai sign-in. Usage is billed where the session runs. | No. | Yes, as a window onto any of those sessions. | Only through the session it drives. | Receives pushes from Remote Control and Dispatch. | No Bypass permissions mode from the app. Local-only commands such as `/plugin` and `/resume` don't work. Dispatch needs Pro, Max or Ultra. |
| **Remote Control** (`claude remote-control`) | The Operator's own machine (CLI, Desktop or VS Code). That machine must stay on with `claude` running. | Yes. claude.ai sign-in only, and API keys are not supported. | Not natively. A Channels webhook receiver can push events into the running session (research preview). | Yes, and the best of the six. Terminal, web and phone stay in sync. Permission prompts and `AskUserQuestion` stay open until answered. | Yes. Anything local, Sandcastle included, runs on the host. | **Yes**: "Push when Claude decides" and "Push when actions required" in `/config`. | All plans (Team and Enterprise need an admin to enable it). Server mode defaults to 32 concurrent sessions. Server mode exits after about 10 min offline. Unavailable behind a non-Anthropic `ANTHROPIC_BASE_URL`. |
| **Cloud scheduled tasks** (formerly routines) | Each run is a fresh cloud session on Anthropic's VMs. | Yes. Can fall back to **metered overage** if usage credits are turned on. | **Yes**: PR, issue and release events, including `labeled`. PR filters include labels. Also cron and a tokened `/fire` API. | Runs start AFK in auto mode. The Operator can open any run and keep chatting. | Same as cloud sessions. | None documented. | Research preview. 100 scheduled runs/h per account. 30 manual or API runs/h per task. 100 API fires/h per account. Unpublished hourly caps on GitHub events (excess events are dropped). Needs the Claude GitHub App. |
| **Claude GitHub App + `claude-code-action`** | A GitHub Actions runner (GitHub-hosted or self-hosted). | Yes, through `claude_code_oauth_token` (a one-year token from `claude setup-token`). Also uses **GitHub Actions minutes**. | **Yes**: any workflow event, including `label_trigger`, `assignee_trigger` and `@claude` comments. | Turn-based: each `@claude` comment starts a new, stateless run that re-reads the thread and updates one comment. | Yes (inferred): the runner has Docker, so a workflow step can run Sandcastle with `CLAUDE_CODE_OAUTH_TOKEN`. | Through GitHub notifications on `claude[bot]` comments. | Rejects bot actors unless they are listed in `allowed_bots`. The token is tied to one person's subscription. Code Review (the managed reviewer) is Team and Enterprise only. |
| **Claude Code in Slack** | It creates a cloud session on Anthropic's infrastructure. | Yes, under the user's own account and plan limits. | No. Only an `@Claude` mention in a channel. | Starts from thread context. Follow-up happens in the cloud session ("View Session"). | Same as cloud sessions. | Through Slack: status updates in the thread and an @mention on completion. | The "earlier version": Pro, Max and Ultra only, in a workspace not connected to Claude Tag. Channels only, no DMs. Needs cloud sessions enabled. |

Plan naming: **Ultra is the new name for Max 20x, and Max is the new name for Max 5x.** In Claude Code, Max and Ultra have the same features ([feature availability](https://code.claude.com/docs/en/feature-availability.md#ultra-plan)). The map's "Max x20" is now **Ultra**.

## Per-surface notes and sources

### Claude Code on the web (cloud sessions)

- **Where it runs and how it's billed.** A cloud session runs on Anthropic-managed infrastructure by default and keeps running after the laptop closes. It counts toward plan usage with no separate VM charge. Sessions can be started from the browser, the mobile Code tab, Desktop, `claude --cloud`, or by a scheduled task. [cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web.md)
- **Isolation.** Each session gets its own VM. Git credentials and signing keys stay outside the sandbox behind a proxy. "Network secrets" are attached to matching outbound requests and never enter the VM. [Security and isolation](https://code.claude.com/docs/en/claude-code-on-the-web.md#security-and-isolation); [Add network secrets](https://code.claude.com/docs/en/cloud-environments.md#add-network-secrets)
- **VM specs.** Ubuntu 24.04 x86_64 with 4 vCPUs and 16 GB RAM. Docker and docker compose are preinstalled. A setup script is snapshotted and cached when it finishes in about 5 minutes, and the cache expires after about 7 days. [cloud environments](https://code.claude.com/docs/en/cloud-environments.md#resource-limits)
- **Time limits.** Foreground Bash commands time out after 2 minutes by default (10 maximum), then move to the background for up to 30 more minutes. An idle VM pauses and may be reclaimed. [Time limits](https://code.claude.com/docs/en/cloud-environments.md#time-limits)
- **Auto-fix.** With auto-fix on, a session subscribes to a PR's CI failures and review comments. It pushes clear fixes and asks the Operator when a comment is ambiguous. It needs the Claude GitHub App, and it can't see base-branch merge conflicts. It also posts replies under the Operator's GitHub username. [Auto-fix pull requests](https://code.claude.com/docs/en/claude-code-on-the-web.md#auto-fix-pull-requests)
- **Shared rate limits.** Cloud sessions share rate limits with all other Claude usage, and parallel tasks consume them proportionately. [Limitations](https://code.claude.com/docs/en/claude-code-on-the-web.md#limitations)
- **Self-hosted environments.** Running cloud sessions on your own infrastructure is Team and Enterprise only (public beta). That rules it out for an individual Ultra plan. [self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments.md)
- **Projects (adjacent, beta).** One conversation coordinates parallel cloud threads. It is in public beta on Pro, Max and Ultra and rolling out gradually. Its notifications are desktop-only, and in a browser the only signal is the dot on the Overview button. [Projects](https://code.claude.com/docs/en/claude-projects.md)

### Claude iOS app

- **A client only.** "The Claude app ... is a client for Claude Code sessions rather than a place where code runs." Its Code tab reaches cloud sessions, Projects, Remote Control and Dispatch. If the laptop will be off, the docs point to cloud sessions or Projects. [mobile](https://code.claude.com/docs/en/mobile.md)
- **Limitations.** Cloud sessions offer the Accept edits, Plan and Auto permission modes, and Remote Control adds Manual. Bypass permissions can't be selected from the app. Dispatch isn't available on Team or Enterprise. [mobile: Limitations](https://code.claude.com/docs/en/mobile.md#limitations)
- **Push notifications.** The docs describe phone pushes only for Remote Control (shipped in week 16, April 2026) and for Dispatch. [mobile: Get push notifications](https://code.claude.com/docs/en/mobile.md#get-push-notifications); [What's new, week 16](https://code.claude.com/docs/en/whats-new/2026-w16.md)

### Remote Control

- **Runs locally.** The session runs on the Operator's machine. Web and mobile are "a window into that local session, so your computer has to stay on and the `claude` process has to keep running." On a remote box, the docs suggest running it inside `tmux` or `screen`. [Remote Control](https://code.claude.com/docs/en/remote-control.md)
- **Requirements.** Pro, Max, Ultra, Team or Enterprise (admin toggle on the last two). API keys are not supported. It is unavailable on Bedrock, Vertex and Foundry, and behind a non-Anthropic `ANTHROPIC_BASE_URL`. [Requirements](https://code.claude.com/docs/en/remote-control.md#requirements)
- **Server mode.** `--spawn worktree` gives each session its own git worktree, and `--capacity` defaults to 32. Server mode exits after about 10 minutes without network. [Start a Remote Control session](https://code.claude.com/docs/en/remote-control.md#start-a-remote-control-session); [Limitations](https://code.claude.com/docs/en/remote-control.md#limitations)
- **Push notifications.** Two `/config` toggles control them. "Claude decides when to push", and there's no per-event configuration. [Mobile push notifications](https://code.claude.com/docs/en/remote-control.md#mobile-push-notifications)
- **Channels (adjacent, research preview).** A channel is an MCP server that pushes Telegram, Discord or iMessage messages, or your own webhooks, into a running local session. It can be two-way and can relay permission prompts. Events only arrive while the session is open. [Channels](https://code.claude.com/docs/en/channels.md)

### Cloud scheduled tasks (formerly routines)

- **What they are.** A saved prompt, a set of repos and a set of connectors, run on Anthropic cloud with schedule, API or GitHub triggers. They are in research preview on Pro, Max, Ultra, Team and Enterprise. [scheduled tasks](https://code.claude.com/docs/en/routines.md)
- **GitHub triggers.** Supported events are pull request (including `labeled`), issue (including `labeled`) and release. "Claude Code doesn't reuse sessions across events". Webhook events are subject to per-task and per-account hourly caps, and excess events are dropped. The trigger requires the Claude GitHub App (`/web-setup` alone doesn't install it). [Add a GitHub trigger](https://code.claude.com/docs/en/routines.md#add-a-github-trigger)
- **Label filters cover pull requests only.** The documented filters (author, title, body, branches, **labels**, draft, merged) are listed only for pull requests. The docs list no filters for issue events, so a task triggered on `issue.labeled` would have to check the label itself, and every matching issue event starts a session. [Filter pull requests](https://code.claude.com/docs/en/routines.md#filter-pull-requests)
- **Permissions and HITL.** A run starts in auto mode and stops for ask rules or repeated blocks. The Operator can open any run as a full session and continue the conversation. [Permission prompts during a run](https://code.claude.com/docs/en/routines.md#permission-prompts-during-a-run); [View and interact with runs](https://code.claude.com/docs/en/routines.md#view-and-interact-with-runs)
- **Usage and overage.** Runs draw down the subscription the same way interactive sessions do. Hourly limits apply: 100 scheduled runs, 100 API fires, and 30 "Run now" or API runs per task. **"Organizations with usage credits turned on can keep running scheduled tasks on metered overage"**. Otherwise runs are rejected until the window resets. [Usage and limits](https://code.claude.com/docs/en/routines.md#usage-and-limits)

### Claude GitHub App and `claude-code-action`

- **Two modes.** In interactive mode, the action responds to `@claude` in comments, reviews, or a new issue's title or body. In automation mode, a `prompt` input runs it on any workflow event. [GitHub Actions](https://code.claude.com/docs/en/github-actions.md#interactive-and-automation-modes)
- **Inputs.** `action.yml` defines `label_trigger`, `assignee_trigger`, `trigger_phrase`, `allowed_bots`, `claude_code_oauth_token` and `track_progress`. `track_progress` covers issue `labeled` and `assigned` events. [action.yml](https://github.com/anthropics/claude-code-action/blob/main/action.yml)
- **Subscription auth.** `CLAUDE_CODE_OAUTH_TOKEN` is available on Pro, Max, Ultra, Team and Enterprise, and is generated by `claude setup-token` with a one-year lifetime. With an OAuth token, "runs use your Claude subscription instead of API billing", but they still consume GitHub Actions minutes. The token is tied to the subscription of whoever minted it. [Manual setup](https://code.claude.com/docs/en/github-actions.md#manual-setup); [Manage costs](https://code.claude.com/docs/en/github-actions.md#manage-costs); [Generate a long-lived token](https://code.claude.com/docs/en/authentication.md#generate-a-long-lived-token)
- **Who can trigger a run.** The triggering user needs write access, and **bot actors are rejected unless listed in `allowed_bots`**. [Who can trigger runs](https://code.claude.com/docs/en/github-actions.md#who-can-trigger-runs) Separately, GitHub doesn't start workflows for events caused by the default `GITHUB_TOKEN`, so pushes or labels made with it won't trigger other workflows. [Troubleshooting](https://code.claude.com/docs/en/github-actions.md#ci-not-running-on-claudes-commits); [GitHub: triggering a workflow from a workflow](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow)
- **One comment per run.** The action updates a single comment, can't approve PRs or submit formal reviews, and can't merge. [capabilities-and-limitations.md](https://github.com/anthropics/claude-code-action/blob/main/docs/capabilities-and-limitations.md)
- **Managed Code Review.** It runs on Anthropic infrastructure through the GitHub App, but only on Team and Enterprise, so it is unavailable on Ultra. [feature availability](https://code.claude.com/docs/en/feature-availability.md#availability-by-subscription-plan)
- **Policy on OAuth tokens.** OAuth is for "ordinary use of Claude Code and other native Anthropic applications". Developers may not route requests through Free, Pro, Max or Ultra credentials on behalf of their users. The Operator using their own token on their own repos fits this. A Kit that ships or collects tokens for others would not. [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md#authentication-and-credential-use)

### Claude Code in Slack

- **The earlier version.** This version answers channel @mentions only from Pro, Max and Ultra accounts, in workspaces no organization has connected to Claude Tag. Team and Enterprise move to Claude Tag. [Slack](https://code.claude.com/docs/en/slack.md)
- **Session flow.** A mention creates a cloud session on claude.ai/code. Claude posts progress to the thread, then @mentions the user on completion with View Session and Create PR buttons. It works in channels only, not DMs, and counts against the user's plan limits. [How it works](https://code.claude.com/docs/en/slack.md#how-it-works)

### Sandcastle (for the Sandbox column)

- **Auth.** Sandcastle authenticates the agent with `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY` in `.sandcastle/.env`. (`../sandcastle/docs/guide/getting-started.md`)
- **Providers.** It ships native providers (`bwrap` on Linux, `seatbelt` on macOS), Docker, Podman, Vercel and Daytona. Ubuntu 24.04 blocks `bwrap`'s user namespaces until an AppArmor profile is added. (`../sandcastle/docs/guide/sandbox-providers.md`)
- **Inferred: Sandcastle inside a cloud session.** A cloud session could run Sandcastle's `docker()` provider, but only if the OAuth token is set as an environment variable the session can read. Network secrets are injected outside the VM, so they can't supply it. This is undocumented and untested.

## What looks promising

### (a) Triggering AFK runs from GitHub labels

1. **GitHub Actions on `issues: labeled`, filtered to `ready-for-agent`.** This is the most mature and deterministic option. It runs with the laptop shut and needs no server. It can run `claude-code-action` directly, or a plain step that runs Sandcastle on the runner with the Operator's `CLAUDE_CODE_OAUTH_TOKEN`. The Reviewer fits the same pattern on `pull_request` events.
   - *Cost:* GitHub Actions minutes, on top of subscription usage.
   - *Catch:* when the AFK Triage agent applies the label, it must apply it with an App token, not `GITHUB_TOKEN`, or no workflow fires. That bot must also be listed in `allowed_bots`, or the action rejects the run.
2. **A cloud scheduled task with a GitHub trigger on `issue.labeled`.** This needs zero infrastructure and no Actions minutes, and the Implementer gets an isolated Anthropic VM. That VM arguably *is* the Sandbox. Turning on auto-fix covers CI failures and review comments.
   - *Catches:* the feature is in research preview, and GitHub-event hourly caps are unpublished (excess events are dropped). Issue events have no label filter, so every issue edit wakes a session that must exit cheaply. Whether bot-applied labels fire the trigger is undocumented. Usage credits must stay **off** so runs can't spill into metered overage.

A hybrid is possible: an Actions workflow filters the label precisely, then POSTs to a scheduled task's `/fire` endpoint with the issue number in `text`. Actions handles exact triggering and the cloud VM does the work.

### (b) Multi-round HITL Design sessions from a phone

1. **A cloud session in the iOS app's Code tab.** A scheduled task on `needs-design` could start it, or the Operator could start it directly. It is a real multi-round chat that survives the laptop being shut and can be resumed from any device.
   - *Gap:* there is no documented push. The session should therefore post its first question, and a link to itself, as a comment on the issue, so GitHub mobile notifies the Operator. It must write the resulting tickets back to GitHub.
2. **Remote Control on an always-on host** (a spare Mac or a VPS running `claude remote-control --spawn worktree` in tmux). This gives the best phone experience: native pushes ("Push when actions required"), and `AskUserQuestion` prompts that stay open until answered.
   - *Catch:* it breaks "works with the Operator's laptop shut" unless a dedicated box is kept running, which is ongoing ops.
3. **Asynchronous grilling in issue comments through `claude-code-action`.** Each Operator reply mentioning `@claude` starts a fresh run that re-reads the thread and asks the next question.
   - *Upside:* the whole Design session lives in GitHub, the system of record, and GitHub mobile notifies on each reply.
   - *Downsides:* every turn cold-starts a runner and costs minutes, and the action is limited to updating one comment per run.

Slack is the weakest fit. Fabrik would depend on a legacy-labelled, individual-plan-only integration that lives outside GitHub.

## Open questions (would need a prototype)

- Does a scheduled task's `issue.labeled` trigger fire when a bot (the Claude GitHub App or another App) applies the label?
- What are the per-task and per-account GitHub-event hourly caps?
- Can Sandcastle's `docker()` provider run inside an Anthropic cloud VM, and is a nested Sandbox worth it there?
- Can a cloud session started by a scheduled task send any push to the iOS app, or must notifications go through GitHub or Slack?
