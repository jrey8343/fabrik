import { describe, expect, it } from "vitest";
import { type DeadTickInput, type DeadTickIssue, deadTickPlan, type ProductTickRead, recentReposOf, type TickFacts } from "./deadTick.ts";

const NOW = "2026-11-11T07:00:00Z";
const hoursAgo = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();
const RUN_URL = "https://github.com/acme/shop/actions/runs/77/job/901";

/** A Product repo's Tick facts: fabrik.yml on main for days, its last Tick 26 hours ago on v1.0.0, still pinned. */
function facts(overrides: Partial<TickFacts> = {}): TickFacts {
  return {
    callerSince: hoursAgo(24 * 5),
    lastTick: { at: hoursAgo(26), url: RUN_URL, release: "v1.0.0" },
    release: "v1.0.0",
    issues: [],
    ...overrides,
  };
}

function read(repo: string, tick: TickFacts): ProductTickRead {
  return { repo, kind: "read", facts: tick };
}

function input(products: readonly ProductTickRead[], overrides: Partial<DeadTickInput> = {}): DeadTickInput {
  return { now: NOW, operator: "operator", products, recentRepos: [], storeIssues: [], timeZone: null, ...overrides };
}

/** The issue a plan opened, as the next run reads it back. */
function openedAs(plan: ReturnType<typeof deadTickPlan>, number: number): DeadTickIssue {
  const [opened] = plan.open;
  if (opened === undefined) throw new Error("expected an issue opened");
  return { number, body: opened.body, byApp: true };
}

describe("A Product repo whose Tick hasn't started for 25 hours", () => {
  it("gets one Dead-tick issue, ready for the Operator and assigned to them, naming when the last Tick started", () => {
    const plan = deadTickPlan(input([read("acme/shop", facts())]));

    expect(plan.open).toHaveLength(1);
    expect(plan.open[0]).toMatchObject({
      repo: "acme/shop",
      title: "The hourly Tick hasn't run since 2026-11-10 05:00 UTC",
      labels: ["fabrik:dead-tick", "ready-for-human"],
      assignees: ["operator"],
    });
    expect(plan.open[0]?.body).toContain(`The last Tick started at 2026-11-10 05:00 UTC ([its run](${RUN_URL})), on Fabrik v1.0.0.`);
    expect(plan.close).toEqual([]);
  });

  it("isn't opened a second time by the next daily run while the first is open", () => {
    const first = deadTickPlan(input([read("acme/shop", facts())]));

    const second = deadTickPlan(input([read("acme/shop", facts({ issues: [openedAs(first, 12)] }))]));

    expect(second.open).toEqual([]);
    expect(second.close).toEqual([]);
  });
});

describe("A new Product repo's grace", () => {
  it("opens nothing while fabrik.yml has been on main for 10 hours and no Tick has ever started", () => {
    const plan = deadTickPlan(input([read("acme/shop", facts({ callerSince: hoursAgo(10), lastTick: null }))]));

    expect(plan.open).toEqual([]);
  });

  it("opens the issue once fabrik.yml has been on main for 26 hours with no Tick ever started, naming when it came", () => {
    const plan = deadTickPlan(input([read("acme/shop", facts({ callerSince: hoursAgo(26), lastTick: null }))]));

    expect(plan.open).toHaveLength(1);
    expect(plan.open[0]?.title).toBe("The hourly Tick hasn't run since 2026-11-10 05:00 UTC");
    expect(plan.open[0]?.body).toContain("No Tick has started its jobs on `main` since `.github/workflows/fabrik.yml` came to it at 2026-11-10 05:00 UTC.");
  });
});

