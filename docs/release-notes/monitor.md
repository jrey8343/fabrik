# Release notes: the Monitor

The notes for the minor release that ships the Monitor ([#148](https://github.com/jrey8343/fabrik/issues/148)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- The scheduled tick runs the **Monitor** every hour, in a job of its own. It's plain Kit code: it reads GitHub and Sentry through their APIs, never checks out or runs Product code, makes no model call and writes no Run record. It runs while the weekly-limit issue is open, and a Sentry outage or a failed Monitor can't stop the tick.
- **Red main**, on by default once the Fabrik App has Checks: read. While the default branch's newest decided commit is red, the Monitor keeps one `fabrik:monitor` issue open with the red commit and its failed checks, and closes it itself with a "green at `<sha>`" note once main is green. That note is the only comment it ever makes. A red-main issue the Operator closes stays closed until main is seen green. `monitor.red_main: false` turns it off.
- **Production errors**, off until `monitor.errors` names a Sentry org and project. Each unresolved `error` group with at least `min_events` events in 24 hours (default 3), and each `fatal` group, gets one `fabrik:monitor` issue. While the issue is open, the Monitor rewrites its stats block in place. A group that comes back after its issue was closed as completed gets a new issue, "Regressed from #n". A group whose issue was closed as not planned or as a duplicate, or labelled `wontfix`, is never filed again. The body quotes only Sentry's title, culprit, counts, release and in-app frames (file, line and function), fenced as untrusted data. It never includes request data, breadcrumbs, user context, tags or variables.
- At most `caps.monitor_issues` error issues (default 5, which a repo can lower but never raise) are open at once. The rest are held, `fatal` first and then by users affected. The newest open error issue's stats block and the Weekly summary's **Held** section show how many are held. `0` pauses new error filings. The red-main issue never counts toward the cap.
- Monitor issues are silent. They carry no state label, so Intake gives them `needs-triage` and Triage sorts them like any bug report.
- Each source the Monitor can't read yet is a quiet note in the tick's step summary, never a failed run. That covers Checks: read not yet accepted, `monitor.errors` set but the Sentry token missing or rejected, and Sentry unreachable.
- The Kit config gains a `monitor` block (`monitor.errors`, default `null`, and `monitor.red_main`, default `true`) and `caps.monitor_issues`. `/fabrik-setup` creates the `fabrik:monitor` label. Its wizard asks for the Fabrik App's Checks: read and has a skippable stage that stores the Sentry token in the `Fabrik App` vault, where the existing push service account reads it.
- **Why a minor:** a new App permission or secret is a major in [releasing.md](../releasing.md) only when the Loop can't run without it. Here both are opt-in ([#139](https://github.com/jrey8343/fabrik/issues/139)): until they're done, the Monitor quietly does less. There are no shim changes, since the Monitor job asks for no permission the caller's `tick` job doesn't grant. No Kit config field is renamed or removed, and every new field has a default. So a Product repo only merges the bump PR.

## To turn it on

Each source has its own step. Until a step is done, the Monitor job runs green every hour and leaves only that source's dormant note in its step summary.

1. **First, check Sentry's plan.** Sentry's pricing lists the free Developer plan as "API: No". Confirm whether a Developer-plan org issues a token with `event:read` that the issues API accepts. If it doesn't, either move to Team (about $26 a month), or use GlitchTip through `monitor.errors.url`. Check that GlitchTip's issues API answers the Monitor's calls before relying on it.
2. **Turn on red main for the Pilot first.** Merge this release's bump PR in the Pilot only. Re-run `/fabrik-setup` at this release there: its plan creates the `fabrik:monitor` label, and its wizard's first stage walks through adding Checks (read) to the Fabrik App's permissions. Accept the App's request for Checks: read on the installation (GitHub asks the account owner, at `https://github.com/settings/installations`), which turns on red main.
   - **The Pilot's caveat:** red main needs at least one gating check that runs on pushes to the default branch. The Pilot's `sandbox.checks` is `["build"]`, and `build` runs only on PRs. Until the Pilot's CI also runs `build` on pushes to main, red main has no decided commit there and files nothing. Its step summary says so each hour.
   - Then check:
     - each hourly tick's run has a green Monitor job, and its step summary has a Monitor section;
     - once `build` runs on push, a red commit on main files one red-main issue, which Intake gives `needs-triage`;
     - the next green commit closes that issue with the "green at" note.
3. **Turn on production errors for the Pilot only at its own Cutover**, so the Monitor files nothing into the Pilot's backlog before it's ready. At Cutover:
   - Store the Sentry token through the wizard's Sentry stage. It needs `event:read` and `project:read`; an organization token (`sntrys_…`) isn't enough. The wizard saves it as `op://Fabrik App/Sentry token/credential`. It's one token for every Product repo, so this happens once.
   - Set `monitor.errors` in the Pilot's `.fabrik/config.json` and merge it to the default branch: `{ "provider": "sentry", "org": "<org slug>", "project": "<project slug>" }`. Add `url` for another Sentry region or GlitchTip.
   - Check that a qualifying Sentry group is filed as one `fabrik:monitor` issue that goes to `needs-triage`, and that the next tick rewrites its stats block without filing it again.
4. **Then the other Product repos**, once the Pilot is healthy. In each, merge the bump PR, re-run `/fabrik-setup` and accept Checks: read if GitHub asks again; that turns on red main. A repo that reports to Sentry sets its own `monitor.errors`, only at that repo's own Cutover. The token is already stored.
