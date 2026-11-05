import { describe, expect, it } from "vitest";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import type { Needs } from "./pushJob.ts";
import { type RunEnd, runRecordFor } from "./runRecord.ts";

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
});
