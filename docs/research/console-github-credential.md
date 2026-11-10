# The Console's GitHub credential: acting as the Operator

Research for Decision #509 on the Map #507 (Wayfinder: the Console). Sources were read on 2026-11-10. The Kit was read at commit `1b14902`. GitHub's permission tables were read from the data files behind docs.github.com (`github/docs` at `f309096a83`, REST API version `2026-03-10`).

**Question.** The Console merges, submits Request changes and sends pull requests back as the Operator, from a Cloudflare Worker. Which credential should make those writes: a GitHub App user access token (from a new App, or from the Fabrik App), an OAuth App token, or a fine-grained personal access token? And how does the Kit decide a merge, a review or a comment is the Operator's, so that a Console-made write is read exactly as one made in GitHub's own UI?

**Method.** The GitHub half is from GitHub's docs, the data files those docs are built from, and a few read-only calls to GitHub's public API to see what the docs don't state. The Kit half is from the code, with `file:line` references. Nothing was written to any repository to test a claim, so every claim about how GitHub treats a write is from the docs or from reading other people's public writes. What couldn't be confirmed is listed under "Uncertain or not verified".

## Answer in brief

1. **The Kit doesn't care which credential made a write.** Its only test of "the Operator's" is the author's login equal to the Kit config's `operator` (or else the repo's owner) and the author not being a bot. A review, comment, label or merge made with a GitHub App user access token, an OAuth App token or a fine-grained personal access token is authored by the Operator's own user account, so all of them pass. A Request changes made through the Console amends the Ticket and counts as a Human touch with **no change to the Loop**. Only a GitHub App *installation* token (a `[bot]` author) would fail, and none of the candidates is one.
2. **So the choice turns on GitHub's side, and a new GitHub App of the Console's own comes out ahead.** Its user access token carries only the permissions the App was given, only on the repos it is installed on, and lasts 8 hours with a refresh. The App's one webhook reaches the Worker for every installed repo with no per-repo setup. Its authorization flow doubles as the Console's sign-in. A fine-grained personal access token is the runner-up: the same narrow permissions and the least to build, but a standing secret the Operator re-mints by hand, with no webhook, no sign-in and no Checks API. An OAuth App token is ruled out: its only way to a private repo is the `repo` scope, which is full control of every repository the Operator can reach, and it never expires. Reusing the Fabrik App is ruled out too: it would add Actions: read to the App the Loop's push jobs use, hand that App's one webhook to the Console, and mark the Operator's merges as made through the agents' App.
3. **Send it back is not a close.** In the Kit, the Operator's write is adding the `needs-design` label to the agent pull request. The Kit then closes the pull request itself. A Console that closed the pull request would instead trip the "closed by hand" rule, which stops the Ticket as `ready-for-human` and starts no Design session.
4. **Two things need a prototype before an ADR records the choice.** Whether the Merge gate ruleset's admin bypass applies when the Operator acts through a GitHub App user access token: the docs don't say. And whether the merge API applies an admin's bypass of required checks without being asked, as the `gh` CLI's `--admin` flag implies: if so, the Console must check a pull request is mergeable before it offers the button.
5. **The Kit changes little.** Nothing in the Loop. One guess in Setup's wizard reads `performed_via_github_app` and would start naming the Console's App as a candidate Fabrik App once the Console posts a comment. And if the bypass check in point 4 fails, the Merge gate ruleset and Setup's check of it would have to change, or the Console falls back to a personal access token.

## Comparison

