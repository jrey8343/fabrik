// Evidence shots in the UI evidence module (#819, #820): the shots marker, the
// second shape of the evidence marker, which carries a pull request's names
// between runs; the names rule; the shots section the Operator reads on the
// pull request; the Kit's own words for an Evidence miss and a failure of the
// collection; and the Reviewer's block of named shots. Route capture's parts,
// and the section's and marker's shared lines, are in src/evidence/uiEvidence.ts.
// Pure, no I/O.
import { isRoute, NAMED_SHOT_CAP, REVIEWER_IMAGE_CAP, UI_VIEWPORTS } from "../kit/config.ts";
import { withoutMentions } from "../loop/mentions.ts";
import { FULL_SHA } from "../skills/lock.ts";
import type { ShotsCollected } from "./shotsCollect.ts";
import { type EvidenceShot, isShotName, SHOT_LIMIT, SHOT_NAME_RULE, type ShotMiss, shotMissOf, type ShotSize, SHOTS_MANIFEST_FILE } from "./shotsManifest.ts";
import {
  code,
  EVIDENCE_MARKER,
  isId,
  isObject,
  isOneOf,
  link,
  type MarkerPreview,
  markerLine,
  markerPreview,
  markerPreviewOf,
  type PreviewLink,
  previewLine,
  REVIEWER_IMAGES_DIR,
  SECTION_START,
  UI_PR,
} from "./uiEvidence.ts";

/** One image of a named Evidence shot a Reviewer gets (#820): the shot, its size, and its file in the artifact and in REVIEWER_IMAGES_DIR. */
export interface ReviewerShotImage {
  readonly name: string;
  readonly size: ShotSize;
  readonly file: string;
}

/**
 * The images of Evidence shots a Reviewer gets (#820): the named shots the
 * run produced, mobile before desktop, each size in the Implementer's order,
 * at most REVIEWER_IMAGE_CAP. Four names at two sizes are eight, so the cap
 * never trims below the named shots' own. Unnamed shots are the Evidence page's alone.
 */
export function reviewerShotImages({ named }: Pick<ShotsCollected, "named">): ReviewerShotImage[] {
  return UI_VIEWPORTS.flatMap(({ name: size }) =>
    named.flatMap(({ name, images }) => {
      const file = images[size];
      return file === undefined ? [] : [{ name, size, file }];
    }),
  ).slice(0, REVIEWER_IMAGE_CAP);
}

/** What a Reviewer is given of a pull request's Evidence shots (#820), for its prompt's block. */
export interface ReviewerShots {
  /** What the Review's jobs collected at the head. */
  readonly collected: ShotsCollected;
  /** The images copied into REVIEWER_IMAGES_DIR, in reviewerShotImages' order. */
  readonly given: readonly ReviewerShotImage[];
}

/**
 * The UI evidence block of a Reviewer whose pull request's evidence is
 * Evidence shots (#820): the images it was given, each by shot and size,
 * with its Journey and path, and what to judge in them; that the shots are
 * from a run that failed, when the named check is red; each miss and
 * failure, in the Kit's own sentence; and the Implementer's sentence that
 * nothing visible changes, to check against the diff. With no pictures it
 * reviews the code as usual.
 */
