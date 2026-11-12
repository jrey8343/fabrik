import { describe, expect, it } from "vitest";
import { aDigestReply } from "../__fixtures__/digests.ts";
import { type DigestItem, readDigestReply } from "./digestContract.ts";

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
