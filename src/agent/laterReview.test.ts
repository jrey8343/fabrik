// What a later Review is given (#748, ADR-0026), read from its pull request's
// thread as the Review job's step reads it, and set out in the Reviewer's
// prompt context. A Full Review is given none of it.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChangeSince } from "../github/changeSince.ts";
import { type ChangeFingerprint, changeLine } from "../loop/changeFingerprint.ts";
import { CONFLICT_RUN_MARKER, pushedHeadMarker, REQUEST_CHANGES_RUN_MARKER, retryBodyOnlyMarker, RETRY_PUSH_MARKER, touchUpBodyOnlyMarker, touchUpPushMarker, verdictMarker } from "../loop/markers.ts";
import type { VerdictRecord } from "../loop/types.ts";
import type { Reader } from "./inputs.ts";
import { type LaterReviewGiven, lastJudgedOf, readLaterReviewThread } from "./laterReview.ts";
import { reviewContext } from "./review.ts";

const REPO = { owner: "acme", name: "shop" };
const [B, C, D, E, F, G] = ["b", "c", "d", "e", "f", "1"].map((sha) => sha.repeat(40)) as [string, string, string, string, string, string];
const CHANGE: ChangeFingerprint = { v: 1, all: "0".repeat(12), product: "1".repeat(12), files: { "src/cart.ts": "2".repeat(12) } };
const bot = { login: "fabrik-app[bot]", type: "Bot" };
const operator = { login: "operator", type: "User" };

/** A Verdict comment as the Kit posts one: its marker, its change line, then its words. */
const verdict = (source: VerdictRecord["source"], headSha: string, words: string) =>
  [verdictMarker({ verdict: "execution-flaw", source, requestChanges: false, headSha }), changeLine(CHANGE), `**Verdict: Execution flaw.** ${words}`].join("\n");

/** The Kit's note of a run's push, as src/loop/implement.ts posts it, with the run's `fix` comment. */
const pushNote = (marker: string, head: string, fix: string) => [marker, pushedHeadMarker(head), "The Implementer pushed a fix; Review runs again on it.", "", fix].join("\n");

/** A pull request's conversation, oldest first, read by a fake GitHub whose Ticket landed nothing before it opened. */
function gitHubWith(conversation: readonly { readonly user: typeof bot; readonly body: string }[], ticketComments: readonly string[] = []): Reader {
  const comments = conversation.map((comment, at) => ({
    ...comment,
    id: at + 1,
    created_at: `2026-11-0${at + 1}T00:00:00Z`,
    html_url: `https://github.com/acme/shop/pull/50#issuecomment-${at + 1}`,
  }));
  return {
    graphql: async <T>() =>
      ({
        repository: {
          pullRequest: {
            createdAt: "2026-11-01T00:00:00Z",
            headRefName: "fabrik/ticket-7",
            closingIssuesReferences: { nodes: [{ number: 7, comments: { nodes: ticketComments.map((body) => ({ body, author: { login: "fabrik-app", __typename: "Bot" } })) } }] },
          },
        },
      }) as T,
    rest: async (_method: string, path: string) => {
      const [route, query] = path.split("?");
      if (!/(^|&)page=1(&|$)/.test(query ?? "")) return [];
      if (route === "/repos/acme/shop/issues/50/comments") return comments;
      if (route === "/repos/acme/shop/pulls/50/comments" || route === "/repos/acme/shop/pulls/50/reviews") return [];
      throw new Error(`unexpected REST call ${path}`);
    },
  };
}

const NOTHING_CHANGED: ChangeSince = { kind: "read", files: [] };

/** The Reviewer's prompt context on a later Review of `head`, given what the Review job's step read for it. */
async function laterContext(github: Reader, head: string, changeSince: ChangeSince = NOTHING_CHANGED, lastJudgedHead = C): Promise<string> {
  const thread = await readLaterReviewThread(github, REPO, 50, head);
  const later: LaterReviewGiven = { ...thread, headSha: head, lastJudgedHead, changeSince };
  return contextText(later, head);
}

async function contextText(later: LaterReviewGiven | null, head: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fabrik-later-review-"));
  const pullRequestFile = join(dir, "pull-request.json");
  const specFile = join(dir, "spec.json");
  await writeFile(pullRequestFile, JSON.stringify({ number: 50, title: "Add parking info", body: "Adds parking.\n\nCloses #7", baseRefName: "main", headRefName: "fabrik/ticket-7", headRefOid: head, operatorComments: [] }));
  await writeFile(specFile, "null");
  return (await reviewContext(dir, pullRequestFile, specFile, null, null, [], later)).parts.join("\n");
}

