import { describe, expect, it } from "vitest";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { aDeploymentsRead, aDeployOf, aLabelAdded, aMergedLastDay, anOpenIssue, factsOf, homeFactsOf } from "./builders.ts";
import type { DeploymentsRead } from "./deployments.ts";
import type { Facts } from "./gather.ts";
import { joinDeployments, mergesToRead } from "./joinDeployments.ts";
import { rowsOf } from "./rows.ts";

const KEPT_AT = "2026-11-12T10:00:00Z";
const NOW = "2026-11-12T10:20:00Z";
const merge = (digit: string) => digit.repeat(40);

/** A repo declaring production at `https://shop.example`, in environment `production` unless a test says otherwise. */
const declaring = (environment: string | null = "production") =>
  ({ repo: "owner/product", branch: "main", config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, production: { url: "https://shop.example", environment } } }, dispatch: null }) as const;

/** Agent pull requests 50, 51 and 52, merged at 09:30, 09:40 and 09:50 with merge commits 1, 2 and 3, closing Tickets 7, 8 and 9, and Ticket 14 waiting for a slot. */
const facts = (environment: string | null = "production"): Facts =>
  homeFactsOf({
    kit: declaring(environment),
    github: factsOf({ openIssues: [anOpenIssue({ number: 14, labels: ["ready-for-agent", "agent:implement"], labelEvents: [aLabelAdded("agent:implement", "2026-11-12T09:00:00Z")] })] }),
    mergedLastDay: [
      aMergedLastDay("2026-11-12T09:30:00Z", { number: 50, ticket: 7, mergeCommit: merge("1") }),
      aMergedLastDay("2026-11-12T09:40:00Z", { number: 51, ticket: 8, mergeCommit: merge("2") }),
      aMergedLastDay("2026-11-12T09:50:00Z", { number: 52, ticket: 9, mergeCommit: merge("3") }),
    ],
  });

/** An earlier read, at the keeping: 50 live, 51 deploying, 52 with none yet. */
const EARLIER = aDeploymentsRead(
  {
    [merge("1")]: aDeployOf({ is: "succeeded", deployment: 900, commit: merge("1"), at: "2026-11-12T09:36:00Z" }),
    [merge("2")]: aDeployOf({ is: "running", deployment: 901, commit: merge("2"), at: "2026-11-12T09:45:00Z" }),
    [merge("3")]: aDeployOf(),
  },
  KEPT_AT,
);
/** A later read of 51 and 52: 51 failed, 52 deploying. */
const LATER = aDeploymentsRead(
  {
    [merge("2")]: aDeployOf({ is: "failed", deployment: 901, commit: merge("2"), at: "2026-11-12T10:05:00Z", log: "https://github.com/owner/product/actions/runs/40/job/41" }),
    [merge("3")]: aDeployOf({ is: "running", deployment: 902, commit: merge("3"), at: "2026-11-12T10:10:00Z" }),
  },
  NOW,
);

/**
 * The kept rows of `of` with the earlier read, joined at `now` with the later
 * one; and the rows the rule gives then with what the two reads say between
 * them, the later where both speak of a merge: a Live merge the later read
 * leaves out is still known to be Live.
 */
function joinedAndRule(of: Facts, earlier: DeploymentsRead | null, later: DeploymentsRead, now = NOW) {
  const kept = rowsOf(of, null, null, earlier, KEPT_AT);
  const known = { ...later, merges: { ...earlier?.merges, ...later.merges } };
  return { kept, joined: joinDeployments(kept, later, now), rule: rowsOf(of, null, null, known, now) };
}

const named = (rows: readonly { readonly standing: { readonly issue: number | null; readonly pullRequest: number | null; readonly name: string } }[]) => rows.map(({ standing }) => [standing.pullRequest ?? standing.issue, standing.name]);

describe("which merges want a Deployments read", () => {
  it("are the merge commit and merge time of every row at Production but the Live ones, which are settled", () => {
    const rows = rowsOf(facts(), null, null, EARLIER, KEPT_AT);

    expect(named(rows)).toEqual([
      [14, "not-started"],
      [50, "live"],
      [51, "deploying"],
      [52, "merged"],
    ]);
    expect(mergesToRead(rows)).toEqual([
      { mergeCommit: merge("2"), mergedAt: "2026-11-12T09:40:00Z" },
      { mergeCommit: merge("3"), mergedAt: "2026-11-12T09:50:00Z" },
    ]);
  });

  it("include a merge whose deploys were unread, and none from a repo that declares no environment", () => {
    expect(mergesToRead(rowsOf(facts(), null, null, null, KEPT_AT)).map(({ mergeCommit }) => mergeCommit)).toEqual([merge("1"), merge("2"), merge("3")]);
    expect(mergesToRead(rowsOf(facts(null), null, null, null, KEPT_AT))).toEqual([]);
  });
});