export function reviewerShotsBlock({ collected, given }: ReviewerShots): string[] {
  const { check, artifact, head, failure, red, missed, nothingVisible, named } = collected;
  const opening = `${UI_PR}, and its UI evidence is the Evidence shots the Implementer named, which the Journeys of the Required check ${code(check)} took at \`${head.slice(0, 7)}\`.`;
  const redLine = red ? [`The ${code(check)} check is still red on this head after the Kit's re-run, so these shots are from a run that failed.`] : [];
  const failed = failure === null ? [] : [shotsFailureSentence(failure, { check, artifact })];
  const misses = missed.length === 0 ? [] : ["The Kit found these misses among the named shots:", missed.map((miss) => `- ${shotMissSentence(miss, check)}`).join("\n")];
  const sentence =
    nothingVisible === undefined
      ? []
      : [
          "The Implementer named no Evidence shot and says nothing a person sees changes, in its own words:",
          `> ${quotedSentence(nothingVisible)}`,
          "Check it against the diff: a diff that plainly changes what a person sees is an `execution-flaw`, whatever the sentence says.",
        ];
  const nothingNamed =
    failure === null && named.length === 0 && missed.length === 0 && nothingVisible === undefined
      ? ["The Implementer named no Evidence shot and didn't say that nothing visible changes, so there are no pictures: review the code as usual."]
      : [];
  const told = ["## UI evidence", [opening, ...redLine, ...failed].join(" "), ...misses, ...sentence, ...nothingNamed];
  if (given.length === 0) return nothingNamed.length > 0 ? told : [...told, "There are no pictures, so review the code as usual."];
  const where = given.length === 1 ? "It's" : `These ${given.length} are`;
  return [
    ...told,
    `Each shows one screen high, where its Journey was at the moment it names. ${where} in \`${REVIEWER_IMAGES_DIR}/\` in your working directory: open each with your Read tool to see it.`,
    given.map((image) => reviewerShotLine(image, named)).join("\n"),
    "Judge them as part of the PR:",
    [
      "- Do they show what the Ticket asked for?",
      "- Is there plain breakage: a blank or error page, content spilling over at mobile width, or overlapping or cut-off content?",
    ].join("\n"),
    "Taste is the Operator's: don't fail the PR over a design choice the Ticket didn't settle. A visual failure is an `execution-flaw` like any other: name the shot and its size in the finding, so the Implementer knows what to fix.",
  ];
}

/** One image of a shot the Reviewer is given: its file, then its shot, size, Journey and path. */
function reviewerShotLine({ name, size, file }: ReviewerShotImage, named: ShotsCollected["named"]): string {
  const viewport = UI_VIEWPORTS.find((each) => each.name === size);
  const width = viewport === undefined ? "" : ` (${viewport.width}×${viewport.height})`;
  const shot = named.find((each) => each.name === name);
  const journey = shot?.journey === undefined ? "" : `, from the Journey ${code(shot.journey)}`;
  const path = shot?.path === undefined ? "" : `, at ${code(shot.path)}`;
  return `- \`${REVIEWER_IMAGES_DIR}/${file}\`: the shot ${code(name)} at ${size} width${width}${journey}${path}`;
}

/**
 * A name a pull request's shots marker holds: the Implementer's, with the
 * Journey and path the artifact's entry gave once it has been read (#820).
 */
export type NamedShot = Omit<EvidenceShot, "images">;

/** How many names the run that gave a pull request its names dropped: past the first four, and for breaking the name rule. */
export interface DroppedNames {
  readonly pastFour: number;
  readonly broken: number;
}

/** The failures of a whole collection of Evidence shots: the Product's wiring, the Operator's to fix, which never send back. */
export const SHOTS_FAILURES = ["no-artifact", "bad-manifest"] as const;

export type ShotsFailure = (typeof SHOTS_FAILURES)[number];

/**
 * What a pull request shows of its change by Evidence shots (#819): the
 * names, in the Implementer's order, or its sentence that nothing a person
 * sees changes, and what its run dropped of the names it gave.
 */
export interface ShotsNames {
  /** The names: none when it has the sentence, or neither. */
  readonly named: readonly NamedShot[];
  readonly nothingVisible?: string;
  /** Absent when the run that gave the names dropped none. */
  readonly dropped?: DroppedNames;
}

/**
 * The marker of a pull request whose UI evidence comes from Evidence shots:
 * the second shape of the evidence marker, told apart by its `source`. A
 * marker without one is a route marker (EvidenceMarker). It carries the
 * pull request's names between runs, and is read only from a body the
 * Fabrik App wrote (src/github/snapshot.ts).
 */
