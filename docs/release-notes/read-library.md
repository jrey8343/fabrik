# Release notes: The read library

The notes for the minor release that ships the read library ([#592](https://github.com/jrey8343/fabrik/issues/592), ADR-0020): one entry in the Kit's source, `src/read/index.ts`, through which another program reads what the Kit knows by the Kit's own rules, with its own credential, and the Kit job's closing step, which says what each run routed. Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What is new on GitHub

- **The Kit job's last step is named with one line of JSON saying what the Kit routed**, held and declined included: the route, and for the agent run it starts, its role, its Ticket or the issue it is on, its agent pull request, the kind of run (first, Retry, Request changes, conflict-only or Prototype), its Retry number and its model; each run held in place of starting, with its role and number; and a Replay's issue and the Ticket it replays. A declined event reads `"route":"none"` with no run. No text a person or an agent wrote goes into it.
- **It shows on a run's Actions page, under the Kit job**, as that job's last step. The step does nothing, needs no credential and runs only when the routing step succeeded: a Kit job that fails says so by failing, with no line.
- **It changes nothing a run does.** The Kit job's permissions are as they were, so no caller job grants more, and every agent job, push job and comment runs as before.

## What is new for a reader of the Kit

- **The read library, at one entry in the Kit's source**: `src/read/index.ts`, the only address the Kit promises. A reader downloads the Kit's source at the release tag it pins and imports the entry by path. There is no package to install: no module the entry reaches imports an npm package, and it keeps to what a Worker with Node.js compatibility can run. Every read takes the client the reader hands it, so the reader counts what a read costs and refreshes its own credential. See [Reading the Kit from another program](../../README.md#reading-the-kit-from-another-program) for what a reader's toolchain needs.
- **The gather shaped for Home.** For one repo, the release its caller workflow pins, its Operator and its Kit config or that config's errors, even when nothing else could be read, and a repo that doesn't run the Kit says so and is read no further. Then the facts the Standing rule reads and nothing else, at about a tenth of the Weekly summary's cost in GraphQL points, and from them each piece of work's row: its Standing, its title and the Fabrik App's last word on it. Every open Plain pull request is a row with its kind. An agent pull request's row carries the issues that could be rolled in to it, the issues that only mention it, and each Follow-up on its pass, marked filed when a related issue has exactly its title. The store of Run records is gathered too, for the Weekly summary's Standing and a failed Weekly summary run's.
- **The runs read.** The runs in flight in one repo, told exactly from the Kit job's closing step: role, Ticket, pull request, kind of run, Retry number and model, and whether the run is blocked behind its concurrency group, waiting for a runner, running or landing, and a Review waiting on its Required checks before its Review job begins. It also gives when the repo's Tick last started, read from Actions.
- **The Required checks read.** Each of the default branch's own Required checks on the heads asked for, judged as GitHub judges it: passed, running, failing or never reported. And whether the branch holds admins to its rules: yes, no, or unknown when that can't be read.
- **The Spend read.** The store's Run records the reader doesn't already hold, read at the current schema with no transcript fetched, and the time zone the Weekly summary's week is cut in. Beside it, each Subscription's last weekly-limit reading with its age and reset, runner time estimated from run times, and the runway: one answer to how long runs keep going at this pace and how long they are then held.
- **The caller read.** For one pull request that changes the caller workflow, whether that caller would run, in the Kit job's own words, and for a Kit bump the two releases it moves between.
- **The outcomes read**, made on demand for one repo and one week, never in a gather. It says what became of each piece of work a week's Run records name (merged, open, never merged), whether it is a Ticket at all, and every agent pull request merged in the week.
- **What a merged pull request cost**, worked out by one shared function that the Weekly summary now uses too, so a reader's figure and the Monday issue's are the same figure.
- **Two more facts on the rows, and one more read.** A repo's read says whether its Kit config has a `ui` block: yes, no, or unknown when the Kit config is invalid or unread. An open agent pull request's row says whether its Ticket is closed. And one read lists the open issues that can be rolled in by hand to an agent pull request, those that mention it first, then the rest newest first, the kinds never related left out.
- **The two joins.** Rows a reader already holds are settled against a fresh runs read, so work awaiting a run reads Running with no gather, and against a fresh Required checks read, so a Plain pull request's row moves when its last check reports. Each gives what the rule would give from the same facts.
- **The fact builders and the cost functions**, so a reader's fake GitHub serves the Kit's own facts and a dollar figure is worked out once: the sum of records' costs, the week a time falls in, as the Weekly summary cuts its weeks, and the test for a live run.
- **The promise.** The library reads whatever an earlier release wrote: a Run record of any earlier schema, every marker the Loop already reads back, and a run from a release with no closing step. A test holds the name and a value of everything the entry exports.

## What changed in Setup

- **The wizard guesses the Fabrik App only from comments and issues a bot wrote.** A comment the Operator made through another GitHub App of theirs is the Operator's own and counts for nothing, so the wizard no longer offers that App as "likely the Fabrik App". Everything else about the guess, and every line of the wizard's wording, is as it was.

## Why a minor

It adds behaviour, so not a patch. It adds no Kit config field, changes no caller or shim, asks for no new secret and no new permission for the Fabrik App, and leaves the Run-record schema as it was. The Kit job gains a step, which asks no caller job for more. If the release that ships this is a higher kind for another Spec's sake, this part needs nothing beyond the bump.

## Upgrading

- **A Product repo merges the bump**, as for any minor, and does nothing else. From then on, each run's Kit job ends with its closing step.
- **The store needs nothing.** Its Run records, its caller and its schema are as they were.
- **A run on an earlier release has no closing step and is still read**, by its job's name, as the Kit told runs in flight before: not exactly, and one that names no number counts for all work awaiting its role.

## From now on

- **A release that removes or changes anything the read library exports is a major**, whatever it asks of a Product repo, as the [releasing guide](../releasing.md#choosing-the-version) now says. A new export, a new field or a new Standing name is not.

## What does not change

- What the Loop does. The Loop never reads the library, and runs the same whether or not anything reads it.
- Every comment, label and mention the Kit makes: no push is added or taken away, and the Kit writes nothing for a reader's sake.
- The Weekly summary. Its cost per merged pull request now comes from the shared function and reads as before. Its runs in flight are now read from the closing step too, so on a Product repo past the bump a run counts only for the work it names; work that an unrelated run of the same role stood in for before can now be listed under Stuck.
- What the Fabrik App may do. A reader reads with its own credential.
