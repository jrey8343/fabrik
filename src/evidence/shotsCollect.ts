// What the Review's jobs collect of a head's Evidence shots (#820): a reading
// of the named check's artifact, by the manifest's reader, against the pull
// request's names, and whether a miss in it sends the pull request back
// before the Reviewer starts. The review job writes it as a step output, which
// the Reviewer's runner and the push job read back by the same rules. Pure,
// no I/O: the review job's own step reads the artifact (src/review/shots-main.ts).
import { isRoute } from "../kit/config.ts";
import { isShotName, namedShots, type ShotMiss, type ShotSize, type ShotsManifestRead } from "./shotsManifest.ts";
import { SHOTS_FAILURES, type ShotsFailure } from "./uiEvidence.ts";

/**
 * What a Review of a UI pull request on a Product repo that uses Evidence
 * shots is started with, from the Kit job's plan (src/loop/review.ts): the
 * check and artifact Kit config names, the pull request's names from its
 * marker, its sentence that nothing visible changes, and the head an Evidence
 * miss would be sent back at. The names and the sentence are agent text.
 */
export interface ReviewShots {
  readonly check: string;
  readonly artifact: string;
  /** The pull request's names, in the Implementer's order. */
  readonly names: readonly string[];
  readonly nothingVisible?: string;
  /**
   * The head an Evidence miss found there sends the pull request back at: its
   * head as the plan read it, when an Implementer run pushed it and the
   * Ticket has a Retry left; null when nothing would be sent back.
   */
  readonly sendsBackAt: string | null;
}

/** A named shot the run produced, as the Review's jobs collected it: its images are files of the downloaded artifact. */
export interface CollectedShot {
  readonly name: string;
  readonly journey?: string;
  readonly path?: string;
  readonly images: Readonly<Partial<Record<ShotSize, string>>>;
}

/** What the Review's jobs collected of a head's Evidence shots, for the Reviewer and the push job. */
export interface ShotsCollected {
  /** The named check, as Kit config names it. */
  readonly check: string;
  /** The artifact's name, as Kit config names it. */
  readonly artifact: string;
  /** The head the check ran at: the one the Review's waits read. */
  readonly head: string;
  /** Why nothing of the run could be read: the Product's wiring, which never sends back. */
  readonly failure: ShotsFailure | null;
  /** Whether the named check was still red after the Kit's re-run, so the shots are from a run that failed. */
  readonly red: boolean;
  /** Each named shot the run produced, in the names' order. */
  readonly named: readonly CollectedShot[];
  /** Each named shot the run didn't produce, and each size a produced one lacks. */
  readonly missed: readonly ShotMiss[];
  /** The name of every shot the run produced, in its manifest's order: what an Evidence miss's comment lists. */
  readonly produced: readonly string[];
  /** How many of the manifest's entries were past the first 100, which aren't read. */
  readonly pastLimit: number;
  readonly nothingVisible?: string;
  /** Whether a miss that sends back was found, so the Reviewer doesn't run and the push job gives the Kit's Execution flaw. */
  readonly sendsBack: boolean;
}

/** Why a named shot that wasn't produced sends the pull request back; `size-missing` never does. */
const SENDS_BACK: readonly ShotMiss["why"][] = ["not-produced", "ambiguous-name", "refused"];

/**
 * What the Review's jobs collect: the reading of the artifact the named
 * check's newest attempt at `head` uploaded, or null when it uploaded none,
 * against the names the Review was `given`. A miss sends back only when the
 * check isn't `red`, the reading is whole, and `head` is the one the plan
 * would send it back at (ReviewShots.sendsBackAt).
 */
export function collectShots({ reading, given, head, red }: { readonly reading: ShotsManifestRead | null; readonly given: ReviewShots; readonly head: string; readonly red: boolean }): ShotsCollected {
  const base = {
    check: given.check,
    artifact: given.artifact,
    head,
    red,
    ...(given.nothingVisible === undefined ? {} : { nothingVisible: given.nothingVisible }),
  };
  if (reading === null || !reading.ok) {
    return { ...base, failure: reading === null ? "no-artifact" : reading.failure, named: [], missed: [], produced: [], pastLimit: 0, sendsBack: false };
  }
  const { answers, missed } = namedShots(reading, given.names);
  const named = answers.flatMap((answer): CollectedShot[] => (answer.produced ? [answer.shot] : []));
  return {
    ...base,
    failure: null,
    named,
    missed,
    produced: reading.shots.map(({ name }) => name),
    pastLimit: reading.pastLimit,
    sendsBack: !red && given.sendsBackAt === head && missed.some(({ why }) => SENDS_BACK.includes(why)),
  };
}

