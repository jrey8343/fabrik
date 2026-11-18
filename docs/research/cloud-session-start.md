# What can a cloud session be started with, and from where?

Research for [#797](https://github.com/jrey8343/fabrik/issues/797), a Decision on the map [#796](https://github.com/jrey8343/fabrik/issues/796). Date: 2026-11-19.

**Question.** What can a Claude Code cloud session be started with, and from where, when the Operator starts it from the Console on an iPhone with no machine of their own running?

**Method.** Desk research only, against primary sources fetched on 2026-11-19:

- Claude Code's docs at code.claude.com (the raw `.md` form of each page, found from [the index](https://code.claude.com/docs/llms.txt)).
- The [Claude Code changelog](https://code.claude.com/docs/en/changelog), generated from `anthropics/claude-code`'s `CHANGELOG.md`. Its newest entry is 2.1.327, dated 17 November 2026.
- The [routine fire API reference](https://platform.claude.com/docs/en/api/claude-code/routines-fire) on platform.claude.com.
- Anthropic's connector and plugin docs at claude.com/docs.
- Anthropic's support pages at support.claude.com.

Nothing was installed, run or tried on a phone. Every fact below quotes the passage behind it. **Inferred** marks my reasoning from the docs, not something they say. "The docs are silent" means I looked and found nothing.

This re-checks [`remote-surfaces.md`](./remote-surfaces.md) (2026-11-02). [What changed since then](#what-changed-since-2026-11-02) lists the differences.

## Answer

A hand-off from the Console to a cloud session has two documented forms, and neither carries everything.

- **A link** (`https://claude.ai/code?...`) carries the prompt, one or several repositories and the cloud environment. It carries no branch, model, effort or permission mode. It fills in the new-session form and sends nothing, so the Operator still taps send in Claude's own UI. Nothing comes back to the Console.
- **A scheduled task's `/fire` endpoint** starts a session with no tap in Claude's UI and returns the session's URL. Its repositories, model, effort, environment and connectors are fixed when the task is saved. A fire can add only free text, which reaches the session labelled as untrusted data. It needs a bearer token that can do nothing but fire that one task.

What holds for both:

- **Model and effort** can be changed inside a running cloud session with `/model <name>` and `/effort <level>`. Fable is selectable and included on Max and Ultra, up to half the weekly limit.
- **The CLI's `--cloud` is ruled out** with no machine of the Operator's running. It needs a claude.ai login whose grant lasts 30 days, and the docs say there is no long-lived token for it.
- **A single-repo session** loads the repo's `.claude/skills/`, its `.claude/settings.json` hooks and its `.mcp.json`. **A session with several repos** loads none of the hooks, permission rules or `.mcp.json` servers.
- **The Kit's SessionStart hook has two documented problems in a cloud session.** It doesn't run in a session with several repos. And it downloads Fabrik from `codeload.github.com`, which the docs say returns a 403 for any repository not attached to the session, public ones included.
- **`gh issue` and `gh pr` don't work in a cloud session.** The GitHub proxy rejects GraphQL, whatever token is supplied. `gh api` against REST works, for attached repos only.
- **The Operator's own MCP server** reaches a cloud session best as a custom connector on their claude.ai account. It authenticates by OAuth outside the session's VM.
- **Nothing outside a session can read its state** through a documented API. The session can report on itself: through hooks, and through the session URL it writes into every commit and pull request body.
- **A long pairing** runs in Accept edits, Plan or Auto mode. An idle VM pauses after "a few minutes" and is later reclaimed, with no number given. It draws on the same plan limits as everything else.

## What a hand-off can carry

| | A link to `claude.ai/code` | `/fire` on a scheduled task |
| :- | :- | :- |
| Repositories | Yes, one or several (`repositories`) | Fixed in the task, one or several |
| Branch | No parameter | The default branch, unless the saved prompt says otherwise |
| First prompt | Yes (`prompt`, or `prompt_url`), filled in and not sent | The saved prompt, plus up to 65,536 characters of `text` that arrives as untrusted data |
| Model | No parameter | Fixed in the task |
| Effort | No parameter | Fixed in the task |
| Cloud environment | Yes (`environment`) | Fixed in the task |
| Permission mode | No parameter | Starts in auto mode |
| Taps in Claude's UI | At least one, to send | None |
| Returns the session's URL | No | Yes |
| Credential | The Operator's claude.ai sign-in, in the browser or app | A per-task bearer token |
| Status | Documented, no preview label | Research preview |

## A link

### The parameters

The docs give a pre-fill URL for a new cloud session:

> You can prefill the prompt, repositories, and environment for a new session by adding query parameters to the claude.ai/code URL. Use this to build integrations such as a button in your issue tracker that opens Claude Code with the issue description as the prompt.

| Parameter | What the docs say |
| :- | :- |
| `prompt` | "Prompt text to prefill in the input box. The alias `q` is also accepted." |
| `prompt_url` | "URL to fetch the prompt text from, for prompts too long to embed in a query string. The URL must allow cross-origin requests. Ignored when `prompt` is also set." |
| `repositories` | "Comma-separated list of `owner/repo` slugs to preselect. The alias `repo` is also accepted." |
| `environment` | "Name or ID of the environment to preselect." |

The example is `https://claude.ai/code?prompt=Fix%20the%20login%20bug&repositories=acme/webapp`, which "opens the form with a prompt and a repository already selected". Source: [Pre-fill sessions](https://code.claude.com/docs/en/web-quickstart#pre-fill-sessions).

- **These four are the whole table.** There is no parameter for branch, model, effort or permission mode.
- **The link sends nothing.** The wording is "prefill" and "opens the form". That the Operator must still tap send is **inferred** from that wording. The page doesn't say it outright.
- **No length limit is documented** for `prompt`. `prompt_url` exists "for prompts too long to embed in a query string".

### What the Operator still picks by hand

- **Branch.** "At claude.ai/code, to start Claude from a feature branch instead of the default, change the branch in the control after the repository selector." ([Start a task](https://code.claude.com/docs/en/web-quickstart#start-a-task)). In the app: "From the Code tab, select a repository and branch, describe the task, and submit it." ([mobile](https://code.claude.com/docs/en/mobile#start-and-monitor-cloud-sessions)).
- **Permission mode.** "On claude.ai/code, use the mode dropdown in the row under the prompt box. In the mobile app, tap the **+** button in the prompt box, then **Permission**." ([Switch permission modes](https://code.claude.com/docs/en/permission-modes#switch-permission-modes)).
- **Model and effort.** The docs mention "the model menu on the message box", and place it "In the browser at claude.ai/code" ([fast mode](https://code.claude.com/docs/en/fast-mode#use-fast-mode-in-cloud-sessions)). They are silent on which model a new cloud session starts on, and on whether the iOS app's new-session screen has model and effort pickers.

### Whether it opens in the Claude iOS app

One sentence covers it:

> Tap **Code** in the app's navigation to reach your sessions, or open claude.ai/code/new on your phone to start a new Code session in the app.

Source: [mobile, Get the app](https://code.claude.com/docs/en/mobile#get-the-app).

- **Documented:** `claude.ai/code/new`, opened on a phone, starts a new Code session in the app.
- **The docs are silent** on whether the pre-fill parameters survive into the app's new-session screen. The pre-fill section speaks only of "the claude.ai/code URL".
- **The docs are silent** on a link followed from a web app installed to the home screen. Whether iOS hands such a link to the Claude app, to Safari or to a browser sheet inside the Console is not covered by any Anthropic page.
- **The other link schemes don't apply.** `claude-cli://` opens "a new terminal window" on "the computer where you clicked" ([deep links](https://code.claude.com/docs/en/deep-links)). The `claude://` scheme the docs describe belongs to Claude Desktop.

### A way to carry model and effort by link (inferred, untested)

**Inferred.** A cloud environment's variables become "ordinary environment variables that any command Claude runs can read" ([Set environment variables](https://code.claude.com/docs/en/cloud-environments#set-environment-variables)). The docs also say "To change a setting for a cloud session, set an environment variable on the environment" ([Manage context](https://code.claude.com/docs/en/claude-code-on-the-web#manage-context)). `ANTHROPIC_MODEL` sets the model and `CLAUDE_CODE_EFFORT_LEVEL` the effort ([model configuration](https://code.claude.com/docs/en/model-config#setting-your-model)). So an environment per model and effort pair, chosen by the link's `environment` parameter, might carry both.

Two cautions. The docs never show this for a cloud session, and the model picker on the form may win. And `CLAUDE_CODE_EFFORT_LEVEL` is first in the effort order, above "A level you pick in the session", so an effort set this way could not be changed with `/effort` afterwards ([Adjust effort level](https://code.claude.com/docs/en/model-config#adjust-effort-level)).

## An API

### A scheduled task's `/fire` endpoint

A cloud scheduled task (formerly a routine) is "a saved Claude Code configuration: a prompt, one or more repositories, and a set of connectors". One of its triggers is "**API**: trigger on demand by sending an HTTP POST to the task's own endpoint with a bearer token" ([scheduled tasks](https://code.claude.com/docs/en/routines)).

**What it starts with.** All of it is saved on the task beforehand:

- **Prompt.** "When a trigger fires, the session receives the saved prompt as its assignment and carries it out". And: "The fired prompt is therefore not live user input and can't act as approval or consent for actions during the run." ([Create from the web](https://code.claude.com/docs/en/routines#create-from-the-web)).
- **Repositories.** "select one or more GitHub repositories for Claude to work in." "Claude starts from the repository's default branch unless your prompt specifies otherwise." ([Repositories and branch permissions](https://code.claude.com/docs/en/routines#repositories-and-branch-permissions)).
- **Model and effort.** "Select a model in the prompt input's model selector for Claude to use on every run. For a Claude Code task, if the model offers effort levels, **Effort** in the same selector shows the current level." The changelog dates the effort picker to 2.1.312 (27 October 2026): "Added an effort level to the model picker when you create or edit a routine that runs in the cloud".
- **Environment and connectors.** One cloud environment per task. "All of your connected MCP connectors are included by default."
- **Permission mode.** Not chosen: "that session begins in auto mode unless auto mode is unavailable" ([Permission prompts during a run](https://code.claude.com/docs/en/routines#permission-prompts-during-a-run)).

**What a fire can add.** One field:

> The request body accepts an optional `text` field for run-specific context such as an alert body or a failing log, passed to the task alongside its saved prompt. The value is freeform text and is not parsed

> It arrives wrapped in a `<routine-fire-payload>` block that labels it as untrusted data and tells Claude not to follow instructions inside it unless the routine's own prompt says to.

> This means a routine's saved prompt must opt in to acting on fire text

Source: [Trigger a scheduled task](https://code.claude.com/docs/en/routines#trigger-a-scheduled-task). The API reference adds "Maximum 65,536 characters" and "Unknown fields in the body are ignored" ([routines-fire](https://platform.claude.com/docs/en/api/claude-code/routines-fire)).

So a fire can't choose the repo, model or effort. **Inferred:** a hand-off through `/fire` needs one saved task per combination of repository, model and effort the Console offers, or one per repository with the model and effort [changed once the session runs](#model-and-effort).

**What it returns.** The session, at once:

```json
{
  "type": "routine_fire",
  "claude_code_session_id": "session_01HJKLMNOPQRSTUVWXYZ",
  "claude_code_session_url": "https://claude.ai/code/session_01HJKLMNOPQRSTUVWXYZ"
}
```

"The request returns once the session is created. It does not stream session output or wait for the session to complete." The reference describes the URL as "A link to the session on claude.ai. Open it in a browser to watch the run, review changes, or continue the conversation."

**The credential.**

- "Authenticate with a per-routine bearer token created in the Claude Code web UI rather than a Claude API key." The token is prefixed `sk-ant-oat01-`.
- "A compromised token can only trigger that routine; it grants no read access, no access to other routines, and no access to account data."
- "The token is shown once and can't be retrieved later". "Generating a new token revokes the previous one."
- "You can't add an API trigger or manage its token from the CLI." It is set up at `claude.ai/code/routines`.

**Limits and standing.**

- "each routine accepts up to 30 fires per hour (shared across API fires, the **Run now** button in the web UI, and one-shot re-arms), and each account can make up to 100 API fires per hour across all routines."
- "Each successful request creates a new session. There is no idempotency key."
- Billing is "Claude Code subscription usage on claude.ai". One catch for a subscription-only design: "organizations with usage credits turned on can keep running scheduled tasks on metered overage" ([Usage and limits](https://code.claude.com/docs/en/routines#usage-and-limits)).
- "Scheduled tasks are in research preview. Behavior, limits, and the API surface may change." The endpoint "is available to claude.ai users only and is not part of the Claude Platform API surface."
- The task's sessions act as the Operator: "Anything a scheduled task does through your connected GitHub identity or connectors appears as you."

### A GitHub event

A scheduled task can also start from a GitHub event, with no call to Anthropic at all.

- "A GitHub trigger starts a new session automatically when a matching event occurs on a connected repository." The Issue event fires when "An issue is opened, edited, closed, reopened, labeled, assigned, or otherwise updated".
- "The Claude GitHub App must be installed on the repository you want to subscribe to".
- "GitHub webhook events are subject to per-task and per-account hourly caps. Events beyond the limit are dropped until the window resets." The caps are not published.
- The documented filters are listed under "Filter pull requests" only. The docs list none for issue events.

Source: [Add a GitHub trigger](https://code.claude.com/docs/en/routines#add-a-github-trigger). **Inferred:** the Console could start a session by labelling an issue with the credential it already holds, but nothing returns the session's URL to it. The session would have to post its own link.

### The CLI's `--cloud`

`claude --cloud "task"` "creates a new cloud session on claude.ai" and "works with a single repository at a time" ([Start a cloud session from your terminal](https://code.claude.com/docs/en/claude-code-on-the-web#start-a-cloud-session-from-your-terminal)). It is no use without a machine holding the Operator's login:

> Both `claude -p ... --environment` and `claude -p ... --cloud` authenticate with a claude.ai OAuth token; API keys, such as `sk-ant-xxxxx`, aren't accepted for either call.

> There is no long-lived CI token for this today. The scope that grants cloud-session control, `user:sessions:claude_code`, is capped server-side at 30 days, so `claude setup-token`, which mints a one-year inference-only token, doesn't cover it.

> the underlying refresh-token grant is capped at 30 days from the initial login, so re-run `claude auth login` interactively on that host every 30 days.

Source: [Authenticate from CI](https://code.claude.com/docs/en/self-hosted-environments-testing#authenticate-from-ci). So an Actions runner can't create or message a cloud session with the token the Kit's AFK runs use.

Two smaller facts about the CLI:

- **Creating a session with JSON output is documented only for self-hosted environments.** `claude -p "<prompt>" --environment <id> --output-format json` prints `{"ok":true,"session_id":"session_...","title":"...","url":"...","pool_id":"..."}`. Self-hosted environments are Team and Enterprise only.
- **A follow-up can be sent to a running session.** `claude -p "your message" --cloud <session-id>` "queues the message into the session and exits without waiting for a reply", and with `--output-format json` prints `{ok, session_id, url}` ([Send follow-ups from the CLI](https://code.claude.com/docs/en/claude-code-on-the-web#send-follow-ups-from-the-cli)). It needs the same 30-day login.

The docs are silent on whether `--cloud` honours `--model` or `--effort`.

### Nothing else

The docs list five places a cloud session starts: the browser, the mobile app's Code tab, the Desktop app, `claude --cloud` and scheduled tasks ([Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web)). Slack mentions and Claude Tag also create them. I found no documented API that creates a session with a chosen repository, model and effort in one request.

## Model and effort

**Which models.** The docs don't list the models a cloud session's picker offers. What they do say:

- Fable is chosen like any other model: "No Fable model is the account-type default on any plan or provider. Select one explicitly" ([Work with Fable](https://code.claude.com/docs/en/model-config#work-with-fable)).
- The support page lists "Claude Code" among the places Fable models are available, and "Claude Fable 5.2, Claude Fable 5.1, and Claude Fable 5 are available on all paid plans" ([Claude Fable models on your plan](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan)).
- The changelog names cloud sessions on Fable (2.1.323, 12 November 2026): "Improved the Fable limit message in `-p`, SDK, IDE and cloud sessions".
- Fable 5.2 "requires Claude Code v2.1.321 or later". The docs are silent on which Claude Code version a cloud session's VM runs.

That Fable can be picked for a cloud session is supported by those three passages together. No page says it in one sentence.

**What Fable costs on the plan.** "On Max plans, Ultra plans, premium seats on Team plans … all three models are a standard part of your plan." "You can use up to 50% of your weekly usage limits on Fable models at no extra cost." After that, "you can keep using Fable models with usage credits, or switch to another model". On Pro, "all three models run on pay-as-you-go usage credits" (same support page).

**Effort levels.** Fable models offer `low`, `medium`, `high`, `xhigh` and `max`. "Fable 5.2, Opus 5.5, Sonnet 5.5, and Haiku 5.5 default to `medium`" ([Adjust effort level](https://code.claude.com/docs/en/model-config#adjust-effort-level)). `max` "is session-only" ([commands](https://code.claude.com/docs/en/commands)).

**Changing either once the session runs.** Documented for cloud sessions:

> **`/model`, `/effort`, `/color`, and `/rename`**: pass the value as an argument, for example `/model sonnet`, instead of opening the terminal picker or slider.

Source: [Manage context](https://code.claude.com/docs/en/claude-code-on-the-web#manage-context). In the browser there is also the model menu on the message box. On the phone the typed commands are the only documented route.

**Fast mode** is separate from effort, and it is outside the subscription: "Fast mode usage draws directly from usage credits, even if you have remaining usage on your plan." In a cloud session, "Type `/fast on` in the session to turn fast mode on. It stays on for that session only" ([fast mode](https://code.claude.com/docs/en/fast-mode#use-fast-mode-in-cloud-sessions)).

## Skills and plugins

### What a cloud session loads

From the table in [What carries over from your setup](https://code.claude.com/docs/en/cloud-environments#what-carries-over-from-your-setup):

| | In a cloud session |
| :- | :- |
| The repo's `CLAUDE.md` and `.claude/rules/` | Yes |
| The repo's `.claude/skills/`, `.claude/agents/`, `.claude/commands/` | Yes, "Part of the clone" |
| The repo's `.claude/settings.json` hooks and permission rules | "Yes, in a session with one repository" |
| The repo's `.mcp.json` MCP servers | "Yes, in a session with one repository" |
| Plugins and marketplaces the repo declares in `.claude/settings.json` | No |
| The Operator's `~/.claude/skills/`, `~/.claude/CLAUDE.md`, user settings and user-scoped plugins | No |
| Skills enabled on the Operator's claude.ai account | Yes: "Cloud sessions automatically load skills you enable on claude.ai" |

- **Personal skills** reach a cloud session only through the account: "For Cowork sessions, cloud sessions, and cloud threads in a project, enable the skill for your claude.ai account" ([Skills in Cowork and cloud sessions](https://code.claude.com/docs/en/skills#skills-in-cowork-and-cloud-sessions)). They are managed at `claude.ai/customize/skills/yours` and arrive named `anthropic-skills:<name>`.
- **Plugins a repo declares** never load: "A cloud session doesn't add the marketplaces a repository lists under `extraKnownMarketplaces`, because that requires the workspace trust dialog, which a cloud session never shows." ([plugin loading](https://code.claude.com/docs/en/plugins/loading)). This still agrees with the Kit's ADR-0003.
- **`/plugin` doesn't exist there:** "Commands that only run in the terminal interface, such as `/plugin` or `/resume`, aren't available."

### Plugins on the Operator's claude.ai account

The docs pages and the changelog don't quite agree.

- **The pages** say synced plugins "load in Cowork sessions and in terminal sessions where you sign in with your claude.ai account" ([Plugins synced from claude.ai](https://code.claude.com/docs/en/plugins/loading#synced-plugins)). They don't name cloud sessions.
- **The changelog** says they load in cloud sessions:
  - 2.1.287 (1 October 2026): "Fixed SessionStart hooks from synced plugins not running in new cloud sessions".
  - 2.1.314 (30 October 2026): "Improved scheduled tasks: runs in Anthropic's cloud now load the plugins enabled on your claude.ai account".
  - 2.1.323 (12 November 2026): "Improved Claude Desktop and cloud sessions for claude.ai accounts with more than 2,000 plugins turned on".
- **The web page** has a card in the conversation: "Select **Add** on a plugin to turn it on for your claude.ai account, where it stays on after the session ends." ([Plugin suggestions](https://code.claude.com/docs/en/claude-code-on-the-web#plugin-suggestions-in-the-conversation)).

So a plugin on the Operator's account is a second way, beside the repo, to get skills and a SessionStart hook into a cloud session. It is documented in the changelog only. Account plugins are added at `claude.ai/customize/plugins`, from a marketplace in a GitHub repository or as an uploaded zip ([platform support](https://claude.com/docs/plugins/platform-support)). Which of a plugin's parts load in a Claude Code cloud session is not in that page's table, whose Claude Code column covers "the terminal, the IDE extensions, and the desktop app's Code tab".

### SessionStart hooks, and the Kit's

**Where a repo's hooks run.** Only in a single-repo session outside a project:

> **One repository per session**: in an Anthropic-hosted environment, a session with several repositories doesn't load hooks from any repository's `.claude/settings.json`, so a SessionStart hook you define there doesn't run. Install dependencies for those sessions with a setup script instead.

> **Not in a project's cloud threads**: a cloud thread in a project doesn't run hooks from a repository's `.claude/settings.json`, whatever the number of repositories.

Source: [Limitations in cloud sessions](https://code.claude.com/docs/en/cloud-environments#limitations-in-cloud-sessions).

**Skills a hook installs load in the same session.** ADR-0003 recorded this as undocumented. It is documented now:

> To make skills that a SessionStart hook installs available in the same session, return `reloadSkills`.

Source: [Reload skills that a hook installs](https://code.claude.com/docs/en/hooks#reload-skills-that-a-hook-installs). The Kit's hook already returns it.

**The Kit's download may be refused.** The hook entry in `templates/claude-settings.json` fetches `https://codeload.github.com/jrey8343/fabrik/tar.gz/refs/tags/<release>`. The GitHub proxy's documented rule is:

> **Repository scope**: the proxy serves GitHub API requests for the repositories attached to the session. An API request for another repository gets a 403 whose message starts with `GitHub access to` and contains `is not enabled for this session`. A source archive you fetch over a `github.com/{owner}/{repo}/archive/` or `codeload.github.com` URL gets that same 403 when the repository isn't attached, even a public one.

Source: [GitHub proxy](https://code.claude.com/docs/en/cloud-environments#github-proxy). By that rule the hook's download fails in a cloud session on a Product repo, because `fabrik` isn't attached to it. Attaching `fabrik` as a second repository makes it a session with several repos, where the hook doesn't run at all. I did not test this, and the repo's README says the hook works in a cloud session, so it needs a try before anything is built on either reading.

The same section names another path: "Committed files from public repositories arrive through `raw.githubusercontent.com`, which the security proxy handles instead. That domain is on the default allowlist".

**Timeouts.** "Claude Code cancels a `command` hook after 600 seconds unless you set `timeout`". The Kit's entry sets 120.

### What a cloud environment's setup script can add

- **When it runs.** "A setup script is a Bash script that runs when a new cloud session starts, before Claude Code launches." "Scripts run as root on Ubuntu 24.04".
- **It is cached.** "When setup completes within roughly five minutes, Anthropic snapshots the filesystem and reuses that snapshot as the starting point for later sessions." The cache "reaches its expiry after roughly seven days".
- **It can write user-level instructions.** The docs' own example writes `~/.claude/CLAUDE.md`, and "Claude Code loads that file as user instructions in the session."
- **It gets no secrets and no variables.** "The script runs before the session sets the environment's environment variables", and network secrets are never attached to "Setup script requests".
- **It is the documented fallback for a session with several repos:** "Install dependencies for those sessions with a setup script instead."

**Inferred:** since the script runs as root and can write `~/.claude/CLAUDE.md`, it could also write `~/.claude/skills/` or a user-level `~/.claude/settings.json` holding a hook. That would reach sessions with several repos. The docs show only the `CLAUDE.md` case.

Source: [Setup scripts](https://code.claude.com/docs/en/cloud-environments#setup-scripts).

## Several repos

**One session can hold several.** "You can add multiple repositories to work across them in one session." ([Start a task](https://code.claude.com/docs/en/web-quickstart#start-a-task)). The link's `repositories` parameter and a scheduled task both take a list. `claude --cloud` takes one.

**It costs the session its repo settings.**

> **Shared project settings with several repositories**: in an Anthropic-hosted environment, a session with several repositories starts above the clones and reads only the `enabledPlugins` and `extraKnownMarketplaces` keys from each repository's `.claude/settings.json`, not permission rules, hooks, `env`, or other keys.

Source: [Settings in cloud sessions](https://code.claude.com/docs/en/settings#settings-in-cloud-sessions). The `.mcp.json` row of the carry-over table carries the same limit.

**Skills still load.** The carry-over table gives `.claude/skills/` a plain "Yes". **Inferred:** in a session that "starts above the clones" they load the way nested skills do, "the first time Claude reads or edits a file in that subdirectory" ([monorepos and subdirectories](https://code.claude.com/docs/en/skills#discovery-from-parent-and-nested-directories)), and not at startup.

**GitHub access is scoped to the attached repos.** A single-repo session can't call the GitHub API on another repository (the 403 quoted above).

**A repo can be added mid-session, by the changelog only.** 2.1.312 improved "the step shown when Claude adds a repository to a cloud session", and 2.1.318 "Added a No repository option". The docs pages describe adding a repository mid-task only for a project's threads.

**Projects are the other shape.** A project gives every thread its repositories, a "Thread model" and "Thread effort", and plugins from "Project settings > Plugins". But "Cloud threads load each repository's `CLAUDE.md` instructions but not its skills, `.mcp.json` servers, or `.claude/settings.json`" ([What threads pick up](https://code.claude.com/docs/en/claude-projects#what-threads-pick-up-from-your-repositories)). Projects "are in public beta on Pro, Max, and Ultra plans and rolling out gradually."

## GitHub from inside the session

This bears on what a Pairing session's `gh` steps can do in the cloud. Source for all of it: [GitHub proxy](https://code.claude.com/docs/en/cloud-environments#github-proxy) and [Work with GitHub issues and pull requests](https://code.claude.com/docs/en/cloud-environments#work-with-github-issues-and-pull-requests).

- **Credentials stay outside the VM.** "the git client inside the VM uses a scoped credential, which the proxy verifies and swaps for your actual GitHub token."
- **Built-in tools cover the common cases.** They "let Claude read issues, list pull requests, fetch diffs, and post comments without any setup."
- **GraphQL is rejected.** "`gh` subcommands that use GraphQL, such as `gh pr` and `gh issue`, get the same 403. The restriction applies to every request through the proxy regardless of the credentials you supply, so a `GH_TOKEN` you set gets the same 403."
- **REST works.** "ask Claude to call the REST API with `gh api`. `gh` subcommands that use the REST API, such as `gh workflow list`, work too."
- **Some pushes are refused.** "the proxy rejects branch deletions and pushes of anything other than a branch, such as a tag. It doesn't limit which branches a push can update."
- **A pasted token is readable.** A `GH_TOKEN` set on the environment "passes through to the container unchanged", and "anyone who uses the environment can read it".

`skills/fabrik-pair/SKILL.md` calls `gh issue view`, `gh issue edit`, `gh issue close`, `gh pr list` and `gh pr view`. By the passage above, those are refused in a cloud session.

## The Operator's own MCP server

### As a connector on the claude.ai account

- **It reaches cloud sessions.** For cloud sessions, "The cloud host passes them in" ([How connectors reach Claude Code](https://code.claude.com/docs/en/mcp#how-connectors-reach-claude-code)).
- **All of them, by default.** For a scheduled task, "All of your connected MCP connectors are included by default." In a running session, **Connectors** in the **+** menu turns one off.
- **No allowlist entry is needed.** "MCP connectors you enable on a session or scheduled task work without adding their hosts to **Allowed domains**, because connector traffic travels through Anthropic's servers rather than the session's network." ([Network access](https://code.claude.com/docs/en/cloud-environments#network-access)).
- **Adding one.** On Pro, Max or Ultra: **Customize > Connectors**, then **Add custom connector**, with "the remote MCP server URL" ([Add a connector that isn't in the directory](https://claude.com/docs/connectors/custom/add-unlisted)). Such a server "runs on infrastructure you host and is reachable over the internet" ([Build an MCP server for Claude](https://claude.com/docs/connectors/building/index)).
- **How it authenticates.** By OAuth, with the sign-in done in claude.ai:

  > For a connector delivered to a cloud session, Claude Code doesn't run a sign-in flow, because the session's proxy authenticates to the connector with the authorization you granted in claude.ai. When a connector there needs authorizing again, reconnect it at claude.ai/customize/connectors rather than from the session.

  Source: [Authenticate with remote MCP servers](https://code.claude.com/docs/en/mcp#authenticate-with-remote-mcp-servers). The server's authorization server must accept the redirect `https://claude.ai/api/mcp/auth_callback` ([Authentication for connectors](https://claude.com/docs/connectors/building/authentication)). **Inferred** from "the session's proxy authenticates": the token never enters the session's VM.
- **A fixed header instead of OAuth** is not generally on offer: "Request header authentication is in beta and available to a limited set of organizations."
- **No sign-in** is also supported, where "anyone with access to the server URL can use the connector".

### As a server in the repo's `.mcp.json`

- **Single-repo sessions only**, and with no approval step: in "cloud sessions outside a project's threads, Claude Code can't show that prompt: it loads project-scoped servers without asking." ([Project scope](https://code.claude.com/docs/en/mcp#project-scope)).
- **A credential comes from an environment variable.** `${VAR}` expands in `url` and `headers` ([Environment variable expansion](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json)). A cloud environment's variables sit inside the VM, where the agent can read them.
- **The docs are silent** on whether a network secret is attached to an MCP connection. A network secret is added "after each request leaves the session's VM" for "the hosts you list" ([Add network secrets](https://code.claude.com/docs/en/cloud-environments#add-network-secrets)), but the examples are commands Claude runs, such as `curl`.
- **The docs are silent** on OAuth sign-in to a `.mcp.json` server from a cloud session. One hint that some sign-in exists: a session "counts as inactive while it waits for you to approve an MCP connector tool call or to sign in to an MCP server".
- **Inferred:** unlike a connector, a `.mcp.json` server is reached over the session's own network, so its host must be in the environment's allowed domains.

### A tap for a high-risk act

An MCP server can make one tool ask every time, in any mode:

> Claude Code shows that tool's permission prompt on every call Claude makes, even in `acceptEdits`, `auto`, and `bypassPermissions` permission modes, and doesn't offer a "don't ask again" option for it.

It is set with `_meta["anthropic/requiresUserInteraction"]` on the tool ([Require approval for a specific tool](https://code.claude.com/docs/en/mcp#require-approval-for-a-specific-tool)).

A server can also ask the Operator for a value or a sign-in mid-task. In a cloud session that request "appears as a card at claude.ai/code or in the Desktop app's **Code** tab", and "If you see no card in either place, you can't answer the request there." ([Answer an elicitation request in a cloud session](https://code.claude.com/docs/en/mcp#answer-an-elicitation-request-in-a-cloud-session)). The mobile app isn't named.

## Reading it from outside

**No documented API reads a session.** I found none that lists sessions or returns one's state. The `/fire` token "grants no read access". A scheduled task's run history shows Succeeded, Failed or Cancelled in the web UI, and "These outcomes say how the session ended, not whether Claude completed the work".

**The session can report on itself.**

- **It knows its own URL.** "the session can read its own ID from the `CLAUDE_CODE_REMOTE_SESSION_ID` environment variable", and the URL is `https://claude.ai/code/` plus the ID with `cse_` changed to `session_`.
- **It writes that URL to GitHub unasked.** "Commits that Claude creates in a cloud session include a `Claude-Session: <url>` git trailer, and PR bodies include the session URL on its own line." ([Link output back to the session](https://code.claude.com/docs/en/cloud-environments#link-output-back-to-the-session)). The Console reads GitHub already, so it can link a pull request to its session with nothing new.
- **Hooks fire on the moments that matter.** "Claude Code fires the same hook events wherever it runs", cloud sessions included. The events include `Stop`, `SessionEnd`, `PermissionRequest`, and `Notification` with the types `permission_prompt`, `idle_prompt` and `elicitation_dialog`. A hook can be an HTTP POST ([hooks reference](https://code.claude.com/docs/en/hooks)).
- **Anthropic's own docs use this pattern** for a self-hosted runner: "swap the file write in the Stop hook for a POST to an endpoint your driver listens on" ([Remote test runners](https://code.claude.com/docs/en/self-hosted-environments-testing#remote-test-runners)).

**Inferred:** in an Anthropic-hosted session, a hook could POST "running", "waiting on the Operator" and "over" to the Console. The hook would come from the repo's `.claude/settings.json` (single-repo sessions only) or from an account plugin. The Console's host would have to be in the environment's allowed domains. The docs time the `Notification` types for terminal sessions and say nothing of their timing in a cloud session.

**Push notifications to the phone.** The docs pages document them only for Remote Control and Dispatch ([mobile, Get push notifications](https://code.claude.com/docs/en/mobile#get-push-notifications)). The changelog shows cloud sessions and scheduled tasks send them too:

- 2.1.326 (16 November 2026): "Improved how secrets are masked in push notifications from Remote Control and cloud sessions".
- 2.1.292 (6 October 2026): "Fixed editing or duplicating a routine turning off its push notifications when the routine had no saved notification setting".

The support page says of a finished task only "You receive a notification" ([Use Claude Code in the cloud](https://support.claude.com/en/articles/12618689-use-claude-code-in-the-cloud)). No page says what triggers a cloud session's push or where it is set.

## A long pairing

**Permission modes.** "Cloud sessions don't offer Manual or Bypass permissions." The three on offer, from a phone too:

- **Auto**: "a classifier reviews Claude's actions instead of asking you".
- **Accept edits**: "Claude makes changes and pushes a branch without stopping for approval". It "corresponds to `default` mode: cloud sessions pre-approve file edits regardless of mode".
- **Plan**: "Claude proposes an approach and waits for you to approve it before editing files".

The mode can change while the session runs: "both when you create the task and while the session runs" ([Permission modes in cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web#permission-modes-in-cloud-sessions)).

**What still stops for the Operator in auto mode.** "Explicit ask rules still force a prompt", as do tools marked `requiresUserInteraction`. Ask rules in a repo's `.claude/settings.json` apply in a single-repo session only.

**Time limits.** No limit on a session's total length is documented. What is:

- **Idle.** "after a few minutes without activity, a session's VM pauses with its files saved, and a paused VM can later be reclaimed." No number is given for the reclaim.
- **Waiting counts as idle.** "A session counts as inactive while it waits for you to approve an MCP connector tool call or to sign in to an MCP server, and it can expire during that wait."
- **A question survives the wait.** "If Claude asks a question and the session sits idle, you can still answer when you come back, up to environment expiry".
- **What a reclaimed session keeps.** Reopening restores "your conversation history". Not restored: "background work that was still running or pending when the VM was reclaimed", including shell commands, subagents and `/loop` timers ([Environment expired](https://code.claude.com/docs/en/claude-code-on-the-web#environment-expired)).
- **Commands.** "Claude waits 2 minutes for a foreground command by default and can ask for up to 10 minutes", then the command moves to the background "for up to 30 more minutes" ([Time limits](https://code.claude.com/docs/en/cloud-environments#time-limits)).
- **Context.** "Auto-compaction runs automatically when the context window approaches capacity." `/compact`, `/context` and `/clear` work.

**The VM.** "4 vCPUs", "16 GB of RAM", "30 GB of disk". "You don't get a shell into the session VM. Claude runs every command for you".

**Plan limits.**

- **Shared.** "cloud sessions share rate limits with all other Claude and Claude Code usage within your account. Running multiple tasks in parallel consumes more rate limits proportionately." There's "no separate charge for the cloud VM."
- **Per plan.** "Pro and Max plans have a five-hour session limit and a weekly limit. Ultra plans have a weekly limit, and verified Ultra accounts don't have a five-hour session limit." "Max and Ultra plans also have a separate weekly limit for Fable." ([Use Claude Code with your Pro, Max, or Ultra plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan)).
- **A cap on sessions at once exists**, with no number: "The last run didn't start because your organization had reached its limit on cloud sessions running at once."

**On the phone.** One documented gap: "In cloud sessions on the mobile app, editing and retrying is not supported" when a request is flagged and the session is set to ask before switching models.

## What changed since 2026-11-02

Held up on re-check:

- The surfaces a cloud session starts from, the VM's size, the command timeouts and the plans it is on.
- The three permission modes from a phone, and no Bypass.
- `/fire`'s hourly limits, its metered-overage catch and its research-preview label.
- No filters documented for issue events on a GitHub trigger.

Not in the earlier research, or different now:

- **The pre-fill link.** The earlier research said cloud sessions have "No trigger to *start* a session". The link fills in a new session's form, though it starts nothing by itself.
- **`/fire` text is untrusted.** It arrives in a `<routine-fire-payload>` block, and the saved prompt "can't act as approval or consent".
- **A scheduled task saves a model and an effort level.**
- **Push notifications.** The earlier research said "None documented" for cloud sessions. The pages still document none, but the changelog now names pushes from cloud sessions and from scheduled tasks.
- **The GitHub proxy rejects GraphQL and source archives of unattached repos.** Neither was recorded.
- **A session with several repos loses its repos' hooks, permission rules and `.mcp.json`.**
- **Account plugins load in cloud sessions**, by the changelog.
- **`--cloud` can't run on a `claude setup-token` token.** The earlier research listed "terminal (`--cloud` / `--teleport`)" without the 30-day login limit.
- **The VM's disk** is now listed, at 30 GB.

## What stays unknown until tried

On a real phone:

1. Whether a `claude.ai/code?...` link tapped in the Console, installed to the home screen, opens the Claude iOS app, and whether `prompt`, `repositories` and `environment` arrive on the app's new-session screen.
2. Whether `prompt_url` works when the link opens in the app.
3. Which model and effort a new session starts on, and whether the app's new-session screen lets the Operator pick them before sending.
4. Whether the session URL that `/fire` returns opens that session in the app.
5. Whether a cloud session pushes to the phone when it waits on the Operator or finishes, and where that is turned on.
6. Whether a permission prompt, a question from Claude and an MCP server's form or link card can each be answered in the app.
7. How long an idle session lasts before its VM is reclaimed.

In any cloud session, phone or not:

8. Whether the Kit's SessionStart hook can download Fabrik from `codeload.github.com` in a session on a Product repo.
9. Whether a plugin on the Operator's claude.ai account loads its skills, hooks and MCP servers in a cloud session they start themselves.
10. Whether environment variables on a cloud environment set the session's model and effort.
11. Whether a network secret is attached to a hook's HTTP request or to a `.mcp.json` server's connection.
12. Whether a session started by `/fire` runs the repo's SessionStart hook as an interactive one does.
