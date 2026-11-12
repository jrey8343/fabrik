import { describe, expect, it } from "vitest";
import { aRunRecord } from "../read/builders.ts";
import { type Rubric, rubricSet } from "./rubrics.ts";
import type { ReplayArm, RunRecord } from "./runRecord.ts";
import { judgedRunOf, type JudgeRun, readJudgedRun, scoreFileFor, scoringPlan, scoringRubrics } from "./scorer.ts";

/** A run id whose SHA-256 falls in the sampled quarter, and one whose doesn't. */
const SAMPLED_RUN = 1007;
const UNSAMPLED_RUN = 1000;

/** A finished first Implement run on Ticket 7 with its transcript in the store, with whatever the case changes. */
function implementRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const runId = overrides.runId ?? SAMPLED_RUN;
  return aRunRecord({ runId, transcript: `transcripts/owner/product/2026-11/${runId}-1-implement.jsonl.gz`, ...overrides });
}

describe("The scoring plan for a finished run", () => {
  it.each(["triage", "design", "review", "audit", "research", "retro", "score"] as const)("never samples a %s run", (role) => {
    expect(scoringPlan(implementRun({ role, retry: 1, stepUp: true }))).toEqual({ kind: "not-sampled" });
  });

  it("never samples a prototype turn, a Design-session turn like any other", () => {
    expect(scoringPlan(implementRun({ role: "design", prototype: true }))).toEqual({ kind: "not-sampled" });
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

  describe("always picks a Replay arm's Implement run, never sampling it, so every arm has a process measure", () => {
    /** A Replay arm's Implement run on Ticket 7, for replay issue 300, whose run id falls outside the sample. */
    const armRun = (overrides: Partial<RunRecord> = {}) =>
      implementRun({ runId: UNSAMPLED_RUN, replay: { issue: 300, arm: "variant", ticket: 7, candidateSha: null }, ...overrides });

    it("scores a replay Implement run whose run id falls outside the sample", () => {
      expect(scoringPlan(armRun())).toEqual({ kind: "score" });
    });

    it("never picks a replay arm's Review, which no Scorer scores", () => {
      expect(scoringPlan(armRun({ role: "review" }))).toEqual({ kind: "not-sampled" });
    });

    it("still skips a replay run with no transcript", () => {
      expect(scoringPlan(armRun({ transcript: null }))).toEqual({ kind: "skip", skip: { reason: "no-transcript" } });
    });

    it.each(["provider-error", "weekly-limit"] as const)("still skips a replay run whose Infrastructure failure was %s", (failure) => {
      const run = armRun({ jobResult: "failure", infrastructureFailure: failure });

      expect(scoringPlan(run)).toEqual({ kind: "skip", skip: { reason: "infrastructure-failure" } });
    });

    it("still skips a replay run whose last weekly-limit reading was at 0.75, keeping the reading", () => {
      const rateLimit = { status: "allowed", rateLimitType: "seven_day", utilization: 0.75, resetsAt: 1_800_500_000 };

      expect(scoringPlan(armRun({ rateLimit }))).toEqual({ kind: "skip", skip: { reason: "weekly-limit", rateLimit } });
    });
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

    // #434: what the agent did, not the infrastructure, so it shows how the Implementer worked.
    it.each(["missing-output", "left-branch", "unlandable-branch"] as const)("scores an Implement run that was a Broken run by %s", (brokenRun) => {
      const run = implementRun({ jobResult: "failure", infrastructureFailure: null, brokenRun });

      expect(scoringPlan(run)).toEqual({ kind: "score" });
    });

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

describe("The scored run as the judge is told of it (#450)", () => {
  it.each([
    ["a first run", {}, { kind: "first", retry: 0, timedOut: false }],
    ["a Stepped-up start, a first run", { stepUp: true, stepUpReason: "marked" }, { kind: "first", retry: 0, timedOut: false }],
    ["a Retry, with its number", { retry: 2, stepUp: true, stepUpReason: "retry" }, { kind: "retry", retry: 2, timedOut: false }],
    ["a Request-changes run", { requestChanges: true, stepUp: true, stepUpReason: "request-changes" }, { kind: "request-changes", retry: 0, timedOut: false }],
    ["a conflict-only run, never a Retry", { retry: 1, stepUp: true, stepUpReason: "conflict-only" }, { kind: "conflict-only", retry: 1, timedOut: false }],
    ["a run its timeout stopped", { retry: 1, infrastructureFailure: "timeout" }, { kind: "retry", retry: 1, timedOut: true }],
    ["a Kept-branch start, which carried on a branch (#536)", { keptBranch: true }, { kind: "kept-branch", retry: 0, timedOut: false }],
    ["a Kept-branch start's Retry after an empty diff", { keptBranch: true, retry: 1 }, { kind: "kept-branch", retry: 1, timedOut: false }],
  ] as const)("names %s", (_, run, judged) => {
    expect(judgedRunOf(implementRun(run))).toEqual(judged);
  });

  it("reads back as the scoring job passed it, and as a first run when none was passed, as for a Replay arm", () => {
    const retry = judgedRunOf(implementRun({ retry: 1, infrastructureFailure: "timeout" }));
    expect(readJudgedRun(JSON.stringify(retry))).toEqual(retry);
    expect(readJudgedRun("")).toEqual({ kind: "first", retry: 0, timedOut: false });
  });

  it.each(['{"kind":"review","retry":0,"timedOut":false}', '{"kind":"retry","retry":-1,"timedOut":false}', '{"kind":"first","retry":0}', "[]"])(
    "refuses %s",
    (text) => {
      expect(() => readJudgedRun(text)).toThrow("Not a judged run");
    },
  );
});

describe("The rubrics a run is scored under", () => {
  /** The pinned release that ran and recorded the run, and a candidate Kit sha a `kit` variant laid its prompts and Base skills from. */
  const PINNED = "a".repeat(40);
  const CANDIDATE = "c".repeat(40);
  /** The candidate's rubrics, one of them bumped, as a Kit checkout at the candidate sha would hold them. */
  const CANDIDATE_RUBRICS = RUBRICS.map((rubric) => (rubric.name === "efficiency" ? { ...rubric, version: 2, text: "How few calls the run made." } : rubric));
  const kitVariantRun = implementRun({ kitSha: PINNED, replay: { issue: 300, arm: "variant", ticket: 7, candidateSha: CANDIDATE } });

  it("are the pinned release's for a kit variant's run", () => {
    expect(scoringRubrics(kitVariantRun, { sha: PINNED, rubrics: RUBRICS })).toEqual(RUBRICS);
  });

  it("are never a kit variant's candidate sha's", () => {
    expect(() => scoringRubrics(kitVariantRun, { sha: CANDIDATE, rubrics: CANDIDATE_RUBRICS })).toThrow(
      `Run 1007-1 is scored under the rubrics of its pinned release ${PINNED}, never those of its candidate Kit sha ${CANDIDATE}`,
    );
  });

  it("are the Kit's at the commit that ran a live run, and never another commit's", () => {
    const live = implementRun({ kitSha: PINNED });

    expect(scoringRubrics(live, { sha: PINNED, rubrics: RUBRICS })).toEqual(RUBRICS);
    expect(() => scoringRubrics(live, { sha: "d".repeat(40), rubrics: RUBRICS })).toThrow(
      `Run 1007-1 is scored under the rubrics of its pinned release ${PINNED}, not those read at ${"d".repeat(40)}`,
    );
  });
});

const SCORED_PATH = "runs/owner/product/2026-11/1007-1-implement.json";
const JUDGE_RECORD = "runs/owner/product/2026-11/1007-1-score.json";
const SCORED_AT = "2026-11-04T12:05:00Z";

/** The judge's run: the Kit's judge model, its own record, and a transcript it read whole. */
const judge: JudgeRun = { model: "claude-sonnet-5", record: JUDGE_RECORD, transcriptTrimmed: false };

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

  it("a judged run's file names the scored run, its record, the rubric set, the judge and each rubric's score", () => {
    const { file } = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: { kind: "judged", judge, output: judgeOutput() } });

    expect(file).toEqual({
      schema: 2,
      kitSha: scored.kitSha,
      repo: "owner/product",
      runId: 1007,
      runAttempt: 1,
      role: "implement",
      issue: 7,
      pullRequest: 50,
      replay: null,
      record: SCORED_PATH,
      scoredAt: SCORED_AT,
      rubrics: ["efficiency@1", "ticket-compliance@1", "skill-use@1"],
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

    it("a weekly-limit skip from the plan names the rubric set but no judge, and keeps the reading", () => {
      const plan = scoringPlan(implementRun({ retry: 1, rateLimit }));
      if (plan.kind !== "skip") throw new Error(`expected a skip, not ${plan.kind}`);
      const { file } = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: plan });

      expect(file).toEqual({
        schema: 2,
        kitSha: scored.kitSha,
        repo: "owner/product",
        runId: 1007,
        runAttempt: 1,
        role: "implement",
        issue: 7,
        pullRequest: 50,
        replay: null,
        record: SCORED_PATH,
        scoredAt: SCORED_AT,
        rubrics: ["efficiency@1", "ticket-compliance@1", "skill-use@1"],
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

    it.each(["judge-failed", "judge-output-invalid"] as const)("a skip for %s names the judge that ran and whether its transcript was trimmed", (kind) => {
      const trimmedJudge = { ...judge, transcriptTrimmed: true };
      const { file } = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: { kind, judge: trimmedJudge } });

      expect(file).toMatchObject({
        record: SCORED_PATH,
        judge: { model: "claude-sonnet-5", record: JUDGE_RECORD },
        digestTrimmed: true,
        skip: { reason: kind },
        entries: null,
      });
    });

    it("a judge that failed before it built its prompt leaves whether its transcript was trimmed unknown", () => {
      const early = { ...judge, transcriptTrimmed: null };
      const { file } = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: { kind: "judge-failed", judge: early } });

      expect(file).toMatchObject({ judge: { model: "claude-sonnet-5", record: JUDGE_RECORD }, digestTrimmed: null, skip: { reason: "judge-failed" } });
    });

    it.each([
      ["a skip from the plan", { kind: "skip", skip: { reason: "no-transcript" } }],
      ["a judge that failed", { kind: "judge-failed", judge }],
      ["a judge whose output wasn't valid", { kind: "judged", judge, output: {} }],
    ] as const)("%s still names each rubric's name and version", (_, outcome) => {
      const bumped = RUBRICS.map((rubric) => (rubric.name === "ticket-compliance" ? { ...rubric, version: 3 } : rubric));
      const { file } = scoreFileFor({ scored, scoredPath: SCORED_PATH, rubrics: bumped, scoredAt: SCORED_AT, outcome });

      expect(file.rubrics).toEqual(["efficiency@1", "ticket-compliance@3", "skill-use@1"]);
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

    describe("for a Replay arm's run, with the arm after the role, so the two arms of one workflow run each get their own", () => {
      const armRun = (arm: ReplayArm) => implementRun({ replay: { issue: 300, arm, ticket: 7, candidateSha: null } });
      const scoreOf = (arm: ReplayArm) =>
        scoreFileFor({ scored: armRun(arm), scoredPath: `runs/owner/product/2026-11/1007-1-implement-replay-${arm}.json`, rubrics: RUBRICS, scoredAt: SCORED_AT, outcome: judged });

      it("at its arm's path", () => {
        const { hash } = rubricSet(RUBRICS);

        expect(scoreOf("baseline").path).toBe(`scores/owner/product/2026-11/1007-1-implement-replay-baseline-${hash}.json`);
        expect(scoreOf("variant").path).toBe(`scores/owner/product/2026-11/1007-1-implement-replay-variant-${hash}.json`);
      });

      it("naming the scored run's Replay, as it names the run's subject", () => {
        expect(scoreOf("variant").file).toMatchObject({
          runId: 1007,
          role: "implement",
          issue: 7,
          replay: { issue: 300, arm: "variant", ticket: 7, candidateSha: null },
          record: "runs/owner/product/2026-11/1007-1-implement-replay-variant.json",
        });
      });
    });
  });
});
