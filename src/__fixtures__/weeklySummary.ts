// The Scorers' and the Replay's builders for their tests, matching anIssue,
// aPullRequest and snapshotOf (./snapshots.ts): say only what a test cares
// about. The builders of the facts the Kit reads are the read library's
// (src/read/builders.ts).
import type { ScoreEntry, ScoreFile, ScoreSkip } from "../kit/scorer.ts";

/** The Efficiency v1 score of a run: 0.8 against its 0.7 threshold, so passing. */
export function aScoreEntry(overrides: Partial<ScoreEntry> = {}): ScoreEntry {
  return { scorer: "efficiency", version: 1, threshold: 0.7, score: 0.8, pass: true, label: "clean", rationale: "No call was wasted.", ...overrides };
}

/** The score file of aRunRecord()'s run, scored five minutes after it ended: passing Efficiency, Ticket compliance and Skill use. */
export function aScoreFile(overrides: Partial<ScoreFile> = {}): ScoreFile {
  return {
    schema: 2,
    kitSha: "f".repeat(40),
    repo: "owner/product",
    runId: 1000,
    runAttempt: 1,
    role: "implement",
    issue: 7,
    pullRequest: 50,
    replay: null,
    record: "runs/owner/product/2026-11/1000-1-implement.json",
    scoredAt: "2026-11-04T12:05:00Z",
    rubrics: ["efficiency@1", "ticket-compliance@1", "skill-use@1"],
    judge: { model: "claude-sonnet-5", record: "runs/owner/product/2026-11/1000-1-score.json" },
    digestTrimmed: false,
    skip: null,
    entries: [
      aScoreEntry(),
      aScoreEntry({ scorer: "ticket-compliance", threshold: 0.8, score: 0.9, label: "compliant", rationale: "Built what was asked." }),
      aScoreEntry({ scorer: "skill-use", score: 0.75, label: "followed", rationale: "Loaded the skills that fit." }),
    ],
    ...overrides,
  };
}

/** The score file of aRunRecord()'s run, skipped for `skip`: by the judge, for a judge failure, or else before any judge ran. */
export function aSkippedScoreFile(skip: ScoreSkip, overrides: Partial<ScoreFile> = {}): ScoreFile {
  const judged = skip.reason === "judge-failed" || skip.reason === "judge-output-invalid";
  return aScoreFile({ skip, entries: null, ...(judged ? {} : { judge: null, digestTrimmed: null }), ...overrides });
}
