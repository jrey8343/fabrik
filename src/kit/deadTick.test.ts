import { describe, expect, it } from "vitest";
import { type DeadTickInput, type DeadTickIssue, deadTickPlan, type ProductTickRead, type TickFacts } from "./deadTick.ts";

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
  return { now: NOW, operator: "operator", products, recentRepos: [], storeIssues: [], ...overrides };
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
