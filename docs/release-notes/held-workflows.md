# Release notes: Held workflows and the Start check

These are the notes for the Held workflows part of the major that carries the Kit's Operator sessions ([Spec: Held workflows and the Start check](https://github.com/jrey8343/fabrik/issues/917)): a Product repo lists in Kit config each workflow whose start is the Operator's word that production takes a change, a Held workflow, whose first job reads a Start check only the Console's App can make; the read library gives the Start check's name and how long it holds; and Setup's report lists each workflow a session can start that holds a role. Its four other parts ship in the same major: [Spec: The Console check: `console.app_id`, Setup's part, and the Kit's read leaving it out](https://github.com/jrey8343/fabrik/issues/914), [Spec: The Kit's tokens in the `fabrik` environment, which only the default branch may use](https://github.com/jrey8343/fabrik/issues/915), [Spec: Release tags and Setup's bootstrap: `setup.sh` fetched at the release it runs, and the releasing guide that reads the tag hold before it uses it](https://github.com/jrey8343/fabrik/issues/916) and [Spec: The Operator session: the Kit's skills and facts reach a cloud session, and the session reports itself on its issue](https://github.com/jrey8343/fabrik/issues/918). Each part has its own notes. Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

This draft holds the part of each of the Spec's five Tickets before it: `console.held_workflows` in Kit config ([#939](https://github.com/jrey8343/fabrik/issues/939)), the Start check's name and its 15 minutes in the read library ([#940](https://github.com/jrey8343/fabrik/issues/940)), Setup's line ([#941](https://github.com/jrey8343/fabrik/issues/941)), the README's shapes ([#942](https://github.com/jrey8343/fabrik/issues/942)), and the Glossary and ADR-0038 ([#943](https://github.com/jrey8343/fabrik/issues/943)).

## What changes with no action

- **Setup's report gains a line for each workflow a session can start that holds a role** ([#941](https://github.com/jrey8343/fabrik/issues/941)), in Setup's report, which Setup says in the terminal and never in the setup PR. On every run it lists each workflow on the default branch, as the checkout Setup runs in holds it, that can be started by `workflow_dispatch` and has a job that asks for `id-token: write` or names an environment, except the Kit's own caller workflow, `fabrik.yml`, by name: its file's name, what its jobs ask for with the environments they name, and whether `console.held_workflows` lists it, one line to a workflow, in the order of the files' names. A job asks for `id-token: write` by its own `permissions:`, or by the workflow's where it has none, `write-all` included. Setup reads a workflow's triggers, permissions and environments, never a step. It blocks nothing and changes nothing: no line changes a step or a note of the plan, and Setup changes none of the repo's workflows.

For a repo whose Kit config lists `promote.yml` and not `deploy.yml`, both of which can be dispatched and name the `production` environment, the lines are:

```text
`deploy.yml` can be started by dispatch, and a job of it asks for id-token: write and names the environment `production`. Kit config doesn't list it in console.held_workflows, so a session can start it with no tap of yours: if only you may start it, make it a Held workflow (README, "Held workflows").
`promote.yml` can be started by dispatch, and a job of it names the environment `production`. Kit config lists it in console.held_workflows, so the Console offers a tap for it.
```

Where the Kit config is invalid, Setup still gives every line, and each ends `Kit config is invalid, so setup can't say whether console.held_workflows lists it.`

Nothing else changes in a repo that lists no Held workflow.

## What is new in Kit config

- **`console.held_workflows`** ([#939](https://github.com/jrey8343/fabrik/issues/939)), the repo's Held workflows, each by its workflow file's name, as `production.workflow` names one, in the `console` block beside `console.app_id`. It is `[]` by default, where the key or the block is left out, so a repo with neither reads exactly as before.
- **It is valid only beside `console.app_id`,** since a Held workflow's step reads its Start check by that App's id. The key without it, an empty list included, is refused with `console.held_workflows is valid only beside console.app_id: a Held workflow reads its Start check by that App's id`, unless `app_id` is there and refused, which is named on its own.
- **What else is refused.** A value that isn't a list of strings is refused with `console.held_workflows must be a list of strings`. Each name is checked as `production.workflow` is, and refused by its place in the list where it is blank, more than one line, a path, such as `console.held_workflows[1] is ".github/workflows/promote.yml": a workflow is named by its file's name alone, such as deploy.yml, not by a path`, or not a `.yml` or `.yaml` file's name. A name listed twice is refused, naming the earlier entry that already lists it, such as `console.held_workflows[2] is "promote.yml", which console.held_workflows[0] already lists`. Names are compared as written, since GitHub's workflow file names are case-sensitive.
- **Nothing checks a listed file.** Nothing in the Kit makes a repo list one, or checks that a listed file exists, can be dispatched or reads its check. No Loop rule, job or prompt reads the key: Setup does, and a reader of the Kit. Kit config is a Trust-root file, so no agent can change the list.

## For a reader of the read library

- **New exports** ([#940](https://github.com/jrey8343/fabrik/issues/940)). `startCheckName`, which gives a Held workflow's Start check its name for a workflow file, `Start promote.yml from the Console` for `promote.yml`, and `START_CHECK_MINUTES`, 15, how old a Start check may be, from its `completed_at` to the job's own clock, when a Held workflow's first job reads it, through the read library's entry, `src/read/index.ts`, under a heading of their own. A reader that makes a Start check makes it under the name `startCheckName` gives, the one a Held workflow's step reads, and says how long a tap holds by `START_CHECK_MINUTES`.
- **`KitConfig.console.heldWorkflows`** ([#939](https://github.com/jrey8343/fabrik/issues/939)). `resolveKitConfig` gives a Kit config's `console.held_workflows` as `console.heldWorkflows`, beside `console.appId`, and `[]` where it is left out, as it is wherever `console.appId` is null. `DEFAULT_KIT_CONFIG` has `console: { appId: null, heldWorkflows: [], sessionEnvironment: null }`. A reader finds a repo's Held workflows in the `KitConfig` the gather already hands back, with no read of its own, and one that builds a `KitConfig` itself fills `console.heldWorkflows`.
- **Nothing the entry exported is removed or changes meaning.** None of the Kit's reads changes: a Start check is under a name no Kit config list holds, so the Required checks read, the Main checks read and the Review's wait never meet it.

## What it never does

- **The Kit makes, reads and waits on no Start check.** The Console's App makes one, at the Operator's tap, and a Held workflow's own first job reads it. Nothing in the Kit's code names one but the read library's entry and `src/kit/startCheck.ts`, which gives its name and its 15 minutes.
- **It ships no action and no template for the step.** Each Product repo writes its own, to the shape the README's [Held workflows](../../README.md#held-workflows) gives ([#942](https://github.com/jrey8343/fabrik/issues/942)), beside the Glossary's Held workflow and Start check and ADR-0038's word on the Operator's tap ([#943](https://github.com/jrey8343/fabrik/issues/943)).
- **It dispatches nothing, and gives the Fabrik App no new permission.** No shim, label, Loop rule or Trust-root guard changes.

## To turn it on

For each workflow a repo makes a Held workflow, the Operator's steps, in that repo, the Pilot first. A Held workflow needs the Console's tap, which the Console's own release brings: with no Start check, its first job fails and the job that takes the role is skipped, so make a workflow a Held workflow only once the Console offers the tap for that repo.

1. **Add the step to the workflow,** as the README's [Held workflows](../../README.md#held-workflows) has it, with the Console's App's id written in the workflow file beside the check's name: the same id `console.app_id` holds, never read from Kit config when the workflow runs.
2. **List it in `console.held_workflows`, beside `console.app_id`,** in the same pull request.
3. **Merge that pull request.**
4. **Delete the workflow's runs from before the step, or wait the 30 days out,** before an Operator session works on the repo. A re-run uses the workflow file of the run's own commit, so a run from before the step re-runs without it ([Runs from before the step](../../README.md#runs-from-before-the-step)).

For a deploy on every merge, add the step that refuses any commit but the head instead ([A deploy on every merge](../../README.md#a-deploy-on-every-merge)), and list nothing.

## Why a minor on its own, in a major

By the releasing guide's [Choosing the version](../releasing.md#choosing-the-version), this part alone would be a minor: a new Kit config key with an empty default, two new exports and a new kind of line in Setup's report, none of them a major, since a new field and a new export are not. It removes nothing the read library exports and changes what none of it means, and no shim, label or permission changes. It ships in the one major that carries the Kit's five Operator sessions Specs ([How are the Specs cut, and who builds them?](https://github.com/jrey8343/fabrik/issues/874)), so a Product repo takes it with that major's Setup run and needs nothing more for it. The major is the other parts'.

## What the Console needs

- **Its pin moved, and its own part built from its Spec before any repo lists a Held workflow:** a tap for each workflow `console.heldWorkflows` lists, which makes the Start check under the name `startCheckName` gives on the default branch's head and starts nothing, with its App's Checks write, and says how long the tap holds by `START_CHECK_MINUTES`. That part is [Write the Console's Spec and cut it into slices](https://github.com/jrey8343/fabrik/issues/913). This line is a guess until the release is checked against the Console (step 4 of [releasing.md](../releasing.md)), and that run's answer replaces it.

## What it does not cover

- **A Product repo's own workflow change:** the step in each Held workflow, the step in a deploy on every merge, the list in its Kit config, and its runs from before the step deleted. Each is that repo's own issue.
- **A way past the Start check while the Console is down,** other than the Merge gate's by-hand way past, used to merge the step out ([Merge gate](../../README.md#merge-gate)).
- **GitHub's required reviewers, wait timers and custom protection rules,** which are for public repos only on the Operator's plan.
