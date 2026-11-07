# UI evidence signs in through a Kit seam, against the Sandbox only

Capture opened a plain browser, so on a Product behind a login every screenshot was the sign-in page, and it read as a clean 200. The Kit now owns the seam: a Product repo gives Kit config one sign-in command per Capture identity, the Kit runs the ones a capture needs after `ui.serve` answers, and each writes a Playwright storage state that capture loads. Kit config's rules, not Tickets or agents, say which Capture identity views a route. We chose this because a sign-in is the same problem in every Product repo, more than one Capture identity needs more than one session against one server, and only the Kit can tell a failed sign-in from a page that loaded. Every Product solving it alone would get none of that.

A sign-in only ever runs against the Sandbox's own server, with fake users. Kit config refuses `ui.sign_in` unless `ui.url` is a loopback address, and the commands get the env `ui.serve` gets, never `sandbox.secrets`. So a signed-in route has no Before: `ui.before_url` is a deployed site, which these sessions can't reach and must not. Public routes keep their Before.

## Considered options

- **A `ui.serve` that's already signed in, with the Product adding the session to every request.** This needs no Kit config, and it's what gradually-core first planned. But one server holds one session, each Product repo builds its own bypass, and the Kit can't tell when it failed.
- **Name the Capture identity in the route, such as `/today as owner`.** The same page could be captured as two identities. But it changes how Tickets and the Implementer's output are read, and lets agent text choose who views a page.
- **Build the default branch in the Sandbox for signed-in Before screenshots.** This would give every route a Before. But it could double capture's time inside its budget, and needs a second checkout and server.

## Consequences

- A failed sign-in is its own capture failure, `sign-in-failed`, whether the command failed or a signed-in page landed on `ui.sign_in_path`. Capture stops there rather than carry on signed out. An app that shows its sign-in form without redirecting to that path isn't caught.
- A storage state holds cookies and localStorage. An app that keeps its session in sessionStorage or memory needs its own way in.
- `/fabrik-setup` leaves Visual evidence off for an app behind a sign-in until the repo has a sign-in command.
