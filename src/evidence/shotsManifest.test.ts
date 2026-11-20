import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { forbiddenImportsFrom } from "../read/importWalk.ts";
import { type ArtifactFile, DROP_REASONS, droppedShotSentence, namedShots, readShotsManifest, type ShotsManifest } from "./shotsManifest.ts";

/** How every PNG file starts: its eight-byte signature. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG beside the manifest, as a caller lists it: its name, its size and how it starts. */
function png(name: string, size = 48_213): ArtifactFile {
  return { name, size, start: Uint8Array.from([...PNG_SIGNATURE, 0x00, 0x00, 0x00, 0x0d]) };
}

/** The Spec's example manifest: one shot of the composer, at both sizes. */
const SPEC_EXAMPLE = JSON.stringify({
  version: 1,
  shots: [
    {
      name: "composer: draft ready",
      journey: "write-a-clinical-note",
      path: "/patients/6f1b2c3d/notes/new",
      images: { mobile: "composer-draft-ready.mobile.png", desktop: "composer-draft-ready.desktop.png" },
    },
  ],
});

const SPEC_FILES = [png("composer-draft-ready.mobile.png"), png("composer-draft-ready.desktop.png")];

describe("Reading an Evidence shots manifest", () => {
  it("reads the Spec's example as one shot with both images, its Journey and its path", () => {
    expect(readShotsManifest(SPEC_EXAMPLE, SPEC_FILES)).toEqual({
      ok: true,
      shots: [
        {
          name: "composer: draft ready",
          journey: "write-a-clinical-note",
          path: "/patients/6f1b2c3d/notes/new",
          images: { mobile: "composer-draft-ready.mobile.png", desktop: "composer-draft-ready.desktop.png" },
        },
      ],
      dropped: [],
      ambiguous: [],
      pastLimit: 0,
    });
  });

  it.each([
    ["is missing", null],
    ["isn't JSON", "{ version: 1, shots: [] "],
    ["isn't a JSON object", "[]"],
    ["has another version", JSON.stringify({ version: 2, shots: [] })],
    ["has no version", JSON.stringify({ shots: [] })],
    ["has no shots list", JSON.stringify({ version: 1 })],
    ["has shots that aren't a list", JSON.stringify({ version: 1, shots: { name: "composer: draft ready" } })],
  ])("reads a manifest that %s as bad-manifest, with why", (_, manifest) => {
    const read = readShotsManifest(manifest, SPEC_FILES);

    expect(read).toMatchObject({ ok: false, failure: "bad-manifest" });
    expect(read.ok ? null : read.why).toMatch(/\S/);
  });

  it("reads a shot with only one of its two images as a shot with that image", () => {
    const manifest = JSON.stringify({ version: 1, shots: [{ name: "inbox: empty", images: { mobile: "inbox-empty.mobile.png" } }] });

    expect(readShotsManifest(manifest, [png("inbox-empty.mobile.png")])).toMatchObject({
      ok: true,
      shots: [{ name: "inbox: empty", images: { mobile: "inbox-empty.mobile.png" } }],
      dropped: [],
    });
  });

  it("reads a manifest whose shots list is empty as no shots, not as bad-manifest", () => {
    expect(readShotsManifest(JSON.stringify({ version: 1, shots: [] }), [])).toEqual({ ok: true, shots: [], dropped: [], ambiguous: [], pastLimit: 0 });
  });
});

/** A good shot either side of the one under test, so a test sees the rule drop only its own entry. */
const BEFORE = { name: "inbox: empty", images: { mobile: "inbox-empty.mobile.png", desktop: "inbox-empty.desktop.png" } };
const AFTER = { name: "settings: saved", images: { mobile: "settings-saved.mobile.png" } };
const GOOD_FILES = [png("inbox-empty.mobile.png"), png("inbox-empty.desktop.png"), png("settings-saved.mobile.png")];