| | GitHub App user access token, new App for the Console | GitHub App user access token, the Fabrik App | OAuth App token | Fine-grained personal access token |
|---|---|---|---|---|
| **Author of a review, comment, label or merge** | The Operator's user account | The Operator's user account | The Operator's user account | The Operator's user account |
| **Marked as made through an app** | Yes. `performed_via_github_app` names the App on comments (seen) and is a field of issue events such as `merged` and `labeled`. The UI shows the user's avatar with the App's badge. The REST review object has no such field. | Same, naming the Fabrik App | No: OAuth apps "don't indicate that the action was performed by the app" | No app is involved |
| **Passes the Kit's Operator test** | Yes | Yes | Yes | Yes |
| **Lifetime and refresh** | 8 hours. A refresh token, good for 6 months, buys a new pair and is spent by doing so. Refreshing needs the App's client secret. Expiry can be switched off for the App, which GitHub advises against. | Same | No expiry. Lives until revoked, or a year unused. | 1 to 366 days or no expiry, chosen at creation (default 30 days). No refresh: the Operator mints a new one. Removed after a year unused. |
| **Narrowest permissions for the Merge-gate moves and the reads** | Contents: write, Pull requests: write, Actions: read, Issues: read, Metadata: read. Checks: read and Commit statuses: read if the Console shows check results. | The Fabrik App has Issues, Pull requests and Contents write and Checks: read. It lacks Actions: read, which would have to be added to the App the Loop uses. | `repo`: read and write on code, plus statuses, invitations, collaborators, deployments and repository webhooks. There is no narrower scope that reads a private repo. | Same as the new App, less Checks: fine-grained tokens can't call the Checks API. |
| **Which repositories** | Only those the App is installed on (the Product repos and `fabrik-runs`), and the same permissions on each | Those the Fabrik App is installed on | Every repository the Operator can reach | Selected repositories of one owner. Two tokens can give `fabrik-runs` read-only. |
| **Webhooks to the Worker** | The App's one webhook, pointed at the Worker, delivers for every installed repo. A new Product repo is covered on install. | The Fabrik App's one webhook, which the Kit doesn't use today, would become the Console's | None of its own. One repository webhook per repo, created by hand or through the API with a hooks scope, and not removed when the token is. | None of its own. One repository webhook per repo, created by hand, by Setup, or through the API with Webhooks: write. |
| **Signing in to the Console** | The authorization flow tells the Worker who signed in, so it can refuse anyone but the Operator | Same | Same | Nothing: the token is a Worker secret, and the Console needs its own guard |
| **What a leak exposes** | A leaked access token: the permissions above on the installed repos, for at most 8 hours. A leaked refresh token is useless without the client secret. Both, from the Worker: the same, until the Operator revokes the authorization. | Same reach, and the Fabrik App's client secret becomes a secret worth stealing | Everything the Operator can do in every repo, until revoked | The permissions above on the selected repos, until the token expires or is deleted |

Every candidate acts with Contents: write as the Operator, because GitHub's merge endpoint asks for exactly that. The Operator is the Merge gate ruleset's bypass actor, so a leaked credential of any of these kinds can do more than merge: see "What a leak exposes".

## 1. How the Kit decides a write is the Operator's

**Who the Operator is.** The Kit config's `operator` key is a GitHub login, or null (`src/kit/config.ts:63-64`, default null at `:385`, read at `:595`). Null means the Product repo's owner (`src/github/snapshot.ts:551`, `:1388`, `:1422`). A Console that asks "is this the Operator?" has to resolve it the same way.

**The test, everywhere, is login plus "not a bot".** Nothing in `src/`, `prompts/` or `templates/` reads `performed_via_github_app`, a token type or an app identity when it weighs a review, a comment, a label or a merge. The caller workflow and `loop.yml` have no `github.actor` or `sender` conditions.

