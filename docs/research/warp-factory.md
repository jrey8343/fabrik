# How Warp's software factory works

Research for [#3](https://github.com/jrey8343/fabrik/issues/3): how Warp's software factory works end to end, and which of its patterns Fabrik should borrow.

Researched 2026-11-02. Sources, in order of trust:

1. **Code.** The local clone of `warpdotdev/warp` (HEAD `d57d9760d`, 2026-10-30), plus the two public repos that clone depends on: [`warpdotdev/oz-for-oss`](https://github.com/warpdotdev/oz-for-oss), the control plane for the open-source repo's agents, and [`warpdotdev/common-skills`](https://github.com/warpdotdev/common-skills), the shared skills.
2. **Docs.** Warp's own documentation at [docs.warp.dev/factories](https://docs.warp.dev/factories).
3. **Zach Lloyd's writing**, all of it on warp.dev. These posts are first-party but promotional, and every number in them is self-reported.
4. **Interviews**, which are secondary write-ups. They are cited only for things nothing else covers.

## TL;DR

Warp runs two factories that share one design.

- **The public `warp` repo** runs on *Oz for OSS*: GitHub webhooks feed a Vercel control plane, which starts Oz cloud-agent runs that use skills.
- **Internal work** runs on the commercial *Warp Factories* product. Engineers ask a Slack bot called `@Wilson`, which files a Linear issue, implements it, records a computer-use video and opens a PR.

Both factories follow the same shape:

- Agents run triage, spec, implement and review.
- Labels or mentions are the triggers.
- GitHub (or Linear) holds the state.
- Specs are committed files: `product.md` plus `tech.md`.
- The review agent is advisory.
- **A human always merges.** In a sample of 60 merged PRs from the agent bot, all 60 were merged by a person.

The mechanisms that matter most for Fabrik:

- Pinned upstream skills, specialised by repo-local `*-local` companion skills.
- Narrow self-improvement loops that may only edit those companion skills.
- Untrusted issue text is kept out of the prompt.
- Agent reviews come as a structured `review.json` verdict.
- A deliberately strict bar for letting triage go straight to implementation.

## 1. How work enters

**Public repo: GitHub issues.**

- New issues are triaged by an agent ([`core/routing.py`](https://github.com/warpdotdev/oz-for-oss/blob/main/core/routing.py)).
- Triage applies *informational* labels: `area:*`, `repro:*`, `os:*`, `agent:bug|feature|security|priority-high`, `needs-info` and `triaged` (`warp/.github/issue-triage/config.json`).
- **Readiness labels are applied only by humans.** "Only the Warp team applies the `ready-to-spec` and `ready-to-implement` labels" ([oz-for-oss CONTRIBUTING](https://github.com/warpdotdev/oz-for-oss/blob/main/CONTRIBUTING.md); `warp/CONTRIBUTING.md` L23, L30–35).
- There is a separate label for designer input: `needs-mocks`.
- The public board at [build.warp.dev](https://build.warp.dev) shows the stages: Triaging, Needs info, Needs mocks, Awaiting maintainer, Ready to spec, Creating spec, Ready to implement, Implementing, Reviewing.
- On 2026-11-02 the board showed **1,897 issues "Awaiting maintainer"** and **1,256 "Ready to implement"**, against 44 "Implementing". Human decisions are the queue.

**Internal work: Slack first.**

- Engineers tag `@Wilson` in a public Slack channel.
- The factory triages the request, files a Linear issue, implements it, attaches a QA video and opens a PR ([How I AI interview with Zach Lloyd, 2026-09-18](https://www.chatprd.ai/how-i-ai/inside-warps-software-factory)).
- Lloyd says Warp deliberately "moved most direct prompting into Slack… continued in Linear and GitHub" and did *not* build a separate portal ([Rolling out software factories, 2026-10-15](https://www.warp.dev/blog/rolling-out-software-factories)).
- Internal specs are named after Linear tickets: 117 of the 293 `warp/specs/` directories are `APP-*`, against 25 `GH*`.

**Product docs.** Work can arrive from Slack, Teams, GitHub, GitLab, Azure DevOps, Linear, Jira, webhooks, schedules, or a local agent through the Factory MCP. The foreman replies "through the tool where the request started" ([How factories work](https://docs.warp.dev/factories/how-factories-work/)).

## 2. How agents are triggered and where they run

**Oz for OSS (public repo).** The control plane is a set of Python functions on Vercel ([architecture.md](https://github.com/warpdotdev/oz-for-oss/blob/main/docs/architecture.md)):

1. A GitHub webhook arrives and its signature is checked.
2. `routing.py` maps the event to a workflow.
3. A prompt is built and an Oz cloud run is dispatched.
4. A `RunState` record is saved in Vercel KV.
5. A progress comment is posted on the issue or PR.
6. The webhook returns 202.
7. A cron job **every minute** polls the run, loads its artifacts and applies the result to GitHub.

GitHub Actions does only CI. The older reusable-Actions wrappers were deleted. Two workflows in `warp` (`update-triage-local.yml` and `update-pr-review-local.yml`) still point at the removed `oz-for-oss` Actions workflows, which is drift Warp hasn't cleaned up.

Triggers ([`routing.py`](https://github.com/warpdotdev/oz-for-oss/blob/main/core/routing.py) docstring):

| Event | Workflow |
|---|---|
| `issues.opened` | triage. An issue already labelled `auto-implement` goes straight to implementation (trusted, at creation time only). |
| `ready-to-spec` / `ready-to-implement` added **and** `oz-agent` assigned | spec / implementation run |
| Same label added, `oz-agent` **not** assigned | "announce-ready-issue" comment inviting community contributors (no agent) |
| `@oz-agent` on an issue | re-triage, or spec/implement if the issue is already ready |
| Reporter replies on a `needs-info` issue | re-triage |
| PR opened, ready for review, review requested from `oz-agent`, or `oz-review` label | review |
| `/warp-agent-review` comment | re-review (limited to 3 per PR by policy, `MAX_DAILY_REVIEW_INVOCATIONS = 5`) |
| `@oz-agent` on a PR | respond to the comment, using the implementation skills |
| `/oz-verify` | verification run |
| `plan-approved` label on a spec PR | removes `ready-to-spec`, adds `ready-to-implement`, and starts implementation if `oz-agent` is assigned |
| PR closed | cancel in-flight review runs |

Things the router deliberately leaves alone:

- Events authored by bots.
- Edited comments, "so an edit to a triggering comment does not start a concurrent workflow for stale content."

Labelling and assigning are treated as trust-safe because only collaborators can do them.

**Where runs execute.**

- Runs execute in Oz cloud environments selected by ID.
- Triage and review can use a separate, lighter environment: `WARP_REVIEW_TRIAGE_ENVIRONMENT_ID` versus `WARP_ENVIRONMENT_ID` ([`oz/oz_client.py`](https://github.com/warpdotdev/oz-for-oss/blob/main/oz/oz_client.py)).
- Factories runners are Docker images with an instance shape and setup commands. Linux and macOS are supported, and agents can use computer use to reproduce and verify ([factory-as-code](https://docs.warp.dev/factories/factory-as-code/)).
- Secrets are injected as environment variables, and each agent gets only the secrets it is explicitly given. The docs make no isolation guarantees ([secrets](https://docs.warp.dev/factories/secrets/)).

**The DIY path Warp itself recommends** runs the factory on **GitHub Actions runners**, using a demo repo and skill ([Cloud Software Factory Build Guide, 2026-07-23](https://www.warp.dev/blog/software-factory-build-guide)).

## 3. How specs and tickets are shaped

**Two committed files per issue**, under `specs/GH<issue>/` ([`warp/CONTRIBUTING.md`](https://github.com/warpdotdev/warp/blob/master/CONTRIBUTING.md) L90–109; example `warp/specs/GH1063/`):

- **`product.md`** describes behaviour from the user's side. Its core is a **numbered list of testable behaviour invariants**: the happy path, user-visible states, edge cases, cancellation, offline, permissions, races and accessibility.
- **`tech.md`** has three required sections:
  - **Context**: the current system, with file and line references.
  - **Proposed changes**.
  - **Testing and validation**: how each invariant will be verified.

**When a spec is needed.**

- Specs are for features. Bugs that are reproducible or actionable skip them.
- The shared `spec-driven-implementation` skill asks for a spec when there is ambiguity, roughly 1k+ lines of code, cross-cutting change, or risky behaviour change. It is "often unnecessary" for small fixes ([common-skills](https://github.com/warpdotdev/common-skills/blob/main/.agents/skills/spec-driven-implementation/SKILL.md)).

**Approval and implementation.**

- A spec PR is approved by applying `plan-approved`.
- Implementation usually continues on the same PR, or on a branch off the spec PR's head.
- Lloyd calls spec approval "the highest-leverage checkpoint in the loop" ([Build Guide](https://www.warp.dev/blog/software-factory-build-guide)).
- In Factories, implementation waits for a person to approve the spec by default ([How factories work](https://docs.warp.dev/factories/how-factories-work/)).

**What the implementer must hand back** ([`implement-issue`](https://github.com/warpdotdev/oz-for-oss/blob/main/.agents/skills/implement-issue/SKILL.md)):

- `implementation_summary.md`.
- `pr-metadata.json`, containing:
  - a branch name with the prefix `oz-agent/implement-issue-<N>-…`;
  - a conventional-commit title;
  - a body whose first line is `Closes #N`.

The control plane, not the agent, turns these files into the PR.

## 4. How review happens and who merges

**The agent review is structured, and advisory.**

- The shared `review-pr` skill reads `pr_diff.txt` (with line annotations), `pr_description.txt` and the optional `spec_context.md`.
- It writes `review.json` with three fields:
  - `verdict`: `APPROVE` or `REJECT`;
  - `body`;
  - inline `comments`, each starting with `🚨 [CRITICAL]`, `⚠️ [IMPORTANT]`, `💡 [SUGGESTION]` or `🧹 [NIT]`. A nit is allowed only with a suggestion block.
- It never posts to GitHub itself. A script validates the JSON and the control plane publishes it ([review-pr](https://github.com/warpdotdev/common-skills/blob/main/.agents/skills/review-pr/SKILL.md); [`review_pr.py`](https://github.com/warpdotdev/oz-for-oss/blob/main/core/workflows/review_pr.py)).
- The reviewer gets **read-only PR permissions** "because of prompt-injection risk" ([Self-improving code review, 2026-07-15](https://www.warp.dev/blog/how-to-build-a-cloud-software-factory-self-improving-code-review)).
- In Factories, the review verdict "is advisory." Revisions go back to the implement agent, and the foreman "continues existing conversations when work returns for revisions" ([How factories work](https://docs.warp.dev/factories/how-factories-work/)).

**Then a human reviews.**

- On external PRs, once the agent approves, the control plane requests **one** human expert. It picks the expert deterministically from `.github/STAKEHOLDERS`, a CODEOWNERS-style map.
- PRs from members get a comment-only review ([`review_pr.py`](https://github.com/warpdotdev/oz-for-oss/blob/main/core/workflows/review_pr.py)).
- An `OWNERS` approval check gates the merge (`warp/.github/workflows/check_approvals.yml`).

**Humans merge.**

- The docs say: "The factory never merges on your behalf. Repository permissions and branch protection control approval and merge" ([Factories overview](https://docs.warp.dev/factories)).
- They also say: "Handoff alone doesn't complete it". A work item closes on the merge notification.
- In practice, among the last 60 merged PRs authored by `app/warp-agent-staging`, every merge was by a person (`gh pr list -R warpdotdev/warp --author app/warp-agent-staging --state merged`).
- That bot wrote **414 of the 685 commits** on `master` since 2026-08-01 (`git log`). Its PRs carry `factory:<name>` labels, mostly `factory:wilson` and `factory:eng-factory-slim`, with a few `factory:claude-code-slim`.
- Lloyd describes auto-merge as a *goal* to raise ("instead of merging 20% of pull requests automatically, can we get to 30%…60%?"), not current practice ([Latent Space](https://www.latent.space/p/software-factories)).

**Verification evidence.**

- PRs carry before-and-after evidence: computer-use videos, screenshots and test commands (see the PR template, and the body of PR #16698).
- Lloyd: "PRs are reviewed and verified before a human is tagged for approval" ([Build Guide](https://www.warp.dev/blog/software-factory-build-guide)).

## 5. How humans are pulled in for decisions

**Factories pauses for a person by default at three points** ([How factories work](https://docs.warp.dev/factories/how-factories-work/)):

- **Spec approval.**
- **Questions**, when requirements are unclear or a review finding is ambiguous. "The foreman asks rather than guessing," and the question lands in the person's inbox and in the thread where the work started.
- **Merge.**

**In the public repo the human levers are labels and mentions:**

- Applying readiness labels.
- Assigning `oz-agent`.
- `plan-approved`.
- `@oz-agent` and `/warp-agent-review`.
- `needs-info` goes back to the reporter, and their reply automatically re-runs triage.

**Internally**, Warp tracks "human interactions per PR" (re-prompts, Linear comments, review fixes) and tries to drive it down. **Time to first human review (about 3.5 h) is the bottleneck**, against about 35 minutes from Slack request to PR ([How I AI](https://www.chatprd.ai/how-i-ai/inside-warps-software-factory)).

## 6. Which models do what

**Oz for OSS uses one model for every role**, set by the optional `WARP_AGENT_MODEL` environment variable ([`oz_client.py`](https://github.com/warpdotdev/oz-for-oss/blob/main/oz/oz_client.py)). The open-source workflows are "powered by GPT models", with OpenAI as founding sponsor ([Warp is now open-source, 2026-04-28](https://www.warp.dev/blog/warp-is-now-open-source)).

**Internally, models are picked by benchmark** ([WarpBench case study, 2026-09-02](https://www.warp.dev/blog/warpbench-case-study-reduce-cost-per-pr)):

- Warp replays its own past runs in sandboxes and scores them with an LLM judge.
- Implementation moved from "auto (genius)" (mostly Opus 5) to Grok 4.6 (high) on simple UI tasks.
- The default then moved to GPT 5.6 sol.
- Cost fell from about $80 to about $30 per PR. Task compliance went from 69% to 83%, and merge rate held flat.
- Caveats: several figures in the post are unfilled placeholders, and Warp's own posts give different percentages for the same drop (63%, 70%, 75%).

**Factories guidance on choosing models** ([agent configuration](https://docs.warp.dev/factories/factory-agents/configuration/)):

- Pick a model for each role.
- The review agent should use **"a different model or harness from the implement agent, so the two don't share blind spots."**
- Harnesses can be the Warp Agent, Claude Code or Codex.
- **The Claude Code harness authenticates with an Anthropic or Bedrock API key.** No subscription login is documented.

## 7. How skills are distributed and pinned

**Shared skills live upstream.**

- All of them sit in `warpdotdev/common-skills`.
- `warp/skills-lock.json` pins 28 of them by `computedHash`. The lock is managed by `npx skills`.
- `./script/bootstrap` installs them into `.agents/skills/`. `.claude/skills` is a symlink to `.agents/skills`, so Claude Code sees the same skills (`warp/AGENTS.md`, "Platform Setup").

**Upstream changes reach consumers as PRs.**

- A merge to `common-skills/main` triggers `update-downstream-skill-locks.yml`.
- That workflow opens a lockfile-bump PR in each consuming repo (`warp`, `warp-server`) ([workflow](https://github.com/warpdotdev/common-skills/blob/main/.github/workflows/update-downstream-skill-locks.yml)).

**Repo-local companion skills specialise without forking.**

- Examples: `review-pr-local`, `triage-issue-local`, `dedupe-issue-local`.
- They may specialise "only the categories declared overridable by the core skill". They "may never change the output JSON schema, the severity labels, the safety rules…" ([review-pr](https://github.com/warpdotdev/common-skills/blob/main/.agents/skills/review-pr/SKILL.md)).
- Prompt builders look for them and treat an absent one as a no-op ([platform.md](https://github.com/warpdotdev/oz-for-oss/blob/main/docs/platform.md)).

**Skills are fetched by fully qualified spec.** Each cloud run fetches its skill as `<owner>/<repo>:<path>`:

- Oz-specific skills come from the workflow repo.
- Base skills come from `common-skills`.

Both repos can be overridden by an environment variable, so a fork can point at its own copies ([`core/dispatch.py`](https://github.com/warpdotdev/oz-for-oss/blob/main/core/dispatch.py)).

**Self-improvement loops have a narrow write surface.**

- `update-pr-review`, `update-triage` and `update-dedupe` run on a schedule (weekly in `warp`).
- They read a week of human feedback, such as maintainer re-labels and replies to bot review comments.
- They may write **only** to the matching `*-local` companion skill, plus the label taxonomy in the triage loop's case. A `git diff` check against allowed path prefixes aborts any run that strays ([update-pr-review](https://github.com/warpdotdev/oz-for-oss/blob/main/.agents/skills/update-pr-review/SKILL.md)).
- Factories productises this: observer runs start after 25 unreviewed scorer failures, or once the oldest failure is 7 days old. They open PRs against the factory definition, and "Nothing is adopted without your review" ([self-improvement](https://docs.warp.dev/factories/measure-and-improve/self-improvement/)).

**Factories is configured as code.**

- The definition is `factory.yaml` plus `agents/<name>/agent.md` files. Frontmatter sets the model or harness, runner, secrets and `spawnableBy`; the body holds the instructions.
- Other parts: `skills/`, `automations/`, `runners/`.
- A GitHub-backed factory changes through PRs, checked by a `warp/factory-config` validation check ([factory-as-code](https://docs.warp.dev/factories/factory-as-code/)).

## 8. Security patterns worth noting

- **Issue and PR text is never put in the prompt.** "Contributors outside the organization can edit issue bodies and post comments". The agent instead fetches that text through `fetch_github_context.py`, which labels each section with its source and `author_association`. Agents are told to treat it as data and not to use `gh api` as a side channel ([implement-issue](https://github.com/warpdotdev/oz-for-oss/blob/main/.agents/skills/implement-issue/SKILL.md)).
- **The reviewer is read-only**, and the control plane, not the agent, writes to GitHub.
- **Bot-authored events are dropped**, unless the bot is on an allowlist (`.github/oz/config.yml`).

## 9. What Warp says has and hasn't worked

All of this is Lloyd's self-report.

**Worked:**

- **Starting with chores** such as Sentry crash fixes, triage and changelogs.
- **Meeting engineers in Slack, Linear and GitHub** rather than a new portal.
- **Treating the factory as infrastructure** engineers can debug themselves.
- **Rewarding shipped work, not token spend.**
- **Measuring in stages**: adoption first, then throughput, cycle time and cost per PR. Warp reports cost per PR down from $80 to $20 over six weeks, a lower revert rate and 40% more PRs ([Rolling out](https://www.warp.dev/blog/rolling-out-software-factories)).
- **Scorers that catch patterns**, such as a "surplus tests" scorer for agents writing redundant tests ([How I AI](https://www.chatprd.ai/how-i-ai/inside-warps-software-factory)).
- **Model routing from replaying Warp's own runs** rather than public benchmarks.
- **The review self-improvement loop** "isn't perfect" but improves over time ([Self-improving code review](https://www.warp.dev/blog/how-to-build-a-cloud-software-factory-self-improving-code-review)).

**Didn't work, or to avoid** ([Rolling out](https://www.warp.dev/blog/rolling-out-software-factories)):

- **Full backlog loops too early.** "It's too likely the agents will generate PRs that never get reviewed", which leads to engineers calling it "a slop cannon".
- **Unreliable intake flows**, which send engineers back to local tools.
- **Broad rollout before a champion team has tuned the factory.**
- **Outputs without clear owners.**
- **Token-based incentives.**

**Ongoing:**

- **Human review is the bottleneck**: about 3.5 h to first review.
- **Benchmarks are expensive**, so they run rarely.
- **Results from replaying past tasks still need A/B confirmation.**

## 10. Patterns Fabrik should borrow

1. **Upstream skills, a lock file, and `*-local` companions.** Upstream skills are pinned by hash. Product-repo specialisation lives in a companion skill that the core skill names, may only override declared categories, and never changes the output contract. This is exactly the mechanism for "Matt's skills consumed upstream, extended through repo-local skills, never forked."
2. **A review verdict file the glue publishes.** The Reviewer writes a schema-validated file with read-only permissions, and the Kit's glue posts it. Fabrik can add a field for its own classification, `execution flaw` or `design flaw`, so routing to retry or `needs-design` is deterministic glue rather than prose parsing.
3. **Untrusted text out of the prompt.** Even with one Operator, issue and PR text is untrusted once anyone else can comment.
4. **A strict bar before triage hands straight to an Implementer.** Warp's `evaluate-auto-implement-eligibility` has eight gates, all of which must pass, and "if you are uncertain about any gate, the answer is `false`":
   - bug only;
   - an objective defect, not taste;
   - root cause known;
   - one clear definition of done;
   - localised;
   - not touching server, auth or billing;
   - not security- or data-sensitive, so a wrong fix is recoverable;
   - small effort (a few files, a few hours).

   Its stated default: "A missed candidate is a minor inefficiency. A false positive queues factory work that should not run."

   Copy it as Fabrik's rule for when triage may apply `ready-for-agent`.
5. **Labels and assignment as triggers, with the control plane routing.** Ignore bot events and edited comments. Cancel runs when a PR closes. Re-run triage when the reporter answers `needs-info`. Cap re-reviews per PR and per day.
6. **Spec shape.** Use `product.md` (numbered, testable invariants) and `tech.md` (Context with line refs, Proposed changes, Testing mapped to invariants), only for work that needs it. These are good targets for what a Design session produces.
7. **Verification evidence in the PR**: test commands run, and before-and-after evidence, so the Operator's merge is confirmation, not investigation.
8. **Narrow self-improvement loops**, scheduled, that may only edit repo-local companion skills, are enforced by a path-prefix diff check, and land as PRs the Operator merges.
9. **Metrics for later observability work**:
   - human interactions per PR;
   - time to first Operator review;
   - share of merged PRs that came through the Loop;
   - for Fabrik, cost per PR as **subscription headroom** rather than dollars.
10. **Rollout advice.** Start the Pilot on chores and keep early output likely to be right. An unreviewed PR backlog is the known failure mode.

## 11. Conflicts and tensions with the map's standing decisions

- **Triage is AFK and may fast-track to `ready-for-agent`.** This is the clearest tension. In the public repo Warp's triage agent *never* applies readiness labels: only humans do. Its auto-implement queue requires eight conservative gates, and even then it only adds a separate `factory-auto-implement` label. Lloyd names over-eager backlog loops as the main early failure ("slop cannon").

  The standing decision isn't wrong for one Operator, since the Merge gate still holds. But it should come with an explicit high-bar eligibility rule like Warp's, and the Operator could keep a manual `ready-for-agent` override.

- **Claude Code under Max x20.** No conflict for Fabrik itself, but it rules out adopting Warp Factories as a host: its Claude Code harness documents only API-key authentication. Warp's own tuning (cost per PR, model swaps across vendors) assumes metered, multi-vendor models. Fabrik's version of "cost" is rate-limit headroom.

- **Reviewer on a frontier model.** Warp advises the Reviewer use "a different model *or harness*" from the Implementer. Fabrik's plan (lighter Implementer model, frontier Reviewer, both Claude) meets "different model" but shares a vendor and harness. That is acceptable, but worth noting as a known blind-spot risk.

- **GitHub as system of record.** Consistent overall. Warp's *internal* factory takes Slack requests and files Linear issues, so chat is an intake that writes to a tracker, close to Fabrik's "chat writes back to GitHub". Warp's adoption lesson ("meet engineers where they work") argues for treating Slack intake as a first-class entry point later, not only as notifications.

- **Merge gate.** Fully consistent. Factories "never merges on your behalf", and all 60 sampled agent PRs were merged by a person.

- **Hosting judged on "laptop shut, least ops".** Warp's own DIY recommendation is GitHub Actions runners. It later moved Oz for OSS to a webhook, KV and cron control plane on Vercel for latency and control. For Fabrik v1, GitHub Actions looks like the least-ops starting point. This is not a conflict, but it is useful evidence for the hosting ticket.