/** Reads a manifest of BEFORE, the entry under test, then AFTER, beside the good shots' files and `files`. */
function readBetween(entry: unknown, files: readonly ArtifactFile[] = []) {
  return readShotsManifest(JSON.stringify({ version: 1, shots: [BEFORE, entry, AFTER] }), [...GOOD_FILES, ...files]);
}

/** Reading the entry under test kept BEFORE and AFTER, and dropped it alone, for `reason`. */
function droppedAlone(name: unknown, reason: string) {
  return {
    ok: true,
    shots: [BEFORE, AFTER],
    dropped: [{ at: 1, name: typeof name === "string" ? name : null, reason }],
    ambiguous: [],
    pastLimit: 0,
  };
}

describe("The artifact's rules for an Evidence shot's images", () => {
  const name = "composer: draft ready";

  it.each([
    ["in a folder", "shots/composer.mobile.png"],
    ["that climbs out with ..", "../composer.mobile.png"],
    ["that is .. inside a name", "composer..mobile.png"],
    ["with a backslash", "shots\\composer.mobile.png"],
    ["that is hidden", ".composer.mobile.png"],
    ["that is empty", ""],
    ["that isn't text", 7],
  ])("drops an entry whose image's file name is %s, as image-name-not-flat", (_, file) => {
    expect(readBetween({ name, images: { mobile: file } }, [png("composer.mobile.png")])).toEqual(droppedAlone(name, "image-name-not-flat"));
  });

  it.each(["composer.mobile.jpg", "composer.mobile.PNG", "composer.mobile"])("drops an entry whose image %s doesn't end .png, as image-name-not-png", (file) => {
    expect(readBetween({ name, images: { desktop: file } }, [png(file)])).toEqual(droppedAlone(name, "image-name-not-png"));
  });

  it("drops an entry whose image doesn't start as a PNG does, as image-not-a-png", () => {
    const jpeg: ArtifactFile = { name: "composer.mobile.png", size: 30_000, start: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]) };

    expect(readBetween({ name, images: { mobile: "composer.mobile.png" } }, [jpeg])).toEqual(droppedAlone(name, "image-not-a-png"));
  });

  it("drops an entry whose image is shorter than a PNG's signature, as image-not-a-png", () => {
    const stub: ArtifactFile = { name: "composer.mobile.png", size: 4, start: Uint8Array.from(PNG_SIGNATURE.slice(0, 4)) };

    expect(readBetween({ name, images: { mobile: "composer.mobile.png" } }, [stub])).toEqual(droppedAlone(name, "image-not-a-png"));
  });

  it("drops an entry with an image one byte over 1 MB, as image-too-large", () => {
    expect(readBetween({ name, images: { mobile: "composer.mobile.png" } }, [png("composer.mobile.png", 1_048_577)])).toEqual(
      droppedAlone(name, "image-too-large"),
    );
  });

  it("keeps an image of exactly 1 MB", () => {
    expect(readBetween({ name, images: { mobile: "composer.mobile.png" } }, [png("composer.mobile.png", 1_048_576)])).toMatchObject({
      shots: [BEFORE, { name, images: { mobile: "composer.mobile.png" } }, AFTER],
      dropped: [],
    });
  });

  it("drops the whole entry when one of its two images breaks a rule", () => {
    const entry = { name, images: { mobile: "composer.mobile.png", desktop: "composer.desktop.png" } };

    expect(readBetween(entry, [png("composer.mobile.png"), png("composer.desktop.png", 2_000_000)])).toEqual(droppedAlone(name, "image-too-large"));
  });

  it("reads a listed image that isn't beside the manifest as that size absent, keeping the other", () => {
    const entry = { name, images: { mobile: "composer.mobile.png", desktop: "composer.desktop.png" } };

    expect(readBetween(entry, [png("composer.mobile.png")])).toEqual({
      ok: true,
      shots: [BEFORE, { name, images: { mobile: "composer.mobile.png" } }, AFTER],
      dropped: [],
      ambiguous: [],
      pastLimit: 0,
    });
  });

  it("drops an entry none of whose listed images is beside the manifest, as images-not-found", () => {
    expect(readBetween({ name, images: { mobile: "composer.mobile.png" } })).toEqual(droppedAlone(name, "images-not-found"));
  });

  it.each([
    ["no images", { name }],
    ["images that aren't an object", { name, images: ["composer.mobile.png"] }],
    ["neither a mobile nor a desktop image", { name, images: { tablet: "composer.tablet.png" } }],
  ])("drops an entry with %s, as no-images", (_, entry) => {
    expect(readBetween(entry, [png("composer.mobile.png"), png("composer.tablet.png")])).toEqual(droppedAlone(name, "no-images"));
  });

  it("drops an entry that isn't an object, as not-an-entry", () => {
    expect(readBetween("composer: draft ready")).toEqual(droppedAlone(null, "not-an-entry"));
  });

  it("reads no file the manifest doesn't list, beside it or not", () => {
    const manifest = JSON.stringify({ version: 1, shots: [BEFORE] });
    const notAPng: ArtifactFile = { name: "notes.txt", size: 9_000_000, start: Uint8Array.from([0x23, 0x21]) };

    expect(readShotsManifest(manifest, [...GOOD_FILES, notAPng])).toEqual({ ok: true, shots: [BEFORE], dropped: [], ambiguous: [], pastLimit: 0 });
  });
});

