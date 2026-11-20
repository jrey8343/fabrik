// What the Review's jobs collect of a head's Evidence shots (#820): a reading
// of the named check's artifact against the pull request's names, and whether
// a miss in it sends the pull request back before the Reviewer starts.
import { describe, expect, it } from "vitest";
import { collectShots, type ReviewShots, reviewShotsFrom, shotsCollectedOf } from "./shotsCollect.ts";
import { type ArtifactFile, readShotsManifest } from "./shotsManifest.ts";

const HEAD = "a".repeat(40);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (name: string): ArtifactFile => ({ name, size: 2048, start: PNG });

/** A manifest of these entries, with a PNG beside it for each image they list. */
function artifactOf(shots: readonly Record<string, unknown>[]) {
  const files = shots.flatMap((shot) => Object.values((shot["images"] ?? {}) as Record<string, string>).map(png));
  return readShotsManifest(JSON.stringify({ version: 1, shots }), files);
}

const draftReady = {
  name: "composer: draft ready",
  journey: "write-a-clinical-note",
  path: "/patients/6f1b2c3d/notes/new",
  images: { mobile: "draft-ready.mobile.png", desktop: "draft-ready.desktop.png" },
};
const inboxEmpty = { name: "inbox: empty", images: { mobile: "inbox-empty.mobile.png", desktop: "inbox-empty.desktop.png" } };
const signIn = { name: "sign in: form", images: { mobile: "sign-in.mobile.png" } };

/** What the Kit job's plan started the Review with: the pull request's names, sent back at HEAD when a miss is found. */
function given(names: readonly string[], overrides: Partial<ReviewShots> = {}): ReviewShots {
  return { check: "e2e", artifact: "fabrik-evidence-shots", names, sendsBackAt: HEAD, ...overrides };
}

describe("What the Review's jobs collect of a head's Evidence shots (#820)", () => {
  it("gives each named shot the run produced, in the names' order, with its Journey, path and images, and every shot's name", () => {
    const collected = collectShots({ reading: artifactOf([inboxEmpty, draftReady, signIn]), given: given(["composer: draft ready", "inbox: empty"]), head: HEAD, red: false });

    expect(collected).toEqual({
      check: "e2e",
      artifact: "fabrik-evidence-shots",
      head: HEAD,
      failure: null,
      red: false,
      named: [
        { name: "composer: draft ready", journey: "write-a-clinical-note", path: "/patients/6f1b2c3d/notes/new", images: draftReady.images },
        { name: "inbox: empty", images: inboxEmpty.images },
      ],
      missed: [],
      produced: ["inbox: empty", "composer: draft ready", "sign in: form"],
      pastLimit: 0,
      sendsBack: false,
    });
  });

  it.each([
    ["the manifest lacks", [inboxEmpty], "not-produced"],
    ["two entries share", [inboxEmpty, draftReady, { ...draftReady, path: "/other" }], "ambiguous-name"],
    ["the artifact's rules refused", [inboxEmpty, { ...draftReady, images: { mobile: "../draft.png" } }], "refused"],
  ])("sends the pull request back for a name %s, at the head an Implementer run pushed with a Retry left", (_, shots, why) => {
    const collected = collectShots({ reading: artifactOf(shots), given: given(["inbox: empty", "composer: draft ready"]), head: HEAD, red: false });

    expect(collected.missed).toEqual([{ name: "composer: draft ready", why }]);
    expect(collected.named.map(({ name }) => name)).toEqual(["inbox: empty"]);
    expect(collected.sendsBack).toBe(true);
  });

  it.each([
    ["no Retry is left or no Implementer run pushed the head", { sendsBackAt: null }, HEAD, false],
    ["the head has moved on from the one the plan judged", {}, "b".repeat(40), false],
    ["the named check is still red after the re-run", {}, HEAD, true],
  ])("sends nothing back for a missed name when %s, and still shows what the run produced", (_, overrides, head, red) => {
    const collected = collectShots({ reading: artifactOf([inboxEmpty]), given: given(["inbox: empty", "composer: draft ready"], overrides), head, red });

    expect(collected.missed).toEqual([{ name: "composer: draft ready", why: "not-produced" }]);
    expect(collected.named.map(({ name }) => name)).toEqual(["inbox: empty"]);
    expect(collected.red).toBe(red);
    expect(collected.sendsBack).toBe(false);
  });

  it("counts a shot with one size as produced, lists the missing size, and sends nothing back", () => {
    const collected = collectShots({ reading: artifactOf([signIn]), given: given(["sign in: form"]), head: HEAD, red: false });

    expect(collected.named).toEqual([{ name: "sign in: form", images: { mobile: "sign-in.mobile.png" } }]);
    expect(collected.missed).toEqual([{ name: "sign in: form", viewport: "desktop", why: "size-missing" }]);
    expect(collected.sendsBack).toBe(false);
  });

  it("finds no miss on a pull request whose Implementer said nothing visible changes, and keeps its sentence", () => {
    const collected = collectShots({ reading: artifactOf([inboxEmpty]), given: given([], { nothingVisible: "Only the API changed." }), head: HEAD, red: false });

    expect(collected).toMatchObject({ named: [], missed: [], produced: ["inbox: empty"], nothingVisible: "Only the API changed.", sendsBack: false });
  });

  it("is no-artifact when the check's run uploaded no artifact of that name, and sends nothing back", () => {
    expect(collectShots({ reading: null, given: given(["inbox: empty"]), head: HEAD, red: false })).toMatchObject({
      failure: "no-artifact",
      named: [],
      missed: [],
      produced: [],
      sendsBack: false,
    });
  });

  it("is bad-manifest when the manifest can't be read, and sends nothing back", () => {
    expect(collectShots({ reading: readShotsManifest("{ not json", []), given: given(["inbox: empty"]), head: HEAD, red: false })).toMatchObject({
      failure: "bad-manifest",
      named: [],
      missed: [],
      sendsBack: false,
    });
  });

  it("counts the shots dropped past the first 100", () => {
    const shots = Array.from({ length: 103 }, (_, at) => ({ name: `shot ${at}`, images: { mobile: `shot-${at}.png` } }));

    expect(collectShots({ reading: artifactOf(shots), given: given(["shot 1"]), head: HEAD, red: false })).toMatchObject({ pastLimit: 3, missed: [{ why: "size-missing" }] });
  });
});