export interface ShotsMarker extends ShotsNames {
  readonly source: "shots";
  /** The head the named check ran at, whose shots the section shows; null while it waits. */
  readonly head: string | null;
  /** The Review run that holds the Evidence page; null while it waits. */
  readonly run: number | null;
  readonly artifact: number | null;
  readonly failure: ShotsFailure | null;
  /** Always empty, for a reader from a release before Evidence shots, which reads it as capturing no route. */
  readonly routes: readonly [];
  /** That the pull request has neither names nor the sentence: an Evidence miss (GLOSSARY.md). */
  readonly miss?: "nothing-named";
  /** Each named shot the check's run didn't produce, and each size a produced one lacks. */
  readonly missed: readonly ShotMiss[];
  readonly preview?: MarkerPreview;
  /** The Actions run whose Implement push job wrote the names, whose preview step links the preview (withPreviewLink). */
  readonly implementRun?: number;
  /**
   * The head the Implementer run that wrote the names pushed (#820): an
   * Evidence miss is sent back only at it, never at a head the Operator
   * pushed or the Kit's plain rebase made. Absent when that run pushed none.
   */
  readonly pushed?: string;
  /** That the named check was still red after the Kit's re-run, so the shots are from a run that failed (#820). */
  readonly red?: true;
  /** How many of the run's manifest entries were past the first 100, which the Kit doesn't read (#820); absent for none. */
  readonly pastLimit?: number;
}

/**
 * The names rule (#819): what a pull request shows of its change once an
 * Implementer run has given `given`, its marker holding `held` before it.
 * The latest run that says anything wins. Names it gives, held to the name
 * rule and once each, replace the pull request's, the first four counting;
 * its sentence, given without a name that counts, clears them and is kept;
 * and a run that gives neither keeps what the pull request had, without the
 * paths an earlier head's artifact gave. Names it gave that were dropped are
 * counted either way.
 */
export function shotsNamesOf(
  given: { readonly shots?: readonly string[]; readonly nothingVisible?: string },
  held: ShotsMarker | null,
): ShotsNames {
  if (given.shots !== undefined) {
    const kept = given.shots.filter(isShotName);
    const valid = kept.filter((name, at) => kept.indexOf(name) === at);
    const counted = valid.slice(0, NAMED_SHOT_CAP);
    const pastFour = valid.length - counted.length;
    const broken = given.shots.length - kept.length;
    const dropped = pastFour + broken === 0 ? {} : { dropped: { pastFour, broken } };
    if (counted.length > 0) return { named: counted.map((name) => ({ name })), ...dropped };
    // Every name it gave was dropped, so it named nothing that counts.
    const { dropped: _, ...rest } = shotsNamesOf({ ...(given.nothingVisible === undefined ? {} : { nothingVisible: given.nothingVisible }) }, held);
    return { ...rest, ...dropped };
  }
  if (given.nothingVisible !== undefined) return { named: [], nothingVisible: given.nothingVisible };
  if (held === null) return { named: [] };
  return {
    named: held.named.map(({ name }) => ({ name })),
    ...(held.nothingVisible === undefined ? {} : { nothingVisible: held.nothingVisible }),
    ...(held.dropped === undefined ? {} : { dropped: held.dropped }),
  };
}

/** Whether a pull request with these names shows nothing of its change: no name and no sentence, an Evidence miss's `nothing-named`. */
export function namesNothing({ named, nothingVisible }: ShotsNames): boolean {
  return named.length === 0 && nothingVisible === undefined;
}

/**
 * The shots marker an Implement run's push job writes: the pull request's
 * names, waiting for the named check, with no head, Review run or artifact
 * yet, `miss` when it names nothing, and the head its run `pushed`, if any.
 */
export function waitingShotsMarker(names: ShotsNames, implementRun: number | null, preview: PreviewLink, pushed: string | null = null): ShotsMarker {
  return {
    source: "shots",
    head: null,
    run: null,
    artifact: null,
    failure: null,
    routes: [],
    named: names.named,
    ...(names.nothingVisible === undefined ? {} : { nothingVisible: names.nothingVisible }),
    ...(names.dropped === undefined ? {} : { dropped: names.dropped }),
    ...(namesNothing(names) ? { miss: "nothing-named" as const } : {}),
    missed: [],
    preview: markerPreview(preview),
    ...(implementRun === null ? {} : { implementRun }),
    ...(pushed === null ? {} : { pushed }),
  };
}

