---
name: fabrik-visual-evidence
description: Turn on Visual evidence in a Product repo, or change its answers, suggesting each from the repo and opening a PR that writes them into the Kit config. Run as /fabrik-visual-evidence from the Product repo's checkout.
disable-model-invocation: true
---

# Visual evidence

The Operator is turning on Visual evidence in this Product repo, or changing its answers. On a pull request whose diff touches the repo's UI, the Kit shows the change at mobile and desktop widths, from one of two sources: the Implement job screenshots the routes the change shows on, or the Product repo's own Journeys take Evidence shots that one of its Required checks uploads. The PR links an Evidence page of them, and the Reviewer sees them. Your job is to suggest each answer from the repo, have the Operator confirm or correct each one, write them with the Kit's writer program, and open a PR for the Operator to merge.

This session runs with the Operator's own GitHub credentials and counts as the Operator, so you may change `.fabrik/config.json`, a Trust-root file no agent elsewhere touches. That's why no agent can turn Visual evidence off or narrow its paths. The writer needs no `gh` admin and no `op`. If `gh auth status` fails, stop and tell the Operator before doing anything else.

Read `GLOSSARY.md` and `docs/adr/` if they exist, and use the repo's terms.

## 1. Check where you are

Stop and tell the Operator what's missing if any of these fails:

- The working directory is the root of the Product repo's clone (`git rev-parse --show-toplevel`), on its default branch, up to date with `origin`, with a clean working tree (`git status --porcelain` prints nothing).
- The Kit is set up here: `.fabrik/config.json` exists, and `.github/workflows/fabrik.yml` pins a Fabrik release, the tag after `@` in its `uses: jrey8343/fabrik/…@<release>` lines. Without them, the Operator runs Setup first.
- `node --version` is 24.3 or later, which the writer program needs.

**Done when:** each check passes, and you know the release the repo pins.

## 2. Ask where UI evidence comes from

A Product repo's pull requests get their UI evidence from one source or the other, never both (ADR-0032):

- **Captured routes:** the Implement job builds and serves the branch and screenshots the routes the change shows on. It suits a Product repo without Journeys. A capture is one page load, so it can't reach a state no URL reaches, such as a step of a multi-step form.
- **Evidence shots:** the Product repo's Journeys, its end-to-end tests, take an Evidence shot at each moment they name, such as `composer: draft ready`, and the Required check that runs them uploads the shots, with a manifest, as an artifact the Kit reads at the pull request's head. The Implementer names the shots that show its change, or says that nothing visible changes, and naming neither, or naming a shot the check didn't produce, is an Evidence miss, which sends the pull request back and uses a Retry (ADR-0033).

Look for Journeys in the repo (end-to-end tests, such as Playwright's or Cypress's), for the workflow job that runs them, for `sandbox.checks` in `.fabrik/config.json`, and for a `shots` in the `ui` block it already has. Say what you found. When the repo has Journeys run by one of `sandbox.checks`, or its `ui` block already has `shots`, suggest Evidence shots, and otherwise captured routes, for the Operator to confirm or correct, as with every answer. When the Journeys run in a check that isn't one of `sandbox.checks`, say so: Evidence shots need that check to be a Required check listed there, and the writer never changes `sandbox`.

For Evidence shots, tell the Operator what the Product repo's side needs, which must exist before the `shots` block does. It's set out, with a reference helper for Playwright to copy, in the README's contract: https://github.com/jrey8343/fabrik#evidence-shots.

- **A helper** of the Product's own that takes an Evidence shot at the Kit's two sizes, one screen high, and adds its entry to `manifest.json`.
- **Shots in its Journeys**, each at a moment it names with one line, a name unique in the run.
- **An upload step** in the check's workflow job that uploads the shots and the manifest as the artifact, and runs whether the Journeys passed or failed, keeping it 30 days.

Don't write any of it, not even as a suggestion in a file: the helper and the shots are the Product repo's own code, which a Ticket can build, and the workflow is a Trust-root file, so a workflow change is the Operator's own to make. Until the upload step is merged, a UI pull request's section would show a failure of the wiring, and its Implementer would find no shot to name. So when any of it isn't merged yet, suggest keeping captured routes, or leaving the `ui` block as it is, and running `/fabrik-visual-evidence` again once it is.

