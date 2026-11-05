---
name: efficiency
version: 1
threshold: 0.7
labels: [clean, repeated-calls, re-reads, dead-end-loop, sandbox-fight]
---

How directly the run got from its Ticket to its result: whether its tool calls moved the work forward, or were spent on calls that repeat, re-read or lead nowhere.

Judge the run's transcript only: what it did, in what order, and what each tool call gave back. Never judge the code it wrote; the Reviewer's Verdict does that. A long run is not an inefficient one, since a big Ticket needs many calls, and a short one is not efficient just for being short. Count only the calls that bought the run nothing.

What counts against the run:

- The same tool call, or one that does the same thing, made again when nothing that could change its result happened in between.
- A file read again when the run had already read it and nothing had changed it since.
- One approach tried again and again after it failed, with no new information each time, or kept up for many turns after it stopped paying.
- Turns spent fighting the Sandbox: a command its permissions, network or tooling refuses, run again unchanged; a permission denial tried again as it was; a long workaround for a missing tool.

What doesn't count against it: running the tests again after a change, reading a file again after editing it, looking around the code before the first change, and API retries, which come from the model provider, not the run.

How to score:

- 1: every tool call moved the work forward, or nearly every one did.
- 0.7: a few wasted calls that cost the run little.
- 0.4: waste a reader notices at once, such as a loop over several turns or many repeated reads.
- 0: most of the run went on waste, or it stalled in a loop it never left.

The label names the run's biggest waste:

- `clean`: no waste worth naming.
- `repeated-calls`: tool calls repeated when nothing had changed in between.
- `re-reads`: files read again that the run had already read and not changed.
- `dead-end-loop`: a failing approach tried over and over, or held onto long after it stopped paying.
- `sandbox-fight`: turns spent fighting the Sandbox's permissions, network or tooling.
