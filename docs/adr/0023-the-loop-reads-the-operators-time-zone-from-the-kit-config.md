# The Loop reads the Operator's time zone from the Kit config

Every time the Kit shows the Operator is written in the Operator's time zone, one for all their Product repos, or in UTC when they've given none. Before this, only the Weekly summary used it, reading the zone from the fabrik-runs store's caller workflow, where the store's `schedule:` needs it anyway. Every other time was in UTC, so the Operator read two clocks for the same reset: "resets 2026-11-07 08:20 Australia/Sydney" in the Weekly summary, and "resets at 2026-11-06 21:20 UTC" on the weekly-limit issue.

- **Two homes for one fact.** The Loop reads `time_zone` from the Kit config, which it already loads on every run. The jobs that run on the store, the Weekly summary and the daily Tick check, keep reading the store caller's `timezone:`. A Product repo and the store can so name different zones, and Setup keeps them in step.
- **Setup writes both.** Its one question, "Your time zone, or no to leave fabrik-runs out", writes the answer to the store's caller, as it always has, and to the Kit config's `time_zone`, setting or adding that one member and keeping every other byte. "No" leaves both out. The Operator can still set `time_zone` by hand.
- **Setup's offer brings a drifted repo back in step.** It offers the store caller's zone first, then this repo's `time_zone`, then the machine's. A repo whose `time_zone` differs from the store's is offered the store's, so pressing Enter on the next Setup run puts it back in step.
- **A bad zone never stops the Loop.** A `time_zone` that isn't an IANA zone the runtime knows fails no Kit config check. The Loop writes its times in UTC and says so in one step-summary line naming the value. One that's unset, `null` or left out, is UTC with no line.
- **Only the times shown change.** `audit.day` and `retro.day` stay UTC days, the gates are still due from 00:00 UTC on their day, `weeklyGate`'s ISO week stays in UTC, and the skills bump tick stays Monday's 04:00 UTC hour. So "The Retro is due from 2026-11-14 00:00 UTC" becomes "… due from 2026-11-14 11:00 Australia/Sydney".

## Considered options

- **Every Loop job reads the store's caller.** Most jobs would need a store token minted and a read made, and it does nothing for a Product repo with no store.
- **A repo or org Actions variable.** A personal account has no org-level Actions variables, the setting would be hidden from the Operator, and Setup would need permission to write variables.

## Consequences

- A repo set up before this has no `time_zone`, so it shows UTC until Setup runs there again; there's no migration.
- A repo and the store can drift, as when the Operator edits one by hand. Each surface then uses its own home's zone until Setup runs again.
- The skills bump runs after the Tick job, whose Kit config read gives it the zone, though it still runs when the Tick fails, in UTC.

Decided in [Show every time the Kit writes in the Operator's time zone, read from the Kit config](https://github.com/jrey8343/fabrik/issues/503), split from #481.
