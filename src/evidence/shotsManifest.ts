// The Evidence shots manifest (#817): the pure reader of the manifest a
// Product repo's Required check uploads beside its Evidence shots, the
// artifact's rules, and the question a caller asks of a reading. It touches no
// network and no disk: the caller hands in the manifest's text and the files
// beside it.
import { isRoute, VIEWPORT_NAMES, type Viewport } from "../kit/config.ts";

// The artifact's default name, which Kit config's ui.shots.artifact can change.
// Kit config defines it, since this module reads config.ts and not the other way.
export { DEFAULT_SHOTS_ARTIFACT } from "../kit/config.ts";

/** The manifest's file name at the artifact's root: the one file the Kit reads besides the images it lists. */
export const SHOTS_MANIFEST_FILE = "manifest.json";

/** One of the Kit's two sizes an Evidence shot is taken at. */
export type ShotSize = Viewport["name"];

/** A file that sits beside the manifest in the artifact, as the caller found it. */
export interface ArtifactFile {
  readonly name: string;
  /** Its size in bytes. */
  readonly size: number;
  /** How it starts: at least its first 8 bytes, so the reader can tell a PNG. */
  readonly start: Uint8Array;
}

/** An Evidence shot that passed the artifact's rules. */
export interface EvidenceShot {
  readonly name: string;
  readonly journey?: string;
  readonly path?: string;
  /** Its images by size, each a file beside the manifest: at least one. */
  readonly images: Readonly<Partial<Record<ShotSize, string>>>;
}

/** Why an entry of the manifest was dropped: each of the artifact's rules has its own. */
export const DROP_REASONS = [
  "not-an-entry",
  "name-not-text",
  "name-not-one-line",
  "name-too-long",
  "name-bad-character",
  "journey-not-text",
  "journey-not-one-line",
  "journey-too-long",
  "journey-bad-character",
  "path-not-a-route",
  "no-images",
  "image-name-not-flat",
  "image-name-not-png",
  "images-not-found",
  "image-not-a-png",
  "image-too-large",
  "duplicate-name",
] as const;

export type DropReason = (typeof DROP_REASONS)[number];

/** An entry of the manifest that broke one of the artifact's rules. */
export interface DroppedShot {
  /** Where it sits in the manifest's shots list, from 0. */
  readonly at: number;
  /**
   * Its name as written, when it gave one as text, so a caller can tell a name
   * it asked for was `refused`. It is held to no rule: it may be any length,
   * span lines, or hold any character, so a caller shows a name it asked for,
   * never this.
   */
  readonly name: string | null;
  readonly reason: DropReason;
}

/** A manifest that was read. */
export interface ShotsManifest {
  readonly ok: true;
  /** The shots that passed every rule, in the manifest's order. */
  readonly shots: readonly EvidenceShot[];
  /** Each entry that broke a rule, in the manifest's order. */
  readonly dropped: readonly DroppedShot[];
  /** Each name two or more entries share, where it first appears: no shot is returned under it. */
  readonly ambiguous: readonly string[];
  /** How many entries were past the first SHOT_LIMIT, which are not read at all. */
  readonly pastLimit: number;
}

/** The most shots a manifest's reading keeps: the first this many entries. */
export const SHOT_LIMIT = 100;

/** The most bytes an image may have: 1 MB. */
export const SHOT_IMAGE_MAX_BYTES = 1_048_576;

/** SHOT_IMAGE_MAX_BYTES as a sentence says it. */
const IMAGE_MAX_SIZE = `${SHOT_IMAGE_MAX_BYTES / 1_048_576} MB`;

/** How every PNG file starts. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A flat file name: letters, digits, `.`, `_` and `-`, starting with a letter or digit, so no folder and no hidden file. */
export const FLAT_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The most characters a shot's name, or its Journey, may have. */
export const SHOT_NAME_MAX_LENGTH = 80;

/** The characters a shot's name, or its Journey, may hold: letters A to Z, digits, spaces and `: - _ / . ,`. */
const NAME_CHARACTERS = /^[A-Za-z0-9 :\-_/.,]*$/;

/** Why a name, or a Journey, breaks the name rule, or null when it keeps it. */
function nameRuleBroken(value: unknown): "not-text" | "not-one-line" | "too-long" | "bad-character" | null {
  if (typeof value !== "string" || value === "") return "not-text";
  if (/[\r\n]/.test(value)) return "not-one-line";
  if (value.length > SHOT_NAME_MAX_LENGTH) return "too-long";
  if (!NAME_CHARACTERS.test(value)) return "bad-character";
  return null;
}

