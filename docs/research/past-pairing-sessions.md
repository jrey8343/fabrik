# What did past Pairing sessions need?

Research for [#801](https://github.com/jrey8343/fabrik/issues/801), a Decision of the map [#796](https://github.com/jrey8343/fabrik/issues/796). Date: 2026-11-19.

**Question.** For each step the Operator took on a `ready-for-human` issue, a Kit-owned issue or a HITL Decision: what kind of step was it, which system did it touch, and did it need the Operator's own terminal or hands?

**Method.** Read with `gh`, signed in as the Operator, on 2026-11-19. Nothing was changed anywhere.

- Every issue labelled `ready-for-human`, open or closed, with its body, task list and comments, in `jrey8343/fabrik`, `jrey8343/fabrik-console`, `jrey8343/gradually-core` and `jrey8343/penrith-physiotherapy-sports-centre` (the Pilot).
- Every issue under a `fabrik:` label in the two Product repos, and every issue in `jrey8343/fabrik-runs`.
- The Decisions labelled `wayfinder:grilling`, `wayfinder:prototype` and `wayfinder:task` under the six closed Maps in `fabrik`.
- All 96 of the Operator's repositories were checked for a `.github/workflows/fabrik.yml` caller workflow. Only the two Product repos have one. `fabrik`, `fabrik-console`, `fabrik-runs` and five throwaway trial repos have none, and the trial repos hold no `ready-for-human` issue.

`fabrik` is public and the other repos are private. Private issues are described here in aggregate only: kinds of system and kinds of step, with counts. Issues in `fabrik` are linked.

**How a step was counted.** A step is one act on one system. A task-list line that touched two systems (a key made in a vendor's dashboard, then stored) counts once for each. An issue with no task list was counted from its closing comment, or from what it asked for when it closed with no comment. Unticked steps on open issues are counted too: they are work a session would have been asked to do. The classification is one reader's judgement, so the counts are good to within a few steps per kind, not exact.

## Answer

- **86 `ready-for-human` issues, 419 steps.** 12 in `fabrik`, 65 in `gradually-core`, 9 in the Pilot, none in `fabrik-console`. 15 are open. 82 carry steps. The other four are two umbrella issues, one throwaway trial issue and one trial plan counted apart (below).
- **62% of the steps were on GitHub** (258 of 419). 39% needed only what any session acting as the Operator on the repo has: writing to issues and pull requests, reading and re-running Actions, and ordinary files through a pull request. 22% needed power the Loop's agents are denied: Trust-root files, workflow files, secrets, settings, rulesets, an App.
- **16% were on a third-party system** (67 steps, 23 issues). AWS is the largest by far, then the practice management system (Nookal), Sentry, the Product's own deployed app, Cloudflare, the Claude account, Deepgram and Stripe.
- **8% were in the Operator's own terminal** (35 steps, 16 issues). Half of those are Setup and its wizard.
- **4% were only for the Operator's hands** (17 steps, 12 issues): a second factor, a consent screen, a legal or plan choice, a device, a person to contact.
- **1Password was 6 steps on 6 issues.** It is small in count and sits in the middle of the credential steps.
- **48 of the 82 issues never left GitHub.** 22 of those needed nothing but the tracker, Actions and ordinary pull requests. 34 issues went outside GitHub, and 24 had at least one step in the Operator's terminal or hands.
- **Five kinds are 59% of the work:** tracker writes, reading or re-running Actions, Trust-root file edits, the Operator's terminal, and ordinary files through a pull request.
- **Of the four Kit-owned kinds the question names, only the Weekly-limit issue has ever been opened:** 10, all in the Pilot. No Usage-credits, token-rotation or Dead-tick issue exists in any repo.
- **Of 105 HITL Decisions, 74 grillings needed conversation and reading only.** The 9 prototypes needed the Operator to look at something. 12 of the 22 tasks needed more: a throwaway repo, a deploy, an App, a new account, or the Operator's phone.

## The kinds, counted

`Issues` is the number of issues with at least one step of that kind.

### On GitHub

| Kind of step | Steps | Issues |
| --- | ---: | ---: |
| A secret or variable (Actions, Dependabot or an environment's) | 8 | 6 |
| A repo setting (environments, branch protection, the OIDC subject claim, a collaborator, archiving) | 9 | 6 |
| A ruleset | 5 | 5 |
| An App's installation or permissions | 2 | 2 |
| A workflow file, or a script or owners file under `.github/` | 21 | 14 |
| Another Trust-root file (Kit config, role prompts and notes, the coding standards, the agents' instructions, `docs/product/`) | 47 | 23 |
| A release cut by hand | 1 | 1 |
| **Needs power the Loop's agents are denied** | **93** | **40** |
| A tracker write: reopen, merge, close, label, a blocked-by edge, a sub-issue move, an issue filed, a pull request's body edited | 83 | 49 |
| Actions: read a failed job's log, re-run a job, dispatch a workflow, watch a deploy or a Tick's step summary | 49 | 35 |
| Ordinary files through a pull request: code, tests, runbooks, decision records, data | 33 | 28 |
| **Needs only the Operator's ordinary access** | **165** | **72** |

The last three are not in the question's list, and together they are the largest group. Three things about them:

- **About 20 of the 83 tracker writes are merges at the Merge gate,** which the Kit's ruleset keeps to a repository admin. So "ordinary" still means the Operator's own role.
- **Four Operator briefs had the same shape:** reopen a pull request the Kit closed unmerged, wait for its Review and merge it. Three more were another repeated shape: make a new Spec block the next phase, swap its number into a task list, and change one line of the Roadmap.
- **Eight issues were closed by hand** because the merge that should have closed them didn't.

### On a third-party system

| System | Steps | Issues | Reached through, as recorded |
| --- | ---: | ---: | --- |
| AWS | 25 | 11 | Its CLI or web console, from the Operator's own terminal or browser: accounts and the Organization, an account's bootstrap stack, a secret's value, a parameter, Bedrock quotas and a test call, a forced service restart, SES identities. The console alone for reading an instance's boot log, log streams and a secret's state. One more issue, counted under Actions, did all its AWS work through a dispatched workflow holding the deploy role, with no cloud credential in the session. |
| Nookal | 10 | 4 | Its web app for account settings, practitioners' schedules and seeded bookings. Its API, with a key, for reads and for making synthetic records. Its support desk, by a person, once. |
| Sentry | 9 | 5 | Its dashboard only: the organization and its data region, a legal agreement, the plan, a project and its privacy settings, a token. |
| The Product's own deployed app | 9 | 3 | A browser only. It sits behind Cloudflare Access, and signing in takes an emailed code and a second factor. |
| Cloudflare | 7 | 4 | Its dashboard: an API token, a tunnel, a Zero Trust service token whose secret is shown once. Three of the seven are an older system's teardown, not yet done. |
| The Claude account | 3 | 2 | `claude setup-token` in a terminal, which opens a browser to authorise. The account's settings page, to turn usage credits off. |
| Deepgram | 3 | 2 | Its console: a project and a key. |
| Stripe | 1 | 1 | Its API through a script in the repo, for a test-mode price. Its dashboard for the test key. |
| **Total** | **67** | **23** | |

Every one of these vendors has an API. The steps that used a dashboard were the ones that mint a credential, set up an account or an organization, accept terms, or look at a page as a person would.

### In 1Password, the Operator's terminal, and the Operator's hands

| Kind of step | Steps | Issues |
| --- | ---: | ---: |
| **1Password:** an item stored (3), service accounts and vaults made by Setup (2), a token read for a local run (1) | 6 | 6 |
| **Terminal: Setup and its wizard,** or another wizard run in the Operator's terminal | 18 | 5 |
| **Terminal: the laptop's own state:** its `gh` login, its keychain, its SSH configuration, scheduled local jobs, a reminder | 6 | 2 |
| **Terminal: the repo's tests run locally,** to check a change or reproduce a failure | 5 | 5 |
| **Terminal: a second private repo's checkout,** read for facts | 3 | 1 |
| **Terminal: a measurement run** of the Kit's own judge or Reviewer on a Subscription's token | 2 | 2 |
| **Terminal: a check run against a deployed environment** | 1 | 1 |
| **Hands: a second factor,** a passkey or an emailed code | 6 | 5 |
| **Hands: a consent or authorisation screen** (installing the App, authorising a token) | 2 | 1 |
| **Hands: an account or token made in a signed-in browser** | 2 | 1 |
| **Hands: a legal agreement or a plan choice** | 2 | 2 |
| **Hands: a device** (GitHub Mobile, the phone's notifications) | 2 | 2 |
| **Hands: a live page in a browser and an inbox** | 2 | 2 |
| **Hands: contacting a person** (a vendor's support) | 1 | 1 |
| **Judgement only:** a decision, an editorial or clinical call, a reply to a Round | 26 | 21 |
| **Waiting:** on a merge, a deploy, a scheduled run, a vendor's release | 8 | 8 |
| **Reading source to settle a fact** | 2 | 1 |

## The systems a session would need to reach

From the counts above, in order of how often each was touched:

1. **GitHub, as the Operator, on the issue's repo:** issues and pull requests (write), Actions (read logs, re-run, dispatch), contents including Trust-root and workflow files, secrets and variables, environments, branch protection, rulesets, and merging past the Merge gate. In the record these writes counted as the Operator's and started workflows: a reopened pull request started the Kit's Review, and a merge started the deploy.
2. **A second repo, in 12 of the 82 issues:** the Kit beside a Product repo (a finding filed upstream, a Kit release awaited, a comment on a `fabrik` issue), `fabrik-runs` for Run records, and once a legacy repo read for facts.
3. **AWS,** in one Product repo: staging and production accounts, and a management account.
4. **The vendors' dashboards:** Sentry, Cloudflare, Nookal, Deepgram, Stripe, and the Claude account's settings.
5. **1Password:** the vaults Setup makes, and the items a step stores or reads.
6. **The Product's deployed app in a browser,** signed in as a real user of it.
7. **A place to run the repo:** its tests, its local stack, the Kit's own programs.

## What no agent could do, whatever it held

These are the steps the record shows a person doing because only a person can:

- **A second factor.** The Operator's GitHub account, an AWS sign-in that requires MFA, Cloudflare Access's emailed code, and the Product's own sign-in (6 steps).
- **A consent or authorisation screen.** Installing the Fabrik App on a repo, accepting a new permission on its installation, authorising `claude setup-token`, and in one trial registering a GitHub App and authorising it through the device flow ([#523](https://github.com/jrey8343/fabrik/issues/523)).
- **A new account.** A machine user on GitHub with its own second factor, and in one trial a second Cloudflare account ([#538](https://github.com/jrey8343/fabrik/issues/538)).
- **A legal agreement or a billing choice.** A vendor's data processing agreement accepted, a plan chosen after a trial ended, and a paid GitHub plan weighed and turned down. **No step in the record says a payment was made.**
- **A device in the hand.** Merging from GitHub Mobile, and in three trials the Operator's iPhone: installing a page to the Home Screen, allowing notifications, tapping one, playing a video ([#532](https://github.com/jrey8343/fabrik/issues/532), [#557](https://github.com/jrey8343/fabrik/issues/557), [#589](https://github.com/jrey8343/fabrik/issues/589)).
- **Another person.** A question to a vendor's support desk, and two open issues that wait on a clinician's knowledge and an editorial call.

Two more kinds were done by hand because of a rule, not because they had to be:

- **One Product repo forbids any agent session from holding production or cloud-account credentials.** 7 issues, with 39 steps between them, say their credentialed steps were run from a terminal or browser with no agent running. The agent's part was drafting the runbook beforehand and checking the result afterwards by read-only means.
- **In at least 4 issues a new secret went straight from where it was minted to where it is stored** (a hidden prompt, standard input, a paste into a settings page) and never through the session. The agent then checked the store by name.

## The kinds that make up most of the work

| Kind | Steps | Share |
| --- | ---: | ---: |
| Tracker writes | 83 | 20% |
| Actions: read, re-run, dispatch, watch | 49 | 12% |
| Trust-root files other than workflows | 47 | 11% |
| The Operator's own terminal | 35 | 8% |
| Ordinary files through a pull request | 33 | 8% |
| **These five** | **247** | **59%** |
| Judgement only | 26 | 6% |
| AWS | 25 | 6% |
| Workflow files | 21 | 5% |
| **These eight** | **319** | **76%** |

Four more facts about the shape of the work:

- **13 issues took more than one sitting.** Each stopped to wait on something outside the session: a pull request's merge, a deploy, the next scheduled run, a later pull request that would produce the evidence to check, or a vendor's verification. The session posted where it stopped and was started again later.
- **Reading a failed job's log was often the whole of the Operator's part.** Triage holds no GitHub credential that reads job logs. On 5 of the 7 Monitor and Flaky-check issues that were not `ready-for-human`, the Operator's one act was pasting the red job's log into the issue, or answering Triage's questions from it. A sixth had a Pairing session that read both red jobs' annotations. The three `ready-for-human` red-main issues began the same way.
- **5 issues used a wizard,** a script the agent wrote and the Operator ran in their own terminal: Setup, a key stored over standard input, and a walk through a deployed app's first sign-in.
- **Since the two Product repos adopted the Kit** (57 issues, 315 steps), the mix is 42% ordinary GitHub, 24% GitHub with power, 12% third party, 9% terminal, 9% judgement or waiting, 3% hands and 1% 1Password. 37 of those 57 never left GitHub. The 25 earlier issues in `gradually-core` were worked under an earlier harness and hold most of the account, organization and bootstrap steps.

## Kit-owned issues

| Kind | Found | What the Operator did |
| --- | --- | --- |
| Weekly-limit issue | 10, all in the Pilot, 8 to 11 November | Closed 9 by hand, within minutes to hours and before the reset. The Kit closed the tenth at the reset. None has a task list or a Pairing session's comment, and none records a stalled run restarted. |
| Usage-credits issue | 0 in any repo | The label exists in both Product repos. |
| Token-rotation issue | 0 in any repo | The label exists in both Product repos. |
| Dead-tick issue | 0 in any repo, and none in `fabrik-runs` | `fabrik-runs` holds two Weekly summaries and nothing else. |
| Monitor issue | 6: 5 in `gradually-core`, 1 in the Pilot | 3 were `ready-for-human` and are counted above. On the others: a pasted log, or nothing. |
| Flaky-check issue | 6, in `gradually-core` | 2 were `ready-for-human` and are counted above. On the others: a pasted log, and on one a Pairing session that read the red jobs' annotations. |

So the record says nothing about what rotating a token or turning usage credits off takes in practice. The only evidence for those is Setup's own stages, which are in the terminal counts: `claude setup-token` with its browser authorisation, an item stored in 1Password, and the Claude account's settings page.

## The HITL Decisions of the closed Maps

105 Decisions under the six closed Maps in `fabrik`: 74 grillings, 9 prototypes, 22 tasks.

- **The 74 grillings needed conversation and reading,** of the repo and of earlier Decisions. Where a grilling needed a fact tried out, it was split off as a task Decision, which is why the tasks hold the needs.
- **The 9 prototypes each needed the Operator to look at something and choose.**
  - 5 were screens meant for a phone, built as throwaway variants on a branch: 3 on public branches of `fabrik` with invented data, 2 on orphan branches of the private Pilot because they showed real pull requests. The record names the branch, not how the Operator opened it.
  - 1 was a set of documents to read: Digests written by hand.
  - 2 ran a model or a Design session on a laptop, on a Subscription, with a checkout or skills placed by hand, and the Operator read what came out.
  - 1, the first of all ([#11](https://github.com/jrey8343/fabrik/issues/11)), ran a workflow that posted Rounds on an issue and had the Operator answer from a phone.
- **The 22 tasks:**

| What the task needed besides conversation | Tasks |
| --- | ---: |
| Nothing: reading code and Run records, writing a Spec, filing issues | 10 |
| A throwaway private repo, made and later deleted | 4 |
| A Cloudflare Worker deployed and later deleted | 4 |
| The Operator's iPhone in their hand | 3 |
| Real runs of the Loop on the Pilot, spending a Subscription | 2 |
| A GitHub App registered and authorised by the Operator | 1, and 1 more left a question untried for want of one |
| A new vendor account | 1 |
| A new permanent repo with its settings | 1 |
| Setup run in the Operator's terminal | 1 |
| The Operator's own token, on a laptop, against both Product repos | 1 |
| A code change in a second repo | 1 |

A task can appear in more than one row. Two details from them bear on a session with no terminal: one deploy tool would register an account's address only when it could ask in an interactive terminal ([#538](https://github.com/jrey8343/fabrik/issues/538)), and the same trial's session could not delete its throwaway repo because its token lacked that scope.

## What could not be classified or reached

- **[#300](https://github.com/jrey8343/fabrik/issues/300), the V2 trial on the Pilot, is counted apart.** It lists 54 checks under a wizard, none ticked on the issue. It has 8 sub-issues, which is where it said to file findings. About 20 of the 54 were acts by the Operator (a release, Setup and its wizard, the App's new permission, a second Subscription's token, usage credits off, a Sentry token, six Kit config edits, a handful of tracker writes). The rest were watching the Loop.
- **12 issues closed with no record of what was done.** They are classified from what the issue asked for.
- **11 issues have no step done yet** (about 40 steps). They are counted as asked.
- **Not everything was read in full.** The 74 grillings were scanned for mentions of a need (a device, a deploy, an account, a credential) and not read through. The 20 most recent `ready-for-human` issues in `gradually-core` were read as task list, opening text and the Operator's comments, without the agents' comments.
- **How long a step took** is not recorded anywhere.
- **How the Operator opened a prototype,** and on which device, is not recorded.
- **Work that never had a `ready-for-human` issue is invisible here:** sessions started without `/fabrik-pair`, the Console's own build (`fabrik-console` has no such issue), and Setup runs that no issue asked for.
- **Whether the stalled runs behind the nine hand-closed Weekly-limit issues were restarted,** and how.
- **The Operator's comments on the 7 other Monitor and Flaky-check issues** were read only in their opening lines.

## Sources

- `gh issue list -R <repo> --label ready-for-human --state all --limit 500 --json number,title,state,body,comments,labels,createdAt,closedAt,author` for each of the four repos, 2026-11-19.
- `gh issue list -R <repo> --label fabrik:<name> --state all` for each `fabrik:` label in the two Product repos, `gh api repos/<repo>/issues/<n>/events` for who closed each Weekly-limit issue, and `gh issue list -R jrey8343/fabrik-runs --state all`.
- `gh issue list -R jrey8343/fabrik --label wayfinder:<kind> --state all` for `map`, `grilling`, `prototype` and `task`, and `gh api repos/jrey8343/fabrik/issues/<map>/sub_issues` for each Map's Decisions.
- `gh repo list jrey8343 --limit 100` and `gh api repos/jrey8343/<name>/contents/.github/workflows/fabrik.yml` for each.
- `skills/fabrik-pair/SKILL.md` and `GLOSSARY.md` at `origin/main` (`e2914ebe`).
