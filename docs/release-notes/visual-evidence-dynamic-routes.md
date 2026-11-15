# Release notes: Visual evidence resolves dynamic routes

The notes for the minor release that lets Visual evidence capture routes with a dynamic segment, and counts unresolved dynamic routes and After error pages as missed ([#707](https://github.com/jrey8343/fabrik/issues/707), ADR-0024). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- **A route with a dynamic segment is resolved, or not visited.** Until now capture visited a route such as `/patients/[patientId]` exactly as written, so its screenshot was the app's 404 page, and the evidence still read as clean. A route with a `[x]`, `<x>` or `:x` segment is now never visited as written.
- **`ui.resolve_route`, a new optional field.** It's one command that turns such a route into a concrete path on the Sandbox's own server, such as `npm run resolve-route`. Kit config refuses it when it's blank or `ui.url` isn't a loopback address, as with `ui.sign_in`.
  - Once `ui.serve` answers and any sign-ins are done, capture runs it once for each named route with a dynamic segment, for up to 2 minutes within capture's budget.
  - It gets the env `ui.serve` gets, never `sandbox.secrets`, plus `FABRIK_ROUTE`, the route as named. When `ui.signed_in_routes` views the route as a Capture identity, it also gets that identity's storage state in `FABRIK_STORAGE_STATE`.
  - It prints the path to capture, and capture reads the last line it prints.
  - The Capture identity is still chosen by the route's pattern.
- **The evidence keeps both.** Each capture of a resolved route records the route and the `resolved` path it was captured at. The evidence section, the Evidence page and the Reviewer's prompt show the route beside that path, and the `fabrik:ui-evidence` marker gains `resolved`, a list of `{ route, path }`, left out when nothing was resolved.
- **A resolved route has no Before**, even one viewed signed out: the record the command found is on the Sandbox's server, not on the production site.
- **An unresolved route is missed.** With no `ui.resolve_route`, or when its command exits non-zero, runs past its time, prints no path, or prints one that still has a dynamic segment, each of the route's After shots goes into `missed` as `unresolved-route`. Its line in the evidence section says why, and no page is visited for it.
- **An After error page is missed.** An After whose page answers 4xx or 5xx goes into `missed` as `error-status` with its status, and no screenshot of it is kept. A Before's error page is still kept, since a route the PR adds is expected to 404 on production.
- **No new capture failure.** A capture whose every shot was missed fails as `unreachable`, as it did when no page would load.
- **`/fabrik-visual-evidence` offers `ui.resolve_route`** when the Product's routes have dynamic segments, with its contract and an example. It never writes the command itself.
- **Why a minor:** `ui.resolve_route` is optional and absent by default. Capture results and markers an earlier release wrote still read. The one change a repo without it sees is that a dynamic route and an After error page now show as not captured, rather than as a screenshot of a 404.

## To turn it on

1. Merge this release's bump PR. If the Product names routes with dynamic segments, file a Ticket for a command that prints a concrete path for the route in `FABRIK_ROUTE`, against the Sandbox's own server, using no `sandbox.secrets`.
2. Once it's merged, run `/fabrik-visual-evidence`, confirm the `ui.resolve_route` it offers, and merge the PR it opens.
3. Check it on a real UI issue that names a dynamic route in backticks: the evidence section shows the route beside the path it was captured at, with no Before, and the Evidence page shows the record's page, not a 404.
