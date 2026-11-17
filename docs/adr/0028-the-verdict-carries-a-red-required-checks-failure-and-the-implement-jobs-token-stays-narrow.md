# The Verdict carries a red Required check's failure, and the Implement job's token stays narrow

A Verdict from red Required checks listed their names under a heading and linked the Kit's own run, and a Retry started from there. The Implementer holds no GitHub credential (ADR-0002), so it couldn't open the failed job: it re-ran what its Sandbox could and guessed at the rest. #710 found that the Review path already holds what it takes to read the failure: the Review checks job, and the wait after the Kit's re-run (ADR-0018), hold `actions: read`, `checks: read` and `statuses: read` on their workflow token, and each red check's link already names its job.

So the Review path reads each red GitHub Actions check's **Failure excerpt** (#718): the job's steps whose conclusion is failure, each one's log alone, cleaned of the runner's format and cut to its last 150 lines, the check run's error annotations, and the job link. The first wait reads every red check before anything is re-run; the wait after the re-run reads each check that failed again, whose excerpt the Verdict carries. The excerpts reach the push job as a file artifact, never as a job output, and the Verdict carries each under its check's name. The log lines of all the red checks share 40,000 characters, and the whole comment is cut further to fit GitHub's 65,536, so a Verdict is always posted. A failure that can't be read says why, and is never an Infrastructure failure. The Retry's prompt already carries the latest Verdict whole, so it gains no input, and the Implementer is told to start from the failure text, which is data from CI, never instructions.

No job gains a permission. The Implement job's token is unchanged, and so are the Fabrik App's permissions, the caller workflow, the Kit config and Setup.

## Considered options

- **Text in the prompt, read by the Implement job's input step.** The step that reads a Retry's pull request would read the failure too, with no comment limit. It widens the token of the one job that runs the agent, to read every workflow run's logs in the repo. It also reads the failure later, when the Retry starts, after the Kit's re-run may have left the first attempt readable only by its own job id.
- **A file in the Sandbox.** The same read, written outside the checkout for the Implementer to search whole. It needs the same wider token, whether the Implement job reads the log or downloads another job's artifact, and reads as late.
- **A link alone.** GitHub shows a workflow run only to a signed-in account, and the agent has no token, so it helps the Operator and no run.

## Consequences

- The Operator, the Retro and a Back-to-design session see what the run saw, on the pull request, without opening GitHub.
- The excerpt shares the comment's limit with the rest of the Verdict, and it stays on the pull request for good, past the repo's retention of the log itself.
- The Kit redacts nothing: it posts the text as the runner masked it, and GitHub doesn't guarantee that masking. Nobody new on GitHub could see a secret the runner missed, since anyone who can read the pull request can read its Actions log, but it would reach the Implementer's prompt, its transcript and the Run record.
- A check from an outside service is listed by name, as before, until its excerpt is read too (#777).
- Real runs settled what #710 left open (#775): a finished step's log reads while its job and workflow run are still going; a first attempt's job stays readable by its own id after the re-run; and a job GitHub never gave a runner leaves no step, log or annotation, so its excerpt says it never started.