| The Operator's write | Where the Kit reads it | The test | Reference |
|---|---|---|---|
| Request changes, as it arrives | The `pull_request_review` event's `review.user.login` and `review.user.type` | Not a bot, and the login is the Operator's. Anyone else's starts nothing. | `src/github/events.ts:81-97`, `src/loop/mergeGate.ts:27` |
| Request changes GitHub never delivered (ADR-0015) | GraphQL `reviews(states: [CHANGES_REQUESTED]) { author { login __typename } }` | The same | `src/github/snapshot.ts:187`, `:1488-1492`, `src/loop/undelivered.ts:24-26` |
| Request changes as the amended Ticket (ADR-0010), given to every later Implementer and Reviewer run | REST `/pulls/{n}/reviews` and `/pulls/{n}/comments` | `user.login === operator && user.type !== "Bot"` | `src/agent/inputs.ts:338`, `:367-368` |
| Request changes shown to the Design session after Send it back | REST `/pulls/{n}/reviews` | `user.login === operator`, any submitted state | `src/agent/inputs.ts:272-277` |
| Request changes as a Human touch, and as a Review miss | GraphQL reviews, the author's login | `review.author === operator` and the state is changes-requested | `src/github/facts.ts:296`, `:632`, `src/kit/retroEvidence.ts:278-280`, `:439` |
| Operator comment, as it arrives (the 👀) | `issue_comment`, or a `pull_request_review` whose state is commented or approved | Not a bot, and the login is the Operator's | `src/github/events.ts:39-45`, `:86-88`, `:106-113`, `src/loop/acknowledge.ts:10-18` |
| Operator comment, as an agent run's input | REST conversation comments, inline comments and reviews | `user.login === operator && user.type !== "Bot"` | `src/agent/inputs.ts:338-366` |
| Send it back | `pull_request_target` `labeled` with `needs-design` | **None.** Whoever adds the label to an open agent pull request sends it back. | `src/github/events.ts:66-69`, `src/loop/rules.ts:139-142`, `src/loop/mergeGate.ts:207-211`, `src/loop/backToDesign.ts:27-45` |
| A pull request closed unmerged | `pull_request_target` `closed`, the payload's `sender.type` | Closed by a bot: nothing. Closed by a person: the Ticket stops as `ready-for-human`. | `src/github/events.ts:72-76`, `src/loop/handClosing.ts:36-54` |
| Merge | `pull_request_target` `closed` with `merged: true`, then the Ticket's `issues` `closed` | **None in the Kit.** GitHub enforces it: the `Fabrik Merge gate` ruleset lets only the repo admin role update the default branch. | `src/github/events.ts:73`, `src/loop/handClosing.ts:42`, `src/loop/rules.ts:127-134`, `src/setup/plan.ts:199-202`, `src/setup/apply.ts:69-84` |
| A Design-session answer (not a Console move in the first version) | `issue_comment` on a `needs-design` issue | Not a bot, and the login is the Operator's | `src/loop/design.ts:140-148` |

**What each credential's writes look like to those tests.** GitHub says a GitHub App user access token's requests "will be attributed to that user", and an OAuth app's token "identifies the app as the user who signed into the app". A personal access token is the user's own. So under all three, `user.type` is `User`, GraphQL's `__typename` is `User`, and the login is the Operator's. Every row above passes.

This was checked against GitHub's API rather than taken on trust. On 2026-11-10, the latest 100 issue comments of three busy public repositories each held comments whose `user.type` was `User`, whose login had no `[bot]`, and whose `performed_via_github_app` named a third-party GitHub App. That is what a user access token's write looks like: a person as the author, with the App recorded beside them. GraphQL shows nothing of the App: `IssueComment` and `PullRequestReview` have no app field (introspected the same day), and the Kit's snapshot reads only `author { login __typename }`.

So:

- **A Request changes made through the Console amends the Ticket exactly as one made in GitHub does**, under any of the three. The event path, ADR-0015's undelivered path and the agents' inputs all key on the same login.
- **It counts as a Human touch**, under any of the three (`src/kit/retroEvidence.ts:278-280`).
- **Events caused by any of the three start the Kit's workflows.** GitHub's only stated exception is the workflow's own token: "events triggered by the `GITHUB_TOKEN` will not create a new workflow run". The same page shows a label added with a personal access token starting a workflow.
- **A Request changes on a pull request that conflicts with `main` still reaches the Loop late**, whichever credential made it: GitHub starts no workflow for it, and the Kit finds it on the next push to `main` or hourly tick (ADR-0015). The Console can't shorten that, and should say so on screen rather than look stuck.

