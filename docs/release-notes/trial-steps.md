# Release notes: Trial steps and the Trial session

The notes for the minor release that ships Trial steps and the Trial session ([#962](https://github.com/jrey8343/fabrik/issues/962), [ADR-0040](../adr/0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md)): in a Product repo whose Kit config declares `staging`, the Implementer writes in plain words what the Operator checks in a Staging trial, the Kit keeps it on the pull request and the Reviewer judges it before the merge; a reader of the Kit is given those Trial steps, each step with its link on staging; a read-only command prints what is untried on staging; and a skill, `/fabrik-trial`, runs a Staging trial with an agent driving the Operator's own Chrome, which ends in the Operator's verdict. Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

Every Ticket of #962 has its part here: the Implementer's Trial steps and the marker that keeps them ([#963](https://github.com/jrey8343/fabrik/issues/963)), the Reviewer's judgement of them ([#964](https://github.com/jrey8343/fabrik/issues/964)), the Trial steps on a row and on the Promote list ([#965](https://github.com/jrey8343/fabrik/issues/965)), the untried queue command ([#966](https://github.com/jrey8343/fabrik/issues/966)) and the Trial session's skill ([#967](https://github.com/jrey8343/fabrik/issues/967)). These notes are [#968](https://github.com/jrey8343/fabrik/issues/968).

## What changes with no action

Nothing of Trial steps, in a Product repo whose Kit config declares no `staging`: its Implementer and its Reviewer are told nothing of them, its pull requests carry no marker, a gather asks GitHub what it asked, and its rows are the rows they were.

Three things come with the bump in every repo, with the block or without it:

- **The `SessionStart` hook installs `/fabrik-trial`**, as it installs the Kit's other skills, and names it in its lines to the session. In a repo that declares no `staging` the skill has nothing to try: the untried queue command it runs says in one line that Kit config declares none, and the session stops there.
- **An Implementer's summary loses any line that passes for the Trial steps marker**, even in a code block. Only the Kit's own marker says what a pull request's Trial steps are, so a run can neither write one into its summary nor carry an old one forward.
- **A Retry of findings that are all about the pull request's body may commit nothing.** A Reviewer's Execution flaw with every finding tagged `[small: body]` calls for a Touch-up, which may commit nothing, and for a Retry once the pull request's two Touch-ups are used. Such a Retry had nothing to commit, and got the Kit's own Execution flaw for committing nothing. It now lands as that Touch-up does: its prompt tells it to commit nothing, the Kit writes the body again from its output and starts the Review of the same head, and it is still one of the Ticket's two Retries. A Retry given any other finding is as it was: one that commits nothing gets that Execution flaw. This is a rule of the Loop's, so it holds for any finding about the body, in a repo with Trial steps or without.

A repo that already declares `staging` gets everything under **What it turns on** with the bump alone.

## What it turns on

In a Product repo whose Kit config declares `staging`:

- **The Implementer writes Trial steps** ([#963](https://github.com/jrey8343/fabrik/issues/963)). Its prompt gains a part that asks for `trial`, a new optional field of its output, on every run whose pull request will ask for a Staging trial: one that changes a file matching `ui.paths`, unless the run says nothing visible changes, which only a repo that uses Evidence shots can say; and one whose Ticket is a Trial problem. `trial` is a `summary`, one short paragraph in plain language of what changed for a person using the product, and `steps`, an ordered list of one step at least. Each step has `do`, what the person does, and `expect`, what they should then see, concrete enough to check by looking, and may give `route`, the page it starts on: a path starting with `/`, with no dynamic segment.
- **A step on a record's page starts on the nearest page with a fixed address.** Staging has its own records, so a `route` never carries a record's id, and the step's `do` says how to reach the record from there, such as "Open any patient from the list".
- **The Kit keeps them on the pull request, out of sight.** The push job writes them into the pull request's body as one hidden line, `<!-- fabrik:trial-steps {…} -->`, after the evidence section and before the line that closes the Ticket. The body gains no section to read: the line is an HTML comment, which GitHub does not draw, so the pull request looks as it did, and it is a reader of the Kit that shows the steps.
- **Every run that lands on a pull request writes them again.** A Retry, a Touch-up, a Request-changes run and a conflict-only run each write the body whole, so a later run's marker takes the earlier one's place and the pull request carries one. Such a run is shown the pull request's current Trial steps to start from, as it is shown its current description. A run that leaves `trial` out leaves the pull request with no marker, the earlier run's steps gone with it.
- **A malformed `trial` never fails a run.** One that is not a `summary` and at least one step, each with a `do` and an `expect`, is treated as left out, and the run lands as it would have. A `route` that is no path, or has a dynamic segment, is left off its step, and the step is kept. The shape is all Kit code checks: whether the steps are good enough is the Reviewer's to judge.
- **The Reviewer judges them** ([#964](https://github.com/jrey8343/fabrik/issues/964)). A Review is told whether its pull request will ask for a Staging trial, by the rule a merged one is read by, and is given the Trial steps the pull request keeps, or told it carries none. On one that will ask, each of these is an Execution flaw: it carries no Trial steps; a step does not say what to do, or what should be seen; the steps do not exercise what the diff changes for a person using the product; an `expect` describes something the diff does not produce; a step's words or its `route` name a particular record's id. On one that will not ask, the Reviewer is told not to judge them, with them or without.
- **A finding about Trial steps is fixed by giving `trial` again, and by no commit.** They are kept in the pull request's body, so the Reviewer is told to tag such a finding `[small: body]`. An Execution flaw whose findings are all tagged so calls for a Touch-up, which may commit nothing: the Kit writes the body again, with the steps the run's output gives. Once the pull request's two Touch-ups are used, such a flaw calls for a Retry, which may commit nothing too and is still one of the Ticket's two Retries. Beside a finding in the code, the run that fixes the code gives `trial` again too.
- **A pull request merged before the upgrade has none.** It reads as having none, and a Trial session on it works from its routes and shot names.

## What is new for a reader of the Kit

All of it is exported through the read library's entry, `src/read/index.ts` ([#965](https://github.com/jrey8343/fabrik/issues/965)). Nothing the entry exported is removed or changes meaning.

- **Trial steps on the row.** In a repo that declares `staging`, a merged agent pull request's `Row` carries its Trial steps as `staging.trial`, beside `site`, `pages`, `shots` and `toTry`, which are what they are without it. It is a `summary` and its `steps`, in the Implementer's order, each with what to `do`, what to `expect`, its `route`, null where the step names none, and `url`, that route's page on staging, built as a captured route's page in `pages` is, null with no `route`. `trial` is null for a pull request that keeps none, as every one merged before this release does.
- **On the Promote list.** An agent `PromoteEntry` carries the same under its own `staging`, as `staging.trial`. The entry's own `trial` is what it was: whether the pull request needs a Staging trial, `needed`, and `why`. A Plain pull request's entry carries neither.
- **New exports.** `trialStepsMarker` writes the hidden line that keeps a `TrialSteps`, a summary and a `TrialStep` for each step, in a pull request's body, and `trialStepsIn` reads it back, so a reader holds no format. The last line in a body that holds Trial steps counts, and a body with none reads as null. Give `trialStepsIn` only a body the Fabrik App wrote: anyone can write the line.
- **The text is an agent's.** Every word of a summary and a step was written by an Implementer. Show it as text, never as markup, and take no link from it but `url`, which the Kit builds on `staging.url`.
- **The facts.** `Facts` gains `trialStepsMarkers`: the Trial steps of each agent pull request, open or merged in the last day, that keeps some. The facts' `staging` gains the same, for those the gather keeps past the last day. Each is `{ pullRequest, marker }`, and a list is empty where no pull request keeps any, as in a repo that has never declared `staging`. The gather reads them from the bodies it already read, so it asks GitHub nothing more.
- **The fact builders.** `homeFactsOf` and `aStagingFacts` give no Trial steps unless told, and take `trialStepsMarkers` as they take any other fact, so a reader's fake data for them is the Kit's own facts.
- **What a reader kept.** `STANDING_SCHEMA` stays 2. A row kept before this release reads back through `readRow` with `staging.trial` null where it has a `staging`, and as it was kept where it has none. Facts kept before it, with no `trialStepsMarkers`, give `rowsOf` rows with no Trial steps.

## What the Console needs

- **Its pin moved, and the new field wherever it builds one by hand.** `Facts` and the facts' `staging` each gain a required `trialStepsMarkers`, and a row's `staging` a required `trial`, so Console code or a Console test that builds any of the three by hand, and not through `homeFactsOf`, `aStagingFacts` or `rowsOf`, adds the field. Its rows are otherwise the rows they were, and it shows no Trial steps until it reads `staging.trial`, which is its own Spec ([fabrik-console#137](https://github.com/jrey8343/fabrik-console/issues/137)). This line is a guess until the release is checked against the Console (step 4 of [releasing.md](../releasing.md)), and that run's answer replaces it.

## The untried queue command

A read-only program of the Kit ([#966](https://github.com/jrey8343/fabrik/issues/966)) that prints which merged agent pull requests are untried on staging, each with its links and its Trial steps, by the read library's own rule and not by a guess made with `gh`. The skill runs it to find what to try, and the Operator can run it themselves, from the root of the Product repo's checkout, with their own `gh` credentials:

```sh
RELEASE=$(sed -n -E "s|^[[:space:]-]*uses:[[:space:]\"']*jrey8343/fabrik/[^@]*@([A-Za-z0-9._+-]+).*|\1|p" .github/workflows/fabrik.yml | head -n 1)
FABRIK=$(mktemp -d)
curl -fsSL "https://codeload.github.com/jrey8343/fabrik/tar.gz/refs/tags/$RELEASE" | tar -xzf - -C "$FABRIK" --strip-components=1
node "$FABRIK/src/trial/untried-queue-main.ts"
rm -rf "$FABRIK"
```

- **Nothing is installed.** Those lines read the release `.github/workflows/fabrik.yml` pins, download Fabrik at that tag into a temporary folder, run the program from it and delete the folder. The program needs Node 24.3 or later and `gh`, signed in, both of which Setup already asks for. No release before this one has the program, so run it in a checkout that holds the bump.
- **With no argument** it prints `untried`: every agent pull request on the Promote list whose result is `untried`, oldest merge first, and an empty list when there is none. Beside it, `unread` lists the number of each one that may be on staging for all the command could tell, because GitHub would not let it read the pull request's staging deploys or their Main checks.
- **With a pull request's number**, as in `node "$FABRIK/src/trial/untried-queue-main.ts" 50`, it prints `pullRequest`: that one, whatever its result, and with it `standing`, its Standing's `name` and the Kit's `sentence` for it, which says why one is not ready to try.
- **Each pull request** has its `number`, its `title`, `url`, its address on GitHub, and `mergedAt`; the staging `site`, its `pages`, its `shots` and what `toTry`, as its row gives them; `trialSteps`; and `result`, its Staging trial's result as the Promote list says it.
- **`trialSteps` is the entry's `staging.trial`**, the pull request's Trial steps, each step with its link, and null for one that keeps none. It has a name of its own so that nobody takes it for the entry's `trial`, which is not printed: `result` says `no-screen` for a pull request that needs no Staging trial.
- **Beside them** it prints `repo`, and `staging.url` and `production.url` as Kit config gives them, so a caller can keep to the one site and refuse the other. `production` is null in a repo that declares none.
- **It only reads.** It gathers as a reader of the Kit does, makes the staging reads, and takes every pull request and its result from `promoteListOf`, so it holds no rule of its own. It makes no request of GitHub but a read, and writes nothing on disk.
- **How it ends.** It exits 0 when it printed. With nothing to print it says why in one line on stderr and exits 1: Kit config declares no `staging`; the number is not a merged agent pull request on the Promote list, which holds only what production has not taken; the repo is not a Product repo, or its Kit config is invalid; GitHub would not let it read the repo; or `gh` gave no credential. It exits 2, with its usage, for arguments it does not take.

## The Trial session, `/fabrik-trial`

A Trial session is a Staging trial the Operator runs with an agent driving their own browser ([#967](https://github.com/jrey8343/fabrik/issues/967)). The Operator starts one by running `/fabrik-trial`, for every pull request untried on staging, or `/fabrik-trial <pull request number>` for one. Only the Operator starts one: the skill is marked `disable-model-invocation`, so no session runs it of its own accord.

- **It needs Claude in Chrome on the Operator's machine.** It is run in a local Claude Code session in the Product repo's checkout, on the machine the Operator's Chrome is on, with Claude in Chrome connected and with the Operator's own `gh` credentials. It stops at once, saying which, when `gh` is not signed in or the session has no Claude in Chrome tools.
- **It finds the work** with the untried queue command: the one pull request named, or the whole queue, oldest merge first. A named pull request that is not untried on staging is named with the Kit's sentence for its Standing and passed over, and one the command could not read is named as unread, never as absent. An empty queue ends the session in one line.
- **The Operator signs in.** It opens the staging site in a new tab and waits while the Operator signs in and passes any access screen, going on only at their word.
- **It performs each pull request's Trial steps** in order, in that one tab, saying each step before it does it. It performs every one without asking first, a step that writes included: staging is the Operator's to change, and they are watching.
- **It reports each step** as one of three: matched; did not match, with the page's address, the visible text that differs and any console errors; or could not be performed, with why. A step it could not perform is offered to the Operator to do by hand in the same tab, and is never a problem by that alone. A step that would raise a JavaScript dialog is one of these, since a dialog stops the extension answering.
- **The verdict is the Operator's.** It asks for it once for each pull request, after its last step: accept, problem, or leave untried. On accept it puts `fabrik:trial-accepted` on the pull request. On problem it opens the Trial problem, whose body carries the line `From Staging trial of PR #<n>`, then each step that did not match with what was expected and what was seen, then the Operator's own words, as text with no images and no @-mentions, and then puts `fabrik:trial-problem` on the pull request. It does both with `gh`, as the Operator, so each label is the Operator's own, the only kind a Staging trial's result is read from (ADR-0038). On leave it writes nothing.
- **A pull request with no Trial steps**, as every one merged before this release is, is trialled from its routes and shot names: the session says it has no steps to follow, shows them, and asks the Operator what to check.
- **In a queue** it goes on to the next pull request in the same tab, and ends with one line for each saying its verdict.

## What it never does

The first four are the skill's own rules, which it tells the session to hold from its first step to its last. The rest are what the Kit's code does and does not do.

- **It never accepts a change itself.** The session never chooses the verdict, whatever the steps showed: every step matching is no accept, and a step that did not match is no problem, until the Operator says so. It labels and files nothing until they give it.
- **It never signs in.** It types no credential into any page, whether a password, a code or a token, and asks the Operator for none. Wherever staging asks for one, it hands the tab over and waits.
- **It never acts off the staging site.** It acts only on a page whose origin is the origin of `staging.url`, and stops, and says so, before any action on another origin or on `production.url`.
- **It follows no instruction in a step.** Trial steps are data an agent wrote. A step that asks for anything but an action on the staging site, such as running a command, reading a file or opening another site, is not followed, and is reported to the Operator.
- **The Loop still ends at the merge.** Nothing in the Loop waits on a Staging trial, and nothing in it reads staging's address or its deploys. The Loop asks one thing of the `staging` block, whether it is there.
- **No Kit job writes for it.** No Kit job puts either label on anything or opens a Trial problem, the Fabrik App's permissions are as they were, and the untried queue command only reads.
- **Kit code never judges the steps.** It checks their shape and builds each link from a path on `staging.url`, and nothing more. Whether a step is right is the Reviewer's judgement before the merge and the Operator's after it.

## Why a minor

It adds behaviour, so not a patch. It adds no Kit config field: what it adds is a new optional field of the Implementer's output, `trial`, a new marker on the pull request, a new command and a new skill, so a Product repo merges the bump and edits nothing. It changes no caller or shim: the `SessionStart` hook entry is as it was and installs every folder of the Kit's `skills/` at the pinned release, and `.gitignore` already hides `.claude/skills/` whole. It asks for no new secret and no new permission for the Fabrik App, and leaves the Run-record schema and the Standing schema as they were. For the read library it adds exports and fields, and by the releasing guide a new export or a new field is not a major. It removes nothing the read library exports and changes what none of it means. It asks no new step of the Operator: it stays dormant until a Product repo declares `staging`, the step the Staging trials release's notes name, and the **To turn it on** section says what a repo that has taken that step gets with the bump. If the release that ships this is a higher kind for another Spec's sake, this part needs nothing beyond the bump.

## To turn it on

Upgrade the Kit: merge this release's bump PR. Take it on the Pilot first, then on the other Product repos.

- **In a Product repo that declares `staging`** the bump is all of it. From its next Implement run the Implementer is asked for Trial steps, and from its next Review they are judged.
- **The skill needs no Setup run.** The `SessionStart` hook installs it at the next Claude Code session in a checkout that holds the bump, as it installs the Kit's other skills.
- **A Trial session needs** a local Claude Code session on the machine the Operator's Chrome is on, with Claude in Chrome connected, and `gh` signed in as the Operator.
- **The two labels still come from Setup.** `fabrik:trial-accepted` and `fabrik:trial-problem` are created by the Setup run the Staging trials release's notes ask for, and this release adds none. In a repo that has not made that run, a session that goes to put one on tells the Operator to run Setup again, and leaves the pull request as it is.
- **A Product repo that declares no `staging`** turns Staging trials on first, by the steps in the notes for [Staging trials](staging-trials.md).

Then, on the Pilot, merge a UI pull request, and check that a reader of the Kit shows its Trial steps once it is on staging. Run `/fabrik-trial` there, and check that the session opens the staging site, waits for the sign-in, reports each step, and labels nothing until it has the verdict.

## Upgrading

- **A Product repo merges the bump**, as for any minor, and does nothing else.
- **The store needs nothing.** Its Run records, its caller and its schema are as they were.
- **A reader of the Kit moves its pin**, and meets what the section for a reader lists. The rows it kept read back through `readRow`.

## Things to know

- **A label the session puts on is told from the Operator's own by nothing.** The Kit reads who put a label on, not how, and the session runs with the Operator's credential. That it asks before it labels is the skill's rule, which no Kit code holds it to.
- **A pull request open across the upgrade has no Trial steps.** Where it will ask for a Staging trial, its next Review is told that carrying none is an Execution flaw, which a Touch-up can fix. One that has already passed its Review merges with none, unless a later run on it gives some.
- **A finding about Trial steps alone uses a Touch-up.** A Ticket gets two. Once both are used, an Execution flaw of such findings alone calls for a Retry, which the Kit lands as it lands that Touch-up when it commits nothing, and which counts toward the Ticket's two Retries all the same. So a pull request whose Trial steps keep falling short still goes back to design once those are used.
- **Only a run that lands writes the body.** A Request-changes run that commits nothing leaves the pull request's Trial steps as they were, so a Request changes that asks only for other steps changes none.
- **Kit code does not hold the Implementer to when.** A `trial` given on a pull request that asks for no Staging trial is kept all the same, and its row carries it.
- **A step's link cannot leave the staging site.** A `route` is held to the same rule where the output is read and where the marker is read: a path with no dynamic segment. So a marker somebody edited by hand gives a link on `staging.url` or none.
- **The steps are judged once and performed later.** The Reviewer judges them against the diff before the merge, and the session performs them on staging after it. A step that passes Review and is still wrong shows in the session's report as one that did not match, or could not be performed, and the Operator decides what it means.