describe("The Tick check in the Operator's time zone, as the store's caller gives it", () => {
  const sydney = { timeZone: "Australia/Sydney" };

  it("says in it when the dead Tick last started, in the issue's title and body and the summary", () => {
    const plan = deadTickPlan(input([read("acme/shop", facts())], sydney));

    expect(plan.open[0]?.title).toBe("The hourly Tick hasn't run since 2026-11-10 16:00 Australia/Sydney");
    expect(plan.open[0]?.body).toContain("The last Tick started at 2026-11-10 16:00 Australia/Sydney ([its run]");
  });

  it("says in it when the caller came to main, for a repo whose Tick never started", () => {
    const plan = deadTickPlan(input([read("acme/shop", facts({ callerSince: hoursAgo(26), lastTick: null }))], sydney));

    expect(plan.open[0]?.body).toContain("came to it at 2026-11-10 16:00 Australia/Sydney.");
  });

  it("says in it when the Tick started again, closing the issue, and in the summary", () => {
    const issue = { number: 12, body: "Dead.\n\n<!-- fabrik:dead-tick -->", byApp: true };
    const lastTick = { at: hoursAgo(2), url: RUN_URL, release: null };

    const plan = deadTickPlan(input([read("acme/shop", facts({ lastTick, issues: [issue] }))], sydney));

    expect(plan.close).toEqual([
      { repo: "acme/shop", issue: 12, comment: "The hourly Tick started again at 2026-11-11 16:00 Australia/Sydney, so the Kit is closing this issue." },
    ]);
    expect(plan.summary).toContain("acme/shop: the last Tick started at 2026-11-11 16:00 Australia/Sydney.");
  });
});

describe("A Tick that started in the last 25 hours", () => {
  it("is alive, whatever commit it ran on, so no issue is opened", () => {
    const plan = deadTickPlan(input([read("acme/shop", facts({ lastTick: { at: hoursAgo(2), url: RUN_URL, release: "v1.0.0" } }))]));

    expect(plan.open).toEqual([]);
    expect(plan.close).toEqual([]);
  });

  it("has the daily check close the open Dead-tick issue, saying when it started again and on which release, when the Tick didn't", () => {
    const issue = { number: 12, body: "Dead.\n\n<!-- fabrik:dead-tick -->", byApp: true };
    const lastTick = { at: hoursAgo(2), url: RUN_URL, release: "v1.1.0" };

    const plan = deadTickPlan(input([read("acme/shop", facts({ lastTick, release: "v1.1.0", issues: [issue] }))]));

    expect(plan.close).toEqual([
      { repo: "acme/shop", issue: 12, comment: "The hourly Tick started again at 2026-11-11 05:00 UTC, on Fabrik v1.1.0, so the Kit is closing this issue." },
    ]);
  });

  it("leaves alone an issue carrying the marker that the Fabrik App didn't open", () => {
    const quoted = { number: 13, body: "<!-- fabrik:dead-tick -->", byApp: false };

    const plan = deadTickPlan(input([read("acme/shop", facts({ lastTick: { at: hoursAgo(2), url: RUN_URL, release: "v1.0.0" }, issues: [quoted] }))]));

    expect(plan.close).toEqual([]);
  });
});

describe("A repo the Fabrik App can't reach", () => {
  const alive = facts({ lastTick: { at: hoursAgo(2), url: RUN_URL, release: "v1.0.0" } });

  it("gets an issue in fabrik-runs naming it, when it has Run records from the last 30 days but the installation no longer lists it", () => {
    const plan = deadTickPlan(input([read("acme/shop", alive)], { recentRepos: ["acme/shop", "acme/old"] }));

    expect(plan.open).toEqual([
      expect.objectContaining({
        repo: "jrey8343/fabrik-runs",
        title: "The Fabrik App can't reach acme/old",
        labels: ["fabrik:dead-tick", "ready-for-human"],
        assignees: ["operator"],
      }),
    ]);
    expect(plan.open[0]?.body).toContain("- [ ] Reinstall the Fabrik App on acme/old");
    expect(plan.open[0]?.body.endsWith("<!-- fabrik:dead-tick-unreachable acme/old -->")).toBe(true);
  });

  it("gets the issue when the installation lists it but GitHub refuses the App's reads of it, saying why", () => {
    const refused: ProductTickRead = { repo: "acme/shop", kind: "refused", error: "Resource not accessible by integration" };

    const plan = deadTickPlan(input([refused]));

    expect(plan.open).toEqual([expect.objectContaining({ repo: "jrey8343/fabrik-runs", title: "The Fabrik App can't reach acme/shop" })]);
    expect(plan.open[0]?.body).toContain("Resource not accessible by integration");
  });

  it("isn't given a second issue while its first is open", () => {
    const first = deadTickPlan(input([], { recentRepos: ["acme/old"] }));

    const second = deadTickPlan(input([], { recentRepos: ["acme/old"], storeIssues: [openedAs(first, 30)] }));

    expect(second.open).toEqual([]);
  });

  it("has its issue closed once the App reaches it again", () => {
    const first = deadTickPlan(input([], { recentRepos: ["acme/shop"] }));

    const plan = deadTickPlan(input([read("acme/shop", alive)], { recentRepos: ["acme/shop"], storeIssues: [openedAs(first, 30)] }));

    expect(plan.open).toEqual([]);
    expect(plan.close).toEqual([
      { repo: "jrey8343/fabrik-runs", issue: 30, comment: "The Fabrik App reaches acme/shop again, so the Kit is closing this issue." },
    ]);
  });

  it("opens nothing for a read that failed some other way, which says nothing of whether the App reaches it", () => {
    const failed: ProductTickRead = { repo: "acme/shop", kind: "failed", error: "Bad Gateway" };

    const plan = deadTickPlan(input([failed], { recentRepos: ["acme/shop"] }));

    expect(plan.open).toEqual([]);
    expect(plan.summary).toContain("acme/shop: couldn't be read: Bad Gateway");
  });
});

