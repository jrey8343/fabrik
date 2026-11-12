import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient, type Repo } from "../github/client.ts";
import { RUN_STORE, RUN_STORE_REPO } from "../kit/runStore.ts";
import { storeStandingsOf } from "../kit/standingStore.ts";
import { WEEKLY_SUMMARY_FAILED_MARKER } from "../kit/weeklyMarks.ts";
import { aComment, aLabelAdded, anOpenIssue } from "./builders.ts";
import { gatherRepo } from "./gather.ts";
import { threeDeepConnectionsIn } from "./queryShape.ts";
import { rowsOf } from "./rows.ts";
import type { StoreFacts, StoreSummaryFacts } from "./store.ts";

const NOW = "2026-11-09T12:00:00Z";
const SUMMARY_URL = `https://github.com/${RUN_STORE_REPO}/issues/9`;

/** The store with none of its own work in it, but what a test says. */
function storeOf(overrides: Partial<Omit<StoreFacts, "kind">> = {}): StoreFacts {
  return { kind: "store", appLogin: "fabrik-app[bot]", summaries: [], failedSummaryIssues: [], readyForHuman: [], ...overrides };
}

/** Weekly summary issue 9, open, its body written on 2026-11-09 at 07:00 UTC, with no comments of the Fabrik App's unless a test says so. */
function aSummary(overrides: Partial<StoreSummaryFacts> = {}): StoreSummaryFacts {
  return { number: 9, title: "Weekly summary: 2 to 9 November", open: true, bodyWrittenAt: "2026-11-09T07:00:00Z", appComments: [], ...overrides };
}

/** A failed run's notice, as the Fabrik App comments it at `at`. */
function aNotice(at: string) {
  return { body: `@jrey8343 **The Weekly summary failed**, so this week's summary isn't filed.\n\n${WEEKLY_SUMMARY_FAILED_MARKER}`, at, url: `${SUMMARY_URL}#issuecomment-5` };
}

