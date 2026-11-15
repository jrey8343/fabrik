# UI evidence resolves a dynamic route through a Kit seam, against the Sandbox only

Capture visited each route exactly as the Ticket or the Implementer wrote it. A route with a dynamic segment, such as `/patients/[patientId]`, `/patients/<patientId>` or `/patients/:patientId`, was visited literally, so its screenshot was the app's 404 page, and the capture result still read as clean (jrey8343/gradually-core#366). In that Product the id is a record's UUID, minted at random when the record opens, so no fixed config value or seed manifest can name it: only the running Sandbox knows it.

The Kit now owns the seam, the same way it owns the sign-in seam (ADR-0012). A Product repo gives Kit config one command, `ui.resolve_route`. Once `ui.serve` answers and the capture's sign-ins are done, the Kit runs that command once for each named route with a dynamic segment. The route pattern is in `FABRIK_ROUTE`. When Kit config's rules view the route as a Capture identity, that identity's storage state is in `FABRIK_STORAGE_STATE`, so the command can act as that user. The command prints the concrete path to capture. Capture reads the last line it prints, so a package manager's banner above it, such as `npm run`'s, doesn't count as bad output. The Kit owns the seam because this is the same problem in every Product repo, and because only the Kit can tell a route that was never resolved from a page that loaded. It also keeps the pattern and the path the command printed side by side in the evidence, so the Operator sees both. The Capture identity is still chosen from the pattern, never from the printed path, so a Product's command can't change who views a page.

Like a sign-in, a resolve only ever runs against the Sandbox's own server. Kit config refuses `ui.resolve_route` unless `ui.url` is a loopback address, and the command gets the env `ui.serve` gets, never `sandbox.secrets`. So a resolved route has no Before, even one viewed signed out. The id the command found exists on the Sandbox's server, not on the deployed `ui.before_url` site. Routes with no dynamic segment keep their Before.

## Considered options

- **Seed a known record and name its id in Kit config.** This needs no command. But it doesn't work for an id minted at random, which is the case that prompted this, and every Product repo would have to keep a seed and Kit config in step.
- **Have the Implementer name the concrete path in its output.** This needs no Kit config. But the Implementer's run has ended before capture serves the branch, so it can only name an id from its own run's server, which no longer exists. It would also let agent text choose a record.
- **Visit the pattern and treat the 404 as evidence.** That's what capture did before this change. The result reads as clean while showing nothing of the change.

## Consequences

- A route that still has a dynamic segment is never visited. That covers a route with no `ui.resolve_route` to resolve it, and one whose command exits non-zero, runs past its 2 minutes, prints no path, or prints a path that still has a dynamic segment. Each of its After shots goes into `missed` as `unresolved-route`, with why. A dynamic route has no Before either way.
- An After whose page answers 4xx or 5xx is missed too, as `error-status` with its status, and no screenshot of it is kept. A Before's error page is still recorded, since a route the PR adds is expected to 404 on the deployed site.
- No new capture failure is added. A capture whose every shot was missed, for any of these reasons, fails as `unreachable`, as it already did when no page would load.
- A 200 page that shows an empty or "loading" state, such as a made-up id the app opens as a blank record, isn't caught. That needs checks on the page's content.
- A Prototype's take resolves nothing: the Design session's capture is of the one route the Operator approved.
