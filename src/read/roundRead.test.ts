import { describe, expect, it } from "vitest";
import { readMapOffer } from "../agent/inputs.ts";
import { GitHubError, type ReadClient } from "../github/client.ts";
import { DEFAULT_KIT_CONFIG, type KitConfigResult } from "../kit/config.ts";
import { designRoundMarker, PROTOTYPE_FAILURE_ROUND_MARKER, PROTOTYPE_ROUND_MARKER, prototypeRequestMarker, SESSION_FINISHED } from "../loop/markers.ts";
import { prototypeTurnRefused } from "../loop/failures.ts";
import { type RoundLine, roundLineOf } from "../loop/roundLine.ts";
import { aDesignTurnFailedNotice, aMapCapRefusal } from "./builders.ts";
import { EXPORT_CALLS, EXPORT_SHAPES } from "./exports.fixture.ts";
import { readRound, type RoundRead, roundWaitsIn } from "./roundRead.ts";

const APP = { __typename: "Bot", login: "fabrik-app" };
const OPERATOR = { __typename: "User", login: "jrey8343" };
const SOMEONE = { __typename: "User", login: "someone-else" };
const NOW = "2026-11-12T12:00:00Z";
const CONFIG: KitConfigResult = { ok: true, config: DEFAULT_KIT_CONFIG };

/** Issue 21 of `jrey8343/shop` as the read's query reads it: open, in a Design session, with no parent and no comments unless a test says so. */
interface RawIssue {
  readonly state?: "OPEN" | "CLOSED";
  readonly labels?: readonly string[];
  readonly parent?: number | null;
  readonly comments?: readonly Record<string, unknown>[];
}

