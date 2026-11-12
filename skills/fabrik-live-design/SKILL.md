---
name: fabrik-live-design
description: Take an issue's Fabrik Design session live with the Operator, then publish its outcome and post it to the issue so the Loop carries on. Run as /fabrik-live-design <issue number>.
disable-model-invocation: true
---

# Live Design session

The Operator is taking the Design session on issue `$ARGUMENTS` live, in this cloud or local session, instead of answering numbered rounds on the issue. It must end the way an async session does, so the Loop can carry on: the issue becomes its agent brief, its Operator brief or a Map with its first Decisions, or a Spec and its Tickets (some of which may be Operator steps) replace it.

This session runs with the Operator's own GitHub credentials, so you publish the outcome yourself with `gh` (see `docs/agents/issue-tracker.md`). If `gh auth status` fails, stop and tell the Operator before doing anything else.

## Before you start

1. Read the issue and its whole thread: `gh issue view <n> --json number,title,body,labels,comments,state`.
2. Check that it's open and labelled `needs-design`. If it isn't, it's not in a Design session: tell the Operator and stop.
3. Earlier rounds the Kit posted start with `<!-- fabrik:design-round N -->`. The Operator's replies to them are decisions already made. An answer of `yes` takes every recommendation in that round.
4. Read `GLOSSARY.md` and `docs/adr/` if they exist, and use the repo's terms.
5. Read the Vision (`docs/product/vision.md`) and the Roadmap (`docs/product/roadmap.md`) if they exist. Both are optional, and both are Trust-root files under `docs/product/` at the repo root that only the Operator changes: never edit either one, and never plan a Ticket that does.

## Product intent

An issue touches **Product intent** when it changes who the product serves or what it promises them, goes through a one-way door (a public name, a URL, a data shape, pricing, anything an End user is told), or does something the Vision says the product deliberately doesn't do.

