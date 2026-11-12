# Release notes: The Digest

The notes for the release that ships the Digest ([#594](https://github.com/jrey8343/fabrik/issues/594), ADR-0022): the Kit's plain-English account of an agent pull request as it stands at one head, which a role of its own, the Digest writer, writes each time the pull request arrives at the Merge gate at a new head. Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- **Every agent pull request gets a Digest before it reaches the Operator.** A Digest is an account of the pull request the Operator can decide from without reading its thread. It is a comment of its own, posted by the Fabrik App, written as of one head and never edited. The Digest writer writes it, never the Reviewer, so its first item can be that a pass was wrong. Kit code counts everything that can be counted and lays the comment out; the writer words it, and judges one thing: whether each thing the Operator asked for is in the head.
  - **The top has four sections**, in plain English with no code:
    - **Needs your eyes**: at most four items, or "Nothing." First anything the Operator asked for that is not in the head, then what only the Operator can judge, then what was not proven. Each item ends with links to the lines it is about, which the Digest points at and never quotes.
    - **What it does**: what changes for the End user.
    - **How it got here**: the rounds as counts, ending with whether the product code changed since the first Verdict.
    - **Follow-ups**: the Follow-ups the pull request's passes named, each with its "Open as issue" link, or "None named."
  - **Four folds sit under it**, each closed until opened:
    - **Walk me through it**: how the change works, and the order to read it in.
    - **Decided without you, and left alone**: what the Implementer decided that the Ticket did not settle, and what it left alone.
    - **The rounds**: Kit code's table of every round, with who, what and each Verdict's effect on the code.
    - **The criteria and how each was checked**: Kit code's table of every Request changes of the Operator's, each of its line comments and each of the Ticket's criteria, with whether it is in the head, how that was checked and where the writer looked.
- **The Merge gate opens a little later.** A pass no longer takes the pull request out of draft and requests the Operator's review at once. It adds `agent:digest`, the Digest writer runs, and when that attempt ends the Digest is posted, the pull request leaves draft and the review is requested. The Operator is told once, when the account is there.
  - **On the Actions tab** the run shows as "PR #<number> labeled agent:digest", since the caller workflow is unchanged, and its job is named "Digest PR #<number>".
  - **The wait**: in the trial a Digest took 20 to 75 seconds to write. Through the Kit there are two more jobs around it, the Kit job before and the push job after. The draft holds its `max_in_flight` slot meanwhile.
- **The Loop never waits on a Digest's success.** It waits for the attempt, which has 10 minutes by default. A run that fails, one that runs past its time limit and a reply Kit code refuses each open the gate all the same, under one comment that mentions nobody: "No Digest could be written for this head", the short head and how, which is `failed`, `timed-out`, or `refused` with Kit code's reason.
  - **Kit code refuses** a reply that leaves an ask of the Operator's unanswered, one whose items do not cover every ask missing from the head, and one whose top runs over 180 words. It also refuses one that breaks the reply's shape, one that names a Follow-up Kit code did not list, and a Digest too long for one comment.
  - **A wrong file or line refuses nothing.** That one link is dropped and the Digest lands.
- **A Digest run is never held** and never counts against a Ticket's Retries.
  - **With Subscription rotation on and every Subscription used up**, where any other run would be a Held run, the gate opens at once and the line says `no-subscription`.
  - **With no run started**, the gate opens at a Tick once the label has waited 30 minutes, and the line says `never-started`. The label is not added again and nothing is handed to the Operator. The usual cause is `main` moving just after the pass: GitHub starts no workflow for a pull request that conflicts with its base.
