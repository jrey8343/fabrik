# Release notes: Run records and the Weekly summary

The notes for the minor release that ships Run records and the Weekly summary ([#145](https://github.com/jrey8343/fabrik/issues/145)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- Each agent run's push job writes a Run record, and the run's gzipped transcript, to `jrey8343/fabrik-runs`, the private store every Product repo shares (ADR-0009). It runs after the Loop, whatever happened to it, and never fails the push job.
- Each Monday at 07:00 in the Operator's time zone, a workflow in `fabrik-runs` files one Weekly summary issue covering every Product repo: cost, Human touches, cycle time, Operator wait and revert rate beside last week's, and what's Waiting on you or Stuck. It mentions the Operator once and closes last week's. A week with no runs and nothing waiting or stuck files nothing.
- No shim changes and no Kit config fields, so a Product repo only merges the bump PR. Until `fabrik-runs` exists, the Loop runs as before, and each push job's step summary has one line saying no Run record was written.

## To turn it on

The store is set up once, for every Product repo.

1. **Create `fabrik-runs`** by re-running `/fabrik-setup` at this release in one Product repo, the Pilot. It asks your time zone. Its plan creates `jrey8343/fabrik-runs` as a private repo, writes its Weekly summary caller workflow and Dependabot entry there, and stores a read-only `Fabrik App` vault service account as its `FABRIK_OP_PUSH_TOKEN` secret.
2. **Walk the wizard's new stage**, "Install the Fabrik App on jrey8343/fabrik-runs". Records start landing once the App is installed there.
3. **Turn it on for the Pilot first.** Merge this release's bump PR in the Pilot only, and check there:
   - an agent run of each role (Triage, Design, Implement, Review) leaves its record under `runs/` and its transcript under `transcripts/` in `fabrik-runs`,
   - a run cancelled by its `timeout-minutes` still has its transcript, or its record says `"transcript": null`,
   - the transcript sizes of a few runs, noted on [#175](https://github.com/jrey8343/fabrik/issues/175), to set the store's growth budget toward the about 1 GB threshold,
   - running Fabrik weekly summary by hand from the Actions tab of `fabrik-runs` files one issue that mentions you once.
4. Once the Pilot is healthy, merge the bump PR in the other Product repos. They need no setup of their own: re-running `/fabrik-setup` there with the same time zone changes nothing in `fabrik-runs`.
