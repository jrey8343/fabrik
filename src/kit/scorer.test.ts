import { describe, expect, it } from "vitest";
import { aRunRecord } from "../__fixtures__/weeklySummary.ts";
import { type Rubric, rubricSet } from "./rubrics.ts";
import type { RunRecord } from "./runRecord.ts";
import { type JudgeRun, scoreFileFor, scoringPlan } from "./scorer.ts";

/** A run id whose SHA-256 falls in the sampled quarter, and one whose doesn't. */
const SAMPLED_RUN = 1007;
const UNSAMPLED_RUN = 1000;

/** A finished first Implement run on Ticket 7 with its transcript in the store, with whatever the case changes. */
function implementRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const runId = overrides.runId ?? SAMPLED_RUN;
  return aRunRecord({ runId, transcript: `transcripts/owner/product/2026-11/${runId}-1-implement.jsonl.gz`, ...overrides });
}

describe("The scoring plan for a finished run", () => {
  it.each(["triage", "design", "review", "score"] as const)("never samples a %s run", (role) => {
    expect(scoringPlan(implementRun({ role, retry: 1, stepUp: true }))).toEqual({ kind: "not-sampled" });
  });

  describe("samples one in four first Implement runs, by run id", () => {
    it("scores a first run whose run id falls in the sample", () => {
      expect(scoringPlan(implementRun({ runId: SAMPLED_RUN }))).toEqual({ kind: "score" });
    });

    it("leaves a first run whose run id falls outside the sample", () => {
      expect(scoringPlan(implementRun({ runId: UNSAMPLED_RUN }))).toEqual({ kind: "not-sampled" });
    });

    it("makes the same choice for every attempt of one run", () => {
      for (const runId of [SAMPLED_RUN, UNSAMPLED_RUN]) {
        expect(scoringPlan(implementRun({ runId, runAttempt: 2 }))).toEqual(scoringPlan(implementRun({ runId, runAttempt: 1 })));
      }
    });

    it("picks about a quarter of run ids", () => {
      const runIds = Array.from({ length: 4000 }, (_, i) => 20_000_000_000 + i);
      const picked = runIds.filter((runId) => scoringPlan(implementRun({ runId })).kind === "score");

      expect(picked.length / runIds.length).toBeGreaterThan(0.22);
      expect(picked.length / runIds.length).toBeLessThan(0.28);
    });
  });

  it.each([
    ["a Retry", { retry: 1 }],
    ["a second Retry", { retry: 2 }],
    ["a Step-up", { retry: 2, stepUp: true }],
    ["a Step-up the Operator asked for", { stepUp: true }],
    ["a Request-changes run", { requestChanges: true }],
  ])("always scores %s, whatever its run id", (_, run) => {
    expect(scoringPlan(implementRun({ runId: UNSAMPLED_RUN, ...run }))).toEqual({ kind: "score" });
  });

  describe("records a picked run it can't score as skipped", () => {
    it("skips a run with no transcript", () => {
      expect(scoringPlan(implementRun({ retry: 1, transcript: null }))).toEqual({ kind: "skip", skip: { reason: "no-transcript" } });
    });

    it("leaves a run with no transcript that the sample didn't pick, recording nothing", () => {
      expect(scoringPlan(implementRun({ runId: UNSAMPLED_RUN, transcript: null }))).toEqual({ kind: "not-sampled" });
    });

    // Every kind the failure notice names (src/loop/failures.ts) but a timeout.
    it.each(["crash", "missing-output", "provider-error", "dead-token", "weekly-limit", "metered-billing", "unreachable-1password"] as const)(
      "skips a run whose Infrastructure failure was %s",
      (failure) => {
        const run = implementRun({ jobResult: "failure", infrastructureFailure: failure });

        expect(scoringPlan(run)).toEqual({ kind: "skip", skip: { reason: "infrastructure-failure" } });
      },
    );

    it("scores a run that timed out with its transcript, since a runaway loop is how it worked", () => {
      const run = implementRun({ jobResult: "cancelled", infrastructureFailure: "timeout", subtype: null, turns: null, totalCostUsd: null });

      expect(scoringPlan(run)).toEqual({ kind: "score" });
    });

    it("skips a run that timed out with no transcript for having none", () => {
      const run = implementRun({ jobResult: "cancelled", infrastructureFailure: "timeout", transcript: null });

      expect(scoringPlan(run)).toEqual({ kind: "skip", skip: { reason: "no-transcript" } });
    });
  });

  describe("guards the Subscription's weekly limit", () => {
    const reading = (status: string, utilization: number | null) => ({ status, rateLimitType: "seven_day", utilization, resetsAt: 1_800_500_000 });

    it("scores a run whose last weekly-limit reading was just below 0.75", () => {
      expect(scoringPlan(implementRun({ retry: 1, rateLimit: reading("allowed", 0.74) }))).toEqual({ kind: "score" });
    });

    it("skips a run whose last weekly-limit reading was at 0.75, keeping the reading", () => {
      const rateLimit = reading("allowed", 0.75);

      expect(scoringPlan(implementRun({ retry: 1, rateLimit }))).toEqual({ kind: "skip", skip: { reason: "weekly-limit", rateLimit } });
    });

    it.each(["allowed_warning", "rejected"])("skips a run whose last weekly-limit reading was %s, however low its utilization", (status) => {
      const rateLimit = reading(status, 0.1);

      expect(scoringPlan(implementRun({ retry: 1, rateLimit }))).toEqual({ kind: "skip", skip: { reason: "weekly-limit", rateLimit } });
    });

    it("scores a run whose allowed reading gave no utilization", () => {
      expect(scoringPlan(implementRun({ retry: 1, rateLimit: reading("allowed", null) }))).toEqual({ kind: "score" });
    });

    it("scores a run with no weekly-limit reading", () => {
      expect(scoringPlan(implementRun({ retry: 1, rateLimit: null }))).toEqual({ kind: "score" });
    });
  });
});