/** What the Review's jobs read of a head's Evidence shots (src/evidence/shotsCollect.ts), in the Review run `run`, whose Evidence page is its artifact `artifact`. */
export interface ShotsRead {
  readonly collected: ShotsCollected;
  readonly run: number;
  /** The Evidence page's artifact, unzipped, or null when the run kept none. */
  readonly artifact: number | null;
}

/**
 * The shots marker once the Review's jobs have read the named check's
 * artifact (#820): `held`, the pull request's, with the head the check ran
 * at, the Review run and its Evidence page, each named shot with the Journey
 * and path its entry gave, what was missed, why nothing could be read, that
 * the check was red, and how many shots were past the first 100. The names
 * stay the pull request's own.
 */
export function readShotsMarker(held: ShotsMarker, { collected, run, artifact }: ShotsRead): ShotsMarker {
  const names = held.named.map(({ name }) => name);
  return {
    ...held,
    head: collected.head,
    run,
    artifact,
    failure: collected.failure,
    named: names.map((name) => {
      const shot = collected.named.find((each) => each.name === name);
      return { name, ...(shot?.journey === undefined ? {} : { journey: shot.journey }), ...(shot?.path === undefined ? {} : { path: shot.path }) };
    }),
    missed: collected.missed.filter(({ name }) => names.includes(name)),
    ...(collected.red ? { red: true as const } : {}),
    ...(collected.pastLimit === 0 ? {} : { pastLimit: collected.pastLimit }),
  };
}

/**
 * The shots marker once the pull request has moved on to a head the Kit
 * pushed without reading its shots (#813), as its plain rebase does: back to
 * waiting for the named check, with no head, Review run or artifact, and
 * nothing missed, red or past the first 100, while the names, their sentence
 * and what was dropped of them, the preview, and the head the naming run
 * pushed all stay. The Journey and path an earlier head's artifact gave are
 * dropped with it, as a run that names nothing drops them (shotsNamesOf).
 */
export function waitingAgainShotsMarker(held: ShotsMarker): ShotsMarker {
  const { red: _red, pastLimit: _pastLimit, ...kept } = held;
  return { ...kept, head: null, run: null, artifact: null, failure: null, named: held.named.map(({ name }) => ({ name })), missed: [] };
}

/**
 * The names of the named shots the check's run produced at the marker's head
 * (#822), in the pull request's order: its names less each the run didn't
 * produce, had two entries of, or refused. A shot that lacks one size was
 * still produced. Names are compared exactly. None while the marker waits
 * for the named check, and none when nothing of the run could be read.
 */
export function producedNamedShots(marker: ShotsMarker): readonly string[] {
  if (marker.head === null || marker.failure !== null) return [];
  const notProduced = new Set(marker.missed.flatMap((miss) => (miss.why === "size-missing" ? [] : [miss.name])));
  return marker.named.flatMap(({ name }) => (notProduced.has(name) ? [] : [name]));
}

/**
 * What came of a pull request's Evidence miss: the Kit sent it back with its
 * own Execution flaw, or it goes on to Review with the miss shown, because no
 * Retry is left or because no Implementer run pushed the head it is at, as
 * when a body-only Touch-up or a body-only Retry pushed nothing, or the
 * Operator pushed it.
 */
export type MissOutcome = "sent-back" | "no-retry-left" | "not-pushed";

/** What came of a named shot the check's run didn't produce (#820): as for any miss, or nothing sent back because the named check is still red. */
export type ShotMissOutcome = MissOutcome | "check-red";

/**
 * What came of an Evidence miss at a head: sent back when the plan `sentBack`
 * it; else nothing sent back because the named check is `red`; else gone on to
 * Review because no Retry is left, at a head an Implementer run `pushed`, or
 * because no Implementer run pushed it.
 */
export function missOutcomeOf({ pushed, sentBack, red = false }: { readonly pushed: boolean; readonly sentBack: boolean; readonly red?: boolean }): ShotMissOutcome {
  if (sentBack) return "sent-back";
  if (red) return "check-red";
  return pushed ? "no-retry-left" : "not-pushed";
}

