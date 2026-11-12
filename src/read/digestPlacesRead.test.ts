import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient } from "../github/client.ts";
import type { DigestData, DigestDataItem } from "../loop/digestContract.ts";
import { type DigestHead, type NamedPlace, placeAt } from "../loop/digestPlaces.ts";
import { type DigestRead, readDigestPlaces } from "./digestRead.ts";

const HEAD = "a".repeat(40);

/** The saved-basket rule at the head: ten lines. */
const SAVE = [
  'import { store } from "./store.ts";',
  "",
  "export function save(basket: Basket): void {",
  "  store.put(basket.id, basket.lines);",
  "  store.put(`${basket.id}:prices`, basket.prices);",
  "  store.expire(basket.id, DAY);",
  "}",
  "",
  "export const DAY = 24 * 60 * 60;",
  "export const LIMIT = 50;",
  "",
].join("\n");

/** What the pull request did to it, as GitHub's API gives the file's patch: one hunk over its first nine lines, the tenth outside it. */
const SAVE_PATCH = [
  "@@ -1,8 +1,9 @@",
  ' import { store } from "./store.ts";',
  " ",
  " export function save(basket: Basket): void {",
  "-  store.set(basket.id, basket.lines);",
  "+  store.put(basket.id, basket.lines);",
  "+  store.put(`${basket.id}:prices`, basket.prices);",
  "-  store.expire(basket.id, HOUR);",
  "+  store.expire(basket.id, DAY);",
  " }",
  " ",
  "-export const HOUR = 60 * 60;",
  "+export const DAY = 24 * 60 * 60;",
].join("\n");

/** The basket page's copy at the head, which the pull request does not change. */
const COPY = ["export const copy = {", '  save: "Save basket",', '  saved: "Saved for 24 hours",', "};", ""].join("\n");

/** What the head held when the Digest was written. */
const WRITTEN_AT: DigestHead = {
  files: [
    { path: "src/basket/save.ts", text: SAVE },
    { path: "src/basket/copy.ts", text: COPY },
  ],
  changed: [{ path: "src/basket/save.ts", patch: SAVE_PATCH }],
};

/** A place as Kit code wrote it into the Digest, from what the head held then. */
function written(path: string, start: number, end: number, as: NamedPlace["as"] = "code") {
  const place = placeAt({ path, start, end, as }, WRITTEN_AT);
  if (place === null) throw new Error(`${path} ${start} to ${end} does not resolve in the head`);
  return place;
}

/** A readable Digest of #50 at HEAD whose items point at these places, one item for each list. */
function aDigestPointingAt(...items: DigestDataItem["places"][]): Extract<DigestRead, { is: "readable" }> {
  const data: DigestData = {
    v: 1,
    items: items.map((places) => ({ kind: "yours-to-judge", claim: "Prices hold for 24 hours.", sentence: "The Implementer chose a day.", places, picture: null, suggestedRequest: null })),
    whatItDoes: "A shopper can now save their basket.",
    howItGotHere: "One Review passed it.",
    followUps: [],
  };
  return { is: "readable", head: HEAD, carriedFrom: null, at: "2026-11-08T18:05:00Z", url: "https://github.com/acme/shop/pull/50#issuecomment-9", data, folds: "" };
}

/** A file of the pull request, as GitHub's REST API lists it. */
interface RestFile {
  readonly filename: string;
  readonly patch?: string;
}

/**
 * acme/shop as GitHub answers for it now: each file's text at HEAD, or the
 * error GitHub refuses it with, and #50's files. Every call the read made is
 * recorded, in order.
 */
function gitHub(
  texts: Readonly<Record<string, string | Error>> = { "src/basket/save.ts": SAVE, "src/basket/copy.ts": COPY },
  files: readonly RestFile[] | Error = [{ filename: "src/basket/save.ts", patch: SAVE_PATCH }],
): { client: ReadClient; calls: string[] } {
  const calls: string[] = [];
  const client: ReadClient = {
    graphql: () => Promise.reject(new Error("The place read asks no GraphQL")),
    rest: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      const [route, query] = path.split("?");
      if (route !== "/repos/acme/shop/pulls/50/files") throw new Error(`unexpected REST call ${path}`);
      if (files instanceof Error) throw files;
      const page = Number(/(?:^|&)page=(\d+)/.exec(query ?? "")?.[1] ?? "1");
      return files.slice((page - 1) * 100, page * 100);
    },
    fileText: async (of, path, ref) => {
      calls.push(`text ${of.owner}/${of.name} ${path}@${ref}`);
      const text = texts[path];
      if (text instanceof Error) throw text;
      return text ?? null;
    },
  };
  return { client, calls };
}