/** Three rubrics like the Kit's, with their thresholds and labels. */
const RUBRICS: readonly Rubric[] = [
  { name: "efficiency", version: 1, threshold: 0.7, labels: ["clean", "repeated-calls", "dead-end-loop"], text: "How directly the run worked." },
  { name: "ticket-compliance", version: 1, threshold: 0.8, labels: ["compliant", "scope-creep", "guessed"], text: "Whether it built the Ticket." },
  { name: "skill-use", version: 1, threshold: 0.7, labels: ["followed", "missed-skill"], text: "Whether it used its skills." },
];

const SCORED_PATH = "runs/owner/product/2026-11/1007-1-implement.json";
const JUDGE_RECORD = "runs/owner/product/2026-11/1007-1-score.json";
const SCORED_AT = "2026-11-04T12:05:00Z";

/** The judge's run: the Kit's judge model, its own record, and a digest it read whole. */
const judge: JudgeRun = { model: "claude-sonnet-5", record: JUDGE_RECORD, digestTrimmed: false };

/** The judge's structured output: one answer per rubric, with whatever the case changes. */
function judgeOutput(answers: Record<string, Partial<{ score: unknown; label: unknown; rationale: unknown }>> = {}) {
  const base: Record<string, { score: unknown; label: unknown; rationale: unknown }> = {
    efficiency: { score: 0.9, label: "clean", rationale: "Each call moved the work on." },
    "ticket-compliance": { score: 0.85, label: "compliant", rationale: "Built what the Ticket asked." },
    "skill-use": { score: 0.75, label: "followed", rationale: "Loaded tdd and followed it." },
  };
  return { answers: Object.entries(base).map(([scorer, answer]) => ({ scorer, ...answer, ...answers[scorer] })) };
}

