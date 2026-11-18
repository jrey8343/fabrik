# A Required check still red after the re-run goes to the Reviewer, which judges its cause

ADR-0018 re-ran red GitHub Actions checks once on the same head and, for anything still red, landed an Execution flaw with no Review: every such check was the pull request's own, and its Verdict spent one of the Ticket's two Retries. In the week of 9 Nov, seven of the eight checks that failed again were not the pull request's (#719): a lint that ran out of memory, tests in files the pull request never touched, a different test failing on each attempt. Each cost a Retry, and the third Execution flaw sends a Ticket back to design.

So a head still red after everything the Kit could do goes to the Reviewer (#779), which judges the code as on any Review and **judges each red check beside it** as `caused` by the pull request or `unrelated` to it, an **Unrelated failure** (GLOSSARY.md), with a one-line reason, in a `red-checks:` block the Kit reads (#780). It is given each check's attempts, its Failure excerpt (ADR-0029) and the same check's result on the default branch's head: passed, failed with its link, still running, or not run there.

- **Positive evidence, or caused.** The Reviewer calls a check unrelated only on positive evidence: the same check red on `main`, a failure in code the change can't reach, two attempts failing on different things, or a failure from the runner or a service rather than the code. A failing test in a file the change didn't touch is evidence to weigh, never enough alone. Without such evidence the check is caused, and the reason says the Reviewer couldn't tell, and why. A red check the block leaves out, misnames or judges in an item that doesn't read is caused, with the reason "the Reviewer gave no judgment".
- **What lands.** A `design-flaw` is a Design flaw, whatever the checks. With at least one caused check, anything else, a `pass` included, is an Execution flaw that counts: a Retry, or Back to design when none is left. With every check unrelated, the Reviewer's line lands as on green: an `execution-flaw` calls for a Touch-up or a Retry by its findings' tags, and a `pass` is a pass.
- **An Unrelated failure never counts.** The marker records the caused checks in `checks`, as ADR-0018's count-back reads them, and the Unrelated failures in `unrelated`, which count toward nothing. The Verdict tells the run fixing it to leave them alone.
- **A pass that names one goes to the Merge gate**, as any pass does, and GitHub holds the merge until the check is green on that head (ADR-0019). The Kit never takes the check off the Required list, skips it or merges past it.
- **Each head is judged afresh.** No earlier judgment binds a later Review, and the Kit acts on nothing a `fix` comment says about a check.

This supersedes ADR-0018's "Anything still red: the Execution flaw lands as before". The rest of ADR-0018 stands.

## Considered options

- **Kit-code signals as rules.** The Kit could match the failing tests against the files the pull request changed, or compare the check with `main`, and decide by rule. As rules they misjudge the week's checks: matching tests to changed files would have cleared gradually-core #375, the one check the pull request did cause, a typecheck error in a test stub it never touched; e2e journeys don't map to files; and `main` has no `e2e` result to compare against. They are given to the Reviewer as evidence instead.
- **The Retry judging.** The Implementer could say in its `fix` that a check isn't its own. That's the Implementer clearing its own work, so the Kit reads nothing a `fix` says about a check.

## Consequences

- The positive-evidence rule and the default to caused keep a doubtful check the pull request's own, as it was under ADR-0018.
- An Unrelated failure never counts toward the Ticket's Retries, and never calls for a Retry or a Touch-up by itself.
- A pass that names an Unrelated failure goes to the Merge gate, which holds it until the check is green: it counts in Gate load, and as a pass for Yield.
- A Review now runs on every red head, which costs a Review where none ran before.
- A red head's Verdict is the Reviewer's, so it settles code like any other, and the pull request's next Review is a later Review.
- The Reviewer can be wrong. A check called unrelated that the pull request did cause still holds the pull request at the Merge gate, since GitHub merges nothing while it is red; a Review miss of that kind is worth a Retro line.
