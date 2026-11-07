---
name: fabrik-visual-evidence
description: Turn on Visual evidence in a Product repo, or change its answers, suggesting each from the repo and opening a PR that writes them into the Kit config. Run as /fabrik-visual-evidence from the Product repo's checkout.
disable-model-invocation: true
---

# Visual evidence

The Operator is turning on Visual evidence in this Product repo, or changing its answers. On a pull request whose diff touches the repo's UI, the Implement job screenshots the routes the change shows on, at mobile and desktop widths. The PR links a gallery of them, and the Reviewer sees them. Your job is to suggest each answer from the repo, have the Operator confirm or correct each one, write them with the Kit's writer program, and open a PR for the Operator to merge.

This session runs with the Operator's own GitHub credentials and counts as the Operator, so you may change `.fabrik/config.json`, a Trust-root file no agent elsewhere touches. That's why no agent can turn Visual evidence off or narrow its paths. The writer needs no `gh` admin and no `op`. If `gh auth status` fails, stop and tell the Operator before doing anything else.

Read `GLOSSARY.md` and `docs/adr/` if they exist, and use the repo's terms.

## 1. Check where you are

Stop and tell the Operator what's missing if any of these fails:

- The working directory is the root of the Product repo's clone (`git rev-parse --show-toplevel`), on its default branch, up to date with `origin`, with a clean working tree (`git status --porcelain` prints nothing).
- The Kit is set up here: `.fabrik/config.json` exists, and `.github/workflows/fabrik.yml` pins a Fabrik release, the tag after `@` in its `uses: jrey8343/fabrik/…@<release>` lines. Without them, the Operator runs Setup first.
- `node --version` is 24 or later.

**Done when:** each check passes, and you know the release the repo pins.

## 2. Suggest the answers

Propose each answer from the repo (its framework, its `package.json` scripts, the port its server listens on, its production site), or from the `ui` and `preview` blocks `.fabrik/config.json` already has. Say where each suggestion came from, and have the Operator confirm or correct each one:

- `ui.paths`: globs of the files whose change makes a PR UI, such as `src/pages/**` and `src/components/**`.
- `ui.serve`: the command the Sandbox runs in the background, after `sandbox.build`, to serve the branch, such as `npm run preview`.
- `ui.url`: the local base URL that command serves on, such as `http://localhost:4321`.
- `ui.before_url`, optional: the production site's base URL, which Before screenshots of the same routes are taken from. Without it Before is skipped, and the answer is `null`.
- `ui.default_routes`, optional: the routes captured when neither the Ticket nor the Implementer names any, each a path starting with `/`, such as `/`. Without them the answer is `[]`.
- `preview.url`, optional: where the repo's preview deployment for a PR appears, as a template that may use only `{pr}`, the PR's number, `{sha}`, its full head commit, and `{branch_slug}`, its branch in lower case with each run of characters other than `a` to `z` and `0` to `9` made one `-`, and no `-` at either end, so `fabrik/ticket-12` is `fabrik-ticket-12`. For example `https://deploy-preview-{pr}--<site>.netlify.app`. Before using `{branch_slug}`, check the host slugs a branch the same way: the Kit never shortens it, though a host may shorten a long one. Without it no preview is linked, and the answer is `null`.

Then check with the Operator that `sandbox.build` and `ui.serve` work without `sandbox.secrets`, which capture never gives them. If either needs a value, give it a non-secret stand-in in `sandbox.env`, or capture fails with `build-failed` or `server-did-not-start`.

### Pages behind a sign-in

Capture opens a plain browser, so a route behind a sign-in screenshots the sign-in page, and it reads as a clean page. The Kit signs in through its own seam (ADR-0012): a sign-in command for each Capture identity, which only ever runs against the Sandbox's own server, with fake users, never a deployed site. So:

