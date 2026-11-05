import { describe, expect, it } from "vitest";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import type { Needs } from "./pushJob.ts";
import { agentRunEnded, type JudgeRunEnd, judgeRunRecordFor, type RunEnd, runRecordFor } from "./runRecord.ts";

const KIT_SHA = "f".repeat(40);
const BASE_SHA = "b".repeat(40);
const HEAD_SHA = "a".repeat(40);
const roles = kitConfig().roles;

const line = (message: unknown) => JSON.stringify(message);
const init = line({ type: "system", subtype: "init", apiKeySource: "none" });

/** A `result` message as the CLI writes it, with whatever the case changes. */
function result(fields: Record<string, unknown> = {}): string {
  return line({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    duration_ms: 90_000,
    duration_api_ms: 60_000,
    num_turns: 12,
    permission_denials: [],
    total_cost_usd: 1.25,
    modelUsage: {
      "claude-opus-5-5": {
        inputTokens: 100,
        outputTokens: 200,
        cacheCreationInputTokens: 300,
        cacheReadInputTokens: 400,
        costUSD: 1.25,
        costBasis: "list",
      },
    },
    ...fields,
  });
}

/** An agent job that ended `result`, with the outputs it passed out. */
const job = (result: string, outputs: Record<string, string> = {}) => ({
  result,
  outputs: { "secrets-step": "success", "base-sha": BASE_SHA, model: "claude-opus-5-5", effort: "", ...outputs },
});

/** The push job's `needs`: the Kit job routed to `route`, with its outputs, and the other jobs as given. */
function needs(route: string, jobs: Needs = {}, kitOutputs: Record<string, string> = {}): Needs {
  return {
    kit: {
      result: "success",
      outputs: {
        sha: KIT_SHA,
        route,
        ticket: "",
        "pull-request": "",
        review: "",
        model: "claude-opus-5-5",
        effort: "",
        retry: "",
        "step-up": "false",
        "request-changes": "false",
        ...kitOutputs,
      },
    },
    ...jobs,
  };
}

/** The agent result artifact's text. */
const agentResult = (role: string, issue: number, output = "{}") => JSON.stringify({ role, issue, output });

/** What the push job knows when a passing Triage run on #12 ends, with whatever the case changes. */
function runEnd(overrides: Partial<RunEnd> = {}): RunEnd {
  return {
    needs: needs("triage", { triage: job("success") }),
    eventIssue: 12,
    repo: "acme/widgets",
    runId: 9001,
    runAttempt: 1,
    kitSha: KIT_SHA,
    endedAt: "2026-11-05T10:00:00Z",
    roles,
    agentResult: agentResult("triage", 12),
    failureReport: null,
    transcript: [init, result()],
    ...overrides,
  };
}

