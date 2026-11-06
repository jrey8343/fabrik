// Landing a Retro (#151): when a Retro run finishes, the Kit checks its
// proposals against the evidence it was given and fills in the pending Retro.
// The Kit renders every word of layout; the Retro wrote only its proposals'
// text. The Retro stays silent: no state label, no assignee, no mention.
import { RUN_STORE_REPO } from "../kit/runStore.ts";
import { fencedRunsOf, retroMarker, retroMarksIn } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import { isPendingRetro } from "./retro.ts";
import { LOOSENING_STREAK_MINIMUM, type LooseningProposal, parseRetroOutput, type ProposalDirection, type ProposalKind, type RetroProposal, type Streak } from "./retroOutput.ts";
import type { Action, IssueContext, LoopEvent, Plan, RetroEvidence } from "./types.ts";
import { failRetro } from "./weeklyFailure.ts";
import { readable } from "./weeklyGate.ts";

type RetroFinished = Extract<LoopEvent, { kind: "retro-run-finished" }>;

/**
 * The Retro's reply, checked against the evidence it was given and rendered
 * into its Retro, the issue in `context`. A result for a Retro that's no
 * longer pending lands nothing: closing a pending Retro cancels it.
 */
export function landRetro(event: RetroFinished, context: IssueContext): Plan {
  const { issue } = context;
  if (!isPendingRetro(issue)) {
    return { kind: "nothing", reason: `#${issue.number} is no longer a pending Retro, so its Retro run's result is stale` };
  }
  const parsed = parseRetroOutput(event.output);
  if (!parsed.ok) {
    // The failed Retro's one line may quote the reply, so it mentions nobody and stays one line.
    const errors = withoutMentions(parsed.errors.join("; ").replace(/\s+/g, " "));
    const how = `its reply broke the Retro output contract (${errors})`;
    return failRetro(context, { failure: "missing-output", how, runUrl: event.runUrl, resetsAt: null });
  }
  const windowEnd = retroMarksIn(issue.body).windowEnd ?? event.evidence.window.end;
  const checks = parsed.output.proposals.map((proposal) => checked(silenced(proposal), event.evidence));
  const kept = checks.flatMap(({ kept }) => (kept === null ? [] : [kept]));
  // What the Kit dropped goes in the run's step summary, never on the Retro.
  const notes = checks.flatMap(({ notes }) => notes);
  // A week with nothing left to propose still leaves a Retro on the record, which closes itself.
  const actions: Action[] =
    kept.length === 0
      ? [
          { kind: "edit-issue-body", issue: issue.number, body: cleanBody(windowEnd, event.evidence) },
          { kind: "close", issue: issue.number, reason: "completed" },
        ]
      : [{ kind: "edit-issue-body", issue: issue.number, body: filledBody(kept, windowEnd, event) }];
  return { kind: "act", actions, ...(notes.length === 0 ? {} : { notes }) };
}

/**
 * A proposal as the Retro wrote it, made safe to file: an @-mention in none
 * of its text, and no line a marker reader would take for the Kit's own, as
 * a Retro's are read anywhere in its body (src/loop/markers.ts). Its short
 * texts, set in a heading or beside a label, go on one line. Its problem and
 * change, each a block of Markdown, keep code in a closed fence as written,
 * since GitHub notifies nobody from code, so a change can be applied as
 * written; and each closes a fence it leaves open, so it can't swallow the
 * rest of the Retro or pair with a fence in the next text.
 */
function silenced(proposal: RetroProposal): RetroProposal {
  const texts = {
    title: oneLine(proposal.title),
    problem: markdown(proposal.problem),
    change: markdown(proposal.change),
    skill: proposal.skill === null ? null : oneLine(proposal.skill),
  };
  if (proposal.direction === "tighten") return { ...proposal, ...texts };
  return { ...proposal, ...texts, streak: { ...proposal.streak, kind: oneLine(proposal.streak.kind) }, undoes: oneLine(proposal.undoes) };
}

function oneLine(text: string): string {
  return withoutMentions(withoutMarkerLines(text).replace(/\s+/g, " ").trim());
}

function markdown(text: string): string {
  const { runs, open } = fencedRunsOf(withoutMarkerLines(text));
  const lines = runs.flatMap(({ code, lines }) => (code ? lines : lines.map(withoutMentions)));
  return [...lines, ...(open === null ? [] : [open])].join("\n");
}

/** The text without any line that is a Kit marker, its outer whitespace trimmed, inside code or not: marker readers don't skip code. */
function withoutMarkerLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^<!--\s*fabrik:/.test(line.trim()))
    .join("\n");
}

/** A proposal the Kit checked: kept with only the evidence it holds, or dropped; and what it dropped, and why. */
interface Checked {
  readonly kept: RetroProposal | null;
  readonly notes: readonly string[];
}

/**
 * The Kit's checks of one proposal, which take nothing on the Retro's word.
 * Each ref the evidence doesn't hold is dropped, so the Retro can't cite
 * evidence it wasn't given, and each one it holds is kept once, in the
 * Retro's order. Then a proposal resting on a pattern seen once outside an
 * escape is dropped (the one-off rule), and so is a loosening whose streak
 * doesn't hold by the Kit's own count.
 */
