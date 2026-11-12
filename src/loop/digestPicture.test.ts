import { describe, expect, it } from "vitest";
import { aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { type DigestData, type DigestGiven, type DigestItem, type DigestReply, digestCommentOf, readDigestComment, readDigestReply } from "./digestContract.ts";

const HEAD = "a".repeat(40);
const BLOB = `https://github.com/acme/shop/blob/${HEAD}`;

/** What the push job hands the contract for #50, whose UI evidence captured `capturedRoutes`: the basket and the saved basket, unless told otherwise. */
function given(capturedRoutes: readonly string[] = ["/basket", "/basket/saved"], rest: Partial<DigestGiven> = {}): DigestGiven {
  return aDigestGiven({ repoUrl: "https://github.com/acme/shop", pullRequest: 50, headSha: HEAD, capturedRoutes, ...rest });
}

function bodyOf(reply: DigestReply, from: DigestGiven = given()): string {
  const comment = digestCommentOf(reply, from);
  if (!comment.ok) throw new Error(`expected a Digest, got the refusal: ${comment.refused}`);
  return comment.body;
}

/** The Digest's data, read back from its comment. */
function dataOf(body: string): DigestData {
  const read = readDigestComment(body);
  if (!read.ok) throw new Error(`expected a Digest's data, got ${read.why}`);
  return read.data;
}

/** Needs your eyes as the comment shows it: the lines between its heading and the next. */
function needsYourEyesIn(body: string): string[] {
  return (body.split("### Needs your eyes\n\n")[1]?.split("\n\n### ")[0] ?? "").split("\n");
}

function anItem(kind: DigestItem["kind"], rest: Partial<DigestItem> = {}): DigestItem {
  return { kind, claim: "The saved basket's page is new.", sentence: "Nothing but its picture shows how it reads on a phone.", asks: [], places: [], picture: null, suggestedRequest: null, ...rest };
}

describe("The picture an item of the Digest writer's reply names", () => {
  it("is one route, or none", () => {
    expect(readDigestReply(aDigestReply({ items: [anItem("yours-to-judge", { picture: "/basket/saved" }), anItem("not-proven")] }))).toMatchObject({
      ok: true,
      output: { items: [{ picture: "/basket/saved" }, { picture: null }] },
    });
  });

  it.each([
    ["is missing", { picture: undefined }],
    ["is a list of routes", { picture: ["/basket", "/basket/saved"] }],
    ["is no text", { picture: 7 }],
  ])("breaks the reply's shape when it %s, naming it", (_what, broken) => {
    expect(readDigestReply(aDigestReply({ items: [anItem("not-proven"), { ...anItem("yours-to-judge"), ...broken } as unknown as DigestItem] }))).toEqual({
      ok: false,
      errors: ["items[1].picture must be a route as text, or null"],
    });
  });

  it("is none when the writer leaves it blank", () => {
    expect(readDigestReply(aDigestReply({ items: [anItem("not-proven", { picture: " " })] }))).toMatchObject({ ok: true, output: { items: [{ picture: null }] } });
  });
});

describe("An item's picture, in the Digest", () => {
  it("lands as the route in the item's data, and is named in words after its places, when the route is one the UI evidence captured", () => {
    const head = { files: [{ path: "src/pages/saved.tsx", text: "one\ntwo\nthree\n" }], changed: [] };
    const reply = aDigestReply({
      items: [
        anItem("yours-to-judge", { picture: "/basket/saved", places: [{ path: "src/pages/saved.tsx", start: 2, end: 3, as: "words" }] }),
        anItem("not-proven", { claim: "Nothing shows a basket expiring." }),
      ],
    });

    const body = bodyOf(reply, given(["/basket", "/basket/saved"], { head }));

    expect(dataOf(body).items.map(({ picture }) => picture)).toEqual(["/basket/saved", null]);
    expect(needsYourEyesIn(body)).toEqual([
      "- **The saved basket's page is new.** Nothing but its picture shows how it reads on a phone.",
      `  [\`src/pages/saved.tsx\`, lines 2 to 3](${BLOB}/src/pages/saved.tsx?plain=1#L2-L3)`,
      "  Picture: the captured route `/basket/saved`",
      "- **Nothing shows a basket expiring.** Nothing but its picture shows how it reads on a phone.",
    ]);
  });

  it("is named straight after the sentence of an item that names no place", () => {
    expect(needsYourEyesIn(bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { picture: "/basket" })] })))).toEqual([
      "- **The saved basket's page is new.** Nothing but its picture shows how it reads on a phone.",
      "  Picture: the captured route `/basket`",
    ]);
  });

  it("is dropped when its route was not captured: the item is kept and the Digest lands", () => {
    const place = { path: "src/pages/saved.tsx", start: 1, end: 1, as: "words" as const };
    const head = { files: [{ path: "src/pages/saved.tsx", text: "one\n" }], changed: [] };
    const reply = aDigestReply({ items: [anItem("yours-to-judge", { picture: "/checkout", places: [place], suggestedRequest: null }), anItem("not-proven", { picture: "/basket" })] });

    const body = bodyOf(reply, given(["/basket", "/basket/saved"], { head }));

    expect(dataOf(body).items).toMatchObject([
      { kind: "yours-to-judge", claim: "The saved basket's page is new.", places: [{ path: "src/pages/saved.tsx", start: 1, end: 1 }], picture: null },
      { kind: "not-proven", picture: "/basket" },
    ]);
    expect(needsYourEyesIn(body)).toEqual([
      "- **The saved basket's page is new.** Nothing but its picture shows how it reads on a phone.",
      `  [\`src/pages/saved.tsx\`, line 1](${BLOB}/src/pages/saved.tsx?plain=1#L1)`,
      "- **The saved basket's page is new.** Nothing but its picture shows how it reads on a phone.",
      "  Picture: the captured route `/basket`",
    ]);
    expect(body).not.toContain("/checkout");
  });

  it.each([
    ["with a slash after it", "/basket/"],
    ["in other letters' case", "/Basket"],
    ["with a query", "/basket?tab=saved"],
    ["with no slash before it", "basket"],
    ["as a longer route that starts with it", "/basket/saved/old"],
    ["at the site's own address", "https://shop.example/basket"],
  ])("is compared with the captured routes exactly: a captured route named %s is no captured route", (_how, picture) => {
    const body = bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { picture })] }));

    expect(dataOf(body).items).toMatchObject([{ picture: null }]);
    expect(body).not.toContain("Picture:");
  });

  it("names a route as code, so that one with a mention in it mentions nobody", () => {
    const body = bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { picture: "/team/@olive" })] }), given(["/team/@olive"]));

    expect(dataOf(body).items).toMatchObject([{ picture: "/team/@olive" }]);
    expect(needsYourEyesIn(body)[1]).toBe("  Picture: the captured route `/team/@olive`");
  });

  it("names a route with a backtick in it as plain words, so its line stays whole and mentions nobody", () => {
    const route = "/a`b/@olive/[x](y)";
    const body = bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { picture: route })] }), given([route]));

    expect(dataOf(body).items).toMatchObject([{ picture: route }]);
    expect(needsYourEyesIn(body)[1]).toBe("  Picture: the captured route /a\\`b/@​olive/\\[x\\](y)");
  });

  it("is dropped, whatever route it names, on a pull request with no captured route", () => {
    const reply = aDigestReply({ items: [anItem("yours-to-judge", { picture: "/basket" }), anItem("not-proven", { picture: "/" })] });

    const body = bodyOf(reply, given([]));

    expect(dataOf(body).items.map(({ picture }) => picture)).toEqual([null, null]);
    expect(needsYourEyesIn(body)).toEqual([
      "- **The saved basket's page is new.** Nothing but its picture shows how it reads on a phone.",
      "- **The saved basket's page is new.** Nothing but its picture shows how it reads on a phone.",
    ]);
  });
});