describe("The repos the check expects to reach", () => {
  it("are those with a Run record in the store from the last 30 days, each once", () => {
    const records = [
      { repo: "acme/shop", endedAt: hoursAgo(24 * 7) },
      { repo: "acme/shop", endedAt: hoursAgo(1) },
      { repo: "acme/old", endedAt: hoursAgo(24 * 29) },
      { repo: "acme/gone", endedAt: hoursAgo(24 * 31) },
    ];

    expect(recentReposOf(records, NOW)).toEqual(["acme/shop", "acme/old"]);
  });
});

describe("The Dead-tick issue's body", () => {
  it("leads with the bump when the pin changed since the last started Tick", () => {
    const plan = deadTickPlan(input([read("acme/shop", facts({ release: "v1.1.0" }))]));

    expect(plan.open[0]?.body.split("\n")[0]).toBe("The Tick stopped after the bump from v1.0.0 to v1.1.0.");
  });

  it("names no bump when the pin is the one the last Tick ran on", () => {
    const plan = deadTickPlan(input([read("acme/shop", facts())]));

    expect(plan.open[0]?.body).not.toContain("bump");
  });

  it("gives the Operator checkbox steps, says the Tick closes it, and ends with its marker", () => {
    const body = deadTickPlan(input([read("acme/shop", facts({ release: "v1.1.0" }))])).open[0]?.body ?? "";

    expect(body).toContain("## Steps");
    expect(body).toContain("- [ ] Open [the Actions tab for `.github/workflows/fabrik.yml`](https://github.com/acme/shop/actions/workflows/fabrik.yml) and read the newest run's error.");
    expect(body).toContain("- [ ] Check that the workflow is enabled");
    expect(body).toContain("- [ ] Compare the caller's job permissions with [v1.1.0's release notes](https://github.com/jrey8343/fabrik/releases/tag/v1.1.0), or re-run Setup.");
    expect(body).toContain("The Tick closes this issue itself on its first run once it starts again.");
    expect(body.endsWith("<!-- fabrik:dead-tick -->")).toBe(true);
  });
});