**Send it back.** The glossary describes the move by its outcome: the pull request closes unmerged and the Ticket goes to a Design session. The write that causes it is the label. `README.md:229` says so: "adding `needs-design` to an open agent PR takes the Design-flaw route". The Kit closes the pull request with the Fabrik App's token, so `closedByBot` is true and the hand-closing rule stays quiet. If the Console closed the pull request with the Operator's credential, `sender.type` would be `User`, and `stopTicketOf` would swap the Ticket to `ready-for-human` and assign the Operator (`src/loop/handClosing.ts:42-53`). So the Console's Send it back is `POST /repos/{owner}/{repo}/issues/{n}/labels` with `needs-design`, which Pull requests: write covers. It needs no permission to close anything.

## 2. Attribution on GitHub

- **GitHub App user access token.** "API requests made by an app on behalf of a user will be attributed to that user." For a comment, "the GitHub UI will show the user's avatar photo along with the app's identicon badge as the author". The audit and security logs "will list the user as the actor" and state the `programmatic_access_type` as "GitHub App user-to-server token". ([Authenticating with a GitHub App on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user))
- **OAuth App token.** It acts as the user, and OAuth apps "don't indicate that the action was performed by the app". ([Deciding when to build a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app), [Differences between GitHub Apps and OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps))
- **Fine-grained personal access token.** The user's own credential. No app is recorded.

By kind of write:

| Write | Author field | Where an App shows |
|---|---|---|
| Comment | `user` | `performed_via_github_app` on the comment (seen set on user-authored comments) |
| Review | `user` | Nowhere in REST: the review schema has no `performed_via_github_app`. Whether the UI badges a review isn't stated. |
| Merge | The pull request's `merged_by` | The `merged` issue event has a `performed_via_github_app` field (seen on a merged pull request, null for a merge made without an App) |
| Label | The event's `actor` | The `labeled` issue event, the same field |

The marking is a point in the App's favour, not against it. It lets a later reader, or the Console itself, tell a Console-made merge from one made on github.com, while the Kit, which never looks, treats both alike.

## 3. Lifetime and refresh

- **GitHub App user access token.** "The user access token expires after eight hours" and "the refresh token expires after six months". "Once you use a refresh token, that refresh token and the old user access token will no longer work." Refreshing is a `POST` to `https://github.com/login/oauth/access_token` with `client_id`, `client_secret`, `grant_type` and `refresh_token`. Expiry is on "unless you opt out", under the App's optional feature "User-to-server token expiration". The tokens start `ghu_` and `ghr_`. The web flow supports PKCE (`code_challenge` with `S256`) and still requires the client secret at the exchange. ([Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens), [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app))
  - For a Worker this means the token pair is state, not a secret set once. Two requests that refresh at the same moment would each spend the same refresh token, and one would be left holding a dead pair. The refresh has to be made by one writer at a time, and the new pair stored before the old one is forgotten. A Console used at least once in six months never asks the Operator to sign in again. How Cloudflare storage gives that guarantee belongs to the Cloudflare research.
- **OAuth App token.** "OAuth app tokens do not expire until the person who authorized the OAuth app revokes the token." GitHub also revokes one unused for a year, and the oldest when an app holds more than ten for one user and scope. ([Token expiration and revocation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation))
- **Fine-grained personal access token.** Expiry is 1 to 366 days, or none ("Infinite lifetimes are allowed but may be blocked by a maximum lifetime policy"), default 30 days. There is no refresh. When it lapses, the Console stops until the Operator mints another and stores it as a Worker secret. GitHub's own advice: "For long-lived integrations, you should use a GitHub App." ([Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens))

All three count against the Operator's own 5,000 requests an hour, shared with everything else they run under their account. ([Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api))

## 4. The narrowest permissions

From the permission sets GitHub's REST reference is built from. The same sets apply to a GitHub App user access token and a fine-grained personal access token, and each endpoint below accepts both.