/** What the shots section needs: the named check and artifact, the marker it ends with, what came of its miss, and the Evidence page. */
export interface ShotsSectionOf {
  readonly check: string;
  /** The artifact's name, as Kit config names it. */
  readonly artifact: string;
  readonly marker: ShotsMarker;
  /** What came of the marker's `miss`, or of a named shot it records as missed; read only when it has one. */
  readonly missOutcome: ShotMissOutcome;
  /** The Evidence page's web address, once the Review's jobs have kept one. */
  readonly evidencePage?: string | null;
}

/**
 * The evidence section of a pull request whose UI evidence comes from
 * Evidence shots, between the start line and its marker: an Evidence miss,
 * when it has one, and what came of it; that it waits for the named check,
 * or, once the Review's jobs have read it (#820), why it couldn't be read,
 * that the check is red, the head the shots are from and the Evidence page;
 * the names, each with its Journey and path, or why it was missed; or the
 * Implementer's sentence in its own words; the names its run dropped, and the
 * shots past the first 100; and the preview link. The sentence is agent
 * text, so it shows quoted on one line, mentions nobody and hides nothing.
 */
export function shotsSection({ check, artifact, marker, missOutcome, evidencePage = null }: ShotsSectionOf): string {
  const { named, nothingVisible, dropped, miss, missed, head } = marker;
  const sendsBack = missed.some(({ why }) => why !== "size-missing");
  // Once read, the head the shots are from by its sha, never "this head": the Kit writes nothing when the Operator pushes at the Merge gate.
  const at = head === null ? "this head" : `\`${head.slice(0, 7)}\``;
  return [
    SECTION_START,
    "## UI evidence",
    ...(miss === "nothing-named" ? ["", nothingNamedLine(missOutcome, at)] : []),
    ...(sendsBack ? ["", namedMissLine(check, missOutcome, at)] : []),
    ...(marker.failure === null ? [] : ["", `**No Evidence shots:** ${lowerFirst(shotsFailureSentence(marker.failure, { check, artifact, ...(head === null ? {} : { head }) }))}`]),
    ...(marker.red === true ? ["", `**The ${code(check)} check is red:** it is still red after the Kit's re-run, so these Evidence shots are from a run that failed.`] : []),
    "",
    head === null
      ? `Waiting for the ${code(check)} check: the Evidence shots it takes at this head show here once it has finished and the Review has read them.`
      : readLine(check, head, evidencePage),
    ...(named.length === 0 ? [] : ["", "Named shots:", "", ...named.map((shot) => namedShotLine(shot, missed, check))]),
    ...(nothingVisible === undefined ? [] : ["", "The Implementer says nothing a person sees changes:", "", `> ${quotedSentence(nothingVisible)}`]),
    ...droppedLines(dropped).flatMap((line) => ["", line]),
    ...(marker.pastLimit === undefined ? [] : ["", `The run's manifest lists ${marker.pastLimit} ${marker.pastLimit === 1 ? "shot" : "shots"} past the first ${SHOT_LIMIT}, which the Kit doesn't read.`]),
    "",
    previewLine(previewLinkOf(marker.preview)),
    markerLine(marker),
  ].join("\n");
}

/** The section's line naming the head the shots are from, and the Evidence page when the Review kept one. */
function readLine(check: string, head: string, evidencePage: string | null): string {
  const at = `\`${head.slice(0, 7)}\``;
  if (evidencePage === null) return `The Review read the ${code(check)} check's run at ${at}.`;
  return `Evidence shots the ${code(check)} check took at ${at}: ${link("Open the Evidence page", evidencePage)}, which holds every shot of its run, the named ones first.`;
}

/** A named shot's line: its name, with its Journey and path once read, or why the run didn't produce it, and any size it lacks. */
function namedShotLine({ name, journey, path }: NamedShot, missed: readonly ShotMiss[], check: string): string {
  const notProduced = missed.find((miss) => miss.name === name && miss.why !== "size-missing");
  if (notProduced !== undefined) return `- ${shotMissSentence(notProduced, check)}`;
  const shown = `- ${code(name)}${journey === undefined ? "" : `, from the Journey ${code(journey)}`}${path === undefined ? "" : `, at ${code(path)}`}`;
  const lacks = missed.filter((miss) => miss.name === name).map((miss) => ` It ${missWords(miss, check)}.`);
  return lacks.length === 0 ? shown : `${shown}.${lacks.join("")}`;
}