Going back from Evidence shots to captured routes takes the `ui.shots` block out, and the route questions are asked as for any repo.

**Done when:** the Operator has confirmed the source, and, for Evidence shots, that the Product repo's side is merged.

## 3. Ask whether the app signs in

Capture opens a plain browser, so a route behind a sign-in screenshots the sign-in page, and it reads as a clean page. Before suggesting any answer, look for a sign-in in the repo (a sign-in redirect, auth middleware, a session check on its pages, a `sign_in` in the `ui` block `.fabrik/config.json` already has), say what you found, and ask the Operator whether the app's pages sit behind a sign-in. If they do, ask whether the repo has a command that signs a fake user in, and whether the app keeps its session in cookies or localStorage, which is all a storage state holds. An app that keeps it in sessionStorage or memory can't sign in this way, so it has no command yet. There are four outcomes:

- **Public:** every page capture will show is open to a signed-out visitor. Go on to step 4, which suggests no sign-in fields.
- **Behind a sign-in, with a sign-in command:** go on to step 4, which also suggests the three sign-in fields.
- **Behind a sign-in, with no command yet, and Evidence shots:** a pull request's pictures come from the Journeys, which sign in their own way, so they need no sign-in command. Only a Prototype is still captured, and its signed-in pages would screenshot the sign-in page: say so, and go on to step 4 with no sign-in fields once the Operator confirms.
- **Behind a sign-in, with no command yet, and captured routes:** tell the Operator every signed-in route would screenshot the sign-in page, so Visual evidence stays off, and write nothing, neither a `ui` block nor a `preview` block. If `.fabrik/config.json` already has a `ui` block, Visual evidence is on already, and its signed-in routes screenshot the sign-in page: say so, and leave the block as it is for the Operator to decide on. Tell them what the repo needs first: a command that signs a fake user in to the Sandbox's own server and writes a Playwright storage state to the file `FABRIK_STORAGE_STATE` names, one command for each kind of user, such as `owner`. Don't write that command, not even as a suggestion in a file: it's the Product repo's own code, which a Ticket can build. Once it's merged, they run `/fabrik-visual-evidence` again. Then stop.

With Evidence shots, capture is a Prototype's alone, so what follows is about a prototype turn's captures. Whichever the outcome, tell the Operator what's safe behind the seam (ADR-0012), since a sign-in command is the Product's code that the Kit runs:

- A sign-in only ever runs against the Sandbox's own server, with fake users, never a deployed environment or a real account. So with a sign-in, `ui.url` must be a loopback address, such as `http://localhost:4321` or `http://127.0.0.1:4321`, and the Kit config refuses any other.
- The sign-in commands get the env `ui.serve` gets, never `sandbox.secrets`, so a command can't need a real credential.
- A signed-in route has no Before, since `ui.before_url` is a deployed site these sessions can't reach and must not. Public routes keep their Before.

**Done when:** the Operator has said which of the four outcomes is this app's, and, for the last, you've told them what the repo needs and stopped.

## 4. Suggest the answers

Propose each answer from the repo (its framework, its `package.json` scripts, the port its server listens on, its production site, its Journeys and the workflow job that runs them), or from the `ui` and `preview` blocks `.fabrik/config.json` already has. Say where each suggestion came from, and have the Operator confirm or correct each one. Whichever the source:

- `ui.paths`: globs of the files whose change makes a PR UI, such as `src/pages/**` and `src/components/**`.
- `ui.serve`: the command the Sandbox runs in the background, after `sandbox.build`, to serve the branch, such as `npm run preview`. With Evidence shots, a prototype turn still serves with it.
- `ui.url`: the local base URL that command serves on, such as `http://localhost:4321`. With a sign-in it must be a loopback address.
- `preview.url`, optional: where the repo's preview deployment for a PR appears, as a template that may use only `{pr}`, the PR's number, `{sha}`, its full head commit, and `{branch_slug}`, its branch in lower case with each run of characters other than `a` to `z` and `0` to `9` made one `-`, and no `-` at either end, so `fabrik/ticket-12` is `fabrik-ticket-12`. For example `https://deploy-preview-{pr}--<site>.netlify.app`. Before using `{branch_slug}`, check the host slugs a branch the same way: the Kit never shortens it, though a host may shorten a long one. Without it no preview is linked, and the answer is `null`.