describe("The read of a Digest's places, made when a screen opens", () => {
  it("gives code inside the diff as its diff hunk: the hunk's lines from the place's first to its last, each with its marker, and the removed lines between them", async () => {
    const digest = aDigestPointingAt([written("src/basket/save.ts", 5, 6)]);

    expect(await readDigestPlaces(gitHub().client, "acme/shop", 50, digest)).toEqual([
      {
        item: 0,
        place: 0,
        path: "src/basket/save.ts",
        start: 5,
        end: 6,
        as: "code",
        inDiff: true,
        show: "hunk",
        text: ["+  store.put(`${basket.id}:prices`, basket.prices);", "-  store.expire(basket.id, HOUR);", "+  store.expire(basket.id, DAY);"].join("\n"),
      },
    ]);
  });

  it("takes the removed lines directly above a hunk's first line with it, and no removed line below its last", async () => {
    const digest = aDigestPointingAt([written("src/basket/save.ts", 4, 4), written("src/basket/save.ts", 7, 9)]);

    expect(await readDigestPlaces(gitHub().client, "acme/shop", 50, digest)).toMatchObject([
      { item: 0, place: 0, start: 4, end: 4, show: "hunk", text: "-  store.set(basket.id, basket.lines);\n+  store.put(basket.id, basket.lines);" },
      { item: 0, place: 1, start: 7, end: 9, show: "hunk", text: " }\n \n-export const HOUR = 60 * 60;\n+export const DAY = 24 * 60 * 60;" },
    ]);
  });

  it("gives code outside the diff, and words wherever they are, as the plain lines from the head", async () => {
    const digest = aDigestPointingAt([written("src/basket/save.ts", 9, 10), written("src/basket/copy.ts", 2, 3, "words"), written("src/basket/save.ts", 5, 6, "words")]);

    expect(digest.data.items[0]?.places.map(({ inDiff }) => inDiff)).toEqual([false, false, true]);
    expect(await readDigestPlaces(gitHub().client, "acme/shop", 50, digest)).toEqual([
      { item: 0, place: 0, path: "src/basket/save.ts", start: 9, end: 10, as: "code", inDiff: false, show: "lines", text: "export const DAY = 24 * 60 * 60;\nexport const LIMIT = 50;" },
      { item: 0, place: 1, path: "src/basket/copy.ts", start: 2, end: 3, as: "words", inDiff: false, show: "lines", text: '  save: "Save basket",\n  saved: "Saved for 24 hours",' },
      { item: 0, place: 2, path: "src/basket/save.ts", start: 5, end: 6, as: "words", inDiff: true, show: "lines", text: "  store.put(`${basket.id}:prices`, basket.prices);\n  store.expire(basket.id, DAY);" },
    ]);
  });

  it("leaves out a place whose lines at the head no longer match its fingerprint, and returns the others at the positions the data gives them", async () => {
    const digest = aDigestPointingAt([written("src/basket/copy.ts", 3, 3, "words")], [written("src/basket/copy.ts", 2, 2, "words"), written("src/basket/save.ts", 10, 10)]);
    // The words on line 3 are not the ones the Digest writer pointed at.
    const { client } = gitHub({ "src/basket/save.ts": SAVE, "src/basket/copy.ts": COPY.replace("Saved for 24 hours", "Saved for a day") });

    expect(await readDigestPlaces(client, "acme/shop", 50, digest)).toMatchObject([
      { item: 1, place: 0, path: "src/basket/copy.ts", start: 2, end: 2, text: '  save: "Save basket",' },
      { item: 1, place: 1, path: "src/basket/save.ts", start: 10, end: 10, text: "export const LIMIT = 50;" },
    ]);
  });

  it("leaves out a place whose file the head no longer has, whose lines run past its end, or that GitHub refuses to give", async () => {
    const digest = aDigestPointingAt([written("src/basket/copy.ts", 2, 2, "words"), written("src/basket/save.ts", 10, 10)]);
    const refused = new GitHubError("GitHub GET the file failed: 403", 403, { body: JSON.stringify({ message: "This API returns blobs up to 1 MB in size." }) });

    expect(await readDigestPlaces(gitHub({ "src/basket/save.ts": SAVE }).client, "acme/shop", 50, digest)).toMatchObject([{ item: 0, place: 1 }]);
    expect(await readDigestPlaces(gitHub({ "src/basket/save.ts": "export {};\n", "src/basket/copy.ts": COPY }).client, "acme/shop", 50, digest)).toMatchObject([{ item: 0, place: 0 }]);
    expect(await readDigestPlaces(gitHub({ "src/basket/save.ts": SAVE, "src/basket/copy.ts": refused }).client, "acme/shop", 50, digest)).toMatchObject([{ item: 0, place: 1 }]);
  });

  it("asks only for the files the places name, once each at the Digest's head, and for the pull request's files", async () => {
    const digest = aDigestPointingAt([written("src/basket/save.ts", 5, 6), written("src/basket/copy.ts", 3, 3, "words")], [written("src/basket/save.ts", 10, 10)]);
    const { client, calls } = gitHub();

    await readDigestPlaces(client, "acme/shop", 50, digest);

    expect(calls.toSorted()).toEqual(["GET /repos/acme/shop/pulls/50/files?per_page=100&page=1", `text acme/shop src/basket/copy.ts@${HEAD}`, `text acme/shop src/basket/save.ts@${HEAD}`]);
  });

  it("asks GitHub nothing for a Digest that points at no place", async () => {
    const { client, calls } = gitHub();

    expect(await readDigestPlaces(client, "acme/shop", 50, aDigestPointingAt([], []))).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("gives a hunk GitHub gives no patch for as the plain lines", async () => {
    const digest = aDigestPointingAt([written("src/basket/save.ts", 5, 6)]);
    const { client } = gitHub(undefined, [{ filename: "src/basket/save.ts" }]);

    expect(await readDigestPlaces(client, "acme/shop", 50, digest)).toMatchObject([
      { inDiff: true, show: "lines", text: "  store.put(`${basket.id}:prices`, basket.prices);\n  store.expire(basket.id, DAY);" },
    ]);
  });

  it("gives the plain lines when the pull request's diff is no longer of the Digest's head: its hunk no longer holds the place's lines, or no hunk holds the place", async () => {
    const digest = aDigestPointingAt([written("src/basket/save.ts", 5, 6)]);
    const plain = [{ show: "lines", text: "  store.put(`${basket.id}:prices`, basket.prices);\n  store.expire(basket.id, DAY);" }];
    const movedOn = SAVE_PATCH.replace("+  store.expire(basket.id, DAY);", "+  store.expire(basket.id, WEEK);");
    const elsewhere = "@@ -20,2 +21,3 @@\n context\n+added\n context";

    expect(await readDigestPlaces(gitHub(undefined, [{ filename: "src/basket/save.ts", patch: movedOn }]).client, "acme/shop", 50, digest)).toMatchObject(plain);
    expect(await readDigestPlaces(gitHub(undefined, [{ filename: "src/basket/save.ts", patch: elsewhere }]).client, "acme/shop", 50, digest)).toMatchObject(plain);
  });

  it("is unread, and never throws, when GitHub fails the pull request's files or a file for a reason that says nothing of the file", async () => {
    const digest = aDigestPointingAt([written("src/basket/save.ts", 5, 6)]);
    const badGateway = new GitHubError("GitHub GET failed: 502", 502, { body: "Bad Gateway" });
    const rateLimited = new GitHubError("GitHub GET failed: 403", 403, { body: JSON.stringify({ message: "API rate limit exceeded" }), rateLimitRemaining: "0" });

    expect(await readDigestPlaces(gitHub(undefined, badGateway).client, "acme/shop", 50, digest)).toBe("unread");
    expect(await readDigestPlaces(gitHub({ "src/basket/save.ts": rateLimited }).client, "acme/shop", 50, digest)).toBe("unread");
  });

  it("returns plain data: it comes back equal after being written as JSON and read again", async () => {
    const digest = aDigestPointingAt([written("src/basket/save.ts", 5, 6), written("src/basket/copy.ts", 3, 3, "words")]);

    const shown = await readDigestPlaces(gitHub().client, "acme/shop", 50, digest);

    expect(shown).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(shown))).toStrictEqual(shown);
  });
});