| What the Console does | Endpoint | Permission |
|---|---|---|
| Merge | `PUT /repos/{owner}/{repo}/pulls/{n}/merge` | Contents: write |
| Request changes, with inline comments | `POST /repos/{owner}/{repo}/pulls/{n}/reviews` (`event: REQUEST_CHANGES`, a `body`, `comments[]`) | Pull requests: write |
| Send it back | `POST /repos/{owner}/{repo}/issues/{n}/labels` | Issues: write **or** Pull requests: write |
| An Operator comment, if the Console ever posts one | `POST /repos/{owner}/{repo}/issues/{n}/comments` | Issues: write **or** Pull requests: write |
| Read pull requests, reviews and their comments | `GET .../pulls`, `.../pulls/{n}/reviews`, `.../issues/{n}/comments` | Pull requests: read |
| Read Tickets, Specs and Kit-owned issues | `GET .../issues` | Issues: read |
| Read files in a private Product repo and in `fabrik-runs` | `GET .../contents/{path}` | Contents: read |
| Runs in flight, their jobs and logs | `GET .../actions/runs`, `.../runs/{id}/jobs`, `.../jobs/{id}/logs` | Actions: read |
| UI evidence artifacts | `GET .../actions/artifacts/{id}/{format}` | Actions: read |
| Check results on a head | `GET .../commits/{ref}/check-runs` | Checks: read. Not open to fine-grained personal access tokens. |
| Commit statuses on a head | `GET .../commits/{ref}/status` | Commit statuses: read |

So the smallest set that covers the Merge-gate moves and the reads is **Contents: write, Pull requests: write, Actions: read, Issues: read, Metadata: read** (Metadata: read comes with any repository permission; that is from memory, not re-read today). Checks: read and Commit statuses: read are needed only if the Console shows check results other than through Actions runs.

Three limits on narrowing it further:

- **Merging needs Contents: write, and nothing less merges.** That same permission lets its holder push to branches. Neither a GitHub App nor a fine-grained token can hold "merge, but not push".
- **Without the Workflows permission, GitHub refuses a push that touches `.github/workflows/`.** ADR-0002 leans on this for the Fabrik App, and the same holds for a Console credential that isn't given it. An OAuth App token needs the separate `workflow` scope for the same thing.
- **Permissions are per credential, not per repository.** An App has one permission set on every repo it's installed on, so `fabrik-runs` gets Contents: write along with the Product repos, though the Console only reads it. A fine-grained token has one set across its selected repos too, but the Operator can mint two: one for the Product repos, and a read-only one for `fabrik-runs`. The App route could do the same for the store alone: leave the App off `fabrik-runs` and read it with a read-only fine-grained token. That keeps Run records out of a leaked Console token's reach, at the price of a second credential that expires by the calendar.

**OAuth App.** The `repo` scope "Grants full access to public and private repositories including read and write access to code, commit statuses, repository invitations, collaborators, deployment statuses, and repository webhooks". There is no read-only scope for a private repository, and no way to name repositories: "Authorizing an OAuth app grants the app access to the user's accessible resources." ([Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps))

**The Fabrik App.** It holds Issues, Pull requests and Contents write and Checks: read, and "no `workflows`" (`README.md:75`, ADR-0002). It has no Actions permission: the Kit reads workflow runs with a job's own read-only token for that reason (`src/github/snapshot.ts:490-491`). Its user access token could make every Merge-gate move today, but couldn't read runs in flight until Actions: read was added to the App, which the Operator would have to accept on every installation and which every installation token the push jobs mint could then ask for.

## 5. How webhooks reach the Worker