For captured routes, also:

- `ui.before_url`, optional: the production site's base URL, which Before screenshots of the same routes are taken from. Without it Before is skipped, and the answer is `null`. When `.fabrik/config.json` has no `ui.before_url` but declares a `production` block, offer `production.url`, the address Setup's production question took, and say it came from the `production` block. The writer still writes only `ui` and `preview`, so the `production` block is left as it is.
- `ui.default_routes`, optional: the routes captured when neither the Ticket nor the Implementer names any, each a path starting with `/`, such as `/`. Without them the answer is `[]`.

When the app has a sign-in command, also suggest these three, from the repo's sign-in command, its routes and its auth middleware:

- `ui.sign_in`: each Capture identity, a named kind of fake user such as `owner` (letters, digits, `-` and `_`, starting with a letter or digit), and the command that signs it in, such as `{ "owner": "npm run sign-in -- owner" }`. At least one, and each command writes a storage state, cookies and localStorage, to `FABRIK_STORAGE_STATE`.
- `ui.sign_in_path`: the route the app sends a signed-out visitor to, such as `/login`. A signed-in page that lands there stops capture as `sign-in-failed`.
- `ui.signed_in_routes`: an ordered list of rules saying which Capture identity views a route, such as `{ "route": "/admin/**", "as": "owner" }`, the first rule to match winning. In a `route`, `*` matches within one path segment and `**` across segments, and `/**` matches `/` too. `as` is one of `ui.sign_in`'s identities, or `null` for a public route, and a route no rule matches is viewed signed out. Put the public routes' rules first when a later rule such as `/**` would cover them.

For captured routes, then look at the Product's routes: its route files, its router config, and the routes Tickets and `ui.default_routes` name. When any has a dynamic segment, such as `[patientId]`, `<patientId>` or `:patientId`, say which you found, and offer the route resolver (ADR-0024):

- `ui.resolve_route`, optional: one command that turns a route with a dynamic segment into a concrete path on the Sandbox's own server, such as `npm run resolve-route`. Capture never visits a route that still has a dynamic segment, since its page is the app's 404: without this command, each such route's screenshots are missed as `unresolved-route`. Its contract: once `ui.serve` answers and any sign-ins are done, capture runs it once for each named route with a dynamic segment, for up to 2 minutes, with the env `ui.serve` gets, never `sandbox.secrets`. The route as named is in `FABRIK_ROUTE`, such as `/patients/[patientId]`, and, when `ui.signed_in_routes` views that route as a Capture identity, that identity's storage state is in `FABRIK_STORAGE_STATE`, so the command can act as that user. It prints the path to capture on stdout, such as `/patients/0b7e`, as its last line, or exits non-zero when it can't find a record. It may find a record or make one. Like a sign-in, it needs a loopback `ui.url`, and a resolved route has no Before, since the record it found isn't on the production site. If the repo has no such command yet, the answer is `null`. Don't write the command, not even as a suggestion in a file: it's the Product repo's own code, which a Ticket can build. Once it's merged, the Operator runs `/fabrik-visual-evidence` again.

When the `ui` block `.fabrik/config.json` has holds `ui.shots`, going back to captured routes takes it out: say so, and take it out only once the Operator confirms.

For Evidence shots, instead of route capture's fields:

- `ui.shots`: the Required check whose run uploads the Evidence shots, as `check`, which must be one of `sandbox.checks`, such as `e2e`, from the workflow job that runs the Journeys, and the artifact's name, as `artifact`, offering the default `fabrik-evidence-shots`, or the name the upload step already uses. For example `{ "check": "e2e", "artifact": "fabrik-evidence-shots" }`.

Evidence shots take the place of route capture, so Kit config refuses `ui.default_routes`, `ui.before_url` and `ui.resolve_route` beside `ui.shots`, even set to `null` or `[]`. When the `ui` block `.fabrik/config.json` has holds any of them, name each one you will take out, with its value, and take them out only once the Operator confirms. Without that, write nothing, and leave the block as it is. `ui.paths`, `ui.serve`, `ui.url` and any sign-in fields stay, since a prototype turn still captures with them.