function checked(proposal: RetroProposal, evidence: RetroEvidence): Checked {
  const held = new Map(evidence.refs.map(({ ref, kind }) => [ref, kind]));
  const cited = [...new Set(proposal.evidence)];
  const notes = cited.filter((ref) => !held.has(ref)).map((ref) => `Dropped ${oneLine(ref)} from "${proposal.title}": the evidence doesn't hold it`);
  const kept = { ...proposal, evidence: cited.filter((ref) => held.has(ref)) };
  const kinds = kept.evidence.map((ref) => held.get(ref));
  if (!kinds.includes("escape") && kinds.filter((kind) => kind === "pull-request").length < 2) {
    return { kept: null, notes: [...notes, `Dropped the proposal "${proposal.title}": its evidence holds no escape and fewer than two distinct PRs`] };
  }
  if (kept.direction === "tighten") return { kept, notes };
  const streak = { ...kept.streak, pullRequests: [...new Set(kept.streak.pullRequests)] };
  const broken = streakBreaks(streak, evidence);
  if (broken.length > 0) return { kept: null, notes: [...notes, `Dropped the loosening "${proposal.title}": ${broken.join("; ")}`] };
  return { kept: { ...kept, streak }, notes };
}

/**
 * What breaks a loosening's streak, each PR counted once, by the Kit's own
 * count, or nothing when it holds: it holds when it counts at least
 * LOOSENING_STREAK_MINIMUM PRs, each in the streak table, and none of them
 * named in an escape, reverted or sent back with Request changes.
 */
function streakBreaks({ pullRequests: counted }: Streak, { streakTable }: RetroEvidence): string[] {
  const breaks = counted.flatMap((number) => {
    const row = streakTable.find((each) => each.number === number);
    if (row === undefined) return [`#${number} isn't in the streak table`];
    return [
      ...(row.escaped ? [`#${number} is named in an escape`] : []),
      ...(row.reverted ? [`#${number} was reverted`] : []),
      ...(row.requestChanges ? [`#${number} was sent back with Request changes`] : []),
    ];
  });
  if (counted.length < LOOSENING_STREAK_MINIMUM) breaks.push(`its streak counts ${counted.length} PRs, fewer than ${LOOSENING_STREAK_MINIMUM}`);
  return breaks;
}

const KIND_LABELS: Readonly<Record<ProposalKind, string>> = { mechanical: "Mechanical", judgement: "Judgement" };
const DIRECTION_LABELS: Readonly<Record<ProposalDirection, string>> = { tighten: "Tighten", loosen: "Loosen" };

/** A clean Retro: one line, then its retro marker. */
function cleanBody(windowEnd: string, evidence: RetroEvidence): string {
  return [`The Retro read the factory's runs ${windowOf(evidence)} and has nothing to propose.`, "", retroMarker(windowEnd)].join("\n");
}

/** A filled Retro: the window it read and what to do, a card per proposal in the Retro's order, then its retro marker. */
function filledBody(proposals: readonly RetroProposal[], windowEnd: string, event: RetroFinished): string {
  return [
    `The Retro read the factory's runs ${windowOf(event.evidence)}. File the proposals you want, comment here on any you reject so the next Retro knows, and close this Retro when you're done: as completed if you filed any, as not planned if you didn't.`,
    ...proposals.flatMap((proposal) => ["", ...card(proposal, event)]),
    "",
    retroMarker(windowEnd),
  ].join("\n");
}

/** The window the evidence covers, as the Retro's opening line says it. */
function windowOf({ window: { start, end } }: RetroEvidence): string {
  return `from ${readable(Date.parse(start))} to ${readable(Date.parse(end))}`;
}

/** One proposal's card: its title, badges, problem, evidence, change and, for a loosening, its streak and what it undoes. */
function card(proposal: RetroProposal, event: RetroFinished): string[] {
  return [
    `## ${proposal.title}`,
    "",
    `\`${KIND_LABELS[proposal.kind]}\` \`${DIRECTION_LABELS[proposal.direction]}\``,
    "",
    "**Problem**",
    "",
    proposal.problem,
    "",
    "**Evidence**",
    "",
    ...proposal.evidence.map((ref) => `- ${evidenceLink(ref, event)}`),
    "",
    "**Change**",
    "",
    proposal.change,
    ...(proposal.direction === "loosen" ? loosened(proposal, event) : []),
    // #225: the card's Open as issue link goes here, last, as an Audit card's does.
  ];
}

/** A loosening's streak, each PR linked, and the tightening it undoes. */
function loosened({ streak, undoes }: LooseningProposal, { repoUrl }: RetroFinished): string[] {
  const links = streak.pullRequests.map((number) => `[#${number}](${repoUrl}/pull/${number})`);
  return [
    "",
    `**Streak:** ${streak.pullRequests.length} merged agent PRs (${streak.kind}), none of them named in an escape, reverted or sent back with Request changes: ${links.join(", ")}`,
    "",
    `**Undoes:** ${undoes}`,
  ];
}

/**
 * A ref from the evidence as a link: a PR or an issue to itself in the
 * Product repo, and anything else, a Run record say, to its file in the
 * fabrik-runs store, with its transcript beside it when it has one.
 */
function evidenceLink(ref: string, { evidence, repoUrl }: RetroFinished): string {
  const kind = evidence.refs.find((each) => each.ref === ref)?.kind;
  const number = /^#([1-9][0-9]*)$/.exec(ref)?.[1];
  if (number !== undefined) return `[${ref}](${repoUrl}/${kind === "pull-request" ? "pull" : "issues"}/${number})`;
  const transcript = evidence.transcripts[ref];
  return `[\`${ref}\`](${storeFile(ref)})${transcript === undefined ? "" : `, with its [transcript](${storeFile(transcript)})`}`;
}

/** A file in the fabrik-runs store, on its default branch. */
function storeFile(path: string): string {
  return `https://github.com/${RUN_STORE_REPO}/blob/HEAD/${path.split("/").map(encodeURIComponent).join("/")}`;
}
