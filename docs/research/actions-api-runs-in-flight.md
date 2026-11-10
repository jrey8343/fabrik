# What the GitHub Actions API can say about a Kit run in flight

Research for Decision #511 on the Wayfinder Map #507 (the Console). It also bears on #471 (nothing on a Ticket or PR says a run is in flight).

**Question.** The Console shows each run in flight at status level: role, Ticket or pull request, model, elapsed time and a link to the live log, and it tells running from queued from held. A Run record exists only once a run ends (ADR-0009), so this has to come from GitHub Actions. What do GitHub's REST, GraphQL and webhook APIs expose about a workflow run, its jobs and its steps while they run? How does a Kit workflow run map back to its role, Ticket or pull request and model today, and what would the Kit have to name or emit for that to be exact? And does any GitHub API give Actions minutes per repo or per run cheaply enough to show as a spend figure?

**Date.** 2026-11-10. Kit read at `1b14902`.

**Method.** GitHub's docs were read live on that date, with GitHub's OpenAPI description (`github/rest-api-description`, `api.github.com.json`) and public GraphQL schema for field lists. A few shapes were checked with `gh api` against public repositories only (this one and `cli/cli`). Nothing was read from a private repository, and no webhook delivery was observed: the Kit's own runs happen in private Product repos, so the event sequence in section 3 is read from the docs and the workflow files, not watched. Anything the docs don't state is listed under "Not verified".

## Answer in brief

1. **Status, elapsed time and the log link are exact today.** A job's `status`, `started_at` and `html_url` come from the REST jobs endpoint and from every `workflow_job` webhook delivery. Role and the issue or PR number are readable from names the Kit already sets (#477): the run's `display_title` ("Implement #12", "Review PR #60") and the job's `name` ("loop / Implement #12 (Retry 1)").
2. **The run's title is a forecast, the job's name is the fact.** `run-name` is worked out from the event before any job runs, so "Implement #12" also titles a run the Kit declined or held. Only a job that exists and isn't `skipped` says an agent is really working. That job appears once the Kit job has finished.
3. **Four things are missing from Actions today:** the model (in no name, and job outputs aren't in any API), the kind of Implement run (a Request-changes run and a conflict-only run look like a first run; only a Retry's number shows), the other half of the Ticket and PR pair (an Implement job names its Ticket, never its PR; a Review job its PR, never its Ticket), and anything machine-readable (step summaries have no API).
4. **A Held run is not in flight in Actions at all.** To the API it is a short green run whose agent job is `skipped`, the same as a declined trigger. The fact that it's held lives on the weekly-limit issue as a `<!-- fabrik:held {...} -->` marker. So "held" is read from Issues, and "queued" and "pending" from Actions; they are three different things.
5. **Webhooks carry all of it, but the Fabrik App can't subscribe today.** `workflow_run` and `workflow_job` need the "Actions" repository permission (read), which the Fabrik App deliberately lacks. Whichever credential the Console uses needs it. Polling as a fallback is cheap: 5,000 requests an hour per installation, and a `304` to a conditional request costs nothing.
6. **The cheapest exact fix is for the Kit to say what it routed in a place the API returns:** job names, or one step whose name is a line of JSON. Step and job names can read the Kit job's outputs; `run-name` can't. Section 5 sets out the options.
7. **Actions minutes: yes, with a caveat.** Per run, an estimate is free: `workflow_job` deliveries carry `started_at` and `completed_at`, GitHub rounds each job up to a whole minute, and every Kit job runs on a Linux 2-core runner at $0.006 a minute. The billed figure per repo comes from one call a month to `GET /users/{username}/settings/billing/usage`, but for a personal account the docs list only user tokens for it, not an App installation token. So the estimate needs nothing new, and the billed figure hangs on the credential decision.

## 1. What GitHub exposes while a run is in flight

### The workflow run

`GET /repos/{owner}/{repo}/actions/runs` and `/runs/{run_id}` ([REST: workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)). Fields that matter here, from the OpenAPI `workflow-run` schema and a live read of a public run:

| Field | What it is |
|---|---|
| `display_title` | "The event-specific title associated with the run or the run-name if set". This is where `run-name` lands. |
| `name` | The workflow's `name:` (the caller's, such as `Fabrik`). |
| `event` | The triggering event's name, as a bare string. |
| `status`, `conclusion` | See "Statuses" below. |
| `created_at`, `run_started_at`, `updated_at` | `run_started_at` is "The start time of the latest run. Resets on re-run." |
| `run_attempt`, `run_number` | `run_attempt` is 1, then higher on each re-run. |
| `html_url` | The run's page. |
| `head_branch`, `head_sha` | For `issues`, `issue_comment` and `schedule` runs this is the default branch and its last commit ([events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)). |
| `pull_requests` | "Pull requests that are open with a `head_sha` or `head_branch` that matches the workflow run. The returned pull requests do not necessarily indicate pull requests that triggered the run." Not a reliable link to the PR. |
| `path`, `referenced_workflows` | The caller's file, and each reusable workflow it called as `{path, sha, ref}`. A Kit run shows `jrey8343/fabrik/.github/workflows/loop.yml@<ref>` here, which also gives the Kit version in use. |

