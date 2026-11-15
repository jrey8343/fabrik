# Giving a run the reason a Required check failed

Research for Decision #710 on the Map #709. Sources were read on 2026-11-16. GitHub's docs were fetched as Markdown from docs.github.com on that date; their REST pages name API version `2026-03-10`. The runner source is `actions/runner` at `main` on that date. The Kit's code is cited at commit `e1e62b6`.

The question: how can a Fabrik run be given the reason a Required check failed, when no agent role holds a GitHub credential (ADR-0002) and the Product repos are private?

Each claim below is marked one of three ways:

- **Documented**: a GitHub doc, the runner's source or the Kit's code says so, cited as `[G…]`, `[S…]` or by file and line.
- **Observed**: read from the Kit's own repo on that date. The sample is workflow run `42449956659`, job `128636834592`, a `Typecheck and test` job of the Kit's CI that failed at its Typecheck step. That repo is public. Nothing was read from either Product repo.
- **Inferred**: reasoned from the above, and not tried.

## Answer in brief

- **The Kit's jobs can already read the failure. Nothing is missing but the code.** The Review checks job's token holds `actions: read`, `checks: read` and `statuses: read` today. With those it can read a failed GitHub Actions job's steps and which one failed, that step's log alone or the whole job's log as plain text, and the check run's annotations. For a red check from an outside service it can read only what that service put on GitHub.
- **Three ways to hand it to a run, and one that doesn't work.**
  1. **Text in the Verdict.** The Review path reads the failing step's log and annotations, and the push job puts an excerpt in the Verdict comment. A Retry's prompt already carries that comment whole. No permission changes, no Setup step.
  2. **Text in the prompt, read by the Implement job's input step.** The step that reads the Retry's pull request also reads the failure. The Implement job's `permissions:` gain `actions: read` and `checks: read` in `loop.yml`. Every caller already grants at least that, so there is no caller change and no Setup step.
  3. **A file in the Sandbox.** The same read, written to a file outside the checkout, with the prompt naming its path. It needs what way 2 needs, and the log can be whole.
  4. **A link** helps the Operator and no agent: GitHub shows a workflow run only to a signed-in account, and the agent has no token.
- **None of them needs a new secret, a new Fabrik App permission, or anything from the Operator.**
- **What none can give:** an outside service's own log; a cause the log doesn't hold, such as a job that never started; whether the pull request caused the failure; a promise that every secret in the log is masked; anything past the repo's retention period.
- **Limits that shape the design:** GitHub documents no cap on a log's size. A Verdict comment holds 65,536 characters. Annotations stop at 10 errors a step. Logs are deleted after 90 days by default, and since 1 October 2026 so are check runs and commit statuses.

## 1. What the Kit does today

All **documented**, from the Kit's code.

- **A Retry is given the failed checks' names and nothing else.** `applyRedChecks` builds the Verdict's findings as headings over a list of names (`src/loop/review.ts:82-98`). The comment's one link is to the Kit's own Loop run (`src/loop/review.ts:249`), not to the failed job. `retryContext` puts the latest Verdict comment into the Retry's prompt under "The findings to fix" (`src/agent/implement.ts:122-148`). The prompt also names the Sandbox's test command and the Required checks (`src/agent/implement.ts:550-558`), so a run can re-run the suite itself. It can't see how the check failed on GitHub.
- **The Review checks job reads each check's job link, and drops it.** Its wait asks `gh pr checks` for `name,bucket,link,workflow,startedAt` (`src/review/wait.ts:82`). For a GitHub Actions check the link is `…/actions/runs/<run>/job/<job>` (`src/review/rerun.ts:28-29`). The job writes names to its `failed` output and, on red, the names with their links and workflow runs to `red` (`src/review/wait.ts:242-253`). The push job passes only the names to the Loop (`src/kit/pushJob.ts:226-229`).
- **The link survives in one place: a Flaky check's issue.** A check that passed on the Kit's re-run keeps its red and green links (`src/review/rerun.ts:73-83`), and they are written into the Flaky check issue or a comment on it (`src/loop/flakyChecks.ts:37`). A check that failed again keeps only its name (`src/kit/pushJob.ts:263-271`).
- **No agent holds a GitHub token.** "The agent itself never gets a GitHub token" (`.github/actions/prepare-agent/action.yml:12-13`). The Implement job's token is passed to the input step alone (`.github/workflows/loop.yml:827`), the checkout keeps no credential (`loop.yml:805`), and the agent step's `env:` has no token (`loop.yml:857-873`). ADR-0002 gives the reason: the agent job holds `contents: read` and no GitHub App token.
- **Which job holds what on the workflow token:**

  | Job | `permissions:` | Where |
  | --- | --- | --- |
  | Review checks, and the wait after a re-run | `contents`, `pull-requests`, `checks`, `statuses`, `actions`: all `read` | `loop.yml:1030-1036`, `1138-1143` |
  | Re-run red checks | `actions: write` only | `loop.yml:1098-1099`, ADR-0018 |
  | Implement | `contents`, `issues`, `pull-requests`: `read` | `loop.yml:773-777` |
  | push | `actions: read`, plus the Fabrik App's token | `loop.yml:2027-2030` |
  | The caller's `loop` job, the most any Kit job may hold | `checks: read`, `statuses: read`, `actions: write` among others | `templates/fabrik.yml:83-91` |