describe("the join of kept rows with a Deployments read", () => {
  it("gives each row at Production the name, since and detail the rule gives for the read, and agrees with the rule", () => {
    const { joined, rule } = joinedAndRule(facts(), EARLIER, LATER);

    expect(joined.filter(({ standing }) => standing.pullRequest !== null).map(({ standing }) => standing)).toMatchObject([
      { pullRequest: 50, name: "live", since: "2026-11-12T09:36:00Z" },
      { pullRequest: 51, name: "deploy-failed", since: "2026-11-12T10:05:00Z", detail: { deployment: 901, log: "https://github.com/owner/product/actions/runs/40/job/41" } },
      { pullRequest: 52, name: "deploying", move: "kit", since: "2026-11-12T10:10:00Z", detail: { deployment: 902 } },
    ]);
    expect(joined).toEqual(rule);
  });

  it("agrees with the rule for a read, over the rows the rule gave without one", () => {
    const read = aDeploymentsRead({ ...EARLIER.merges, ...LATER.merges }, NOW);
    const kept = rowsOf(facts(), null, null, null, NOW);

    expect(kept.filter(({ standing }) => standing.pullRequest !== null).map(({ standing }) => standing.detail)).toMatchObject([{ deploysUnread: true }, { deploysUnread: true }, { deploysUnread: true }]);
    expect(joinDeployments(kept, read, NOW)).toEqual(rowsOf(facts(), null, null, read, NOW));
  });

  it("puts the rows back in the rule's order when deploys settle in the opposite order to their merges", () => {
    const read = aDeploymentsRead(
      {
        [merge("1")]: aDeployOf({ is: "running", deployment: 910, commit: merge("1"), at: "2026-11-12T10:10:00Z" }),
        [merge("2")]: aDeployOf({ is: "succeeded", deployment: 911, commit: merge("2"), at: "2026-11-12T09:45:00Z" }),
        [merge("3")]: aDeployOf(),
      },
      NOW,
    );
    const kept = rowsOf(facts(), null, null, null, NOW);
    const joined = joinDeployments(kept, read, NOW);

    expect(named(joined)).toEqual([
      [14, "not-started"],
      [51, "live"],
      [52, "merged"],
      [50, "deploying"],
    ]);
    expect(joined).toEqual(rowsOf(facts(), null, null, read, NOW));
  });

  it("returns a row unchanged when the read leaves out its merge or gives it as unread, but for reading it later", () => {
    const kept = rowsOf(facts(), null, null, EARLIER, KEPT_AT);
    const unread = aDeploymentsRead({ [merge("2")]: "unread" }, NOW);

    const joined = joinDeployments(kept, unread, NOW);

    expect(joined[0]).toBe(kept[0]);
    expect(joined.find(({ standing }) => standing.pullRequest === 51)).toBe(kept.find(({ standing }) => standing.pullRequest === 51));
    // Merge 3 had none at the keeping; left out of this read, it is read at the later time all the same.
    expect(joinDeployments(kept, unread, "2026-11-12T10:51:00Z").find(({ standing }) => standing.pullRequest === 52)?.standing).toMatchObject({
      name: "no-deploy-seen",
      since: "2026-11-12T10:50:00.000Z",
    });
  });

  it("turns a row with no deploy seen into deploying when a deploy starts after the hour, as the rule does", () => {
    const none = aDeploymentsRead({ [merge("3")]: aDeployOf() }, "2026-11-12T11:00:00Z");
    const started = aDeploymentsRead({ [merge("3")]: aDeployOf({ is: "running", deployment: 903, commit: merge("3"), at: "2026-11-12T11:05:00Z" }) }, "2026-11-12T11:10:00Z");
    const kept = rowsOf(facts(), null, null, none, "2026-11-12T11:00:00Z");

    const joined = joinDeployments(kept, started, "2026-11-12T11:10:00Z");

    expect(kept.find(({ standing }) => standing.pullRequest === 52)?.standing).toMatchObject({ name: "no-deploy-seen", since: "2026-11-12T10:50:00.000Z" });
    expect(joined.find(({ standing }) => standing.pullRequest === 52)?.standing).toMatchObject({ name: "deploying", since: "2026-11-12T11:05:00Z" });
    expect(joined).toEqual(rowsOf(facts(), null, null, started, "2026-11-12T11:10:00Z"));
  });

  it("takes no read of another environment or repo", () => {
    const kept = rowsOf(facts(), null, null, EARLIER, KEPT_AT);

    expect(joinDeployments(kept, { ...LATER, environment: "staging" }, NOW)).toEqual(joinDeployments(kept, aDeploymentsRead({}, NOW), NOW));
    expect(joinDeployments(kept, { ...LATER, repo: "owner/other" }, NOW)).toEqual(joinDeployments(kept, aDeploymentsRead({}, NOW), NOW));
  });

  it("leaves out a merged row once its 24 hours have passed, tracked or not, as the rule does", () => {
    const after = "2026-11-13T09:41:00Z";
    for (const environment of ["production", null]) {
      const { joined, rule } = joinedAndRule(facts(environment), EARLIER, LATER, after);

      expect(named(joined)).toEqual([
        [14, "stuck"],
        [52, environment === null ? "merged" : "deploying"],
      ]);
      expect(joined).toEqual(rule);
    }
  });

  it("reads every other row at the later time, as the rule reads a kept Standing", () => {
    const kept = rowsOf(facts(), null, null, EARLIER, KEPT_AT);
    const later = "2026-11-12T23:00:00Z";

    expect(named(joinDeployments(kept, LATER, later)).filter(([pullRequest]) => pullRequest === 14)).toEqual([[14, "stuck"]]);
  });
});