/** The section's line for a named shot the check's run didn't produce at the head `at`, as the section words it: what came of it. */
function namedMissLine(check: string, outcome: ShotMissOutcome, at: string): string {
  return `**Evidence miss:** a named shot isn't among the Evidence shots the ${code(check)} check took at ${at}${missOutcomeWords(outcome, at, "with the miss shown")}`;
}

/** The section's line for a pull request that names nothing, sent back or going on to Review, and why, at the head `at`, as the section words it. */
function nothingNamedLine(outcome: ShotMissOutcome, at: string): string {
  // A red check never decides a pull request that names nothing, which is judged as its Implement run's push lands.
  const named = outcome === "check-red" ? "not-pushed" : outcome;
  return `**Evidence miss:** the Implementer named no Evidence shot and didn't say that nothing visible changes${missOutcomeWords(named, at, "showing nothing of the change")}`;
}

/** What came of an Evidence miss at the head `at`, as the end of its line in the section, going on to Review `shown` as it is. */
function missOutcomeWords(outcome: ShotMissOutcome, at: string, shown: string): string {
  switch (outcome) {
    case "sent-back":
      return ", so the Kit sent it back with an Execution flaw, which uses a Retry.";
    case "no-retry-left":
      return `. No Retry is left, so it goes on to Review ${shown}.`;
    case "not-pushed":
      return `. No Implementer run pushed ${at}, so it isn't sent back: it goes on to Review ${shown}.`;
    case "check-red":
      return ". The check is still red after the Kit's re-run, so nothing is sent back for evidence: the Reviewer's judgment of the check decides.";
  }
}

/**
 * Why a named shot has no shot in the check's run, or lacks a size, as a
 * clause after the shot: the one place each reason is worded, which the
 * section, the Reviewer's block and an Evidence miss's Execution flaw share.
 */
function missWords(miss: ShotMiss, check: string): string {
  switch (miss.why) {
    case "not-produced":
      return `wasn't produced: the ${code(check)} check's run took no shot of that name`;
    case "ambiguous-name":
      return "is ambiguous: two or more of the run's shots have that name, so none is shown under it";
    case "refused":
      return "was refused: its entry in the run's manifest broke the artifact's rules, so the Kit dropped it";
    case "size-missing":
      return `has no ${miss.viewport} image, so it shows at ${miss.viewport === "mobile" ? "desktop" : "mobile"} alone`;
  }
}

/**
 * A named shot the check's run missed, or a size it lacks, as one sentence a
 * reader shows as it is (#820): the shot's name, which the name rule holds to
 * safe characters, then the Kit's own words for why.
 */
export function shotMissSentence(miss: ShotMiss, check: string): string {
  return `${code(miss.name)} ${missWords(miss, check)}.`;
}

/**
 * Why nothing of a head's Evidence shots could be read, as sentences a reader
 * shows as they are (#820): the Kit's own words, naming the check and the
 * artifact Kit config names, the `head` the check ran at when given, else
 * "this head", and that it is the Operator's wiring to fix.
 */
