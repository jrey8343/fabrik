# Release notes: the output block ends an agent's run

The notes for the patch release that stops a finished agent being failed as idle when its process stays open ([#860](https://github.com/jrey8343/fabrik/issues/860)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

An agent whose reply held its output block is no longer failed as a crash ten minutes later because its process stayed open: the block ends the run, and the work is pushed.

## What changed

- **The output block ends the run.** A `claude -p` run that ends a turn with a background command running is woken into another turn, so its stream holds more than one `result`, and its process can stay open after the last. The Kit used to wait for the process, see no output for 600 seconds and fail the run as an Infrastructure failure, with the commits only in the failure report's bundle. Now, once a `result` holds the role's whole output block and 60 seconds pass with no further line, the run is over, and the Kit carries on as it does when the process exits: the init check, the branch bundle, the output contract, the agent result.
  - Only a `result` counts. Assistant text that names or quotes the tag mid-run neither ends the run nor starts the 60 seconds.
  - A `result` with no block isn't the end. A later `result` that holds a block takes an earlier one's place.
  - A run whose process exits by itself is unchanged, with its one retry for a malformed block.
- **The agent's process doesn't outlive its run.** When a run settles, however it ended, the runner writes what it writes, stops the agent's process and whatever it started, and exits. A step no longer waits minutes after its run failed. A notice annotation, "Agent process stopped", says when a run left something running.
- **No scheduled turns.** Every agent, each role's and the judge's, starts with `--disallowedTools ScheduleWakeup,CronCreate,CronDelete,CronList`, in the arguments the metered-billing preflight checks. Background commands stay. If an init message still lists one of these tools, the run goes on with a warning annotation, "Scheduling tools at init", naming them.
- **The prompts say so.** Every role's prompt says the reply holding its output tag ends the run, to write it only once nothing is running or waited on, and never to schedule a wakeup.
- **Whole-run figures.** The step summary and the Run record gave the last `result`'s duration and turns as the run's, such as 38 seconds and 3 turns for a run of about 29 minutes. Turns and API time are now summed over every `result`, and the duration runs from the agent's start to its last `result`, the waits between them included. Cost and model usage still come from the last `result`, which already counted the whole run. A run with one `result` reads as before.
- **Why a patch:** no Kit config field, shim or setup step changes. A Product repo merges the bump PR.

## Not covered

- The 600-second idle limit stands. A command that stays silent longer still fails its run, in the foreground or the background.
- A Run record written before this release keeps the figures it was written with: for a run with several results, the last one's.
- What the Hand-back says about a failed run's kept commits is [#862](https://github.com/jrey8343/fabrik/issues/862).
