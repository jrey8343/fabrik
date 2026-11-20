# UI evidence can come from Evidence shots a Product repo's own Required check uploads

Capture visits routes, and a route is often the wrong unit. In one Product repo, 11 of 17 agent pull requests that changed a screen reached the Merge gate with no picture of the change, and none of those captures failed. The largest group changed a state no URL reaches, or named no route at all. The Product's own Journeys already reached every missed state, with real ids, by driving the UI.

The Kit now has a second source. A Product repo names one of its Required checks in Kit config, and that check uploads the Evidence shots its Journeys took, with a manifest, as an artifact. The Kit reads the artifact from the check's newest attempt at the pull request's head. A Product repo uses one source or the other for its pull requests, and Kit config refuses both. We chose this because a sign-in seam and a route-resolver seam (ADR-0012, ADR-0024) still end in one page load, and because pictures from a check follow the head through the Operator's pushes and the Kit's rebases, which pictures from the Implement job never did.

## Considered options

- **More seams on route capture**, such as steps in Kit config that click through to a state. Each Product repo would write its Journeys twice, and the second copy would drift.
- **Run the Journeys in the Implement job.** The pictures would be of the Implementer's Sandbox, not the head, and would be left behind by every later push.
- **A helper the Kit ships into the Product's tests.** The Kit is pinned at one version per Product repo (ADR-0003), and a package in the Product's test run is a second thing to keep in step.
- **A Before from the default branch's run of the same check.** It needs a second lookup and compares against the default branch's head, not the pull request's base. The manifest leaves room for it.
- **A new trigger so the Kit hears a check finish.** It would give a section to pull requests with no Review, at the cost of a Trust-root change in every Product repo.

## Consequences

- The pull request's own code writes the artifact. Today's capture also runs the branch's code, so this is no worse, and the Kit reads the artifact as untrusted: the manifest and the images it lists, by fixed rules, and it runs none of it.
- A shot shows the head as it would have merged when the check ran, and is not taken again when the default branch moves.
- The section appears once the check has finished and the Review's jobs have read it. A pull request with no Review has no section, and a reader gets its shots from the artifact.
- A shot has no Before.
- The Kit takes the manifest's word for an image's size.
- The upload step must run whether the Journeys passed or failed. A green check with no artifact is a failure of the wiring, the Operator's to fix.
- Route capture stays for a Product repo without Journeys, and for every Prototype.