- **The Fabrik App has Checks: read and Actions: read**, where the Operator has accepted them (ADR-0002 and its addendum, `src/setup/wizard.sh:320`). The comment at `loop.yml:2028-2029` still says the App "has no Actions permission", which the addendum supersedes.

## 2. What GitHub lets a job read about a red check

### A failed GitHub Actions job

| What | Endpoint | Permission | Returns |
| --- | --- | --- | --- |
| The job and its steps | `GET /repos/{owner}/{repo}/actions/jobs/{job_id}` | Actions: read | `conclusion`, `run_attempt`, `check_run_url`, and `steps[]` with `name`, `number`, `conclusion` |
| The job's log | `GET …/actions/jobs/{job_id}/logs` | Actions: read | A redirect to a plain text file |
| One step's log | `GET …/actions/jobs/{job_id}/steps/{step_number}/logs` | Actions: read | A redirect to a plain text file |
| A run's logs, or one attempt's | `GET …/actions/runs/{run_id}/logs`, `…/attempts/{attempt_number}/logs` | Actions: read | A redirect to a zip archive |
| A run's jobs, or one attempt's | `GET …/actions/runs/{run_id}/jobs`, `…/attempts/{attempt_number}/jobs` | Actions: read | The job objects above |
| The check run | `GET …/check-runs/{check_run_id}`, `GET …/commits/{ref}/check-runs` | Checks: read | `conclusion`, `details_url`, `output.title`, `output.summary`, `output.text`, `output.annotations_count` |
| Its annotations | `GET …/check-runs/{check_run_id}/annotations` | Checks: read | `path`, `start_line`, `annotation_level`, `title`, `message`, `raw_details` |

- **Documented:** the endpoints and their response fields [G1][G2][G3]; the permission each needs, and that an installation token may call them [G4].
- **Documented:** each log redirect "expires after 1 minute", so the read follows it at once [G1][G2].
- **Documented:** the step endpoint "is intended for selective retrieval of one step" [G1].
- **Documented:** "When you download the log archive for a workflow that was partially re-run, the archive only includes the jobs that were re-run" [G5]. `GET …/runs/{run_id}/jobs` takes `filter=all` to list jobs "from old executions of the workflow run" [G1].
- **Observed:** the job's id is the check run's id. The sample job `128636834592` has `check_run_url` `…/check-runs/128636834592`, and its `html_url` is the link `gh pr checks` gives. So the link the Review checks job already holds names both the job and the check run. No doc promises this; `check_run_url` on the job object is the documented way across [G1].
- **Observed:** the job's `steps[]` named the failed step: step 5, `Typecheck`, `conclusion: "failure"`, with later steps `skipped`.
- **Observed:** the whole job log was 17,588 bytes in 209 lines. The step log for step 5 was 738 bytes in 10 lines, and held the compiler's error and "Process completed with exit code 1."
- **Observed:** the check run's `output.title`, `summary` and `text` were all `null`. It had three annotations: the TypeScript error with its file and line (`src/loop/conflicts.test.ts`, 211), "Process completed with exit code 1." at `.github`, and a runner notice.
- **Observed:** the log's form. It starts with a UTF-8 byte-order mark. Each line starts with a timestamp such as `2026-11-08T05:14:13.5242087Z `. Steps' commands sit between `##[group]` and `##[endgroup]`, errors start `##[error]`, and the text carries ANSI colour sequences. `gh api` (2.103.3) refused to print it without `--allow-escape-sequences`.
- **Documented:** `gh run view --log-failed` prints "the log for any failed steps in a run or specific job". It reads the run's zip archive first, and there "some log lines may not be associated with a specific step within a job" [C1].