- A sign-in needs `ui.url` to be a loopback address, such as `http://localhost:4321` or `http://127.0.0.1:4321`.
- The sign-in commands get the env `ui.serve` gets, never `sandbox.secrets`.
- A signed-in route has no Before, since `ui.before_url` is a deployed site these sessions can't reach and must not. Public routes keep their Before.

Until Kit config can name this repo's sign-in command, Visual evidence stays off for an app whose pages sit behind a sign-in. When the repo shows that's this app (a sign-in redirect, auth middleware, a session check on its pages), confirm it with the Operator. If it is, tell them every signed-in route would screenshot the sign-in page, write nothing, and stop.

**Done when:** the Operator has confirmed or corrected all six answers, and the pages capture will show are public.

## 3. Write the answers

Download Fabrik at the release the repo pins into a temporary folder, so the writer checks the answers against the same Kit config rules the repo's Kit jobs read. Fabrik is public, so this needs no credentials:

```sh
FABRIK=$(mktemp -d)
curl -fsSL "https://codeload.github.com/jrey8343/fabrik/tar.gz/refs/tags/<release>" | tar -xzf - -C "$FABRIK" --strip-components=1
```

The change goes out on the branch `fabrik/visual-evidence`. Run `git fetch origin`, then look for an earlier run's open PR from it. Only a PR whose head is in this repo counts: `gh pr list --head` matches a fork's branch of the same name too, so look with `gh pr list --head fabrik/visual-evidence --state open --json number,url,isCrossRepository --jq '.[] | select(.isCrossRepository | not)'`, and never push to, edit or offer the Operator a PR from a fork.

- **An earlier run's PR is open:** switch to its branch with `git switch -C fabrik/visual-evidence origin/fabrik/visual-evidence`, and push to it in step 4.
- **Otherwise:** start the branch from the up-to-date default branch with `git switch -C fabrik/visual-evidence`. That also starts again a branch left from an earlier run whose PR was merged or closed, and loses nothing, since every run confirms its answers again.

Run the writer from the repo's root, with the confirmed answers on stdin as the `ui` and `preview` blocks, in JSON spelled as Kit config spells them. Give every answer, with `null` or `[]` for an optional one the Operator left out. The quoted `'EOF'` keeps the shell off the values:

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

It writes only those two blocks of `.fabrik/config.json`, in place or before its closing brace, printed as Prettier prints JSON, and keeps every other byte. A field of a block the file already has that the answers leave out keeps its value. What it prints decides what's next:

- **`Wrote the … to .fabrik/config.json.`** Go on to step 4.
- **`Nothing was written to .fabrik/config.json:`**, then one line per problem: the Kit config would refuse the answers, so nothing was written. Settle each problem with the Operator and run the writer again.
- **`.fabrik/config.json already holds these answers, so nothing was written.`** Tell the Operator Visual evidence already has these answers, remove the branch and the temporary folder, and stop.

**Done when:** the writer has written the blocks, or says the Kit config already holds them.

## 4. Open the pull request

1. Commit `.fabrik/config.json` alone. When step 3 found an earlier run's PR open, push with `git push origin fabrik/visual-evidence`, which updates that PR. Otherwise push with `git push --force-with-lease -u origin fabrik/visual-evidence`, which replaces a branch GitHub kept from a merged or closed PR, and open a PR to the default branch with `gh pr create`. Its body lists each answer, and says the check that `sandbox.build` and `ui.serve` work without `sandbox.secrets` was made.
2. Remove the temporary Fabrik folder.
3. Tell the Operator to merge the PR themselves. The push job reads the `ui` block from the default branch, so capture starts on the first UI PR after the merge. Then tell them:
   - That with Visual evidence on, each PR whose diff touches `ui.paths` gets an evidence section linking a gallery of its screenshots, and the Reviewer sees them.
   - That the setup wizard's "Visual evidence" stage says it's on once the PR is merged.
   - That running `/fabrik-visual-evidence` again changes its answers, and with the same answers it writes nothing.

**Done when:** the PR is open, and the Operator has its link.