describe("The Run record a run's end yields", () => {
  it("a passing Triage run gets a record with its identity, what ran, its outcome, effort spent and cost", () => {
    expect(runRecordFor(runEnd())?.record).toEqual({
      schema: 1,
      kitSha: KIT_SHA,
      repo: "acme/widgets",
      runId: 9001,
      runAttempt: 1,
      role: "triage",
      issue: 12,
      pullRequest: null,
      endedAt: "2026-11-05T10:00:00Z",
      model: "claude-opus-5-5",
      effort: null,
      retry: 0,
      stepUp: false,
      requestChanges: false,
      baseSha: BASE_SHA,
      jobResult: "success",
      subtype: "success",
      isError: false,
      terminalReason: "completed",
      infrastructureFailure: null,
      verdict: null,
      durationMs: 90_000,
      apiDurationMs: 60_000,
      turns: 12,
      permissionDenials: 0,
      apiRetries: 0,
      totalCostUsd: 1.25,
      modelUsage: {
        "claude-opus-5-5": {
          inputTokens: 100,
          outputTokens: 200,
          cacheWriteTokens: 300,
          cacheReadTokens: 400,
          costUsd: 1.25,
          costBasis: "list",
        },
      },
      rateLimit: null,
      transcript: "transcripts/acme/widgets/2026-11/9001-1-triage.jsonl.gz",
    });
  });

  it("a Design-session turn's record is for the event's issue", () => {
    const files = runRecordFor(runEnd({ needs: needs("design", { design: job("success") }), agentResult: agentResult("design", 12) }));

    expect(files?.record).toMatchObject({ role: "design", issue: 12, pullRequest: null, jobResult: "success", turns: 12 });
    expect(files?.recordPath).toBe("runs/acme/widgets/2026-11/9001-1-design.json");
  });

  it("an Implement run's record is for the Ticket the Kit job's plan named, on the Implementer's model", () => {
    const record = runRecordFor(
      runEnd({
        needs: needs("implement", { implement: job("success", { model: "claude-sonnet-5-5" }) }, { ticket: "7", model: "claude-sonnet-5-5" }),
        eventIssue: 7,
        agentResult: agentResult("implement", 7),
      }),
    )?.record;

    expect(record).toMatchObject({ role: "implement", issue: 7, pullRequest: null, model: "claude-sonnet-5-5", baseSha: BASE_SHA, totalCostUsd: 1.25 });
  });

  it("a passing Review's record is for the Ticket and its PR, starting from the PR's head", () => {
    const record = runRecordFor(
      runEnd({
        needs: needs(
          "review",
          {
            "review-checks": { result: "success", outputs: { checks: "green", "head-sha": HEAD_SHA, failed: "[]" } },
            review: job("success", { "base-sha": HEAD_SHA }),
          },
          { ticket: "7", "pull-request": "50" },
        ),
        eventIssue: 50,
        agentResult: agentResult("review", 50, "verdict: pass\n\nAll good."),
      }),
    )?.record;

    expect(record).toMatchObject({ role: "review", issue: 7, pullRequest: 50, baseSha: HEAD_SHA, jobResult: "success", durationMs: 90_000 });
  });

  describe("an Implement run says which run it was", () => {
    const implement = (kitOutputs: Record<string, string>) =>
      runRecordFor(
        runEnd({
          needs: needs("implement", { implement: job("success") }, { ticket: "7", ...kitOutputs }),
          eventIssue: 7,
          agentResult: agentResult("implement", 7),
        }),
      )?.record;

    it("a first run is retry 0, not a Step-up or a Request-changes run", () => {
      expect(implement({ retry: "0" })).toMatchObject({ retry: 0, stepUp: false, requestChanges: false });
    });

    it("a Retry carries its Retry number and its PR", () => {
      expect(implement({ retry: "1", "pull-request": "50" })).toMatchObject({ retry: 1, stepUp: false, requestChanges: false, pullRequest: 50 });
    });

    it("a Step-up carries its Retry number and that it Stepped up", () => {
      expect(implement({ retry: "2", "step-up": "true", "pull-request": "50" })).toMatchObject({ retry: 2, stepUp: true });
    });

    it("a Request-changes run says so, and is no Retry", () => {
      expect(implement({ retry: "0", "request-changes": "true", review: "900", "pull-request": "50" })).toMatchObject({
        retry: 0,
        stepUp: false,
        requestChanges: true,
      });
    });
  });

  describe("a Review carries its Verdict", () => {
    const green = { result: "success", outputs: { checks: "green", "head-sha": HEAD_SHA, failed: "[]" } };
    const review = (reviewer: ReturnType<typeof job>, reply: string | null, failureReport: string | null = null) =>
      runRecordFor(
        runEnd({
          needs: needs("review", { "review-checks": green, review: reviewer }, { ticket: "7", "pull-request": "50" }),
          eventIssue: 50,
          agentResult: reply === null ? null : agentResult("review", 50, reply),
          failureReport,
        }),
      )?.record;

    it.each(["pass", "execution-flaw", "design-flaw"])("a %s Verdict", (verdict) => {
      expect(review(job("success"), `verdict: ${verdict}\n\nFindings.`)?.verdict).toBe(verdict);
    });

    it("a Reviewer that gave no Verdict carries none", () => {
      const record = review(job("failure"), null, JSON.stringify({ failure: "missing-output", detail: "no Verdict line" }));

      expect(record).toMatchObject({ verdict: null, infrastructureFailure: "missing-output" });
    });
  });

  describe("no agent run ended, so there's no record", () => {
    it("red required checks: the Reviewer never ran", () => {
      const red = { result: "success", outputs: { checks: "red", "head-sha": HEAD_SHA, failed: '["build"]' } };
      const end = runEnd({
        needs: needs("review", { "review-checks": red, review: { result: "skipped", outputs: {} } }, { ticket: "7", "pull-request": "50" }),
        agentResult: null,
        transcript: null,
      });

      expect(runRecordFor(end)).toBeNull();
    });

    it("the Kit job routed straight to the push job", () => {
      expect(runRecordFor(runEnd({ needs: needs("push"), agentResult: null, transcript: null }))).toBeNull();
    });

    it("there was nothing to do", () => {
      expect(runRecordFor(runEnd({ needs: needs("none"), agentResult: null, transcript: null }))).toBeNull();
    });

    it("is known from the jobs alone, before anything else is read", () => {
      const red = { result: "success", outputs: { checks: "red", "head-sha": HEAD_SHA, failed: '["build"]' } };

      expect(agentRunEnded(needs("push"), null)).toBe(false);
      expect(agentRunEnded(needs("review", { "review-checks": red, review: { result: "skipped", outputs: {} } }, { ticket: "7", "pull-request": "50" }), 50)).toBe(false);
      expect(agentRunEnded(needs("triage", { triage: job("success") }), 12)).toBe(true);
      expect(agentRunEnded(needs("triage", { triage: job("cancelled") }), 12)).toBe(true);
    });
  });

  describe("a run that failed is recorded as its Infrastructure failure", () => {
    const failedTriage = (result: string, outputs: Record<string, string>, failureReport: string | null, transcript: readonly string[] | null) =>
      runRecordFor(runEnd({ needs: needs("triage", { triage: job(result, outputs) }), agentResult: null, failureReport, transcript }));

    it("a failed 1Password load is an Infrastructure failure of the secrets step: the agent never started", () => {
      const files = failedTriage("failure", { "secrets-step": "failure", model: "", effort: "" }, null, null);

      expect(files?.record).toMatchObject({
        role: "triage",
        issue: 12,
        jobResult: "failure",
        infrastructureFailure: "unreachable-1password",
        model: roles.triage.model,
        turns: null,
        totalCostUsd: null,
        transcript: null,
      });
      expect(files?.transcriptPath).toBeNull();
    });

    it("a Review timed out by its timeout-minutes, with its transcript, gets a record with no result fields", () => {
      const green = { result: "success", outputs: { checks: "green", "head-sha": HEAD_SHA, failed: "[]" } };
      const files = runRecordFor(
        runEnd({
          needs: needs("review", { "review-checks": green, review: job("cancelled") }, { ticket: "7", "pull-request": "50" }),
          agentResult: null,
          transcript: [init],
        }),
      );

      expect(files?.record).toMatchObject({
        role: "review",
        issue: 7,
        pullRequest: 50,
        jobResult: "cancelled",
        infrastructureFailure: "timeout",
        verdict: null,
        subtype: null,
        isError: null,
        terminalReason: null,
        durationMs: null,
        apiDurationMs: null,
        turns: null,
        permissionDenials: null,
        totalCostUsd: null,
        modelUsage: {},
        transcript: "transcripts/acme/widgets/2026-11/9001-1-review.jsonl.gz",
      });
    });

    it("a Review timed out by its timeout-minutes, with no transcript, gets a record with no transcript", () => {
      const green = { result: "success", outputs: { checks: "green", "head-sha": HEAD_SHA, failed: "[]" } };
      const files = runRecordFor(
        runEnd({
          needs: needs("review", { "review-checks": green, review: job("cancelled") }, { ticket: "7", "pull-request": "50" }),
          agentResult: null,
          transcript: null,
        }),
      );

      expect(files?.record).toMatchObject({ infrastructureFailure: "timeout", durationMs: null, apiRetries: null, transcript: null });
      expect(files?.transcriptPath).toBeNull();
      expect(files?.recordPath).toBe("runs/acme/widgets/2026-11/9001-1-review.json");
    });

    it("a Review checks job that failed is a Review Infrastructure failure", () => {
      const files = runRecordFor(
        runEnd({
          needs: needs(
            "review",
            { "review-checks": { result: "failure", outputs: {} }, review: { result: "skipped", outputs: {} } },
            { ticket: "7", "pull-request": "50" },
          ),
          agentResult: null,
          transcript: null,
        }),
      );

      expect(files?.record).toMatchObject({ role: "review", issue: 7, pullRequest: 50, jobResult: "failure", infrastructureFailure: "crash" });
    });

    // The same kinds the failure notice names (src/loop/failures.ts).
    it.each([
      ["crash", "failure", { failure: "crash", detail: "boom" }],
      ["missing-output", "failure", { failure: "missing-output", detail: "no output" }],
      ["provider-error", "failure", { failure: "provider-error", detail: "overloaded_error (529)" }],
      ["dead-token", "failure", { failure: "dead-token", detail: "authentication_failed" }],
      ["weekly-limit", "failure", { failure: "weekly-limit", detail: "", resetsAt: "2026-11-09T00:00:00.000Z" }],
      ["metered-billing", "failure", { failure: "metered-billing", detail: "ANTHROPIC_API_KEY is set" }],
      ["timeout", "cancelled", null],
      ["crash", "failure", null],
    ])("%s, from a %s job and its report", (kind, result, report) => {
      const files = failedTriage(result, {}, report === null ? null : JSON.stringify(report), [init]);

      expect(files?.record.infrastructureFailure).toBe(kind);
    });
  });

  it("a model whose cost basis is unknown has no cost figure, and nor does the run", () => {
    const usage = {
      "claude-opus-5-5": { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4, costUSD: 0.5, costBasis: "list" },
      "claude-next": { inputTokens: 5, outputTokens: 6, cacheCreationInputTokens: 7, cacheReadInputTokens: 8, costUSD: 0, costBasis: "unknown" },
    };
    const record = runRecordFor(runEnd({ transcript: [init, result({ modelUsage: usage, total_cost_usd: 0.5 })] }))?.record;

    expect(record?.modelUsage["claude-next"]).toEqual({
      inputTokens: 5,
      outputTokens: 6,
      cacheWriteTokens: 7,
      cacheReadTokens: 8,
      costUsd: null,
      costBasis: "unknown",
    });
    expect(record?.modelUsage["claude-opus-5-5"]?.costUsd).toBe(0.5);
    expect(record?.totalCostUsd).toBeNull();
  });

  it("keeps only the last weekly-limit reading, as reported", () => {
    const limit = (info: Record<string, unknown>) => line({ type: "rate_limit_event", rate_limit_info: info });
    const transcript = [
      init,
      limit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.2, resetsAt: 1_800_000_000 }),
      limit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.81, resetsAt: 1_800_500_000 }),
      result(),
    ];

    expect(runRecordFor(runEnd({ transcript }))?.record.rateLimit).toEqual({
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.81,
      resetsAt: 1_800_500_000,
    });
  });

  it("keeps the last weekly-limit reading even when a five-hour one came after it", () => {
    const limit = (info: Record<string, unknown>) => line({ type: "rate_limit_event", rate_limit_info: info });
    const transcript = [
      init,
      limit({ status: "allowed", rateLimitType: "seven_day", utilization: 0.4, resetsAt: 1_800_500_000 }),
      limit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.9, resetsAt: 1_800_000_000 }),
      result(),
    ];

    expect(runRecordFor(runEnd({ transcript }))?.record.rateLimit).toMatchObject({ rateLimitType: "seven_day", utilization: 0.4 });
  });

  it("has no weekly-limit reading when the stream reported only five-hour ones", () => {
    const limit = (info: Record<string, unknown>) => line({ type: "rate_limit_event", rate_limit_info: info });
    const transcript = [init, limit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.9, resetsAt: 1_800_000_000 }), result()];

    expect(runRecordFor(runEnd({ transcript }))?.record.rateLimit).toBeNull();
  });

  it("counts permission denials and API retries", () => {
    const retry = line({ type: "system", subtype: "api_retry", attempt: 1, error: "overloaded_error", error_status: 529 });
    const denials = [{ tool_name: "Bash" }, { tool_name: "Write" }];
    const record = runRecordFor(runEnd({ transcript: [init, retry, retry, retry, result({ permission_denials: denials })] }))?.record;

    expect(record).toMatchObject({ permissionDenials: 2, apiRetries: 3 });
  });

  it("a re-run attempt of the same workflow run gets its own record and transcript paths", () => {
    const files = runRecordFor(runEnd({ runAttempt: 2, endedAt: "2026-12-01T00:30:00Z" }));

    expect(files?.recordPath).toBe("runs/acme/widgets/2026-12/9001-2-triage.json");
    expect(files?.transcriptPath).toBe("transcripts/acme/widgets/2026-12/9001-2-triage.jsonl.gz");
    expect(files?.record).toMatchObject({ runAttempt: 2, transcript: files?.transcriptPath });
  });

  it("carries schema 1 and the Kit sha that wrote it", () => {
    expect(runRecordFor(runEnd({ kitSha: "c".repeat(40) }))?.record).toMatchObject({ schema: 1, kitSha: "c".repeat(40) });
  });
});

