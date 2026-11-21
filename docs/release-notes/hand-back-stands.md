# Release notes: A Hand-back on a pull request stands until you give it back

The notes for the minor release that has the Kit leave an agent pull request's branch alone while it carries `ready-for-human` ([#841](https://github.com/jrey8343/fabrik/issues/841), ADR-0036). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

An agent pull request the Kit handed back to you with `ready-for-human` now stays yours until you take the label off: the Kit no longer rebases it, puts it back in draft or starts a conflict-only run on it when `main` moves or a check's fix lands, so its push never races yours.

## What changed

- **The Kit leaves a handed-back pull request's branch alone.** While an open agent pull request carries `ready-for-human`, the Kit makes none of its own moves to bring it up to date with `main`: no plain rebase, even a clean one, no return to draft, no conflict-only run, and no check's fix brought in. This holds on a push to `main`, on the hourly Tick and when a Check's issue closes as completed. It posts nothing when it leaves one alone; the conflict check's reason names the pull request and the label.
- **The label is the whole test.** It doesn't matter who added it, who the pull request is assigned to, or whether a Pairing session is open. Adding `ready-for-human` to any agent pull request by hand keeps the Kit off it too.
- **How you give it back.** Take `ready-for-human` off. A Verdict on the pull request takes it off too, as before, and merging or closing the pull request ends it. The next push to `main` or Tick weighs it like any other: one attempt per `main` head still counts, so a pull request given back at a head the Kit already tried waits for `main` to move. A check's fix that landed meanwhile is brought in by the Tick, if its Check's issue closed in the last 7 days.
- **Your Request changes still runs.** A Request changes from you on a handed-back pull request starts its Request-changes run as before.
- **The notices say so.** The notices for a conflict-only run or a Request-changes run that didn't land, and for a Request-changes run that committed nothing, now say the pull request is yours while it carries `ready-for-human` and that taking the label off gives it back, in place of "the Kit won't try again until `main` moves past" a commit. A draft whose Review couldn't start because it conflicts, and which carries the label, gets the note that hands it to you, in the same words, with no rebase. Every notice's markers are unchanged, so the Standing reads them as before.
- **What you'll notice.** A handed-back pull request no longer heals by itself when `main` moves: resolve it, or take the label off. Pull requests that already carry `ready-for-human` when you upgrade are left alone from then on.
- **Why a minor:** it's new behaviour that needs nothing from a Product repo beyond the bump. No new App permission and no new Kit config field is needed, and the read library is unchanged.
