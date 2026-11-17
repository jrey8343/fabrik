# Release notes: Architectural escapes counted once each

The notes for the minor release that counts Architectural escapes once each over each repo's window ([#737](https://github.com/jrey8343/fabrik/issues/737), part of [#734](https://github.com/jrey8343/fabrik/issues/734)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- The Weekly summary's **Architectural escape rate (90 days)**, the share of merged agent PRs some escape named, becomes **Architectural escapes (90 days)**: the escapes filed, each counted once however many merged agent PRs it names, with what stands behind the count, such as `3, from 4 Audits over 68 merged agent PRs, 2 candidates undecided`, then last week's and the signed change in the count. A week with no Audit in any repo's window reads `no Audits yet`.
- Each repo's window is the trailing 90 days, starting no earlier than 30 days before its first Audit, so a new repo's count grows into the window instead of counting work no Audit read. The Weekly summary finds the first Audit with one more read per repo, its oldest `fabrik:audit` issues, oldest first. Audits count only once landed, filled or clean, never pending or failed.
- Undecided candidates are those on an open Audit whose card traces to a merged agent PR, less the issues the Operator filed from it with an escape marker. Only this week's cell names them: an Audit's facts say whether it's open now, not when it closed, so last week's cell leaves them out rather than guess.
- Each repo's **Architectural escapes this week** names, for each PR an escape traces to, the Ticket it built and its last passing Review run, no longer "the Review run that missed it".
- **The Auditor's prompt changes** (`prompts/audit.md`, "Tracing a candidate"): it names in `introducedBy` only the merged agent PRs that introduced the structure or grew it into the problem, never one that only extended structure older than itself, such as one more caller of a shallow module already there. A candidate whose problem predates every agent PR gets an empty `introducedBy`, so it is filed with no escape marker and isn't an Architectural escape.
- The Glossary's **Architectural escape** says it is counted once.
- No Run-record change, no shim change, no new App permission and no Kit config fields.

## Upgrading

**Bump the store's pin** in `fabrik-runs` to this release, with the Pilot, for the Weekly summary's new count. The Auditor's prompt reaches each Product repo with its own bump PR, and only Audits opened from then on trace their candidates the new way, so escapes filed from older Audits may still name a PR that only extended an older structure.