/**
 * Whether a value keeps the name rule a shot's name is held to: text of at
 * most 80 characters on one line, of letters A to Z, digits, spaces and
 * `: - _ / . ,` only. The names the Implementer gives are held to it too (#819).
 */
export function isShotName(value: unknown): value is string {
  return nameRuleBroken(value) === null;
}

/** The name rule, as a clause the Kit says it in. */
export const SHOT_NAME_RULE = `a name is at most ${SHOT_NAME_MAX_LENGTH} characters on one line, of letters A to Z, digits, spaces and \`: - _ / . ,\``;

/** Each rule's reason in words, as the Kit says it of an entry it dropped. */
const DROP_SENTENCES: Readonly<Record<DropReason, string>> = {
  "not-an-entry": "It is not an object.",
  "name-not-text": "It has no name: a name must be text, and not empty.",
  "name-not-one-line": "Its name spans more than one line.",
  "name-too-long": `Its name is over ${SHOT_NAME_MAX_LENGTH} characters.`,
  "name-bad-character": "Its name has a character other than letters A to Z, digits, spaces and `: - _ / . ,`.",
  "journey-not-text": "Its journey is given but is not text, or is empty.",
  "journey-not-one-line": "Its journey spans more than one line.",
  "journey-too-long": `Its journey is over ${SHOT_NAME_MAX_LENGTH} characters.`,
  "journey-bad-character": "Its journey has a character other than letters A to Z, digits, spaces and `: - _ / . ,`.",
  "path-not-a-route": "Its path is not a path starting with one /.",
  "no-images": "It lists no image: images must give a mobile or a desktop file, or both.",
  "image-name-not-flat": "An image's file name is not a plain file name: it has a folder, a `..`, or a character other than letters, digits, `.`, `_` and `-`.",
  "image-name-not-png": "An image's file name doesn't end .png.",
  "images-not-found": "None of its images is in the artifact.",
  "image-not-a-png": "An image doesn't start as a PNG file does.",
  "image-too-large": `An image is over ${IMAGE_MAX_SIZE}.`,
  "duplicate-name": "Another entry has the same name, so neither is shown under it.",
};

/** Why an entry was dropped, as a sentence a caller can show. */
export function droppedShotSentence(reason: DropReason): string {
  return DROP_SENTENCES[reason];
}

/** A manifest that can't be read at all: a failure of the Product's wiring, never of one shot. */
export interface BadManifest {
  readonly ok: false;
  readonly failure: "bad-manifest";
  /** Why, as a sentence a caller can show. */
  readonly why: string;
}

export type ShotsManifestRead = ShotsManifest | BadManifest;

/** The manifest's version this reader reads. */
export const SHOTS_MANIFEST_VERSION = 1;

/**
 * Reads a manifest's text against the files beside it, by the artifact's
 * rules. `manifest` is null when the artifact has no `manifest.json`.
 */
