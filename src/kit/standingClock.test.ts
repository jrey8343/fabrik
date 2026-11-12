import { describe, expect, it } from "vitest";
import type { RunInFlightFact } from "../github/snapshot.ts";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import { anOpenIssue, factsOf, standingFactsOf } from "../__fixtures__/weeklySummary.ts";
import { aLabelAdded } from "../__fixtures__/weeklySummary.ts";
import type { KitConfig } from "../loop/types.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type Standing, standingsOf, type StandingFacts } from "./standing.ts";
import type { GitHubFacts, RepoKitFacts } from "./weeklySummary.ts";

const NOW = "2026-11-08T20:00:00Z";

/** `owner/product`'s Kit at this Kit config, with nothing for Dispatch to weigh and these runs in flight. */
function aKit(runsInFlight: readonly RunInFlightFact[] | "unread" = [], config: KitConfig = DEFAULT_KIT_CONFIG): RepoKitFacts {
  return { repo: "owner/product", branch: "main", config: { ok: true, config }, dispatch: { candidates: { tickets: [], researchDecisions: [] } }, runsInFlight };
}

function standingsIn(github: Partial<GitHubFacts>, overrides: Partial<Omit<StandingFacts, "kind" | "github">> = {}, now = NOW): Standing[] {
  return standingsOf(standingFactsOf({ github: factsOf(github), kit: aKit(), ...overrides }), now);
}

/** Ticket 7, ready for an agent, with `agent:implement` added at `at`. */
const askedFor = (at: string, overrides: Parameters<typeof anOpenIssue>[0] = {}) =>
  anOpenIssue({ number: 7, labels: ["ready-for-agent", "agent:implement"], labelEvents: [aLabelAdded("ready-for-agent", "2026-11-08T10:00:00Z"), aLabelAdded("agent:implement", at)], ...overrides });

describe("a run that was asked for and never began", () => {
  it("gives a Ticket whose agent:implement was added 40 minutes ago, with no Implement run in flight, not-started, the Kit's, turning Stuck 210 minutes after the label", () => {
    expect(standingsIn({ openIssues: [askedFor("2026-11-08T19:20:00Z")] })).toEqual([
      {
        schema: 1,
        repo: "owner/product",
        issue: 7,
        pullRequest: null,
        work: "ticket",
        place: "implement",
        name: "not-started",
        move: "kit",
        yours: false,
        stopsWork: false,
        since: "2026-11-08T19:20:00Z",
        stuckAt: "2026-11-08T22:50:00.000Z",
        awaits: { role: "implement", on: "issue" },
        subscription: null,
        detail: { silence: "trigger-label", label: "agent:implement" },
      },
    ]);
  });

  it("reads the same facts a minute before the bar as not-started, and a minute after as stuck, the Operator's and stopping work, keeping its since and the name it had", () => {
    const issue = askedFor("2026-11-08T19:20:00Z");
    const [before] = standingsIn({ openIssues: [issue] }, {}, "2026-11-08T22:49:00Z");
    const [after] = standingsIn({ openIssues: [issue] }, {}, "2026-11-08T22:51:00Z");
    expect(before).toMatchObject({ name: "not-started", move: "kit", yours: false, stopsWork: false });
    expect(after).toEqual({
      ...before,
      name: "stuck",
      yours: true,
      stopsWork: true,
      detail: { was: "not-started", silence: "trigger-label", label: "agent:implement" },
    });
  });

  it("counts the repo's own bar: with the Implement role's timeout raised to 120, Stuck comes 270 minutes after the label", () => {
    const config = kitConfig({ roles: { ...DEFAULT_KIT_CONFIG.roles, implement: { ...DEFAULT_KIT_CONFIG.roles.implement, timeoutMinutes: 120 } } });
    expect(standingsIn({ openIssues: [askedFor("2026-11-08T19:20:00Z")] }, { kit: aKit([], config) })).toMatchObject([{ name: "not-started", stuckAt: "2026-11-08T23:50:00.000Z" }]);
  });

  it("reads a repo whose Kit config is invalid on the Kit's default timeouts", () => {
    const kit: RepoKitFacts = { ...aKit([]), config: { ok: false, errors: ["roles.implement.timeoutMinutes: not a number"] } };
    expect(standingsIn({ openIssues: [askedFor("2026-11-08T19:20:00Z")] }, { kit })).toMatchObject([{ name: "not-started", stuckAt: "2026-11-08T22:50:00.000Z" }]);
  });
});
