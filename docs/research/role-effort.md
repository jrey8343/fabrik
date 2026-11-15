# What effort does each role run at today, and what does each level buy?

Research for Decision [#712](https://github.com/jrey8343/fabrik/issues/712) on the Map [#709](https://github.com/jrey8343/fabrik/issues/709) (Wayfinder: fewer Retries per merged pull request). All sources were read on **2026-11-16**. Claude Code's docs at code.claude.com and the API docs at platform.claude.com were fetched as Markdown on that date, when the newest Claude Code release was v2.1.325 (2026-11-13). The Kit's code was read at commit `e1e62b6`. Terms follow `GLOSSARY.md` (Kit config, role, Implementer, Reviewer, Design session, Step-up, Subscription, Replay, Run record).

Each claim is tagged with how much weight it can bear:

- **[documented]**: stated on an Anthropic-owned page (code.claude.com, platform.claude.com, support.claude.com) or in Claude Code's changelog.
- **[code]**: read from the Kit's code or its pinned dependencies, cited by file and line.
- **[illustration]**: published by Anthropic on a blog its docs link to, but as a worked example or an internal test run, not a specification.
- **[inferred]**: follows from documented or coded facts, but no document says it and no run here checked it.
- **[not documented]**: looked for and not found.

Nothing here comes from a run. No `claude` session was started to check a default.

## Answer in brief

**Every role runs at `medium` today.** Kit config leaves every role's `effort` at `null`, so the Kit passes no `--effort` flag, and Claude Code then uses its own default for the model, which is `medium` for both Opus 5.5 and Sonnet 5.5 [documented]. For Opus 5.5 that is also the API's default. **For Sonnet 5.5 it is not**: the API's default is `high`, and Claude Code sends `medium` in its place [documented]. So the Implementer, the one role on Sonnet 5.5, runs one level below what the model would do if nothing were sent.

**What the documents say a level buys** is behaviour, not a number. Effort scales every output token: thinking, tool calls and text. Higher levels read more, verify more, test more edge cases and carry more of a task through without checking in; lower levels return sooner and can skip a check [documented]. Anthropic publishes **no token, time or quality figure per level** for either model, only the direction, a few worked examples, and the advice to run an effort sweep on your own evals [not documented]. Effort has **no separate weight against a Subscription's weekly limit** in any document: higher effort uses more tokens, "so you'll reach your usage limits faster", and that is all that is said [documented].

**Two documented behaviours bear directly on Retries**, and a Replay is the only way to size either:

1. Sonnet 5.5 at `low` and `medium`, on long agentic coding tasks, "sometimes checks in before the work is done", and Anthropic's first remedy is "Try a higher effort level first". An AFK Implementer has nobody to check in with.
2. Anthropic's own tests found extra effort helped most where "verification and edgecase testing was more useful like hardware, code review, and security", and that it reduces failures from missed edge cases but "does not fix when the model has the wrong approach".

## 1. How a role's effort reaches the CLI

| Step | Where | Status |
|---|---|---|
| Kit config's `roles.<role>.effort` is `null` or one of `low`, `medium`, `high`, `xhigh`, `max`. "null means pass no --effort, so the Claude Code CLI uses its default." | `src/kit/config.ts:9-10`, `:707-714` (`readAgentRole`), `:992-998` (`EFFORTS`, `checkEffort`); README "Kit config" (`README.md:461`) | code |
| The Loop's plan carries the role's `model` and `effort` on its `start-agent-run` action. An Implement run with a Step-up reason takes `roles.step_up`'s pair instead of `roles.implement`'s. | `src/loop/runs.ts:4-9`; `src/loop/retry.ts:51-55` (`implementSettings`); `src/loop/implement.ts:94`; `src/loop/review.ts:47` | code |
| The Kit job passes them out as its `model` and `effort` outputs. A `null` effort becomes the empty string. | `src/kit/jobs.ts:251-252`; `.github/workflows/loop.yml:119-121` | code |
| Each agent job hands them to the runner as the env vars `FABRIK_MODEL` and `FABRIK_EFFORT`. | `.github/workflows/loop.yml:587-588` (and the same pair in every agent job); a Replay arm's come from its arm settings, `.github/actions/replay-implement/action.yml:109`, `.github/actions/replay-review/action.yml:120` | code |
| The runner reads them: an unset or empty `FABRIK_EFFORT` is `null`. With no `FABRIK_MODEL` it falls back to the role's own Kit config pair. | `src/agent/run.ts:376-384` (`modelFor`), `:398-401` | code |
| The runner starts the agent through Sandcastle's `claudeCode(model, options)`, passing `{ effort }` only when it is not `null`. | `src/agent/run.ts:544-547` | code |
| Sandcastle 0.14.0 builds the command `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model <model>[ --effort <level>] -p -`. The flag is there only when the option is. | `node_modules/@ai-hero/sandcastle/dist/chunk-H2PEFS4W.js:1180-1184`; mirrored for the preflight by `claudeArgs`, `src/agent/launch.ts:89-103` | code |

So the only channel is the **`--effort` CLI flag**, which sets "the effort level for the current session", overrides the `modelSettings` and `effortLevel` settings for it "and doesn't persist" [documented, R]. The Kit sets no effort env var and writes no effort setting:

- `CLAUDE_CODE_EFFORT_LEVEL` appears nowhere in `src/`, `.github/`, `templates/` or `prompts/`, and a Product repo cannot set it through `sandbox.env`, which refuses every name starting with `CLAUDE_` (`src/kit/config.ts:1017-1021`) [code].
- `templates/claude-settings.json`, the settings a Product repo merges in at Setup, holds a `SessionStart` hook and a plugin switch, and no `effortLevel` or `modelSettings` [code].

**When effort is `null`, the Kit passes nothing**: no flag, no env var, no setting. What happens next is Claude Code's resolution order (section 3).

**The CLI the Kit installs** is `@anthropic-ai/claude-code` **2.1.319**, pinned exactly (`package.json:25`), released 2026-11-06 [documented, changelog]. The runner puts the Kit's own `node_modules/.bin` first on `PATH` and sets `DISABLE_AUTOUPDATER=1` (`src/agent/launch.ts:130-134`), so that version is the one that runs. Dependabot proposes bumps to it weekly, one pull request per upstream (`.github/dependabot.yml:12-19`) [code].

## 2. Each role's default model and effort

From `DEFAULT_KIT_CONFIG` (`src/kit/config.ts:421-437`) and README "Kit config" (`README.md:401-440`) [code]. The last column is section 3's reading of the docs.

| Role | Default model | Kit config effort | Level the CLI runs it at |
|---|---|---|---|
| Triage | `claude-opus-5-5` | `null` | `medium` |
| Design session (and a prototype turn, which runs on the Design model and effort, `src/loop/design.ts:131`) | `claude-opus-5-5` | `null` | `medium` |
| **Implementer** | **`claude-sonnet-5-5`** | `null` | **`medium`** (the API's own default would be `high`) |
| Reviewer | `claude-opus-5-5` | `null` | `medium` |
| Auditor | `claude-opus-5-5` | `null` | `medium` |
| Retro | `claude-opus-5-5` | `null` | `medium` |
| Researcher | `claude-opus-5-5` | `null` | `medium` |
| Digest writer (the repo's own `roles.review` unless `roles.digest` sets its own) | `claude-opus-5-5` | `null` | `medium` |
| Step-up (an Implementer run on `roles.step_up`) | `claude-opus-5-5` | `null` | `medium` |
| Dispatch | none: it runs no agent, and takes a timeout only | n/a | n/a |
| The judge (a Kit constant, not Kit config: "Sonnet, at its default effort", `src/kit/runStore.ts:17-22`, `src/kit/judgeLaunch.ts:41`) | `claude-sonnet-5-5` | never passed | `medium` |

A Step-up changes the model from Sonnet 5.5 to Opus 5.5 and leaves the level name at `medium`. Because "the effort scale is calibrated per model, so the same level name does not represent the same underlying value across models" [documented, M], the two `medium`s are not the same amount of work.

## 3. What `null` resolves to in a headless run

Claude Code "resolves the session's effort level in this order, taking the first that applies" [documented, M]:

1. The `CLAUDE_CODE_EFFORT_LEVEL` environment variable.
2. A level picked in the session (`/effort`, the `/model` picker, the SDK's `applyFlagSettings()`).
3. Launching with `--effort`.
4. Settings: a per-model level under `modelSettings`, or an `effortLevel` key.
5. "The model's default effort: Fable 5.2, Opus 5.5, Sonnet 5.5, and Haiku 5.5 default to `medium`, and Opus 4.7 defaults to `xhigh`. Other models in the effort levels table default to `high`."

With `null`, steps 1 to 3 don't apply in a Kit run. Step 4 applies only if a settings file the run loads sets a level (see the caveats below). Otherwise step 5 decides:

| Model | Claude Code's default | The API's default when no effort is sent | Status |
|---|---|---|---|
| `claude-opus-5-5` | `medium` | `medium` ("Claude Opus 5.5 supports all five effort levels, and `medium` is the default") | documented [M], [E], [O] |
| `claude-sonnet-5-5` | `medium` | `high` ("Claude Sonnet 5.5 supports all five effort levels, and `high` is the default on the Claude API") | documented [M], [E], [S] |

The two columns differ for Sonnet 5.5 because Claude Code sends its own default rather than sending nothing: "When Claude Code sends no effort level to a supported model, the API's default applies instead of Claude Code's", and sending none takes an explicit `CLAUDE_CODE_EFFORT_LEVEL=auto` [documented, M]. Kit config's "the CLI's default" and "the model's default" are therefore the same thing for the Opus roles and different things for the Implementer.

What the documents do and don't pin down about a headless run:

- **No separate rule for `-p`.** The resolution order is stated for "the session" with no interactive or headless exception, and no plan-specific default is stated for the 5.5 models [documented absence]. (Older models did have plan-specific defaults: v2.1.117's "Default effort for Pro/Max subscribers on Opus 4.6 and Sonnet 4.6 is now `high`" [documented, C].)
- **The docs describe the newest release, and the Kit pins 2.1.319.** Opus 5.5 arrived in v2.1.280 and Sonnet 5.5 in v2.1.284; the changelog has no entry from then to v2.1.325 that states or changes either model's default effort [documented, C]. That `medium` is what 2.1.319 does is therefore **[inferred]** from the current page plus the absence of a change entry, not stated for that version.
- **A Dependabot bump can move it.** The level `null` means is whatever the pinned CLI's default is on the day, and Claude Code has changed defaults before (v2.1.94, v2.1.117) [documented, C]. A Run record's `effort: null` doesn't say which level ran.

Caveats, each **[inferred]** from the documented order and not checked by a run:

- **A Product repo's own settings can decide the level while Kit config says `null`.** "A top-level `effortLevel` in project, local, or managed settings, or one passed with `--settings`, applies to every model" [documented, M], and the agent runs in the Product repo's checkout, whose `.claude/settings.json` and `.claude/settings.local.json` the run loads (the same files the preflight reads, `src/preflight/main.ts:38-48`). `--effort` outranks settings, so this only bites at `null`. A user-level `effortLevel` on the runner would not count for Opus 5.5 [documented, M], and a fresh GitHub-hosted runner has no saved per-model level.
- **A skill can change the level for a turn.** A skill's `effort` frontmatter "applies until the end of the turn it runs in … whatever level you launch with" [documented, M]. None of Fabrik's own skills in `skills/` sets one [code]. The Base skills at their pinned commit and a Product repo's Extra skills were not checked.
- **Subagents on another model don't follow the role's level.** "On the main conversation's model, a subagent … with no `effort` of its own runs at the level you pick in the session or set with `--effort`. On another model, that level doesn't apply" [documented, M; changed in v2.1.317, C]. A role run at `high` that spawns a subagent on a different model runs that subagent at that model's default.

**The Kit can't currently see which level ran.** The run's stream never names it: the `effort` field of the init message is set "only on the init message it sends to Remote Control clients", and Claude Code "omits it from the init message your application reads" [documented, K]. The step summary prints "CLI default" for `null` for that reason (`src/agent/summary.ts:4-5`, `:104`), and the Run record stores what the runner passed, not what the CLI resolved (`src/kit/runRecord.ts:214`, `:720-731`) [code]. Two documented places do carry the level in force: OpenTelemetry's `effort` attribute on `api_request` ("Absent when Claude Code sends no effort level") and the `CLAUDE_EFFORT` variable "set automatically in Bash tool subprocesses and hook commands" [documented, T, V].

## 4. What each level changes

**The mechanism, for both models [documented, E]:** "The effort parameter affects **all tokens** in the response", which covers text, tool calls and thinking. "Lower effort also means fewer and terser tool calls." It is "a behavioral signal, not a strict token budget". Thinking is always on for Opus 5.5 and Sonnet 5.5 in Claude Code and can't be turned off, so effort is the only dial on how much they think [documented, M]. With tools, lower levels tend to "combine multiple operations into fewer tool calls", "make fewer tool calls" and "proceed directly to action without preamble"; higher levels "make more tool calls", "explain the plan before taking action" and "provide detailed summaries of changes".

**The levels as Claude Code describes them [documented, M]:**

| Level | When to use it, per Claude Code's docs |
|---|---|
| `low` | "Quick exchanges where you review each result, such as brainstorming, a first sketch, or a small change like a rename" |
| `medium` | "The default on the Fable 5.2, Opus 5.5, Sonnet 5.5, and Haiku 5.5 models. On Opus 5.5 and Sonnet 5.5, it fits day-to-day engineering work with a clear scope, such as implementing a new feature." |
| `high` | "Work where verification matters or edge cases are likely, such as fixing a bug in an existing codebase." |
| `xhigh` | "Deeper reasoning at higher token spend." The API docs add: "Long-running agentic and coding tasks (over 30 minutes) with token budgets in the millions" [E]. |
| `max` | "Hard problems you want Claude to work through without you, such as finding security vulnerabilities. `max` may show diminishing returns and is prone to overthinking, so test before adopting it broadly." |

"In tests on Opus 5.5 and Fable 5.1, Claude at a higher level tested more edge cases and verified more of its work before answering. It also made more choices on its own. At a lower level, Claude returned a starting point sooner, which fits work where you review each result and steer the next step." [documented, M]

**Opus 5.5 (every role but the Implementer, and every Step-up) [documented, E, PO, M]:**

- "In Anthropic's testing, Claude Opus 5.5 at `medium` matches or exceeds Claude Opus 5 at `high` on coding and knowledge-work evaluations, and on several coding evaluations `low` comes close to it at much lower cost."
- "At a given level, Claude Opus 5.5 tends to think more per turn than Claude Opus 5, especially at `xhigh` and `max`." Expect "longer turns and more output tokens".
- "Reserve `xhigh` and `max` for work where you've measured a quality gain."
- "Run an effort sweep on your own evals rather than carrying settings over from an earlier model."

**Sonnet 5.5 (the Implementer, and the judge) [documented, E, PS]:**

- "Start with `high` unless your workload is agentic or latency-sensitive. For agentic coding and multistep tool use, start with `medium` for well-specified tasks and move to `high` for harder or longer ones."
- At `low`: "it keeps its thinking short and can skip verifying a change"; "it sometimes reports a change as done without running a check that exercises it. For example, it might skip the project's tests because the project's dependencies aren't installed."
- At `low` and `medium`: "On agentic coding tasks at `low` and `medium` effort, the model sometimes checks in before the work is done. It might pause to confirm a plan, ask a question it could answer itself, or stop after one part of a multipart task to ask whether to continue. Try a higher effort level first." The alternative offered is a system-prompt paragraph ("Keep working until everything the user asked for is done…"), with the note that then "sessions at those levels run longer and cost more".
- At every level, "and more at higher effort": it "tends to add tests, documentation, and small supporting files that fit your repository's conventions, even when you don't ask for them".
- At `xhigh` and `max`: "After it completes a task, it can start its own rounds of review and verification, sometimes with subagents if your harness provides them. It can also make related fixes it noticed along the way. This takes more time and tokens, so run routine work at `high` or below, where it's rare." Also "thinking and replies get much longer there".
- Its levels are "recalibrated: a level doesn't produce the same amount of thinking as the same level on Claude Sonnet 5".

## 5. What is documented about tokens, time and quality

| Question | What the documents say | Status |
|---|---|---|
| Direction | "Lower effort is faster and cheaper for straightforward tasks, while higher effort provides deeper reasoning for complex problems." "Each level trades token spend against capability." | documented [M] |
| Tokens per level, for Opus 5.5 or Sonnet 5.5 | No multiplier, range or table. The nearest figures: `xhigh` suits "token budgets in the millions" [E]; "the default budget can be tens of thousands of tokens per request depending on the model" for thinking [CO]. | not documented |
| How the tokens are priced | Thinking, tool calls and text "are all ordinary output tokens from the same loop, billed at the same rate" [B1]. "You are charged for all thinking tokens generated, even when collapsed or redacted" [M]. So a higher level shows up as more output tokens in a run's result message, and in its equivalent API cost. | documented |
| Time per level | No figure. "Higher effort means a longer wait before the reply starts" [PS]. | not documented |
| Quality per level | No published benchmark table by effort for either model in the docs. The comparisons given are across models (Opus 5.5 at `medium` against Opus 5 at `high`), not across levels. | not documented |
| Above `high` | Gains are uneven: "Use `xhigh` or `max` only where your evals show a quality gain" [E, both models]; `max` "may show diminishing returns and is prone to overthinking" [M]. | documented |
| One illustrative ratio | A diagram of one prompt at two levels: "The high effort path generates roughly 7x more tokens to reach a higher confidence answer." The post predates both 5.5 models (2026-07-07) and names no model for the diagram. | illustration [B1] |
| Worked times | One engineer's builds of one app. Underspecified prompt, on Opus 5.5: `low` 1.5 min, `medium` 4 min, `high` 11 min, `max` 67 min. The same app from a detailed spec: `low` 16 min, `medium` 22 min, `high` 33 min, `max` 79 min, where "the models behaved much more similarly" (the post doesn't name the model these four times are from). | illustration [B2] |
| Worked pass rates, Opus 5.5 | Three Terminal-Bench 3.0 tasks picked because effort changed the outcome, 5 attempts each: 0/5 at `low` to 4/5 at `xhigh`; 0/5 at `low` to 5/5 at `high`; 0/5 at `low` to 4/5 at `high`. Internal runs, not the public leaderboard. | illustration [B2] |
| Where effort helps | "Extra effort gave better results in domains where verification and edgecase testing was more useful like hardware, code review, and security." "Increasing effort tends to reduce failures due to missing edgecases … but does not fix when the model has the wrong approach." | illustration [B2] |
| Which dial for which failure | "If Claude has all the pertinent context, clearly tried, and still got it wrong, that's a signal to pick a more capable model. If Claude got it wrong by skipping a file, not running the tests, or bailing on a refactor partway through, pick a higher effort level." | illustration [B1] |

Nothing in [B2] is about Sonnet 5.5: its tests ran on Opus 5.5 and Fable 5.1.

Two consequences for the Kit, both **[inferred]**:

- **A role's timeout bounds what a level can spend.** Implement has 60 minutes and Review 30 by default (`src/kit/config.ts:429-430`). The one published `max` build from a detailed spec took 79 minutes [B2], and Sonnet 5.5 at `xhigh` and `max` starts review rounds of its own [PS]. A run at those levels may time out where the same run at `medium` finishes.
- **Effort is constant for a whole run, so the prompt cache is unaffected.** The cache warnings in the docs are about changing the level mid-conversation [E], which no role does.

## 6. Effort and a Subscription's weekly limit

| Claim | Source | Status |
|---|---|---|
| "Your usage is affected by several factors, including the length and complexity of your conversations, the features you use, which Claude model you're chatting with, and the effort level you've selected." | [L] | documented |
| "Higher effort means more thorough responses, but they take longer and use more tokens, so you'll reach your usage limits faster." | [G] | documented |
| "Lower the effort level: Choose a lower effort level for routine tasks that don't need Claude's most thorough responses. Higher effort uses more tokens." On models where thinking is always on, "such as Claude Opus 5.5 and Sonnet 5.5, choose a lower effort level instead" of turning thinking off. | [L] | documented |
| "Effort level" is one line in the list of "factors that affect your usage limits", beside model choice and tool usage. | [U] | documented |
| Claude Code's `/usage` gained "warnings for max effort" in v2.1.299, and its recommendations can read "Switch from max to high effort". | [C], [CO] | documented |
| Whether a level carries any weight of its own, apart from the tokens it produces. | none found | not documented |
| How thinking tokens are weighted against the weekly limit (as output tokens, or otherwise), and how many tokens the weekly allowance holds. | none found | not documented |

So the only documented link is **through tokens**: a higher level produces more output tokens, and more tokens use the week faster. **[inferred]** There being no stated per-level weight, a run's equivalent API cost (which prices thinking as output) is the best available proxy for what a level costs the week, as `docs/research/subscription-cost-equivalent.md` sets out; how closely the weekly limit tracks that cost is itself unpublished.

## 7. What a Replay can and can't show

From README "Replay" (`README.md:320-340`) and `src/kit/replay.ts`, `src/kit/replayPick.ts` [code].

**What `implement.effort` and `review.effort` test.** A replay issue names exactly one variable, set to `low`, `medium`, `high`, `xhigh` or `max`. For up to 10 merged Tickets (5 by default) it runs two arms from each Ticket's `baseSha`: the baseline with the models and efforts Kit config held there, and the variant differing only in that one effort (`src/kit/replayPick.ts:219-235`). Each arm is one Implement run and one Review. It reports, per arm: the gates (`sandbox.setup`, `sandbox.build`, `sandbox.test`), the merged pull request's tests laid over the arm's diff (the hidden tests), the Verdict, the three Scorers' scores, cost, turns and duration, with totals beside the original runs and "the baseline's gap from the original, which shows how much results vary by chance".

That is exactly the measurement the documents decline to give: for the Kit's own Tickets, at the pinned CLI, **what a level costs in equivalent dollars, turns and minutes, and what it changes in gates, hidden tests, Verdicts and scores**. In particular only a Replay can show:

- Whether the Implementer on Sonnet 5.5 passes its first Review more often at `high` than at `medium`, and at what cost. The docs say `medium` suits "well-specified tasks" and `high` "harder or longer ones", and can't say which the Kit's Tickets are.
- Whether Sonnet 5.5's documented checking-in at `medium` happens in the Kit's Implement runs at all, where it would show as a part-built Ticket or a run that ends on a question, and whether `high` removes it.
- Whether the Reviewer on Opus 5.5 judges differently at `high` than at `medium`.
- Whether a level fits inside the role's timeout on real Tickets.
- How large run-to-run variation is at a fixed level, which is what any difference between levels has to beat.

**What it can't show.**

- **Only two roles.** The variables are `implement.*` and `review.*`. Triage, the Design session, the Auditor, the Retro, the Researcher and the Digest writer can't be replayed. `roles.step_up`'s effort is not a variable of its own: it enters only as the baseline of a Ticket marked for a Stepped-up start, where `implement.effort` then varies it.
- **One variable at a time.** No Replay crosses effort with model (Sonnet 5.5 at `high` against Opus 5.5 at `medium`, the choice a Step-up actually makes), or changes both roles' efforts together. Two Replays over the same Tickets give two separate comparisons against two separate baselines.
- **No Retry and no Step-up.** Each arm stops after one Implement run and one Review. A Replay shows first-run outcomes, a proxy for first-pass yield. It can't show Retries per merged pull request, the Map's yardstick, or whether a costlier first run is repaid by Retries it saves; that has to be reasoned from the first-run figures.
- **`review.effort` compares Reviews of two different diffs.** Both arms run their own Implement run at the same settings, and each arm's Reviewer judges its own arm's diff. A difference in Verdicts mixes the Reviewer's level with the chance difference between two Implement runs [inferred]. And a Replay has no ground truth for a Verdict: the hidden tests and gates grade the diff, not whether the Reviewer was right about it. It can't show a Review miss or an Architectural escape, which only surface after merge.
- **`null` against `medium` is two arms at the same level.** The pick leaves a Ticket out only when its config value equals the variable's (`src/kit/replay.ts:343-350`), and `null` is not the string `medium`. A Replay of `implement.effort: medium` over Tickets built at `null` would run, with both arms at `medium` by section 3 [inferred]. That is a waste as a comparison, though it would measure chance variation and confirm section 3's reading at the pinned CLI.
- **Small, selected samples.** Five Tickets by default, ten at most, and only merged, never-reverted ones whose pull request changed no Trust-root file. Tickets that went back to design or never merged, where a level might matter most, are never in the pick.
- **The weekly limit only as an estimate.** Each arm's record has its equivalent cost and a weekly-limit reading, and the Replay runs only while that reading is under 50%. It shows what a level costs in tokens and equivalent dollars, not its share of the week, for the reasons in section 6.
- **This CLI, these models.** Results hold for the pinned Claude Code release and the two 5.5 models. Levels are recalibrated per model [documented], so a result doesn't carry to a later model or necessarily across a default change in a CLI bump.

**The store holds no comparison yet.** Per the Map's read of the Run records, every run's record in the week of 2026-11-09 has `effort: null`, so there is no pair of levels to compare. (Taken from the Map; the store was not re-read here.) A Replay costs "about twice the original Tickets' first Implement runs and their Reviews".

## What this research could not establish

1. **Tokens, minutes or pass rates per level for Opus 5.5 or Sonnet 5.5.** Not published. Anthropic's answer is to sweep effort on your own evals.
2. **Whether `medium` is what v2.1.319 resolves `null` to**, stated for that version. It is inferred from the current docs and a changelog with no change entry. A run that prints `$CLAUDE_EFFORT` from a Bash tool call, or exports OpenTelemetry, would settle it.
3. **Whether the weekly limit weights effort or thinking tokens in any way beyond token count.** Not published, as with the allowance itself.
4. **Whether any Product repo's `.claude/settings.json` sets `effortLevel`**, which would override `null` there. Product repos were not read.
5. **Whether the Base skills at their pinned commit, or any Extra skill, carry `effort` frontmatter.** Not checked.
6. **Why Claude Code's default for Sonnet 5.5 is one level below the API's.** Both defaults are documented; the reason is not.

## Sources

Anthropic-owned, read 2026-11-16:

- **[M]** Claude Code docs, [Model configuration: Adjust effort level](https://code.claude.com/docs/en/model-config#adjust-effort-level) (resolution order, per-model defaults, the level table, "Send no effort level", subagents, where thinking can't be turned off).
- **[E]** API docs, [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) (how effort works, the level table, recommended levels per model, effort with tool use).
- **[O]** API docs, [Claude Opus 5.5 overview](https://platform.claude.com/docs/en/models/opus-5-5/overview) (default effort `medium`).
- **[S]** API docs, [Claude Sonnet 5.5 overview](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) (default effort `high`).
- **[PO]** API docs, [Prompting Claude Opus 5.5: Calibrate effort](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5#calibrate-effort).
- **[PS]** API docs, [Prompting Claude Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5) ("Calibrate effort", "Steer initiative and scope", "Verification on coding tasks").
- **[C]** Claude Code [changelog](https://code.claude.com/docs/en/changelog): v2.1.319 (2026-11-06), v2.1.317 (subagents on another model), v2.1.299 (`/usage` warnings for max effort), v2.1.284 (Sonnet 5.5 added), v2.1.280 (Opus 5.5 added; saved levels no longer apply to new models), v2.1.117 and v2.1.94 (earlier default changes).
- **[R]** Claude Code docs, [CLI reference](https://code.claude.com/docs/en/cli-reference) (`--effort`: "Set the effort level for the current session … overrides the `modelSettings` and `effortLevel` settings for this session and doesn't persist") and [Settings reference](https://code.claude.com/docs/en/settings-reference#effortlevel) (`effortLevel`, `modelSettings`).
- **[V]** Claude Code docs, [Environment variables](https://code.claude.com/docs/en/env-vars) (`CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_EFFORT`).
- **[K]** Claude Code docs, [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript) (the init message's `effort` field).
- **[T]** Claude Code docs, [Monitoring](https://code.claude.com/docs/en/monitoring-usage) (the `effort` attribute).
- **[CO]** Claude Code docs, [Costs](https://code.claude.com/docs/en/costs) ("Adjust extended thinking"; `/usage` recommendations).
- **[L]** Support, [How do usage and length limits work?](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work) (modified 2026-11-04).
- **[G]** Support, [Change the model, effort, and thinking settings](https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings) (modified 2026-11-09).
- **[U]** Support, [Usage limit best practices](https://support.claude.com/en/articles/9797557-usage-limit-best-practices) (modified 2026-10-30).
- **[B1]** Claude blog, [Choosing a Claude model and effort level in Claude Code](https://claude.com/blog/claude-model-and-effort-level-in-claude-code) (2026-07-07), linked from [M].
- **[B2]** claude.dev blog, [Using Claude Code: Spending your effort](https://claude.dev/blog/spending-your-effort/) (2026-09-25), linked from [M].

The Kit, at commit `e1e62b6`: `src/kit/config.ts`, `src/agent/run.ts`, `src/agent/launch.ts`, `src/agent/summary.ts`, `src/kit/jobs.ts`, `src/kit/runRecord.ts`, `src/kit/runStore.ts`, `src/kit/judgeLaunch.ts`, `src/kit/replay.ts`, `src/kit/replayPick.ts`, `src/loop/runs.ts`, `src/loop/retry.ts`, `src/preflight/main.ts`, `.github/workflows/loop.yml`, `package.json`, `README.md`, and Sandcastle 0.14.0 as installed.