export function readShotsManifest(manifest: string | null, files: readonly ArtifactFile[]): ShotsManifestRead {
  if (manifest === null) return badManifest("the artifact has no manifest.json");
  let value: unknown;
  try {
    value = JSON.parse(manifest);
  } catch (error) {
    return badManifest(`manifest.json is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(value)) return badManifest("manifest.json must be a JSON object");
  if (value.version !== SHOTS_MANIFEST_VERSION) return badManifest(`manifest.json's version must be ${SHOTS_MANIFEST_VERSION}`);
  if (!Array.isArray(value.shots)) return badManifest("manifest.json must have a shots list");
  const entries: unknown[] = value.shots.slice(0, SHOT_LIMIT);
  const names = entries.map(nameOf);
  const ambiguous = names.filter((name, at): name is string => name !== null && names.indexOf(name) === at && names.lastIndexOf(name) !== at);
  const beside = new Map(files.map((file) => [file.name, file]));
  const shots: EvidenceShot[] = [];
  const dropped: DroppedShot[] = [];
  entries.forEach((entry, at) => {
    const name = names[at] ?? null;
    const read = readEntry(entry, beside);
    if (typeof read === "string") dropped.push({ at, name, reason: read });
    else if (name !== null && ambiguous.includes(name)) dropped.push({ at, name, reason: "duplicate-name" });
    else shots.push(read);
  });
  return { ok: true, shots, dropped, ambiguous, pastLimit: value.shots.length - entries.length };
}

/** An entry's name as written, when it gave one as text. */
function nameOf(entry: unknown): string | null {
  return isObject(entry) && typeof entry.name === "string" ? entry.name : null;
}

/** One entry of the shots list as a shot, or the reason of the first rule it broke. */
function readEntry(entry: unknown, beside: ReadonlyMap<string, ArtifactFile>): EvidenceShot | DropReason {
  if (!isObject(entry)) return "not-an-entry";
  const { name, journey, path, images } = entry;
  const nameBroken = nameRuleBroken(name);
  if (nameBroken !== null) return `name-${nameBroken}`;
  const journeyBroken = journey === undefined ? null : nameRuleBroken(journey);
  if (journeyBroken !== null) return `journey-${journeyBroken}`;
  if (path !== undefined && !isRoute(path)) return "path-not-a-route";
  if (!isObject(images)) return "no-images";
  const listed = VIEWPORT_NAMES.filter((size) => images[size] !== undefined);
  if (listed.length === 0) return "no-images";
  for (const size of listed) {
    const file = images[size];
    if (typeof file !== "string" || !FLAT_FILE_NAME.test(file) || file.includes("..")) return "image-name-not-flat";
    if (!file.endsWith(".png")) return "image-name-not-png";
  }
  const found: Partial<Record<ShotSize, string>> = {};
  for (const size of listed) {
    const fileName = images[size] as string;
    const file = beside.get(fileName);
    if (file === undefined) continue;
    if (!startsAsPng(file.start)) return "image-not-a-png";
    if (file.size > SHOT_IMAGE_MAX_BYTES) return "image-too-large";
    found[size] = fileName;
  }
  if (Object.keys(found).length === 0) return "images-not-found";
  return {
    name: name as string,
    ...(typeof journey === "string" ? { journey } : {}),
    ...(typeof path === "string" ? { path } : {}),
    images: found,
  };
}

/** Why a name a pull request gave has no shot in a reading: each an Evidence miss that sends back, as `size-missing` never is. */
export const SHOT_NOT_PRODUCED = ["not-produced", "ambiguous-name", "refused"] as const;

export type ShotNotProduced = (typeof SHOT_NOT_PRODUCED)[number];

/** What a reading says of one name a pull request gave. */
export type NamedShotAnswer =
  | { readonly name: string; readonly produced: true; readonly shot: EvidenceShot; readonly sizes: readonly ShotSize[] }
  | { readonly name: string; readonly produced: false; readonly why: ShotNotProduced };

/** A named shot missed, or a size a produced one lacks, as the shots marker records it. */
export type ShotMiss =
  | { readonly name: string; readonly why: ShotNotProduced }
  | { readonly name: string; readonly viewport: ShotSize; readonly why: "size-missing" };

/** What a reading says of a pull request's names. */
export interface NamedShots {
  /** One answer for each name, in the order given. */
  readonly answers: readonly NamedShotAnswer[];
  /** Each name missed, and each size a produced shot lacks, in the names' order, mobile before desktop. */
  readonly missed: readonly ShotMiss[];
}

/**
 * Answers, for each of a pull request's names, whether the reading produced
 * it and at which sizes, or why not. Names are compared exactly: no trimming,
 * no folding of case. A name past SHOT_LIMIT is not read, so it is not-produced.
 */
export function namedShots(reading: ShotsManifest, names: readonly string[]): NamedShots {
  const answers = names.map((name): NamedShotAnswer => {
    if (reading.ambiguous.includes(name)) return { name, produced: false, why: "ambiguous-name" };
    const shot = reading.shots.find((candidate) => candidate.name === name);
    if (shot !== undefined) return { name, produced: true, shot, sizes: VIEWPORT_NAMES.filter((size) => shot.images[size] !== undefined) };
    if (reading.dropped.some((entry) => entry.name === name)) return { name, produced: false, why: "refused" };
    return { name, produced: false, why: "not-produced" };
  });
  const missed = answers.flatMap((answer): ShotMiss[] =>
    answer.produced
      ? VIEWPORT_NAMES.filter((size) => !answer.sizes.includes(size)).map((viewport) => ({ name: answer.name, viewport, why: "size-missing" }))
      : [{ name: answer.name, why: answer.why }],
  );
  return { answers, missed };
}

/**
 * A missed shot as a shots marker or a review job's step output holds it,
 * when it reads, as a list of none or one: its name held to the name rule,
 * its reason one of the Kit's, and a missing size one of the two.
 */
export function shotMissOf(value: unknown): ShotMiss[] {
  if (!isObject(value) || !isShotName(value.name)) return [];
  const { name, why, viewport } = value;
  if (why === "size-missing") return VIEWPORT_NAMES.some((size) => size === viewport) ? [{ name, viewport: viewport as ShotSize, why }] : [];
  const notProduced = SHOT_NOT_PRODUCED.find((reason) => reason === why);
  return notProduced === undefined ? [] : [{ name, why: notProduced }];
}

function startsAsPng(start: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, at) => start[at] === byte);
}

function badManifest(why: string): BadManifest {
  return { ok: false, failure: "bad-manifest", why };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