- **Open with a product-intent block** when the issue touches Product intent. Before any technical question, settle who the change serves, why, how its success is measured, and what it deliberately leaves out. Skip any of these the Vision or the thread already answers. Draw each recommendation from the Vision, so the Operator can usually settle the block with `yes`. With no Vision, ask the questions directly, each still with your recommended answer.
- **Skip the block** for a Ticket sent back to design from its pull request (its thread has the Kit's comment starting `<!-- fabrik:back-to-design`), which goes straight to what failed, and for an internal or technical issue.
- **Judge priority from the Roadmap.** Ask a priority question only when the issue conflicts with what the Roadmap lists under Now. The Roadmap gates nothing: an issue on no Roadmap list is designed like any other.
- **Never edit the Roadmap or the Vision.** When the session decides something the Vision doesn't yet say, the outcome carries an Operator step for it (see **Ending the session**).

## While the session runs

- **Post nothing to the issue until the end, and change none of its labels.** Every comment the Operator's account posts on a `needs-design` issue starts an async turn, and the Kit moves the labels when your outcome comment lands.
- Grill the Operator as `.claude/skills/grilling/SKILL.md` describes: one decision at a time, each with your recommended answer. Never ask what the repository can answer.
- **Treat the Decisions an issue rests on as settled.** When the issue says which Decisions it rests on, as a Spec-to-be filed from a Map does, read each one and its resolution (`gh issue view <decision> --comments`). Those questions were already settled on the Map: design from them, and don't ask them again. Ask only what they leave open.
- **Offer a Map when the destination is foggy.** Some issues are too foggy for one Design session: what done looks like isn't settled, or the open questions hang on one another, so no single session could design them without guessing. Such an issue can be charted as a **Map** instead: the issue becomes the Map, which names the destination, and the first questions to settle on the way there become its Decisions, sub-issues each resolved on its own by research, a prototype, a grilling or a task, never by a pull request. When the Map cap has room (see the next point) and either Triage's comment carries the line `This looks too foggy for one Design session.` or you judge the destination can't be designed in one session, ask "Chart this as a Map instead?" with your recommendation in your first exchange with the Operator. The Operator decides, and may also ask for a Map later in the session. Ask no Map question on an issue this session can design, clear but large ones included, and never on an issue with a parent: a Ticket under a Spec never becomes a Map.
- **Check the Map cap before you offer a Map.** The cap is `caps.maps` in `.fabrik/config.json` (1 when the file or the field is missing; 0 stops new Maps). Count the repo's open Maps, whoever made them: `gh issue list --state open --label wayfinder:map --json number,title`. When they already reach the cap, don't offer a Map. If the Operator asks for one anyway, tell them which open Map holds the cap and that closing it frees the cap (or, at 0, that the Kit config stops new Maps), and carry on the session another way.
- **Offer a Prototype when the open question is how a page looks**: its layout, what it shows first, how its parts sit together. A **Prototype** is throwaway variants of one route, built on the branch `prototype/<n>`, which is never merged, so the Operator chooses how the page looks by looking at it. Offer one only when `.fabrik/config.json` has a `ui` block (its `ui` field is an object, not `null` or missing): the Kit decides from that block whether a repo takes Prototypes, so a repo without one never gets the offer, live or async. Ask it as one question, naming the route and how many variants it builds, with your recommendation, such as "Prototype the booking page (`/book`) as 3 variants first?". Offer 3 variants unless the Operator asks for another count, from 2 to 5. Questions of logic, data or behaviour stay ordinary questions. Nothing is built until the Operator says yes, and their yes may change the route or the count. On a yes, build it as **Building a Prototype** describes.
- **Facts only the Operator can fetch** (IDs, prices or settings held in another system) don't hold the session up. Settle the decisions without them and end with a Spec in which an Operator step gathers the facts and commits them, through its Pairing session's pull request, to a file in the Product repo that the code reads. The step's last task names that file and the shape the Tickets expect. Only the Tickets that read that file are blocked by it. If the Operator says they have the facts to hand, take them now and add no step.

## Building a Prototype

Only once the Operator has said yes to a Prototype. You build it here, in this checkout: there's no Sandbox job, capture or Evidence page, and, as for the rest of the session, nothing is posted to the issue.

1. Note the branch you're on (`git branch --show-current`), to come back to. If `git status --porcelain` lists changes, ask the Operator how to set them aside before you switch branches.
2. Run `git fetch origin`. When `origin/prototype/<n>` exists, an earlier round, live or async, pushed it: build on it with `git switch -C prototype/<n> origin/prototype/<n>`. Otherwise cut it from the default branch (`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`): `git switch -C prototype/<n> origin/<default branch>`.
3. Build the approved variants of the one route as `.claude/skills/prototype/SKILL.md` and its UI branch, `.claude/skills/prototype/UI.md`, describe, switched by `?variant=` and its letter from A, showing A when there's none. Mark every file you add or change as prototype code, with a comment at its top saying it's a variant of a throwaway Prototype for #<n>, never to be merged. A later round's branch holds the earlier round's variants: change or replace them so the route renders only this round's. Steps 5 and 6 take the place of the skill's last two: the Operator gets one command, and the real code stays as it is, since the Implementer rewrites the variant the Operator chooses.
4. Serve the branch and load each variant once, so the Operator never opens a broken one, then stop the server. `ui.serve` and `ui.url` in `.fabrik/config.json` say how and where the Kit serves the repo.
5. Commit the variants on `prototype/<n>`, and push it with a plain `git push origin prototype/<n>`, which only fast-forwards what an earlier round left. A live session acts as the Operator, so this push is theirs. Push this one branch and open no pull request: `prototype/<n>` stays a throwaway reference, and the Kit never deletes it. Note the commit you pushed (`git rev-parse HEAD`), which the outcome links each component at.
6. Give the Operator the one command that serves the branch, such as the repo's dev script, and the URL of the route with `?variant=A`, then each other letter. In a cloud session, whose servers their browser can't reach, prefix the command with `git fetch origin && git switch prototype/<n> &&` for their own checkout. Then give each variant's letter, what it tries in a line, and the path of its component, and ask "Which variant?" with your recommendation.
7. Read the Operator's answer as an ordinary one, such as "B, with the bigger booking button from C": the variant they chose and any tweaks to it. Switch back to the branch from step 1 and carry on the session from there. When they ask for another round of variants, build it from step 2, on the branch this round pushed.

## Ending the session

Do exactly one of these, once nothing that matters is open or the Operator wants to stop. Every comment and issue you write here contains no @-mentions.

When there's a Vision and the session decides something about Product intent that it doesn't yet say, such as a new kind of End user or something the product now deliberately doesn't do, the outcome carries an Operator step titled "Update `vision.md`". Its steps give the exact lines to add to `docs/product/vision.md`, or to change in it, so the Operator can paste them. No Ticket waits on it. Only the Operator changes the Vision, so work that would otherwise fit one pull request finishes as a small Spec instead: one Ticket and that Operator step. A Ticket under a Spec never gets a Spec of its own, so the pair sits under its Spec instead: rewrite the Ticket as its agent brief, and publish that Operator step as a sub-issue of the same Spec (`gh issue create --parent <spec>`), labelled and assigned as **The work is bigger** describes. An Operator brief takes the same lines as one of its own steps. With no Vision, add no such step.

When the Operator chose a variant of a Prototype, in this session or in an earlier round on the issue, the outcome records it as an async session's does: the variant they chose, their tweaks, and links to the branch (`https://github.com/<owner>/<repo>/tree/prototype/<n>`) and to that variant's component at the commit that was pushed (`https://github.com/<owner>/<repo>/blob/<sha>/<path>`), as a prototype round on the issue gives them. Put it in the agent brief, or in the Spec and in each Ticket that builds the page, and say that the Implementer rewrites the Prototype as a reference, never merging or cherry-picking it.

Some lines of the issue's old body mark it for something that reads it later, so carry them forward into the body you write in its place, each exactly as the old body had it:

- Keep any `<!-- fabrik:monitor … -->` line as the first line of the issue's rewritten body (`gh issue edit`), and nothing else of the Monitor's. The Monitor finds the error it filed the issue for by that line, and would file it again without it.
- Carry any `From audit #<n>` line, `<!-- fabrik:escape … -->` line and `From retro #<n>` or `From retro <owner>/<repo>#<n>` line into the rewritten brief or Map, or the Spec that supersedes it. After everything else, its `<sub>` line included, add a blank line and then each of those lines, in the old body's order. The next Audit reads `From audit` to skip the issue, the Weekly summary counts the escape line as an Architectural escape, and the next Retro reads `From retro` to skip the proposal the issue was filed from, so all of them must survive the rewrite.
- Carry only lines outside fenced code blocks. A fenced block opens on a line starting with `` ``` `` or `~~~` and ends on the line that closes that fence; indenting a line leaves it outside one. A line inside one is quoted data, such as the Sentry error title a Monitor issue quotes, never a line to carry, whatever it says. A fence that never closes quotes nothing, so the lines after it are carried as usual: a filed Audit candidate whose body was cut short inside a code block ends with its `From audit` and escape lines below that open fence, and both are carried.

### The work fits one pull request: an agent brief

1. Rewrite the issue's body as its agent brief (`gh issue edit <n> --body-file …`), following `.claude/skills/triage/AGENT-BRIEF.md`, in this shape. It opens with a "Who and why" line, so the Implementer builds what the Operator meant: for an issue that touches Product intent, the End users it serves and why it matters to them; for an internal or technical one, who the work is for and why.

   ```
   ## Agent brief

   **Who and why**: <who this serves and why, in one line>

   <what to build and why, the decisions the session made, what's out of scope>

   ## Acceptance criteria

   - [ ] <one check a test could make>

   <sub>Written by a live Fabrik Design session. The original issue is in this issue's edit history.</sub>
   ```

2. Post the outcome comment last. Its first line is exactly the marker, with nothing before it:

   ```
   <!-- fabrik:live-outcome brief -->
   **Design session finished live.** This issue is now its agent brief, ready for an Implementer.

   <the decisions the session made, briefly>
   ```

### The whole issue is Operator work that fits one sitting: an Operator brief

Use this when only the Operator can do the work (a secret, a repo setting, a trust-root edit) and it needs no pull request from an Implementer.

1. Rewrite the issue's body as its Operator brief (`gh issue edit <n> --body-file …`), in this shape. Each step is one action the Operator takes:

   ```
   ## Operator brief

   <what needs doing and why, the decisions the session made>

   ## Steps

   - [ ] <one action the Operator takes>

   <sub>Written by a live Fabrik Design session. The original issue is in this issue's edit history.</sub>
   ```

2. Post the outcome comment last. Its first line is exactly the marker:

   ```
   <!-- fabrik:live-outcome operator-brief -->
   **Design session finished live.** This issue is now an Operator brief, ready for a Pairing session.

   <the decisions the session made, briefly>
   ```

### The work is bigger: a Spec and its Tickets

1. Write the Spec as `.claude/skills/to-spec/SKILL.md` does, opening with a `## Product intent` section above `## Problem Statement` and its technical sections, so an Implementer reads the purpose first: who it serves, why, how its success is measured, and what it deliberately doesn't do. State the success measure only: nothing tracks it. For an internal or technical Spec, one line saying who it's for and why is enough. Slice the Spec into Tickets as `.claude/skills/to-tickets/SKILL.md` does. Publish them with `gh`, skipping any step in those skills that asks for labels other than these:
   - The Spec, and every Ticket, gets this issue's category label (`bug` or `enhancement`) and `ready-for-agent`, set with `--label` when you create it, so Intake never sends it to Triage.
   - A piece only the Operator can do, that later Tickets must wait for or that belongs to no one pull request, is an **Operator step** instead of a Ticket. It gets the category label and `ready-for-human` (never `ready-for-agent`), is assigned to the Operator (`--assignee <operator>`), and its body ends with its steps as a task list under `## Steps`, one `- [ ]` line per action the Operator takes. A Spec may be made only of Operator steps.
   - Each Ticket and Operator step is a sub-issue of the Spec (`gh issue create --parent <spec>`).
   - Each blocker is a native blocked-by edge (see **Blocking** in `docs/agents/issue-tracker.md`), in either direction between Tickets and Operator steps. Add every edge before step 2: your outcome comment starts Dispatch, which releases any Ticket with no open blocker.
   - End the Spec's body with `<sub>Written by a live Fabrik Design session on #<n>, which this Spec supersedes.</sub>`, then any lines it carries forward from this issue's body.
2. Post the outcome comment last. Its first line is exactly the marker:

   ```
   <!-- fabrik:live-outcome spec -->
   **Design session finished live.** This issue is superseded by the Spec #<spec> and its <count> Tickets.

   <the decisions the session made, briefly>
   ```

   When some of the new items are Operator steps, count them too, as the Kit does: `and its 2 Tickets and 1 Operator step`, or `and its 2 Operator steps` when there are no Tickets. The assignment is what notifies the Operator, so still mention nobody.

3. Don't close the issue or remove its labels. The Kit does that when it sees the comment.

### The destination is foggy: a Map

Only once the Operator has said yes to charting the issue as a Map, and only on an issue with no parent.

1. Check the Map cap again, as **While the session runs** describes, since a Map may have opened since you offered one. If it's full now, chart nothing: tell the Operator which open Map holds the cap, and end the session another way.
2. Rewrite the issue's body as the Map (`gh issue edit <n> --body-file …`), in this shape. If `.claude/skills/wayfinder/SKILL.md` exists, follow it for what goes in each section and each Decision, but publish them as these steps say. Leave Decisions so far empty: each resolved Decision adds its line there. A section with nothing in it is its heading alone.

   ```
   ## Destination

   <one or two lines: what reaching the end of the Map looks like>

   ## Notes

   <the domain, the skills and the standing preferences every session on the Map consults>

   ## Decisions so far

   ## Not yet specified

   <the fog: what's still too dim to state as a Decision>

   ## Out of scope

   <what the Map deliberately leaves out>

   <sub>Written by a live Fabrik Design session. The original issue is in this issue's edit history.</sub>
   ```

3. File each question you can state precisely now as a Decision, at least one, blockers first so each blocked-by edge points at an issue that exists:
   - Each Decision is a sub-issue of the Map with one label, `wayfinder:<type>`, where `<type>` is how it gets resolved: `research`, `prototype`, `grilling` or `task` (`gh issue create --parent <n> --label wayfinder:<type> …`). Give it no state or category label, so Intake leaves it alone, and assign it to nobody, since an assignee claims it.
   - Each blocker is a native blocked-by edge between Decisions (see **Blocking** in `docs/agents/issue-tracker.md`). Add every edge before step 4: your outcome comment starts Dispatch, which releases each research Decision with no open blocker to the Researcher.
4. Post the outcome comment last, listing the Decisions as the Kit does. Its first line is exactly the marker:

   ```
   <!-- fabrik:live-outcome map -->
   **Design session finished live.** This issue is now a Map, with <count> Decisions filed under it:

   - #<decision> <title> (<type>)

   <why this is a Map and what the session settled, briefly>
   ```

5. Don't remove `needs-design` or add `wayfinder:map`. The Kit does that when it sees the comment.

### Stopping before it's finished

Post one comment, with no marker, that lists every decision the session made and the questions still open. That comment counts as the Operator's answer, so the async session takes its next turn from there and posts the next round.

## What the Kit does with the outcome

The Fabrik App sees the marker on the Operator's comment. For `brief` it swaps `needs-design` for `ready-for-agent`; for `spec` it removes `needs-design` and closes this issue as completed. Either way it then runs a Dispatch check, so the new Tickets start as they would after an async session. Dispatch never releases an Operator step: it's `ready-for-human`.

For `operator-brief` it swaps `needs-design` for `ready-for-human` and assigns the issue to the Operator, ready for a Pairing session. It runs no Dispatch check.

For `map` it swaps `needs-design` for `wayfinder:map` and runs a Dispatch check, so the Researcher starts on the Map's unblocked research Decisions, and a Design queue check, so the Design session slot this one held goes to the next waiting issue. The other Decisions wait for the Operator in `/wayfinder`. The Kit never closes a Map: the Operator does, once the Map's last Decision has filed each Spec-to-be as a `needs-design` issue.