// #554: the caller's runs since the Tick died, read with the App's Actions: read only for a repo about to get its issue.
describe("The Dead-tick issue's count of never-started runs", () => {
  const run = (event: string, hours: number, conclusion: string | null = "startup_failure") => ({ conclusion, createdAt: hoursAgo(hours), event });
  const withRuns = (runs: TickFacts["runs"], overrides: Partial<TickFacts> = {}) => deadTickPlan(input([read("acme/shop", facts({ runs, ...overrides }))]));
  const bodyOf = (plan: ReturnType<typeof deadTickPlan>) => plan.open[0]?.body ?? "";
  const ON_EVENTS = "on issue, comment, pull request or push events, so nothing the Loop does on an event has run either: no Triage, Design, Implement or Review.";

  it("says 14 runs never started, 9 of them on events, naming the roles that haven't run", () => {
    const runs = [
      ...[1, 2, 3, 4, 5].map((h) => run("schedule", h)),
      ...[1, 2, 3].map((h) => run("issues", h)),
      ...[4, 5, 6].map((h) => run("pull_request_target", h)),
      ...[7, 8, 9].map((h) => run("push", h)),
    ];

    const body = bodyOf(withRuns({ kind: "read", runs }));

    expect(body).toContain(`**14 runs of \`fabrik.yml\` since then never started**, 9 of them ${ON_EVENTS}`);
  });

  it("says 3 never started, with no events clause, when all three are scheduled", () => {
    const body = bodyOf(withRuns({ kind: "read", runs: [run("schedule", 1), run("schedule", 2), run("schedule", 3)] }));

    expect(body).toContain("**3 runs of `fabrik.yml` since then never started**.");
    expect(body).not.toContain("of them");
  });

  it("says it in the singular for one never-started run", () => {
    const body = bodyOf(withRuns({ kind: "read", runs: [run("schedule", 1), run("schedule", 2, "success")] }));

    expect(body).toContain("**1 run of `fabrik.yml` since then never started**.");
  });

  it("says it in the singular for one never-started run on an event", () => {
    const body = bodyOf(withRuns({ kind: "read", runs: [run("schedule", 2, "success"), run("issue_comment", 1)] }));

    expect(body).toContain("**1 run of `fabrik.yml` since then never started**, on an issue, comment, pull request or push event, so nothing the Loop does");
  });

  it("counts no run created before the last started Tick", () => {
    const body = bodyOf(withRuns({ kind: "read", runs: [run("schedule", 27), run("issues", 30), run("schedule", 1, "success")] }));

    expect(body).not.toContain("never started");
  });

  it("counts from when fabrik.yml came to main when no Tick ever started", () => {
    const runs = [run("schedule", 30), run("schedule", 27), run("schedule", 1)];

    const body = bodyOf(withRuns({ kind: "read", runs }, { lastTick: null, callerSince: hoursAgo(28) }));

    expect(body).toContain("**2 runs of `fabrik.yml` since then never started**.");
  });

  it("says the workflow is most likely disabled, and leads the Steps with checking it's enabled, when GitHub created no scheduled run since", () => {
    const body = bodyOf(withRuns({ kind: "read", runs: [run("schedule", 30, "success"), run("issues", 3), run("push", 2)] }));

    expect(body).toContain("GitHub hasn't created a scheduled run of `fabrik.yml` since then, so the workflow is most likely disabled.");
    expect(body).toContain(`**2 runs of \`fabrik.yml\` since then never started**, all of them ${ON_EVENTS}`);
    const steps = body.split("## Steps\n\n")[1]?.split("\n") ?? [];
    expect(steps[0]).toMatch(/^- \[ \] Check that the workflow is enabled/);
    expect(steps[1]).toMatch(/read the newest run's error\.$/);
  });

  it("keeps the Steps' order when scheduled runs were created but never started", () => {
    const body = bodyOf(withRuns({ kind: "read", runs: [run("schedule", 1)] }));

    expect(body).not.toContain("disabled");
    expect(body.split("## Steps\n\n")[1]).toMatch(/^- \[ \] Open \[the Actions tab/);
  });

  it("is today's body when there's no Actions token, the summary saying why the count is unread", () => {
    const today = deadTickPlan(input([read("acme/shop", facts())]));

    const plan = withRuns({ kind: "no-permission" });

    expect(plan.open).toEqual(today.open);
    expect(plan.summary).toContain("acme/shop: run counts unread: the Fabrik App lacks Actions: read.");
  });

  it("is today's body when GitHub won't list the runs, the summary giving GitHub's message", () => {
    const today = deadTickPlan(input([read("acme/shop", facts())]));

    const plan = withRuns({ kind: "unread", why: "Resource not accessible by integration" });

    expect(plan.open).toEqual(today.open);
    expect(plan.summary).toContain("acme/shop: run counts unread: Resource not accessible by integration");
  });
});