export function shotsFailureSentence(
  failure: ShotsFailure,
  { check, artifact, head }: { readonly check: string; readonly artifact: string; readonly head?: string },
): string {
  const wiring = "That is the Product repo's wiring, the Operator's to fix, so nothing is sent back.";
  switch (failure) {
    case "no-artifact":
      return `The ${code(check)} check's run at ${head === undefined ? "this head" : `\`${head.slice(0, 7)}\``} uploaded no artifact named ${code(artifact)}, which its workflow must upload whether its Journeys pass or fail. ${wiring}`;
    case "bad-manifest":
      return `The ${code(artifact)} artifact's \`${SHOTS_MANIFEST_FILE}\` couldn't be read: it is missing, isn't JSON, has another \`version\` or has no \`shots\` list. ${wiring}`;
  }
}

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/** The lines saying what the run dropped of the names it gave: none when it dropped none. */
function droppedLines(dropped: DroppedNames | undefined): string[] {
  if (dropped === undefined) return [];
  const names = (count: number) => `${count} ${count === 1 ? "name" : "names"}`;
  const were = (count: number) => (count === 1 ? "was" : "were");
  return [
    ...(dropped.pastFour === 0 ? [] : [`${names(dropped.pastFour)} past the first four ${were(dropped.pastFour)} dropped: at most four count.`]),
    ...(dropped.broken === 0 ? [] : [`${names(dropped.broken)} ${were(dropped.broken)} dropped for breaking the name rule: ${SHOT_NAME_RULE}.`]),
  ];
}

/** Agent text shown on one line, mentioning nobody, with each `<` escaped so no HTML or comment in it hides anything. */
function quotedSentence(text: string): string {
  return withoutMentions(text.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim()).replaceAll("<", "&lt;");
}

/** A marker's preview as the section's preview line says it: none when the marker records none. */
function previewLinkOf(preview: MarkerPreview | undefined): PreviewLink {
  if (preview === undefined) return { kind: "none" };
  return preview.is === "linked" || preview.is === "never-answered" ? { kind: preview.is, url: preview.url } : { kind: preview.is };
}

/**
 * The shots marker in this body (ShotsMarker), or null when it has none. Read
 * only from a body the Fabrik App wrote (src/github/snapshot.ts). The last
 * counts, and a field that doesn't read is left out or read as none.
 */
export function shotsMarkerIn(body: string): ShotsMarker | null {
  const markers = body.split("\n").flatMap((line) => {
    const marker = shotsMarkerOf(EVIDENCE_MARKER.exec(line.trim())?.[1]);
    return marker === null ? [] : [marker];
  });
  return markers.at(-1) ?? null;
}

function shotsMarkerOf(json: string | undefined): ShotsMarker | null {
  if (json === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isObject(value) || value.source !== "shots") return null;
  const { head, run, artifact, failure, named, nothingVisible, dropped, miss, missed, preview, implementRun, pushed, red, pastLimit } = value;
  return {
    source: "shots",
    head: typeof head === "string" && FULL_SHA.test(head) ? head : null,
    run: isId(run) ? run : null,
    artifact: isId(artifact) ? artifact : null,
    failure: isOneOf(SHOTS_FAILURES, failure) ? failure : null,
    routes: [],
    // A name that breaks the rule, as an edit of the body might leave it, is dropped: names reach the Reviewer's prompt.
    named: Array.isArray(named) ? named.flatMap((shot) => (isObject(shot) && isShotName(shot.name) ? [namedShotOf(shot.name, shot.journey, shot.path)] : [])) : [],
    ...(typeof nothingVisible === "string" && nothingVisible.trim() !== "" ? { nothingVisible } : {}),
    ...(isObject(dropped) && isCount(dropped.pastFour) && isCount(dropped.broken) ? { dropped: { pastFour: dropped.pastFour, broken: dropped.broken } } : {}),
    ...(miss === "nothing-named" ? { miss } : {}),
    missed: Array.isArray(missed) ? missed.flatMap((each) => shotMissOf(each)) : [],
    ...(markerPreviewOf(preview) ?? {}),
    ...(isId(implementRun) ? { implementRun } : {}),
    ...(typeof pushed === "string" && FULL_SHA.test(pushed) ? { pushed } : {}),
    ...(red === true ? { red } : {}),
    ...(isCount(pastLimit) && pastLimit > 0 ? { pastLimit } : {}),
  };
}

/** A named shot as its marker reads, with its Journey and path when each keeps the rule the artifact's entry was held to. */
function namedShotOf(name: string, journey: unknown, path: unknown): NamedShot {
  return { name, ...(isShotName(journey) ? { journey } : {}), ...(isRoute(path) ? { path } : {}) };
}

/** A count: a whole number, zero or more. */
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
