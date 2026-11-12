import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { aPullRequest, HEAD_SHA, kitConfig, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { type DigestData, type DigestGiven, type DigestItem, type DigestReply, digestCommentOf, noDigestLine, readDigestComment, readDigestReply } from "./digestContract.ts";
import { planFor } from "./rules.ts";
import type { Action } from "./types.ts";

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

describe("A Digest with a picture, as the push job lands it", () => {
  const pullRequest = aPullRequest({ labels: ["agent:digest"], verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }] });
  const GATE_OPENS = ["remove-label", "mark-ready-for-review", "request-review"];

  function landed(reply: unknown, capturedRoutes: readonly string[]): Action[] {
    const from = aDigestGiven({ headSha: HEAD_SHA, capturedRoutes });
    const plan = planFor({ kind: "digest-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: JSON.stringify(reply), given: from, runUrl: from.runUrl }, snapshotOfPullRequest(pullRequest), kitConfig());
    return plan.kind === "act" ? [...plan.actions] : [];
  }
  const reply = aDigestReply({ items: [anItem("yours-to-judge", { picture: "/basket/saved" }), anItem("not-proven", { picture: "/checkout" })] });

  it("lands with the route in its data and its rendering on a pull request whose evidence marker names two routes, the item naming another kept without one", () => {
    const [comment, ...rest] = landed(reply, ["/basket", "/basket/saved"]);
    const body = comment?.kind === "comment" ? comment.body : "";

    expect(dataOf(body).items.map(({ picture }) => picture)).toEqual(["/basket/saved", null]);
    expect(needsYourEyesIn(body)).toEqual([
      "- **The saved basket's page is new.** Nothing but its picture shows how it reads on a phone.",
      "  Picture: the captured route `/basket/saved`",
      "- **The saved basket's page is new.** Nothing but its picture shows how it reads on a phone.",
    ]);
    expect(rest.map(({ kind }) => kind)).toEqual(GATE_OPENS);
  });

  it("lands with every picture dropped on a pull request with no captured route: no picture ever refuses a Digest", () => {
    const [comment, ...rest] = landed(reply, []);
    const body = comment?.kind === "comment" ? comment.body : "";

    expect(dataOf(body).items.map(({ picture }) => picture)).toEqual([null, null]);
    expect(body).not.toContain("Picture:");
    expect(rest.map(({ kind }) => kind)).toEqual(GATE_OPENS);
  });

  it("is refused when an item's picture is a list of routes: the no-Digest line says so, and the gate opens all the same", () => {
    const two = { ...reply, items: [{ ...anItem("yours-to-judge"), picture: ["/basket", "/basket/saved"] }] };
    const [comment, ...rest] = landed(two, ["/basket", "/basket/saved"]);

    expect(comment).toEqual({
      kind: "comment",
      issue: 50,
      body: noDigestLine({ head: HEAD_SHA, how: "refused", reason: "items[0].picture must be a route as text, or null", runUrl: aDigestGiven().runUrl }),
    });
    expect(rest.map(({ kind }) => kind)).toEqual(GATE_OPENS);
  });
});

describe("The Digest writer's prompt, on a picture", () => {
  const prompt = readFileSync(new URL("../../prompts/digest.md", import.meta.url), "utf8");
  const givenSection = prompt.split("\n## What you are given\n")[1]?.split("\n## ")[0] ?? "";
  const eyes = prompt.split("\n### Needs your eyes\n")[1]?.split(/\n###? /)[0] ?? "";
  const output = prompt.split("\n## Your output\n")[1] ?? "";

  it("says the writer is given the captured routes, under UI evidence", () => {
    expect(givenSection).toContain(
      '- "UI evidence": whether the pull request has screenshots of its pages, and its captured routes, the routes those screenshots are of, or that it has none.',
    );
  });

  it("carries the addition: an item about a screen may name one captured route, and a changed screen with no captured route is a not-proven item", () => {
    expect(eyes).toContain("`picture`, on an item about a screen: one captured route, or `null`.");
    expect(eyes).toContain("An item about a screen may name one captured route as its picture");
    expect(eyes).toContain("A changed screen with no captured route is a `not-proven` item");
  });

  it("has the writer name the route exactly as the captured routes list it, and never embed or link an image", () => {
    expect(eyes).toContain('exactly as "UI evidence" lists it');
    expect(eyes).toContain("At most one on an item");
    expect(eyes).toContain("Never embed or link an image");
  });

  it("says what the Kit does with a picture: one that is no captured route is dropped, and its item kept", () => {
    expect(eyes).toContain("The Kit drops a picture whose route is not a captured route, and keeps the item");
    expect(eyes).toContain("The Kit names the route after the item's places");
  });

  it("gives the picture its part of the reply's shape", () => {
    expect(output).toContain("Each has `kind`, `claim`, `sentence`, `asks`, `places`, `picture` and `suggestedRequest`");
    expect(output).toContain("`picture` is one captured route as text, or `null`");
    expect(output).toContain("the link to each place, each picture's route,");
  });

  it("keeps its own example to the rule: an item about a screen names one route as its picture, and the others name none", () => {
    const read = readDigestReply(JSON.parse(/<digest>\n([\s\S]*?)\n<\/digest>/.exec(prompt)?.[1] ?? "null"));
    if (!read.ok) throw new Error(read.errors.join("; "));

    expect(read.output.items.map(({ kind, picture }) => [kind, picture])).toEqual([
      ["asked-not-here", "/basket"],
      ["yours-to-judge", null],
      ["not-proven", null],
    ]);
  });
});

describe("The README's Digest section, on a picture", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = readme.split("\n## Digest\n")[1]?.split("\n## ")[0] ?? "";
  const bullets = section.split("\n").filter((line) => line.startsWith("- **"));
  const picture = bullets.find((line) => line.startsWith("- **A picture**")) ?? "";

  it("comes straight after Places and data", () => {
    expect(bullets[bullets.findIndex((line) => line.startsWith("- **Places and data**")) + 1]).toBe(picture);
    expect(picture).not.toBe("");
  });

  it("says what a picture is, where its routes come from and what Kit code does with one before the Digest lands", () => {
    for (const said of [
      "one picture",
      "a route the pull request's UI evidence captured",
      "never embeds or links an image",
      "`routes`",
      "compared exactly",
      "is dropped, and its item is kept",
      "no UI evidence",
      "written before markers recorded",
      "after the item's places",
      "`picture`",
      "or null",
    ]) {
      expect(picture).toContain(said);
    }
  });

  it("says the writer is told the captured routes, where the section says what the writer is given", () => {
    expect(bullets.find((line) => line.startsWith("- **The Digest writer**")) ?? "").toContain("whether UI evidence exists, and the routes it captured");
  });

  it("no longer says the data's picture is null for now", () => {
    expect(section).not.toContain("null for now");
  });
});
