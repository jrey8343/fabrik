# Matt Pocock's Real Engineering Loop, and how his skills chain through it

Research for the wayfinder ticket [What is Matt Pocock's Real Engineer loop, and how do his skills chain through it?](https://github.com/jrey8343/fabrik/issues/5) (map: [Fabrik v1 spec](https://github.com/jrey8343/fabrik/issues/2)). Researched 2026-11-02.

**Sources, most trusted first**

- **Skills**: the installed `mattpocock-skills` plugin v1.3.1 (`~/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.3.1/`), checked against upstream `mattpocock/skills` `main` (latest release v1.3.2, 2026-10-29). Upstream `triage` and `ask-matt` are byte-identical to 1.3.1. The v1.3.2 changes are patch-level fixes, listed in the [v1.3.2 release notes](https://github.com/mattpocock/skills/releases/tag/v1.3.2).
- **Sandcastle**: Matt's own AFK wiring in `mattpocock/sandcastle` (local clone at `../sandcastle`, HEAD `85e8e6d`), specifically `.github/workflows/agent-*.yml`, `.sandcastle/agent-workflows/*`, `.sandcastle/run.ts` and `.factory/`.
- **Matt's own pages**: the course page [Software Factories for Real Engineers](https://www.aihero.dev/cohorts/software-factories-for-real-engineers-xdy1m), the [AI Coding Crash Course](https://www.aihero.dev/workshops/ai-coding-crash-course) page, and the AI Engineer Europe 2026 talk page [Full Walkthrough: Workflow for AI Coding](https://ai.engineer/talks/ai-coding-workflow). I read the talk page through a fetch summary, not a transcript, so I mark claims from it as lower confidence.

## 1. The name

"Real Engineer loop" is close to Matt's wording but not exact. His exact phrase is the **Real Engineering Loop**. The course page says:

> "I've already helped thousands of engineers like you apply a Real Engineering approach to AI coding, achieving excellent quality using my Real Engineering Loop. And this is a fantastic approach for new projects, exploratory work, and highly complex moving parts. But it's not necessary for more mundane stuff like stacks of tickets. That's where a Software Factory approach can really shine."
> ([course page](https://www.aihero.dev/cohorts/software-factories-for-real-engineers-xdy1m))

Matt never lists the loop's stages under that name. The closest thing to a named, staged definition is the **main flow: idea → ship** in his router skill `ask-matt` (`skills/engineering/ask-matt/SKILL.md`). It feeds into the "Skills For Real Engineers" repo (repo description: "Skills for Real Engineers. Straight from my .agents directory."). This document treats that main flow, plus its on-ramps, as the Real Engineering Loop.

Matt splits his practice into two modes, and this split matters for Fabrik:

| | Real Engineering Loop | Software Factory |
| --- | --- | --- |
| Suited to | new projects, exploratory work, complex parts | "stacks of tickets", routine backlog |
| Driven by | the human typing user-invoked skills in one session | label-triggered GitHub Actions running Sandcastle |
| Where it lives | `mattpocock/skills` | course content, plus the workflows in `mattpocock/sandcastle` |

The course page breaks a Software Factory into six parts: **The Agent** (the tactician), **The Team** (the humans, strategic thinkers), **Brakes** ("Automated checks, automated & human review"), **Knowledge** ("Codebase design, testing, constraining code"), **Accelerators** ("Schedules and triggers that initiate agents on their own, without human intervention") and **Infrastructure** ("Data sources, sandboxes and scripts that allow agents to work AFK"). His thesis is that "starting with accelerators is backwards": build brakes first. He says he uses "GitHub Actions to automatically investigate, triage, assign, delegate, track and review units of work".

**Fabrik's Loop is a Software Factory in Matt's terms.** Its front half (grilling, spec, tickets) borrows the Real Engineering Loop's HITL stages, and its back half is the factory. `GLOSSARY.md` already tells us to avoid calling Fabrik's own Loop the "Real Engineer loop", and this research supports that rule.

## 2. Stages of the main flow

Sources: `ask-matt/SKILL.md` and each skill's `SKILL.md`. In Matt's README, user-invoked skills (`disable-model-invocation: true`) are the ones "reachable only when you type them" and whose "job is to orchestrate". Model-invoked skills "hold the reusable discipline". A user-invoked skill may call model-invoked ones, never another user-invoked one.

| # | Stage | Skill(s) | HITL / AFK | Artifact, and where it lives |
| --- | --- | --- | --- | --- |
| 0 | Precondition | `/setup-matt-pocock-skills` (user) | HITL, once per repo | `docs/agents/issue-tracker.md`, `triage-labels.md`, `domain.md`, plus an "Agent skills" block in AGENTS.md/CLAUDE.md. Creates any missing triage labels (v1.3.2). |
| 1 | Sharpen the idea | `/grill-with-docs` (user), which calls `grilling` and `domain-modeling` (model) | **HITL**. The talk calls grilling "not suitable for an unattended implementation loop". | `GLOSSARY.md` and `docs/adr/NNNN-*.md`, updated inline. The conversation itself is the primary source. |
| 1a | Detour: runnable answer needed | `/handoff` (user), then `prototype` (model), then `/handoff` back | HITL | A throwaway prototype kept on a `prototype/<name>` branch out of main, linked from the implementation issue |
| 1b | Detour: facts outside the repo | `research` (model) | **AFK** (background agent) | A cited Markdown file in the repo, which feeds back into `/grill-with-docs` |
| 1c | On-ramp: huge, foggy effort | `/wayfinder` (user) | Map charting is HITL. Research tickets are AFK. Prototype and grilling tickets are HITL. Task tickets can be either. | A `wayfinder:map` issue and its child decision tickets labelled `wayfinder:<type>`. Research lands on unmerged `research/<name>` branches. Hands off to `/to-spec`. |
| 2 | Spec | `/to-spec` (user) | Mostly synthesis ("Do NOT interview the user"), with one HITL check: "Check with the user that these seams match their expectations." | A spec issue on the tracker (Problem, Solution, User Stories, Implementation Decisions, Testing Decisions, Out of Scope), labelled `ready-for-agent` with "no need for additional triage" |
| 3 | Tickets | `/to-tickets` (user) | **HITL**: "Quiz the user... Iterate until the user approves the breakdown." | Tracer-bullet tickets published as sub-issues of the spec, with native blocking edges, each labelled `ready-for-agent` ("agent-grabbable by construction") |
| 4 | Build | `/implement` per ticket, with `/clear` between tickets, or `/implement-spec` for the whole graph (both user-invoked). Each drives `tdd` (model). | **AFK-capable**. The talk's "night shift" loop picks up AFK issues. `implement-spec` runs implementer subagents across the ready frontier. | Commits on a branch. `implement-spec` lands everything on one integration branch and can open a draft PR. |
| 5 | Review | `code-review` (model): two parallel subagents, **Standards** (repo docs plus Fowler smell baseline) and **Spec** (diff vs issue) | **AFK** | A report with `## Standards` and `## Spec` sections, deliberately not merged or reranked. It does not classify findings or retry. |
| 6 | PR | `pr` (model) | AFK | A PR body: the smallest visual of the change, before/after evidence, a one-way/two-way door call and its blast radius |
| 7 | Human gate | none | **HITL**. The talk says manual QA and code review "remain human". | Merge |
| 8 | Close the loop | `/retro` (user) | HITL (it proposes, the human picks) | Environment changes: lint rules, CI jobs, `CODING_STANDARDS.md`, navigation pointers |

Other on-ramps and support skills:

- **`/triage`** (user): for "bugs and requests piling up". It "produces agent-ready issues, which `/implement` later picks up". See §4.
- **`diagnosing-bugs`** (model): for hard bugs. It builds a red feedback loop first, then fixes with a regression test.
- **`/improve-codebase-architecture`** (user): a periodic survey for "deepening opportunities". Picking one feeds a new idea into stage 1. `codebase-design` (model) supplies the vocabulary it uses.
- **`wizard`** (model): generates a bash wizard for "steps only a human can take" (credentials, dashboards, CI secrets). This is the clearest example in the kit of work that is HITL in the physical sense.
- **`to-questionnaire`**, **`wait-what`**, **`teach`**, **`grill-me`**, **`writing-for-agents`**: standalone skills, off the main flow.

Context hygiene, from `ask-matt`: keep stages 1 to 3 "in one unbroken context window (don't compact or clear until after `/to-tickets`)", and start each `/implement` fresh from its ticket. The limit is the "smart zone" (~150k tokens). `PHASE-BOUNDARIES.md` gives the order for choosing what to do at a phase boundary: Continue, then `/clear`, then `/handoff`, then subagent (the AFK case, e.g. "Automated review is the standard case"), then `/compact`.

From the talk page (lower confidence): Sonnet implements and Opus reviews, in a fresh context. Coding standards are "pull" for implementers and "push" for reviewers. `retro` says the same thing: "the review agent should be responsible for imposing coding standards, not the implementation agent", because the implementer carries the most context pressure. Sandcastle's current code uses `claude-opus-4-8` for every role (`.sandcastle/run.ts`, `.sandcastle/agent-workflows/shared/common.ts`).

### Where the human sits

The human sits in four places:

- **Alignment.** Grilling, prototype reactions, the seam check in `to-spec`, and approving the breakdown in `to-tickets`.
- **Gates.** QA, code review and merge.
- **The environment.** `retro`, coding standards, codebase design.
- **Steps only a human can do.** The `wizard` skill covers these.

In `grilling`, facts are the agent's job and decisions are the human's: "don't ask the user for anything you could look up yourself". In `wayfinder` and `GLOSSARY.md`, a HITL ticket "only resolves through that live exchange; the agent never stands in for the human's side of it".

## 3. Label flow

### Matt's skills: five canonical roles

From `triage/SKILL.md` and `docs/agents/triage-labels.md`:

- Category roles: `bug` and `enhancement`. Every triaged issue carries exactly one category and one state.
- State roles: `needs-triage`, `needs-info`, `ready-for-agent` ("fully specified, ready for an AFK agent"), `ready-for-human` ("needs human implementation"), `wontfix`.
- Transitions: unlabelled → `needs-triage` → `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`. `needs-info` returns to `needs-triage` when the reporter replies. "The maintainer can override at any time."
- `ready-for-agent` gets an **agent brief** comment (`AGENT-BRIEF.md`), which becomes "the authoritative specification that an AFK agent will work from... the agent brief is the contract". The brief is durable and behavioural: no file paths or line numbers, complete acceptance criteria, an explicit out-of-scope list.
- `ready-for-human` uses the same brief structure "but note why it can't be delegated (judgment calls, external access, design decisions, manual testing)".
- `wontfix` has three cases. Already implemented: point to the existing code, and do not write to `.out-of-scope/`. Rejected bug: polite close. Rejected enhancement: write `.out-of-scope/<concept>.md` and close.
- For an external PR, "a PR is an issue with attached code". `ready-for-human` on a PR means "ready for a human to merge".
- Specs and tickets skip triage. `to-spec` and `to-tickets` apply `ready-for-agent` directly. `ask-matt` says triage is "only for issues you didn't create... Tickets that `/to-tickets` produced are already agent-ready, so don't triage them."
- Wayfinder issues carry only `wayfinder:` labels, "never a triage label like `ready-for-agent`".

### Matt's factory: `agent:*` labels in Sandcastle

From `.github/workflows/agent-*.yml` and `.sandcastle/agent-workflows/explore/*`:

```
issue + agent:explore ──(batch AFK triage, read-only agent)──┐
   easy-call      → agent:implement   (applied with AGENT_PAT so it triggers the next workflow)
   needs-a-human  → ready-for-human
   blocked        → agent:blocked
   duplicate      → closed onto the oldest survivor
issue + agent:implement → agent:in-progress → Sandbox run → push branch → draft PR "Closes #N" → PR + agent:review
   (fails)        → agent:blocked + comment with reason and run URL; "Re-add `agent:implement` to retry"
   (refused)      → the issue has sub-issues (PRD-shaped) or is a sub-issue, or a collaborator PR already targets it
PR + agent:review → agent:in-progress → reviewer agent improves the branch, answers review threads → human merges
PR + agent:update-branch → agent resolves merge conflicts
```

Each run uses Claude Code authenticated with `CLAUDE_CODE_OAUTH_TOKEN`, a subscription OAuth token, on GitHub Actions runners. In the explore job the agent gets read-only permissions (`contents: read`, `issues: read`), returns a JSON plan, and a separate job validates the plan and applies it. Issue text is treated as untrusted and never reaches the shell.

Sandcastle runs two label vocabularies side by side. The skills' canonical roles are mapped in `docs/agents/triage.md`. The factory's `agent:*` labels drive the Actions.

## 4. How triage decides "an agent can just implement this" vs "needs design"

This is the question behind Fabrik's `ready-for-agent` / `needs-design` routing. Matt has two answers.

**The `triage` skill is HITL.** It is user-invoked, and step 2 is "Recommend... Wait for direction." Its decision inputs are:

1. **Gather context**: two codebase checks.
   - *Redundancy*: is the behaviour already implemented? Search by domain concept, not by the issue's wording. If it is, close as `wontfix`.
   - *Prior rejection*: does it match a file in `.out-of-scope/*.md`?
2. **Verify the claim before grilling.** Reproduce the bug, or run the PR's diff. "Insufficient detail" is "a strong `needs-info` signal". "A confirmed verification makes a much stronger agent brief."
3. **Grill if needed.** If the request "needs fleshing out", the skill runs `grilling` and `domain-modeling` *inside triage*, live with the maintainer, until a `ready-for-agent` brief can be written. Design work therefore happens inside triage, and the result is still `ready-for-agent`.
4. **The bar for `ready-for-agent`** is "fully specified": a brief with current/desired behaviour, key interfaces, testable acceptance criteria and scope boundaries. If such a brief can't be written without a human decision, the issue goes to `ready-for-human`, whose stated reasons include "design decisions".

**The AFK triage in Sandcastle** (`.sandcastle/agent-workflows/explore/prompt.md`) is Matt's own unattended version. It is a prompt, not the skill. Its verdicts are:

- `easy-call`: "the right change is clear and an agent could implement it with no human judgement call."
- `needs-a-human`: "a design, product, or priority decision comes first, or the issue's claims fail."
- `blocked`: "waiting on something outside this repo, or on missing information from the reporter."
- "**A one-way door takes `needs-a-human` or `blocked`.**" Each survivor's comment must "Call one door, committed: one-way (hard to walk back: public API, defaults users build on, removals, persisted formats) or two-way (cheap to revert)."
- Findings count only when **verified** ("traces to code a subagent read or a command it ran"). Anything else becomes an **open question**. The comment covers difficulty, relevant files, which claims hold, open questions, a possible approach and the blast radius.
- It groups and closes duplicates aggressively, pointing each one at the oldest issue, which survives.

Put together, an issue can go straight to an Implementer only when:

- its claim is verified against the code,
- the right change is clear with no open design, product or priority question,
- it is a two-way door, and
- a durable brief with testable acceptance criteria can be written.

Any open question, failed claim or one-way door routes it to a human. Matt calls that destination `ready-for-human`. Fabrik calls it `needs-design`.

## 5. Conflicts with the map's standing decisions

1. **"Triage is AFK ... (Matt's `triage` skill)."** Matt's `triage` skill is not AFK.
   - It is `disable-model-invocation: true`, it waits for maintainer direction at step 2, and it grills the maintainer at step 4.
   - Matt's own AFK triage is a separate prompt plus GitHub Action (Sandcastle's `agent:explore`). That prompt reuses the skill's ideas (verify, check for duplicates, write a brief) but not the skill itself.
   - Fabrik can still make triage AFK, but through a repo-local AFK triage prompt modelled on `explore`. Running `/triage` headless would not work. This fits the "extend through prompts, never fork" decision. The map's wording should change from "Matt's `triage` skill" to "an AFK triage prompt built on Matt's triage discipline".
2. **"Every new issue gets `needs-triage`."** Matt explicitly excludes generated issues from triage.
   - Spec issues from `to-spec` and tickets from `to-tickets` arrive already labelled `ready-for-agent`, and must not be triaged again.
   - Wayfinder maps and tickets must never carry triage labels. In this repo, the map and every ticket would get `needs-triage` under a literal reading of the rule.
   - Fabrik needs an exemption rule: issues authored by the Loop's own skills skip triage.
3. **"Applying `ready-for-agent` is the trigger for AFK implementation."** `to-spec` puts `ready-for-agent` on the **spec (parent) issue** itself, not just on its tickets.
   - If the label is the trigger, the Kit would start an Implementer on a whole spec.
   - Sandcastle guards against this: `agent-implement.yml` refuses issues that have sub-issues ("PRD-shaped") and issues that are sub-issues. Its planner prompt says "If the issue appears to be a PRD and it has implementation issues which link to it, the PRD cannot be worked on."
   - Matt keeps the canonical `ready-for-agent` state label separate from the trigger label `agent:implement`. Fabrik should either do the same or add a "no sub-issues / is a leaf ticket" guard to the trigger.
4. **`needs-design` and the narrow `ready-for-human`.** Matt has no `needs-design` role.
   - His `ready-for-human` explicitly covers "judgment calls, external access, design decisions, manual testing". Sandcastle maps `needs-a-human` (which includes design decisions) to `ready-for-human`.
   - The map splits that one role into two labels: `needs-design` (HITL Design session) and `ready-for-human` (only physical work, which matches `wizard`'s "steps only a human can take").
   - The split is coherent, but `docs/agents/triage-labels.md` maps roles to labels one-to-one. Fabrik's AFK triage prompt and Design session must own the sixth label. Matt's skills will keep writing `ready-for-human` for design questions unless the mapping file's prose redirects them.
   - The `needs-design` label already exists in this repo's GitHub labels, but it is not in `docs/agents/triage-labels.md`.
5. **Reviewer classifies execution flaw vs design flaw, with up to 2 retries.** Matt's `code-review` only reports two axes and deliberately does not rerank or merge findings. Sandcastle's reviewer edits the branch itself and makes no routing decision.
   - Nothing upstream classifies a failing review or routes it to a retry or to `needs-design`.
   - This is not a conflict with a decision, but it is unbuilt. Matt's two axes map well onto the two flaw kinds:
     - a **Standards** failure, or a Spec "implemented but wrong" finding, suggests an **execution flaw**;
     - a Spec "missing because the ticket was ambiguous", or "scope creep forced by the design", suggests a **design flaw**.
6. **Max x20, no metered API.** Matt's factory runs Claude Code on GitHub Actions with `CLAUDE_CODE_OAUTH_TOKEN`, so Matt himself runs the AFK factory on a subscription token in CI. This supports the decision rather than challenging it. Usage limits and terms remain a separate research question.
7. **Merge gate.** This is consistent with Matt's practice: implement opens a *draft* PR, a human merges, and the talk keeps QA and code review human.

## 6. Skills, prompts and glue Fabrik's Loop needs that don't exist upstream

Matt does not accept new-skill proposals: "if you can compose the behaviour from existing skills, it doesn't get a new skill" (`.out-of-scope/new-skills.md`). Each item below should therefore be a repo-local skill or prompt in the Kit that composes upstream skills.

| Gap | Nearest upstream prior art | Notes |
| --- | --- | --- |
| **AFK triage prompt** that routes to `ready-for-agent` / `needs-design` / `needs-info` / `ready-for-human` / `wontfix` and writes an agent brief | `triage` (HITL) and `AGENT-BRIEF.md`; Sandcastle `explore` prompt, JSON plan and validated apply job | Use the §4 criteria. Keep the agent read-only and let glue apply the labels, as Sandcastle does. |
| **Design session entry**: `needs-design` issue → HITL grilling → one or more `ready-for-agent` tickets, including a redesign after a failed review | `grill-with-docs`, then `to-spec`/`to-tickets`; `triage` step 4 | Needs to load the issue's history (failed review, Reviewer verdict) as context. Must reach the Operator wherever they are (the map's open Notifications question). |
| **AFK implementer prompt** | `implement` is user-invoked, so a model can't call it through the Skill tool. Sandcastle's implement prompt inlines red-green-refactor and points at `CONTEXT.md`, ADRs and `CODING_STANDARDS.md`. | Can call the model-invoked `tdd` and `code-review` through the Skill tool. Must not push to main, edit labels or close issues. Glue opens the PR, as in Sandcastle. |
| **Reviewer verdict and retry classifier** | `code-review` (two axes); Sandcastle review prompt | Adds the execution/design classification and the retry counter (max 2) on top of `code-review`'s report. Runs on a frontier model. |
| **Label-triggered dispatcher** (triage → implement → review → `needs-design` / Merge gate) | Sandcastle `agent-*.yml` workflows; `.sandcastle/run.ts`; `.factory/` daemon hooks (Matt's private `software-factory` daemon, referenced in `.factory/run-daemon.sh`, is not public) | This is glue, not a skill. Note GitHub's rule that a label added with `GITHUB_TOKEN` does not trigger other workflows, which is why Sandcastle uses `AGENT_PAT`. |
| **Merge-conflict / update-branch agent** | Sandcastle `agent:update-branch` | Belongs to the map's "Failure handling" fog. |
| **Operator briefs / notifications** | `loop-me` (in-progress): "Checkpoint", "Push right", "Brief" | Not a skill to install. The vocabulary is useful for the Notifications decision. |
| **Leaf-ticket guard and "Loop-authored issues skip triage" rule** | Sandcastle's sub-issue/PRD refusal; `ask-matt`'s rule against triaging generated tickets | Config and glue. |

## 7. Skill inventory (v1.3.1, every SKILL.md)

Legend: **U** = user-invoked (`disable-model-invocation: true`), **M** = model-invoked.

| Skill | Bucket | U/M | Stage it serves |
| --- | --- | --- | --- |
| ask-matt | engineering | U | Router over all flows; the source of the main flow |
| setup-matt-pocock-skills | engineering | U | Precondition (tracker, labels, domain layout) |
| grill-with-docs | engineering | U | Stage 1: HITL alignment and domain docs |
| wayfinder | engineering | U | On-ramp for huge, foggy efforts (decision map) |
| to-spec | engineering | U | Stage 2: spec issue |
| to-tickets | engineering | U | Stage 3: tracer-bullet tickets with blocking edges |
| implement | engineering | U | Stage 4: one ticket, via tdd and code-review |
| implement-spec | engineering | U | Stage 4: whole spec, parallel implementers, integration branch |
| triage | engineering | U | On-ramp: incoming issues and external PRs (HITL) |
| improve-codebase-architecture | engineering | U | Codebase health survey; generates ideas for stage 1 |
| retro | engineering | U | Stage 8: improve the agent's environment |
| tdd | engineering | M | Stage 4 discipline (red-green-refactor at agreed seams) |
| code-review | engineering | M | Stage 5: Standards and Spec review |
| pr | engineering | M | Stage 6: PR body |
| prototype | engineering | M | Detour 1a: throwaway answer to a design question |
| research | engineering | M | Detour 1b: AFK primary-source research |
| diagnosing-bugs | engineering | M | On-ramp: hard bugs |
| domain-modeling | engineering | M | Vocabulary layer: GLOSSARY.md and ADRs |
| codebase-design | engineering | M | Vocabulary layer: deep modules, seams |
| wizard | engineering | M | Steps only a human can do (credentials, dashboards) |
| grilling | productivity | M | The interview primitive behind grill-*, triage, wayfinder, improve-codebase-architecture |
| grill-me | productivity | U | Stateless grilling, with no repo |
| handoff | productivity | U | Phase boundary: portable context file |
| to-questionnaire | productivity | U | Async questions for someone else |
| wait-what | productivity | U | Re-pitch a message that didn't land |
| teach | productivity | U | Multi-session teaching |
| writing-for-agents | productivity | M | Writing skills and AGENTS.md |
| chief-of-staff | in-progress (not in plugin) | U | Long-running goal, coordinated through subagents |
| loop-me | in-progress | U | Grill out workflow specs (trigger, checkpoint, brief) |
| claude-handoff | in-progress | U | Hand off to a `claude --bg` background agent |
| setup-ts-deep-modules | in-progress | U | dependency-cruiser deep-module boundaries |
| writing-beats / writing-fragments / writing-shape | in-progress | U | Article writing |
| git-guardrails-claude-code, setup-pre-commit, migrate-to-shoehorn, scaffold-exercises | misc (frozen) | M | Not on the loop. `git-guardrails` is relevant to the Merge gate (blocks `git push`). |

The ticket names `to-prd` and `to-issues`. Those older names are now `to-spec` and `to-tickets`. Third-party write-ups still use the old names.
