import { describe, expect, it } from "vitest";
import { aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import {
  DIGEST_FOLDS_MARKER,
  type DigestGiven,
  type DigestReply,
  digestCommentOf,
  digestMarkIn,
  isDigestComment,
  NO_DIGEST_HOWS,
  noDigestIn,
  noDigestLine,
  parseDigestReply,
  readDigestReply,
} from "./digestContract.ts";
import { GITHUB_COMMENT_LIMIT } from "./roundLine.ts";

const HEAD = "a".repeat(40);
const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

const GIVEN: DigestGiven = aDigestGiven({ repoUrl: "https://github.com/acme/shop", pullRequest: 50, headSha: HEAD, runUrl: RUN });

/** A reply as the Digest writer emits one, keeping its shape, for a pull request one Review passed. */
function aReply(overrides: Partial<DigestReply> = {}): DigestReply {
  return aDigestReply({ howItGotHere: "One Review passed it at the first head.", ...overrides });
}

function bodyOf(reply: DigestReply, given: DigestGiven = GIVEN): string {
  const comment = digestCommentOf(reply, given);
  if (!comment.ok) throw new Error(`expected a Digest, got the refusal: ${comment.refused}`);
  return comment.body;
}

describe("The Digest's comment", () => {
  it("is rendered from the reply's fields and Kit code's facts: the hidden first line naming the head, an opening line, the three sections, the folds line and the three folds, and a link to the run", () => {
    expect(bodyOf(aReply())).toBe(
      [
        `<!-- fabrik:digest {"head":"${HEAD}"} -->`,
        `**Digest** of #50, written as of [\`aaaaaaa\`](https://github.com/acme/shop/pull/50/commits/${HEAD}).`,
        "",
        "### What it does",
        "",
        "A shopper can now save their basket from /basket. A saved basket keeps its prices for a day.",
        "",
        "### How it got here",
        "",
        "One Review passed it at the first head.",
        "",
        "### Follow-ups",
        "",
        "None named.",
        "",
        "<!-- fabrik:digest-folds -->",
        "<details>",
        "<summary>Walk me through it</summary>",
        "",
        "```",
        "on save:",
        "  store the lines",
        "  store the prices shown",
        "```",
        "",
        "1. The basket page's Save button.",
        "2. The saved-basket rule.",
        "",
        "</details>",
        "",
        "<details>",
        "<summary>Decided without you, and left alone</summary>",
        "",
        "- **Decided:** prices hold for a day; the Ticket did not say.",
        "- **Left alone:** sharing a saved basket by link.",
        "",
        "</details>",
        "",
        "<details>",
        "<summary>The rounds</summary>",
        "",
        "| Who | What | Effect on the code |",
        "| --- | --- | --- |",
        "| The Implementer | The first run | |",
        "| The Reviewer | Pass | |",
        "",
        "One Review, which passed it.",
        "",
        "</details>",
        "",
        `[The run](${RUN})`,
      ].join("\n"),
    );
  });

  it("names its head on its first line, which reads back", () => {
    const body = bodyOf(aReply());

    expect(digestMarkIn(body)).toEqual({ head: HEAD });
    expect(isDigestComment(body)).toBe(true);
  });

  it("puts the folds under one hidden line, in the order they are read", () => {
    const [top, folds] = bodyOf(aReply()).split(`\n${DIGEST_FOLDS_MARKER}\n`);

    expect(top).toContain("### What it does");
    expect(top).not.toContain("<details>");
    expect(folds?.match(/<summary>(.*)<\/summary>/g)).toEqual([
      "<summary>Walk me through it</summary>",
      "<summary>Decided without you, and left alone</summary>",
      "<summary>The rounds</summary>",
    ]);
  });

  it("takes every mention out, as a Verdict's findings lose theirs", () => {
    const body = bodyOf(
      aReply({ whatItDoes: "Ask @octocat about it.", howItGotHere: "@acme/core passed it.", walkthrough: "1. cc @octocat", decided: "- @octocat decided", roundsLine: "@octocat disagreed." }),
    );

    expect(body).not.toMatch(/(?<![\w`])@[A-Za-z0-9]/);
    expect(body).toContain("Ask @​octocat about it.");
  });

  it("trims the white space around each field, so the layout holds", () => {
    const body = bodyOf(aReply({ whatItDoes: "\n  It adds a button.  \n\n", decided: "\n- Nothing was left alone.\n\n" }));

    expect(body).toContain("### What it does\n\nIt adds a button.\n\n### How it got here");
    expect(body).toContain("<summary>Decided without you, and left alone</summary>\n\n- Nothing was left alone.\n\n</details>");
  });

  it("is refused, never cut, when it would be too long for one GitHub comment", () => {
    const comment = digestCommentOf(aReply({ walkthrough: "x".repeat(GITHUB_COMMENT_LIMIT) }), GIVEN);

    expect(comment).toEqual({ ok: false, refused: expect.stringMatching(/^the Digest would be \d+ characters, over GitHub's limit of 65536 for a comment$/) });
  });
});

describe("The Digest writer's reply", () => {
  it("reads a reply with every field", () => {
    expect(parseDigestReply(JSON.stringify(aReply()))).toEqual({ ok: true, output: aReply() });
  });

  it("refuses a reply that is not JSON", () => {
    expect(parseDigestReply("```json\n{}\n```")).toEqual({ ok: false, errors: [expect.stringMatching(/^The Digest writer's reply is not valid JSON: /)] });
  });

  it("refuses a reply that is not an object", () => {
    expect(readDigestReply(["whatItDoes"])).toEqual({ ok: false, errors: ["The Digest writer's reply must be a JSON object"] });
  });

  it.each(["whatItDoes", "howItGotHere", "walkthrough", "decided"] as const)("refuses a reply with %s missing, naming it", (field) => {
    const { [field]: _left, ...rest } = aReply();

    expect(readDigestReply(rest)).toEqual({ ok: false, errors: [`${field} must be non-empty text`] });
  });

  it("names every field that is mistyped or empty", () => {
    expect(readDigestReply({ ...aReply(), whatItDoes: 7, decided: "   " })).toEqual({
      ok: false,
      errors: ["whatItDoes must be non-empty text", "decided must be non-empty text"],
    });
  });
});

describe("The no-Digest line", () => {
  it("says no Digest could be written for the head, how, and links the run, under its hidden line", () => {
    expect(noDigestLine({ head: HEAD, how: "timed-out", runUrl: RUN })).toBe(
      [
        `<!-- fabrik:no-digest {"head":"${HEAD}","how":"timed-out"} -->`,
        "No Digest could be written for this head, `aaaaaaa`: `timed-out`, the Digest writer ran past its time limit.",
        "",
        `[The run](${RUN})`,
      ].join("\n"),
    );
  });

  it("gives Kit code's reason on a refusal, with no mention in it", () => {
    const line = noDigestLine({ head: HEAD, how: "refused", reason: "whatItDoes must be non-empty text, says @octocat", runUrl: RUN });

    expect(line).toContain("No Digest could be written for this head, `aaaaaaa`: `refused`, Kit code refused the Digest writer's reply (whatItDoes must be non-empty text, says @​octocat).");
    expect(line).not.toMatch(/(?<![\w`])@[A-Za-z0-9]/);
  });

  it("words each of the five ways an attempt ends with no Digest, and mentions nobody", () => {
    const said = NO_DIGEST_HOWS.map((how) => noDigestLine({ head: HEAD, how }).split("\n")[1]);

    expect(said).toEqual([
      "No Digest could be written for this head, `aaaaaaa`: `failed`, the Digest writer's run failed.",
      "No Digest could be written for this head, `aaaaaaa`: `timed-out`, the Digest writer ran past its time limit.",
      "No Digest could be written for this head, `aaaaaaa`: `refused`, Kit code refused the Digest writer's reply.",
      "No Digest could be written for this head, `aaaaaaa`: `no-subscription`, no Subscription was free to run the Digest writer.",
      "No Digest could be written for this head, `aaaaaaa`: `never-started`, the Digest writer's run never started.",
    ]);
  });

  it("links no run when it has none to link", () => {
    expect(noDigestLine({ head: HEAD, how: "never-started" }).split("\n")).toHaveLength(2);
  });

  it("reads back to its head and how, and is a Digest comment to whoever filters them", () => {
    const line = noDigestLine({ head: HEAD, how: "refused", reason: "it broke its shape", runUrl: RUN });

    expect(noDigestIn(line)).toEqual({ head: HEAD, how: "refused" });
    expect(isDigestComment(line)).toBe(true);
    expect(digestMarkIn(line)).toBeNull();
  });

  it("is not read from a comment that only quotes one further down, nor from another marker", () => {
    expect(noDigestIn(`Quoting:\n${noDigestLine({ head: HEAD, how: "failed" })}`)).toBeNull();
    expect(noDigestIn(`<!-- fabrik:no-digest {"head":"${HEAD}","how":"lost"} -->\nNo Digest`)).toBeNull();
    expect(isDigestComment('<!-- fabrik:verdict {"verdict":"pass"} -->\n## Verdict: Pass')).toBe(false);
    expect(isDigestComment(`<!-- fabrik:digest-folds -->\n<details>`)).toBe(false);
  });
});
