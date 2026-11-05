# Run records live in a central private repo, written only by the push job

Every AFK agent run gets one Run record, plus its gzipped stream-json transcript, in one private GitHub repo shared by all Product repos (`jrey8343/fabrik-runs`). Only the push job writes there, with a second Fabrik App token scoped to that repo and to Contents write. Records are append-only: the push job writes only what it knows when the run ends (the stream's `init`, `result` and last `rate_limit_event`, and what `FABRIK_NEEDS` and the agent result say). Later facts such as merges, reverts and Human touches are never written back. They are read live from GitHub when metrics are computed. Records and transcripts are kept forever, and each record carries a schema version and the Kit sha that wrote it.

We chose this because Scorers, Replay, the Retro and the weekly summary all need records that outlive the 90-day Actions retention and span several Product repos, and gradually-core is the second. A git repo costs nothing at this volume, needs no new vendor or secret, and can be read with `gh`, `git` and `jq`. Writing from the push job keeps ADR-0002's rule that the job running Product code never holds a write credential.

## Considered options

- **An orphan branch in each Product repo.** It needs no new App install. But it shows up in each repo's branch list, it can start Product CI on push, and it splits records across repos that cross-repo metrics need together.
- **Actions artifacts.** They are already the hand-off from agent job to push job. But they are per run, deleted after at most 400 days, and readable only through the Actions API.
- **Cloudflare R2 or S3.** These scale past a git repo, but each needs a new account and a new credential. Deferred until transcripts approach about 1 GB.
- **An OpenTelemetry backend.** Free tiers keep about 14 days, content is cut off at 60 KB, and the ingest token would sit in the agent job.

## Consequences

- The Fabrik App must be installed on `fabrik-runs` with Contents write. `fabrik-runs` must be at least as private as the most private Product repo, because a transcript can hold whatever the agent echoed.
- Parallel push jobs write one file per run and retry on conflict, so they never edit the same file.
- A Pairing session writes no record. It runs locally, has no push job, and counts as a Human touch instead.
- A run killed by its timeout still gets a record, with no result fields and, if the upload didn't survive, no transcript.

## Addendum: the Weekly summary is filed from `fabrik-runs`

The Weekly summary is one issue per week covering every Product repo, filed in `fabrik-runs` by a scheduled workflow there. Its App token therefore also gets Issues write on `fabrik-runs` and read access to the Product repos it summarises. The push job's token stays Contents-write only, and nothing in a Product repo's agent job gains a credential. Decided in [Operator inbox and weekly summary](https://github.com/jrey8343/fabrik/issues/84).
