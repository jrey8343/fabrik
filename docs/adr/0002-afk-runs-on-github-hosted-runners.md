# AFK work runs on GitHub-hosted runners, and the agent never holds a write credential

Every AFK step in the Loop (Triage, Dispatch, Implementer, Reviewer) runs as a GitHub Actions job on a GitHub-hosted runner in the Product repo. The runner's throwaway VM is the Sandbox. Sandcastle runs inside it with `noSandbox()`. We chose this because it needs no machine of the Operator's own, keeps working with the laptop shut, and moves to a new Product repo with nothing but the Kit and a few repo secrets. A run spends most of its time waiting on the model, not the CPU, so faster hardware would gain little. The real limit on throughput is the shared Ultra weekly pool, not runner capacity or Actions minutes.

Each agent step is split into two jobs. The agent job gets `contents: read`, the subscription OAuth token and no GitHub App token, and passes its commits out as a git bundle artifact (the Reviewer passes out its Verdict). A separate job on a fresh VM then mints an App token, pushes the branch, opens the PR or posts the Verdict, and moves labels. That job never runs code from the Product repo. Putting the steps in one job isn't enough: a prompt-injected agent could plant a git hook or edit a script that a later step runs while holding the token. The Fabrik GitHub App has Issues, Pull requests and Contents permissions and deliberately no `workflows` permission, so GitHub refuses any agent branch that touches `.github/workflows/` at push time.

## Considered options

- **The Operator's OVHcloud box** (always on, in Sydney, either as a webhook host or as a self-hosted Actions runner). It has warm caches, no minutes bill and no 6-hour cap, but the difference in cost is tens of dollars a month at most. GitHub doesn't clean self-hosted runners between jobs, so the box would need throwaway runners in containers on a shared kernel. The Operator would also own patching and uptime, and nothing would announce an outage. It was rejected for simplicity and portability. The Operator won't run an always-on box of their own for Fabrik, for HITL sessions either.
- **Anthropic cloud scheduled tasks** fired on `issue.labeled`. These would make Sandcastle redundant, but they're a research preview with no label filter for issue events and unpublished hourly caps.

## Consequences

- Private Product repos use Actions minutes for the whole run, including time spent waiting on the model. Each job has a hard `timeout-minutes` (Kit config).
- Each Product repo holds the App ID, its private key and `CLAUDE_CODE_OAUTH_TOKEN` as Actions secrets, because a personal account can't share Actions secrets across repos.
- Per-issue and per-PR `concurrency` groups ensure only one run per Ticket. A cap on how many run at once across Tickets plugs into Dispatch (ADR-0001).