- **A GitHub App has one webhook.** "Each app has exactly one webhook", which is created with the App, starts with no subscriptions, and can be deactivated but not deleted. It fires for "the repositories or organizations where the app has been granted access". The events on offer follow the App's permissions: `pull_request` and `pull_request_review` need Pull requests, `issues` and `issue_comment` need Issues, `workflow_run` and `workflow_job` need Actions, `check_run` needs Checks, `push` needs Contents, `status` needs Commit statuses, each at read. ([Types of webhooks](https://docs.github.com/en/webhooks/types-of-webhooks), [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)) Note `issue_comment`: a comment on a pull request arrives only with Issues: read, which the set above has.
- **An OAuth App or a personal access token has none.** "OAuth apps request the webhook scope to create a repository webhook for each repository they need to receive events from", and those hooks aren't removed when the token is. With a personal access token, each Product repo needs a repository webhook pointed at the Worker, created by hand in the repo's settings, by Setup, or by the Worker through `POST /repos/{owner}/{repo}/hooks`, which needs Webhooks: write (another permission on the Console's token). A repository takes up to 20 webhooks per event. Every new Product repo is one more hook to remember.
- **Either way, deliveries are signed and not retried.** GitHub signs each delivery with the webhook's secret as an HMAC SHA-256 in `X-Hub-Signature-256`, the same for an App's webhook and a repository's, and "does not automatically redeliver failed webhook deliveries". ([Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)) Listing or redelivering an App's deliveries (`/app/hook/deliveries`) needs a JWT signed with the App's private key. A user access token can't call it. A Worker that holds no private key therefore rebuilds a missed event by reading the REST API, not by asking for redelivery. That fits "anything the Console stores is a cache that can be deleted and rebuilt".
- **The Kit's own events are untouched.** The Loop runs on Actions events in each Product repo and uses no webhook, so the Console's webhook is a second, independent listener, and the Loop never depends on it.

## 6. What a leak exposes

The Worker would hold, under the App route: the client secret and the webhook secret as Worker secrets, and the current access and refresh tokens in storage. Under the token route: the personal access token as a Worker secret, and a webhook secret per repo.

- **Any of the three, with Contents: write as the Operator, is more than a merge button.** The Merge gate ruleset's only bypass actor is the repo admin role (`src/setup/plan.ts:201-202`), and the Operator is the admin. Branch protection asks for a pull request and green checks, but Setup leaves admin enforcement as it finds it, and "unless the branch already enforces its rules for admins, the Operator, as the repo's admin, can still merge past them" (`README.md:70`). So a stolen credential that acts as the Operator can merge any pull request, push to agent branches, and, where admins aren't held to the rules, push to `main`, which holds the trust-root files. It can read every private file and every transcript in `fabrik-runs`. What it can't do without more permissions: change workflows, repo settings, rulesets, secrets or webhooks. This is the first standing credential outside the Operator's own devices that can update `main`. ADR-0002 keeps such a credential out of every agent job, and the Console's Worker is now where one lives.
- **GitHub App user access token.** A leaked access token is good for at most 8 hours, on the installed repos only. A leaked refresh token can't be spent without the client secret. Someone who takes both from the Worker holds the access until the Operator revokes the App's authorization ("any tokens associated with the authorization will be revoked as well") or rotates the client secret. If the App's private key is never generated, nothing can act as the App itself: the key is created after registration, not with it, and only installation tokens need it. (GitHub's page implies but doesn't state that an App may have no key.)
- **The Fabrik App's user access token.** The same reach. But the Fabrik App's client secret, which nothing stores today (the wizard keeps its `client-id` and `private-key`, `README.md:75`), would become a secret that, with the Operator's authorization, merges. Today's sentence "the Fabrik App, never an admin, can't" merge (`README.md:71`) would hold only for its installation tokens.
- **OAuth App token.** Everything the Operator can do in every repository they can reach, with no expiry.
- **Fine-grained personal access token.** The granted permissions on the selected repos, until the token's expiry date or until the Operator deletes it. A long expiry is a long exposure, and a short one is a Console that stops working every month.
- **All of them** are revoked by GitHub when found in a public repository or gist, and anyone can revoke a token they come across through the credential revocation API.

Whichever is chosen, the credential should stay in the Worker and never reach the installed PWA: the browser holds a session with the Worker, and the Worker holds GitHub. That is for the "guarding a deployment" Decision, not this one.

## 7. Recommendation

**Register a new, private GitHub App for the Console, owned by the Operator's account, and act through its user access token.** (A private App "can only be installed on the account that owns the app".)

- Permissions: Contents: write, Pull requests: write, Actions: read, Issues: read, Metadata: read, and Checks: read if check results are shown. No Workflows, no Administration.
- Installed on each Product repo and on `fabrik-runs`, or left off `fabrik-runs` with a read-only token for the store (section 4).
- Token expiry left on. No private key generated.
- The App's webhook pointed at the Worker, subscribed to the events the cache needs.
- The authorization flow as the Console's sign-in: the Worker accepts the session only when the signed-in login is the Operator's.

Why this over the others:

- **Over the Fabrik App.** The Console and the Loop stay separate: no new permission on the App the push jobs mint tokens from, no claim on its one webhook, and a marking on the Operator's writes that names the Console rather than the agents' App. Revoking the Console never touches the Loop.
- **Over an OAuth App.** Narrow permissions on named repos instead of `repo` on everything, and tokens that expire.
- **Over a fine-grained personal access token.** One webhook instead of one per repo, a refresh instead of a yearly re-mint, a sign-in for free, the Checks API, and writes that can be told from the Operator's own. The token route is still sound, and it is the fallback if the bypass check below fails: it is certain to act as the Operator's own account, and it costs no flow to build.

The decision belongs to a later ticket, and two things should be tried on a throwaway repo first:

1. **Does the Merge gate ruleset let the Operator merge through the App's user access token?** The ruleset's rule is `update` on the default branch with the admin role as its one bypass actor, `always` (`src/setup/apply.ts:72-80`). GitHub says only that the bypass list holds roles, teams and GitHub Apps, and that a user access token's requests are attributed to the user. It doesn't say the user's role bypass carries through an App. If it doesn't, the merge is refused and the choice is between the token route and adding the Console's App to the bypass list.
2. **Does `PUT .../merge` merge past unmet required checks for an admin without being asked?** GitHub's UI makes an admin tick a box to bypass. The `gh` CLI's `--admin` flag ("Use administrator privileges to merge a pull request that does not meet requirements") suggests the API applies the bypass on its own. If so, the Console's merge button must read the pull request's mergeable state first and refuse a pull request whose checks aren't green, or it turns a mis-tap into a bypass.

## 8. What would change in the Kit

**For the Loop: nothing.** Every Operator test passes as it stands (section 1).

**Whatever the credential:**

- **The Console's Send it back adds `needs-design` to the pull request and closes nothing.** No Kit change. A Spec for the Console should say it, because the glossary's wording ("closes an agent pull request unmerged") reads as though the Operator closes it.
- **The Console resolves the Operator as the Kit does:** the Kit config's `operator`, or else the repo's owner. Otherwise the Console's sign-in and the Kit's tests could name different people.
- **Send it back and the merge have no Operator test in the Kit.** Anyone who can label a pull request can send it back, and the merge is guarded by GitHub alone. That is unchanged by the Console, and worth knowing when its guard is designed: on those two moves the Kit won't catch a write the Console shouldn't have made.

**If the Console gets its own GitHub App:**

- **Setup's wizard guesses the Fabrik App's slug from `performed_via_github_app`** (`src/setup/wizard.sh:236-255`): it lists every App owned by the signed-in user that made one of the latest 100 comments or issues in the repo or in `fabrik-runs`, and offers a lone match as "likely the Fabrik App" (`src/setup/wizard.sh:298-301`). A Console App is owned by the Operator, and a comment the Operator posts through it carries its slug. With both found, the wizard already falls back to asking. With only the Console's found, it would offer the wrong App. Counting only comments and issues whose author is a bot fixes it. Reviews, merges and labels aren't read there, so this bites only once the Console posts comments or files issues.
- **If the ruleset bypass doesn't carry through the App** (check 1 above), the Merge gate would need the Console's App on the ruleset's bypass list. Setup would then have to write that, and stop treating it as drift: it repairs any ruleset whose bypass actors aren't exactly the admin role (`src/setup/plan.ts:625-640`). The README's "only repo admins may update the default branch" would no longer be the whole rule. That is a real cost, and a reason to prefer the token route in that case.
- **`README.md:75` and ADR-0002 list the Fabrik App's permissions.** A second App is a second list to document, and one more thing for the Operator to install on each new Product repo.

**If the Fabrik App were reused instead:** Actions: read on the App (ADR-0002's permission list, the wizard's stage 1 text at `src/setup/wizard.sh:290-292` and `:312-317`, and the note at `src/github/snapshot.ts:490-491`), a client secret to store, and the README's Merge gate wording.

## What the Map's Notes assume that this doesn't bear out

- **"Send it back" as a close.** It is a label (section 1).
- **"A small Cloudflare Worker … that receives GitHub webhooks"** costs nothing extra under a GitHub App and one hook per Product repo under a token. The credential choice and the webhook choice are one choice.
- **"Kit config already carries `operator`."** It does, but it is null by default and then means the repo's owner.
- **"Every action it takes is an ordinary GitHub write made as the Operator."** True of the author under every candidate. Under a GitHub App the write also carries the App's name, which the Kit ignores and Setup's wizard, in one place, does not.

## Uncertain or not verified

- **Ruleset bypass through a GitHub App user access token.** Not stated in GitHub's docs, and not tested. See check 1.
- **The merge API applying an admin's bypass unasked.** Inferred from the `gh` CLI's manual, not from the REST reference, and not tested. See check 2.
- **`sender` in an Actions event caused by a user access token.** GitHub's docs say such requests are attributed to the user and that `sender` is "the user who triggered the event". No payload from a user-access-token write was read. The comment sample shows `user.type: "User"` on the write itself, which is what the Kit's review and comment tests read.
- **Workflows starting for user-access-token and OAuth-token events.** GitHub names only `GITHUB_TOKEN` as the exception and shows a personal access token starting one. The other two are by that rule, not by a sentence that names them.
- **`performed_via_github_app` on a `merged` or `labeled` event made through an App.** The field is there on those events. Only on comments was it seen set beside a user author.
- **Whether GitHub's UI badges a review or a merge made through an App.** The docs' example is an issue.
- **Requesting changes through an App on a pull request another App's bot opened.** No rule against it was found, and the author (a bot) and the reviewer (the Operator) are different accounts. Not tested.
- **An App with no private key.** Implied by "After you create a GitHub App, you'll need to generate a private key", not stated.
- **Whether the Fabrik App's webhook is active today.** The repo doesn't say. The Kit uses none.
- **One-year removal of an unused fine-grained token.** GitHub states it for personal access tokens in general, in the classic-token section.

## Sources

GitHub docs, read 2026-11-10:

- [Authenticating with a GitHub App on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)
- [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [Managing private keys for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
- [Deciding when to build a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app)
- [Making a GitHub App public or private](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private)
- [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)
- [Differences between GitHub Apps and OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)
- [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Token expiration and revocation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation)
- [Triggering a workflow](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)
- [Types of webhooks](https://docs.github.com/en/webhooks/types-of-webhooks), [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)
- [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets), [Creating rulesets for a repository](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository), [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [REST: pull request reviews](https://docs.github.com/en/rest/pulls/reviews), [pull requests](https://docs.github.com/en/rest/pulls/pulls), [issue comments](https://docs.github.com/en/rest/issues/comments)
- [`gh pr merge`](https://cli.github.com/manual/gh_pr_merge)

GitHub's data behind those docs, `github/docs` at `f309096a83`:

- `src/github-apps/data/fpt-2026-03-10/fine-grained-pat-permissions.json`, `server-to-server-permissions.json`, `user-to-server-rest.json` and `fine-grained-pat.json`: which permission each endpoint needs, and which token types may call it.
- `src/rest/data/fpt-2026-03-10/pulls.json`, `issues.json` and `apps.json`: each endpoint's permission sets (`progAccess`), where the "Issues or Pull requests" alternatives and the JWT-only webhook delivery endpoints come from.

GitHub's API, read-only, 2026-11-10:

- `GET /repos/{owner}/{repo}/issues/comments?per_page=100` on three public repositories: comments with a `User` author and a non-null `performed_via_github_app`.
- `GET /repos/{owner}/{repo}/issues/{n}/events` on a merged pull request in this repo: `merged`, `closed` and `head_ref_deleted` events each carry a `performed_via_github_app` field.
- GraphQL introspection of `IssueComment` and `PullRequestReview`: no app field on either.

The Kit, at `1b14902`: the files referenced inline, with `GLOSSARY.md`, `README.md` and ADR-0002, ADR-0007, ADR-0010 and ADR-0015.
