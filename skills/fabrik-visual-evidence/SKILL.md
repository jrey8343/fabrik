---
name: fabrik-visual-evidence
description: Turn on Visual evidence in a Product repo, or change its answers, suggesting each from the repo and opening a PR that writes them into the Kit config. Run as /fabrik-visual-evidence from the Product repo's checkout.
disable-model-invocation: true
---

# Visual evidence

The Operator is turning on Visual evidence in this Product repo, or changing its answers. On a pull request whose diff touches the repo's UI, the Implement job screenshots the routes the change shows on, at mobile and desktop widths. The PR links an Evidence page of them, and the Reviewer sees them. Your job is to suggest each answer from the repo, have the Operator confirm or correct each one, write them with the Kit's writer program, and open a PR for the Operator to merge.

This session runs with the Operator's own GitHub credentials and counts as the Operator, so you may change `.fabrik/config.json`, a Trust-root file no agent elsewhere touches. That's why no agent can turn Visual evidence off or narrow its paths. The writer needs no `gh` admin and no `op`. If `gh auth status` fails, stop and tell the Operator before doing anything else.

Read `GLOSSARY.md` and `docs/adr/` if they exist, and use the repo's terms.

## 1. Check where you are

Stop and tell the Operator what's missing if any of these fails:

- The working directory is the root of the Product repo's clone (`git rev-parse --show-toplevel`), on its default branch, up to date with `origin`, with a clean working tree (`git status --porcelain` prints nothing).
- The Kit is set up here: `.fabrik/config.json` exists, and `.github/workflows/fabrik.yml` pins a Fabrik release, the tag after `@` in its `uses: jrey8343/fabrik/…@<release>` lines. Without them, the Operator runs Setup first.
- `node --version` is 24.3 or later, which the writer program needs.

**Done when:** each check passes, and you know the release the repo pins.

## 2. Ask whether the app signs in

Capture opens a plain browser, so a route behind a sign-in screenshots the sign-in page, and it reads as a clean page. Before suggesting any answer, look for a sign-in in the repo (a sign-in redirect, auth middleware, a session check on its pages, a `sign_in` in the `ui` block `.fabrik/config.json` already has), say what you found, and ask the Operator whether the app's pages sit behind a sign-in. If they do, ask whether the repo has a command that signs a fake user in, and whether the app keeps its session in cookies or localStorage, which is all a storage state holds. An app that keeps it in sessionStorage or memory can't sign in this way, so it has no command yet. There are three outcomes:

- **Public:** every page capture will show is open to a signed-out visitor. Go on to step 3, which suggests no sign-in fields.
- **Behind a sign-in, with a sign-in command:** go on to step 3, which also suggests the three sign-in fields.
- **Behind a sign-in, with no command yet:** tell the Operator every signed-in route would screenshot the sign-in page, so Visual evidence stays off, and write nothing, neither a `ui` block nor a `preview` block. If `.fabrik/config.json` already has a `ui` block, Visual evidence is on already, and its signed-in routes screenshot the sign-in page: say so, and leave the block as it is for the Operator to decide on. Tell them what the repo needs first: a command that signs a fake user in to the Sandbox's own server and writes a Playwright storage state to the file `FABRIK_STORAGE_STATE` names, one command for each kind of user, such as `owner`. Don't write that command, not even as a suggestion in a file: it's the Product repo's own code, which a Ticket can build. Once it's merged, they run `/fabrik-visual-evidence` again. Then stop.

Whichever the outcome, tell the Operator what's safe behind the seam (ADR-0012), since a sign-in command is the Product's code that the Kit runs:

- A sign-in only ever runs against the Sandbox's own server, with fake users, never a deployed environment or a real account. So with a sign-in, `ui.url` must be a loopback address, such as `http://localhost:4321` or `http://127.0.0.1:4321`, and the Kit config refuses any other.
- The sign-in commands get the env `ui.serve` gets, never `sandbox.secrets`, so a command can't need a real credential.
- A signed-in route has no Before, since `ui.before_url` is a deployed site these sessions can't reach and must not. Public routes keep their Before.