**The run does not carry the event's payload.** The schema has no `inputs`, `payload` or `client_payload` property; `event` is only the name. So the issue or PR number an `issues` or `pull_request_target` run was started for is not a field on the run. It is recoverable only from what the workflow itself puts in `run-name`, or by matching the run's start against the issue's own timeline.

**List filters:** `status`, `event`, `branch`, `actor`, `created`, `head_sha`, `check_suite_id`, `exclude_pull_requests`, `per_page` (up to 100). `status` takes one value per request, so "everything unfinished" is one request per status, or one unfiltered request read newest-first. The filters "return up to 1,000 results for each search".

### `run-name`

From [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax): "The name for workflow runs generated from the workflow." It "can include expressions and can reference the `github` and `inputs` contexts"; the [contexts table](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts) lists `github, inputs, vars`. Neither lists `needs`, so a run's title can never use a job's output. "If `run-name` is omitted or is only whitespace, then the run name is set to event-specific information", such as the commit message or PR title; what that is for `issues` or `schedule` runs isn't documented.

It is a top-level key of the workflow whose run it is. A reusable workflow doesn't get its own run ("Reusable workflows are called directly within a job"), so only the caller's `run-name` counts. The docs never say so in those words; the Kit found it out for #477 and `templates/fabrik.yml:12-13` records it.

### Jobs and steps

`GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` (with `filter=latest` for the current attempt only) and `/actions/jobs/{job_id}` ([REST: workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs)). From the OpenAPI `job` schema and a live read:

| Field | What it is |
|---|---|
| `name` | The job's `name:` with its expressions worked out. For a job inside a called workflow it is `<caller job> / <called job>`: observed on a public run in `cli/cli` as `no-response / noResponse`, and documented for check names in [troubleshooting rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/troubleshooting-rules). |
| `status` | `queued`, `in_progress`, `completed`, `waiting`, `requested`, `pending`. |
| `conclusion` | `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required`. |
| `created_at`, `started_at`, `completed_at` | Elapsed time is `now - started_at` while `status` is `in_progress`. |
| `html_url` | `https://github.com/<owner>/<repo>/actions/runs/<run>/job/<job>`: the live log page, for a signed-in viewer with access to the repo. |
| `steps[]` | Each with `name`, `number`, `status`, `conclusion`, `started_at`, `completed_at`. |
| `run_id`, `run_attempt`, `workflow_name`, `head_branch`, `head_sha`, `labels`, `runner_name` | `workflow_name` is the caller's name, also for a job inside a called workflow (observed). `runner_name` is null until a runner is assigned. |

Three things are **not** exposed:

- **Job outputs.** No endpoint or webhook returns a job's `outputs`. What one job passes to the next through `needs` stays inside the run.
- **Step summaries.** No REST endpoint returns `GITHUB_STEP_SUMMARY`; the docs describe it only as shown "on the workflow run summary page" ([workflow commands](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands)). A job's check run has an `output.summary` field, but it was `null` on the two jobs of this repo that were looked at, and no doc says Actions fills it.
- **A job that hasn't been created.** A job still waiting on its `needs` isn't listed until they finish. That isn't in the docs; the Kit's own reader records it and leans on it (`src/github/snapshot.ts:1949-1951`).

**Logs.** `GET .../jobs/{job_id}/logs` returns a redirect to a plain-text file, valid for one minute, and there is a per-step form, `.../jobs/{job_id}/steps/{step_number}/logs`. The docs don't say whether either works before the job ends. The Console only needs the link, so `html_url` is enough, and a live transcript is out of the Map's scope anyway.

### Statuses: queued, pending and waiting are different

