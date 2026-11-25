---
name: fabrik-pair
description: Run a Pairing session on a ready-for-human issue, working through its steps with the Operator and recording on the issue what was done, at the Operator's terminal or in a cloud session. Run as /fabrik-pair <issue number>.
disable-model-invocation: true
---

# Pairing session

The Operator is working through issue `$ARGUMENTS` with you. It's `ready-for-human`, or the Kit's own weekly-limit issue (see **The weekly-limit issue** below), because only the Operator can do it, or an agent that counts as the Operator: a secret, a repo setting, a third-party dashboard, a Trust-root file edit. It may have come from Triage, from the Kit itself (a token rotation), from a Ticket an Implementer refused, or as an Operator step from a Design session. Your job is to work each step with the Operator, check it, and leave the issue as the record: its task list ticked as the work happens, and one comment, kept current, saying what was done.

You run in one of two places, and the SessionStart hook's context says which: at the Operator's terminal, or in a Claude Code cloud session, where this is an Operator session. **First, read `.claude/skills/fabrik-operator-session/SKILL.md`.** It holds the rules this skill shares with every Operator session. In a cloud session all of it holds, and at the terminal its **Everywhere** section does. This skill keeps no copy of them.

You count as the Operator, so you may change Trust-root files, which agents elsewhere never touch.

- **At the terminal** you run with the Operator's own GitHub credentials and write to the issue with `gh` (see `docs/agents/issue-tracker.md`). If `gh auth status` fails, stop and tell the Operator before doing anything else.
- **In a cloud session** every tracker operation goes over REST, by the forms in `fabrik-operator-session`. Before any work, make its checks in its order: the Session environment, your connectors, and the first read of the issue.
- **Wherever you run,** if your context holds no line from Fabrik's SessionStart hook, as in a session opened on several repos, you are in a wrong environment: say so as your first words, and do no work until the Operator says to go on or starts again.