**Done when:** the Operator has said which of the three outcomes is this app's, and, for the third, you've told them what the repo needs and stopped.

## 3. Suggest the answers

Propose each answer from the repo (its framework, its `package.json` scripts, the port its server listens on, its production site), or from the `ui` and `preview` blocks `.fabrik/config.json` already has. Say where each suggestion came from, and have the Operator confirm or correct each one:

- `ui.paths`: globs of the files whose change makes a PR UI, such as `src/pages/**` and `src/components/**`.
- `ui.serve`: the command the Sandbox runs in the background, after `sandbox.build`, to serve the branch, such as `npm run preview`.
- `ui.url`: the local base URL that command serves on, such as `http://localhost:4321`. With a sign-in it must be a loopback address.
- `ui.before_url`, optional: the production site's base URL, which Before screenshots of the same routes are taken from. Without it Before is skipped, and the answer is `null`.
- `ui.default_routes`, optional: the routes captured when neither the Ticket nor the Implementer names any, each a path starting with `/`, such as `/`. Without them the answer is `[]`.
- `preview.url`, optional: where the repo's preview deployment for a PR appears, as a template that may use only `{pr}`, the PR's number, `{sha}`, its full head commit, and `{branch_slug}`, its branch in lower case with each run of characters other than `a` to `z` and `0` to `9` made one `-`, and no `-` at either end, so `fabrik/ticket-12` is `fabrik-ticket-12`. For example `https://deploy-preview-{pr}--<site>.netlify.app`. Before using `{branch_slug}`, check the host slugs a branch the same way: the Kit never shortens it, though a host may shorten a long one. Without it no preview is linked, and the answer is `null`.

When the app has a sign-in command, also suggest these three, from the repo's sign-in command, its routes and its auth middleware:

- `ui.sign_in`: each Capture identity, a named kind of fake user such as `owner` (letters, digits, `-` and `_`, starting with a letter or digit), and the command that signs it in, such as `{ "owner": "npm run sign-in -- owner" }`. At least one, and each command writes a storage state, cookies and localStorage, to `FABRIK_STORAGE_STATE`.
- `ui.sign_in_path`: the route the app sends a signed-out visitor to, such as `/login`. A signed-in page that lands there stops capture as `sign-in-failed`.
- `ui.signed_in_routes`: an ordered list of rules saying which Capture identity views a route, such as `{ "route": "/admin/**", "as": "owner" }`, the first rule to match winning. In a `route`, `*` matches within one path segment and `**` across segments, and `/**` matches `/` too. `as` is one of `ui.sign_in`'s identities, or `null` for a public route, and a route no rule matches is viewed signed out. Put the public routes' rules first when a later rule such as `/**` would cover them.

Then check with the Operator that `sandbox.build`, `ui.serve` and each sign-in command work without `sandbox.secrets`, which capture never gives them. If one needs a value, give it a non-secret stand-in in `sandbox.env`, or capture fails with `build-failed`, `server-did-not-start` or `sign-in-failed`.

**Done when:** the Operator has confirmed or corrected all six answers, and, with a sign-in command, the three sign-in fields too.

## 4. Write the answers

Download Fabrik at the release the repo pins into a temporary folder, so the writer checks the answers against the same Kit config rules the repo's Kit jobs read. Fabrik is public, so this needs no credentials:

```sh
FABRIK=$(mktemp -d)
curl -fsSL "https://codeload.github.com/jrey8343/fabrik/tar.gz/refs/tags/<release>" | tar -xzf - -C "$FABRIK" --strip-components=1
```

