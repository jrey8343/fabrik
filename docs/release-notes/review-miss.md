# Release notes: Review misses

The notes for the release that tells a Review miss from a requirements change among Request changes ([#369](https://github.com/jrey8343/fabrik/issues/369)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- A Request-changes run's output owes two new required fields about the review it was started for, and only that one: `reviewMiss` (with `reviewMissPoints` naming each point when it's `true`) and `amendsTicket`. Output without them breaks the Implementer's contract, on the agent side and in the push job, as any other missing required field does. Retries and conflict-only runs are unchanged.
- The Kit records the answers on the PR: a `<!-- fabrik:request-changes-answers {"review":…,"reviewMiss":…,"amendsTicket":…} -->` line right under the run's push note's marker, or under its empty-diff Verdict's marker, plus the readable lines "Review miss: yes, <point>" or "Review miss: no", and "Amends the Ticket: yes" or "no".
- The Weekly summary's Metrics table gains three rows, week over week, counting the Operator's Request changes by when each was submitted: **Request changes with a Review miss**, **Request changes amending the Ticket** and **Request changes unanswered**. Each repo gains a **Review misses this week** list, left out in a week with none.
- Each Request changes item in the Retro's evidence gains `reviewMiss` and `amendsTicket`, `null` when unanswered. The streak rule is unchanged: any Request changes still breaks a loosening's streak.
- The facts the Weekly summary and the Retro read now fetch each review's id and URL and each comment's URL.
- Request changes from before this release, such as the Pilot's #59 and #60, count as unanswered. Nothing is back-filled, and no Run record field changes.
- No shim changes and no Kit config fields.

## To check it on the Pilot

1. Request changes on a passed agent PR, asking only for a rebase. Check that the run's push note holds the answers marker for that review and reads "Review miss: no" and "Amends the Ticket: no".
2. On the next Monday's Weekly summary, check the three Request changes rows, and that a Review miss, if any, is listed with working links.