describe("The artifact's rules for an Evidence shot's name, Journey and path", () => {
  const images = { mobile: "composer.mobile.png" };
  const files = [png("composer.mobile.png")];
  const eighty = `composer: ${"a".repeat(70)}`;

  it("keeps a name of 80 characters, every one of them allowed", () => {
    const name = "Aa0 :-_/.,".repeat(8);

    expect(name).toHaveLength(80);
    expect(readBetween({ name, images }, files)).toMatchObject({ shots: [BEFORE, { name, images }, AFTER], dropped: [] });
  });

  it("drops a name of 81 characters, as name-too-long", () => {
    const name = `${eighty}a`;

    expect(name).toHaveLength(81);
    expect(readBetween({ name, images }, files)).toEqual(droppedAlone(name, "name-too-long"));
  });

  it.each(["composer:\ndraft ready", "composer:\r\ndraft ready", "composer: draft ready\n"])("drops a name on two lines, as name-not-one-line", (name) => {
    expect(readBetween({ name, images }, files)).toEqual(droppedAlone(name, "name-not-one-line"));
  });

  it.each([
    ["an @, which would mention someone", "composer: ping @jrey8343"],
    ["a <, which could end a comment", "composer --> <script>"],
    ["a backtick", "composer: `draft`"],
    ["a tab", "composer:\tdraft"],
    ["a letter outside A to Z", "composer: brouillon prêt"],
    ["an emoji", "composer: draft ready ✅"],
  ])("drops a name with %s, as name-bad-character", (_, name) => {
    expect(readBetween({ name, images }, files)).toEqual(droppedAlone(name, "name-bad-character"));
  });

  it.each([
    ["no name", { images }],
    ["an empty name", { name: "", images }],
    ["a name that isn't text", { name: 12, images }],
  ])("drops an entry with %s, as name-not-text", (_, entry) => {
    expect(readBetween(entry, files)).toEqual(droppedAlone((entry as { name?: unknown }).name, "name-not-text"));
  });

  it("holds a journey to the same rule as a name, each with its own reason", () => {
    const name = "composer: draft ready";
    expect(readBetween({ name, journey: `${eighty}a`, images }, files)).toEqual(droppedAlone(name, "journey-too-long"));
    expect(readBetween({ name, journey: "write\na note", images }, files)).toEqual(droppedAlone(name, "journey-not-one-line"));
    expect(readBetween({ name, journey: "write @someone", images }, files)).toEqual(droppedAlone(name, "journey-bad-character"));
    expect(readBetween({ name, journey: "", images }, files)).toEqual(droppedAlone(name, "journey-not-text"));
    expect(readBetween({ name, journey: ["write-a-note"], images }, files)).toEqual(droppedAlone(name, "journey-not-text"));
  });

  it("keeps a journey of 80 allowed characters", () => {
    const entry = { name: "composer: draft ready", journey: eighty, images };

    expect(readBetween(entry, files)).toMatchObject({ shots: [BEFORE, entry, AFTER], dropped: [] });
  });

  it.each([
    ["doesn't start with /", "patients/6f1b2c3d"],
    ["starts with //, another host", "//evil.example/notes"],
    ["is a full URL", "https://evil.example/notes"],
    ["isn't text", 404],
  ])("drops an entry whose path %s, as path-not-a-route", (_, path) => {
    const name = "composer: draft ready";

    expect(readBetween({ name, path, images }, files)).toEqual(droppedAlone(name, "path-not-a-route"));
  });

  it("keeps a shot that gives no journey and no path, with neither", () => {
    expect(readBetween({ name: "composer: draft ready", images }, files)).toMatchObject({
      shots: [BEFORE, { name: "composer: draft ready", images }, AFTER],
    });
  });

  it("keeps a path with a query, as a route may have", () => {
    const entry = { name: "composer: draft ready", path: "/patients/6f1b2c3d/notes/new?step=2", images };

    expect(readBetween(entry, files)).toMatchObject({ shots: [BEFORE, entry, AFTER], dropped: [] });
  });
});

