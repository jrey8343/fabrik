import { describe, expect, it } from "vitest";
import { aDigestFacts, aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { aPullRequest, HEAD_SHA, kitConfig, notificationsOf, snapshotOfPullRequest, verdictsPostedIn } from "../__fixtures__/snapshots.ts";
import type { ChangeFingerprint } from "./changeFingerprint.ts";
import { agentRunIn } from "../github/apply.ts";
import { carriedDigest, placedFilesIn } from "./digestCarry.ts";
import { type DigestCommentRead, type DigestItem, digestCommentOf, digestDataMarker, digestMarker, digestMarkIn, digestTop, noDigestLine, readDigestComment } from "./digestContract.ts";
import type { DigestAsk } from "./digestFacts.ts";
import type { DigestHead, NamedPlace } from "./digestPlaces.ts";
import { planFor } from "./rules.ts";
import type { Action, DigestOnThread, KitIssueSnapshot, LoopEvent, Plan, PullRequestSnapshot } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const REPO = "https://github.com/acme/shop";
/** The head the last Digest was written at, before the pull request was rebased onto `main` to HEAD_SHA. */
const WRITTEN_AT = "b".repeat(40);

/** The pull request's own change, as a Verdict records it: the same on both heads when only `main` moved. */
function aChange(all = "1".repeat(12)): ChangeFingerprint {
  return { v: 1, all, product: "2".repeat(12), files: null };
}

/** An ask of the Operator's, as Kit code lists one: a Request changes, by its id. */
function anAsk(id: string): DigestAsk {
  return { id, what: "request-changes", url: `${REPO}/pull/50#pullrequestreview-${id.replace("review-", "")}` };
}

/** A Digest's comment, written as of `head`, having answered `asks`. */
function aDigestBody(head: string = WRITTEN_AT, asks: readonly string[] = []): string {
  const reply = aDigestReply({ asks: asks.map((id) => ({ id, answer: "in-head", where: "src/basket/save.ts", checkedBy: "reading" })) });
  const rendered = digestCommentOf(reply, aDigestGiven({ repoUrl: REPO, headSha: head, runUrl: RUN, facts: aDigestFacts({ asks: asks.map(anAsk) }) }));
  if (!rendered.ok) throw new Error(rendered.refused);
  return rendered.body;
}

function onThread(body: string, overrides: Partial<DigestOnThread> = {}): DigestOnThread {
  return { node: "IC_last", minimized: false, body, postedAt: "2026-11-10T09:00:00Z", ...overrides };
}

/**
 * #50, a draft rebased onto `main` since its last Digest: that Digest was
 * written at WRITTEN_AT, where the Reviewer's pass recorded the pull
 * request's own change, and the push job has read the same change at its
 * head now, with the Kit's list of asks as that Digest answered it.
 */
function rebased(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return aPullRequest({
    verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: WRITTEN_AT, change: aChange() }],
    digests: [onThread(aDigestBody())],
    change: aChange(),
    asks: [],
    ...overrides,
  });
}

/** The Reviewer passes #50 at its head. */
const PASSED: LoopEvent = { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: "verdict: pass\n\nLooks good.", runUrl: RUN, repoUrl: REPO };