The change goes out on the branch `fabrik/visual-evidence`. Run `git fetch origin`, then look for an earlier run's open PR from it. Only a PR whose head is in this repo counts: `gh pr list --head` matches a fork's branch of the same name too, so look with `gh pr list --head fabrik/visual-evidence --state open --json number,url,isCrossRepository --jq '.[] | select(.isCrossRepository | not)'`, and never push to, edit or offer the Operator a PR from a fork.

- **An earlier run's PR is open:** switch to its branch with `git switch -C fabrik/visual-evidence origin/fabrik/visual-evidence`, and push to it in step 5.
- **Otherwise:** start the branch from the up-to-date default branch with `git switch -C fabrik/visual-evidence`. That also starts again a branch left from an earlier run whose PR was merged or closed, and loses nothing, since every run confirms its answers again.

Run the writer from the repo's root, with the confirmed answers on stdin as the `ui` and `preview` blocks, in JSON spelled as Kit config spells them. Give every answer, with `null` or `[]` for an optional one the Operator left out. Give the sign-in fields only with a sign-in command, `ui.sign_in` as an object and `ui.signed_in_routes` as a list of rules, in the Operator's order. The quoted `'EOF'` keeps the shell off the values:

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

With a sign-in command, the `ui` block also holds the three sign-in fields:

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
    ]
  },
  "preview": { "url": null }
}
EOF
```

It writes only those two blocks of `.fabrik/config.json`, in place or before its closing brace, printed as Prettier prints JSON, and keeps every other byte. A field of a block the file already has that the answers leave out keeps its value, so a `ui` block that signs in keeps its sign-in fields when the answers leave them out. An answer for `ui.sign_in` or `ui.signed_in_routes` replaces the field whole, so give every identity and every rule. What it prints decides what's next:

- **`Wrote the … to .fabrik/config.json.`** Go on to step 5.
- **`Nothing was written to .fabrik/config.json:`**, then one line per problem: the Kit config would refuse the answers, so nothing was written. Settle each problem with the Operator and run the writer again. A sign-in with a `ui.url` that isn't loopback is one: the Operator gives a loopback `ui.url`, never a deployed one.
- **`.fabrik/config.json already holds these answers, so nothing was written.`** Tell the Operator Visual evidence already has these answers, remove the branch and the temporary folder, and stop.

**Done when:** the writer has written the blocks, or says the Kit config already holds them.

## 5. Open the pull request

1. The writer prints for Prettier's default width, 80 columns. If the Product's own Prettier settings set another (`printWidth` in `.prettierrc` or in `package.json`'s `prettier` key, or `max_line_length` in `.editorconfig`), run the Product's own `prettier --write .fabrik/config.json`, so the PR passes its `prettier --check`.
2. Commit `.fabrik/config.json` alone. When step 4 found an earlier run's PR open, push with `git push origin fabrik/visual-evidence`, which updates that PR. Otherwise push with `git push --force-with-lease -u origin fabrik/visual-evidence`, which replaces a branch GitHub kept from a merged or closed PR, and open a PR to the default branch with `gh pr create`. Its body lists each answer, and says the check that `sandbox.build`, `ui.serve` and any sign-in command work without `sandbox.secrets` was made.
3. Remove the temporary Fabrik folder.
4. Tell the Operator to merge the PR themselves. The push job reads the `ui` block from the default branch, so capture starts on the first UI PR after the merge. Then tell them:
   - That with Visual evidence on, each PR whose diff touches `ui.paths` gets an evidence section linking an Evidence page of its screenshots, and the Reviewer sees them.
   - With a sign-in, that each signed-in screenshot names the Capture identity it was viewed as, and has no Before, and that a sign-in that fails, or a signed-in page that lands on `ui.sign_in_path`, shows in the evidence section as `sign-in-failed`.
   - That the merge is all it needs: Setup and its wizard needn't run again for it.
   - That running `/fabrik-visual-evidence` again changes its answers, and with the same answers it writes nothing.

**Done when:** the PR is open, and the Operator has its link.