describe("The artifact's rules for a run's shots together", () => {
  const files = [...GOOD_FILES, png("composer-a.mobile.png"), png("composer-b.mobile.png")];

  it("makes a name two entries share ambiguous, returns neither under it, and reads the other shots", () => {
    const first = { name: "composer: draft ready", journey: "write-a-note", images: { mobile: "composer-a.mobile.png" } };
    const second = { name: "composer: draft ready", journey: "edit-a-note", images: { mobile: "composer-b.mobile.png" } };
    const manifest = JSON.stringify({ version: 1, shots: [first, BEFORE, second, AFTER] });

    expect(readShotsManifest(manifest, files)).toEqual({
      ok: true,
      shots: [BEFORE, AFTER],
      dropped: [
        { at: 0, name: "composer: draft ready", reason: "duplicate-name" },
        { at: 2, name: "composer: draft ready", reason: "duplicate-name" },
      ],
      ambiguous: ["composer: draft ready"],
      pastLimit: 0,
    });
  });

  it("makes a name ambiguous when the other entry under it broke a rule, keeping that entry's own reason", () => {
    const good = { name: "composer: draft ready", images: { mobile: "composer-a.mobile.png" } };
    const tooLarge = { name: "composer: draft ready", images: { mobile: "composer-huge.mobile.png" } };
    const manifest = JSON.stringify({ version: 1, shots: [good, tooLarge] });

    expect(readShotsManifest(manifest, [...files, png("composer-huge.mobile.png", 5_000_000)])).toEqual({
      ok: true,
      shots: [],
      dropped: [
        { at: 0, name: "composer: draft ready", reason: "duplicate-name" },
        { at: 1, name: "composer: draft ready", reason: "image-too-large" },
      ],
      ambiguous: ["composer: draft ready"],
      pastLimit: 0,
    });
  });

  it("doesn't take names that differ in case or by a space for one name", () => {
    const shots = [
      { name: "composer: draft ready", images: { mobile: "composer-a.mobile.png" } },
      { name: "Composer: draft ready", images: { mobile: "composer-a.mobile.png" } },
      { name: "composer: draft ready ", images: { mobile: "composer-b.mobile.png" } },
    ];

    expect(readShotsManifest(JSON.stringify({ version: 1, shots }), files)).toEqual({ ok: true, shots, dropped: [], ambiguous: [], pastLimit: 0 });
  });

  /** `count` good shots, each with its own name and one image. */
  function manyShots(count: number) {
    return Array.from({ length: count }, (_, at) => ({ name: `step ${at + 1}`, images: { mobile: `step-${at + 1}.mobile.png` } }));
  }
  const manyFiles = (count: number) => Array.from({ length: count }, (_, at) => png(`step-${at + 1}.mobile.png`));

  it("keeps all of 100 shots", () => {
    const read = readShotsManifest(JSON.stringify({ version: 1, shots: manyShots(100) }), manyFiles(100));

    expect(read).toMatchObject({ ok: true, dropped: [], pastLimit: 0 });
    expect(read.ok && read.shots).toHaveLength(100);
  });

  it("keeps the first 100 of 101 shots and reports one dropped past the limit", () => {
    const read = readShotsManifest(JSON.stringify({ version: 1, shots: manyShots(101) }), manyFiles(101));

    expect(read).toMatchObject({ ok: true, dropped: [], pastLimit: 1 });
    expect(read.ok && read.shots).toEqual(manyShots(100));
  });

  it("reads nothing past the limit: an entry there breaks no rule and makes no name ambiguous", () => {
    const shots = [...manyShots(100), { name: "step 1", images: { mobile: "step-1.mobile.png" } }, "not an entry"];
    const read = readShotsManifest(JSON.stringify({ version: 1, shots }), manyFiles(100));

    expect(read).toMatchObject({ ok: true, dropped: [], ambiguous: [], pastLimit: 2 });
    expect(read.ok && read.shots).toEqual(manyShots(100));
  });
});