/** A read-only client over `jrey8343/shop`'s issue 21 and its open Maps, recording each query it was asked. */
function repoWith(issue: RawIssue, openMaps: readonly number[] = []): { client: ReadClient; queries: string[] } {
  const queries: string[] = [];
  const client: ReadClient = {
    rest: () => Promise.reject(new Error("The read asks no REST")),
    fileText: () => Promise.reject(new Error("The read reads no file")),
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      queries.push(query);
      expect(variables).toMatchObject({ owner: "jrey8343", name: "shop" });
      if (variables["map"] === "wayfinder:map") return { repository: { issues: { nodes: openMaps.map((number) => ({ number, title: `Map ${number}` })) } } } as T;
      if (query.includes("issue(number: $issue)")) {
        expect(variables["issue"]).toBe(21);
        return {
          repository: {
            issue: {
              state: issue.state ?? "OPEN",
              labels: { nodes: (issue.labels ?? ["needs-design"]).map((name) => ({ name })) },
              parent: issue.parent === undefined || issue.parent === null ? null : { number: issue.parent },
              comments: { nodes: issue.comments ?? [] },
            },
          },
        } as T;
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  };
  return { client, queries };
}

let nextId = 1000;

/** A comment on issue 21, its id one more than the last's, at `at`, by `author`. */
function aRawComment(body: string, at: string, author: Record<string, unknown> | null = APP, id = ++nextId): Record<string, unknown> {
  return { databaseId: id, url: `https://github.com/jrey8343/shop/issues/21#issuecomment-${id}`, body, createdAt: at, author };
}

/** An ordinary Round's line, round `round`. */
function anOrdinaryLine(round: number, fields: Partial<Extract<RoundLine, { kind: "round" }>> = {}): RoundLine {
  return { v: 1, kind: "round", round, intro: "Two things to settle.", questions: [{ question: "Which page?", recommendation: "The cart." }], ...fields };
}

/** The Fabrik App's ordinary Round `round`, its hidden line under its marker, as the landing posts it. */
function aRound(round: number, at: string, line: RoundLine | null = anOrdinaryLine(round), id?: number): Record<string, unknown> {
  return aRawComment([designRoundMarker(round), ...(line === null ? [] : [roundLineOf(line)]), "Two things to settle.", "", "1. Which page?"].join("\n"), at, APP, id);
}

describe("The Round read", () => {
  it("gives the Round that is the App's last word, waiting, with its comment, number, time and line", async () => {
    const round = aRound(2, "2026-11-12T09:00:00Z", anOrdinaryLine(2), 5001);
    const { client } = repoWith({ comments: [aRound(1, "2026-11-11T09:00:00Z"), aRawComment("The cart.", "2026-11-11T10:00:00Z", OPERATOR), round] });

    const read = await readRound(client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

    expect(read).toEqual({
      repo: "jrey8343/shop",
      issue: 21,
      readAt: NOW,
      waits: "round",
      round: {
        comment: 5001,
        url: "https://github.com/jrey8343/shop/issues/21#issuecomment-5001",
        postedAt: "2026-11-12T09:00:00Z",
        round: 2,
        waiting: true,
        line: anOrdinaryLine(2),
      },
      failedTurn: null,
      mapMayBeOffered: true,
    });
  });

  describe("whether the Round still waits", () => {
    it("no longer once the Operator has replied: the same Round, waiting false, and nothing waits", async () => {
      const { client } = repoWith({ comments: [aRound(1, "2026-11-12T09:00:00Z", anOrdinaryLine(1), 5001), aRawComment("The cart.", "2026-11-12T10:00:00Z", OPERATOR)] });

      const read = await readRound(client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read.waits).toBe("nothing");
      expect(read.round).toMatchObject({ comment: 5001, waiting: false });
    });

    it("still, after a comment from anyone else, or from a bot under the Operator's login", async () => {
      const { client } = repoWith({
        comments: [
          aRound(1, "2026-11-12T09:00:00Z", anOrdinaryLine(1), 5001),
          aRawComment("The cart, surely.", "2026-11-12T10:00:00Z", SOMEONE),
          aRawComment("Deploying.", "2026-11-12T10:30:00Z", { __typename: "Bot", login: "jrey8343" }),
        ],
      });

      const read = await readRound(client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read.waits).toBe("round");
      expect(read.round).toMatchObject({ comment: 5001, waiting: true });
    });

    it("gives the later Round once one is posted, so a reader holding the earlier one's comment sees it differs", async () => {
      const earlier = aRound(1, "2026-11-11T09:00:00Z", anOrdinaryLine(1), 5001);
      const held = await readRound(repoWith({ comments: [earlier] }).client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);
      const { client } = repoWith({ comments: [earlier, aRawComment("The cart.", "2026-11-11T10:00:00Z", OPERATOR), aRound(2, "2026-11-12T09:00:00Z", anOrdinaryLine(2), 5002)] });

      const fresh = await readRound(client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(fresh.round).toMatchObject({ comment: 5002, round: 2, waiting: true });
      expect(fresh.round?.comment).not.toBe(held.round?.comment);
    });
  });

  describe("a Round's line", () => {
    it("is null for a Round with no line, as an earlier release posted it", async () => {
      const { client } = repoWith({ comments: [aRound(1, "2026-11-12T09:00:00Z", null, 5001)] });

      const read = await readRound(client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read.waits).toBe("round");
      expect(read.round).toMatchObject({ comment: 5001, round: 1, waiting: true, line: null });
    });

    it("is null for a Round whose line does not read", async () => {
      const broken = [designRoundMarker(1), '<!-- fabrik:round-line {"v":1,"kind":"round","round":"one"} -->', "Two things to settle."].join("\n");
      const unknown = [designRoundMarker(1), roundLineOf(anOrdinaryLine(1)).replace('"v":1', '"v":2'), "Two things to settle."].join("\n");

      for (const body of [broken, unknown]) {
        const read = await readRound(repoWith({ comments: [aRawComment(body, "2026-11-12T09:00:00Z")] }).client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);
        expect(read.round).toMatchObject({ round: 1, waiting: true, line: null });
      }
    });

    it("is given for a prototype round and for a prototype failure round", async () => {
      const prototype: RoundLine = {
        v: 1,
        kind: "prototype",
        round: 3,
        intro: "Three ways to show the cart.",
        questions: [{ question: "Which variant?", recommendation: "B, as it shows the total." }],
        route: "/cart",
        recommended: "B",
        variants: [
          { letter: "A", summary: "A list.", component: "https://github.com/jrey8343/shop/blob/abc/A.tsx", preview: null },
          { letter: "B", summary: "A table.", component: "https://github.com/jrey8343/shop/blob/abc/B.tsx", preview: "https://preview.example/cart?variant=B" },
        ],
        captures: { run: 9100, artifact: 77 },
      };
      const failed: RoundLine = {
        v: 1,
        kind: "prototype-failed",
        round: 3,
        intro: "The prototype didn't build.",
        questions: [{ question: "Carry on without one?", recommendation: "Yes." }],
        otherAnswers: ["Ask for the prototype again."],
      };

      for (const [marker, line] of [
        [PROTOTYPE_ROUND_MARKER, prototype],
        [PROTOTYPE_FAILURE_ROUND_MARKER, failed],
      ] as const) {
        const body = [designRoundMarker(3), marker, roundLineOf(line), line.intro].join("\n");
        const read = await readRound(repoWith({ comments: [aRawComment(body, "2026-11-12T09:00:00Z")] }).client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);
        expect(read.waits).toBe("round");
        expect(read.round).toMatchObject({ round: 3, waiting: true, line });
      }
    });
  });

  describe("a failed turn", () => {
    /** The App's notice that the turn on #21 failed at `at`, naming run `run` in its hidden line, as the Kit posts it. */
    const aFailedTurn = (at: string, run?: number) => aRawComment(aDesignTurnFailedNotice(at, run).body, at);
    const reply = (at: string) => aRawComment("Try again.", at, OPERATOR);

    it("with no reply since, waits, in the Standing's own sentence, with its run, the run's address and one in a row", async () => {
      const { client } = repoWith({ comments: [aRound(1, "2026-11-12T06:00:00Z", anOrdinaryLine(1), 5001), reply("2026-11-12T07:00:00Z"), aFailedTurn("2026-11-12T09:00:00Z", 9100)] });

      const read = await readRound(client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read.waits).toBe("failed-turn");
      expect(read.failedTurn).toEqual({
        sentence: "A Design-session turn failed 3 hours ago. Reply on the issue to run it again.",
        run: 9100,
        url: "https://github.com/jrey8343/shop/actions/runs/9100",
        failedRunning: 1,
      });
      // A failed turn is not a Round: the session's last Round, answered, is still given.
      expect(read.round).toMatchObject({ comment: 5001, waiting: false });
    });

    it("words a prototype turn's failure the same way, from the notice the Kit posts for it", async () => {
      const notice = prototypeTurnRefused(21, "jrey8343", "its output broke the contract", "https://github.com/jrey8343/shop/actions/runs/9200/attempts/1");
      const body = notice.kind === "act" && notice.actions[0]?.kind === "comment" ? notice.actions[0].body : "";
      const { client } = repoWith({ comments: [aRound(1, "2026-11-12T06:00:00Z"), reply("2026-11-12T07:00:00Z"), aRawComment(body, "2026-11-12T11:00:00Z")] });

      const read = await readRound(client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read.waits).toBe("failed-turn");
      expect(read.failedTurn).toEqual({
        sentence: "A Design-session turn failed 1 hour ago. Reply on the issue to run it again.",
        run: 9200,
        url: "https://github.com/jrey8343/shop/actions/runs/9200",
        failedRunning: 1,
      });
    });

    it("counts two after a reply ran the turn again and it failed again, and one again after a Round in between", async () => {
      const twice = [aRound(1, "2026-11-12T06:00:00Z"), reply("2026-11-12T07:00:00Z"), aFailedTurn("2026-11-12T08:00:00Z", 9100), reply("2026-11-12T09:00:00Z"), aFailedTurn("2026-11-12T10:00:00Z", 9101)];
      const roundBetween = [...twice, reply("2026-11-12T10:30:00Z"), aRound(2, "2026-11-12T11:00:00Z"), reply("2026-11-12T11:10:00Z"), aFailedTurn("2026-11-12T11:30:00Z", 9102)];

      const second = await readRound(repoWith({ comments: twice }).client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);
      const afterRound = await readRound(repoWith({ comments: roundBetween }).client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(second.failedTurn).toMatchObject({ run: 9101, failedRunning: 2 });
      expect(afterRound.failedTurn).toMatchObject({ run: 9102, failedRunning: 1 });
    });

    it("counts from the session's start when it has no Round yet", async () => {
      const { client } = repoWith({ comments: [aFailedTurn("2026-11-12T08:00:00Z", 9100), reply("2026-11-12T09:00:00Z"), aFailedTurn("2026-11-12T10:00:00Z", 9101)] });

      const read = await readRound(client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read).toMatchObject({ waits: "failed-turn", round: null, failedTurn: { failedRunning: 2 } });
    });

    it("from an earlier release, with no run in its hidden line, gives no run or address and is still counted", async () => {
      const { client } = repoWith({ comments: [aFailedTurn("2026-11-12T08:00:00Z", 9100), reply("2026-11-12T09:00:00Z"), aFailedTurn("2026-11-12T10:00:00Z")] });

      const read = await readRound(client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read.failedTurn).toEqual({ sentence: "A Design-session turn failed 2 hours ago. Reply on the issue to run it again.", run: null, url: null, failedRunning: 2 });
    });

    it("waits no more once the Operator has replied, as the turn runs again", async () => {
      const { client } = repoWith({ comments: [aRound(1, "2026-11-12T06:00:00Z"), reply("2026-11-12T07:00:00Z"), aFailedTurn("2026-11-12T08:00:00Z", 9100), reply("2026-11-12T09:00:00Z")] });

      const read = await readRound(client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read).toMatchObject({ waits: "nothing", failedTurn: null });
    });

    it("is not the Map cap's refusal, which opens like one: nothing waits, and the refusal is not counted", async () => {
      const refusal = (at: string) => aRawComment(aMapCapRefusal(at).body, at);
      const refused = [aRound(1, "2026-11-12T06:00:00Z"), reply("2026-11-12T07:00:00Z"), refusal("2026-11-12T08:00:00Z")];
      const failedAround = [aFailedTurn("2026-11-12T05:00:00Z", 9100), reply("2026-11-12T06:00:00Z"), refusal("2026-11-12T07:00:00Z"), reply("2026-11-12T08:00:00Z"), aFailedTurn("2026-11-12T09:00:00Z", 9101)];

      const read = await readRound(repoWith({ comments: refused }).client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);
      const counted = await readRound(repoWith({ comments: failedAround }).client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read).toMatchObject({ waits: "nothing", failedTurn: null });
      expect(counted.failedTurn).toMatchObject({ failedRunning: 2 });
    });
  });

  describe("waits on nothing", () => {
    const waitingRound = [aRound(1, "2026-11-12T09:00:00Z")];

    it("on a closed issue, one that still carries needs-design included", async () => {
      const read = await readRound(repoWith({ state: "CLOSED", comments: waitingRound }).client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read).toMatchObject({ waits: "nothing", round: null, failedTurn: null });
    });

    it("on a closed issue whose last word is a failed turn", async () => {
      const read = await readRound(
        repoWith({ state: "CLOSED", comments: [aRawComment(aDesignTurnFailedNotice("2026-11-12T09:00:00Z", 9100).body, "2026-11-12T09:00:00Z")] }).client,
        "jrey8343/shop",
        21,
        CONFIG,
        "jrey8343",
        "fabrik-app[bot]",
        NOW,
      );

      expect(read).toMatchObject({ waits: "nothing", round: null, failedTurn: null });
    });

    it("on an issue not in a Design session", async () => {
      const read = await readRound(repoWith({ labels: ["ready-for-agent"], comments: waitingRound }).client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read).toMatchObject({ waits: "nothing", round: null, failedTurn: null });
    });

    it("once the session has ended, its Rounds left behind with it", async () => {
      const ended = [...waitingRound, aRawComment(`${SESSION_FINISHED} The Kit filed a Spec.`, "2026-11-12T10:00:00Z")];

      const read = await readRound(repoWith({ comments: ended }).client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read).toMatchObject({ waits: "nothing", round: null, failedTurn: null });
    });

    it("in a session that a Ticket's return started, until it posts a Round of its own", async () => {
      const returned = [...waitingRound, aRawComment("<!-- fabrik:back-to-design 50 operator -->\nThis Ticket came back from #50.", "2026-11-12T10:00:00Z")];

      const read = await readRound(repoWith({ comments: returned }).client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read).toMatchObject({ waits: "nothing", round: null });
    });

    it("while a prototype is being built", async () => {
      const request = prototypeRequestMarker({ request: { route: "/cart", variants: 2, brief: "Two ways to show the cart." }, reply: 6001 });
      const building = [...waitingRound, aRawComment("Yes, prototype it.", "2026-11-12T10:00:00Z", OPERATOR, 6001), aRawComment(`${request}\n**Prototype requested.**`, "2026-11-12T10:30:00Z")];

      const read = await readRound(repoWith({ comments: building }).client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read).toMatchObject({ waits: "nothing", round: { round: 1, waiting: false }, failedTurn: null });
    });

    it("while a turn runs that agent:design started, which no reply did, once the Kit has said more since the Round", async () => {
      const request = prototypeRequestMarker({ request: { route: "/cart", variants: 2, brief: "Two ways to show the cart." }, reply: null });
      const building = [...waitingRound, aRawComment(`${request}\n**Prototype requested.**`, "2026-11-12T10:30:00Z")];

      const read = await readRound(repoWith({ comments: building }).client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read.waits).toBe("nothing");
    });
  });

  describe("reads only the Fabrik App's comments as the Kit's", () => {
    it("never a person's comment that quotes a Round, marker and line included", async () => {
      const quoted = aRound(2, "2026-11-12T10:30:00Z", anOrdinaryLine(2), 5002);
      const { client } = repoWith({
        comments: [aRound(1, "2026-11-12T09:00:00Z", anOrdinaryLine(1), 5001), aRawComment("The cart.", "2026-11-12T10:00:00Z", OPERATOR), { ...quoted, author: SOMEONE }],
      });

      const read = await readRound(client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read).toMatchObject({ waits: "nothing", round: { comment: 5001, waiting: false } });
    });

    it("never a person's comment that quotes a failed turn's notice", async () => {
      const notice = aDesignTurnFailedNotice("2026-11-12T10:30:00Z", 9100).body;
      const { client } = repoWith({ comments: [aRound(1, "2026-11-12T09:00:00Z"), aRawComment("The cart.", "2026-11-12T10:00:00Z", OPERATOR), aRawComment(notice, "2026-11-12T10:30:00Z", SOMEONE)] });

      const read = await readRound(client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read).toMatchObject({ waits: "nothing", failedTurn: null });
    });

    it("never another bot's when the App's login is known, and any bot's when it is not", async () => {
      const other = { __typename: "Bot", login: "renovate" };
      const comments = [{ ...aRound(1, "2026-11-12T09:00:00Z", anOrdinaryLine(1), 5001), author: other }];

      const known = await readRound(repoWith({ comments }).client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);
      const unknown = await readRound(repoWith({ comments }).client, "jrey8343/shop", 21, CONFIG, "jrey8343", null, NOW);

      expect(known).toMatchObject({ waits: "nothing", round: null });
      expect(unknown).toMatchObject({ waits: "round", round: { comment: 5001 } });
    });
  });

  describe("whether a Map may be offered", () => {
    const capOf = (maps: number): KitConfigResult => ({ ok: true, config: { ...DEFAULT_KIT_CONFIG, caps: { ...DEFAULT_KIT_CONFIG.caps, maps } } });

    it.each([
      ["the cap has room", { parent: null }, [], CONFIG, true],
      ["the open Maps fill the cap", { parent: null }, [12], CONFIG, false],
      ["the cap is 0", { parent: null }, [], capOf(0), false],
      ["the issue has a parent Spec", { parent: 3 }, [], CONFIG, false],
      ["two open Maps leave a cap of 3 room", { parent: null }, [12, 13], capOf(3), true],
    ] as const)("when %s, as a Design turn on the issue would be told", async (_case, issue, maps, config, offered) => {
      const { client } = repoWith({ ...issue, comments: [aRound(1, "2026-11-12T09:00:00Z")] }, maps);

      const read = await readRound(client, "jrey8343/shop", 21, config, "jrey8343", "fabrik-app[bot]", NOW);
      const told = config.ok ? await readMapOffer(client, { owner: "jrey8343", name: "shop" }, config.config, issue.parent === null ? null : { number: issue.parent }) : null;

      expect(read.mapMayBeOffered).toBe(offered);
      expect(told?.kind === "may-offer").toBe(offered);
    });

    it("never on a Kit config that does not read, which runs no Design turn", async () => {
      const read = await readRound(repoWith({ comments: [aRound(1, "2026-11-12T09:00:00Z")] }).client, "jrey8343/shop", 21, { ok: false, errors: ["maxInFlight is not a Kit config field"] }, "jrey8343", "fabrik-app[bot]", NOW);

      expect(read.mapMayBeOffered).toBe(false);
    });
  });

  describe("unread", () => {
    const REFUSAL = new GitHubError("GitHub POST /graphql failed: 403", 403, { body: JSON.stringify({ message: "Resource not accessible by integration" }), request: "POST /graphql" });
    const UNREAD = { repo: "jrey8343/shop", issue: 21, readAt: NOW, waits: "unread", round: null, failedTurn: null, mapMayBeOffered: false };

    it.each([
      ["refused", REFUSAL],
      ["failed", new GitHubError("GitHub POST /graphql failed: 502", 502, { body: "Bad Gateway", request: "POST /graphql" })],
      ["never answered", new Error("fetch failed")],
    ])("when GitHub %s the issue's request, or the open Maps', with no Round, no failed turn and no Map offered", async (_how, error) => {
      const { client } = repoWith({ comments: [aRound(1, "2026-11-12T09:00:00Z")] });
      const failing = (which: "issue" | "maps"): ReadClient => ({
        ...client,
        graphql: <T>(query: string, variables: Record<string, unknown>) => ((variables["map"] === undefined) === (which === "issue") ? Promise.reject(error) : client.graphql<T>(query, variables)),
      });

      expect(await readRound(failing("issue"), "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW)).toEqual(UNREAD);
      expect(await readRound(failing("maps"), "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW)).toEqual(UNREAD);
    });

    it("when the issue is not one GitHub has", async () => {
      const client: ReadClient = { ...repoWith({}).client, graphql: <T>(_query: string, variables: Record<string, unknown>) => Promise.resolve((variables["map"] === undefined ? { repository: { issue: null } } : { repository: { issues: { nodes: [] } } }) as T) };

      expect(await readRound(client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW)).toEqual(UNREAD);
    });
  });

  it("asks GitHub for the issue's last 100 comments, with who wrote each and each one's id, and for the open Maps", async () => {
    const { client, queries } = repoWith({ comments: [aRound(1, "2026-11-12T09:00:00Z")] });

    await readRound(client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

    expect(queries).toHaveLength(2);
    expect(queries.find((query) => query.includes("issue(number: $issue)"))).toMatch(/comments\(last: 100\) \{ nodes \{ databaseId url body createdAt author \{ login __typename \} \} \}/);
  });

  it("is plain data: it comes back equal after being written as JSON and read again", async () => {
    const { client } = repoWith({ comments: [aRound(1, "2026-11-12T06:00:00Z"), aRawComment("The cart.", "2026-11-12T07:00:00Z", OPERATOR), aRawComment(aDesignTurnFailedNotice("2026-11-12T09:00:00Z", 9100).body, "2026-11-12T09:00:00Z")] });

    const read = await readRound(client, "jrey8343/shop", 21, CONFIG, "jrey8343", "fabrik-app[bot]", NOW);

    expect(JSON.parse(JSON.stringify(read))).toStrictEqual(read);
  });
});

describe("The Round read in the read library", () => {
  it("is held by the interface fixture, a read of each kind of wait", async () => {
    const reads = (await EXPORT_CALLS["readRound"]?.()) as readonly RoundRead[];

    expect(reads.map(({ waits }) => waits).toSorted()).toEqual(["failed-turn", "nothing", "round", "unread"]);
    expect(EXPORT_SHAPES["RoundRead"]).toMatchObject({ waits: "round" });
  });
});

describe("Whether a Round waits, for a reader that holds the comments", () => {
  it("is the Round read's own rule over the comments as the gather keeps them", () => {
    const round = { body: [designRoundMarker(1), "Two things to settle."].join("\n"), author: "fabrik-app[bot]", byBot: true };
    const someone = { body: "Hm.", author: "someone-else", byBot: false };
    const operator = { body: "The cart.", author: "jrey8343", byBot: false };

    expect(roundWaitsIn([round, someone], "jrey8343", "fabrik-app[bot]")).toBe(true);
    expect(roundWaitsIn([round, operator], "jrey8343", "fabrik-app[bot]")).toBe(false);
    expect(roundWaitsIn([operator], "jrey8343", "fabrik-app[bot]")).toBe(false);
  });
});
