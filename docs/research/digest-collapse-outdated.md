# Collapsing an older Digest as outdated, with the credential the Kit comments with

Research for #570. It comes from rule 17 of the decision on #519: the current Digest is the newest one whose head is the pull request's head, and older ones are collapsed as outdated. Nobody had checked that the Kit can do that.

**Question.** Can the Kit collapse an older Digest as outdated with the credential its push job already comments with, is a collapsed Digest still readable through the API, and can the collapse be undone without noise on the pull request?

Everything below was read on 2026-11-11. Nothing was tried against a live repo and nothing was written anywhere. Three kinds of evidence are used and each claim says which:

- **Documented**: GitHub's own docs, its published GraphQL schema or its published REST description says it.
- **Read from source**: the code of the Kit, or of an Action or App that hides comments, says it.
- **Observed**: read-only API calls against one public pull request whose workflow hides its own comments (`cilium/tetragon` #4994). This is reading public data, not a trial.

Anything else is marked **inferred** or **not verified**.

## Answer in brief

1. **The call is the GraphQL mutation `minimizeComment`, with `classifier: OUTDATED`.** It takes the comment's node ID. There is no REST form: the REST API can read that a comment is minimized, but has no endpoint that minimizes one. Documented.
2. **An installation token can make the call on its own pull request comment.** GitHub does not document which permission the mutation needs. The evidence is source and observation: a workflow `GITHUB_TOKEN`, which is itself an App installation token, minimized its own pull request comment as outdated while holding only `pull-requests: write`; and Atlantis does the same as a GitHub App whose permissions include Issues and Pull requests write. So Pull requests write is enough for a comment on a pull request. Issues write alone was not isolated.
3. **The Kit's push job comments with the Fabrik App's installation token, minted with every permission the installation has.** The Kit declares those as Issues, Pull requests and Contents read and write, plus Checks read and Actions read. That covers the call. The Kit holds the needed permission as it stands. Read from source.
4. **A minimized comment is still returned whole.** REST and GraphQL both return its full body, and both say it is minimized and why: REST as `minimized: { "reason": "outdated" }`, GraphQL as `isMinimized` and `minimizedReason`. Documented for the fields, observed for the body.
5. **It can be undone with `unminimizeComment`.** No timeline event and no webhook action exists for minimizing, and GitHub documents no notification for it. One side effect was observed: minimizing moves the comment's `updated_at`.

**Bottom line.** The Kit can collapse older Digests as it stands. The Digest's Spec needs no new permission on the Fabrik App. It needs three small things in Kit code: the older Digests' node IDs, one `minimizeComment` call per older Digest, and a failure of that call treated as harmless, since rule 17 finds the current Digest by its head either way.

## How it was read

| Source | Pinned at |
| --- | --- |
| GitHub's public GraphQL schema, `https://docs.github.com/public/fpt/schema.docs.graphql` | fetched 2026-11-11 |
| GitHub's REST description, `github/rest-api-description`, `descriptions/api.github.com/api.github.com.json` (version 1.1.4) | commit `e59da575720241498e75762a659b7ccb86e512fa`, 2026-11-11 |
| GitHub's docs source, `github/docs` | `main` at `b1faf75dbd3e7627ecdfaab5241b91953e308ddb`, 2026-11-11 |
| `marocchino/sticky-pull-request-comment` (latest release v3.0.5) | `main` at `28ad303d6acb4ccfc50f20c0044188e7e294b8c4` |
| `runatlantis/atlantis` | `main` at `dcbc0e21be4cd6f791ad8e8d411d8bf76865e441` |
| `actions/create-github-app-token` | `64ab729a6294000f5aa4a4bc0b73d1f32bc45510` (v3.3.0, the Kit's pin) |
| `cilium/tetragon`, `.github/workflows/lint-helm.yaml` | `23ed6e9cad8298ccbad3ece31679fc2399c1af8d`, the file as it stood when the observed comments were hidden |
| The Kit | `origin/main` at `773232f7fbc3177511f24baa9decb632b5f770cd` |

The schema, the REST description and each source file were downloaded and read as text, not summarised by a model. Two rendered docs pages were read through a fetch tool and only to confirm what the schema already said. Passages in quotation marks are verbatim.

## 1. The call

### What the schema says

Documented, in the [GraphQL schema](https://docs.github.com/public/fpt/schema.docs.graphql) and rendered on the [GraphQL reference page for issues](https://docs.github.com/en/graphql/reference/issues):

- Mutation `minimizeComment(input: MinimizeCommentInput!)`: "Minimizes a comment on an Issue, Commit, Pull Request, or Gist".
- Its input has `subjectId: ID!`, "The Node ID of the subject to modify", and `classifier: ReportedContentClassifiers!`, "The classification of comment". The subject may be a `CommitComment`, `DiscussionComment`, `GistComment`, `IssueComment`, `PullRequestReview` or `PullRequestReviewComment`.
- It returns `minimizedComment: Minimizable`, "The comment that was minimized".

A comment in a pull request's conversation is an `IssueComment`, which is what the Kit posts a Digest as, so it is a valid subject.

### The classifier values

Documented. The enum `ReportedContentClassifiers`, "The reasons a piece of content can be reported or minimized", has seven values:

| Value | The schema's description |
| --- | --- |
| `ABUSE` | An abusive or harassing piece of content |
| `DUPLICATE` | A duplicated piece of content |
| `LOW_QUALITY` | A low quality piece of content |
| `OFF_TOPIC` | An irrelevant piece of content |
| `OUTDATED` | An outdated piece of content |
| `RESOLVED` | The content has been resolved |
| `SPAM` | A spammy piece of content |

"Collapsed as outdated" is `OUTDATED`. The reason reads back in a different spelling. The schema says of `minimizedReason`: "One of `abuse`, `off-topic`, `outdated`, `resolved`, `duplicate`, `spam`, and `low-quality`. Note that the case and formatting of these values differs from the inputs to the `MinimizeComment` mutation."

### No REST form

Documented by absence. The REST description at the commit above has no path and no operation whose path, summary or description mentions minimizing or hiding a comment. The [issue comments page](https://docs.github.com/en/rest/issues/comments) lists eight endpoints: list for a repository, get, update, delete, pin, unpin, list for an issue, create. Pinning has REST endpoints; minimizing does not.

REST can only read the state (see section 4). No changelog entry announcing that read field was found, so when it arrived is not known.

### The same call in real code

Read from source. Both tools pass the comment's node ID and the classifier, and nothing else.

`marocchino/sticky-pull-request-comment`, [`src/comment.ts` lines 153 to 168](https://github.com/marocchino/sticky-pull-request-comment/blob/28ad303d6acb4ccfc50f20c0044188e7e294b8c4/src/comment.ts#L153-L168):

```ts
export async function minimizeComment(
  octokit: InstanceType<typeof GitHub>,
  subjectId: string,
  classifier: ReportedContentClassifiers,
): Promise<void> {
  await octokit.graphql(
    `
    mutation($input: MinimizeCommentInput!) {
      minimizeComment(input: $input) {
        clientMutationId
      }
    }
    `,
    {input: {subjectId, classifier}},
  )
}
```

Its `hide_and_recreate` mode is rule 17's shape exactly: [`src/main.ts` lines 107 to 112](https://github.com/marocchino/sticky-pull-request-comment/blob/28ad303d6acb4ccfc50f20c0044188e7e294b8c4/src/main.ts#L107-L112) minimizes the previous comment, then creates the new one. Its README gives the classifier's default as `OUTDATED`.

`runatlantis/atlantis`, [`server/events/vcs/github/client.go` lines 253 to 321](https://github.com/runatlantis/atlantis/blob/dcbc0e21be4cd6f791ad8e8d411d8bf76865e441/server/events/vcs/github/client.go#L253-L321), `HidePrevCommandComments`: lists the pull request's comments over REST, keeps the ones its own user wrote, and for each sends `minimizeComment` with `Classifier: githubv4.ReportedContentClassifiersOutdated` and `SubjectID: comment.GetNodeID()`.

## 2. Whether an installation token can make it, and with which permission

### What GitHub documents

- **Who may hide, as a person.** [Managing disruptive comments](https://docs.github.com/en/communities/moderating-comments-and-conversations/managing-disruptive-comments): "Organization moderators and anyone with write access to a repository, can hide comments on issues, discussions, pull requests, and commits." The [repository roles table](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization) gives "Hide anyone's comments on issues, pull requests, and commits" to the write, maintain and admin roles.
- **Which App permission the mutation needs: not documented.** The mutation's reference entry names no permission, scope or token type. GitHub's page [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) covers REST endpoints only.
- **The nearest documented neighbours.** That page lists the REST calls on the same object, creating, updating and deleting an issue comment, under both the "Issues" and the "Pull requests" repository permission at write level, open to installation tokens. So for a comment, GitHub treats either permission as the write permission.
- **A workflow's `GITHUB_TOKEN` is an installation token.** [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token): "When you enable GitHub Actions, GitHub installs a GitHub App on your repository. The `GITHUB_TOKEN` secret is a GitHub App installation access token." So what a `GITHUB_TOKEN` can do with a given permission is evidence for what any App's installation token can do with the same permission.
- **A read-only way to ask.** The `Minimizable` interface has `viewerCanMinimize: Boolean!`, "Check if the current viewer can minimize this object", and `viewerCanUnminimize`. A query for that field on a comment, sent with the Fabrik App's token, answers the question for that exact token without changing anything. Observed: for a reader with only read access to the public repo below, both fields read `false` on its hidden comments.

### What source and observation add

- **`GITHUB_TOKEN` with only `pull-requests: write` does it.** Read from source and observed. `cilium/tetragon`'s [`lint-helm.yaml`](https://github.com/cilium/tetragon/blob/23ed6e9cad8298ccbad3ece31679fc2399c1af8d/.github/workflows/lint-helm.yaml) declares, for the whole workflow, `permissions:` with the single line `pull-requests: write`, and runs `marocchino/sticky-pull-request-comment` with `hide_and_recreate: true` and no token of its own, so the Action uses the job's `GITHUB_TOKEN`. On that repo's pull request #4994, whose branch is in the same repo, two comments by `github-actions[bot]` read back as minimized with the reason `outdated`, each hidden within a second of its replacement being created. A token with only Pull requests write minimized its own pull request comment.
- **The Action's own statement.** Its [README](https://github.com/marocchino/sticky-pull-request-comment/blob/28ad303d6acb4ccfc50f20c0044188e7e294b8c4/README.md) says "You need to add permissions for this tool" and gives `pull-requests: write`, for every mode, hiding included. Its own test workflow does not exercise hiding, so the README alone would be weaker than the observation above.
- **A GitHub App that is not Actions does it.** Read from source. Atlantis hides its earlier plan comments with the call in section 1 and runs as a GitHub App. Its docs say: "When using the GitHub App, you need to set `--gh-app-slug` to enable this feature", because the slug is how it recognises its own comments. The App it registers asks for `issues: write` and `pull_requests: write`, among others ([`github_app_controller.go` lines 200 to 210](https://github.com/runatlantis/atlantis/blob/dcbc0e21be4cd6f791ad8e8d411d8bf76865e441/server/controllers/github_app_controller.go#L200-L210)). This shows an installation token of an ordinary App making the call. It does not isolate which of its permissions allows it.

### So

- **Can an installation token minimize a pull request comment the App wrote?** Yes. Read from source and observed.
- **With which permission?** Pull requests write is sufficient: observed. Whether Issues write alone is also sufficient on a pull request's comment is inferred from the REST neighbours and was not isolated. It does not matter for the Kit, which holds both.
- **Does the workflow `GITHUB_TOKEN` differ?** Not in kind. It is an installation token narrowed by the job's `permissions:`. The differences are elsewhere: its comments are written as `github-actions[bot]`, not as the Fabrik App, and what it changes starts no later workflow.
- **In a private repo?** Not verified. The observed repo is public. Nothing in the docs or in either tool's source makes hiding depend on a repo's visibility, and an installation's write permissions do not vary with it, so the same result is inferred.

## 3. Which token the Kit's push job comments with, and what it holds

All read from the Kit's code at the commit above.

- **The push job comments with the Fabrik App's installation token.** `loop.yml`'s `push` job runs the composite action `.github/actions/run-loop`, which loads the App's key through the push service account, mints a token with `actions/create-github-app-token`, and hands it to `src/main.ts` as `FABRIK_APP_TOKEN`. `src/main.ts` builds its one GitHub client from it, under the comment "Only the Fabrik App's token: changes made with GITHUB_TOKEN don't start later workflows." Every comment the Loop posts goes through that client (`src/github/apply.ts`, the `comment` action, a REST `POST` to the issue's comments).
- **The job's `GITHUB_TOKEN` posts nothing.** The push job's `permissions:` is `actions: read` alone. That token reaches the Loop only on a push to the default branch, as `FABRIK_ACTIONS_TOKEN`, and is used only to read workflow runs.
- **The token is minted with no narrowing.** The "Mint a Fabrik App token" step passes `client-id` and `private-key` and no `permission-*` input. The Action's README says: "By default, the token inherits all of the installation's permissions." So the push job's token holds whatever the Fabrik App's installation on the Product repo holds. Other Kit actions do narrow theirs, such as `link-preview` with `permission-pull-requests: write`; `run-loop` does not.
- **What the installation holds, as the Kit declares it.** ADR-0002: "The Fabrik GitHub App has Issues, Pull requests and Contents permissions, plus Checks: read", with Actions: read added by its addendum, "and deliberately no `workflows` permission". Setup's wizard (`src/setup/wizard.sh`) tells the Operator: "It needs Issues, Pull requests and Contents (read and write), Checks (read), Actions (read), and never 'workflows'."
- **The Kit already sends GraphQL mutations with this token.** `src/github/apply.ts` calls `convertPullRequestToDraft`, `markPullRequestReadyForReview` and `addReaction` through the same client. A fourth mutation needs no new plumbing.

**So the Kit holds the needed permission as it stands.** Pull requests write is what the observation shows to be enough, and the Fabrik App is declared with it, and with Issues write as well.

One limit on that sentence: the permissions live on the App's registration and on each installation at GitHub, not in the repo. The code declares them and Setup asks the Operator for them, but nothing in the Kit reads them back. An installation whose Operator set the App up differently would differ, and the Kit would learn of it only from a refused call.

## 4. Whether a minimized comment is still returned whole

### The fields that say it is minimized

Documented.

- **GraphQL.** `IssueComment` implements `Minimizable`, so it has `isMinimized: Boolean!`, "Returns whether or not a comment has been minimized", and `minimizedReason: String`, with the lower-case values quoted in section 1. Its `body: String!`, "The body as Markdown.", is described with no exception for a minimized comment.
- **REST.** The issue comment schema has a `minimized` property: an object titled "Minimized Issue Comment", "Details about why an issue comment was minimized", with one required field `reason`, "The reason the comment was minimized", or `null` for a comment that is not minimized. It is on the comment returned by the get, list, create and update endpoints, on the comment in a timeline, and on the `issue_comment` webhook's comment.

### The body

Observed, on `cilium/tetragon` #4994, read with a token whose only access to that repo is read:

| Comment | REST `minimized` | GraphQL `isMinimized`, `minimizedReason` | Body returned |
| --- | --- | --- | --- |
| 4773552086 | `{"reason":"outdated"}` | `true`, `outdated` | whole, 3,797 characters, the same from both |
| 4920266393 | `{"reason":"outdated"}` | `true`, `outdated` | whole, 9,771 characters, the same from both |
| 4920374827 (the current one) | `null` | `false`, `null` | whole, 7,092 characters |

Both the single-comment REST call and the list call (`GET /repos/{owner}/{repo}/issues/{issue_number}/comments`) returned the minimized comments in place, in order, with their bodies. The docs say the same of people: "Hidden comments are minimized but people with read access to the repository can expand them."

### What that means for the Kit's reads

Read from source. The Kit reads a pull request's comments through GraphQL (`src/github/snapshot.ts`, selecting `body createdAt author`) and through the REST list (`src/agent/inputs.ts`). Neither filters on the minimized state, so a collapsed Digest reads exactly as an open one: its hidden first line, its head and its data are all still there for rule 4's carry-forward and for the Console's reads through the Kit's read library.

The reverse also holds: collapsing hides nothing from a reader that does not ask. If a reader should skip collapsed Digests, it must select `isMinimized` itself, as `sticky-pull-request-comment` does when it looks for its previous comment (`!node?.isMinimized`). Rule 17 does not need that, since the current Digest is found by its head.

## 5. Undoing it, notifications and the timeline

- **It can be undone.** Documented. Mutation `unminimizeComment(input: UnminimizeCommentInput!)`, "Unminimizes a comment on an Issue, Commit, Pull Request, or Gist", takes the same `subjectId`. A person can do it too: the docs' "Unhiding a comment" gives it to "Organization moderators and anyone with write access to a repository". That an installation token may unminimize what it minimized is inferred from the same permission covering both; no source was found that does it, and `viewerCanUnminimize` would answer it read-only.
- **No timeline event.** Documented by absence and observed. Neither the GraphQL union `PullRequestTimelineItems` nor the REST timeline's event types has an entry for minimizing. They do have ones for a deleted comment (`CommentDeletedEvent`) and for a pinned one (`IssueCommentPinnedEvent`). The docs make the contrast themselves: "Deleting a comment creates a timeline event that is visible to anyone with read access to the repository", and they say nothing of the kind about hiding. The observed pull request's REST timeline has no entry for either hide, only the two new comments that replaced the hidden ones.
- **No webhook action of its own.** Documented. The `issue_comment` webhook's actions are created, edited, deleted, pinned and unpinned. Whether minimizing sends an `edited` delivery is not verified. It would not matter to the Loop: the caller workflow listens to `issue_comment` with `types: [created]` only (`templates/fabrik.yml`).
- **No notification is documented.** A search of GitHub's docs source finds hiding a comment described only on the moderation page, in the roles table and in the GraphQL reference, and none of them mentions a notification. That nobody is notified is inferred from that silence, not stated anywhere.
- **`updated_at` moves.** Observed. Comment 4773552086 was created on 2026-06-22 and reads `updated_at` 2026-07-09T00:04:19Z, the second it was hidden, with `lastEditedAt` null and no edits in its history. So a minimized comment looks "updated" to anything that sorts or filters by that field, though its body and its `created_at` are untouched. The Kit's reads use `createdAt`.

## What the page shows the Operator

Not something the question asked, but it bears on the words "as outdated".

- **Observed, signed out.** GitHub's page for the observed pull request shows each hidden comment as one line, "This comment has been minimized.", with "Sign in to view". The reason is not shown there.
- **A forum report, weaker than everything above.** A [GitHub Community discussion](https://github.com/orgs/community/discussions/19865) open since 2022, with replies through December 2025 and no answer from GitHub, says a comment minimized through GraphQL shows that generic line where one hidden with the page's own Hide button says which reason was chosen, although the API reports the reason correctly in both cases.
- **Not verified**: what a signed-in Operator sees today on a comment the Kit minimized. The collapse itself is certain; the label on it may read "minimized" and not "outdated". The API's reason is `outdated` either way.

## What the Digest's Spec must add

No permission. The Fabrik App as the Kit declares it is enough. In Kit code:

1. **The older Digests' node IDs.** The mutation takes a node ID, and the Kit's comment reads select none today: the GraphQL selection has no `id`, and the `comment` action keeps only `html_url` and `id` from the REST response, which also carries `node_id`. Add `id` to the pull request comments selection, or read `node_id` from the REST list.
2. **One `minimizeComment` call per older Digest, with `OUTDATED`,** after the new Digest is posted, through the client that already sends mutations. Which comments are older Digests is the Kit's own rule: its Digest marker in the hidden first line, written by the App, with a head that is not the current one. Selecting `isMinimized` as well lets it skip the ones already collapsed.
3. **A refused or failed call is not a failure of the Digest.** The decision's fallback already holds: the older Digest stays open and the current one is still found by its head. The Kit's client already turns a GraphQL `FORBIDDEN` error into a 403 and reads GitHub's "Resource not accessible by integration" as a missing permission (`src/github/client.ts`). That this is the error a refused `minimizeComment` gives was not verified.

Optional, and cheap: have the first Digest that runs on a Product repo read `viewerCanMinimize` on its own comment before relying on the collapse. It is the one check that would turn the inferences below into facts for that installation, at no risk.

## Not verified

- **The call made with the Fabrik App's own token.** Nothing was tried. The conclusion rests on a workflow token with Pull requests write, and on another App's source.
- **A private repo.** The observation is from a public one.
- **Issues write alone** as a sufficient permission for a comment on a pull request. The Kit holds Pull requests write too, so this does not change the answer.
- **The real permissions of any Fabrik App installation.** They were read from the Kit's ADR and Setup wizard, not from GitHub.
- **Unminimizing with an installation token.** The mutation is documented; no source was found using it.
- **Notifications.** Their absence is inferred from the docs' silence.
- **Whether minimizing sends an `issue_comment` `edited` webhook.**
- **The error a refused `minimizeComment` returns.**
- **What a signed-in person sees** as the collapsed comment's label, and whether the forum report above still holds.
- **When REST gained the `minimized` field.** It is in today's description; no changelog entry was found.
