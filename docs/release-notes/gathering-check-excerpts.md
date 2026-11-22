# Release notes: a Failure excerpt names what failed when the red check only gathers other jobs' results

The notes for the patch release that has a red GitHub Actions check's Failure excerpt carry the other failed jobs of its workflow run ([#890](https://github.com/jrey8343/fabrik/issues/890)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

A Failure excerpt now carries the other failed jobs of the red check's workflow run, each with its error annotations. A Required check that only gathers other jobs' results, such as a `gate` job that `needs` the test shards, now names the test that failed, where its excerpt held only the gate's own result.

## What changed

- **The other failed jobs travel with the excerpt.** After the red check's own failed step, log and annotations, its excerpt lists each other job of the same workflow run that failed, under "Other jobs of its workflow run failed too": the job's name, a link to it, its failed step and its error annotations as file, line and message. For a `gate` that failed because `test (1)` did, that is the test file, the test's name and the error.
- **Which jobs.** Every job of the red job's own run attempt that failed or timed out, in the order GitHub lists them. A re-run's jobs are a new attempt's, so each attempt shows its own. A job that passed, was skipped or was cancelled is left out: most often another job stopped a cancelled one, as a matrix's fail-fast does. The Kit doesn't read the workflow file, so it takes every failed job, not only those the red job `needs`.
- **Log lines only where the annotations name no file.** A job whose error annotations name a file shows them and none of its log. One whose annotations name none, as when a test runner writes no annotation and the runner leaves only "Process completed with exit code 1", also shows the end of each failed step's log, cleaned and cut to its last 150 lines as the red check's own is.
- **The cap is shared.** The red checks still share the 40,000 characters of log lines equally. A check's share now goes equally to its jobs that have log lines, its own and the other failed ones, each cut from the top with a line saying how many were left out and linking that job. Annotations stay outside that cap, and the other jobs' are shortened with the rest when a comment or issue would pass GitHub's limit.
- **At most ten.** The first ten other failed jobs are read. Past that, one line says how many more aren't shown and links the workflow run.
- **Shown once.** Where several red checks are listed together, as in a Verdict, a failed job that is itself one of them shows under its own name only. Alone, as in the check's issue, each excerpt shows every other failed job.
- **A check that failed both times** shows the re-run's other failed jobs with the re-run's excerpt, then, after the line on whether the same step failed, the other jobs that failed on the first attempt, by failed step and annotations with no log lines, as the first attempt itself is shown.
- **Everywhere an excerpt goes.** The Verdict, the Reviewer's red checks, a Flaky check's or Unrelated failure's issue and its later comments, and the Monitor's red-main and Main check issues all carry it. The Reviewer's and Triage's prompts each gain a sentence saying that a check which only gathers other jobs' results fails because one of them did, and to read the cause from those jobs.
- **What can't be read says why.** When GitHub refuses the list of the run's jobs, the excerpt keeps the red check's own part and says why under it; a job whose annotations or log can't be read says so under its name. None of it fails the job that read.
- **Why a patch:** it fixes an excerpt that named nothing. The jobs are listed on the Actions: read, and their annotations read on the Checks: read, that each reader of an excerpt already holds, so no job gains a permission and no caller, Kit config field, secret or Fabrik App permission changes. No workflow in a Product repo changes. The read library is unchanged. A Product repo merges the bump PR.

## Not covered

- An unrelated job that failed in the same workflow run shows too, since only the workflow file says which jobs the red job waits on.
- A cancelled job isn't shown, so a check that failed only because another job was cancelled still names only its own job.
- A check that gathers the results of jobs in another workflow run names only its own job: the other run's jobs aren't read.
- A red check from an outside service is unchanged.
- An excerpt already posted isn't rewritten. A Monitor issue keeps its block until its details change, and a check's issue gains the other failed jobs with its next failure.
