// What the Loop reads when an agent pull request merges, so each fault its
// passes named opens as an issue once, under the cap (#885): from what
// GitHub holds, through the snapshot, to the plan.
import { describe, expect, it } from "vitest";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import { followUpsSection, type NamedFollowUp } from "../loop/followUps.ts";
import { followUpMarker, verdictMarker } from "../loop/markers.ts";
import { planFor } from "../loop/rules.ts";
import type { LoopEvent, Plan } from "../loop/types.ts";
import type { GitHub } from "./client.ts";
import { gatherSnapshot } from "./snapshot.ts";

const repo = { owner: "acme", name: "shop" };
const REPO_URL = "https://github.com/acme/shop";
const APP_LOGIN = "fabrik-app[bot]";
const APP = { login: "fabrik-app", __typename: "Bot" };
const OTHER_BOT = { login: "dependabot", __typename: "Bot" };
const OPERATOR = { login: "operator", __typename: "User" };

const merged: LoopEvent = { kind: "pull-request-closed", pullRequest: 42, merged: true, closedByBot: false };

const BADGE = { kind: "fault", title: "The badge miscounts", body: "`badge.ts:14` reads a stale count." } as const;
const FOOTER = { kind: "fault", title: "The footer test is skipped", body: "`footer.test.ts:3` is `it.skip`." } as const;
const MONEY = { kind: "idea", title: "Extract the money type", body: "The cart and the till both round." } as const;

/** A comment on #42, as GitHub holds it: the Fabrik App's unless a test says who wrote it. */
interface HeldComment {
  readonly body: string;
  readonly author?: { readonly login: string; readonly __typename: string };
}

/** An issue of acme/shop as GitHub holds it: open, and the Fabrik App's, unless a test says otherwise. */
interface HeldIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state?: "OPEN" | "CLOSED";
  readonly author?: { readonly login: string; readonly __typename: string } | null;
  /** The repo it is in, when it is cross-referenced from another. */
  readonly repo?: string;
  /** Whether GitHub cross-references it to #42 yet: it does once it has read the issue's `From PR #42` line. */
  readonly crossReferenced?: boolean;
}

/** What GitHub holds of #42, merged, and around it. */
interface Held {
  readonly headRefName?: string;
  readonly comments?: readonly HeldComment[];
  readonly issues?: readonly HeldIssue[];
  /** How many issues GitHub gives to a page. */
  readonly pageSize?: number;
}

/** The Fabrik App's pass on #42 at a head, as the Kit posts it, listing these Follow-ups. */
const aPassNaming = (head: string, ...followUps: NamedFollowUp[]): HeldComment => ({
  body: [verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: head.repeat(40) }), "## Verdict: Pass", ...followUpsSection(followUps, REPO_URL, 42)].join("\n"),
});

/** An issue the Kit opened for a fault of pull request #`pullRequest`, as its plan writes it. */
const aKitIssue = (number: number, title: string, pullRequest = 42, overrides: Partial<HeldIssue> = {}): HeldIssue => ({
  number,
  title,
  body: [followUpMarker(pullRequest), "What shows it is wrong.", "", `From PR #${pullRequest}`].join("\n"),
  ...overrides,
});

/** An issue the Operator opened from a Follow-up's Open as issue link on pull request #`pullRequest`. */
const anOperatorIssue = (number: number, title: string, pullRequest = 42, overrides: Partial<HeldIssue> = {}): HeldIssue => ({
  number,
  title,
  body: `What it is.\n\nFrom PR #${pullRequest}`,
  author: OPERATOR,
  ...overrides,
});