/**
 * What the Review's jobs collected, read back from the review job's step
 * output, or null when it doesn't read. The output passes through a job, so
 * it is held to the artifact's rules again: a name, Journey, path or image
 * that breaks them is left out rather than passed on.
 */
export function shotsCollectedOf(text: string | undefined): ShotsCollected | null {
  if (text === undefined || text === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const { check, artifact, head, failure, red, named, missed, produced, pastLimit, nothingVisible, sendsBack } = value;
  if (!isText(check) || !isText(artifact) || typeof head !== "string" || !FULL_SHA.test(head)) return null;
  return {
    check,
    artifact,
    head,
    failure: SHOTS_FAILURES.find((each) => each === failure) ?? null,
    red: red === true,
    named: listOf(named).flatMap(collectedShotOf),
    missed: listOf(missed).flatMap(shotMissOf),
    produced: listOf(produced).filter(isShotName),
    pastLimit: Number.isSafeInteger(pastLimit) && (pastLimit as number) > 0 ? (pastLimit as number) : 0,
    ...(typeof nothingVisible === "string" && nothingVisible.trim() !== "" ? { nothingVisible } : {}),
    sendsBack: sendsBack === true,
  };
}

/**
 * What a Review was started with, from the Kit job's `ui-shots` output, as
 * the review job's steps take it in FABRIK_UI_SHOTS. Only Kit code wrote it,
 * so anything that doesn't read throws rather than reviews without it.
 */
export function reviewShotsFrom(text: string): ReviewShots {
  const refused = (why: string) => new Error(`FABRIK_UI_SHOTS ${why}`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw refused("isn't JSON");
  }
  if (!isObject(value)) throw refused("isn't a JSON object");
  const { check, artifact, names, nothingVisible, sendsBackAt } = value;
  if (!isText(check) || !isText(artifact)) throw refused("names no check and artifact");
  if (!Array.isArray(names) || !names.every(isShotName)) throw refused("holds a name that breaks the name rule");
  if (!(sendsBackAt === null || (typeof sendsBackAt === "string" && FULL_SHA.test(sendsBackAt)))) throw refused("sends back at no head");
  return { check, artifact, names, ...(typeof nothingVisible === "string" ? { nothingVisible } : {}), sendsBackAt };
}

/** A full commit sha. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** An image's file name as the artifact's rules allow it: flat, ending .png. */
const IMAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/;

const SIZES: readonly ShotSize[] = ["mobile", "desktop"];

function collectedShotOf(value: unknown): CollectedShot[] {
  if (!isObject(value) || !isShotName(value.name)) return [];
  const images = isObject(value.images) ? value.images : {};
  const kept = Object.fromEntries(
    SIZES.flatMap((size) => {
      const file = images[size];
      return typeof file === "string" && IMAGE_FILE.test(file) && !file.includes("..") ? [[size, file]] : [];
    }),
  ) as Partial<Record<ShotSize, string>>;
  if (Object.keys(kept).length === 0) return [];
  return [
    {
      name: value.name,
      ...(isShotName(value.journey) ? { journey: value.journey } : {}),
      ...(isRoute(value.path) ? { path: value.path } : {}),
      images: kept,
    },
  ];
}

function shotMissOf(value: unknown): ShotMiss[] {
  if (!isObject(value) || !isShotName(value.name)) return [];
  const { name, why, viewport } = value;
  if (why === "size-missing") return viewport === "mobile" || viewport === "desktop" ? [{ name, viewport, why }] : [];
  return why === "not-produced" || why === "ambiguous-name" || why === "refused" ? [{ name, why }] : [];
}

/** A check's or artifact's name, as Kit config holds it: text on one line. */
function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !/[\r\n]/.test(value);
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
