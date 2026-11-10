# Prototype: the Console's Spend screen

Throwaway. This branch is never merged.

Three structurally different variants of Spend, for the Decision
[Prototype Spend: what the factory has used, reached from Home's factory panel](https://github.com/jrey8343/fabrik/issues/524)
on [Wayfinder: the Console](https://github.com/jrey8343/fabrik/issues/507).

**Chosen: D, which is B's ledger with A's sentence as the title.** The file opens on it. A, B and C are kept as the record of what was judged; C was rejected.

Run it: open `index.html` in a browser, or serve this folder (`python3 -m http.server`) and open it on a phone.
Switch variants with the floating bar, the arrow keys, `#a` / `#b` / `#c` / `#d`, or `?variant=`. The bar's second button changes the scene (Busy, Held, Quiet).

Every repo, issue, pull request and figure in it is invented. Nothing talks to GitHub. The styling is the Digest prototype's (the private Pilot repo, branch `prototype/console-digest`), which starts from the Home prototype's tokens: a back link, a pill and refs, a 20px title, fact chips, panels with a muted header, and no figure set larger than the title.

- **A, Runway:** leads with how long the Subscriptions last. Each one's share of its weekly limit, how far through its own week it is, and when it runs out at this pace. Dollars cover the last 7 days and are reached by drilling down: Product repo, piece of work, runs. No moving between periods, no GitHub Actions minutes.
- **B, Ledger:** leads with one dollar figure for a calendar week, stepped a week at a time. One flat list of work, dearest first; Product repo and outcome are filter chips that carry their own totals; a row opens in place to its runs. The Subscriptions are a line each. GitHub Actions minutes are one fact under the title.
- **C, Trend:** leads with eight weeks as a chart; tap a bar to choose a week. Under it the Weekly summary's figures beside the week before, then breakdowns by Product repo, role and model. Single pieces of work appear only as the dearest three. GitHub Actions runner time has its own panel. The Subscriptions come last.

What a figure rests on, so the variants aren't judged on something the Kit can't know:

- A dollar figure is a Run record's `totalCostUsd`: what the run would have cost at API list prices. Nothing is billed.
- A Subscription's share is the `utilization` the last run that ended on it reported, so it is as old as that run, and it counts everything on the account.
- "Runs out at this pace" is a straight line from the Subscription's reset to now. Nothing in the Kit works that out today.
- GitHub Actions minutes are an estimate from run times; the "included minutes" allowance is invented.