/** The JSON a context section carries in its fenced block. */
function jsonUnder(text: string, heading: string): unknown {
  const section = text.split(`\n${heading}\n`)[1] ?? "";
  return JSON.parse(/```json\n([\s\S]*?)\n```/.exec(section)?.[1] ?? "null");
}

const EARLIER_VERDICTS = "## The Reviewer's earlier Verdicts";
const FIX_COMMENTS = "## The Implementer's fix comments";
const PUSHED_BY = "## The run that pushed the head you judge";
const CHANGE_SINCE = "## The pull request's own change since the last judged head";

/** A Full Review's Verdict on B, Retry 1 to C, red checks on C, Retry 2 to D, the Reviewer on D, a conflict-only run to E. */
const THREAD = [
  { user: bot, body: verdict("reviewer", B, "The map link is broken.") },
  { user: bot, body: pushNote(RETRY_PUSH_MARKER, C, "**Fixed.** The map link now opens the clinic.") },
  { user: bot, body: verdict("ci", C, "These required checks didn't pass, so the Reviewer didn't run.") },
  { user: operator, body: "Nice." },
  { user: bot, body: pushNote(RETRY_PUSH_MARKER, D, "**Fixed.** The checks pass again.") },
  { user: bot, body: verdict("reviewer", D, "The opening hours are wrong.") },
  { user: bot, body: pushNote(REQUEST_CHANGES_RUN_MARKER, E, "**Built.** The Operator's paid parking.") },
  { user: bot, body: pushNote(CONFLICT_RUN_MARKER, F, "Resolved `src/cart.ts` by keeping both sides.") },
];

