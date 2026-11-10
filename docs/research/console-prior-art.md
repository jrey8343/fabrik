# Prior art: what agent consoles and mobile code-review apps put on their home and review screens

Research for the Decision "What do agent consoles and mobile code-review apps put on their home and review screens?" ([#512](https://github.com/jrey8343/fabrik/issues/512)) on the Map "Wayfinder: the Console, an Operator app for seeing and steering the factory" ([#507](https://github.com/jrey8343/fabrik/issues/507)). Gathered 2026-11-10.

**Question.** What do existing products show an operator of coding agents, and a reviewer on a phone? For each: how "needs you" is separated from "in progress" and "done", how a run's state and trustworthiness is conveyed, how a long diff is made reviewable on a small screen, how approve, request changes and merge are offered, and how cost or usage is shown.

**Method.** Desk research only, primary sources only: each product's own docs, changelog, launch post and the alt text or captions of its published screenshots. Most of these vendors publish their docs as raw Markdown (`.md` pages and an `llms.txt` index), so I fetched the Markdown and read it directly; quotes are verbatim from those files as fetched on 2026-11-10. Nothing was installed, signed into or run, and **I did not look at any screenshot image**: every claim about a screen comes from the vendor's prose, alt text or caption. Anything marked **unverified** is something the primary sources don't say. This file makes no recommendation for the Console's own design; "worth stealing" and "avoid" below are a reading of the prior art against the Map's settled points, as input to the prototypes.

The file is long. Read "Answer in brief", then the section for the screen you are prototyping.

## Sources and how they were read

| Short name | Product and surface | Pages read | How |
| --- | --- | --- | --- |
| **Warp** | Warp Factories web app: Factory inbox, Dashboard, Runs | [Factory inbox](https://docs.warp.dev/factories/factory-inbox/), [Factory dashboard](https://docs.warp.dev/factories/factory-dashboard/) | Raw text from `docs.warp.dev/_llms-txt/factories.txt` |
| **Claude Code** | Agent view (terminal), Projects Overview (web, desktop, phone), cloud sessions, the Claude app's Code tab, `/usage` | [agent view](https://code.claude.com/docs/en/agent-view.md), [Projects](https://code.claude.com/docs/en/claude-projects.md), [cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web.md), [cloud quickstart](https://code.claude.com/docs/en/web-quickstart.md), [mobile](https://code.claude.com/docs/en/mobile.md), [costs](https://code.claude.com/docs/en/costs.md) | Raw `.md` |
| **Copilot** | GitHub Copilot cloud agent: agents panel, Agents tab, "mission control", GitHub Mobile's Copilot tab, the notifications inbox | [Managing agent sessions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents), [Agent management](https://docs.github.com/en/copilot/concepts/agents/coding-agent/agent-management), [Review output from Copilot](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/review-copilot-output), [Agent Merge](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/get-pull-requests-ready-to-merge), [Managing notifications from your inbox](https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/managing-notifications-from-your-inbox), [GitHub Mobile docs](https://docs.github.com/en/get-started/using-github/github-mobile), the [github.com/mobile](https://github.com/mobile) landing page, changelogs of [2026-01-26](https://github.blog/changelog/2026-01-26-introducing-the-agents-tab-in-your-repository), [2026-02-26](https://github.blog/changelog/2026-02-26-github-mobile-track-coding-agent-progress-in-real-time-with-live-notifications) and [2026-04-01](https://github.blog/changelog/2026-04-01-github-mobile-stay-in-flow-with-a-refreshed-copilot-tab-and-native-session-logs), and the [Agent HQ launch post](https://github.blog/news-insights/company-news/welcome-home-agents/) | Docs through the docs site's Markdown API; changelogs and the landing page as HTML reduced to text (image alt text kept) |
| **Cursor** | Cursor for iOS, cursor.com/agents (web and PWA), Cloud Agents | [Cursor for iOS](https://cursor.com/docs/cloud-agent/mobile.md), [iOS help page](https://cursor.com/help/ai-features/mobile-app.md), [Cloud Agents](https://cursor.com/docs/cloud-agent.md), [capabilities](https://cursor.com/docs/cloud-agent/capabilities.md), [usage and limits](https://cursor.com/help/models-and-usage/usage-limits.md), the [2025-06-30 web and mobile launch post](https://cursor.com/blog/agent-web) | Raw `.md`; the launch post through a summarising fetch |
| **Codex** | OpenAI Codex in the ChatGPT apps: Codex Cloud, Codex on mobile, Activity view, Code Review | [Codex Cloud](https://learn.chatgpt.com/docs/cloud.md), [Codex on mobile](https://learn.chatgpt.com/docs/mobile.md), [Notifications](https://learn.chatgpt.com/docs/notifications.md), [Code review](https://learn.chatgpt.com/docs/code-review.md), [Pricing](https://learn.chatgpt.com/docs/pricing.md) | Raw `.md`. `developers.openai.com/codex/...` now redirects to `learn.chatgpt.com/docs/...` |
| **Devin** | Devin web app (also an installable PWA): sessions sidebar, Devin Review, test recordings, Session Insights | [Devin Review](https://docs.devin.ai/work-with-devin/devin-review.md), [Testing & Video Recordings](https://docs.devin.ai/work-with-devin/testing-and-recordings.md), [Session Insights](https://docs.devin.ai/product-guides/session-insights.md), [release notes](https://docs.devin.ai/release-notes/overview.md) | Raw `.md` |
| **Linear** | Inbox, My Issues, Reviews ("Diffs"), Mobile Diffs, the cloud coding agent, Usage & limits | [Inbox](https://linear.app/docs/inbox.md), [My issues](https://linear.app/docs/my-issues.md), [Reviews](https://linear.app/docs/diffs.md), [Linear cloud coding agent](https://linear.app/docs/linear-cloud-coding-agent.md), [Usage & limits](https://linear.app/docs/usage-and-limits.md), [Agent Interaction Guidelines](https://linear.app/developers/aig.md), [Linear Mobile](https://linear.app/mobile.md), changelogs of [2026-07-30](https://linear.app/changelog/2026-07-30-coding-sessions-on-mobile), [2026-09-03](https://linear.app/changelog/2026-09-03-priority-inbox) and [2026-11-04](https://linear.app/changelog/2026-11-04-mobile-diffs), the [Mobile Diffs launch post](https://linear.app/now/mobile-diffs) (2026-11-05) | Raw `.md`; two changelog entries through a summarising fetch |
| **Graphite** | Pull request inbox, PR page, merge, Slack | [PR inbox](https://graphite.com/docs/use-pr-inbox.md), [PR page overview](https://graphite.com/docs/pr-page-overview.md), [Merge pull requests](https://graphite.com/docs/merge-pull-requests.md), [Slack notifications](https://graphite.com/docs/slack-notifications.md), `graphite.com/docs/llms-full.txt` | Raw `.md` |
| **CodeRabbit** | PR summary and walkthrough, Merge Risk, Triage, Change Stack | [PR Summaries](https://docs.coderabbit.ai/pr-reviews/summaries.md), [PR Walkthroughs](https://docs.coderabbit.ai/pr-reviews/walkthroughs.md), [Merge Risk](https://docs.coderabbit.ai/pr-reviews/merge-risk.md), [Your Triage view](https://docs.coderabbit.ai/triage/your-triage-view.md), [Change Stack](https://docs.coderabbit.ai/change-stack.md) | Raw `.md` |
| **Jules** | Google Jules | [Reviewing code](https://jules.google/docs/code.md), [Managing tasks and repos](https://jules.google/docs/tasks-repos.md), [Jules Turndown](https://jules.google/docs/changelog/2026-10-29.md) | Raw `.md` |

**Not found, not read, or unverified:**

- **Screenshots themselves.** Not viewed. Where a claim rests on alt text or a caption it says so.
- **GitHub Mobile's pull request review screen.** GitHub's docs say only that you can "Read, review, and collaborate on issues and pull requests" and "Edit files in pull requests". The landing page says "approve and merge—all directly within GitHub Mobile". How the diff is laid out, and whether anything condenses it, is undocumented. **Unverified.**
- **GitHub Mobile's session-list states.** The 2026-04-01 changelog says the list "includes filters to sort tasks by state" and never names the states. The only named states are the Live Activity's four.
- **Cursor's mobile inbox.** The docs call the app's list "the inbox" and say Live Activities show agents "with their current state". No state names, grouping or filters are documented. A "Kanban view" exists on the web per a 2025 screenshot caption; nothing newer describes it. **Unverified.**
- **Codex on mobile.** Each screen is described by an "Illustration:" caption only.
- **Devin's native mobile apps.** One release note (2026-11-06) mentions logging out of "the mobile apps"; no other page documents them. The PWA and mobile-web Review are documented.
- **Graphite on a phone.** No mobile app or mobile layout is documented. Slack is the only documented small-screen route.
- **Three GitHub Mobile changelog entries** (2026-02-03 comment on unchanged lines, 2026-07-17 "Fix with Copilot" on review comments, 2026-07-23 fix failing Actions checks) were seen only as search-result summaries, not opened.
- **GitHub's current "AI credits" billing pages.** I read the managing-sessions page (which names AI credits) and the legacy premium-request pages; not the current individual billing page.
- **Third-party reviews and app-store listings** were deliberately not used.

Fabrik already has notes on Warp's factory posts ([research/warp-factory](https://github.com/jrey8343/fabrik/tree/research/warp-factory)) and on the Claude surfaces a phone can reach ([`remote-surfaces.md`](https://github.com/jrey8343/fabrik/blob/main/docs/research/remote-surfaces.md)); this file doesn't repeat them.

## Answer in brief

**Home**

- **Worth stealing: a derived, personal queue whose rows leave by themselves.** Warp's Factory inbox is the closest thing to the Map's settled point 7: six kinds of item, only "work tied to tasks *you* started", and "Items clear on their own once they stop being relevant". Claude Code's agent view and Projects Overview group by what the human owes (`Ready for review`, `Needs input` / "Waiting on you") above `Working` and done, and state the rule: "These group names don't map one-to-one to the states".
- **Worth stealing: say what the item wants, on the row.** Claude's agent view shows "a blocked row shows the question it's asking" and, in the peek panel, `waiting 3m`. CodeRabbit's Triage card names exactly one "Next action" (`Review`, `Fix CI`, `Merge`, `Review and decide`). Devin's sidebar carries persistent labels such as "PR created" and "Awaiting instructions".
- **Worth stealing: one row per piece of work, with the pull request's own status folded in.** Agent view colours the `#1234` label yellow, green, purple or grey; Warp shows `Blocked` or `Failed` only when "nothing else on that task already needs yours".
- **Avoid: read/unread, snooze and manual clearing as the way a queue empties.** Linear's Inbox, GitHub's inbox, Devin's notification inbox and Codex's Activity view all empty by a human marking things, and Linear caps at 2,000 open notifications. Even Warp's derived queue adds resolve, undo, and read/unread on top.
- **Avoid: "done" at the same weight as "needs you".** Every product that groups well also demotes done: agent view folds it to `… 6 more`, Linear lets you "pin it to the bottom", Projects moves it to `Resolved`.

**Review**

- **Worth stealing: the review starts on an ordered guide, with the raw diff one tap away.** Linear Mobile Diffs (shipped 2026-11-05) and Devin Review both lead with grouped sections and an explanation; Devin's phone layout is tabs: **Changes**, **Bugs**, **Description**, **Discussion**, **Commits**.
- **Worth stealing: cut the diff down before showing it.** Linear counts "implementation changes by default, excluding things like tests and documentation" and groups files by type from `.gitattributes`; Devin has copy and move detection and hide-whitespace; Linear drops split view when "there isn't enough horizontal space".
- **Worth stealing: the merge control tells the truth about mergeability.** Devin's "merge button reflects the PR's current mergeability status and required checks"; CodeRabbit's "merge control refuses a stale artifact"; Linear and Devin both show how many pull requests a stack merge will land.
- **Worth stealing: sending work back is a first-class move beside approve.** Linear: "tap the relevant line to add it to your message"; Claude: inline comments "queue up until you send your next message"; Claude Projects' card buttons **Fix CI**, **Address comments**, **Resolve conflicts**, **Merge it**; Warp's **Request changes** / **Approve & merge**.
- **Avoid: actions that fire at different times on the same screen.** Codex warns that posting in **Summary** or **Changes** "sends the comment to the source provider immediately, without waiting for **Submit review**".
- **Avoid: assuming the Operator's approval counts.** GitHub tells the person Copilot asks for review: "your approval of a Copilot pull request won't count toward the required number. Another reviewer must approve".

**Digest**

- **Worth stealing: structure by meaning, not by file path.** Devin: "Groups changes logically, putting related edits together instead of alphabetical order". CodeRabbit Change Stack: "ordered so foundations come before the code that depends on them". Linear Guides: "surface the core parts of an implementation first while grouping supporting or lower-signal changes separately", each section pairing "a high-level explanation of *why*" with the diffs.
- **Worth stealing: pin the account to a commit and say when it is stale.** CodeRabbit regenerates the summary "on every incremental push" and gives Merge Risk "the first five characters of the commit SHA"; Devin's "Review history" has "Switch to latest"; Linear's preview button indicates "when its preview is behind the latest commit".
- **Worth stealing: a "needs human eyes" signal with reasons.** Linear's risk score (four levels plus up to eight explanation strings such as "Touches authentication"), CodeRabbit's Merge Risk and 1 to 5 "Estimated review effort", Devin's `Investigate` flags versus `Informational` ones.
- **Worth stealing: evidence beside the claim.** Cursor attaches "screenshots, videos, and log references" to the pull request; Devin sends an annotated test recording; Linear shows "screenshots or recordings alongside the proposed changes".
- **Not found anywhere: pseudocode in place of the diff.** No product documents it. The nearest are prose-plus-diff guides, CodeRabbit's Mermaid sequence diagrams, and Codex's optional "Comic book", "Visualization" or "PDF" explanation formats. Nor does any product read here document "what was out of scope" or "follow-ups" as sections of its summary; the nearest is CodeRabbit's linked-issue assessment, which "highlights gaps between what the issue requested and what the PR delivers".
- **Avoid: a summary nobody can check.** CodeRabbit's Triage card separates "Provider facts", "Review signals" and "Triage's own judgment" precisely so the reader knows "how much to trust each".

**Spend**

- **Worth stealing: cost attached to the unit of work.** Warp's "Cost per PR" (median, with the card expanding "to list the most expensive PRs"), Linear's usage explorer grouped by session with a hover breakdown by model and compute, Devin's XS to XL size pill per review and per session.
- **Worth stealing: the two-figure shape the Map already settled on.** Claude Code's `/usage` is the only surface found that shows a subscription's plan-usage bars next to a list-price dollar figure, and it labels the dollars honestly: "an estimate", and for subscribers "isn't relevant for billing purposes".
- **Worth stealing: say what the number is not.** Warp: "This is an estimate, not an invoice total". Linear: "Spend limits are approximate safeguards, not exact caps". Claude: "computed from local session history on this machine, so usage from other devices or claude.ai is not included".
- **Avoid, or at least note: nobody puts spend on the phone.** Cursor is explicit: "Admin, billing, and usage. Web only." No mobile surface read here shows cost or limit share. A Spend screen on a phone has no prior art to copy.

## 1. How "needs you" is separated from "in progress" and "done"

Two families. One **derives** the list from the state of the work; the other **streams** events and lets a human clear them.

### Derived queues

**Warp Factory inbox** ([docs](https://docs.warp.dev/factories/factory-inbox/)). "**Inbox** collects everything your factories need from you specifically, across every factory you have access to, in one place."

- Six kinds: **Asked question** ("An agent needs a decision from you before it can continue"), **Answered question** ("for your information. No action is required"), **Spec review**, **PR review**, **Blocked** ("A run stopped and needs attention, and nothing else on that task already needs yours"), **Failed** ("under the same condition as Blocked").
- "It's a personal queue, not a team-wide feed: a teammate's task, even a blocked or failed one, never appears in your inbox."
- "Items clear on their own once they stop being relevant. For example, a PR review clears when someone reviews or merges the pull request, and a question clears once it's answered. You can also resolve any item yourself."
- On top of the derived list it still has manual state: mark **resolved** (with **Undo**), mark **read** or **unread**, and filter "by factory, read state, or kind".
- Runs in flight live on a separate **Runs** page; the Inbox exists "so you don't have to search **Runs** for stalled work" ([dashboard docs](https://docs.warp.dev/factories/factory-dashboard/)).

**Claude Code agent view** ([docs](https://code.claude.com/docs/en/agent-view.md)). A terminal screen, but the clearest statement of the grouping rule. The documented list:

```text
Pinned
Ready for review
Needs input
Working
Completed
  … 6 more
```

- "Agent view groups sessions so the ones that need input are at the top, with `Ready for review` and `Needs input` above `Working` and `Completed`. These group names don't map one-to-one to the states above: a session moves to `Ready for review` when it has an open pull request that needs review or has failing checks, and `Completed` collects finished, failed, and stopped sessions together."
- "Completed sessions that don't fit on screen fold into a `… N more` row." On a short screen "the header compacts to a single summary line so sessions that are working or need input stay visible."
- A row is "the session's name, current activity, and its age". The peek panel adds "the exact question it's asking" and "A line such as `waiting 3m`: how long the session has been waiting on you."
- The count that matters is surfaced outside the list: the tab title reads "`2 awaiting input · claude agents`".
- `s:blocked` "lists everything waiting on you".

**Claude Code Projects, Overview pane** ([docs](https://code.claude.com/docs/en/claude-projects.md#see-what-needs-you-in-overview)). The same idea with the pull request's later life added:

| Group | What's in it |
| :- | :- |
| **Ready for review** | Threads whose pull request is open and awaiting review |
| **Waiting on you** | Threads that need your reply or approval, or that failed |
| **Working** | Threads still running |
| **Landing** | Threads whose pull request is approved or queued to merge |
| **Idle** | Threads that finished and aren't waiting on anything |
| **Resolved** | Threads marked done: by you, "by Claude once you've taken the last step, such as merging its pull request, or automatically after a week with no activity" |

Note that failure is filed under "Waiting on you", not under done, and that the header button "shows a dot when a thread is waiting on you".

**Devin sessions sidebar** ([release notes](https://docs.devin.ai/release-notes/overview.md)). Three increments in 2026:

- 2026-03-07: "The browser tab favicon now shows a colored status dot on session pages (green when Devin is working, orange when it's waiting for you)". The same release made Devin an installable PWA.
- 2026-05-08: "The session sidebar now shows persistent status labels, such as "PR created," "Awaiting instructions," or "Approve session," alongside timestamps so you can quickly see what each session needs." It also added an orange unread dot that "clears once you open the session".
- 2026-09-25: "The sessions sidebar's "Group by status" now uses Working / Ready / Blocked / Inactive, so sessions with a PR awaiting review and sessions that need your input are listed separately."

**CodeRabbit Triage** ([docs](https://docs.coderabbit.ai/triage/your-triage-view.md)). "One cross-repository queue" of open pull requests. "Every card names one next action — not a list of options, the single step Triage believes moves this pull request forward": `Start review`, `Review`, `Respond to feedback`, `Fix CI`, `Fix merge conflicts`, `Review and decide` ("A judgment call from a maintainer, not a line-by-line review"), `Merge` ("Approved and nothing mechanical is blocking it"), and others. Always shown on the card: priority with a reasoning line, next action, checks, diff size as `+120` / `−45`, reviewers.

**Graphite PR inbox** ([docs](https://graphite.com/docs/use-pr-inbox.md)). "Think of the pull request inbox as an "email client" for your PRs", but each section is a saved filter over pull request state, not a notification list. Six default sections: **Needs your review**, **Approved**, **Returned to you**, **Merging and recently merged**, **Drafts**, **Waiting for review**. The page doesn't define when a pull request enters or leaves a section. Another Graphite page says a row shows "the overall approval state of the PRs as well as merge conflict status, check statuses, individual reviewer statuses, and the last updated date".

**Linear Reviews** ([docs](https://linear.app/docs/diffs.md#display-and-grouping)). Two tabs, **Created** and **To Review**. "To keep done or merged reviews separate from actionable work, right-click a group and pin it to the bottom of the list." A review can be snoozed "for a set period, until a new comment, or until a re-review", which is snooze defined by an event on the work, not by a clock. On mobile, "My Issues → Assigned" has a section "for your delegated issues" that "shows the status of each coding session" ([changelog 2026-07-30](https://linear.app/changelog/2026-07-30-coding-sessions-on-mobile)).

### Notification streams

- **GitHub's notifications inbox** ([docs](https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/managing-notifications-from-your-inbox)). "Your inbox shows all of the notifications that you haven't unsubscribed to or marked as **Done.**" Triage options are Save, Done, Unsubscribe, Read, Unread. The default filters are by reason ("assigned, participating in a thread, requested to review a pull request" or mentioned), not by whether a move is owed. This is the stream the Operator's "soup" complaint is about. It syncs to GitHub Mobile.
- **GitHub agent sessions.** Separate from the inbox. On GitHub.com recent sessions sit under "Pick up where you left off"; in GitHub Mobile under "Agent sessions" in the Copilot tab ([docs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)). The list leaves by archiving: "Archive stopped sessions to remove them from your sessions list." Live Activities on the lock screen show four states, "In progress", "Completed", "Failed" and "Cancelled", with "the related pull request title", and a tap opens the pull request ([changelog 2026-02-26](https://github.blog/changelog/2026-02-26-github-mobile-track-coding-agent-progress-in-real-time-with-live-notifications)). There is no documented "needs you" state.
- **Linear Inbox** ([docs](https://linear.app/docs/inbox.md)). "The **Priority** tab separates notifications that need your attention from other updates. Linear selects Priority notifications by default" (added [2026-09-03](https://linear.app/changelog/2026-09-03-priority-inbox)). It is cleared by hand: delete, mark read or unread, snooze ("Snoozing hides a notification from your Inbox until the selected time"). "You cannot choose which notifications go to your Inbox", and "you can have up to 2,000 open notifications". On mobile: "Tap to take action, swipe to delete, snooze to deal with it later" ([Linear Mobile](https://linear.app/mobile.md)).
- **Codex Activity view** ([docs](https://learn.chatgpt.com/docs/notifications.md)). "Select the bell in the sidebar to see chats that are unread, running, or waiting for your response", with "**Mark all as read**". The desktop "pet" uses four words: "**Running**, **Needs input**, **Ready**, or **Blocked**". The mobile task list lets you "see when your input is needed" ([docs](https://learn.chatgpt.com/docs/mobile.md)); no more detail is given.
- **Devin notification inbox** (2026-10-07): "The bell in the sidebar collects notifications about your sessions, such as when Devin finishes working or needs your attention, and opening a session marks its notifications as read." All/Unread tabs came a release later.
- **Cursor for iOS** ([docs](https://cursor.com/docs/cloud-agent/mobile.md)). "Get a push notification when an agent finishes a turn, and track up to eight agents at once with Live Activities on the lock screen and Dynamic Island." "The app is cache-first. It reads from local data so the inbox and conversations open fast, then syncs once your connection returns." How the inbox itself is grouped is **unverified**.
- **Jules** ([docs](https://jules.google/docs/tasks-repos.md)) had no queue at all: "You will have to navigate to the task to check for updates, approve the plan, etc." Jules is being wound down (see "Surprises").

### Where they disagree

- **Does failure belong with "needs you" or with "done"?** Claude Projects files failed threads under "Waiting on you"; Claude's agent view files them under `Completed`; Warp gives `Failed` its own kind but suppresses it when another item on the same task already wants the person.
- **Is a pull request waiting for review a different thing from a question?** Agent view, Projects and Devin (since September) split them (`Ready for review` versus `Needs input`, `Ready` versus `Blocked`). Codex's Activity view and Linear's Inbox don't.
- **Does a derived queue still need manual state?** Warp says yes (resolve, read/unread). Claude's agent view and Projects have none beyond pin and "mark done". The Map's "Not yet specified" list already carries this question as "Seen it, not now".

## 2. How a run's state and trustworthiness is conveyed

**State, at a glance**

- **Claude agent view** defines six states by icon colour (Working animated, Needs input yellow, Idle dimmed, Completed green, Failed red, Stopped grey) and a separate icon shape for whether the process is alive. The row text is a generated summary: "The one-line summary in each row is generated by a Haiku-class model so the row can tell you what the session is doing, what it needs, or what it produced without opening the transcript." It is refreshed "at most once every 15 seconds" while working, and rewritten "when each turn ends".
- **Pull request status on the run's row.** Agent view colours the pull request number: yellow "Waiting on checks or review, or checks failed", green "Checks passed and no review is blocking", purple merged, grey draft or closed. "For a task that ends in a pull request, check this label for the result: review and merge the pull request when its number turns green."
- **GitHub** shows, per session, "the session log and overview, where you can monitor the agent's progress, token usage, and session length". In the redesigned log, "Similar tool calls are grouped together, reducing noise" ([changelog 2026-01-26](https://github.blog/changelog/2026-01-26-introducing-the-agents-tab-in-your-repository)). GitHub Mobile shows session logs natively since 2026-04-01.
- **Linear's Agent Interaction Guidelines** ([AIG](https://linear.app/developers/aig.md)) put the requirement as a principle: "Agents should clearly indicate whether they're thinking, waiting for input, executing, or finished working. Humans should be able to understand what's happening at a glance and, when needed, inspect the underlying reasoning, tool calls, prompts, and decision logic."

**Trust: who did it**

- **GitHub**: "Commits from Copilot cloud agent are authored by Copilot, with the person who started the task listed as co-author. Each commit message includes a link to the session logs ... Commits are signed and appear as "Verified" on GitHub."
- **Linear**: "Pull request activity can show when a comment was made by an AI coding agent on behalf of a person", with the agent's name, avatar and model. AIG: "An agent should always disclose that it's an agent."
- **Claude auto-fix** replies on GitHub "are posted using your GitHub account ... but each reply is labeled as coming from Claude Code".

**Trust: evidence the work was checked**

- **Cursor**: "Agents create artifacts such as screenshots, videos, and log references to demonstrate their work. These artifacts are attached to the PR so you can quickly validate changes without checking out the branch locally." ([capabilities](https://cursor.com/docs/cloud-agent/capabilities.md))
- **Devin**: after opening a pull request it can record an end-to-end test. "The goal is a short recording that a code reviewer watches and immediately thinks "yep, it works" — then merges the PR." Recordings carry text annotations, slow down at annotated points and auto-zoom to clicks. They are "a **quick sanity check** with one primary end-to-end flow", not coverage ([docs](https://docs.devin.ai/work-with-devin/testing-and-recordings.md)).
- **Linear**: "When a session includes verification artifacts, you can review the screenshots or recordings alongside the proposed changes."
- **GitHub** holds CI back as a trust gate: "By default, GitHub Actions workflows will not run automatically when Copilot pushes changes to a pull request", until someone clicks "**Approve and run workflows**".

**Trust: a rating, and what it is a rating of**

- **Linear risk score**: "`Low risk`, `Typical risk`, `High risk`, `Very high risk`", supplied by a connected tool, optionally with up to eight explanations ("Touches authentication", "Changes database migrations") and "who reported it and when it was last updated". "It complements, rather than replaces, your team's normal review process."
- **CodeRabbit Merge Risk**: Minimal, Low, Moderate, High, Critical, shown with "the first five characters of the commit SHA that the rating covers" and a paragraph of explanation. When the review didn't complete, there is no rating rather than an old one: "A rating that CodeRabbit still shows from an earlier commit does not count."
- **CodeRabbit Triage** labels provenance on every card: "**Provider facts**", "**Review signals**" (which "can be withdrawn when a newer commit lands") and "**Triage's own judgment**". "A card is a **projection**, not a live window onto your provider ... When a decision is expensive to get wrong — closing another contributor's work, or merging — open the pull request and confirm the current state before you act." "When an approval no longer covers the latest commit, no label is shown rather than a stale one."
- **Devin Review** sorts findings by confidence: Bugs (**Severe** or **Non-severe**), Flags (**Investigate**: "review the flagged code yourself", or **Informational**: "explaining how something works ... without requiring action"), and Security (**Critical** or **Warning**).
- **Devin Session Insights** rates the run, not the diff: a size from XS to XL where "Sessions classified as **L** or **XL** are flagged as unhealthy, meaning Devin likely encountered significant issues or the task scope was too broad", plus a colour-coded timeline of issues.

**The Operator's "can I trust this status comment" complaint has one direct answer in the prior art:** tie every claim to the commit it was made about and withdraw it when the commit moves (CodeRabbit, Devin's review history, Linear's preview-behind-latest marker). Nothing read here verifies an agent's own prose status against the run.

## 3. How a long diff is made reviewable on a small screen

**Linear Mobile Diffs** ([launch post, 2026-11-05](https://linear.app/now/mobile-diffs); [docs](https://linear.app/docs/diffs.md)) is the only product read here that names the phone as the place a large pull request is reviewed.

- "Guided Reviews break a pull request into sections, starting with what the change does and why, so a large PR can be reviewed on a phone one section at a time."
- From the docs: "Instead of working through files one-by-one to piece together what changed, Guides surface the core parts of an implementation first while grouping supporting or lower-signal changes separately. Each section pairs a high-level explanation of *why* a part of the change exists alongside the relevant diffs". The guide is "a dedicated **Guide** tab alongside the diff view, with direct links into the relevant parts of the pull request". The landing page adds "separating out supporting changes and glue code".
- Links from email and Slack "open Guide automatically when a guide is available" (changelog).
- **Smaller numbers.** "Line counts in pull request diffs show implementation changes by default, excluding things like tests and documentation", with a `[*]` marker when that differs from the total.
- **File categories.** `.gitattributes` rules sort files into `review-implementation`, `review-test`, `review-documentation`, `review-generated`, `review-agent-guidance`, `review-localization` and `review-assets`, to browse by "**File type** grouping".
- **Layout gives way.** "On smaller screens, Split view may be unavailable if there isn't enough horizontal space." Image, video and font diffs "stack the previous version above the new one on small screens". On narrow pages "Guide progress text is hidden".
- **Progress carries across devices.** "Files you mark as viewed on your phone are already marked when you open the same PR on desktop."
- **Try it, don't read it.** "Preview links open from the diff, so you can try a mobile change on an actual phone."
- Also: syntax-aware "structural highlighting" of the part of a line that changed, and a per-commit filter on the diff.

**Devin Review** ([docs](https://docs.devin.ai/work-with-devin/devin-review.md)).

- "The analysis starts with a short overview of the PR's behavior and impact, followed by key changes in bullets when useful. Related edits are grouped into sections with explanations alongside their diffs."
- "On mobile, the review opens on **Changes**. Switch to **Bugs** to see bugs, flags, and security findings, or use **Description**, **Discussion**, and **Commits** for the PR's other details."
- "Detects when code has been copied or moved and displays changes cleanly, instead of full deletes and inserts." "Hide whitespace-only changes". "Mark files **Viewed**".
- For a pull request with history: "Use **Review history** to inspect an earlier analysis. A link pinned to an older commit does not automatically show the newest results; use **Switch to latest**". "On subsequent reviews, Devin checks for duplicate and resolved findings rather than treating every result as new." Resolved findings "are dimmed in the sidebar and sorted to the bottom".
- Opening it is a URL swap: "replace `github.com` with `devinreview.com`". Linear does the same with `linear.review`.

**CodeRabbit** ([summaries](https://docs.coderabbit.ai/pr-reviews/summaries.md), [walkthroughs](https://docs.coderabbit.ai/pr-reviews/walkthroughs.md), [Change Stack](https://docs.coderabbit.ai/change-stack.md)).

- The summary lives in the pull request description, "groups changes by type", and "is regenerated on every incremental push".
- The walkthrough's changed-files table consolidates: "a PR that modifies one source file and 27 localization files produces two rows".
- "A pull request arrives as a flat list of files in alphabetical order, and nothing about that order reflects how the change was built or how it should be read." Change Stack regroups it into numbered layers: "a contract and the code that implements it and the tests that cover it belong in one layer, not three", in "the order someone would explain the change". Summaries attach to line ranges, not files.
- It admits the grouping is a model's: it "can legitimately come out differently when a later review run regenerates it".
- No phone layout is documented for any of it.

**The agent products' own diff views** are thinner.

- **Claude Code cloud sessions**: a **Changes** card with "the lines added and removed, such as `+42 -18`", opening a diff where you "leave inline comments on specific lines, then send the comments to Claude with your next message". The phone app is documented only as "check progress, answer Claude's questions, or steer it".
- **Cursor for iOS**: "Read full diffs, commits, deployments, approvals, comments, and checks." "On mobile you see changed files in the diff view, not a full workspace." The iPad adds "Read file diffs at full width". No summarising layer is documented.
- **Codex on mobile**: "Inspect changed files and diffs from your phone before deciding what happens next." On desktop the pull request view has a **Summary** tab ("description, activity, comments, and checks") and a **Changes** tab, with "**Mark as viewed**" per file.
- **GitHub**: Copilot can write a summary into the description on request, and "does not take into account any existing content in the pull request description" ([docs](https://docs.github.com/en/copilot/how-tos/use-copilot-for-common-tasks/create-a-pr-summary)). Nothing documents how GitHub Mobile condenses a diff.
- **Graphite** (desktop): a file tree that collapses to "a table of contents visualizer", and `linguist-generated` files hidden by default. Its one small-screen surface draws a line by size: "Reviewing from Slack is available for PRs of up to 25 lines."
- **Jules** showed "a **mini diff** directly in the feed" with a full diff editor in a side pane.

**Pseudocode.** Not found. The ticket asked about it by name; no vendor documents replacing a diff with pseudocode. The alternatives to prose that do exist: CodeRabbit's "Mermaid sequence diagrams showing the updated flow" for changes to "component interactions", and Codex's review instruction presets "**Comic book**, **Visualization**, or **PDF**".

**Review history.** The Operator's complaint about back-and-forth review threads has little prior art. Devin dedupes findings across runs and keeps a per-commit review history; Linear syncs review threads and adds "On behalf of" attribution; Linear's notification settings can "exclude activity from bot actors". Nobody documents collapsing a long thread into its current state.

## 4. How approve, request changes and merge are offered

| Product | Approve / request changes | Merge | Send back to the agent |
| --- | --- | --- | --- |
| **Linear** (phone and desktop) | "Approving a pull request, requesting changes, or submitting a review comment updates the review state and syncs with GitHub." | "Once a pull request is ready and you have permission, you can merge it directly from Linear." Mobile: "Merge approved changes". | "tap the relevant line to add it to your message to steer the coding session"; "send a fix back to an agent" |
| **Devin Review** (phone web and desktop) | "Leave comments, approve PRs, request changes—all within Devin Review, synced to GitHub." | **Merge** with "the repository's configured merge strategy"; the button "reflects the PR's current mergeability status and required checks". Close, convert to draft, mark ready, and auto-merge (the bar shows "who enabled it") sit in the same control. | Chat edits applied "as a commit to the PR branch"; "Ask Devin" on any comment, bug or flag |
| **Cursor for iOS** | "Add or change reviewers"; approvals are readable. Submitting an approval is not mentioned. | "merge with squash, mark ready, update the branch, toggle auto-merge, publish, or close" | "ask an agent to resolve review comments or fix a failing check" |
| **Claude Code Projects** | None in the app. **Review PR** "opens the pull request on GitHub". | **Merge it** is a button that sends "that instruction to the thread as a message from you". | **Resolve conflicts**, **Fix CI**, **Address comments**, same mechanism. Inline diff comments are "bundled" with the next message. |
| **Copilot / GitHub Mobile** | Ordinary GitHub review, except that where approvals are required "your approval of a Copilot pull request won't count". Landing page: "Use comments to refine, iterate, approve and merge—all directly within GitHub Mobile." | Ordinary merge box, plus Agent Merge's "**Watch and fix**". | "mention `@copilot` in a comment, or push commits directly to the branch" |
| **Codex Code Review** (desktop, web) | "Use **Submit review** to choose **Comment**, **Approve**, or **Request changes**". | Not offered from Code Review. | "ask Codex to address specific feedback"; **Fix** on a failing check "prepares a message without sending it" |
| **Warp** | On a spec review: "use **Request changes** to send feedback back to the agent, or **Approve & merge**". | Same control. | Same control. |
| **Graphite** (desktop) | **Finish review**, or keys `R` `C` / `R` `N` / `R` `A`, and `R` `Y` to "quick-approve" without a comment. Comments batch with "Add to review". | A **Merge** button that opens a modal for merge strategy and commit message; `Merge N` for a stack. From Slack: "approve, comment, request changes, or merge" for small pull requests. | Not applicable. |
| **CodeRabbit** | Change Stack: "Write a review under your own provider identity". | "merge or enqueue the pull request"; "the merge control refuses a stale artifact". | A Coding Agent task that it "delivers as a commit or a stacked pull request for you to approve". |

Patterns across the table:

- **Two models of acting.** Linear, Devin, Cursor and Graphite write to the code host directly as the person. Claude Projects and Agent Merge instead tell an agent to do it. The Map's settled point 1 ("every action it takes is an ordinary GitHub write made as the Operator") matches the first model.
- **"Request changes" and "send it back" are the same gesture in most agent products**: a message to the session with line references attached. Only Warp, Linear and Devin keep the code host's formal "request changes" review state alongside it.
- **The merge control is where state is disclosed.** Devin shows mergeability and who turned on auto-merge; Linear and Devin show "how many pull requests the action affects" for a stack; Graphite "will update a single comment on GitHub with the status of your PR's merge".
- **Watch-and-fix is offered next to merge**, not as a separate screen: GitHub's "**Watch and fix**" in the merge box, Claude's **Auto-fix** in the Changes card's menu. Both state the limit: "Agent Merge does not remove the need for human review."
- **Immediate versus batched.** Graphite and Claude batch comments until submit; Codex warns that comments typed in two of its tabs post "immediately, without waiting for **Submit review**".
- **An automatic approver exists.** Devin's Autoapprover (beta) "posts real approvals" on a rubric of intent, code quality and incident risk, reads its rules "from the target branch, so a PR cannot write its own approval rules", and shows one of "**Autoapproved**", "**Not autoapproved**" or "**Approved by a person**". CodeRabbit has "approval risk limits". Neither merges.

## 5. How cost or usage is shown

| Product | Unit shown | Where | Per piece of work? |
| --- | --- | --- | --- |
| **Claude Code** `/usage` ([docs](https://code.claude.com/docs/en/costs.md)) | Plan-usage bars for subscribers; a session "Total cost" in dollars "computed locally from token counts at list price"; a usage-credits row measured "against your monthly spend limit" | Terminal and VS Code. Not the phone. | Per session. Attribution to "skills, subagents, plugins, and individual MCP servers, each shown as a percentage of the total", over "the last 24 hours and the last 7 days". |
| **Claude Code Projects** | Tokens | **Usage** in project settings | "token use by thread and by model, and how much went to the project conversation" |
| **Warp** ([docs](https://docs.warp.dev/factories/factory-dashboard/)) | Dollars or credits | Factory Dashboard; each run's page shows "its timeline and cost" | "**Cost per PR** - The median cost of PRs opened in the range. A run's cost includes its child runs and splits evenly across the PRs it produces." The chart breaks cost into "compute, platform, and inference" (alt text). |
| **Linear** ([docs](https://linear.app/docs/usage-and-limits.md)) | Dollars of AI credits | **Settings → Usage & limits**, admins only | "total spend, session count, and average spend per session"; group by Team, Feature, Source or Session; hover a session for "token costs by model, compute costs, and total spend". "Loop costs include the coding work the loop starts." |
| **Devin** | ACUs (Agent Compute Units) | A size chip beside the session title; a "consumption pill" on each pull request in Devin Review; Settings → Consumption | Per session (XS to XL) and per pull request's reviews ("Hover over the size pill to see the exact ACU total, the number of review jobs run"). Per-user and per-repository breakdowns, the latter with "the number of bugs caught". |
| **Copilot** | Tokens and time per session; "AI credits" for billing | Session overview | "token usage, and session length". "Each steering message consumes AI credits." Agent Merge's credits "are charged to the user who enables it". |
| **Cursor** ([docs](https://cursor.com/help/models-and-usage/usage-limits.md)) | Share of a weekly pool, the next reset date, prepaid credit | A web dashboard. "Admin, billing, and usage. Web only." | "request-level cost details" on the dashboard; nothing per agent run is documented. |
| **Codex** ([docs](https://learn.chatgpt.com/docs/pricing.md)) | Remaining limits and reset times | A web usage dashboard; `/status` in the CLI | No per-task figure documented. |

Patterns:

- **Subscription share and dollar cost are almost never on one screen.** Tools sold by subscription (Cursor, Codex, Claude Code) show a share of a pool and a reset time. Tools sold by metered credit (Linear, Devin, Warp, Copilot) show spend per unit of work. Claude Code's `/usage` is the exception, and it warns that for subscribers the dollar figure "isn't relevant for billing purposes".
- **T-shirt sizes stand in for numbers.** Devin shows XS to XL with the exact figure on hover, and reuses the size as a health signal.
- **Roll-up rules are stated.** Warp splits a run's cost "evenly across the PRs it produces" and includes child runs; Linear includes the coding work a loop starts in the loop's figure and keeps earlier usage with its original team when an issue moves.
- **Limits are soft and say so.** Linear: "concurrent or already-running work can cause spending to exceed a limit". Devin's per-pull-request review limit is "a soft block". Claude Projects: "A thread that stops at your plan's limit waits and by default continues on its own when the limit resets."
- **Staleness is displayed.** When Claude Code can't fetch plan limits it shows the last bars with "a `Showing last-known usage` note stating how long ago that data was fetched".
- **Background cost is called out.** Claude Projects: "an idle thread wakes up and uses your plan again when CI fails or a review comment arrives on its pull request."

## Surprises

- **Linear shipped phone code review five days before this was written.** Mobile Diffs (2026-11-05) puts guided review, viewed-state sync, preview links, agent hand-back and merge in a native phone app. It is the nearest thing to the Review and Digest screens together, and it is new enough that no secondary write-up was needed or used.
- **Warp's Factory inbox is already a "queue of moves owed"**, down to items clearing themselves and the queue being personal. It still kept read/unread and manual resolve.
- **Google is shutting Jules down.** "Jules will wind down on December 31, 2026", read-only after 2026-11-11, "as part of our work to unify our agentic coding efforts" into Google Antigravity. Its plan-approval-then-activity-feed shape is prior art with no future.
- **Two competitors chose a PWA for the phone.** Devin "can now be installed as a Progressive Web App on desktop and mobile" (2026-03-07), and Cursor's Android route is "tap **Install App** for a Progressive Web App" while iOS got a native app. That bears on the Map's settled point 4.
- **Nobody shows spend on a phone, and Cursor says so in as many words.**
- **Nobody read here documents pseudocode over a diff, "out of scope" or "follow-ups"** as parts of a pull request account. The Digest's listed sections go past this prior art.
- **On GitHub, the person Copilot asks to review its pull request can't count as a required approver.** The docs give no reason; the same docs list "the person who started the task" as co-author of every Copilot commit, so the likely reading (**inferred**) is that asking for the work counts as co-authoring it. Fabrik's pull requests aren't Copilot's, so this doesn't bite today.
- **OpenAI's Codex docs have moved** under `learn.chatgpt.com`, and **Cursor's usage docs now describe "The X Subscription"** with a weekly pool shared with Grok products. Both products' docs read differently from a few months ago; anything remembered about them should be rechecked.
