# Release notes: Production, captures and Rounds as data

The notes for the minor release that ships production, captures and Rounds as data ([#593](https://github.com/jrey8343/fabrik/issues/593), ADR-0021): a `production` block in Kit config, by which a reader of the Kit follows a merged agent pull request until it is live; page links on a UI pull request that outlast its screenshots; a Prototype's captures kept zipped; every Round's fields written as data beside its comment; and the read library's reads of all of it. Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What is new in Kit config

- **The `production` block**, such as `{ "url": "https://shop.example", "environment": "production" }`: `url`, the production site's address, an `http://` or `https://` URL that live links are built from, which a block must have; and `environment`, the name the repo's production deploys carry in GitHub's Deployments, or `null` for a repo whose host reports none. A block with no `url`, a `url` that isn't `http://` or `https://`, a blank or many-line `environment`, or a field the block doesn't have, is a Kit config error naming the field.
- **`null` by default.** Left out or `null`, the block declares nothing, and the starter Kit config now ends with `"production": null`. Kit config is a Trust-root file, so no agent can change where a live link points.
- **`ui.before_url` and `preview.url` are as they were.** `production` is its own block: a repo with no `ui` block can declare it, and one can turn Before screenshots off while production stays declared. `preview.url` stays the only way a preview reaches the Kit.

## What it turns on

- **A merged agent pull request is followed for 24 hours after its merge**, in a repo whose Kit config declares both `production.url` and `production.environment`. Its Standing gains a sixth place, Production, after the merge:
  - **Deploying** while a deploy at the merge commit or later runs. A deploy of a later commit that contains the merge counts.
  - **Live** once one succeeds. A later deploy that succeeds turns an earlier failure Live.
  - **Deploy failed**, with its log's address, when none succeeded or is running and the newest failed.
  - **No deploy seen** when nothing started within an hour of the merge, as when a path filter skips the deploy.
  - **Merged** in the first hour, before any deploy has started, and whenever the Deployments could not be read, which it says, never reading as not deployed.
- **A repo that declares the address and no environment** keeps the five places it has today, and a merged agent pull request reads Merged for its 24 hours, its links into production marked not tracked, with no claim that the change is live. **A repo that declares no production** is followed no further than the merge, as today, even with `ui.before_url` set. A merged Plain pull request gets no Standing at all.
- **Only a reader of the Kit works this out**, from GitHub Deployments in the environment Kit config names, with its own credential, which needs Deployments read on the Product repo. No Kit job reads a Deployment.
- **Nothing on GitHub changes for it:** no comment, no label and no mention. A merged pull request is never listed as yours, never marked as stopping work and never Stuck, since looking at a live page is not a move owed. The Monday issue says nothing past the merge.

## What does not move

- **The Loop still ends at the merge.** Nothing in it waits on a deploy, and no Loop rule, job or prompt reads `production`.
- **A failed deploy is still the Monitor's red-main issue**, when `monitor.red_main` is on: its check reads every check run on the default branch, and a deploy job is one.
- **The Fabrik App's permissions are as they were.**

## What changed on a UI pull request

- **Its evidence section names the Evidence page** where it named the page by the Console's word: the link, the line saying none was kept, and the page's own title and file. Nothing reads the old wording back, so a section an earlier release wrote is read as before.
- **Its hidden marker now records the captured routes**, in the order the section lists them under "Captured routes": the Ticket's, then the Implementer's, then the defaults, a route missed outright among them.
- **It records what came of the preview:** not declared, when Kit config has no `preview.url`; pending, until the preview step has polled; then linked, or never answered, with the address it polled, in the same edit that rewrites the preview's line. Linked says the branch's address answered within the poll, not that the pull request's head is what answers.
- **It names each shot that was missed**, by its route, its size (mobile or desktop) and its side (Before or After), while capture went on to the rest. Why it missed stays in the artifact.
- **A route may be an Implementer's text,** so the marker's JSON is written as the Kit's other markers that carry text are: no route can end its HTML comment or mention anyone. The section reads as it did.

## What changed on a Design session's Round

- **Every Round carries its fields in one hidden line under its marker**, a versioned line of JSON: its number, its intro, and its questions with their recommendations, and on round 1 of a Ticket sent back, the pull request it came back from and its Verdict's address. The comment reads as before, word for word, and the Kit reads your reply to it as it always has.
- **A prototype round names the variant the session advises**, by its letter, beside its route and each variant's letter, summary, component and, once the preview step links it, preview. A letter that is not one of the variants is left out and noted in the run's step summary, never failing the turn. A prototype failure round carries what stopped the prototype, and "Try again" as the other answer to its question.
- **A Round that asks whether to chart a Map is marked**, so a reader never offers the Map twice.
- **No agent is handed the line.** Wherever the Kit hands an issue's thread to an agent, the line is taken out, so every prompt is what it was. A Round that would pass GitHub's limit for a comment with the line is posted without it, never held back.

## What changed for a Prototype

- **Its screenshots, videos and capture result are kept zipped for 30 days**, beside its Evidence page, which is still uploaded unzipped, as a UI pull request's are kept. Keeping them never fails the prototype turn.
- **Its round names where:** the hidden line carries the Actions run and the artifact that keep them, or says the job kept none.

## What is new for a reader of the Kit

All of it is exported through the read library's entry, `src/read/index.ts`. Each new export is a new name or a new field, so a reader on an earlier pin is unaffected.

- **The Deployments read** (`readDeployments`): for one repo, over REST, with the reader's credential, whether each merge it is asked about has been deployed in the environment Kit config names: running, succeeded, failed or none, with the Deployment that decided it, the commit it deployed, when, and a failed deploy's log when that is an `https` address. A merge whose Deployments could not be read is `unread`. It reads no further back than the earliest merge asked about.
- **The join with it** (`joinDeployments`), which settles rows a reader already holds against a fresh Deployments read with no gather, giving what the Standing rule gives from the same facts and leaving out a merged row once its 24 hours have passed; and which rows still want a read (`mergesToRead`): every row at Production that is not Live. The read library's rows function takes the Deployments read as one more input, which may be missing. The hour and the 24 hours are exported (`NO_DEPLOY_SEEN_MINUTES`, `MERGED_STANDS_HOURS`), and a kept Merged Standing read later turns No deploy seen once its hour has passed. The fact builders gain a merge of the last 24 hours, a deploy and a Deployments read.
- **Rows carry a change's pages.** An agent pull request's row carries its captured routes, each with a link to it in the preview when the preview was linked; a merged row carries the site's address, whether its deploys are tracked, and a link to each captured route in production; and an open issue's row carries its newest Prototype: the round, its comment, when it was posted, whether it still waits, its route and where its captures are kept.
- **The Round read** (`readRound`), for one issue, on demand: the last Round of its Design session with its line as data (a Round with no data when it has none), whether that Round still waits, whether a Map may be offered, worked out when asked by the one rule the Design turn uses, and a failed turn's sentence, in the Kit's own words, its Actions run and how many turns have failed running. A failed turn's notice now names its run in its hidden line; one from an earlier release gives no run. A read GitHub refused or failed says so, and offers nothing to answer.
- **The readers of an evidence marker and of a Round's line** (`evidenceMarkerIn`, `roundLineIn`), for a body or a comment a reader fetches itself.
- **The reader of a capture result** (`parseCaptureResult`) **with its file's name** (`CAPTURE_RESULT_FILE`), so a reader can tell which file in a zipped capture of a pull request or a Prototype is which shot. It never throws, and reads a result an earlier release wrote.
- **The builder of a page's production address** (`productionPageUrl`), the same one the merged rows use, so a merged pull request's pages can be linked after its 24 hours.
- **On a row's evidence,** a failed capture's sentence in the Kit's own words, and each missed shot named by route, size and side. A marker written before this release gives its routes, its preview and its missed shots as unknown.

## Why a minor

It adds behaviour, so not a patch. It adds one Kit config field, `production`, with a default; changes no caller or shim; asks for no new secret and no new permission for the Fabrik App; and leaves the Run-record schema as it was. Following work to production is opt-in, and stays dormant until the block is declared. If the release that ships this is a higher kind for another Spec's sake, this part needs nothing beyond the bump.

## To turn it on

The step is declaring the `production` block in Kit config. Take it on the Pilot first.

1. **The Pilot first.** Merge this release's bump PR there, then either:
   - **run Setup again at the release** and answer its production question: it reads the repo's Deployments with your `gh`, offers an environment (`production` when the repo has Deployments by that name, else the only one it has, else a choice among them) and an address (`ui.before_url`, else the one on that environment's newest successful Deployment), and writes the block in its setup PR; or
   - **add the block to Kit config by hand** in a pull request, such as `"production": { "url": "https://shop.example", "environment": "production" }`.

   Then merge an agent pull request there and check that a reader of the Kit shows it Deploying, then Live, and that its links open the changed pages in production.
2. **Then the other Product repos, when they want it,** the same way.

**A repo whose host reports no Deployments to GitHub** (Netlify, Cloudflare Workers Builds and Cloudflare Pages do not; Vercel does) is tracked once its deploy runs from an Actions job that names an environment, since GitHub then records the Deployment itself, whatever the host. Until then it can declare the address alone, with `environment` null, and gets links into production with no claim that a change is live. Setup says so when it finds no Deployments.

## Upgrading

- **A Product repo merges the bump**, as for any minor, and does nothing else. Until it declares `production`, nothing is followed past the merge.
- **The store needs nothing.** Its Run records, its caller and its schema are as they were.
- **Rounds and pull request bodies written before the bump keep their wording and are still read.** A Round from before it has no hidden line and reads as a Round with no data; an evidence marker from before it reads with its routes, preview and missed shots unknown.

## Two things to know

- **A row is followed for 24 hours from the merge**, so a deploy that lands later than that is not shown.
- **Live means GitHub recorded a successful deploy**, not that anyone looked at the page. A rollback to an earlier commit is not seen.
