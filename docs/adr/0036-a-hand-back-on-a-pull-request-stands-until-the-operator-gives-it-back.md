# A Hand-back on a pull request stands until the Operator gives it back

This refines ADR-0011, ADR-0016, ADR-0028 and ADR-0031, which stay as written apart from what follows. When a conflict-only run or a Request-changes run doesn't land, or a Request-changes run commits nothing on a head that didn't move, the Kit hands the pull request to the Operator: its notice says the work is theirs, and it adds `ready-for-human`. Until now the next conflict check took the pull request back anyway. At the next new `main` head, or when a Check's issue closed as completed, the Kit rebased its branch, or put it back in draft and started a conflict-only run, while the Operator might be resolving the same conflict on the same branch.

A Hand-back on a pull request now stands while the pull request carries `ready-for-human`, and while it stands the Kit leaves the branch alone:

- **What stops.** For an open agent pull request carrying `ready-for-human`, the Kit makes none of its own bring-up-to-date moves: no plain rebase, even a clean one, no return to draft, no conflict-only run, and no bringing in of a check's fix to a pull request only behind `main`. This holds on a push to `main`, on the hourly Tick (its catch-up of closed Check's issues included), and when a Check's issue closes as completed. The Kit posts no comment when it leaves such a pull request alone. The reason the conflict check gives names the pull request and the label.
- **The label is the whole test.** The rule reads the pull request's labels and nothing else: not who added the label, not its assignees, not whether a Pairing session is open. So an Operator who adds `ready-for-human` to an agent pull request by hand keeps the Kit off it too.
- **How it ends.** The Operator takes `ready-for-human` off, a Verdict lands on the pull request (which already takes the label off), or the pull request is merged or closed. Nothing else ends it: no clock, no move of `main`, and not the pull request merging cleanly again.
- **After it is given back.** The pull request is weighed like any other at the next conflict check. ADR-0011's one attempt per `main` head still counts, so a pull request given back at a head the Kit already tried waits for `main` to move, and one given back after `main` moved is tried at the next check. A check's fix that landed on `main` while the Hand-back stood is brought in by the Tick once the label is off. No event fires when the label comes off.
- **What still runs.** The Operator's own Request changes on such a pull request starts its Request-changes run as before, whether GitHub delivered the review or the undelivered-review recovery found it. That is the Operator asking for a run, not the Kit moving unasked.
- **The notices say so.** Each notice that puts `ready-for-human` on a pull request says the pull request is the Operator's while it carries the label, that the Kit leaves its branch alone until then, and that taking the label off gives it back. None promises anything by a `main` sha. Their markers and hidden hand-back lines are unchanged, so the Standing reads them as the same Hand-backs.

`ready-for-human` on the pull request is the whole test because it is the one signal the Kit itself sets at the moment its notice says the work is the Operator's, and the one the Standing already reads (#609).

We chose this because the Kit's rebase and the Operator's each end in a force-push to one branch, so the two raced, and whichever landed second was refused or overwrote the first. The pull request also flipped to draft under the Operator, and a Step-up run was spent on a conflict the Operator was already resolving ([#841](https://github.com/jrey8343/fabrik/issues/841)). The notice's "until `main` moves past" a sha also gave the Operator less time than a real conflict takes on a Product whose `main` moves every half hour, and was untrue whenever `main` had already moved by the time it was written.

## Considered options

- **Read the pull request's assignment.** The Kit reads no pull request assignees, and the Operator may start work without assigning themselves.
- **A marker a Pairing session sets.** It would cover only an Operator who opened one.
- **Let the Hand-back end by itself**, on a clock, on a move of `main`, or when the pull request merges cleanly again. Each brings back a moment where the Kit pushes to a branch the Operator may be working on.

## Consequences

- A handed-back pull request no longer heals by itself when `main` moves. It costs the Operator one move: resolve it, or take the label off.
- A handed-back pull request a red check holds at the Merge gate stays red after the check's fix lands, until the Operator takes the label off. The Tick reads only the Check's issues closed in the last 7 days, so a label left on longer than that leaves the fix for the Operator to bring in.
- The label doubles as the Operator's way to keep the Kit off any agent pull request at the Merge gate, which #304 left as an open question.
- A conflicted draft whose Review stopped waiting (ADR-0028) and carries the label gets the note that hands it to the Operator, not a rebase.

Decided in [The Kit hands a conflicting pull request back as ready-for-human, then starts a conflict-only run on it while the Operator is resolving it](https://github.com/jrey8343/fabrik/issues/841).
