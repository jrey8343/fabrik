# Live is read from GitHub Deployments in an environment the Product repo declares

The Operator wants to follow a pull request to the point where it is live and to open the changed page there. The Loop ends at the merge and the Kit deploys nothing, so something has to say when a merged change is deployed. We read it from GitHub: a merged agent pull request is live when GitHub shows a successful Deployment, in the environment the Product repo's Kit config names, of the merge commit or a later commit that contains it.

- **The Product repo declares it.** Kit config's `production` block gives the site's base address and the name its production deploys carry in GitHub's Deployments. Kit config is a Trust-root file, so no agent can change where a live link points. Nothing is guessed: a repo that declares no production is not followed past its merge, and one that declares an address and no environment gets its links and no claim that anything is live.
- **Only a reader reads it.** The read library reads Deployments with its reader's own credential, as ADR-0020 has every read made. No Kit job works out a Standing past the merge, the Weekly summary says nothing past it, and the Fabrik App gains no permission.
- **The Loop still ends at the merge.** Standing widens to follow the work to production. Nothing in the Loop waits on a deploy, and a Live pull request is never a move owed.
- **Any host, through GitHub.** A deploy run from an Actions job that names an environment is recorded as a Deployment by GitHub itself, whatever the host. The Kit calls no host's API.
- **"At the merge commit or later"** is GitHub's comparison of the merge commit with the deployed one. A later deploy that succeeds makes an earlier failure Live.
- **A failed deploy is the Monitor's.** Its red-main check reads every check run on the default branch, and a deploy job is one.

## Considered options

- **Calling a merge live after a wait.** A guess.
- **Each Product exposing its build commit.** Work in every Product repo.
- **A host's API.** The provider-specific code the Kit avoids for previews too.
- **The Loop ending in production.** It would have two ends, since a repo that declares no production stops at the merge, and a last part in which the Kit does nothing.
- **Reusing `ui.before_url` as the production address.** A repo with no `ui` block could not declare production, and Before screenshots could not be off while it is declared.
- **Reading previews from Deployments as well.** It covers only hosts that report them; `preview.url` stays the one way.

## Consequences

- Netlify, Cloudflare Workers Builds and Cloudflare Pages report no Deployments. A repo on one of them is tracked only once it deploys from an Actions job that names an environment.
- A reader needs Deployments read on each Product repo.
- Live means deployed, not checked: nothing looks at the page, and a rollback to an earlier commit is not seen.
- A failed deploy in a repo with `monitor.red_main` off is seen only where a reader shows it.
- The Standing lasts 24 hours from the merge, so a deploy that lands later than that is never shown.

Decided in [How do a preview link and the live page after merge reach the Console?](https://github.com/jrey8343/fabrik/issues/520).
