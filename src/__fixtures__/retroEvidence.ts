// Small builders for the Retro evidence bundle's tests, beside the Weekly
// summary's record and GitHub-facts builders (./weeklySummary.ts) that the
// bundle's tests build its facts with: say only what a test cares about.
import type { CommentFacts, RetroEvidenceInput, RetroIssueFacts } from "../kit/retroEvidence.ts";
import { type RunRecord, runStoreName } from "../kit/runRecord.ts";
import { followUpsSection } from "../loop/followUps.ts";
import { verdictActions } from "../loop/review.ts";
import type { Verdict } from "../loop/types.ts";
import type { FollowUp } from "../loop/verdict.ts";
import { aPullRequest, aRetroIssue, retroBody } from "./snapshots.ts";
import { aComment, aRunRecord, factsOf } from "./weeklySummary.ts";

/**
 * What a Retro reads of `owner/product` as it fills Retro 120, whose window
 * runs from the last Retro's end, Saturday 2026-10-31 00:00 UTC, to its own a
 * week later: nothing more, unless a test says so.
 */
export function aRetroEvidenceInput(overrides: Partial<RetroEvidenceInput> = {}): RetroEvidenceInput {
  return {
    records: [],
    scoreFiles: {},
    readTranscript: () => null,
    facts: factsOf(),
    operator: "operator",
    retro: 120,
    windowEnd: "2026-11-07T00:00:00Z",
    retros: [aPastRetro({ body: retroBody("2026-10-31T00:00:00.000Z") }), theRetroBeingFilled("2026-11-07T00:00:00.000Z")],
    fromRetroIssues: [],
    tickets: [],
    ...overrides,
  };
}

/** A `fabrik:retro` issue the Fabrik App opened, as aRetroIssue() makes it: by default Retro 80, filled and closed, with no comments. */
export function aPastRetro(overrides: Partial<RetroIssueFacts> = {}): RetroIssueFacts {
  return { ...aRetroIssue(overrides), comments: overrides.comments ?? [] };
}

/** Retro 120, still pending on the run the evidence is for, its window ending at `windowEnd`. */
export function theRetroBeingFilled(windowEnd: string): RetroIssueFacts {
  return aPastRetro({ number: 120, title: "Retro: week of 2026-11-02", open: true, stateReason: null, createdAt: windowEnd, body: retroBody(windowEnd, "pending") });
}

/**
 * The Fabrik App's Verdict comment on PR `pullRequest` at `at`, as the Loop
 * posts it (src/loop/review.ts), listing these Follow-ups after its findings
 * whatever the Verdict; a person's quote of one with `{ author, byBot: false }`.
 */
export function aVerdictWithFollowUps(
  verdict: Verdict,
  followUps: readonly FollowUp[],
  at: string,
  pullRequest: number,
  overrides: Partial<CommentFacts> = {},
): CommentFacts {
  const actions = verdictActions(
    { headSha: "a".repeat(40), runUrl: "https://github.com/owner/product/actions/runs/1000/attempts/1" },
    aPullRequest({ number: pullRequest }),
    { verdict, source: "reviewer", findings: "### Checked\n\nThe cart totals its lines.", followUps: followUpsSection(followUps, "https://github.com/owner/product", pullRequest) },
  );
  const comment = actions.find((action) => action.kind === "comment");
  if (comment === undefined) throw new Error("A Verdict always posts its comment");
  return aComment(comment.body, at, overrides);
}

/** aRunRecord(overrides), its transcript in the store at the path its run's name gives. */
export function aRecordWithTranscript(overrides: Partial<RunRecord> = {}): RunRecord {
  const record = aRunRecord(overrides);
  return { ...record, transcript: `transcripts/${runStoreName(record)}.jsonl.gz` };
}

/** A reader of the store's transcripts of these runs, each by the path its record gives; null for any other path. */
export function transcriptsOf(...runs: readonly (readonly [RunRecord, readonly string[]])[]): (path: string) => readonly string[] | null {
  const transcripts = new Map(
    runs.map(([record, lines]) => {
      if (record.transcript === null) throw new Error("This run's record names no transcript");
      return [record.transcript, lines];
    }),
  );
  return (path) => transcripts.get(path) ?? null;
}

/** A run's transcript, as stream-json lines: its init, then a Read of each file, answered with its contents, then its result. */
export function aTranscript(reads: Readonly<Record<string, string>> = { "src/cart.ts": "export const cart = [];" }): string[] {
  const line = (message: unknown) => JSON.stringify(message);
  return [
    line({ type: "system", subtype: "init", model: "claude-opus-5-5", skills: ["tdd"] }),
    ...Object.entries(reads).flatMap(([path, contents], i) => [
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: path } }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: contents }] } }),
    ]),
    line({ type: "result", subtype: "success", is_error: false, num_turns: 3, duration_ms: 90_000, permission_denials: [] }),
  ];
}