/** A reading the test expects to have read, so it can be asked of. */
function read(manifest: string, files: readonly ArtifactFile[]): ShotsManifest {
  const reading = readShotsManifest(manifest, files);
  if (!reading.ok) throw new Error(`expected a reading, got bad-manifest: ${reading.why}`);
  return reading;
}

describe("Asking a reading for a pull request's named shots", () => {
  const composer = {
    name: "composer: draft ready",
    journey: "write-a-clinical-note",
    path: "/patients/6f1b2c3d/notes/new",
    images: { mobile: "composer-draft-ready.mobile.png", desktop: "composer-draft-ready.desktop.png" },
  };

  it("answers a shot with both images as produced at both sizes, with nothing missed", () => {
    expect(namedShots(read(SPEC_EXAMPLE, SPEC_FILES), ["composer: draft ready"])).toEqual({
      answers: [{ name: "composer: draft ready", produced: true, shot: composer, sizes: ["mobile", "desktop"] }],
      missed: [],
    });
  });

  it("answers a shot with one image as produced at that size, and the other size as size-missing", () => {
    const manifest = JSON.stringify({ version: 1, shots: [{ name: "inbox: empty", images: { desktop: "inbox-empty.desktop.png" } }] });

    expect(namedShots(read(manifest, [png("inbox-empty.desktop.png")]), ["inbox: empty"])).toEqual({
      answers: [{ name: "inbox: empty", produced: true, shot: { name: "inbox: empty", images: { desktop: "inbox-empty.desktop.png" } }, sizes: ["desktop"] }],
      missed: [{ name: "inbox: empty", viewport: "mobile", why: "size-missing" }],
    });
  });

  it("answers a name no entry has as not-produced", () => {
    expect(namedShots(read(SPEC_EXAMPLE, SPEC_FILES), ["settings: saved"])).toEqual({
      answers: [{ name: "settings: saved", produced: false, why: "not-produced" }],
      missed: [{ name: "settings: saved", why: "not-produced" }],
    });
  });

  it.each([
    ["in another case", "Composer: draft ready"],
    ["with a trailing space", "composer: draft ready "],
    ["with a leading space", " composer: draft ready"],
  ])("compares a name exactly: one %s is not-produced", (_, name) => {
    expect(namedShots(read(SPEC_EXAMPLE, SPEC_FILES), [name]).missed).toEqual([{ name, why: "not-produced" }]);
  });

  it("answers a name two entries share as ambiguous-name, with neither shot under it", () => {
    const shots = [composer, { ...composer, journey: "edit-a-clinical-note" }];

    expect(namedShots(read(JSON.stringify({ version: 1, shots }), SPEC_FILES), ["composer: draft ready"])).toEqual({
      answers: [{ name: "composer: draft ready", produced: false, why: "ambiguous-name" }],
      missed: [{ name: "composer: draft ready", why: "ambiguous-name" }],
    });
  });

  it("answers a name whose entry broke a rule as refused", () => {
    const shots = [{ ...composer, path: "patients/6f1b2c3d" }];

    expect(namedShots(read(JSON.stringify({ version: 1, shots }), SPEC_FILES), ["composer: draft ready"])).toEqual({
      answers: [{ name: "composer: draft ready", produced: false, why: "refused" }],
      missed: [{ name: "composer: draft ready", why: "refused" }],
    });
  });

  it("answers each name in the order asked, and misses in that order", () => {
    const shots = [composer, { name: "inbox: empty", images: { mobile: "inbox-empty.mobile.png" } }, { name: "bad: path", path: "x", images: composer.images }];
    const reading = read(JSON.stringify({ version: 1, shots }), [...SPEC_FILES, png("inbox-empty.mobile.png")]);

    const asked = namedShots(reading, ["bad: path", "inbox: empty", "settings: saved", "composer: draft ready"]);

    expect(asked.answers.map((answer) => [answer.name, answer.produced])).toEqual([
      ["bad: path", false],
      ["inbox: empty", true],
      ["settings: saved", false],
      ["composer: draft ready", true],
    ]);
    expect(asked.missed).toEqual([
      { name: "bad: path", why: "refused" },
      { name: "inbox: empty", viewport: "desktop", why: "size-missing" },
      { name: "settings: saved", why: "not-produced" },
    ]);
  });

  it("answers no names with nothing", () => {
    expect(namedShots(read(SPEC_EXAMPLE, SPEC_FILES), [])).toEqual({ answers: [], missed: [] });
  });
});