function passOn(pullRequest: PullRequestSnapshot, config = kitConfig()): Plan {
  return planFor(PASSED, snapshotOfPullRequest(pullRequest, { operator: "jrey" }), config);
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** What a pass does after its Verdict. */
function afterTheVerdict(plan: Plan): Action[] {
  return actionsOf(plan).filter((action) => action.kind !== "comment");
}

describe("The Digest carried forward: a pass on a head where only main moved", () => {
  it("carries the last Digest to the new head and opens the Merge gate in the same step, adding no label", () => {
    const pullRequest = rebased();
    const plan = passOn(pullRequest);

    expect(verdictsPostedIn(actionsOf(plan).flatMap((action) => (action.kind === "comment" ? [action.body] : [])))).toMatchObject([{ verdict: "pass", headSha: HEAD_SHA }]);
    expect(afterTheVerdict(plan)).toEqual([
      {
        kind: "carry-digest",
        pullRequest: 50,
        headSha: HEAD_SHA,
        repoUrl: REPO,
        digest: pullRequest.digests[0]!.body,
        carried: [
          { kind: "minimize-comment", pullRequest: 50, node: "IC_last", classifier: "OUTDATED" },
          { kind: "mark-ready-for-review", pullRequest: 50 },
          { kind: "request-review", pullRequest: 50, reviewer: "jrey" },
        ],
        otherwise: [{ kind: "add-labels", issue: 50, labels: ["agent:digest"] }],
      },
    ]);
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  /** A pass with no Digest to carry: the label that starts the Digest writer, and nothing else. */
  const STARTS_THE_WRITER: Action[] = [{ kind: "add-labels", issue: 50, labels: ["agent:digest"] }];

  it.each<[string, Partial<PullRequestSnapshot>]>([
    ["a changed line in the pull request's own change", { change: aChange("9".repeat(12)) }],
    ["a new Request changes since the last Digest", { asks: ["review-9"] }],
    ["a Request changes that Digest answered, dismissed since", { digests: [onThread(aDigestBody(WRITTEN_AT, ["review-8"]))], asks: [] }],
    ["a pass with no fingerprint", { change: undefined }],
    ["a list of asks that was not read", { asks: undefined }],
    ["a last Digest that does not read back, having no data line", { digests: [onThread(aDigestBody().split("\n").toSpliced(1, 1).join("\n"))] }],
    ["a Verdict on the last Digest's head that recorded no fingerprint", { verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: WRITTEN_AT }] }],
    ["no Verdict on the head the last Digest names", { digests: [onThread(aDigestBody("c".repeat(40)))] }],
    ["no Digest on the thread", { digests: [] }],
  ])("%s carries nothing, and the pass adds agent:digest", (_what, overrides) => {
    expect(afterTheVerdict(passOn(rebased(overrides)))).toEqual(STARTS_THE_WRITER);
  });

  it("the same asks carry, by the ids the last Digest's first line names, in Kit code's order", () => {
    const answered = ["review-8", "inline-21"];
    const carries = (asks: readonly string[]): boolean => afterTheVerdict(passOn(rebased({ digests: [onThread(aDigestBody(WRITTEN_AT, answered))], asks }))).some(({ kind }) => kind === "carry-digest");

    expect(carries(answered)).toBe(true);
    expect(carries(["review-8"])).toBe(false);
    expect(carries(["review-8", "inline-21", "review-30"])).toBe(false);
  });

  it("weighs only the newest Digest, whatever head it names: an older one that would carry is not reached past it", () => {
    const newest = onThread(aDigestBody("c".repeat(40)), { node: "IC_newest", postedAt: "2026-11-11T09:00:00Z" });

    expect(afterTheVerdict(passOn(rebased({ digests: [onThread(aDigestBody()), newest] })))).toEqual(STARTS_THE_WRITER);
  });

  it("comes before the held check: with every Subscription used up it still carries, and only with the files unread does the no-Digest line open the gate", () => {
    const rotating = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
    const usedUp = (number: number, subscription: string): KitIssueSnapshot => ({
      number,
      labels: ["fabrik:weekly-limit"],
      body: [`The weekly usage limit of the \`${subscription}\` Subscription is reached.`, "", `<!-- fabrik:subscription ${subscription} -->`, "<!-- fabrik:resets-at 2026-11-16T04:00:00.000Z -->"].join("\n"),
      comments: [],
    });
    const plan = planFor(PASSED, snapshotOfPullRequest(rebased(), { operator: "jrey", kitIssues: [usedUp(40, "Claude token"), usedUp(41, "Claude token 2")] }), rotating);

    expect(afterTheVerdict(plan)).toMatchObject([
      {
        kind: "carry-digest",
        otherwise: [
          { kind: "comment", issue: 50, body: noDigestLine({ head: HEAD_SHA, how: "no-subscription" }) },
          { kind: "mark-ready-for-review", pullRequest: 50 },
          { kind: "request-review", pullRequest: 50, reviewer: "jrey" },
        ],
      },
    ]);
  });

  it("starts no run and adds no label, so no Run record is written for a carried Digest", () => {
    const [carry] = afterTheVerdict(passOn(rebased()));
    if (carry?.kind !== "carry-digest") throw new Error("expected the pass to carry the Digest");
    const lands = [...actionsOf(passOn(rebased())), ...carry.carried];

    // A Run record is written only for an agent job's run, which only a trigger label or a started run brings.
    expect(lands.filter(({ kind }) => kind === "start-agent-run" || kind === "hold-agent-run" || kind === "add-labels")).toEqual([]);
    expect(agentRunIn(passOn(rebased()))).toBeNull();
  });

  it("with the Digest off in Kit config, nothing is carried and the gate opens as it always has", () => {
    expect(afterTheVerdict(passOn(rebased(), kitConfig({ digest: { enabled: false } })))).toEqual([
      { kind: "mark-ready-for-review", pullRequest: 50 },
      { kind: "request-review", pullRequest: 50, reviewer: "jrey" },
    ]);
  });
});

/** The saved-basket rule as the last Digest's head had it: a hundred lines, `const line1 = 1;` to `const line100 = 100;`. */
const SAVE_LINES = Array.from({ length: 100 }, (_, index) => `const line${index + 1} = ${index + 1};`);
const SAVE = `${SAVE_LINES.join("\n")}\n`;
/** Twelve lines `main` gained above the rule since. */
const TWELVE_FROM_MAIN = Array.from({ length: 12 }, (_, index) => `import { helper${index + 1} } from "./helpers.ts";`);
const SAVE_MOVED_DOWN_12 = `${[...TWELVE_FROM_MAIN, ...SAVE_LINES].join("\n")}\n`;

const NEW_HEAD = HEAD_SHA;
const WHERE = { repoUrl: REPO, pullRequest: 50, headSha: NEW_HEAD };
const BLOB = `${REPO}/blob/${NEW_HEAD}`;

function anItem(claim: string, places: readonly NamedPlace[]): DigestItem {
  return { kind: "yours-to-judge", claim, sentence: "The Ticket did not say.", asks: [], places, suggestedRequest: null };
}

function inSave(start: number, end: number): NamedPlace {
  return { path: "src/basket/save.ts", start, end, as: "code" };
}

/** What a head holds of the saved-basket rule, and the pull request's files there. */
function aHead(text: string | null = SAVE, changed: DigestHead["changed"] = []): DigestHead {
  return { files: [{ path: "src/basket/save.ts", text }], changed };
}

/** A Digest written as of WRITTEN_AT, with these items, against what that head held. */
function writtenDigest(items: readonly DigestItem[] = [], head: DigestHead = aHead()): string {
  const rendered = digestCommentOf(aDigestReply({ items }), aDigestGiven({ repoUrl: REPO, headSha: WRITTEN_AT, runUrl: RUN, head }));
  if (!rendered.ok) throw new Error(rendered.refused);
  return rendered.body;
}

function carried(digest: string, head: DigestHead = aHead()): string {
  const body = carriedDigest(digest, WHERE, head);
  if (body === null) throw new Error("expected the Digest to be carried");
  return body;
}

function readBack(body: string): Extract<DigestCommentRead, { ok: true }> {
  const read = readDigestComment(body);
  if (!read.ok) throw new Error(`expected a Digest that reads back, got ${read.why}`);
  return read;
}

describe("The Digest carried forward: the comment posted for the new head", () => {
  it("names the new head, the same asks and the head it was written at on its hidden first line", () => {
    const body = carried(aDigestBody(WRITTEN_AT, ["review-8", "inline-21"]));

    expect(digestMarkIn(body)).toEqual({ head: NEW_HEAD, asks: ["review-8", "inline-21"], carriedFrom: WRITTEN_AT });
    expect(body.split("\n")[0]).toBe(`<!-- fabrik:digest {"head":"${NEW_HEAD}","asks":["review-8","inline-21"],"carriedFrom":"${WRITTEN_AT}"} -->`);
  });

  it("shows one added line under its opening line, saying it was carried over because only main moved", () => {
    const lines = carried(writtenDigest()).split("\n");

    // The two hidden lines, then the opening line for the new head, then the added line.
    expect(lines.slice(2, 5)).toEqual([
      `**Digest** of #50, written as of [\`aaaaaaa\`](${REPO}/pull/50/commits/${NEW_HEAD}).`,
      "Carried over from `bbbbbbb` because only `main` moved.",
      "",
    ]);
    expect(lines.filter((line) => line.startsWith("Carried over from"))).toHaveLength(1);
  });

  it("reuses the folds as they were written, character for character, from the folds line down, the run's link included", () => {
    const written = writtenDigest([anItem("Prices hold for 24 hours.", [inSave(10, 12)])]);
    const fromTheFoldsLine = (body: string): string => body.slice(body.indexOf("<!-- fabrik:digest-folds -->"));

    expect(fromTheFoldsLine(written)).toContain("<summary>The rounds</summary>");
    expect(fromTheFoldsLine(carried(written))).toBe(fromTheFoldsLine(written));
    expect(carried(written).endsWith(`[The run](${RUN})`)).toBe(true);
    expect(readBack(carried(written)).folds).toBe(readBack(written).folds);
  });

  it("carried a second time, keeps the head it was first written at, and says so once", () => {
    const written = writtenDigest([anItem("Prices hold for 24 hours.", [inSave(10, 12)])]);
    const third = "c".repeat(40);
    const again = carriedDigest(carried(written, aHead(SAVE_MOVED_DOWN_12)), { ...WHERE, headSha: third }, aHead(SAVE));
    if (again === null) throw new Error("expected the Digest to be carried again");

    expect(digestMarkIn(again)).toEqual({ head: third, asks: [], carriedFrom: WRITTEN_AT });
    expect(again.split("\n").filter((line) => line.startsWith("Carried over from"))).toEqual(["Carried over from `bbbbbbb` because only `main` moved."]);
    // Its places follow their lines again, and its folds are still the writer's.
    expect(readBack(again).data.items[0]!.places).toMatchObject([{ start: 10, end: 12 }]);
    expect(readBack(again).folds).toBe(readBack(written).folds);
  });

  it("writes a fresh data line, which reads back to what is rendered above the folds", () => {
    const written = writtenDigest([anItem("Prices hold for 24 hours.", [inSave(10, 12)])]);
    const body = carried(written, aHead(SAVE_MOVED_DOWN_12));
    const { data } = readBack(body);
    const [opening, ...top] = digestTop(data, WHERE).split("\n");

    expect(body.split("\n").slice(2, body.split("\n").indexOf("<!-- fabrik:digest-folds -->"))).toEqual([opening, "Carried over from `bbbbbbb` because only `main` moved.", ...top, ""]);
    expect(body).toContain(`${BLOB}/src/basket/save.ts?plain=1#L22-L24`);
    expect(body).not.toContain(`${REPO}/blob/${WRITTEN_AT}`);
    // Its words are as they were when it was written.
    const was = readBack(written).data;
    expect(data).toMatchObject({ v: 1, whatItDoes: was.whatItDoes, howItGotHere: was.howItGotHere, followUps: was.followUps });
    expect(data.items.map(({ claim, sentence }) => ({ claim, sentence }))).toEqual(was.items.map(({ claim, sentence }) => ({ claim, sentence })));
  });

  it("keeps an item's picture as it was", () => {
    const was = readBack(writtenDigest([anItem("The saved basket page is new.", [])]));
    const withAPicture = [
      digestMarker({ head: WRITTEN_AT, asks: [], carriedFrom: null }),
      digestDataMarker({ ...was.data, items: was.data.items.map((item) => ({ ...item, picture: "/basket/saved" })) }),
      digestTop(was.data, { ...WHERE, headSha: WRITTEN_AT }),
      "",
      "<!-- fabrik:digest-folds -->",
      was.folds,
    ].join("\n");

    expect(readBack(carried(withAPicture)).data.items.map(({ picture }) => picture)).toEqual(["/basket/saved"]);
  });

  it("is none for a comment that does not read back as a Digest, and for one too long for GitHub once carried", () => {
    const written = writtenDigest();
    // A Digest at the very limit: its carried copy holds one line more.
    const atTheLimit = `${written}${"x".repeat(65_536 - written.length)}`;

    expect(carriedDigest("Looks good to me.", WHERE, aHead())).toBeNull();
    expect(carriedDigest(written.split("\n").toSpliced(1, 1).join("\n"), WHERE, aHead())).toBeNull();
    expect(atTheLimit).toHaveLength(65_536);
    expect(carriedDigest(atTheLimit, WHERE, aHead())).toBeNull();
  });
});

/** Needs your eyes as a comment shows it: the lines between its heading and the next. */
function needsYourEyesIn(body: string): string[] {
  return (body.split("### Needs your eyes\n\n")[1]?.split("\n\n### ")[0] ?? "").split("\n");
}

describe("The Digest carried forward: re-pointing each place at the new head", () => {
  const PRICES = "Prices hold for 24 hours.";
  const EXPIRY = "Nothing shows a basket expiring.";

  it("asks for each file the Digest's places name, once, and for none of a comment that does not read back", () => {
    const copy = { path: "src/basket/copy.ts", text: "export const copy = {};\n" };
    const places = [inSave(10, 12), { path: "src/basket/copy.ts", start: 1, end: 1, as: "words" as const }, inSave(40, 40)];
    const named = writtenDigest([anItem(PRICES, places), anItem(EXPIRY, [inSave(50, 51)])], { files: [...aHead().files, copy], changed: [] });

    expect(placedFilesIn(named)).toEqual(["src/basket/save.ts", "src/basket/copy.ts"]);
    expect(placedFilesIn(writtenDigest())).toEqual([]);
    expect(placedFilesIn("Looks good to me.")).toEqual([]);
  });

  /** A Digest whose first item points at lines 10 to 12 of the saved-basket rule, and whose second points nowhere. */
  const written = writtenDigest([anItem(PRICES, [inSave(10, 12)]), anItem(EXPIRY, [])]);
  const placesOf = (body: string) => readBack(body).data.items.map(({ claim, places }) => ({ claim, places }));

  it("a place whose lines moved down 12 lines is re-pointed by 12, its fingerprint unchanged", () => {
    const [was] = readBack(written).data.items[0]!.places;
    const body = carried(written, aHead(SAVE_MOVED_DOWN_12));

    expect(was).toMatchObject({ start: 10, end: 12 });
    expect(placesOf(body)).toEqual([
      { claim: PRICES, places: [{ path: "src/basket/save.ts", start: 22, end: 24, as: "code", inDiff: false, fingerprint: was!.fingerprint }] },
      { claim: EXPIRY, places: [] },
    ]);
    expect(needsYourEyesIn(body)).toEqual([
      `- **${PRICES}** The Ticket did not say.`,
      `  [\`src/basket/save.ts\`, lines 22 to 24](${BLOB}/src/basket/save.ts?plain=1#L22-L24)`,
      `- **${EXPIRY}** The Ticket did not say.`,
    ]);
  });

  /** Both items kept, the first with no place left and so no line of links under it. */
  const ITEMS_KEPT_PLACE_DROPPED = [`- **${PRICES}** The Ticket did not say.`, `- **${EXPIRY}** The Ticket did not say.`];

  it.each<[string, DigestHead]>([
    ["whose lines now appear twice in the file", aHead(`${[...SAVE_LINES, ...SAVE_LINES.slice(9, 12)].join("\n")}\n`)],
    ["whose lines are gone, one of them having changed", aHead(SAVE.replace("const line11 = 11;", "const line11 = 110;"))],
    ["whose file the new head no longer has", aHead(null)],
    ["whose file was not among those read", { files: [], changed: [] }],
    ["whose file is now shorter than the place", aHead("const line10 = 10;\nconst line11 = 11;\n")],
  ])("a place %s is dropped, and its item kept", (_what, head) => {
    const body = carried(written, head);

    expect(placesOf(body)).toEqual([
      { claim: PRICES, places: [] },
      { claim: EXPIRY, places: [] },
    ]);
    expect(needsYourEyesIn(body)).toEqual(ITEMS_KEPT_PLACE_DROPPED);
  });

  it("re-points each place by its own lines: one found again beside one that is not", () => {
    const both = writtenDigest([anItem(PRICES, [inSave(10, 12), inSave(40, 40)])]);
    const body = carried(both, aHead(SAVE_MOVED_DOWN_12.replace("const line11 = 11;", "const line11 = 110;")));

    expect(placesOf(body)).toMatchObject([{ claim: PRICES, places: [{ start: 52, end: 52 }] }]);
  });

  it("works inDiff out afresh at the new head: true for a re-pointed place inside the new diff's hunk, false for one outside it", () => {
    /** The pull request's diff of the rule, as GitHub gives it: one hunk, of these lines on the head's side. */
    const changing = (start: number, count: number): DigestHead["changed"] => [{ path: "src/basket/save.ts", patch: `@@ -${start},${count} +${start},${count} @@\n const context = 1;` }];
    // As written, lines 10 to 12 lay inside the diff's hunk and line 40 outside it.
    const both = writtenDigest([anItem(PRICES, [inSave(10, 12), inSave(40, 40)])], aHead(SAVE, changing(8, 10)));
    // At the new head the hunk covers lines 50 to 54: line 40 is now line 52, inside it, and lines 22 to 24 are outside.
    const body = carried(both, aHead(SAVE_MOVED_DOWN_12, changing(50, 5)));

    expect(readBack(both).data.items[0]!.places).toMatchObject([{ start: 10, end: 12, inDiff: true }, { start: 40, end: 40, inDiff: false }]);
    expect(readBack(body).data.items[0]!.places).toMatchObject([{ start: 22, end: 24, inDiff: false }, { start: 52, end: 52, inDiff: true }]);
  });
});