/** A GitHub holding `held`, which records what it is asked. */
function gitHubHolding(held: Held = {}) {
  const queries: string[] = [];
  const issues = held.issues ?? [];
  const pageSize = held.pageSize ?? 100;
  const paged = <T,>(all: readonly T[], after: unknown) => {
    const from = after === null || after === undefined ? 0 : Number(after);
    return { pageInfo: { hasNextPage: from + pageSize < all.length, endCursor: String(from + pageSize) }, nodes: all.slice(from, from + pageSize) };
  };
  const nodeOf = ({ number, title, body, author }: HeldIssue) => ({ number, title, body, author: author === undefined ? APP : author });
  const github = {
    async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
      queries.push(query);
      if (query.includes("CROSS_REFERENCED_EVENT") && query.includes("body")) {
        const references = issues.filter(({ crossReferenced, state }) => crossReferenced ?? state === "CLOSED");
        const page = paged(references, variables["after"]);
        return {
          repository: {
            pullRequest: {
              crossReferences: {
                ...page,
                nodes: [
                  { __typename: "CrossReferencedEvent", source: { __typename: "PullRequest" } },
                  ...page.nodes.map((issue) => ({ __typename: "CrossReferencedEvent", source: { __typename: "Issue", ...nodeOf(issue), repository: { nameWithOwner: issue.repo ?? "acme/shop" } } })),
                ],
              },
            },
          },
        };
      }
      if (query.includes("CROSS_REFERENCED_EVENT")) return { repository: { pullRequest: { crossReferences: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } };
      if (query.includes("issues(states: OPEN") && query.includes("body") && !query.includes("labels:")) {
        const open = issues.filter(({ state, repo: elsewhere }) => (state ?? "OPEN") === "OPEN" && elsewhere === undefined);
        return { repository: { issues: { ...paged(open, variables["after"]), nodes: paged(open, variables["after"]).nodes.map(nodeOf) } } };
      }
      if (!query.includes("pullRequest(number: $number)")) return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      return {
        repository: {
          owner: { login: "acme" },
          pullRequest: {
            number: 42,
            state: "MERGED",
            isDraft: false,
            headRefName: held.headRefName ?? "fabrik/ticket-30",
            headRefOid: "b".repeat(40),
            author: APP,
            body: "Closes #30",
            url: `${REPO_URL}/pull/42`,
            labels: { nodes: [] },
            comments: {
              pageInfo: { hasPreviousPage: false },
              nodes: (held.comments ?? []).map(({ body, author }, at) => ({ id: `C_${at}`, isMinimized: false, body, createdAt: `2026-11-0${at + 2}T09:00:00Z`, author: author ?? APP })),
            },
            changesRequests: { nodes: [] },
            draftEvents: { pageInfo: { hasPreviousPage: false }, nodes: [] },
            createdAt: "2026-11-01T09:00:00Z",
            forcePushes: { nodes: [] },
            commits: { pageInfo: { hasPreviousPage: false }, nodes: [] },
            closingIssuesReferences: { nodes: [{ number: 30, state: "CLOSED", labels: { nodes: [] }, comments: { nodes: [] } }] },
          },
        },
      };
    },
    async rest(method: string, path: string): Promise<unknown> {
      throw new Error(`Unexpected REST call: ${method} ${path}`);
    },
  };
  /** The queries that read issues for the merge's faults: every open issue, and the issues cross-referenced to #42 with their bodies. */
  const issueReads = () => queries.filter((query) => (query.includes("issues(states: OPEN") && !query.includes("labels:")) || (query.includes("CROSS_REFERENCED_EVENT") && query.includes("body")));
  return { github: github as unknown as GitHub, queries, issueReads };
}

/** What the Kit would do about #42 merging, as the push job reads GitHub, which knows the Fabrik App's login. */
async function planOn(held: Held, event: LoopEvent = merged): Promise<Plan> {
  const snapshot = await gatherSnapshot(gitHubHolding(held).github, repo, event, "operator", APP_LOGIN);
  return planFor(event, snapshot, kitConfig());
}

/** The titles of the issues a plan opens, in its order. */
const openedBy = (plan: Plan): string[] => (plan.kind === "act" ? plan.actions.flatMap((action) => (action.kind === "create-issue" ? [action.title] : [])) : []);