describe("the store's rows", () => {
  it("are the store's Standing rule's own, one row for each", () => {
    const facts = storeOf({
      summaries: [aSummary()],
      failedSummaryIssues: [{ number: 11, title: "Weekly summary failed", createdAt: "2026-11-02T07:00:00Z", appComments: [] }],
      readyForHuman: [anOpenIssue({ number: 12, title: "Tick dead in jrey8343/shop", labels: ["ready-for-human"] })],
    });

    expect(rowsOf(facts, "unread", {}, NOW).map(({ standing }) => standing)).toEqual(storeStandingsOf(facts, NOW));
  });

  it("give an open Weekly summary one row, the Operator's to read, not marked as stopping work, with its title and the Fabrik App's last word", () => {
    const said = { body: "Re-ran: two repos read.", at: "2026-11-09T08:00:00Z", url: `${SUMMARY_URL}#issuecomment-4` };

    const rows = rowsOf(storeOf({ summaries: [aSummary({ appComments: [said] })] }), "unread", {}, NOW);

    expect(rows).toEqual([
      {
        standing: expect.objectContaining({ repo: RUN_STORE_REPO, issue: 9, pullRequest: null, name: "yours-to-read", move: "operator", stopsWork: false, work: "weekly-summary", since: "2026-11-09T07:00:00Z" }),
        title: "Weekly summary: 2 to 9 November",
        lastWord: { text: "Re-ran: two repos read.", at: "2026-11-09T08:00:00Z", url: `${SUMMARY_URL}#issuecomment-4` },
        related: [],
        mentions: [],
        relatedTo: null,
        followUps: [],
        ticketClosed: null,
      },
    ]);
  });

  it("give a failure notice that is the Fabrik App's last comment on the newest Weekly summary one row, the Operator's with the mark off", () => {
    const rows = rowsOf(storeOf({ summaries: [aSummary({ open: false, appComments: [aNotice("2026-11-09T07:30:00Z")] })] }), "unread", {}, NOW);

    expect(rows).toEqual([
      expect.objectContaining({
        standing: expect.objectContaining({ issue: 9, name: "yours-to-do", move: "operator", stopsWork: false, work: "weekly-summary", since: "2026-11-09T07:30:00Z" }),
        title: "Weekly summary: 2 to 9 November",
        lastWord: { text: aNotice("2026-11-09T07:30:00Z").body, at: "2026-11-09T07:30:00Z", url: `${SUMMARY_URL}#issuecomment-5` },
      }),
    ]);
  });

  it("give none for that notice when the Weekly summary's body was written since", () => {
    const rows = rowsOf(storeOf({ summaries: [aSummary({ open: false, bodyWrittenAt: "2026-11-09T08:00:00Z", appComments: [aNotice("2026-11-09T07:30:00Z")] })] }), "unread", {}, NOW);

    expect(rows).toEqual([]);
  });

  it("give an open \"Weekly summary failed\" issue a row, the Operator's with the mark off", () => {
    const notice = { body: "@jrey8343 The issue's own word.", at: "2026-11-02T07:05:00Z", url: `https://github.com/${RUN_STORE_REPO}/issues/11#issuecomment-1` };
    const rows = rowsOf(storeOf({ failedSummaryIssues: [{ number: 11, title: "Weekly summary failed", createdAt: "2026-11-02T07:00:00Z", appComments: [notice] }] }), "unread", {}, NOW);

    expect(rows).toEqual([
      expect.objectContaining({
        standing: expect.objectContaining({ issue: 11, name: "yours-to-do", stopsWork: false, since: "2026-11-02T07:00:00Z" }),
        title: "Weekly summary failed",
        lastWord: { text: "@jrey8343 The issue's own word.", at: "2026-11-02T07:05:00Z", url: `https://github.com/${RUN_STORE_REPO}/issues/11#issuecomment-1` },
      }),
    ]);
  });

  it("give an open ready-for-human issue a row marked as stopping work, with the Fabrik App's last word on it", () => {
    const issue = anOpenIssue({
      number: 12,
      title: "Tick dead in jrey8343/shop",
      author: "fabrik-app[bot]",
      labels: ["ready-for-human"],
      labelEvents: [aLabelAdded("ready-for-human", "2026-11-08T10:00:00Z")],
      comments: [
        aComment("The Fabrik App can't reach jrey8343/shop.", "2026-11-08T10:00:00Z", { url: `https://github.com/${RUN_STORE_REPO}/issues/12#issuecomment-1` }),
        aComment("I'll look tonight.", "2026-11-08T11:00:00Z", { author: "jrey8343", byBot: false }),
      ],
    });

    const rows = rowsOf(storeOf({ readyForHuman: [issue] }), "unread", {}, NOW);

    expect(rows).toEqual([
      expect.objectContaining({
        standing: expect.objectContaining({ repo: RUN_STORE_REPO, issue: 12, name: "yours-to-do", move: "operator", stopsWork: true, work: "ready-for-human", since: "2026-11-08T10:00:00Z" }),
        title: "Tick dead in jrey8343/shop",
        lastWord: { text: "The Fabrik App can't reach jrey8343/shop.", at: "2026-11-08T10:00:00Z", url: `https://github.com/${RUN_STORE_REPO}/issues/12#issuecomment-1` },
      }),
    ]);
  });

  it("take any bot's comment for the Fabrik App's when the reader gave no login", () => {
    const issue = anOpenIssue({ number: 12, labels: ["ready-for-human"], comments: [aComment("Another App's word.", "2026-11-08T10:00:00Z", { author: "other-app[bot]" })] });

    const [row] = rowsOf(storeOf({ appLogin: null, readyForHuman: [issue] }), "unread", {}, NOW);

    expect(row?.lastWord?.text).toBe("Another App's word.");
  });

  it("are none for a store with none of these", () => {
    expect(rowsOf(storeOf({ summaries: [aSummary({ open: false })] }), "unread", {}, NOW)).toEqual([]);
    expect(rowsOf(storeOf(), "unread", {}, NOW)).toEqual([]);
  });

  it("survive a JSON round trip, as their facts do", () => {
    const facts = storeOf({
      summaries: [aSummary({ appComments: [aNotice("2026-11-09T07:30:00Z")] }), aSummary({ number: 8, open: false })],
      failedSummaryIssues: [{ number: 11, title: "Weekly summary failed", createdAt: "2026-11-02T07:00:00Z", appComments: [] }],
      readyForHuman: [anOpenIssue({ number: 12, labels: ["ready-for-human"] })],
    });
    const rows = rowsOf(facts, "unread", {}, NOW);

    expect(rows.length).toBe(3);
    expect(JSON.parse(JSON.stringify(facts))).toStrictEqual(facts);
    expect(JSON.parse(JSON.stringify(rows))).toStrictEqual(rows);
  });
});