describe("Saying why an entry was dropped", () => {
  it("says each rule's reason in its own words", () => {
    const sentences = DROP_REASONS.map(droppedShotSentence);

    expect(new Set(sentences).size).toBe(DROP_REASONS.length);
    for (const sentence of sentences) expect(sentence).toMatch(/^[A-Z].*\.$/);
  });

  it.each([
    ["image-too-large", "An image is over 1 MB."],
    ["name-bad-character", "Its name has a character other than letters A to Z, digits, spaces and `: - _ / . ,`."],
    ["duplicate-name", "Another entry has the same name, so neither is shown under it."],
  ] as const)("says %s as the rule it broke", (reason, sentence) => {
    expect(droppedShotSentence(reason)).toBe(sentence);
  });
});

describe("What reading a manifest touches", () => {
  it("reads no file and makes no request: the files are what the caller lists, and the reading comes back at once", () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("the reader made a request");
    });
    try {
      // No file of these names is on disk: the reader takes the caller's word for each.
      const reading = readShotsManifest(SPEC_EXAMPLE, SPEC_FILES);

      expect(reading).not.toBeInstanceOf(Promise);
      expect(namedShots(reading as ShotsManifest, ["composer: draft ready"]).missed).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("imports nothing a Worker can't load, so the read library can carry it", () => {
    const here = fileURLToPath(new URL("./shotsManifest.ts", import.meta.url));

    expect(forbiddenImportsFrom(here, (path) => readFileSync(path, "utf8"))).toEqual([]);
  });
});
