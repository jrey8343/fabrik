import { describe, expect, it } from "vitest";
import { missingSkills, runSummary } from "./summary.ts";

const init = {
  type: "system",
  subtype: "init",
  apiKeySource: "none",
  model: "claude-opus-5-5",
  skills: ["tdd", "triage"],
  session_id: "s1",
};

const result = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 125_400,
  num_turns: 14,
  usage: {
    input_tokens: 1200,
    output_tokens: 3400,
    cache_creation_input_tokens: 5000,
    cache_read_input_tokens: 40_000,
  },
};

const lines = (...messages: unknown[]) => messages.map((m) => JSON.stringify(m));

describe("the agent job's step summary", () => {
  it("falls back to the result's usage for tokens when it has no modelUsage", () => {
    const summary = runSummary({
      role: "triage",
      effort: "medium",
      lines: lines(init, { type: "assistant", message: {} }, result),
    });

    expect(summary).toBe(
      [
        "### Fabrik agent run: triage",
        "",
        "| Role | Model | Effort | Duration | Turns | Input tokens | Output tokens | Cache write | Cache read | Cost |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        "| triage | claude-opus-5-5 | medium | 2m 5s | 14 | 1,200 | 3,400 | 5,000 | 40,000 | unknown |",
        "",
        "Skills loaded: tdd, triage",
        "",
      ].join("\n"),
    );
  });

  it("sums tokens across every model in modelUsage, subagents included, and shows the run's cost", () => {
    const withSubagent = {
      ...result,
      total_cost_usd: 1.2345,
      modelUsage: {
        "claude-opus-5-5": {
          inputTokens: 1200,
          outputTokens: 3400,
          cacheCreationInputTokens: 5000,
          cacheReadInputTokens: 40_000,
        },
        "claude-haiku-5-5": {
          inputTokens: 300,
          outputTokens: 600,
          cacheCreationInputTokens: 1000,
          cacheReadInputTokens: 2000,
        },
      },
    };
    const summary = runSummary({ role: "implement", effort: "high", lines: lines(init, withSubagent) });

    expect(summary).toContain("| implement | claude-opus-5-5 | high | 2m 5s | 14 | 1,500 | 4,000 | 6,000 | 42,000 | $1.23 |");
  });

  it("says unknown for anything the stream never reported, as when a run dies before its result", () => {
    const summary = runSummary({ role: "triage", effort: null, lines: ["not json", ...lines(init)] });

    expect(summary).toContain(
      "| triage | claude-opus-5-5 | CLI default | unknown | unknown | unknown | unknown | unknown | unknown | unknown |",
    );
  });

  it("reports the effort the runner passed, whatever the init message says", () => {
    const summary = runSummary({ role: "review", effort: "xhigh", lines: lines({ ...init, effort: "low" }, result) });

    expect(summary).toContain("| review | claude-opus-5-5 | xhigh |");
  });

  it("names each installed source with its short SHA and the skills from it, confirming from the init message that they loaded", () => {
    const summary = runSummary({
      role: "triage",
      effort: null,
      lines: lines(init, result),
      installed: [{ repository: "mattpocock/skills", sha: "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d", skills: ["tdd", "triage"] }],
    });

    expect(summary).toContain("Installed from mattpocock/skills at 4ae2317: tdd, triage (all 2 loaded)");
  });

  it("names the installed skills the init message didn't report", () => {
    const summary = runSummary({
      role: "triage",
      effort: null,
      lines: lines(init, result),
      installed: [
        { repository: "mattpocock/skills", sha: "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d", skills: ["tdd", "triage", "to-spec", "grilling"] },
      ],
    });

    expect(summary).toContain(
      "Installed from mattpocock/skills at 4ae2317: tdd, triage, to-spec, grilling (2 of 4 loaded; missing: to-spec, grilling)",
    );
  });

  it("flags every installed skill, across sources, that the init message didn't report", () => {
    const installed = [
      { repository: "mattpocock/skills", sha: "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d", skills: ["tdd", "grilling"] },
      { repository: "jrey8343/skills", sha: "0123456789abcdef0123456789abcdef01234567", skills: ["event-storming"] },
    ];

    expect(missingSkills(lines(init, result), installed)).toEqual(["grilling", "event-storming"]);
  });

  it("says when no init message arrived, so no skills were seen to load", () => {
    const summary = runSummary({ role: "triage", effort: null, lines: [] });

    expect(summary).toContain("| triage | unknown | CLI default |");
    expect(summary).toContain("Skills loaded: none reported");
  });
});