const APP = { __typename: "Bot", login: "fabrik-app" };
const OTHER_APP = { __typename: "Bot", login: "other-app" };
const OPERATOR = { __typename: "User", login: "jrey8343" };
const STORE_CALLER = "jobs:\n  summary:\n    uses: jrey8343/fabrik/.github/workflows/weekly-summary.yml@v3.1.0\n";

/** What the store holds on GitHub, as the gather's queries read it, with nothing unless a test says so. */
interface RawStore {
  /** Its caller workflow at its default branch's head, or none. */
  caller?: string | null;
  /** Its `fabrik:weekly-summary` issues, newest first. */
  summaries?: Record<string, unknown>[];
  /** Every other issue, open and closed: a query asking for `states: OPEN` gets the open ones, as from GitHub. */
  issues?: Record<string, unknown>[];
  /** Fail every query whose text holds this. */
  failing?: string;
}

/** A read-only client over the store, answering each query the gather makes with one page, and recording what it was asked. */
function storeWith(raw: RawStore): { client: ReadClient; queries: string[] } {
  const queries: string[] = [];
  const page = (nodes: unknown[] = []) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
  const client: ReadClient = {
    rest: () => Promise.reject(new Error("The gather reads no REST")),
    async fileText(repo: Repo, path: string, ref: string) {
      expect(repo).toEqual(RUN_STORE);
      expect(path).toBe(".github/workflows/weekly-summary.yml");
      expect(ref).toBe("HEAD");
      return raw.caller === undefined ? STORE_CALLER : raw.caller;
    },
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      queries.push(query);
      expect(variables).toMatchObject({ owner: RUN_STORE.owner, name: RUN_STORE.name });
      if (raw.failing !== undefined && query.includes(raw.failing)) throw new GitHubError("GitHub GraphQL failed: 502", 502);
      const answer = (data: unknown) => data as T;
      if (query.includes("labels: [$label]")) {
        expect(variables["label"]).toBe("fabrik:weekly-summary");
        return answer({ repository: { issues: { nodes: raw.summaries ?? [] } } });
      }
      if (query.includes("issues(states: OPEN")) return answer({ repository: { issues: page((raw.issues ?? []).filter(({ state }) => state === "OPEN")) } });
      throw new Error(`Unexpected query: ${query}`);
    },
  };
  return { client, queries };
}

/** Weekly summary issue 9, open, filed on 2026-11-09 at 07:00 and never edited, with no comments unless a test says so. */
function aRawSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { number: 9, title: "Weekly summary: 2 to 9 November", state: "OPEN", createdAt: "2026-11-09T07:00:00Z", lastEditedAt: null, comments: { nodes: [] }, ...overrides };
}

/** Open issue 12 in the store, the Fabrik App's, with no labels, comments or label events unless a test says so. */
function aRawIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    title: "An open issue",
    state: "OPEN",
    createdAt: "2026-11-01T00:00:00Z",
    author: APP,
    labels: { nodes: [] },
    comments: { nodes: [] },
    timelineItems: { nodes: [] },
    ...overrides,
  };
}