Then check with the Operator that `sandbox.build`, `ui.serve`, each sign-in command and any `ui.resolve_route` work without `sandbox.secrets`, which capture never gives them. If one needs a value, give it a non-secret stand-in in `sandbox.env`, or capture fails with `build-failed`, `server-did-not-start` or `sign-in-failed`, or misses its dynamic routes as `unresolved-route`.

**Done when:** the Operator has confirmed or corrected `ui.paths`, `ui.serve`, `ui.url` and `preview.url`, then, for captured routes, `ui.before_url`, `ui.default_routes` and, when the Product's routes have dynamic segments, `ui.resolve_route`, or, for Evidence shots, `ui.shots` and each route capture field to take out, and, with a sign-in command, the three sign-in fields too.

## 5. Write the answers

Download Fabrik at the release the repo pins into a temporary folder, so the writer checks the answers against the same Kit config rules the repo's Kit jobs read. Fabrik is public, so this needs no credentials:

```sh
FABRIK=$(mktemp -d)
curl -fsSL "https://codeload.github.com/jrey8343/fabrik/tar.gz/refs/tags/<release>" | tar -xzf - -C "$FABRIK" --strip-components=1
```

The change goes out on the branch `fabrik/visual-evidence`. Run `git fetch origin`, then look for an earlier run's open PR from it. Only a PR whose head is in this repo counts: `gh pr list --head` matches a fork's branch of the same name too, so look with `gh pr list --head fabrik/visual-evidence --state open --json number,url,isCrossRepository --jq '.[] | select(.isCrossRepository | not)'`, and never push to, edit or offer the Operator a PR from a fork.

- **An earlier run's PR is open:** switch to its branch with `git switch -C fabrik/visual-evidence origin/fabrik/visual-evidence`, and push to it in step 6.
- **Otherwise:** start the branch from the up-to-date default branch with `git switch -C fabrik/visual-evidence`. That also starts again a branch left from an earlier run whose PR was merged or closed, and loses nothing, since every run confirms its answers again.

Run the writer from the repo's root, with the confirmed answers on stdin as the `ui` and `preview` blocks, in JSON spelled as Kit config spells them. Give every answer, with `null` or `[]` for an optional one the Operator left out. Give the sign-in fields only with a sign-in command, `ui.sign_in` as an object and `ui.signed_in_routes` as a list of rules, in the Operator's order. Give `ui.resolve_route` only when the Operator answered it, as its command or `null`. Beside the blocks, `remove` lists each `ui` field the Operator confirmed taking out, as `ui.<field>`; the writer takes a field out only when `remove` names it, and takes out only `ui.before_url`, `ui.default_routes`, `ui.resolve_route` and `ui.shots`. The quoted `'EOF'` keeps the shell off the values:

```sh
node "$FABRIK/src/setup/visual-evidence-main.ts" <<'EOF'
{
  "ui": {
    "paths": ["src/pages/**", "src/components/**"],
    "serve": "npm run preview",
    "url": "http://localhost:4321",
    "before_url": "https://clinic.example.com",
    "default_routes": ["/"]
  },
  "preview": { "url": null }
}
EOF
```

With a sign-in command, the `ui` block also holds the three sign-in fields, and here a route resolver too:

```sh
node "$FABRIK/src/setup/visual-evidence-main.ts" <<'EOF'
{
  "ui": {
    "paths": ["src/pages/**", "src/components/**"],
    "serve": "npm run preview",
    "url": "http://localhost:4321",
    "before_url": "https://clinic.example.com",
    "default_routes": ["/"],
    "sign_in": { "owner": "npm run sign-in -- owner" },
    "sign_in_path": "/login",
    "signed_in_routes": [
      { "route": "/book/**", "as": null },
      { "route": "/**", "as": "owner" }
    ],
    "resolve_route": "npm run resolve-route"
  },
  "preview": { "url": null }
}
EOF
```

For Evidence shots, the `ui` block gives `ui.shots` in place of route capture's fields, and `remove` takes out each of them the Operator confirmed taking out:

