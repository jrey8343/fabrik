# The Kit publishes its read side as a library and writes no snapshot for its readers

The Console shows the Operator what the factory is doing and makes their moves at the Merge gate. Everything it shows is something the Kit already reads from GitHub and the Run records: where a piece of work stands, what is running, what a merge waits on, what was spent. The Kit publishes that reading as a **read library**: one entry in its source, which a reader fetches at the release it pins and runs itself, with its own credential.

- **The Kit owns every rule.** A reader holds none about what a label, a marker or a Verdict means. The library hands it Standings, the Kit's words for them, and the joins that settle a kept row against fresh runs or checks.
- **The Kit writes nothing for a reader.** No snapshot, no file, no comment. The Loop never learns a reader exists and runs the same without one.
- **Webhooks are nudges, never state.** An event tells a reader which repo to read again, and the reading is done through the library. No rule is written a second time as an event handler.
- **One pin.** A reader reads with the Fabrik release its own caller workflow pins, fetched as source at that tag, as skills are (ADR-0003). There is no package.
- **The promise.** The library reads whatever any earlier release wrote, as the Loop already must for old markers and Run-record schemas. A test holds what it exports. Removing an export or changing what it means is a breaking change and a major.
- **A run in flight says what it is.** The Kit job ends with a step whose name is one line of JSON: what it routed, held and declined included. It needs no write credential, so ADR-0002 stands.

## Considered options

- **A snapshot the Kit writes per Product repo.** Each repo's answers would come from the Kit that repo runs, so no skew. But it is only as fresh as an Actions run, a minute at best and an hour for anything that turns on the clock, and it needs a write on every event from a job holding a write credential.
- **The reader working the answers out from GitHub.** Two definitions of whose move is next from the first day. Splitting by freshness, or applying each webhook to a cache as a change, is the same thing in part.
- **A public npm package, or a git dependency on the tag.** A registry account and a publish step in every release, or a second pin and the Kit's runtime dependencies, the Claude Code CLI among them, installed into the reader.
- **Longer agent job names,** in place of the closing step. A job blocked behind its concurrency group sends no delivery, so its name would say nothing until the block was over.

## Consequences

- The Kit has a second kind of consumer. A release now promises a library as well as workflows and a caller shape.
- The library keeps to what a Worker can run and imports no package. A reader typechecks and runs it with its own TypeScript and runtime, and its bump pull request is where a break shows.
- A Product repo on a newer Kit than its reader pins is read with older rules until the reader's bump merges. The reader compares pins and says so.
- The fact builders and the cost functions are part of the interface, so a reader's fake data is the Kit's own facts.
- GitHub and the Run records stay the record. Anything a reader keeps is a cache it can rebuild by reading again.

Decided in [How does the Console learn what the Kit knows?](https://github.com/jrey8343/fabrik/issues/516), with what it costs from [What is the Console built with?](https://github.com/jrey8343/fabrik/issues/521).