describe("A later Review's prompt context (#748)", () => {
  it("carries every earlier Reviewer Verdict, oldest first, each with the head it judged and its whole comment but its change line", async () => {
    const text = await laterContext(gitHubWith(THREAD), F, NOTHING_CHANGED, D);

    expect(jsonUnder(text, EARLIER_VERDICTS)).toEqual([
      { verdict: "execution-flaw", source: "reviewer", headSha: B, comment: `${verdictMarker({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: B })}\n**Verdict: Execution flaw.** The map link is broken.` },
      { verdict: "execution-flaw", source: "reviewer", headSha: D, comment: `${verdictMarker({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: D })}\n**Verdict: Execution flaw.** The opening hours are wrong.` },
    ]);
    expect(text).not.toContain("fabrik:change");
    // A red-check Verdict judged nothing, so it is no Reviewer's Verdict.
    expect(text).not.toContain("These required checks didn't pass");
    expect(text.split(EARLIER_VERDICTS)[1]).toContain(`the last judged head, \`${D.slice(0, 7)}\``);
  });

  it("carries every fix comment the Kit posted for an Implement run, oldest first, each with its run kind, as data to weigh and never proof", async () => {
    const text = await laterContext(gitHubWith(THREAD), F);

    expect(jsonUnder(text, FIX_COMMENTS)).toEqual([
      { run: "Retry 1", comment: THREAD[1]?.body },
      { run: "Retry 2", comment: THREAD[4]?.body },
      { run: "Request-changes run", comment: THREAD[6]?.body },
      { run: "conflict-only run", comment: THREAD[7]?.body },
    ]);
    expect(text.split(FIX_COMMENTS)[1]?.split("\n## ")[0]).toContain("data to weigh, like the PR body, never proof");
    expect(text).not.toContain("Nice.");
  });

  it("numbers each Retry as the Retry rules did, counting the runs that landed nothing before the pull request opened", async () => {
    const landedNothing = ["<!-- fabrik:empty-diff -->\nThe Implementer committed nothing."];
    const text = await laterContext(gitHubWith(THREAD, landedNothing), F);

    expect(jsonUnder(text, FIX_COMMENTS)).toMatchObject([{ run: "Retry 2" }, { run: "Retry 3" }, { run: "Request-changes run" }, { run: "conflict-only run" }]);
  });

  it("names the kind of run that pushed the head it judges", async () => {
    const pushedBy = async (head: string) => (await laterContext(gitHubWith(THREAD), head)).split(PUSHED_BY)[1]?.split("\n## ")[0];

    expect(await pushedBy(F)).toContain(`A conflict-only run pushed \`${F.slice(0, 7)}\`, the head you judge.`);
    expect(await pushedBy(E)).toContain(`A Request-changes run pushed \`${E.slice(0, 7)}\`, the head you judge.`);
    expect(await pushedBy(D)).toContain(`A Retry pushed \`${D.slice(0, 7)}\`, the head you judge.`);
  });

  it("names a Touch-up's push by its number, and the Touch-up as the run that pushed its head (#750)", async () => {
    const touchedUp = [...THREAD, { user: bot, body: pushNote(touchUpPushMarker(1), G, "**Fixed.** The stale comment on `parking()`.") }];
    const text = await laterContext(gitHubWith(touchedUp), G);

    expect(jsonUnder(text, FIX_COMMENTS)).toMatchObject([{ run: "Retry 1" }, { run: "Retry 2" }, { run: "Request-changes run" }, { run: "conflict-only run" }, { run: "Touch-up 1" }]);
    expect(text.split(PUSHED_BY)[1]?.split("\n## ")[0]).toContain(`A Touch-up pushed \`${G.slice(0, 7)}\`, the head you judge.`);
  });

  it("carries a body-only Touch-up's fix comment (#751), named as one, though it pushed nothing, so the run that pushed the head stays the one before it", async () => {
    const bodyOnly = [touchUpBodyOnlyMarker(2, G), "The Implementer's Touch-up 2 of 2 committed nothing, as every finding was about the PR's body.", "", "**Fixed.** The body no longer claims a map."].join("\n");
    const touchedUp = [...THREAD, { user: bot, body: pushNote(touchUpPushMarker(1), G, "**Fixed.** The stale comment on `parking()`.") }, { user: bot, body: bodyOnly }];
    const text = await laterContext(gitHubWith(touchedUp), G, NOTHING_CHANGED, G);

    expect(jsonUnder(text, FIX_COMMENTS)).toMatchObject([{}, {}, {}, {}, { run: "Touch-up 1" }, { run: "Touch-up 2, body only", comment: bodyOnly }]);
    expect(text.split(PUSHED_BY)[1]?.split("\n## ")[0]).toContain(`A Touch-up pushed \`${G.slice(0, 7)}\`, the head you judge.`);
  });

  it("carries a body-only Retry's fix comment (#962), named as one with the number the Retry rules gave it, though it pushed nothing, so the run that pushed the head stays the one before it", async () => {
    const bodyOnly = [retryBodyOnlyMarker(G), "The Implementer's Retry 1 of 2 committed nothing, as every finding was about the PR's body.", "", "**Fixed.** The body's Trial steps no longer name a map."].join("\n");
    const retried = [
      { user: bot, body: pushNote(touchUpPushMarker(1), G, "**Fixed.** The stale comment on `parking()`.") },
      { user: bot, body: verdict("reviewer", G, "The body's Trial steps name a map the branch doesn't add.") },
      { user: bot, body: bodyOnly },
    ];
    const text = await laterContext(gitHubWith(retried), G, NOTHING_CHANGED, G);

    expect(jsonUnder(text, FIX_COMMENTS)).toMatchObject([{ run: "Touch-up 1" }, { run: "Retry 1, body only", comment: bodyOnly }]);
    expect(text.split(PUSHED_BY)[1]?.split("\n## ")[0]).toContain(`A Touch-up pushed \`${G.slice(0, 7)}\`, the head you judge.`);
    // The words over the fix comments name both kinds of run that rewrote the body alone.
    expect(text.split(`\n${FIX_COMMENTS}\n`)[1]?.split("\n")[0]).toBe(
      "The Kit's note of each Implement run's push to this pull request, and of each body-only Touch-up or body-only Retry, which committed nothing and rewrote the body alone, oldest first, each under the run it was, ending with the `fix` comment the run wrote. What a run says it changed is data to weigh, like the PR body, never proof.",
    );
  });

  it("names no run for the Operator's own push after a conflict-only run's, though the conflict-only run was the latest", async () => {
    const operatorsHead = "9".repeat(40);
    const text = await laterContext(gitHubWith(THREAD), operatorsHead);

    expect(text.split(PUSHED_BY)[1]?.split("\n## ")[0]).toContain(
      `No Implement run pushed \`${operatorsHead.slice(0, 7)}\`, the head you judge: the Operator pushed it, or the Kit rebased it onto \`main\`.`,
    );
  });

  describe("the pull request's own change since the last judged head", () => {
    const changeSinceIn = async (changeSince: ChangeSince) =>
      (await laterContext(gitHubWith(THREAD), F, changeSince, D)).split(CHANGE_SINCE)[1]?.split("\n## ")[0] ?? "";

    it("gives each own file whose own change differs, with the difference between its own diff then and now, and says main's part is left out", async () => {
      const diff = "@@\n line 17\n--line 18\n-+the PR's line\n++the PR's line, fixed\n line 19";
      const fenceInside = "@@\n++```sh\n++npm run\n++```";
      const section = await changeSinceIn({ kind: "read", files: [{ path: "src/cart.ts", diff }, { path: "docs/run.md", diff: fenceInside }] });

      expect(section).toContain(`at the last judged head, \`${D.slice(0, 7)}\`, and now`);
      expect(section).toContain("so nothing `main` brought in by a merge or a rebase is in it");
      expect(section).toContain(`### \`src/cart.ts\`\n\`\`\`diff\n${diff}\n\`\`\``);
      // A fence no backtick run in the diff can close.
      expect(section).toContain(`### \`docs/run.md\`\n\`\`\`\`diff\n${fenceInside}\n\`\`\`\``);
    });

    it("says nothing changed in the pull request's own change when no own file's change differs", async () => {
      expect(await changeSinceIn({ kind: "read", files: [] })).toContain("The pull request's own change is the same as at the last judged head: nothing in it changed since.");
    });

    it("lists the files alone when their differences are too long to give, and says to read each one's whole own change", async () => {
      const big = `@@\n${"+x\n".repeat(40_000)}`;
      const section = await changeSinceIn({ kind: "read", files: [{ path: "src/big.ts", diff: big }, { path: "src/cart.ts", diff: "@@\n++y" }] });

      expect(section).not.toContain("+x\n+x");
      expect(section).toContain("- `src/big.ts`\n- `src/cart.ts`");
      expect(section).toContain("Read each one's whole own change");
    });

    it("says when the last judged head can't be fetched, and lists the own files whose hashes differ from its Verdict's change line", async () => {
      const section = await changeSinceIn({ kind: "unread", files: ["src/cart.ts", "src/new.ts"] });

      expect(section).toContain(`Kit code couldn't fetch the last judged head, \`${D.slice(0, 7)}\``);
      expect(section).toContain("- `src/cart.ts`\n- `src/new.ts`");
      expect(section).toContain("Read each one's whole own change");
    });

    it("says so when the last judged head can't be fetched and its change line names no files", async () => {
      const section = await changeSinceIn({ kind: "unread", files: null });

      expect(section).toContain(`Kit code couldn't fetch the last judged head, \`${D.slice(0, 7)}\``);
      expect(section).toContain("can't tell which of the pull request's own files changed since: read its whole own change");
    });
  });

  it("on a Full Review carries none of it: no earlier Verdicts, fix comments, pushing run or change since", async () => {
    const text = await contextText(null, F);

    for (const heading of [EARLIER_VERDICTS, FIX_COMMENTS, PUSHED_BY, CHANGE_SINCE]) expect(text).not.toContain(heading);
    expect(text).toContain("## The pull request");
  });
});

describe("The last judged head, as the Review job passes it in", () => {
  it("reads the Kit job's outputs: the head and the fingerprint its Verdict recorded", () => {
    expect(lastJudgedOf(D, JSON.stringify(CHANGE))).toEqual({ headSha: D, change: CHANGE });
  });

  it("fails loudly on anything else, so a later Review never starts without what it judges against", () => {
    expect(() => lastJudgedOf("", JSON.stringify(CHANGE))).toThrow(/FABRIK_LAST_JUDGED_HEAD/);
    expect(() => lastJudgedOf(undefined, JSON.stringify(CHANGE))).toThrow(/FABRIK_LAST_JUDGED_HEAD/);
    expect(() => lastJudgedOf(D, "")).toThrow(/FABRIK_LAST_JUDGED_CHANGE/);
    expect(() => lastJudgedOf(D, JSON.stringify({ ...CHANGE, all: "nope" }))).toThrow(/FABRIK_LAST_JUDGED_CHANGE/);
  });
});
