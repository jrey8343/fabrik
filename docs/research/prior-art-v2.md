# Prior art: what the factory sources prescribe per V2 feature

Research for the Decision "Prior art: what the factory sources prescribe per V2 feature" (#64) on the Map "Wayfinder: Fabrik V2" (#62). Gathered 2026-11-04.

Read the section for your feature; each one quotes the sources and ends with where they disagree. The cross-cutting section is worth reading once, because one claim recurs in every source and bears on the Map's keep/cut test.

## Sources and how they were read

| Short name | Source | Version read | How |
| --- | --- | --- | --- |
| **Addy** | Addy Osmani, [addyosmani/factory](https://github.com/addyosmani/factory) | `8af1165` (main, 2026-11-04) | Cloned and read in full: `README.md`, `ARCHITECTURE.md`, `ADVICE.md`, `LIMITS.md`, `ROUTINES.md`, `template/` (skills, commands, agents, charter, run records, gates) |
| **Matt** | Matt Pocock, [mattpocock/skills](https://github.com/mattpocock/skills) `skills/in-progress/software-factory/` (`SKILL.md`, `EXAMPLE-TASKS.md`, four slot surveys) | `4ae2317` (main; the `software-factory-skill` branch is merged and identical) | Cloned and read in full. Also `skills/engineering/retro`, `skills/engineering/improve-codebase-architecture`, `skills/in-progress/chief-of-staff` at the same commit |
| **Dex** | Dex Horthy (HumanLayer), "Harness engineering is not enough: why software factories fail", WF2026 livestream, [youtube.com/watch?v=htM02KMNZnk](https://www.youtube.com/watch?v=htM02KMNZnk), talk starts at 7:33:08 | YouTube auto-captions | Captions fetched and read for the whole talk (about 7:33 to 7:51). Auto-captions mangle words (the MC's "Jack" is Dex), so quotes are close but not word-perfect |
| **Zach** | Zach Lloyd (Warp) posts: [Open infrastructure for building a software factory](https://warp.dev/blog/open-infrastructure-for-building-a-software-factory) (2026-08-18), [WarpBench case study](https://www.warp.dev/blog/warpbench-case-study-reduce-cost-per-pr) (2026-09-02), [Using LLM-as-a-judge scoring](https://www.warp.dev/blog/using-llm-as-a-judge-scoring-to-measure-your-software-factory) (2026-09-18), [Tactics for rolling out software factories](https://www.warp.dev/blog/rolling-out-software-factories) (2026-10-15) | Live pages | Fetched through a summariser; quotes are as it returned them |
| **Ben** | Ben Holmes (Warp) posts: [The road to self-improving software](https://www.warp.dev/blog/self-improving-software-proactive-agents) (2026-10-15), [7 core components for building a software factory](https://www.warp.dev/blog/7-ways-to-build-a-software-factory) (2026-10-29) | Live pages | As Zach |
| **Warp docs** | [docs.warp.dev/factories](https://docs.warp.dev/factories.md), [factory skills](https://docs.warp.dev/factories/factory-skills/), [self-improvement](https://docs.warp.dev/factories/measure-and-improve/self-improvement/); and Varoon Kodithala, [The missing feedback loop for software factories](https://www.warp.dev/blog/engineering-self-improving-software-factories) (2026-08-26) | Live pages | As Zach |
| **Kent** | Kent C. Dodds, [You Own the Outcome: Product Engineering in the Age of AI](https://kentcdodds.com/blog/you-own-the-outcome) (2026-09-24); [Introducing Kody](https://kentcdodds.com/blog/introducing-kody-your-personal-software-factory) (2026-09-08) | Live pages | As Zach |

**Not found or not read:**

- **Dex's slides.** He says "these slides are live", but I found no URL for them. The talk's skipped section ("we're skip this part", about 7:50) is therefore unseen.
- **Kent's courses and podcast** (Epic Product Engineer, the "AI-Native Product Engineering" workshop on 2026-11-18). Paywalled or audio; not read. Only the blog post above is Kent's own written statement on product engineering that I found.
- **Warp's scorer, benchmark and automation docs pages** beyond the three above, and Warp's `common-skills` repo (Zach names it as where the built-in scorers live; not opened).
- **Warp quotes are second-hand to a degree.** The pages were read through a summarising fetch; short quoted phrases are as returned, and any number here should be checked against the page before a Spec relies on it.

Fabrik already has notes on Warp ([research/warp-factory](https://github.com/jrey8343/fabrik/tree/research/warp-factory)) and Kody ([research/kody](https://github.com/jrey8343/fabrik/tree/research/kody)); this file does not repeat them.

## Cross-cutting: every source says human review attention is the binding constraint

This is the one claim all five agree on, and it is the Map's keep/cut test in their words.

- **Addy:** "The constraint on a factory is not how many agents can run, it is how many decisions can be pending your judgment at once. When the review queue is full, stop producing." (`template/docs/factory/CHARTER.md`, §7). Its default `STOP_IF` includes "More than 3 items are already awaiting human review". On a one-person portfolio: "one human's review attention is the entire quality apparatus, with no org backstop behind it" (`LIMITS.md`). `/factory-tune` ends every run with: "is the factory producing work worth the review attention it consumes? ... If the queue is full of green PRs nobody has time to read, the correct tuning is to produce less, not to review faster."
- **Matt:** "Every trigger is an accelerator. Accelerators without brakes make a slop cannon." Three brakes: automated checks, automated review, human review. "Add one automated trigger at a time, throttled at first (one bug report in ten, a clock once a day), with human review on every PR. Open the throttle as the brakes earn trust, and cap every loop of runs at a few tries before a human." (`SKILL.md`, "Start slow").
- **Dex:** the building step now "takes minutes or hours, but this human part still takes hours or days"; agentic review "makes this part faster, but it's probably still the bottleneck." "If you're drowning in PRs, you actually have too many bad PRs." His remedy is upfront alignment: "30 minutes over here in pre-planning and alignment can save you hours in review."
- **Ben:** code review before merge is still the bottleneck, and it is "an act of risk mitigation". Computer-use recordings "dramatically cut review times".
- **Kent:** "Agents produce output. You own the outcome."

They disagree on **how** to spend the attention (see feature 6): Dex reads every line; Kent reviews outcomes, not diffs.

---

## 1. Human work leftovers

What happens to the part of a job only a human can do.

**Addy** parks it with a named question, never as speculative code.

- Queue label `factory:needs-info`: "blocked on a named question" (`CONTRACT.md`). Triage: "If the charter does not cover an item, the answer is `needs-info`, not a guess. Silence in the charter means stop." (`factory-triage/SKILL.md`)
- A run that stops after claiming an issue must move it to a live state: "ambiguity or missing human decision -> `factory:needs-info`"; "load-bearing or scope decision -> `factory:ready-to-spec`". "Never leave an issue `factory:in-progress` without a run record explaining who owns it." (`factory-implement/SKILL.md`)
- The PR body has two fields for leftovers: "## Human read required — <yes + reason, or no>" and "## Not done — <anything in scope you deliberately left out, or "nothing">". "Fill every field. Empty fields are how unreviewed work gets merged."
- The alert-triage routine, when it can't fix: "open a GitHub issue with your diagnosis, the evidence, and what you would need in order to proceed. Label it factory:needs-info." (`ROUTINES.md` §5)
- The monitor gathers charter gaps "into a single issue for a human decision rather than one issue each."

**Matt** routes every leftover back to the ticket tracker, because "A run never waits for a human: it ends, and the human's later change to the ticket tracker or git host triggers a new run." (`SKILL.md`, Run)

- Explore: "Anything else ends with the ticket labelled as waiting for a human."
- Rework: "After a set number of fails, it ends with the PR labelled as waiting for a human."
- Design question 4 for every task: "Where does a human re-enter?"

**Warp** has a "Needs attention" status in the Activity view (Zach, Aug 18) and a personal "factory inbox" of runs needing you (Ben, Oct 29). Neither post says what the leftover looks like.

**Dex, Kent:** nothing specific.

**Agreement:** a leftover is a labelled ticket or a named field on the PR, never a run left waiting. Fabrik's Operator step is the same shape. **Gap:** no source has a separate "human work" artifact apart from the label or PR field; Addy's `Not done` field is the closest prior art.

## 2. Architecture-agnostic skills / multi-source skill pinning

**Addy** gives the only direct prescription for pinning: "Across several repositories, keep the common policy in one versioned template or skill and install a pinned copy into each project. Leave project-specific exceptions beside the code they govern, and periodically ask the harness to report which instructions it loaded. This is less clever than a central policy service, but it is easy to inspect and works with a normal clone." (`ADVICE.md`)

- Harness-agnostic by keeping one canonical copy and thin adapters: canonical skills in `.claude/skills/`, "Thin adapters under `.agents/skills/`" for Codex; "Whichever harness starts a run, GitHub labels remain the queue and the shared contract remains the policy." (`README.md`)

**Matt** is agnostic about products, not skill sources: "Buy the services and build the tasks: the tasks carry the user's design, the services are generic." (`SKILL.md`). His `retro` skill says where steering belongs: `AGENTS.md` "should be used incredibly sparingly, usually only for navigation pointers"; coding standards go in `CODING_STANDARDS.md`, read at review; skills for docs and user-invoked commands (`skills/engineering/retro/SKILL.md`). Nothing on loading skills from more than one repo or on pinning.

**Warp docs** (factory skills): three sources. Role and integration skills ("These skills come from roles and integrations, not files in your definition"), Warp-provided skills, and team-owned `SKILL.md` files in the factory definition. Custom skills "extend the built-in skills rather than replacing them." **No pinning to a commit, tag or branch, and no precedence rule** for same-named skills. The whole factory definition is versioned instead: "You can roll back or forward to factory versions, canary them, test them" (Zach, Aug 18). Zach names a Warp `common-skills` repo that holds the built-in scorers.

**Kent:** "Keep skills small and focused" (You Own the Outcome). Kody argues packages run "faster, cheaper, and more reliably than any SKILL.md file you could come up with."

**Dex:** nothing.

**Disagreement:** Addy pins a copy per project; Warp versions the whole definition and leaves skills unpinned within it. **Gap:** no source covers several skill sources pinned at separate versions, which is what Fabrik's `skills.lock.json` is heading toward. Fabrik would be designing that part without prior art.

## 3. Telemetry, transcripts, scorers, replay

**Addy** keeps structured run records and keeps transcripts out of them.

- "Write one immutable Markdown file per run", with front matter: `run_id, stage, started_at, finished_at, status, issue, pull_request, gate_level, gate_status, verifier, human_required`. "Do not include secrets, full transcripts, or copied issue bodies. Link to those systems instead." These support "queue age, gate failure rate, verifier rejection rate, time to review, and escaped defects" (`template/docs/factory/runs/README.md`).
- No scorers, and no token accounting: "No ROI or token dashboard. Nothing stock emits the data; building it is a project." (`LIMITS.md`). Run records are "the only durable record after the transcripts are gone" (`ARCHITECTURE.md`).
- Independent verification is a **separate agent** that reads the diff cold and proves the new test fails without the implementation (`prove-test.sh`, `factory-verifier`). That is a gate per PR, not a scorer across runs.

**Matt** makes observability optional and keeps it out of decisions.

- Observability platform: "Optional: the product filling the runner or orchestrator slot often shows enough on its own. A run never decides on it until something writes it into the ticket tracker or git host." (`SKILL.md`)
- "Type 1: None": "the agent's transcript saved as a run artifact"; "Most factories start here, and grow out of it when they need search across runs, a token or cost rollup per run, or retention longer than the runner keeps." Type 2 (LLM tracing) suits it when "a retro run or a human compares runs" (`OBSERVABILITY-PLATFORMS.md`). The "Hook plugin" path: "a Claude Code hook reads the session transcript at each Stop and ships it".
- No scorers and no replay.

**Warp (Zach, Varoon, Ben)** is the main source on scorers and replay.

- Scorer: "defined by a prompt, classification instructions, and a judge model to use"; usually one dimension each; outcome labels scored 0 to 1 with a pass threshold. Built-ins: task compliance, efficiency, verbosity, quality, plus custom (for example "did agents use the right internal MCPs and Skills"). Example custom rubric: "redundant tests", for "a common failure mode we were seeing in our internal factory" (Zach, Sep 18).
- A scorer reads the whole trace: "scores the conversation with the full turn-by-turn and tool calls as context" (Varoon). Traces should hold full input and output, including PRs and screenshots, stored "accessible via API" (Zach).
- Sampling: scoring every run is unnecessary "since scoring itself costs money"; percent-based or classifier-based ("score all my front-end tasks"); a 25% default (Varoon); Warp's own scoring is about "3% of total token costs" (Zach).
- Calibration: only "once you get a feel for checking your scorers by hand" (Zach). No method given.
- Replay (WarpBench): a foreman agent picks "a representative set of ... tasks, at different levels of scope" from past runs; each is replayed by recreating the original code **and factory configuration** with git; models compared with config held constant. Result: "from about $80 to $30 per completed PR, with no measured drop in agent quality." Cautions: "don't recommend running benchmarks often because of the cost"; benchmarks "only support retroactive measurements of quality"; A/B tests planned. Cross-harness comparison not yet supported.
- One store for transcripts: warns against "zipping up Claude or Codex sessions" to S3 (Ben, Oct 29).

**Dex** argues against trusting judge models on quality: "models judging quality can only go so far. Uh, because if the new model, if the model knew what good code looks like, it would probably write it in the first place. Uh, and review agents and throwing more tokens at the problem, it can raise the floor." Code quality is hard to verify because "the cost function of bad architecture is measured in months and years."

**Kent:** watch outcomes and cost: track whether things work at a sensible cost, not just whether they work (paraphrase).

**Disagreement:**

- Warp puts full transcripts at the centre (scorers and self-improvement read them). Addy keeps them out of the durable record. Matt keeps them optional.
- Warp trusts LLM-as-judge scorers to drive changes. Dex says a judge can't see what the model can't, so scorers raise the floor at best. Matt and Addy prefer deterministic checks over model judgment (see feature 4).

## 4. Self-improvement / retro / factory-tune

**Addy: `/factory-tune`** (`template/.claude/commands/factory-tune.md`).

- Cadence: "Run it monthly, or after any escaped defect."
- "It **proposes**. It never edits `CHARTER.md` itself. A factory that can rewrite its own constraints has none." `ARCHITECTURE.md`: "No self-improvement loop. `/factory-tune` proposes; a human decides."
- Evidence: the last 30 days of run records plus issue and PR timestamps: merged PRs and human fixes after merge, **escaped defects** ("For each, trace which gate should have caught it. This is the single most valuable input here."), verifier rejections, triage accuracy, review-queue depth, gate misconfigurations, flow. "State when records are incomplete; do not manufacture precision."
- Tighten when an escape traces to a trusted gate ("Tighten immediately; this is not a judgment call"); when the verifier catches the same class repeatedly, "Propose the deterministic check that would catch it instead, because a gate cannot be talked out of its verdict and a reviewer can."
- Loosen only on a counted run of evidence: "23 dependency bumps over 6 weeks, zero escapes, zero human fixes." "Anecdote is not evidence."
- **Never loosen:** the merge gate, load-bearing path protection, the test-modification rule, and verification as a separate agent from implementation.
- Accepted results go to `DECISIONS.md` with date and evidence, "so the next review can tell whether a past loosening was a mistake."

**Matt: Retro task** (`EXAMPLE-TASKS.md`): "Trigger: a PR merges, throttled to one merged PR in ten. Does: reads the PR, its ticket, its automated reviews and its run logs, and proposes changes to the factory's own instructions as a PR. Triggers: an automated review run."

- The `retro` skill's categories: navigation, automated checks, coding standards, global AGENTS.md, tool economy, no-ops, information access. On a violation it can't be argued with: "a **mechanical** one ... gets a deterministic check, full stop ... Default to building the check over writing the rule." Coding standards belong with the reviewer, not the implementer, because the implementer has the most "context pressure".
- `chief-of-staff` (in progress) samples differently: "run a retro on about one in five of your subagents' sessions ... Pick first the ones where something went wrong."
- **Fix task** for the factory's own failed runs: files the failing log as a ticket, attempts a fix PR when fixable; "A failure in a fix run's own work triggers nothing, so fixes never chain. Because the fix changes the factory itself, it always gets human review."

**Warp** (Varoon; Self-improvement docs; Ben, Oct 15).

- Trigger: a scheduled check "every few hours" (Varoon); the docs say a run starts once an agent has "25 distinct unreviewed failures" or its oldest is seven days old (`selfImprovement.failedRunThreshold`, 1 to 50).
- Input: scorer failures grouped by agent; it "searches through transcripts for evidence of why that failure occurred."
- Output: a PR against the factory definition (prompts, skills, config) or application code, with a "Regressions addressed" section linking the failing runs and scores. "Nothing is adopted without your review"; a random eligible reviewer is requested.
- Against bloat: agents "should not pile on addendums" and should redraft instead (Varoon).
- Ben's four steps: aggregate sessions, score them against "rubrics that you define", find common causes in low-scoring runs, propose changes to skills, code, or AGENTS.md.
- Zach (Oct 15): a human's fix of an agent mistake "serves as an important input into the learning loop of factory engineering."

**Dex:** nothing on retros.

**Agreement:** the factory **proposes** changes to its own instructions as a reviewed PR, and a human merges. Nobody self-applies.

**Disagreement:**

- **Trigger.** Addy runs on a clock (monthly) or an escaped defect. Matt samples merged PRs (one in ten), or one in five sessions with failures first. Warp waits for a pile of scorer failures (25, or 7 days). Matt and Addy can run without scorers; Warp's loop can't.
- **What counts as evidence.** Addy: escaped defects and counted streaks from run records. Matt: one PR's ticket, reviews and logs. Warp: LLM-judge scores plus transcripts.
- **Tone.** Addy says the factory has "No self-improvement loop", only a proposal a human decides on; Warp calls the same shape "automatic self-improvement". It's the same mechanism under a different name.
- Addy has a **never-loosen** list; nobody else does.

## 5. Scheduled architecture audit

**Matt: Architecture task** (`EXAMPLE-TASKS.md`): "Trigger: a nightly clock. Does: scans recent changes for refactoring candidates and files them as one ticket. Triggers: nothing. A human picks a candidate and labels it, which starts the usual chain."

- `improve-codebase-architecture` sets the method: "Scope before you scan: YAGNI ... put extra weight on the parts of the codebase that have recently changed"; walk `git log` for hot spots; a fresh sub-agent explores; candidates are "deepening opportunities" judged by the deletion test; ADRs are not re-litigated.
- The Ratchet task is the deterministic sibling: "a daily clock"; "takes one file off the exception list, fixes it until the stricter check passes, and opens a PR"; "One small PR a day keeps human review cheap, and the check only ever gets stricter."

**Addy** does it as gates plus one monitor check.

- An `architecture` gate in the `deep` tier: "plain grep assertions are enough to start and are impossible for an agent to argue with" (`gates.sh`); `REQUIRED_DEEP="types lint test audit architecture"`.
- Verification budget: "reserve deep security, mutation, architecture, or broad end-to-end checks for risk that warrants them, or run them on a separate cadence" (`ADVICE.md`).
- The monitor's **comprehension drift** check: "Files changed by the factory more than 5 times in the last 30 days with no corresponding update to their documentation or to `docs/factory/DECISIONS.md`. These are the places where the code has moved and the written understanding has not, which is where the next surprise comes from."
- `factory-critic` agent for load-bearing changes: "What did this change assume that nobody stated?"

**Zach** (Aug 18) mentions a "periodic dead-code removal agent" as a scheduled example.

**Dex** gives the reason the feature matters. Models "can't maintain and improve codebase quality over time, not without a decent amount of human steering"; "agents really start to struggle after maybe three to six months"; HumanLayer "went full lights off" in July 2025 and regretted it. RL rewards only "did the test pass", so "There's no way in this system that we can penalize it for poor program design". His conclusion is "for now we're stuck reading the code."

**Agreement:** the audit **files**, it doesn't refactor. Matt files one ticket and triggers nothing; Addy's monitor files and never fixes. **Disagreement:** Matt uses a model to scan for candidates nightly; Addy prefers grep rules that can't be argued with, plus a churn-versus-docs heuristic. Dex would say both only raise the floor, and the human still has to read.

## 6. Product engineering / product gate

**Addy: `factory-spec` Gate 1 – Product** (`template/.claude/skills/factory-spec/SKILL.md`). Interactive only: "Do not run it inside an unattended routine; a routine that approves its own spec has no gates at all."

- "No technical content whatsoever. If you find yourself naming a file or a function, you are in the wrong gate."
- Contents: "The user problem, stated as a person's problem"; "What success looks like, measurably"; "A short announcement written as if the change already shipped"; "Plain HTML mockups for any screen involved, in `mockups/`"; "**What we are deliberately not doing**". "That last item ... is also where the kill decision lives: if the honest answer to "should this exist" is no, this gate is where that is cheap to say."
- Then Gate 2 Architecture, Gate 3 Program design ("The three decisions you are least confident about"), Gate 4 Slices ("Slice 0 is a tracer bullet"). "Never proceed on an inferred approval: "looks good" on gate 1 is not approval of gate 2."
- "If triage cannot infer product intent, the issue goes to `factory:ready-to-spec`" (`README.md`).

**Dex** gives the same four steps: "product review. Understanding what problem we're solving, what's the desired behavior, maybe looking at mockups", then "system architecture", then "program design" ("the types and the method signatures the program layout and the call stacks"), then "vertical slices". "Small stuff still just goes straight to the agent." Addy's four gates match Dex's sequence step for step, though neither source cites the other on it (Dex quotes an Addy post on another topic).

**Kent** (You Own the Outcome) treats product as the human's job: "Agents produce output. You own the outcome."

- Shared understanding first, or "the agent will happily solve a slightly different problem than the one you have".
- "Treat workarounds as product signal."
- Ask agents for options with effort, trade-offs, reversibility and a recommendation; classify one-way doors (public names, data shapes, pricing) and slow down for them.
- "Get comfortable being accountable for whether something *worked*, not just whether it *shipped*."
- No named checklist or gate. The post works through one example (a webhook synthetic-dispatch feature).

**Ben** (Oct 15): "a human will always be in the loop for product work"; agents mine analytics, SEO and customer interviews to suggest roadmap items, but "We still require humans to review and accept these ideas."

**Matt:** the software-factory skill has no product gate. Product judgment sits upstream in his other skills (`to-spec`, `grill-with-docs`), not in the factory.

**Disagreement:** Kent says he did not read the diff line by line (paraphrase): he checks whether the result met the decided behavior and the trusted gates passed. Dex: "we're stuck reading the code", made feasible by upfront alignment. Both put the human's effort before the code (product decisions); they differ on whether the human also reads the diff afterwards.

## 7. Visual prototypes and PR evidence

**Prototypes before code.** Addy's Gate 1 requires "Plain HTML mockups for any screen involved, in `mockups/`", with no technical content allowed. Dex's product review includes "looking at mockups" ("Here's a product review I was working on yesterday with a mockup of a new feature"). Nobody else covers it.

**Evidence on the PR.**

- **Addy:** a structured PR body: What / Queue item with `done_when` "copied verbatim" / "Why this is safe — <the thing a reviewer would otherwise have to work out for themselves>" / Gates ("You must quote the `FACTORY_GATES:` line verbatim") / Verification verdict / Human read required / Not done. The verifier proves the new test fails without the implementation (`prove-test.sh`). It's draft if load-bearing, tests modified, a gate skipped, or the verifier had reservations. No screenshots or recordings.
- **Warp:** computer use. Agents "click through the apps they build and produce before-and-after screenshots and recordings"; auto-trim cuts long runs to short clips, which "dramatically cut review times" (Ben, Oct 29). A verification video "is saved to PR descriptions for human review" (Zach, Aug 18). Mobile flows recorded on hosted simulators.
- **Warp's cost warning:** one agent used 275 computer-use actions to verify a one-line CSS fix; the self-improvement fix was to use "the DOM and computed styles to frame visual captures" instead of repeated screenshots (Varoon).
- **Kent:** review the outcome against the decided behavior.
- **Matt:** nothing on PR evidence.

**Disagreement:** Addy's evidence is textual and deterministic (verbatim gate line, proof the test fails without the change); Warp's is visual (recordings), and Warp shows visual capture needs a budget.

## 8. Idea intake and maps

**Matt** names the role **Ticket source**: "Anything outside the factory that creates tickets in the ticket tracker: a feedback button, a monitor, an error tracker, an inbox." Avoid: "data source, trigger source, intake".

- "A feedback button in the app is a ticket source: it files each report as a ticket with the explore label already on it. The explore run does the rest."
- Throttle new sources: "one bug report in ten".
- The design question for every source: "what stops it filing the same ticket twice?"
- Maps: Matt's `wayfinder` skill (the method this Map uses) plans work "too big for one agent session" as a map of decision tickets. It is a planning tool and isn't part of the software-factory skill; no source wires idea intake into a map.

**Addy:** issues are the queue; an hourly scheduled triage polls them, because Claude routines have no issue-created trigger ("This is the load-bearing error, because it is the entire first stage of the factory", `LIMITS.md`). Triage sorts into ready-to-implement, ready-to-spec, needs-info, or wait. The monitor exists because "Without it a factory only processes work a human remembered to file, which means the backlog reflects attention rather than reality."

**Warp:** "Work enters your factories from the tools your team already uses" (Slack, Teams, Linear, Jira, GitHub, GitLab), plus a Factory MCP for local tools (Zach, Aug 18). Agents check task boards to avoid duplicates (Ben, Oct 29). Ben (Oct 15) wants agents to find the work: "figuring out what should be in the backlog in the first place". His sources are analytics, SEO data and customer interviews, with human acceptance required.

**Dex** gives the warning: "take all the user feedback and just stick it straight into the factory ... now your only job is how much things can you stuff into the queue" is the narrative he says "does not work".

**Disagreement:** Ben wants agents to propose what to build; Dex warns that a pipe straight from feedback into the factory is how factories fail. Ben's own setup agrees with the part that matters here: ideas need a human to accept them before they become work.

## 9. Monitor

**Addy: `factory-monitor`**, weekly (Monday 06:00, `ROUTINES.md` §4).

- "**You file issues. You do not fix anything.** Mixing detection and repair in one run means a bad detection becomes a bad commit before anyone sees it."
- Sweep: CI failures on main (flakes tracked separately, "because flakes are what erode trust in the gates"); gate health (`gates.sh deep` on main; red is the highest-priority finding); advisories (grouped, "Do not file an issue per transitive dependency"); queue staleness (in-progress over 2 hours, awaiting-review over 7 days means throttle intake, resolved blockers, answered needs-info); comprehension drift; charter gaps.
- Dedupe: "search open issues for a duplicate; a monitor that refiles the same issue weekly gets muted, and a muted monitor is worse than none."
- Cap: no more than 10 issues a run, "**Never silently truncate.**" Never reopen or comment on issues a human closed.
- Report what was clean: "A silent monitor is ambiguous between "nothing is wrong" and "the sweep did not run"."
- Severity `blocks-factory` only for a red gate on main or a full review queue.
- A separate, optional **alert-triage** routine fires per alert via API (Sentry etc.). It may open a draft fix PR only if "the cause is clear AND the fix touches no load-bearing path AND matches an AUTOMATABLE entry"; otherwise needs-info. The payload arrives as untrusted data.

**Matt:** "A monitor (slow queries, error rates) is a ticket source. It files a ticket per problem, and comments on the open ticket instead when it sees the same problem again. After a fix merges, it reopens the ticket if the problem persists." Observability: "When a run should act on what the platform sees, make the platform a ticket source: a monitor files the ticket, and a run reads it." The Fix task covers the factory's own failed runs.

**Ben** (Oct 15): an alert from Sentry or Grafana triggers an agent via a webhook automation; "the stronger version" has the agent send a fix PR, not just a Slack report. **Zach:** "A monitoring agent that integrates with Sentry might detect this and create a Linear ticket for it."

**Dex:** routing "all incidents straight into the factory" so you "wake up to a pull request" is part of the loop narrative he warns about.

**Disagreement:**

- **Fix or file.** Addy's monitor never fixes; his alert routine fixes only charter-permitted cases. Ben calls a fix PR the stronger version. Matt files and lets the usual chain fix.
- **Dedupe.** Matt comments on the open ticket and reopens after a fix if the problem persists. Addy searches for duplicates but never reopens what a human closed. These conflict on reopening.

## 10. Operator inbox

**Addy: `/factory` control room** (`template/.claude/commands/factory.md`). "Lead with what needs a human. Nothing else is urgent."

- Report order: NEEDS YOU (each PR with "why it needs you: load-bearing / tests modified / gate skipped / verifier reservations"; each needs-info with "the actual question"), REVIEW QUEUE n / limit, RUNNING, QUEUE, HEALTH (gates on main, skips, charter gaps, last monitor), FLOW, SUGGESTED NEXT (one thing).
- If the review queue is at the limit, lead with that; if gates are red on main, lead with that instead. "Be terse. This is a dashboard." "If no run record has landed in over a week, say so. Stale evidence reads as calm."
- `next`: "the single highest-value thing for a human to do right now, and why". `stuck`: blocked, stale or twice-rejected only.
- It is pull, not push: Addy has "No steering or handoff layer ... That is a real gap, accepted knowingly."

**Matt:** the ticket tracker is "the factory's human interface: humans schedule work by filing tickets, talk to agents in their comments, and their changes to tickets trigger runs." No separate inbox; "waiting for a human" labels are the queue.

**Warp:** "Each user keeps a personal inbox for runs that need their attention" (Ben, Oct 29); "Needs attention" statuses in Activity (Zach, Aug 18); a dedicated tab for self-improvement PRs (Varoon).

**Dex, Kent:** nothing.

**Agreement:** the inbox is a **filter over existing state** (labels, PRs, run records), not a new store. **Disagreement:** Matt says the tracker already is the inbox; Addy and Warp add a ranked view on top. Addy's view is the most fully specified, and it ranks by the binding constraint (a full review queue, a red main) before individual items.

---

## Summary table

| Feature | Most concrete prior art | Main disagreement |
| --- | --- | --- |
| 1 Human work leftovers | Addy `needs-info` "named question" + PR fields `Human read required` / `Not done`; Matt "a run never waits for a human" | None of substance |
| 2 Skills sources / pinning | Addy "install a pinned copy into each project"; Warp three additive skill sources, whole-definition versioning | Pin per project (Addy) vs version the definition (Warp); **no source covers multi-source pinning** |
| 3 Telemetry, scorers, replay | Addy run-record front matter; Warp scorers (prompt + classes + judge, 25% sample, ~3% cost) and WarpBench replay ($80 to $30/PR) | Transcripts central (Warp) vs out of the record (Addy); judges (Warp) vs "if the model knew what good code looks like" (Dex) |
| 4 Self-improvement | Addy `/factory-tune` (monthly, proposes, never-loosen list); Matt Retro task (1 in 10 merged PRs, PR to factory instructions) | Trigger: clock (Addy) vs merged-PR sample (Matt) vs failure pile (Warp); prefer deterministic checks (Addy, Matt) vs scorer-driven (Warp) |
| 5 Architecture audit | Matt Architecture task (nightly, one ticket, triggers nothing); Addy grep gate + comprehension drift | Model scan (Matt) vs grep rules (Addy); Dex: the human still reads |
| 6 Product gate | Addy Gate 1 (no tech, mockups, "deliberately not doing", kill decision); Dex same four steps | Read every line (Dex) vs review outcomes, not diffs (Kent) |
| 7 Prototypes, PR evidence | Addy HTML mockups + verbatim gate line + test-fails-without proof; Warp recordings with auto-trim | Textual/deterministic (Addy) vs visual (Warp), which needs a budget |
| 8 Idea intake, maps | Matt Ticket source + "what stops it filing the same ticket twice?"; Addy hourly triage poll | Agents propose the backlog (Ben) vs feedback-to-factory is how factories fail (Dex) |
| 9 Monitor | Addy `factory-monitor` (files never fixes, dedupe, cap 10, report clean checks); Matt comment-don't-refile, reopen-if-persists | Fix PR from alert (Ben) vs file only (Addy); reopen (Matt) vs never touch human-closed (Addy) |
| 10 Operator inbox | Addy `/factory` NEEDS YOU, ranked by the binding constraint; Warp personal inbox | Tracker is the inbox (Matt) vs ranked view on top (Addy, Warp) |