describe("A judge run's record", () => {
  const JUDGE_MODEL = "claude-sonnet-5-5";
  const limit = (utilization: number) =>
    line({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day", utilization, resetsAt: 1_800_500_000 } });

  /** The record the push job wrote for a first Retry of Ticket 7 on PR 50, the run the judge scored. */
  function scoredRun(overrides: Partial<RunEnd> = {}) {
    const files = runRecordFor(
      runEnd({
        needs: needs("implement", { implement: job("success") }, { ticket: "7", "pull-request": "50", retry: "1" }),
        eventIssue: 7,
        agentResult: agentResult("implement", 7),
        transcript: [init, limit(0.4), result()],
        ...overrides,
      }),
    );
    if (files === null) throw new Error("expected the scored run's record");
    return files;
  }

  /** The judge's stream: one turn on Sonnet, cheap, with its own weekly-limit reading. */
  const judgeStream = [
    init,
    limit(0.52),
    result({
      duration_ms: 20_000,
      duration_api_ms: 18_000,
      num_turns: 1,
      total_cost_usd: 0.04,
      modelUsage: {
        [JUDGE_MODEL]: { inputTokens: 30_000, outputTokens: 900, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUSD: 0.04, costBasis: "list" },
      },
    }),
  ];

  /** What the score-record job knows when a passing judge run on the scored Retry ends, with whatever the case changes. */
  function judgeRunEnd(overrides: Partial<JudgeRunEnd> = {}): JudgeRunEnd {
    return {
      scored: scoredRun().record,
      judge: { result: "success", outputs: { "secrets-step": "success", model: JUDGE_MODEL, effort: "" } },
      judgeModel: JUDGE_MODEL,
      kitSha: KIT_SHA,
      endedAt: "2026-11-05T10:04:00Z",
      failureReport: null,
      transcript: judgeStream,
      ...overrides,
    };
  }

  it("is for the scored run's subject, in role score, with its own model, outcome, effort spent and cost", () => {
    expect(judgeRunRecordFor(judgeRunEnd()).record).toEqual({
      schema: 1,
      kitSha: KIT_SHA,
      repo: "acme/widgets",
      runId: 9001,
      runAttempt: 1,
      role: "score",
      issue: 7,
      pullRequest: 50,
      endedAt: "2026-11-05T10:04:00Z",
      model: JUDGE_MODEL,
      effort: null,
      retry: 0,
      stepUp: false,
      requestChanges: false,
      baseSha: null,
      jobResult: "success",
      subtype: "success",
      isError: false,
      terminalReason: "completed",
      infrastructureFailure: null,
      verdict: null,
      durationMs: 20_000,
      apiDurationMs: 18_000,
      turns: 1,
      permissionDenials: 0,
      apiRetries: 0,
      totalCostUsd: 0.04,
      modelUsage: {
        [JUDGE_MODEL]: { inputTokens: 30_000, outputTokens: 900, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0.04, costBasis: "list" },
      },
      rateLimit: { status: "allowed", rateLimitType: "seven_day", utilization: 0.52, resetsAt: 1_800_500_000 },
      transcript: "transcripts/acme/widgets/2026-11/9001-1-score.jsonl.gz",
    });
  });

  it("sits beside the scored run's record and transcript, sharing its run id and attempt, even when the judge ends the next month", () => {
    const scored = scoredRun({ runAttempt: 2, endedAt: "2026-11-30T23:58:00Z" });
    const files = judgeRunRecordFor(judgeRunEnd({ scored: scored.record, endedAt: "2026-12-01T00:03:00Z" }));

    expect(scored.recordPath).toBe("runs/acme/widgets/2026-11/9001-2-implement.json");
    expect(files.recordPath).toBe("runs/acme/widgets/2026-11/9001-2-score.json");
    expect(scored.transcriptPath).toBe("transcripts/acme/widgets/2026-11/9001-2-implement.jsonl.gz");
    expect(files.transcriptPath).toBe("transcripts/acme/widgets/2026-11/9001-2-score.jsonl.gz");
    expect(files.record).toMatchObject({ runId: 9001, runAttempt: 2, endedAt: "2026-12-01T00:03:00Z", transcript: files.transcriptPath });
  });

  it("a judge timed out with no transcript, its job passing out no model, gets a record on the Kit's judge model with no transcript", () => {
    const files = judgeRunRecordFor(judgeRunEnd({ judge: { result: "cancelled", outputs: {} }, transcript: null }));

    expect(files.record).toMatchObject({
      role: "score",
      issue: 7,
      pullRequest: 50,
      model: JUDGE_MODEL,
      effort: null,
      jobResult: "cancelled",
      infrastructureFailure: "timeout",
      subtype: null,
      isError: null,
      terminalReason: null,
      durationMs: null,
      apiDurationMs: null,
      turns: null,
      permissionDenials: null,
      apiRetries: null,
      totalCostUsd: null,
      modelUsage: {},
      rateLimit: null,
      transcript: null,
    });
    expect(files.transcriptPath).toBeNull();
    expect(files.recordPath).toBe("runs/acme/widgets/2026-11/9001-1-score.json");
  });
});