### GraphQL

**Documented:** GraphQL's `CheckRun` has `annotations`, `steps` (each with `name`, `number`, `conclusion`), `summary`, `text`, `title` and `detailsUrl`. It has no field for a log [G6]. The log is REST only. `gh pr checks`, which the wait already calls, is a GraphQL read.

### A job summary or a test reporter's report

- **Documented:** a job writes Markdown to `GITHUB_STEP_SUMMARY` and it is "shown on the workflow run summary page". Each step's part is capped at 1 MiB and 20 are displayed per job [G7].
- **Not established:** how to read a job summary through the API. The workflow jobs, workflow runs and check runs pages document no endpoint for it [G1][G2][G3]. The sample job wrote none, so its null `output.summary` settles nothing.
- **Documented:** a reporter that creates its own check run can fill `output.summary` and `output.text`, each up to 65,535 characters, and add annotations [G3]. Those are read with Checks: read like any check run [G4]. Whether either Product repo's CI does this was not read.
- **Documented:** a job can upload a report as an artifact, and `GET …/actions/runs/{run_id}/artifacts` and the download endpoint need Actions: read [G4][G8]. The Review job already downloads an Implement run's artifact this way (`loop.yml:1221-1222`).

### A red check from an outside service

- **Documented:** GitHub Actions "generates checks, not commit statuses". Outside services report as either: a check with "detailed output, annotations, and messages", or a commit status, "a simpler status for a commit" [G9].
- **Documented:** a commit status carries a `state`, a `description` ("the high level summary of what happened with the build") and a `target_url` ("the full URL to the build output") [G10]. Reading them needs Commit statuses: read [G4]. The Review checks job holds `statuses: read`; the Fabrik App does not have it (ADR-0018's consequences).
- **Documented:** an outside check run carries `details_url`, "the URL of the integrator's site that has the full details of the check", and whatever `output` and annotations the service wrote [G3].
- **Inferred:** the service's own log sits behind `target_url` or `details_url` on the service's site, under the service's own sign-in. No GitHub permission reaches it. What the Kit can pass on is the description, the output and the annotations, which may be one line.

## 3. Permissions, limits, retention and masking

### Permissions

- **Documented:** on the workflow token, `actions`, `checks` and `statuses` each take `read`, `write` or `none`, and "`write` includes `read`" [G11].
- **Documented:** "The `GITHUB_TOKEN` permissions passed from the caller workflow can be only downgraded (not elevated) by the called workflow" [G12].
- **Inferred from those and the Kit's code:** the caller's `loop` job grants `actions: write`, `checks: read` and `statuses: read` (`templates/fabrik.yml:83-91`). Before ADR-0018 it granted `actions: read`. So any Kit job in `loop.yml` may ask for `actions: read`, `checks: read` and `statuses: read` with no caller change. ADR-0018 records what happens otherwise: GitHub starts no run of a caller that grants a called job less than it asks.
- **Inferred:** a workflow token's `actions: read` reads every run in its repo, not only its own. The Re-run red checks job reads other workflows' runs with its token today (`src/review/rerun-main.ts:47-51`), and the Review job downloads another run's artifact.
- **Documented:** an installation token with Actions: read may call every log endpoint above, and with Checks: read the check run ones [G4]. So the Fabrik App's token could read them too, in a push job or the hourly tick.

### Rate limits

- **Documented:** "The rate limit for `GITHUB_TOKEN` is 1,000 requests per hour per repository." An installation token gets at least 5,000 an hour [G13].
- **Inferred:** reading one red check costs about four requests: the check runs on the head, the job, the step's log, the annotations. The redirect's target is a file download, not an API call.

### Sizes

- **Not established:** a cap on a log's size. GitHub's Actions limits page lists none [G14]. The runner writes a job's log in 8 MB pages, with no cap in that file [S2]. A log can be large; the Product repos' own logs were not measured.
- **Documented:** "GitHub Actions are limited to 10 warning annotations and 10 error annotations per step" [G3]. The runner's source agrees, at 10 per kind per step, and cuts each message to 4,096 characters [S1].
- **Documented:** a check run's `summary` and `text` hold 65,535 characters each. An annotation's `message` holds 64 KB and its `title` 255 characters. The annotations list is paged at up to 100 [G3].
- **Documented:** a job's outputs "can be a maximum of 1 MB per job", 50 MB a run, and "Outputs containing secrets are redacted on the runner and not sent to GitHub Actions" [G11]. An artifact is the Kit's usual way to pass a file between jobs.
- **Documented, from the Kit:** a GitHub comment holds 65,536 characters (`src/loop/roundLine.ts:19`), and a Verdict drops a line that would pass it (`src/loop/review.ts:257-258`).

### Retention

- **Documented:** "By default, checks, workflow runs, commit statuses, and the artifacts and log files generated by workflows are retained for 90 days before they are automatically deleted." A private repo may set 1 to 400 days [G15].
- **Documented:** since 1 October 2026 the setting also covers checks, workflow runs and commit statuses, "created by Actions as well as third-party applications". Before that they were kept "for 400+ days" [G15][G16].
- **Inferred:** a read at Review time or at the Retry's start is minutes after the failure, so retention doesn't touch it. It matters for late readers: a Flaky check issue's links, a Design session weeks later, an Audit. Text copied into a Verdict comment outlives the log. Neither Product repo's setting was read.

### Masking

- **Documented:** "Redacting of secrets is performed by your workflow runners. This means a secret will only be redacted if it was used within a job and is accessible by the runner" [G17].
- **Documented, from the runner's source:** every log line goes through `SecretMasker.MaskSecrets` before it is written to the job's log or sent to GitHub [S1]. The masker also matches common encodings of each secret, Base64 and JSON-escaped among them [S3].
- **Inferred:** a downloaded log is the text the runner already masked. Downloading it unmasks nothing, and masks nothing more.
- **Documented:** "automatic redaction is not guaranteed". Redaction "largely relies on finding an exact match", structured secrets can defeat it, and a value derived from a secret isn't masked unless the workflow registers it with `::add-mask::` [G17][G7]. GitHub also redacts some token formats it recognises, such as GitHub tokens, JWTs and database connection strings [G18].
- **Inferred:** the Product's CI may hold secrets the Sandbox doesn't, since a Sandbox holds "no production secrets" (`GLOSSARY.md`). A value that escaped masking in CI would travel with the log into the Implementer's prompt and its transcript, and by way 1 into a pull request comment that retention never deletes. The log is also text the Kit didn't write: it goes in the prompt as data, as the pull request's description does (`src/agent/implement.ts:99-100`).

## 4. Cutting a log to the failing part

- **Documented:** the job's `steps[]` give each step's `conclusion`, and the step endpoint returns one step's log [G1]. That is the one cut GitHub supports by name: take the steps whose conclusion is `failure`.
- **Observed:** on the sample that cut 17,588 bytes to 738, and kept the whole reason.
- **Documented:** annotations are a second, smaller cut: the lines the job marked as errors, with a file and line where a problem matcher or an `::error file=…,line=…::` command gave one [G7]. They cap at 10 errors a step.
- **Inferred:** a failing test step can still be long, since a suite prints every test. Test runners put failures and the summary last, so the end of the step's log is the part to keep when it must be cut again. How many lines to keep is a design choice no source settles.
- **Inferred:** before the text reaches a prompt, the byte-order mark, the timestamps (29 characters a line on the sample) and the ANSI sequences can go. The `##[group]` and `##[error]` markers are the runner's log format as observed, not a documented contract.
- **Inferred:** an Actions job that failed with no failed step, or with no steps, has no step to cut to. Its annotations are then the only reason GitHub holds.

## 5. The ways to hand a run the failure

The first three are **inferred** designs resting on the facts above. None was built or tried.

| Way | Who reads GitHub | Permission change | Setup step | What the run gets |
| --- | --- | --- | --- | --- |
| 1. Text in the Verdict | The Review checks job, or the wait after a re-run | None | None | An excerpt, inside the comment's 65,536 characters |
| 2. Text in the prompt | The Implement job's input step | `actions: read` and `checks: read` on the Implement job in `loop.yml`; `statuses: read` too for outside commit statuses | None | An excerpt, with no comment limit |
| 3. A file in the Sandbox | As way 2, or way 1's job uploading an artifact the Implement job downloads | `actions: read` on the Implement job either way; `checks: read` if it reads annotations itself | None | The whole step's or job's log, to search |
| 4. A link | Nobody | None | None | Nothing an agent can open |

**1. Text in the Verdict.**

- The Review checks job holds every permission the read needs and already has each red check's job link in hand (`src/review/wait.ts:223`, `250`).
- It can pass the excerpt out as an artifact, as it passes a failure report (`loop.yml:1076-1084`). The push job puts it in the Verdict, and `retryContext` delivers it unchanged.
- Everything that reads the Verdict gets it: the Retry, a Step-up, a Request-changes run that takes over the findings (`src/agent/implement.ts:246-252`), and the Operator on the pull request.
- Its costs: the excerpt shares the comment's 65,536 characters with the rest of the Verdict, and whatever the log holds is published on the pull request for good.
- The Fabrik App's token could do the read in the push job instead, where the App's Actions: read has been accepted.

**2. Text in the prompt, read by the input step.**

- `prepare-agent` already reads the Retry's pull request with the job's token before any secret loads, and writes it to `$RUNNER_TEMP` (`action.yml:88-102`).
- The same step can find the failed check runs on the Verdict's head by the names the Verdict's marker records (`src/loop/review.ts:229-238`), and read their steps, logs and annotations.
- Nothing is posted on the pull request.
- Its cost is a wider token in the one job that runs the agent with `noSandbox()`. Today that token reads contents, issues and pull requests. It would also read every run's logs in the repo. The agent is never passed the token either way.

**3. A file in the Sandbox.**

- The input step writes the log beside the other input files in `$RUNNER_TEMP`, outside the checkout so it is never committed, and the prompt names the path and carries only the annotations and the step's last lines.
- The Implementer can then search the whole log.
- It is the only way that isn't bounded by what fits in a prompt or a comment.
- It needs the Implement job's `actions: read` however the file arrives, since downloading another run's artifact needs it too [G4].

**4. A link.**

- **Documented:** "You must be logged in to a GitHub account to view workflow run information, including for public repositories" [G5].
- The agent has no token, so the check's job link opens nothing for it. It is still worth a place in the Verdict for the Operator, and the Kit already holds it.

**Anything else.** The Product's own CI can make the reason cheaper to read: a problem matcher or `::error` command turns a failure into an annotation, and a test reporter can write a check run's summary or upload a report. Each is read with permissions the Review checks job holds. Those are changes to a Product repo's suite, which the Map puts out of scope.

### What none of them can give

- **An outside service's log.** Only the description, output and annotations the service wrote to GitHub.
- **A cause the log doesn't hold.** A Required check that never reported has no job. A workflow run GitHub refused at startup "has no jobs" (ADR-0002's addendum), so no log. What a job leaves when its runner dies mid-step, as when a lint runs out of memory, was not established.
- **Whether the pull request caused it.** A log says what failed, not whether the same check is red on `main` or flaky. That is the other red-check Decision's question.
- **A promise about secrets.** Masking is the runner's, done once, by exact match.
- **Anything past retention**, 90 days unless the repo says otherwise, check runs and commit statuses now included.
- **Test results as data**, unless the Product's CI writes annotations or a report. The log is text.

