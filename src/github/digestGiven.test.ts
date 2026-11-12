import { describe, expect, it } from "vitest";
import { digestCommentOf } from "../loop/digestContract.ts";
import type { ReadClient } from "./client.ts";
import { readDigestGiven } from "./digestGiven.ts";

const HEAD = "a".repeat(40);
const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

/** A client that fails the test if anything is read through it. */
const NOTHING_READ: ReadClient = {
  rest: () => Promise.reject(new Error("readDigestGiven read from GitHub's REST API")),
  graphql: () => Promise.reject(new Error("readDigestGiven read from GitHub's GraphQL API")),
  fileText: () => Promise.reject(new Error("readDigestGiven read a file")),
};

describe("What the push job hands the Digest's contract", () => {
  const written = { repoUrl: "https://github.com/acme/shop", pullRequest: 50, headSha: HEAD, runUrl: RUN };

  it("is the repo's address, the pull request, the head and the run's link, as the push job knows them", async () => {
    expect(await readDigestGiven(NOTHING_READ, { owner: "acme", name: "shop" }, written)).toEqual(written);
  });

  it("is what the contract renders a Digest from, beside the writer's reply", async () => {
    const given = await readDigestGiven(NOTHING_READ, { owner: "acme", name: "shop" }, written);
    const comment = digestCommentOf({ whatItDoes: "It adds a button.", howItGotHere: "One Review passed it.", walkthrough: "1. The button.", decided: "- Nothing." }, given);

    expect(comment).toMatchObject({ ok: true, body: expect.stringContaining(`[The run](${RUN})`) });
  });
});
