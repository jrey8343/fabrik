# The Kit resolves an agent pull request's conflict with main, once per main head

This refines ADR-0006. When a push to `main` leaves an open agent pull request at the Merge gate conflicting with `main`, the Kit brings it up to date itself instead of waiting for the Operator to ask. First it tries a plain rebase of the pull request's branch onto `main`, with no agent. If that's clean, it pushes with a lease, and the push starts a full Review of the combined head. If it conflicts, the Kit starts one conflict-only run: an Implementer run on the Step-up model, on the pull request's branch, told to rebase onto `origin/main`, resolve the conflicts and change nothing else. Neither uses a retry, and the Verdict on a conflict-only run's push doesn't count toward the Ticket's two Retries. While a conflict-only run is in flight it counts as in flight under ADR-0006's rule, so no other head gets a Verdict until it lands. A pull request that's only behind `main`, a draft, or one with a Retry or Request-changes run in flight is left alone. A push to `main` and the hourly tick both run the check, so a pull request whose mergeable state GitHub hadn't worked out yet, or a repo whose caller workflow predates the push trigger, is caught within the hour.

Each pull request gets one attempt per `main` head, recorded as a marker comment on the pull request carrying that head. If the conflict-only run fails, changes nothing, doesn't bring `main` in, or the trust-root guard refuses it, the Kit says why on the pull request, adds `ready-for-human` and brings it back out of draft, and doesn't try again until `main` moves. Unlike a refused Retry, a refused conflict-only run never closes the pull request.

A conflict-only run rebases; it doesn't merge. A plain rebase is what the Kit tries first, and the conflict-only run finishes that same rebase, so the history reads the same whichever one brought the pull request up to date. "Merge, never rebase" still holds for Retries: a Retry that needs work from `main` merges it in, so its earlier commits stay as they were.

The loop is bounded. Only the Operator merges to `main`, through the Merge gate, and neither the rebase nor the conflict-only run ever changes `main`, only the pull request's own branch. So nothing the Kit does here can move `main` and start another round, and each `main` head gets at most one attempt per pull request.

We chose this because a pull request that passed Review and then conflicted after another merge sat at the Merge gate until the Operator noticed and asked for a rebase in a Request changes. That is mechanical work, and Request changes is the Operator's way to amend the Ticket (ADR-0010), not to keep a branch current.

## Considered options

- **Rebase every open agent pull request after every merge, conflicting or not.** This keeps every pull request current. But it would push, and start a Review, on every pull request after every merge, for no change to what the Operator merges.
- **Let a conflict-only run merge `main` in, as a Retry does.** This keeps the earlier commits as they were. But a plain rebase is tried first, and a merge here would leave pull requests brought up to date one of two ways depending on whether the rebase happened to conflict.
- **Treat a conflict-only run as a Retry.** It would then use one of the Ticket's two Retries for a conflict the Implementer didn't cause, and could send a sound Ticket back to design.

## Consequences

- The caller workflow's `push` trigger fires on every push to the default branch, not only on Kit config changes. Each Product repo has to update its own `.github/workflows/fabrik.yml` from the template to get it, because the App has no `workflows` permission. Until then, the hourly tick catches conflicts.
- The trust-root guard (ADR-0005) judges a conflict-only run's rewritten commits as its own. A conflict resolved inside a trust-root file, which only an Operator commit on the pull request could have touched, is refused and handed to the Operator.
- The Reviewer's prompt says a rebase onto `main` is expected on a pull request the Kit brought up to date, so it doesn't flag one.