describe("Reading what a Review was started with, as the review job's steps read the Kit job's output (#820)", () => {
  it("reads it back as the Kit job wrote it", () => {
    const shots = given(["composer: draft ready"], { nothingVisible: "Only the API changed." });

    expect(reviewShotsFrom(JSON.stringify(shots))).toEqual(shots);
    expect(reviewShotsFrom(JSON.stringify(given([], { sendsBackAt: null })))).toEqual(given([], { sendsBackAt: null }));
  });

  it.each([
    ["isn't JSON", "{"],
    ["names no check", JSON.stringify({ ...given([]), check: "" })],
    ["holds a name that breaks the name rule", JSON.stringify(given(["@octocat"]))],
    ["sends back at no full sha", JSON.stringify(given([], { sendsBackAt: "main" }))],
  ])("throws when it %s, since only Kit code wrote it", (_, text) => {
    expect(() => reviewShotsFrom(text)).toThrow("FABRIK_UI_SHOTS");
  });
});

describe("Reading what the Review's jobs collected, as the push job and the Reviewer's runner read it (#820)", () => {
  const collected = collectShots({ reading: artifactOf([inboxEmpty, draftReady, signIn]), given: given(["composer: draft ready", "sign in: form"]), head: HEAD, red: false });

  it("reads it back as it was written", () => {
    expect(shotsCollectedOf(JSON.stringify(collected))).toEqual(collected);
  });

  it.each([
    ["isn't JSON", "{"],
    ["is empty", ""],
    ["names no head", JSON.stringify({ ...collected, head: "main" })],
    ["names no check", JSON.stringify({ ...collected, check: 7 })],
  ])("is none when it %s", (_, text) => {
    expect(shotsCollectedOf(text)).toBeNull();
  });

  it("drops what breaks the artifact's rules, as an edited output might hold, rather than pass it on", () => {
    const edited = {
      ...collected,
      named: [
        { name: "@octocat", images: { mobile: "a.png" } },
        { name: "composer: draft ready", journey: "x\ny", path: "no-slash", images: { mobile: "../../etc/passwd", desktop: "draft-ready.desktop.png" } },
      ],
      missed: [{ name: "<b>", why: "not-produced" }, { name: "inbox: empty", why: "made-up" }],
      produced: ["inbox: empty", "<script>"],
    };

    expect(shotsCollectedOf(JSON.stringify(edited))).toMatchObject({
      named: [{ name: "composer: draft ready", images: { desktop: "draft-ready.desktop.png" } }],
      missed: [],
      produced: ["inbox: empty"],
    });
  });
});