## Open questions

- **How large the Product repos' failing logs are**, and how much of a failing test step is the reason. Neither repo was read. Measuring the 8 red-check Execution flaws the Map counts would size the excerpt.
- **Whether a job's log can be read while its workflow run is still going.** The wait reads red as soon as one Required check fails (`src/review/checks.ts:29-30`), when the run's other jobs may still be running. The docs don't say. It needs one trial.
- **Whether a first attempt's job stays readable by its job id after the Kit re-runs the failed jobs.** The attempt endpoints exist for it [G1][G2]. The Kit's repo had no re-run among its last 200 runs to try it on.
- **Whether a job summary can be read through the API at all.**
- **What a job whose runner was killed leaves** in its log and annotations.
- **What each outside service on the Product repos writes** to its check run or commit status when it fails.
- **Each Product repo's retention setting.**

## Sources

- [G1] GitHub Docs, REST API endpoints for workflow jobs: https://docs.github.com/en/rest/actions/workflow-jobs
- [G2] GitHub Docs, REST API endpoints for workflow runs: https://docs.github.com/en/rest/actions/workflow-runs
- [G3] GitHub Docs, REST API endpoints for check runs: https://docs.github.com/en/rest/checks/runs
- [G4] GitHub Docs, Permissions required for GitHub Apps (Repository permissions for "Actions", "Checks", "Commit statuses"): https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
- [G5] GitHub Docs, Using workflow run logs: https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs
- [G6] GitHub Docs, GraphQL reference, Checks (`CheckRun`, `CheckStep`, `CheckAnnotation`): https://docs.github.com/en/graphql/reference/checks
- [G7] GitHub Docs, Workflow commands for GitHub Actions ("Setting an error message", "Masking a value in a log", "Adding a job summary"): https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
- [G8] GitHub Docs, REST API endpoints for GitHub Actions artifacts: https://docs.github.com/en/rest/actions/artifacts
- [G9] GitHub Docs, About status checks: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks
- [G10] GitHub Docs, REST API endpoints for commit statuses: https://docs.github.com/en/rest/commits/statuses
- [G11] GitHub Docs, Workflow syntax for GitHub Actions (`permissions`, `jobs.<job_id>.outputs`): https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- [G12] GitHub Docs, Reusable workflows reference: https://docs.github.com/en/actions/reference/workflows-and-actions/reusable-workflows
- [G13] GitHub Docs, Rate limits for the REST API: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- [G14] GitHub Docs, Actions limits: https://docs.github.com/en/actions/reference/limits
- [G15] GitHub Docs, Managing GitHub Actions settings for a repository ("Configuring the retention period for checks, workflow runs, commit statuses, artifacts, and logs in your repository"): https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository
- [G16] GitHub Changelog, Actions retention will cover checks, workflow runs, and statuses, 2026-07-17: https://github.blog/changelog/2026-07-17-actions-retention-will-cover-checks-workflow-runs-and-statuses/
- [G17] GitHub Docs, Secure use reference ("Use secrets for sensitive information"): https://docs.github.com/en/actions/reference/security/secure-use
- [G18] GitHub Docs, Secrets reference ("Automatically redacted secrets"): https://docs.github.com/en/actions/reference/security/secrets
- [C1] GitHub CLI manual, `gh run view`: https://cli.github.com/manual/gh_run_view
- [S1] `actions/runner`, `src/Runner.Worker/ExecutionContext.cs` (`Write`, `AddIssue`, `_maxCountPerIssueType`, `_maxIssueMessageLength`): https://github.com/actions/runner/blob/main/src/Runner.Worker/ExecutionContext.cs
- [S2] `actions/runner`, `src/Runner.Common/Logging.cs` (`PageSize`): https://github.com/actions/runner/blob/main/src/Runner.Common/Logging.cs
- [S3] `actions/runner`, `src/Runner.Common/HostContext.cs` (the secret masker's value encoders): https://github.com/actions/runner/blob/main/src/Runner.Common/HostContext.cs
- Observed sample: https://github.com/jrey8343/fabrik/actions/runs/42449956659/job/128636834592
- Fabrik source: `src/review/wait.ts`, `src/review/checks.ts`, `src/review/rerun.ts`, `src/review/rerun-main.ts`, `src/loop/review.ts`, `src/loop/flakyChecks.ts`, `src/loop/roundLine.ts`, `src/agent/implement.ts`, `src/agent/inputs.ts`, `src/kit/pushJob.ts`, `src/setup/wizard.sh`, `.github/actions/prepare-agent/action.yml`, `.github/workflows/loop.yml`, `templates/fabrik.yml`, `docs/adr/0002-afk-runs-on-github-hosted-runners.md`, `docs/adr/0018-the-kit-re-runs-red-required-checks-once.md`, `GLOSSARY.md`
