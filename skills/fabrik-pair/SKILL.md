---
name: fabrik-pair
description: Run a Pairing session on a ready-for-human issue, working through its steps with the Operator and recording on the issue what was done. Run as /fabrik-pair <issue number>.
disable-model-invocation: true
---

# Pairing session

The Operator is working through issue `$ARGUMENTS` with you beside them. It's `ready-for-human` because only the Operator can do it: a secret, a repo setting, a third-party dashboard, a Trust-root file edit. It may have come from Triage, from the Kit itself (a token rotation), from a Ticket an Implementer refused, or as an Operator step from a Design session. Your job is to guide each step, check it, and leave the issue as the record: its task list ticked as the work happens, and a comment saying what was done.

This session runs with the Operator's own GitHub credentials, so you write to the issue yourself with `gh` (see `docs/agents/issue-tracker.md`). If `gh auth status` fails, stop and tell the Operator before doing anything else.

Every comment and body edit you write names where a secret lives (the 1Password item, the GitHub secret's name) and never its value, and contains no @-mentions.

## 1. Check the issue

Read the issue and its whole thread: `gh issue view <n> --json number,title,body,labels,comments,state,assignees`. Read `GLOSSARY.md` and `docs/adr/` if they exist, and use the repo's terms.

If the issue isn't open, or isn't labelled `ready-for-human`, tell the Operator which and stop: it isn't Operator work waiting to be done. If it's assigned to nobody, assign it to the Operator (`gh issue edit <n> --add-assignee @me`).

**Done when:** the issue is open, `ready-for-human`, and assigned.

## 2. Settle the task list

The issue body's GitHub task list (`- [ ]` lines) is the plan and the record.

- **The body has one:** that's the plan. Steps already ticked (`- [x]`) are done; you resume at the first unticked one.
- **The body has none:** draft one from what the issue and its thread say to do, one `- [ ]` line per action the Operator takes, in the order they must happen. Show it to the Operator and agree it with them. Then write it into the body under a `## Steps` heading, below the original text, which stays as it is: `gh issue edit <n> --body-file …`.

**Done when:** the body holds the agreed task list, and you've told the Operator which step you start at.

## 3. Work through the steps

Take the unticked steps in order. For each:

1. **Guide it.** For one or two simple steps, talk the Operator through them yourself. When the remaining steps involve a third-party dashboard, credentials, or several commands to run in order, build a wizard for them with `.claude/skills/wizard/SKILL.md`, saved in a temp folder (`mktemp -d`) outside the repo so it's never committed, and hand it to the Operator to run in their own terminal.
2. **Change files through a pull request.** A step that changes repo files, Trust-root files included (you may edit them because this session runs as the Operator), is made on the branch `fabrik/pair-<n>`, cut from the default branch, and goes out as one pull request whose body contains `Closes #<n>`. Every such step goes in that same pull request; if an earlier sitting already opened one (`gh pr list --head fabrik/pair-<n> --state open`), push to its branch instead. The default branch only changes by its merge.
3. **Check it.** Confirm the step with a command wherever one can see the result: `gh secret list` for a GitHub secret, `gh api` for a repo setting, `op item get` for a 1Password item, reading the file for a file change, `gh pr view` for an opened pull request. Where nothing can check it, ask the Operator to confirm it in their own words, and take their answer as the check.
4. **Tick it** in the body the moment it's confirmed: rewrite that step's `- [ ]` as `- [x]` with `gh issue edit <n> --body-file …`, leaving every other line as it is. A file-change step is confirmed once its pull request is open.

**Done when:** every step is ticked, or the Operator stops.

## 4. Finish

- **Every step ticked, no pull request:** post a closing comment summarising what was done, step by step, then close the issue as completed (`gh issue close <n> --reason completed`).
- **Every step ticked, with a pull request:** post the closing comment, linking the pull request and saying the issue closes when it merges. Leave the issue open: the merge closes it.
- **The Operator stops partway:** post a comment saying which steps are done and the step the session stopped at. Leave the issue open and assigned. Running `/fabrik-pair <n>` again picks up from there.

Closing the issue already makes the Kit check whether its Spec can close and what Dispatch can now release, so do neither yourself.