/** A comment on store issue `issue` at `at`. */
function aRawComment(issue: number, body: string, at: string, author: Record<string, string> = APP, id = 1) {
  return { url: `https://github.com/${RUN_STORE_REPO}/issues/${issue}#issuecomment-${id}`, body, createdAt: at, author };
}

describe("the gather of the store", () => {
  /** The store's facts, as a gather reads them with `appLogin`. */
  async function storeFactsFrom(raw: RawStore, appLogin: string | null = "fabrik-app[bot]"): Promise<StoreFacts> {
    const read = await gatherRepo(storeWith(raw).client, RUN_STORE_REPO, NOW, appLogin);
    if (read.product || !read.store || read.facts === null) throw new Error(`no store facts: ${JSON.stringify(read)}`);
    return read.facts;
  }

  it("answers with the store's shape: the release its caller pins and its facts", async () => {
    const read = await gatherRepo(storeWith({}).client, RUN_STORE_REPO, NOW, "fabrik-app[bot]");

    expect(read).toEqual({
      repo: RUN_STORE_REPO,
      product: false,
      store: true,
      release: "v3.1.0",
      facts: { kind: "store", appLogin: "fabrik-app[bot]", summaries: [], failedSummaryIssues: [], readyForHuman: [] },
      unread: null,
    });
  });

  it("gives no release when its caller is gone or pins none exactly", async () => {
    expect(await gatherRepo(storeWith({ caller: null }).client, RUN_STORE_REPO, NOW)).toMatchObject({ store: true, release: null, unread: null });
    expect(await gatherRepo(storeWith({ caller: STORE_CALLER.replace("@v3.1.0", "@main") }).client, RUN_STORE_REPO, NOW)).toMatchObject({ store: true, release: null, unread: null });
  });

  it("still gives the release when a query of the facts fails, with no facts and why", async () => {
    const read = await gatherRepo(storeWith({ failing: "issues(states: OPEN" }).client, RUN_STORE_REPO, NOW);

    expect(read).toEqual({ repo: RUN_STORE_REPO, product: false, store: true, release: "v3.1.0", facts: null, unread: "GitHub GraphQL failed: 502" });
  });

  it("reads its Weekly summary issues newest first, each with whether it is open, when its body was last written and the Fabrik App's comments on it", async () => {
    const facts = await storeFactsFrom({
      summaries: [
        aRawSummary({
          comments: {
            nodes: [
              aRawComment(9, "Re-ran.", "2026-11-09T08:00:00Z", APP, 4),
              aRawComment(9, "Thanks!", "2026-11-09T09:00:00Z", OPERATOR, 5),
              aRawComment(9, "Another App's word.", "2026-11-09T10:00:00Z", OTHER_APP, 6),
            ],
          },
        }),
        aRawSummary({ number: 8, title: "Weekly summary: 26 October to 2 November", state: "CLOSED", createdAt: "2026-11-02T07:00:00Z", lastEditedAt: "2026-11-02T09:30:00Z" }),
      ],
    });

    expect(facts.summaries).toEqual([
      {
        number: 9,
        title: "Weekly summary: 2 to 9 November",
        open: true,
        bodyWrittenAt: "2026-11-09T07:00:00Z",
        appComments: [{ body: "Re-ran.", at: "2026-11-09T08:00:00Z", url: `${SUMMARY_URL}#issuecomment-4` }],
      },
      { number: 8, title: "Weekly summary: 26 October to 2 November", open: false, bodyWrittenAt: "2026-11-02T09:30:00Z", appComments: [] },
    ]);
  });

  it("takes any bot's comments for the Fabrik App's when the reader gave no login", async () => {
    const facts = await storeFactsFrom(
      { summaries: [aRawSummary({ comments: { nodes: [aRawComment(9, "Another App's word.", "2026-11-09T10:00:00Z", OTHER_APP), aRawComment(9, "Mine.", "2026-11-09T11:00:00Z", OPERATOR)] } })] },
      null,
    );

    expect(facts.appLogin).toBeNull();
    expect(facts.summaries[0]?.appComments.map(({ body }) => body)).toEqual(["Another App's word."]);
  });

  it("reads its open \"Weekly summary failed\" issues, with the Fabrik App's comments, and no closed one", async () => {
    const facts = await storeFactsFrom({
      issues: [
        aRawIssue({ number: 11, title: "Weekly summary failed", createdAt: "2026-11-02T07:00:00Z", comments: { nodes: [aRawComment(11, "Still failing.", "2026-11-02T08:00:00Z")] } }),
        aRawIssue({ number: 10, title: "Weekly summary failed", state: "CLOSED" }),
        aRawIssue({ number: 13, title: "Something else" }),
      ],
    });

    expect(facts.failedSummaryIssues).toEqual([
      {
        number: 11,
        title: "Weekly summary failed",
        createdAt: "2026-11-02T07:00:00Z",
        appComments: [{ body: "Still failing.", at: "2026-11-02T08:00:00Z", url: `https://github.com/${RUN_STORE_REPO}/issues/11#issuecomment-1` }],
      },
    ]);
  });

  it("reads its open ready-for-human issues as a Product repo's open issues are read", async () => {
    const facts = await storeFactsFrom({
      issues: [
        aRawIssue({
          title: "Tick dead in jrey8343/shop",
          labels: { nodes: [{ name: "ready-for-human" }] },
          comments: { nodes: [aRawComment(12, "The Fabrik App can't reach jrey8343/shop.", "2026-11-08T10:00:00Z")] },
          timelineItems: { nodes: [{ __typename: "LabeledEvent", createdAt: "2026-11-08T10:00:00Z", actor: APP, label: { name: "ready-for-human" } }] },
        }),
        aRawIssue({ number: 14, labels: { nodes: [{ name: "ready-for-human" }] }, state: "CLOSED" }),
      ],
    });

    expect(facts.readyForHuman).toEqual([
      {
        number: 12,
        title: "Tick dead in jrey8343/shop",
        author: "fabrik-app[bot]",
        labels: ["ready-for-human"],
        createdAt: "2026-11-01T00:00:00Z",
        comments: [{ url: `https://github.com/${RUN_STORE_REPO}/issues/12#issuecomment-1`, author: "fabrik-app[bot]", byBot: true, body: "The Fabrik App can't reach jrey8343/shop.", at: "2026-11-08T10:00:00Z" }],
        labelEvents: [{ label: "ready-for-human", action: "labeled", actor: "fabrik-app[bot]", at: "2026-11-08T10:00:00Z" }],
        subIssues: [],
      },
    ]);
  });

  it("gives a row for an open \"Weekly summary failed\" issue until it is closed", async () => {
    const failed = (state: string) => aRawIssue({ number: 11, title: "Weekly summary failed", state });

    expect(rowsOf(await storeFactsFrom({ issues: [failed("OPEN")] }), "unread", {}, NOW).map(({ standing }) => standing.issue)).toEqual([11]);
    expect(rowsOf(await storeFactsFrom({ issues: [failed("CLOSED")] }), "unread", {}, NOW)).toEqual([]);
  });

  it("asks for no connection inside a connection inside a connection", async () => {
    const { client, queries } = storeWith({ summaries: [aRawSummary()], issues: [aRawIssue()] });
    await gatherRepo(client, RUN_STORE_REPO, NOW);

    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) expect(threeDeepConnectionsIn(query)).toEqual([]);
  });

  it("gives facts that survive a JSON round trip", async () => {
    const facts = await storeFactsFrom({
      summaries: [aRawSummary({ comments: { nodes: [aRawComment(9, "Re-ran.", "2026-11-09T08:00:00Z")] } }), aRawSummary({ number: 8, state: "CLOSED" })],
      issues: [aRawIssue({ number: 11, title: "Weekly summary failed" }), aRawIssue({ labels: { nodes: [{ name: "ready-for-human" }] } })],
    });

    expect(JSON.parse(JSON.stringify(facts))).toStrictEqual(facts);
  });
});