```sh
node "$FABRIK/src/setup/visual-evidence-main.ts" <<'EOF'
{
  "ui": {
    "paths": ["src/pages/**", "src/components/**"],
    "serve": "npm run preview",
    "url": "http://localhost:4321",
    "shots": { "check": "e2e", "artifact": "fabrik-evidence-shots" }
  },
  "preview": { "url": null },
  "remove": ["ui.before_url", "ui.default_routes", "ui.resolve_route"]
}
EOF
```

Going back to captured routes, the answers give route capture's fields as above, with `"remove": ["ui.shots"]` once the Operator confirms taking it out.

It writes only those two blocks of `.fabrik/config.json`, in place or before its closing brace, printed as Prettier prints JSON, and keeps every other byte. A field of a block the file already has that the answers leave out keeps its value, so a `ui` block that signs in keeps its sign-in fields when the answers leave them out. An answer for `ui.sign_in` or `ui.signed_in_routes` replaces the field whole, so give every identity and every rule. What it prints decides what's next:

- **`Wrote the … to .fabrik/config.json.`** Go on to step 6.
- **`Nothing was written to .fabrik/config.json:`**, then one line per problem: the Kit config would refuse the answers, so nothing was written. Settle each problem with the Operator and run the writer again. A sign-in or a `ui.resolve_route` with a `ui.url` that isn't loopback is one: the Operator gives a loopback `ui.url`, never a deployed one. A route capture field `is set, but so is ui.shots` is another: `remove` didn't name it, so name it to the Operator, and add it to `remove` only once they confirm. A `ui.shots.check` that isn't one of `sandbox.checks` is a third: the check must be a Required check listed there first, which the writer never changes.
- **`.fabrik/config.json already holds these answers, so nothing was written.`** Tell the Operator Visual evidence already has these answers, remove the branch and the temporary folder, and stop.

**Done when:** the writer has written the blocks, or says the Kit config already holds them.

## 6. Open the pull request

1. The writer prints for Prettier's default width, 80 columns. If the Product's own Prettier settings set another (`printWidth` in `.prettierrc` or in `package.json`'s `prettier` key, or `max_line_length` in `.editorconfig`), run the Product's own `prettier --write .fabrik/config.json`, so the PR passes its `prettier --check`.
2. Commit `.fabrik/config.json` alone. When step 5 found an earlier run's PR open, push with `git push origin fabrik/visual-evidence`, which updates that PR. Otherwise push with `git push --force-with-lease -u origin fabrik/visual-evidence`, which replaces a branch GitHub kept from a merged or closed PR, and open a PR to the default branch with `gh pr create`. Its body lists each answer, and each field taken out, and says the check that `sandbox.build`, `ui.serve`, any sign-in command and any `ui.resolve_route` work without `sandbox.secrets` was made.
3. Remove the temporary Fabrik folder.
4. Tell the Operator to merge the PR themselves. The push job reads the `ui` block from the default branch, so capture starts on the first UI PR after the merge. Then tell them:
   - That with Visual evidence on, each PR whose diff touches `ui.paths` gets an evidence section linking an Evidence page of its screenshots, and the Reviewer sees them.
   - With Evidence shots, that the Implementer names up to four shots that show its change, or says in one sentence that nothing visible changes; that the section waits for the named check, and shows the named shots once the Review's jobs have read its artifact; that naming neither, or naming a shot the green check didn't produce, is an Evidence miss, which sends the PR back and uses one of the Ticket's two Retries, and with none left goes on to Review with the miss shown; and that a green check with no artifact, or a manifest that can't be read, is shown as a failure of the wiring, theirs to fix, and sends nothing back.
   - With a sign-in, that each signed-in screenshot names the Capture identity it was viewed as, and has no Before, and that a sign-in that fails, or a signed-in page that lands on `ui.sign_in_path`, shows in the evidence section as `sign-in-failed`.
   - With `ui.resolve_route`, that each dynamic route's screenshots show the route beside the path it was captured at, and have no Before, and that a route it can't resolve shows in the evidence section as not captured, with why.
   - That an After page answering 4xx or 5xx shows in the evidence section as not captured, with its status, rather than as a screenshot of the error page.
   - That the merge is all it needs: Setup and its wizard needn't run again for it.
   - That running `/fabrik-visual-evidence` again changes its answers, and with the same answers it writes nothing.

**Done when:** the PR is open, and the Operator has its link.