Every comment and body edit you write names where a secret lives (the 1Password item, the GitHub secret's name) and never its value, and contains no @-mentions.

## 1. Check the issue

Read the issue and its whole thread, and `GLOSSARY.md` and `docs/adr/` if they exist, and use the repo's terms. In a cloud session that first read is your check that you can reach the repo.

If the issue isn't open, or isn't labelled `ready-for-human`, tell the Operator which and stop: it isn't Operator work waiting to be done. The one exception is an issue labelled `fabrik:weekly-limit`, which you take open or closed while its last step is unticked. If it's assigned to nobody, assign it to the Operator.

In a cloud session, once these checks pass and before any work, write your marker comment as `fabrik-operator-session` says, unless the issue already holds one with your own address. That comment is your record from here on.

**Done when:** the issue is open, `ready-for-human`, and assigned, and in a cloud session it holds your marker.

## 2. Settle the task list and sort it

The issue body's GitHub task list (`- [ ]` lines) is the plan and the record.

- **The body has one:** that's the plan. Steps already ticked (`- [x]`) are done; you resume at the first unticked one.
- **The body has none:** draft one from what the issue and its thread say to do, one `- [ ]` line per action, in the order they must happen. Show it to the Operator and agree it with them. Then write it into the body under a `## Steps` heading, below the original text, which stays as it is.

In a cloud session, read `.fabrik/operator-session.md` as the default branch has it, then sort every unticked step as `fabrik-operator-session` says: done by you, done by the Operator's hands with you guiding, or left for a laptop. At the terminal there is no sort, since the Operator is at the laptop.

**Done when:** the body holds the agreed task list, and you've told the Operator the step you start at, and in a cloud session the sort.

## 3. Work through the steps

Take the unticked steps in order. For each:

1. **Guide it.** At the terminal, for one or two simple steps, talk the Operator through them yourself. When the remaining steps involve a third-party dashboard, credentials, or several commands to run in order, build a wizard for them with `.claude/skills/wizard/SKILL.md`, saved in a temp folder (`mktemp -d`) outside the repo so it's never committed, and hand it to the Operator to run in their own terminal. In a cloud session build no wizard: walk the steps in the conversation one at a time, each checked before the next, and for a step the Operator's hands do, say what it takes (which apps, roughly how many moves), so they choose to do it now or leave it.
2. **Change files through a pull request.** A step that changes repo files, Trust-root files included, is made on the branch `fabrik/pair-<n>`, cut from the default branch, pushed at once, and goes out as one pull request, opened at once. Every such step goes in that same pull request: if an earlier sitting already opened one from that branch, push to it instead. Its body says `Closes #<n>` only when its merge is the last thing left on the issue, and otherwise names the issue with no closing keyword. The default branch only changes by its merge, and you never merge it.
3. **Check it.** Confirm the step with a command wherever one can see the result: the repo's list of secrets for a GitHub secret, a read of the setting for a repo setting, `op item get` for a 1Password item at the terminal, reading the file for a file change, reading the pull request for one opened. Where nothing can check it, ask the Operator to confirm it in their own words, take their answer as the check, and say so in your record.
4. **Tick it** in the body the moment it's confirmed: rewrite that step's `- [ ]` as `- [x]`, leaving every other line as it is. A file-change step is confirmed once its pull request is open. Then bring your record up to date.

When the next step is left for a laptop or waits on something, skip ahead only as `fabrik-operator-session` says. When a step waits on a merge, a deploy or a run, say what it waits on, bring the record up to date, and stop: never poll.

- **A merge.** A step that is the merge of another pull request is the Operator's, from the Console, in a cloud session and on any repo whose `.fabrik/config.json` holds `console.app_id`. Read the key from the checkout, and never learn it from a refusal. Anywhere else, at the terminal, you merge it on the Operator's word. Every road to a merge is the same act: `gh`, REST, and the GitHub MCP server's `merge_pull_request` and `enable_pr_auto_merge`.
- **A Held workflow.** A workflow the repo's Kit config lists in `console.held_workflows` is started only after the Operator's tap in the Console, at the terminal too: ask for the tap, naming the workflow, then start the run and follow it. Never start one before the tap, and never retry one that was refused.

**Done when:** every step is ticked, or the Operator stops.

## The weekly-limit issue

The Kit opens this issue, labelled `fabrik:weekly-limit` instead of `ready-for-human`, when an agent run hits a Subscription's weekly usage limit. What it asks depends on how many Subscriptions the repo's Kit config lists in `subscriptions`, and its task list says which.

- **One Subscription, so rotation is off.** Until the limit resets every agent run in the repo stalls, so take this issue before any other. Its two steps go in this order.
  1. **Wait for the reset.** The body's `<!-- fabrik:resets-at <time> -->` line says when the limit resets. Tick the step once `date -u` is past that time. If it isn't yet, tell the Operator when it resets and stop partway (see **4. Finish**), saying to run `/fabrik-pair <n>` again after the reset. With no `resets-at` line, the Operator confirms agent runs work again.
  2. **Restart the stalled Tickets**, only once the reset is ticked: a Ticket restarted before then just stalls again. The stalled runs are the `#<r>` the body and the Kit's comments on this issue name (`The Implement run on #<r> ...`): each `<r>` is the number the run's failure comment is on, the Ticket's PR when it has one open, else the Ticket. That failure comment names the trigger label to re-add and where it goes, `this PR`, `this issue`, or another number such as `the Ticket (#<t>)`. Re-add it there, check the label is back, and tick the step once every stalled Ticket has its label back.
- **Two or more, so rotation is on.** While every listed Subscription is used up the Kit holds each run due, and resumes them itself, so nothing is re-added by hand. The issue that @-mentioned the Operator has two steps.
  1. **Wait for the first limit to reset,** at the time the step names. Tick it once `date -u` is past that time; if it isn't yet, say when it resets and stop partway. Where the step says the Kit doesn't know when the limit resets, it asks the Operator to close the issue once agent runs work again: close it on the Operator's word, which resumes the held runs, and tick it.
  2. **Nothing to re-add.** The Kit resumes each held run itself, in the order they were held. Tick it once the first step is ticked.

  A weekly-limit issue the Kit opened quietly, with no steps, while another Subscription was free, is the Kit's to close at its reset, and nothing on it is the Operator's.

When the reset time is known, the Kit's scheduled tick closes this issue after the reset, possibly before you've finished. A closed weekly-limit issue with its last step unticked is still yours to finish: finish it, tick the step, and post the closing comment.

## 4. Finish

Your record is the one comment you keep on the issue and edit as you go. It says what was done at each step and how it was checked, which steps were taken on the Operator's word, every system touched and every workflow dispatched, and what is left, with what each left step waits on.

- **Every step ticked, no pull request:** the record is the closing comment. Close the issue as completed.
- **Every step ticked, with a pull request:** the record is the closing comment, linking the pull request. If its body says `Closes #<n>`, leave the issue open: the merge closes it. If it doesn't, the session that checks the merge closes the issue.
- **The Operator stops partway, or a step waits:** bring the record up to date with what is left and what each left step waits on. Leave the issue open and assigned. Running `/fabrik-pair <n>` again, at the terminal or from the Console, picks up from the task list and the record.
- **Every remaining step is left for a laptop:** a comment saying so, and nothing else.

A closed issue keeps its labels, `ready-for-human` included, whether you closed it or its pull request's merge did. That's normal: closed issues keep their state label, so don't remove it.

Closing the issue already makes the Kit check whether its Spec can close and what Dispatch can now release, so do neither yourself.