From [check statuses and conclusions](https://docs.github.com/en/pull-requests/reference/status-checks):

- `requested`: "created but has not been queued."
- `queued`: "has been queued", that is, waiting for a runner.
- `pending`: "at the front of the queue but the group-based concurrency limit has been reached."
- `waiting`: "waiting for a deployment protection rule to be satisfied." The Kit uses no environments, so this shouldn't occur.
- `in_progress`, `completed`.

"Only GitHub Actions can set a status of `waiting`, `pending`, or `requested`."

### Concurrency groups

The Kit puts most jobs in a `concurrency:` group with `cancel-in-progress: false`. From [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax): when another job in the group is in progress, "the queued job or workflow will be `pending`. By default, any existing `pending` job or workflow in the same concurrency group will be canceled and the new queued job or workflow will take its place."

Since [7 May 2026](https://github.blog/changelog/2026-05-07-github-actions-concurrency-groups-now-allow-larger-queues/) a group takes a `queue` property: `single` (the default) keeps that behaviour, and `max` lets "up to 100 jobs or workflow runs" wait, served "in first-in-first-out (FIFO) order according to the time each one started waiting", though "ordering is not guaranteed". The Kit already sets `queue: max` on its Design, prototype, claim, Implement, Review, Audit, Retro, Research and push groups. The Triage job's group (`loop.yml:207-209`) doesn't, so a third Triage of one issue still cancels the second.

There is also a **concurrency-groups REST API** ([REST: concurrency groups](https://docs.github.com/en/rest/actions/concurrency-groups)), under the "Actions" read permission:

- `GET /repos/{owner}/{repo}/actions/concurrency_groups` lists the active groups.
- `GET .../concurrency_groups/{name}` lists who holds and who waits, each with `run_id`, `job_id`, `job_name` and `status` (`in_progress` or `pending`), and takes `ahead_of_job` to answer what is blocking one job.
- `GET .../runs/{run_id}/concurrency_groups` gives each of a run's groups with a `position`: "0 means the item holds the concurrency lease (in_progress), 1 or higher means queued (pending)."

Both list endpoints answered `200` with an empty list on this public repo, so the API is live. That is all that was observed of it.

### GraphQL and check runs add nothing in flight

- **GraphQL** has a `WorkflowRun` object with `displayTitle`, `event`, `runNumber`, `runAttempt`, `url` and `checkSuite`, but no status, no jobs and no way to list a repo's unfinished runs ([GraphQL: Actions](https://docs.github.com/en/graphql/reference/actions)). Status comes only through `CheckSuite` and `CheckRun`, anchored on a commit. Issue, comment and schedule runs all sit on the default branch's head commit, so a per-commit read mixes every one of them. REST is the natural source.
- **Check runs.** Each Actions job has a check run (`check_run_url` on the job). It needs a separate permission ("Checks" read), its webhook has no in-progress action, and its list endpoint can't filter on `pending`. It gives nothing the jobs API lacks while a run is in flight.

## 2. Webhooks and polling

### The events

From [webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads):

| Event | Actions | Fires when | GitHub App permission |
|---|---|---|---|
| `workflow_run` | `requested`, `in_progress`, `completed` | "A workflow run was triggered"; "started processing on a runner"; "finished ... regardless of whether the workflow was successful". `requested` "does not occur when a workflow is re-run". | "Actions" repository permission, read |
| `workflow_job` | `queued`, `waiting`, `in_progress`, `completed` | "A job in a workflow run was created"; "was created and is waiting for approvals"; "started processing on a runner"; "finished". | "Actions", read |
| `check_run` | `created`, `completed` (plus two that need write access) | No in-progress action. | "Checks", read |
| `deployment`, `deployment_status` | `created` | Only for jobs that name an `environment:`. The Kit has none. | "Deployments", read |

`workflow_job` is the one that matters. Every delivery carries the whole job: `id`, `run_id`, `run_attempt`, `name`, `status`, `conclusion`, `created_at`, `started_at`, `completed_at`, `html_url`, `workflow_name`, `head_branch`, `labels`, `runner_name` and `steps`. `workflow_run` carries `display_title`, `event`, `status`, `html_url`, `run_attempt`, `path` and `referenced_workflows`. Both events can be delivered to a GitHub App, and to a repository or organisation webhook.

So one `workflow_run.requested` gives the run's title and link the moment it starts, and each agent job's `workflow_job.in_progress` gives its name, start time and log link with no API call at all.

### What webhooks can't be trusted for

- **No redelivery.** "GitHub does not automatically redeliver failed webhook deliveries" ([handling failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)). A delivery can be asked for again for 3 days, and for an App that needs the App's JWT, not an installation token.
- **A 10-second deadline.** "Your server should respond with a 2XX response within 10 seconds", or the delivery counts as failed ([best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)).
- **No ordering.** "GitHub may deliver webhooks in a different order than the order in which the events took place" ([troubleshooting webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks)). `in_progress` can arrive after `completed`; compare the timestamps in the payload.
- **No `pending` action.** `workflow_job` has no action for a job blocked on its concurrency group, and its payload's `status` enum omits `pending`. Which delivery, if any, marks that moment is not documented.

A missed `completed` would leave a run showing as in flight forever, so the cache needs a reconciling read.

### Rate limits for that read

From [rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api):

- **An installation token gets 5,000 requests an hour.** It grows by 50 an hour per repository past 20; the 15,000 figure is only for GitHub Enterprise Cloud organisations. A workflow's own `GITHUB_TOKEN` gets 1,000 an hour per repository.
- **Secondary limits:** 100 concurrent requests, and 900 points a minute for REST, where a `GET` costs 1.
- **Conditional requests are free.** "Making a conditional request does not count against your primary rate limit if a `304` response is returned" ([best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)). The same page says to "subscribe to webhook events instead of polling" and to "use the same parameters every time you poll".

A reconciling read is one `GET .../actions/runs?per_page=N` per Product repo with `If-None-Match`, plus one jobs call per unfinished run only when the list changed. At one a minute that is at most 60 requests an hour for each repo before any `304`, a little over 1% of the budget. Elapsed time needs no polling: it's `now - started_at`, counted on the phone.

The Kit's own reader, for comparison, makes five list calls (one per unfinished status) and then one jobs call per unfinished run (`src/github/snapshot.ts:2121-2138`).

## 3. How a Kit run maps back today

### The two names the Kit sets

**The run's title** comes from `run-name` in the Product repo's caller workflow (`templates/fabrik.yml:16-39`), one case per line, first match wins:

| Event | Title | Line |
|---|---|---|
| `schedule` | `Tick` | 18 |
| `push` | `Push to <branch>` | 19 |
| issue opened with `fabrik:audit` / `fabrik:retro` | `Audit #<n>` / `Retro #<n>` | 20-21 |
| any other issue opened | `Triage #<n>` (or `Opened #<n>` for the Kit's other issues) | 22-23 |
| `agent:implement` / `agent:design` / `agent:research` / `agent:replay` added | `Implement #<n>` / `Design-session turn #<n>` / `Research #<n>` / `Replay #<n>` | 24-27 |
| any other label added to an issue | `#<n> labeled <label>` | 28 |
| a comment on a `needs-design` issue | `Design-session turn #<n>` | 30 |
| any other comment | `Comment on #<n>` | 31 |
| `agent:review` added, or a push to a `fabrik/` PR | `Review PR #<n>` | 32-33 |
| the Operator's Request changes | `Request changes PR #<n>` | 36 |

`src/kit/caller.test.ts:114-169` holds these cases to the Kit's label names. The store's caller (`templates/fabrik-runs-caller.yml:8`) sets no `run-name`; it runs no agent.

**The job's name** comes from `.github/workflows/loop.yml`, and in a Product repo each is prefixed with the caller's job key, `loop / `:

| Job | Name | Line | Concurrency group |
|---|---|---|---|
| Kit job | `Kit` | 62 | none |
| Triage | `Triage` | 202 | `fabrik-triage-<issue>` (208) |
| Design | `Design-session turn #<issue>` | 311 | `fabrik-design-<issue>` (320) |
| Prototype | `Prototype turn #<issue>` | 436 | `fabrik-design-<issue>` (445) |
| Claim | `Claim the work` | 658 | per run (666) |
| Implement | `Implement #<Ticket>` then ` (Retry <n>)` for a Retry | 699 | `fabrik-implement-<Ticket>` (710) |
| Review checks | `Review checks` | 955 | `fabrik-review-checks-<PR>` (961) |
| Review | `Review PR #<PR>` | 1026 | `fabrik-review-<PR>` (1033) |
| Audit, Retro evidence, Retro, Research | `Audit`, `Retro evidence`, `Retro`, `Research` | 1166, 1287, 1317, 1369 | `fabrik-audit`, none, `fabrik-retro`, `fabrik-research-<issue>` |
| Replay arms | `Replay implement (<arm>)` and three more | 1499-1627 | none |
| Push job | `Push` | 1704 | per run (1713) |
| Dispatch, Design queue, Score, Score record | by those names | 1825, 1861, 1902, 1951 | |

These names are already a contract inside the Kit. Dispatch, the stall check and the stuck-trigger sweep count runs in flight by matching them (`IMPLEMENT_JOB`, `REVIEW_JOB` and `DESIGN_JOB` at `src/github/snapshot.ts:1968-1969` and `:1985`; the constants at `:431-479`, each with a test holding it to the workflow). The Console would be a second reader of the same strings.

### Why the two names disagree

The Kit job decides what the run does. It reads the event, asks the Loop rules core for a Plan, and writes a `route` output (`src/kit/jobs.ts:104-109`, `:205`): one of the roles, `replay`, `push` or `none`. Each agent job runs only `if` the route is its own (`loop.yml:204`, `:314`, `:701`, `:957`). So:

- **`run-name` is set before the Kit job runs**, from the event alone. It says what the event usually starts.
- **The job name is set after**, from the Kit job's outputs (`needs.kit.outputs.ticket` and `.retry` at `loop.yml:699`, `.pull-request` at `:1026`). It says what the Kit actually started.

A run titled `Implement #12` therefore has four possible meanings: an Implement run started, the trigger was declined (`src/loop/implement.ts:71-73`), the run was held (below), or the Kit config was invalid. The same goes for `Review PR #60`, which titles every push to an agent PR, including one that gets no Review because a Retry is still in flight (`src/loop/review.ts:41-42`).

And some agent runs carry only a generic title. A Triage started by re-adding `needs-triage`, which is how a held Triage resumes (`src/loop/heldRun.ts:53`) and how a reply on a `needs-info` issue restarts it, is titled `#7 labeled needs-triage`. Its job is `loop / Triage`, with no number. That run's role comes only from the job and its issue only from the title.

A Product repo that hasn't updated its caller since #477 titles every run `Fabrik` (`README.md:33`).

### Field by field

| What the Console shows | Where it comes from today | How exact |
|---|---|---|
| **Role** | The job's `name`, once the job exists. Before that, the run's `display_title`. | Exact from the job. A forecast from the title. |
| **Ticket or PR** | The number in the title is the issue or PR the event was on. `Implement #<Ticket>` and `Review PR #<PR>` repeat it from the Plan. | One of the pair only. An Implement job never names its PR, a Review job never its Ticket. Triage, Research, Audit and Retro jobs name neither. |
| **Kind of Implement run** | ` (Retry <n>)` in the job name. | Only a Retry shows. A Request-changes run and a conflict-only run have `retry` 0 (`src/kit/jobs.ts:230`), so both read as `Implement #12`, like a first run. A Request-changes run started straight from the review is titled `Request changes PR #60`; one the Kit starts later, deferred behind a Retry say, starts from `agent:implement` like a Retry or a conflict-only run (`src/loop/implement.ts:69`) and isn't. |
| **Model** | Nowhere in Actions. | Missing. The Plan's model is a Kit job output (`src/kit/jobs.ts:227`), handed to the agent step as an env var (`loop.yml:808`) and written out again as a step output for the Run record (`src/agent/run.ts:336`). The Kit job's step summary names the Subscription but not the model (`src/kit/kitJob.ts:29`). |
| **Elapsed time** | The agent job's `started_at`. | Exact. The run's `run_started_at` is earlier: it includes the Kit job, the claim and, for a Review, the wait for required checks. |
| **Live log link** | The agent job's `html_url`. | Exact. It opens GitHub and needs the viewer signed in with access to the repo. The Kit's own comments link the run's attempt page instead (`src/main.ts:246-254`), and only once the run has landed. |
| **Running, queued or pending** | The agent job's `status`. | Exact for Actions' own states. A Review shows two stages: `loop / Review checks` in progress is the wait for the PR's required checks, `loop / Review PR #60` in progress is the Reviewer working. |
| **Held** | Not in Actions. See below. | Read from the weekly-limit issue. |

The missing half of the Ticket and PR pair can be filled from GitHub without the Kit: an agent PR's branch is `fabrik/<Ticket>` (`src/loop/agentPullRequest.ts:12-14`). The kind of run can be inferred from the Kit's markers on the PR (`<!-- fabrik:request-changes-run-started ... -->`, the conflict note), but that means the Console re-deriving what the Kit job already knew. The model can only be guessed, by re-running the Kit's Step-up rules (`src/loop/retry.ts:28-36`) over Kit config and the Ticket's labels.

### A run as the webhooks would show it

Not observed; read from the docs and the workflow file. A Retry on Ticket 12:

1. `workflow_run.requested`: title `Implement #12`, event `issues`, the run's link. Nothing yet says it will run.
2. `workflow_job` for `loop / Kit`: queued, in progress, completed.
3. `workflow_job.queued` for `loop / Claim the work` and for `loop / Implement #12 (Retry 1)`. This is the first moment the role, Ticket and Retry number are a fact. If another Implement run holds `fabrik-implement-12`, the job waits here as `pending`.
4. `workflow_job.in_progress` for the Implement job: `started_at` and `html_url`. The Console's line is complete, bar the model and the PR.
5. `workflow_job.completed` for it, with its `conclusion`. The run is still unfinished: the push job, and then perhaps Dispatch and Score jobs, follow. The Kit itself counts an Implement run as under way until its push job is done (`src/github/snapshot.ts:1953-1956`).
6. `workflow_run.completed`.

Most runs never get past step 2. Every issue comment, label and PR event starts a run, and for most the Kit job routes to `none` or to `push` alone. The Console has to ignore a run until it has a job that isn't `skipped` and whose name is an agent job's.

## 4. How a Held run looks to the Actions API

It doesn't look like anything in flight. The glossary's "neither starts nor fails" is literal:

1. The event arrives, such as `agent:implement` added to Ticket 12, and a run starts, titled `Implement #12`.
2. The Kit job's Plan has every `start-agent-run` replaced by a `remove-label`, a `hold-agent-run` and a comment on the weekly-limit issue (`src/loop/hold.ts:37-62`, `src/loop/heldRun.ts:266-271`).
3. With no `start-agent-run` in the Plan, the route is `push` (`src/kit/jobs.ts:104-109`). The Implement job's `if` is false, so it is `skipped`; so is the claim (`loop.yml:660`).
4. The push job takes the trigger label off and posts the held line, which ends in `<!-- fabrik:held {"issue":12,"role":"implement","label":"agent:implement","order":3} -->` (`src/loop/hold.ts:19-29`, `src/loop/heldRun.ts:37-43`). The hold itself "changes nothing on GitHub" (`src/github/apply.ts:570-572`).
5. The run completes with `conclusion: success`, about as long after it started as the Kit and push jobs take.

The only places that say "held" inside Actions are the Kit job's step summary (`src/kit/kitJob.ts:51-55`) and the push job's (`src/github/describePlan.ts:70-71`), and no API returns a step summary. To the API a held run and a declined trigger are the same: a green run, an agent job skipped, a push job that ran.

A run can also be held after it started: one "refused, or killed, while none is free is held instead of re-run" (`src/loop/hold.ts:2-3`). That shows as a run whose agent job failed, followed by a push job, with the same held marker posted.

So the Console reads Held runs where the Weekly summary already does (`README.md:318`): the held markers on the open weekly-limit issues, less the `<!-- fabrik:resumed ... -->` ones. That needs Issues read, not Actions.

Three other waits are also invisible to Actions, because no run exists while they last:

- **A Ticket waiting for a Dispatch slot.** It has `ready-for-agent` and no PR, and no run until Dispatch adds `agent:implement` (`src/loop/dispatch.ts:71-82`).
- **A `needs-design` issue waiting for a Design-session slot** (`README.md:318`, "Held work is silent").
- **A Retry the Verdict announced but that never started** (#416). The Verdict says "going back to an Implementer"; the proof that it is, is an unfinished run with a `loop / Implement #<Ticket> (Retry <n>)` job that isn't skipped. No such job a few minutes after the Verdict is the Operator's complaint, made checkable.

In the Console's words, then:

| State | Where it's read | What it looks like |
|---|---|---|
| Running | Actions | The agent job is `in_progress`. |
| Queued | Actions | The agent job is `queued`: waiting for a runner. Normally seconds. |
| Pending | Actions | The agent job is `pending` behind its concurrency group; the concurrency-groups API gives its position. |
| Landing | Actions | The agent job is `completed` and the run's `loop / Push` job isn't. |
| Held | Issues | A held marker on an open weekly-limit issue, not yet resumed. No run. |
| Waiting for a slot | Issues | `ready-for-agent` with no PR and no trigger label, or `needs-design` with no round. No run. |

## 5. What the Kit would have to name or emit

The gaps are the model, the kind of run, the PR beside the Ticket (and the Ticket beside the PR), and a held or declined run saying so. All four are known to the Kit job when it finishes (`src/kit/jobs.ts:204-256`). The question is which API-visible place it writes them to. `run-name` is ruled out: it can't read a job's output.

**A. Put more in the agent job's name.** For example `Implement #12 (Retry 1) · PR #60 · <model>`. A job's `name` may use `needs` ([contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts): `github, needs, strategy, matrix, vars, inputs`), and it arrives in every `workflow_job` delivery.
- For: no new step, no write credential, nothing extra to fetch.
- Against: the names are parsed by the Kit's own regexes and held by tests, so every addition changes three places. They are what the Operator reads on the Actions tab and in a PR's checks, so they get long. A display string becomes a wire format. And a held or declined run has no agent job to rename.

**B. One step whose name is a line of JSON.** A step's `name` may use `needs` and `steps` (same table: `github, needs, strategy, matrix, job, runner, env, vars, secrets, steps, inputs`), and `steps[]` is in the REST job and in every `workflow_job` delivery. The Kit job could end with a step named, say, `fabrik-run {"route":"implement","issue":12,"pullRequest":60,"kind":"retry","retry":1,"model":"...","effort":"..."}`, or `{"route":"push","held":[{"role":"implement","issue":12}]}` for a hold.
- For: one place, the Kit job, which every run has, so it also covers held and declined runs and arrives with the Kit job's `workflow_job.completed`, before the agent job has a runner. It leaves the human-readable job names alone. No write credential, so ADR-0002 is untouched.
- Against: it's an unusual use of a step name. It needs checking that a long name isn't cut short, and the values need keeping to what the Kit itself chose: a replay arm's model name comes from an issue body (`src/kit/jobs.ts:29-32`).

**C. A Kit-owned line on the Ticket or PR when the run starts.** This is #471's ground: the claim job, which holds the App token, writes or rewrites one marker such as `<!-- fabrik:run {"run":123,"role":"implement","kind":"retry","retry":1,"model":"..."} -->`.
- For: GitHub stays the record, the Map's first settled point. The GitHub page itself then says a run is in flight, which is what #471 asks for. The Console already reads issues and their webhooks, and gets the run id to join on.
- Against: only Implement, Research, replay and a Design session's first turn have a claim job today (`loop.yml:660`); Triage, Review and a Design reply would need one. It is a write per start, to weigh against "How loud each kind is". And it says a run started, not that it is still running, so Actions is still needed for liveness.

**D. An artifact from the Kit job.** A small `fabrik-run.json`, listed by `GET .../runs/{run_id}/artifacts` while the run is in flight. It works with no write credential, but costs a list and a download per run where A and B cost nothing.

**E. A commit status, check run or deployment.** Each needs a write permission in a job that has none today, and each attaches to a commit: for issue-triggered runs that is the default branch's head, where it would pile up. Not worth pursuing.

**Recommendation, not a decision.** For the Console alone, B is the smallest change that makes every field exact, including held and declined: one step in the Kit job, read from a webhook the Console receives anyway. A is the fallback if a JSON step name feels too odd, at the cost of leaving held runs to the Issues side. C answers a different question, what the Ticket itself shows, and is better settled under #471: it says a run started, B says what the run is, and neither makes the other unnecessary. Whatever is chosen, two facts hold without any Kit change: Held runs are read from the weekly-limit issues, and status, elapsed time and the log link come from `workflow_job`.

Two things the Console's side needs whatever the Kit does:

- **The "Actions" read permission.** "The Fabrik App has no Actions permission" (`loop.yml:1718`, `:1836`, `:1872`; `README.md:227`), which is why the Kit reads runs with each job's own `GITHUB_TOKEN`. To receive `workflow_run` and `workflow_job`, or to poll, the Console's credential needs it: either the Fabrik App gains it, which the Operator has to accept on each installation, or the Console has an App of its own. That belongs to the credential Decision.
- **The run's own summary.** If the Map's "last finished run's own summary" means the Actions step summary, no API returns it. It would have to come from the Run record in `fabrik-runs`, or from the Kit's comment on the Ticket or PR.

## 6. Actions minutes

### Per run

- **No billing field on a run or job.** The only schemas with a billable figure are the two timing endpoints' ([REST: workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)).
- **`GET /repos/{owner}/{repo}/actions/runs/{run_id}/timing` still answers,** with `billable.UBUNTU.total_ms`, `job_runs[].duration_ms` and `run_duration_ms`. It returned `200` on a public run on 2026-11-10, with `billable` at 0, as the docs say: "Billable minutes only apply to workflows in private repositories that use GitHub-hosted runners", and the figure "is not rounded up to the nearest whole minute". But both timing endpoints carry "This endpoint is in the process of closing down", and have since [February 2025](https://github.blog/changelog/2025-02-02-actions-get-workflow-usage-and-get-workflow-run-usage-endpoints-closing-down/), with no removal date. Not something to build on.
- **An estimate is free.** Every `workflow_job.completed` delivery has `started_at` and `completed_at`. "GitHub rounds the minutes and partial minutes each job uses up to the nearest whole minute" ([runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)). Every Kit job is `runs-on: ubuntu-latest`, the Linux 2-core runner at $0.006 a minute ([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)). So a run's cost is the sum over its jobs that ran of `ceil(minutes) × $0.006`, with no API call. A skipped job never reaches a runner.

The rounding matters for the Kit's shape: each job that starts bills at least a minute, and one agent run is four or more jobs (Kit, claim, agent, push, then perhaps Dispatch and Score). Every comment, label and hourly tick also starts a run with at least a Kit job. An estimate summed from webhooks would show that; a per-agent-run figure alone would hide it.

### Per repo

- **The old endpoints are gone.** `/users/{username}/settings/billing/actions` and its siblings "are no longer supported" since [26 September 2025](https://github.blog/changelog/2025-09-26-product-specific-billing-apis-are-closing-down/).
- **The replacement is `GET /users/{username}/settings/billing/usage`** ([REST: billing usage](https://docs.github.com/en/rest/billing/usage)), with `year`, `month` and `day` parameters. Each `usageItems[]` row has `date`, `product`, `sku`, `quantity`, `unitType`, `pricePerUnit`, `grossAmount`, `discountAmount`, `netAmount` and `repositoryName`. One call for the month returns every repo; group by `repositoryName`. It is per repo, per SKU and per day. It has no run, job or workflow field, and the fuller report with `workflow_path` "cannot be obtained via the REST API" ([billing reports](https://docs.github.com/en/billing/reference/billing-reports)).
- **It wants a user's token.** The reference lists it for "GitHub App user access tokens" and "Fine-grained personal access tokens" with the "Plan" user permission (read). An App installation token is not listed for the user endpoints, though it is for the organisation ones. So the Worker's installation token can't read a personal account's bill; it needs the Operator's own token, or a user access token from an App the Operator signed in to.
- **Free allowance.** GitHub Free includes $12 a month of Actions compute on private repos and Pro $18; public repos on standard runners are free. `netAmount` is after that discount, `grossAmount` before.

### Yes or no

**Yes for an estimate, and it costs nothing:** minutes and dollars per run and per repo, summed from the `workflow_job` deliveries the Console already receives. **Yes for the billed figure per repo, at one call a month, but only with a user-level credential,** which is the credential Decision's to grant or refuse. **No for a billed figure per run:** GitHub doesn't publish one.

## Not verified

- **How a job blocked on its concurrency group is reported.** The docs call it `pending` and the job schema allows that status, but no page says "a blocked job's `status` is `pending`", and `workflow_job` has no `pending` action. Which delivery marks the moment, and what the run's own `status` is meanwhile, wants one experiment: two runs in one group on a test repo, watching the deliveries.
- **The webhook sequence in section 3.** Read from the docs and the workflow, not watched. In particular, whether a `skipped` job sends a `workflow_job.completed` delivery, and how a skipped job whose name uses an empty output is shown.
- **`display_title` on `workflow_run.in_progress`.** The payload schema declares it for `requested` and `completed` only.
- **Whether `steps[]` lists steps that haven't started,** and whether a step's name is shown with its expressions worked out before it runs. Option B avoids both by reading the step from the Kit job once it has completed. Any length limit on a step or job name wasn't looked for.
- **Whether a job's check run ever carries its step summary** in `output.summary`. It was `null` on two jobs here; whether either wrote a summary wasn't checked.
- **Whether job logs can be downloaded while the job runs.**
- **The concurrency-groups API** was seen only returning empty lists.
- **The timing endpoint on a private repo:** whether it still fills `billable` for a personal account, and whether it accepts an installation token. The docs' permission tables say it does; the OpenAPI description marks it `enabledForGitHubApps: false`.
- **Which personal access token the billing usage endpoint accepts.** The REST reference says fine-grained; the [usage-reporting tutorial](https://docs.github.com/en/billing/tutorials/automate-usage-reporting) says "The billing usage endpoints do not support fine-grained personal access tokens." Test before settling the credential.
- **How fresh the billing usage data is,** and whether `repositoryName` is always present on Actions rows.
- **How long the Kit job takes** in a Product repo, which sets how long a run shows only its forecast title. Not measured: that would mean reading a private repo's runs.

## Sources

GitHub docs, read 2026-11-10:

- [REST: workflow runs](https://docs.github.com/en/rest/actions/workflow-runs), [workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs), [concurrency groups](https://docs.github.com/en/rest/actions/concurrency-groups), [check runs](https://docs.github.com/en/rest/checks/runs), [billing usage](https://docs.github.com/en/rest/billing/usage)
- [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts), [events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [reusable workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/reusable-workflows), [workflow commands](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands)
- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [best practices for using webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks), [handling failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries), [troubleshooting webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks)
- [Check statuses and conclusions](https://docs.github.com/en/pull-requests/reference/status-checks)
- [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api), [permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
- [GraphQL: Actions](https://docs.github.com/en/graphql/reference/actions), [GraphQL: checks](https://docs.github.com/en/graphql/reference/checks)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing), [billing reports](https://docs.github.com/en/billing/reference/billing-reports)
- Changelog: [concurrency groups allow larger queues](https://github.blog/changelog/2026-05-07-github-actions-concurrency-groups-now-allow-larger-queues/) (2026-05-07), [timing endpoints closing down](https://github.blog/changelog/2025-02-02-actions-get-workflow-usage-and-get-workflow-run-usage-endpoints-closing-down/) (2025-02-02), [product-specific billing APIs closing down](https://github.blog/changelog/2025-09-26-product-specific-billing-apis-are-closing-down/) (2025-09-26)
- `github/rest-api-description`, `descriptions/api.github.com/api.github.com.json`, for the `workflow-run`, `job` and `check-run` schemas and the webhook payloads

In this repo, at `1b14902`: `templates/fabrik.yml`, `templates/fabrik-runs-caller.yml`, `.github/workflows/loop.yml`, `src/kit/jobs.ts`, `src/kit/kitJob.ts`, `src/main.ts`, `src/github/snapshot.ts`, `src/github/apply.ts`, `src/github/describePlan.ts`, `src/loop/hold.ts`, `src/loop/heldRun.ts`, `src/loop/implement.ts`, `src/loop/review.ts`, `src/loop/retry.ts`, `src/loop/dispatch.ts`, `src/agent/run.ts`, `src/kit/caller.test.ts`, `README.md`, `GLOSSARY.md`.