describe("Reading what an agent pull request merged with (#885)", () => {
  it("reads the faults its passes named from the Fabrik App's Verdict comments, in order, a repeat among them, and never an idea", async () => {
    const { github } = gitHubHolding({ comments: [aPassNaming("a", BADGE, MONEY), aPassNaming("b", FOOTER, BADGE), { ...aPassNaming("b", MONEY), author: OPERATOR }] });

    const { pullRequest } = await gatherSnapshot(github, repo, merged, "operator", APP_LOGIN);

    expect(pullRequest?.faults).toEqual([
      { title: BADGE.title, body: BADGE.body },
      { title: FOOTER.title, body: FOOTER.body },
      { title: BADGE.title, body: BADGE.body },
    ]);
    expect(pullRequest?.followUpsOpened).toBe(false);
  });

  it("reads how many Follow-up issues the Fabrik App has open in the repo, whichever pull request each names, and the issues that already hold one of this pull request's", async () => {
    const { github } = gitHubHolding({
      comments: [aPassNaming("a", BADGE, FOOTER)],
      pageSize: 2,
      issues: [
        aKitIssue(60, "An older fault", 31),
        aKitIssue(61, "Another older fault", 35),
        anOperatorIssue(62, "A fault the Operator opened", 31),
        // Not the Kit's: another bot's, a person's quoting the marker, and one whose marker is not its first line.
        aKitIssue(63, "A look-alike", 31, { author: OTHER_BOT }),
        aKitIssue(64, "A quote", 31, { author: OPERATOR }),
        { number: 65, title: "A Spin-off", body: `Text first.\n${followUpMarker(31)}` },
        aKitIssue(70, BADGE.title, 42, { state: "CLOSED" }),
        anOperatorIssue(71, FOOTER.title, 42),
        // Names another pull request, or is nobody's the rule counts.
        anOperatorIssue(72, BADGE.title, 41),
        { number: 73, title: BADGE.title, body: "From PR #42", author: { login: "someone", __typename: "User" } },
        aKitIssue(74, "In another repo", 42, { state: "CLOSED", repo: "acme/other" }),
      ],
    });

    const snapshot = await gatherSnapshot(github, repo, merged, "operator", APP_LOGIN);

    expect(snapshot.followUpIssues).toEqual({
      repoUrl: REPO_URL,
      open: 2,
      ofPullRequest: [
        { number: 70, title: BADGE.title, openedBy: "kit" },
        { number: 71, title: FOOTER.title, openedBy: "operator" },
      ],
    });
  });

  it("so each fault opens as an issue once, under the cap, and one that is an issue already is not opened again", async () => {
    const open = [60, 61, 62].map((number) => aKitIssue(number, `An older fault ${number}`, 31));

    expect(openedBy(await planOn({ comments: [aPassNaming("a", BADGE, MONEY), aPassNaming("b", FOOTER, BADGE)] }))).toEqual([BADGE.title, FOOTER.title]);
    expect(openedBy(await planOn({ comments: [aPassNaming("a", BADGE, FOOTER)], issues: [...open, aKitIssue(63, "One more", 31)] }))).toEqual([BADGE.title]);
    // An issue the Kit opened seconds ago, which GitHub does not cross-reference yet, is read among the open ones.
    expect(openedBy(await planOn({ comments: [aPassNaming("a", BADGE, FOOTER)], issues: [aKitIssue(70, BADGE.title, 42, { crossReferenced: false })] }))).toEqual([FOOTER.title]);
    // One the Operator opened and has closed since is read from the cross-references.
    expect(openedBy(await planOn({ comments: [aPassNaming("a", BADGE, FOOTER)], issues: [anOperatorIssue(71, FOOTER.title, 42, { state: "CLOSED" })] }))).toEqual([BADGE.title]);
  });

  it("reads the comment that says the merge was seen to, so a second look opens nothing and reads no issue", async () => {
    const seenTo = { body: "<!-- fabrik:follow-ups-opened -->\nThis pull request merged, so the Kit opened…" };
    const { github, issueReads } = gitHubHolding({ comments: [aPassNaming("a", BADGE), seenTo] });

    const snapshot = await gatherSnapshot(github, repo, merged, "operator", APP_LOGIN);

    expect(snapshot.pullRequest?.followUpsOpened).toBe(true);
    expect(snapshot.followUpIssues).toBeNull();
    expect(issueReads()).toEqual([]);
    expect(planFor(merged, snapshot, kitConfig())).toEqual({ kind: "act", actions: [{ kind: "check-dispatch" }] });
    // A person quoting the mark has seen to nothing.
    expect(openedBy(await planOn({ comments: [aPassNaming("a", BADGE), { ...seenTo, author: OPERATOR }] }))).toEqual([BADGE.title]);
  });

  it("reads no issue for a pull request whose passes named no fault, one closed unmerged, or a Plain one", async () => {
    const noFault = gitHubHolding({ comments: [aPassNaming("a", MONEY)] });
    const unmerged = gitHubHolding({ comments: [aPassNaming("a", BADGE)] });
    const plain = gitHubHolding({ comments: [aPassNaming("a", BADGE)], headRefName: "fix-the-badge" });
    const closedByHand: LoopEvent = { kind: "pull-request-closed", pullRequest: 42, merged: false, closedByBot: false };

    expect((await gatherSnapshot(noFault.github, repo, merged, "operator", APP_LOGIN)).followUpIssues).toBeNull();
    expect((await gatherSnapshot(unmerged.github, repo, closedByHand, "operator", APP_LOGIN)).followUpIssues).toBeNull();
    expect((await gatherSnapshot(plain.github, repo, merged, "operator", APP_LOGIN)).followUpIssues).toBeNull();
    expect([...noFault.issueReads(), ...unmerged.issueReads(), ...plain.issueReads()]).toEqual([]);
  });
});
