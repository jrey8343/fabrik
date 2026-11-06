# Release notes: Visual evidence

The notes for the minor release that ships Visual evidence on UI pull requests ([#153](https://github.com/jrey8343/fabrik/issues/153)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- The Kit config gains two optional blocks, both off by default:
  - `ui`: `paths`, globs of the files whose change makes a pull request UI; `serve`, the command the Sandbox runs in the background after `sandbox.build` to serve the branch; `url`, the local base URL the Kit polls until it answers, then captures routes under; and optionally `before_url`, the production base URL, and `default_routes`, paths starting with `/`.
  - `preview`: `url`, a template that may use only `{pr}`, `{branch_slug}` and `{sha}`.
- **A repo without a `ui` block never captures**, and each Implement run's step summary says in one quiet line that Visual evidence is off and that `/fabrik-setup` turns it on. An invalid `ui` or `preview` block is reported with every problem at the start of the run, like any other Kit config error. `.fabrik/config.json` is already a Trust-root file, so no agent can turn Visual evidence off or narrow its paths.
- **Whether a pull request is UI is the Kit's call, never an agent's.** The Implement job checks the PR's diff against `ui.paths`. A PR that touches none of them gets no evidence section, no images and no extra text in the Reviewer's prompt.
- **On a UI pull request, the Implement Sandbox job captures UI evidence** after the Implementer's agent has exited, on first, Retry and Request-changes runs alike. It runs `sandbox.build`, starts `ui.serve`, waits for `ui.url` to answer, and a Kit script drives headless Playwright through each route at a mobile width (390 by 844) and a desktop width (1440 by 900) for the After screenshots. With `before_url` set it then takes Before screenshots of the same routes from the production site, and without one it skips Before quietly. Capture uses no model turns, no Playwright MCP and no video, so it costs no Subscription usage. Build and server get `sandbox.env` and no secret. Capture has its own 20-minute timeout, and the Implement job's timeout is the Implement role's plus that plus 10 minutes, while the agent still stops at the role's own.
- **The routes:** every route the Ticket names, as the path alone in backticks such as `/book`, is always captured. The routes the Implementer names in its result come next, and `ui.default_routes` is used only when neither names one. Each route is captured once, and the list stops at 4 routes so capture stays fast, though a route the Ticket names is captured even past that.
- **The pull request links a gallery.** It's one self-contained HTML page with every screenshot inlined, Before and After side by side for each route and viewport, with no image cap. It's uploaded as an unzipped artifact, so it opens in one click, and it's kept about 30 days with the screenshots. The PR body gets an evidence section between the summary and `Closes #n`. The section holds:
  - the gallery link;
  - each captured route, with why it was chosen: named by the Ticket, named by the Implementer, or a default;
  - any route that answered with a server error, flagged;
  - the preview link, or why there isn't one;
  - when capture failed, why: the build failed, the server didn't start, a timeout, no routes.
- **Capture never blocks a pull request and never uses up a Retry.** Every failure is caught and named in the evidence section, and is never an Infrastructure failure.
- **Every Retry and Request-changes run on a UI pull request captures again** and replaces the evidence section, so the evidence always matches the PR's head. A hidden marker in the PR body records that the PR is UI and which Implement run holds its images.
- **The Reviewer sees the screenshots.** On a UI pull request the Review job, which gains read access to Actions artifacts, downloads at most 8 of them into its working directory, After before Before and mobile before desktop. The review prompt gets a UI evidence block naming each image's route, viewport and side. The Reviewer judges three things: whether the screenshots show what the Ticket asked for, plain breakage (a blank or error page, content spilling over at mobile width, overlapping or cut-off content), and regressions against Before on parts the Ticket didn't touch. Taste stays the Operator's. A visual failure is an ordinary Execution flaw that names the route and the screenshot, so the Verdict means what it always has. When capture failed, the block says why and the Reviewer reviews the code as usual.
- **The preview link.** With `preview.url` set, the push job fills in the template after it pushes. `{pr}` is the PR's number and `{sha}` its full head commit. `{branch_slug}` is its branch in lower case, with each run of characters other than letters and digits made one `-`, so `fabrik/ticket-12` is `fabrik-ticket-12`. The push job then polls the URL for 4 minutes at most, in a bounded step that never fails. When the URL answers with a page, the evidence section links it, and when it doesn't, the section says so. The Kit never calls a hosting provider's API and needs no new secret.
- To ask for a visual change, the Operator uses Request changes and cites a screenshot. There's no thumbs-down or reaction trigger for rework (ADR-0007).
- `/fabrik-setup` gains an opt-in step, Visual evidence. It asks for `ui.paths`, `serve`, `url`, `before_url`, `default_routes` and `preview.url`, and writes them into `.fabrik/config.json` in its setup PR. Its wizard gains a stage, "Visual evidence", that checks the Kit config has a `ui` block. Without the step's answers, setup leaves the Kit config alone.
- The release pins Playwright (`playwright-core`) at one exact version beside Sandcastle and the Claude Code CLI, and Dependabot bumps it. Capture installs its Chromium when it runs.
- **Why a minor:** `ui` and `preview` are new Kit config blocks that default to off, and turning Visual evidence on is an opt-in Operator setup step ([#139](https://github.com/jrey8343/fabrik/issues/139)). Until a repo takes that step, no PR is captured, and runs note quietly that Visual evidence is off. There are no shim changes, and no Kit config field is renamed or removed. So a Product repo only merges the bump PR.

## To turn it on

The setup step is Visual evidence: `/fabrik-setup` with its answers, whose wizard stage "Visual evidence" checks it's on. Turn it on for the Pilot now. The other Product repos can take the step whenever they want it.

1. **The Pilot now.** Merge this release's bump PR in the Pilot only. Then re-run `/fabrik-setup` at this release there, saying yes to Visual evidence, and answer:
   - `ui.paths`: the files that make up its pages, such as its page, layout, component and style files;
   - `ui.serve` and `ui.url`: the command that serves its built site, and the local URL it serves on;
   - `ui.before_url`: its production site, so Before comes from the live site without a second build;
   - `ui.default_routes`: at least `/`;
   - `preview.url`: none, which writes `null`. The Pilot has no preview host, and setting one up is a separate Operator decision.

   Merge the setup PR it opens. Re-running setup with the same answers then plans nothing for it, and the wizard's "Visual evidence" stage says it's on.
2. **Check it on a real UI issue** in the Pilot before the release goes anywhere else:
   - the PR's evidence section links a gallery that opens in one click, with Before and After at mobile and desktop widths for each route;
   - the routes it lists include every one the Ticket named, each with why it was chosen;
   - the Review run's prompt names the screenshots, and a visual problem comes back as an Execution flaw that names the route and the screenshot;
   - a Retry or Request-changes run replaces the evidence section;
   - a PR that touches no file in `ui.paths` gets no evidence section.
3. **Then the other Product repos, when they want it.** In each, merge the bump PR: the repo runs as before, with one quiet line in each Implement run's step summary saying Visual evidence is off. To turn it on, re-run `/fabrik-setup` and answer its Visual evidence step. A repo with no public production site leaves `before_url` out and still gets After evidence. A repo with no UI never takes the step.