describe("The score file", () => {
  const scored = implementRun();

  it("a judged run's file names the scored run, its record, the judge and each rubric's score", () => {
    const { file } = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: { kind: "judged", judge, output: judgeOutput() } });

    expect(file).toEqual({
      schema: 1,
      kitSha: scored.kitSha,
      repo: "owner/product",
      runId: 1007,
      runAttempt: 1,
      role: "implement",
      issue: 7,
      pullRequest: 50,
      record: SCORED_PATH,
      scoredAt: SCORED_AT,
      judge: { model: "claude-sonnet-5", record: JUDGE_RECORD },
      digestTrimmed: false,
      skip: null,
      entries: [
        { scorer: "efficiency", version: 1, threshold: 0.7, score: 0.9, pass: true, label: "clean", rationale: "Each call moved the work on." },
        { scorer: "ticket-compliance", version: 1, threshold: 0.8, score: 0.85, pass: true, label: "compliant", rationale: "Built what the Ticket asked." },
        { scorer: "skill-use", version: 1, threshold: 0.7, score: 0.75, pass: true, label: "followed", rationale: "Loaded tdd and followed it." },
      ],
    });
  });

  it("passes each rubric at or above its own threshold, and fails it below, whatever the judge thought", () => {
    const output = judgeOutput({
      efficiency: { score: 0.7, label: "repeated-calls" },
      "ticket-compliance": { score: 0.79, label: "scope-creep" },
      "skill-use": { score: 0.69, label: "missed-skill" },
    });
    const { file } = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: { kind: "judged", judge, output } });

    expect(file.entries?.map(({ scorer, pass }) => [scorer, pass])).toEqual([
      ["efficiency", true],
      ["ticket-compliance", false],
      ["skill-use", false],
    ]);
  });

  it("lists the entries in the rubrics' order, whatever order the judge answered in", () => {
    const output = { answers: [...judgeOutput().answers].reverse() };
    const { file } = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: { kind: "judged", judge, output } });

    expect(file.entries?.map((entry) => entry.scorer)).toEqual(["efficiency", "ticket-compliance", "skill-use"]);
  });

  describe("records a skip with its reason and no scores", () => {
    const rateLimit = { status: "allowed", rateLimitType: "seven_day", utilization: 0.8, resetsAt: 1_800_500_000 };

    it("a weekly-limit skip from the plan names no judge and keeps the reading", () => {
      const plan = scoringPlan(implementRun({ retry: 1, rateLimit }));
      if (plan.kind !== "skip") throw new Error(`expected a skip, not ${plan.kind}`);
      const { file } = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: plan });

      expect(file).toEqual({
        schema: 1,
        kitSha: scored.kitSha,
        repo: "owner/product",
        runId: 1007,
        runAttempt: 1,
        role: "implement",
        issue: 7,
        pullRequest: 50,
        record: SCORED_PATH,
        scoredAt: SCORED_AT,
        judge: null,
        digestTrimmed: null,
        skip: { reason: "weekly-limit", rateLimit },
        entries: null,
      });
    });

    it.each([
      ["no-transcript", { transcript: null }],
      ["infrastructure-failure", { jobResult: "failure", infrastructureFailure: "provider-error" }],
    ] as const)("a skip from the plan for %s names no judge", (reason, run) => {
      const plan = scoringPlan(implementRun({ retry: 1, ...run }));
      if (plan.kind !== "skip") throw new Error(`expected a skip, not ${plan.kind}`);
      const { file } = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: plan });

      expect(file).toMatchObject({ judge: null, digestTrimmed: null, skip: { reason }, entries: null });
    });

    it.each(["judge-failed", "judge-output-invalid"] as const)("a skip for %s names the judge that ran and whether its digest was trimmed", (kind) => {
      const trimmedJudge = { ...judge, digestTrimmed: true };
      const { file } = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: { kind, judge: trimmedJudge } });

      expect(file).toMatchObject({
        record: SCORED_PATH,
        judge: { model: "claude-sonnet-5", record: JUDGE_RECORD },
        digestTrimmed: true,
        skip: { reason: kind },
        entries: null,
      });
    });

    it("a skip goes where the scores would have", () => {
      const judged = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: { kind: "judged", judge, output: judgeOutput() } });
      const failed = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: { kind: "judge-failed", judge } });

      expect(failed.path).toBe(judged.path);
    });
  });

  describe("refuses the judge's output as a whole when any answer is invalid", () => {
    const { answers } = judgeOutput();

    it.each([
      ["a score above 1", judgeOutput({ efficiency: { score: 1.2 } })],
      ["a score below 0", judgeOutput({ "skill-use": { score: -0.1 } })],
      ["a label outside the rubric's list", judgeOutput({ efficiency: { label: "sandbox-fight" } })],
      ["another rubric's label", judgeOutput({ efficiency: { label: "compliant" } })],
      ["no answer for one rubric", { answers: answers.slice(1) }],
      ["two answers for one rubric", { answers: [...answers, answers[0]] }],
      ["an answer for a rubric it wasn't given", { answers: [...answers, { scorer: "verbosity", score: 1, label: "terse", rationale: "Short." }] }],
      ["a score that isn't a number", judgeOutput({ efficiency: { score: "0.9" } })],
      ["a rationale that isn't text", judgeOutput({ efficiency: { rationale: null } })],
      ["no answers", {}],
      ["no object at all", "0.9"],
    ])("%s gives a judge-output-invalid skip file", (_, output) => {
      const { file } = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: { kind: "judged", judge, output } });

      expect(file).toMatchObject({
        judge: { model: "claude-sonnet-5", record: JUDGE_RECORD },
        digestTrimmed: false,
        skip: { reason: "judge-output-invalid" },
        entries: null,
      });
    });
  });

  describe("goes beside the scored run's record, named by the rubric set", () => {
    const judged = { kind: "judged", judge, output: judgeOutput() } as const;

    it("in the month the scored run ended, with its run id, attempt and role", () => {
      const lateRun = implementRun({ runAttempt: 2, endedAt: "2026-11-30T23:50:00Z" });
      const { path } = scoreFileFor({ scored: lateRun, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: "2026-12-01T00:10:00Z", outcome: judged });

      expect(path).toBe(`scores/owner/product/2026-11/1007-2-implement-${rubricSet(RUBRICS).hash}.json`);
    });

    it("the same for the same rubrics, so a re-run of scoring finds the file it wrote", () => {
      const first = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: judged });
      const again = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: "2026-11-04T12:30:00Z", outcome: judged });

      expect(again.path).toBe(first.path);
    });

    it("another for a changed rubric version, so re-scoring under new rubrics keeps the old file", () => {
      const bumped = RUBRICS.map((rubric) => (rubric.name === "skill-use" ? { ...rubric, version: 2 } : rubric));
      const before = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: judged });
      const after = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: bumped, scoredAt: SCORED_AT, outcome: judged });

      expect(after.path).not.toBe(before.path);
      expect(after.path).toMatch(/^scores\/owner\/product\/2026-11\/1007-1-implement-[0-9a-f]+\.json$/);
    });
  });
});
