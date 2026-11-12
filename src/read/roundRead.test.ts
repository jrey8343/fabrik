import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient } from "../github/client.ts";
import { DEFAULT_KIT_CONFIG, type KitConfigResult } from "../kit/config.ts";
import { designRoundMarker, PROTOTYPE_FAILURE_ROUND_MARKER, PROTOTYPE_ROUND_MARKER } from "../loop/markers.ts";
import { prototypeTurnRefused } from "../loop/failures.ts";
import { type RoundLine, roundLineOf } from "../loop/roundLine.ts";
import { aDesignTurnFailedNotice, aMapCapRefusal } from "./builders.ts";
import { readRound } from "./roundRead.ts";

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
});
