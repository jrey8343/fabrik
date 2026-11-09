import { describe, expect, it } from "vitest";
import { REVIEW_HIGH } from "../__fixtures__/replay.ts";
import { noWait, storeWith } from "../__fixtures__/store.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { replayArms } from "./replay.ts";
import { type ArmArtifacts, armJobOf, type ArmRunArtifacts, readArmJob } from "./replayArtifacts.ts";
import { armScoring, readReplayRunEnded, replayRunContextOf, replayRunEnded, replayRunFiles, writeReplayRun } from "./replayRecord.ts";
import type { Rubric } from "./rubrics.ts";
import type { ReplayArm } from "./runRecord.ts";

const KIT_SHA = "f".repeat(40);
const BASE_SHA = "b".repeat(40);
const ENDED_AT = "2026-11-07T12:00:00Z";

const RUBRICS: readonly Rubric[] = [
  { name: "efficiency", version: 1, threshold: 0.7, labels: ["clean", "repeated-calls"], text: "How directly the run worked." },
];

/** Replay #140's run 9001 of Ticket 12, merged in #112, review.effort: high, on the Kit job's outputs. */
const CONTEXT = replayRunContextOf(
  {
    "replay-issue": "140",
    ticket: "12",
    "pull-request": "112",
    "base-sha": BASE_SHA,
    "replay-arms": JSON.stringify(replayArms(DEFAULT_KIT_CONFIG, REVIEW_HIGH)),
    subscription: "Claude token",
    sha: KIT_SHA,
  },
  { repo: "acme/shop", runId: 9001, runAttempt: 1 },
);

const line = (message: unknown) => JSON.stringify(message);
const GZIP = new Uint8Array([0x1f, 0x8b, 8, 0]);

/** A run's stream: an init and a clean result. */
const LINES = [
  line({ type: "system", subtype: "init", apiKeySource: "none" }),
  line({ type: "result", subtype: "success", is_error: false, num_turns: 12, duration_ms: 90_000, total_cost_usd: 1.25 }),
];

/** A run whose job passed, with its transcript, as the arm's job left it. */
function ran(overrides: Partial<ArmRunArtifacts> = {}): ArmRunArtifacts {
  return {
    job: line({ ran: true, job: { result: "success", outputs: { "secrets-step": "success", model: "claude-opus-5-5", effort: "" } } }),
    agentResult: null,
    failureReport: null,
    transcript: LINES,
    transcriptGzip: GZIP,
    ...overrides,
  };
}

/** What one arm's jobs left when every one of them ran and passed: a non-empty patch, its gates, a passing Verdict and the judge's answer. */
function armRan(arm: ReplayArm, overrides: Partial<ArmArtifacts> = {}): ArmArtifacts {
  return {
    implement: ran(),
    review: ran({ agentResult: line({ role: "review", issue: 12, output: "Verdict: pass\n\nAll good." }) }),
    patch: new TextEncoder().encode("diff --git a/x b/x\n"),
    gates: line({ ticket: 12, arm, run: 9001, gates: "passed", hiddenTests: "passed" }),
    judge: {
      ...ran(),
      result: line({ output: { answers: [{ scorer: "efficiency", score: 0.8, label: "clean", rationale: "Direct." }] }, digestTrimmed: false }),
      failure: null,
    },
    ...overrides,
  };
}

const KIT = { sha: KIT_SHA, rubrics: RUBRICS };

describe("The replay-record job's files, for both arms of one replay Ticket's run", () => {
  it("writes each arm's Implement and Review runs, its patch and gates, and the judge's run and score file, at create-only paths that name the arm", async () => {
    const store = storeWith();
    const files = replayRunFiles(CONTEXT, { baseline: armRan("baseline"), variant: armRan("variant") }, KIT, ENDED_AT);

    await writeReplayRun(store, files, noWait);

    const month = "acme/shop/2026-11";
    const armFiles = (arm: ReplayArm) => [
      `transcripts/${month}/9001-1-implement-replay-${arm}.jsonl.gz`,
      `runs/${month}/9001-1-implement-replay-${arm}.json`,
      `replays/acme/shop/140/12-${arm}-9001.patch`,
      `replays/acme/shop/140/12-${arm}-9001.gates.json`,
      `transcripts/${month}/9001-1-review-replay-${arm}.jsonl.gz`,
      `runs/${month}/9001-1-review-replay-${arm}.json`,
      `transcripts/${month}/9001-1-score-replay-${arm}.jsonl.gz`,
      `runs/${month}/9001-1-score-replay-${arm}.json`,
      expect.stringMatching(new RegExp(`^scores/${month}/9001-1-implement-replay-${arm}-[0-9a-f]+\\.json$`)),
    ];
    expect(store.writes).toEqual([...armFiles("baseline"), ...armFiles("variant")]);
    expect(new Set(store.writes).size).toBe(store.writes.length);
  });

  it("leaves every file the store holds already as it was, as a re-run of the job finds them", async () => {
    const files = replayRunFiles(CONTEXT, { baseline: armRan("baseline"), variant: armRan("variant") }, KIT, ENDED_AT);
    const paths = files.writes.flatMap((group) => group.files.map(({ path }) => path));
    const store = storeWith({ files: paths });

    expect(await writeReplayRun(store, files, noWait)).toEqual({ kind: "written", written: [], existing: paths });
  });

  it("writes a Ticket's second run's patch and gates beside its first's, as when the first run never landed", async () => {
    const second = { ...CONTEXT, runId: 9003 };
    const gates = { gates: line({ ticket: 12, arm: "baseline", run: 9003, gates: "passed", hiddenTests: "failed" }) };
    const files = replayRunFiles(second, { baseline: armRan("baseline", gates), variant: armRan("variant", { gates: null }) }, KIT, ENDED_AT);
    const store = storeWith({ files: ["replays/acme/shop/140/12-baseline-9001.patch", "replays/acme/shop/140/12-baseline-9001.gates.json"] });

    await writeReplayRun(store, files, noWait);

    expect(store.writes.filter((path) => path.startsWith("replays/"))).toEqual([
      "replays/acme/shop/140/12-baseline-9003.patch",
      "replays/acme/shop/140/12-baseline-9003.gates.json",
      "replays/acme/shop/140/12-variant-9003.patch",
    ]);
  });

  it("writes nothing to a store others can read", async () => {
    const files = replayRunFiles(CONTEXT, { baseline: armRan("baseline"), variant: armRan("variant") }, KIT, ENDED_AT);
    const store = storeWith({ private: false });

    expect(await writeReplayRun(store, files, noWait)).toEqual({ kind: "public-store" });
    expect(store.writes).toEqual([]);
  });
});

describe("Scoring each arm's Implement run, as the scoring plan has it", () => {
  const decoded = (store: ReturnType<typeof storeWith>, path: string | undefined): unknown =>
    JSON.parse(Buffer.from(store.held.get(path ?? "") ?? "", "base64").toString("utf8"));
  const scoreFileIn = (store: ReturnType<typeof storeWith>, arm: ReplayArm) => store.writes.find((path) => path.startsWith(`scores/`) && path.includes(`-replay-${arm}-`));

  it("scores every arm from the judge's answer, under the pinned release's rubrics, the score file naming the arm", async () => {
    const store = storeWith();
    await writeReplayRun(store, replayRunFiles(CONTEXT, { baseline: armRan("baseline"), variant: armRan("variant") }, KIT, ENDED_AT), noWait);

    expect(decoded(store, scoreFileIn(store, "variant"))).toMatchObject({
      kitSha: KIT_SHA,
      replay: { issue: 140, arm: "variant", ticket: 12, candidateSha: null },
      record: "runs/acme/shop/2026-11/9001-1-implement-replay-variant.json",
      judge: { record: "runs/acme/shop/2026-11/9001-1-score-replay-variant.json" },
      rubrics: ["efficiency@1"],
      skip: null,
      entries: [expect.objectContaining({ scorer: "efficiency", score: 0.8, pass: true })],
    });
  });

  it("writes a skip's score file for an arm the plan skips, and no judge run, whatever the judge's job left", async () => {
    const store = storeWith();
    const untranscribed = armRan("baseline", { implement: ran({ transcript: null, transcriptGzip: null }) });
    await writeReplayRun(store, replayRunFiles(CONTEXT, { baseline: untranscribed, variant: armRan("variant") }, KIT, ENDED_AT), noWait);

    expect(decoded(store, scoreFileIn(store, "baseline"))).toMatchObject({ judge: null, skip: { reason: "no-transcript" }, entries: null });
    expect(store.writes).not.toContain("runs/acme/shop/2026-11/9001-1-score-replay-baseline.json");
  });

  it("writes no score file for an arm the plan picked whose judge left no account of its run", async () => {
    const store = storeWith();
    const unjudged = armRan("baseline", { judge: { job: null, result: null, failure: null, transcript: null, transcriptGzip: null } });
    await writeReplayRun(store, replayRunFiles(CONTEXT, { baseline: unjudged, variant: armRan("variant") }, KIT, ENDED_AT), noWait);

    expect(scoreFileIn(store, "baseline")).toBeUndefined();
    expect(scoreFileIn(store, "variant")).toBeDefined();
  });

  describe("for a `kit` variant", () => {
    const CANDIDATE = "e".repeat(40);
    const kitVariant = replayRunContextOf(
      {
        "replay-issue": "140",
        ticket: "12",
        "pull-request": "112",
        "base-sha": BASE_SHA,
        "replay-arms": JSON.stringify(replayArms(DEFAULT_KIT_CONFIG, { kind: "kit", sha: CANDIDATE })),
        subscription: "Claude token",
        sha: KIT_SHA,
      },
      { repo: "acme/shop", runId: 9001, runAttempt: 1 },
    );

    it("names the candidate sha in the variant's records and score file, while their kitSha and rubrics stay the pinned release's", async () => {
      const store = storeWith();
      await writeReplayRun(store, replayRunFiles(kitVariant, { baseline: armRan("baseline"), variant: armRan("variant") }, KIT, ENDED_AT), noWait);

      expect(decoded(store, "runs/acme/shop/2026-11/9001-1-implement-replay-variant.json")).toMatchObject({ kitSha: KIT_SHA, replay: { candidateSha: CANDIDATE } });
      expect(decoded(store, "runs/acme/shop/2026-11/9001-1-implement-replay-baseline.json")).toMatchObject({ replay: { candidateSha: null } });
      expect(decoded(store, scoreFileIn(store, "variant"))).toMatchObject({ kitSha: KIT_SHA, replay: { candidateSha: CANDIDATE }, rubrics: ["efficiency@1"] });
    });

    it("never scores an arm under rubrics read at the candidate sha", () => {
      expect(() => replayRunFiles(kitVariant, { baseline: armRan("baseline"), variant: armRan("variant") }, { sha: CANDIDATE, rubrics: RUBRICS }, ENDED_AT)).toThrow(
        /is scored under the rubrics of its pinned release/,
      );
    });
  });
});

// The judge job runs the plan before the judge, so an arm the plan skips never spends a judge run (#286).
describe("Whether the judge scores an arm's Implement run, decided before it runs", () => {
  it("scores an arm's run, never sampled, from its transcript", () => {
    expect(armScoring(CONTEXT, "variant", ran(), ENDED_AT)).toEqual({ score: true, why: "the scoring plan picks every Replay arm's Implement run" });
  });

  it("doesn't for a run the plan skips, saying why, as the replay-record job's skip score file will", () => {
    expect(armScoring(CONTEXT, "variant", ran({ transcript: null, transcriptGzip: null }), ENDED_AT)).toEqual({ score: false, why: "the scoring plan skips it: no-transcript" });
  });

  it("doesn't for an arm whose Implement run never ran, or left no account of how it went", () => {
    expect(armScoring(CONTEXT, "variant", ran({ job: null }), ENDED_AT)).toEqual({ score: false, why: "the variant arm's Implement run left no account of how it went" });
  });
});

describe("An arm's job's account of its run, from how its steps went", () => {
  const steps = { agent: "success", secrets: "success", job: "success", model: "claude-opus-5-5", effort: "high", notRun: "" };
  const outputs = { "secrets-step": "success", model: "claude-opus-5-5", effort: "high" };

  it("passed, with what it passed out, when the agent step passed", () => {
    expect(armJobOf(steps)).toEqual({ ran: true, job: { result: "success", outputs } });
  });

  it("failed when the agent step failed", () => {
    expect(armJobOf({ ...steps, agent: "failure", job: "failure" })).toEqual({ ran: true, job: { result: "failure", outputs } });
  });

  // Read as a timeout, as the push job reads a cancelled agent job.
  it("cancelled when the job was cancelled, by its timeout or the workflow run's, before the agent step passed", () => {
    expect(armJobOf({ ...steps, agent: "cancelled", job: "cancelled" })).toMatchObject({ ran: true, job: { result: "cancelled" } });
    expect(armJobOf({ ...steps, agent: "", job: "cancelled" })).toMatchObject({ ran: true, job: { result: "cancelled" } });
  });

  it("failed when a step before the agent failed, as when its Claude token never loaded", () => {
    expect(armJobOf({ ...steps, agent: "skipped", secrets: "failure", job: "failure", model: "", effort: "" })).toEqual({
      ran: true,
      job: { result: "failure", outputs: { "secrets-step": "failure", model: "", effort: "" } },
    });
  });

  it("never started, with why, when the job had nothing to run it on", () => {
    expect(armJobOf({ ...steps, agent: "skipped", secrets: "skipped", notRun: "the arm's Implement run left no patch" })).toEqual({
      ran: false,
      why: "the arm's Implement run left no patch",
    });
  });

  it("reads back as the replay-record job reads it", () => {
    expect(readArmJob(JSON.stringify(armJobOf(steps)))).toEqual(armJobOf(steps));
  });
});

describe("A replay Ticket's run, read from the Kit job's outputs", () => {
  it("is no replay's without the replay route's outputs", () => {
    expect(() => replayRunContextOf({ ticket: "12", sha: KIT_SHA }, { repo: "acme/shop", runId: 9001, runAttempt: 1 })).toThrow(/isn't a replay Ticket's run/);
  });

  it.each([
    ["don't read as each arm's", '{"baseline":{}}'],
    ["name a model Kit config refuses", JSON.stringify({ ...replayArms(DEFAULT_KIT_CONFIG, REVIEW_HIGH), variant: { ...replayArms(DEFAULT_KIT_CONFIG, REVIEW_HIGH).variant, review: { model: "best", effort: null } } })],
    ["name a candidate Kit that isn't a full sha", JSON.stringify({ ...replayArms(DEFAULT_KIT_CONFIG, REVIEW_HIGH), variant: { ...replayArms(DEFAULT_KIT_CONFIG, REVIEW_HIGH).variant, candidateSha: "abc1234" } })],
  ])("refuses arms' settings that %s, as the replay issue's plan does", (_, arms) => {
    const outputs = { "replay-issue": "140", ticket: "12", "pull-request": "112", "base-sha": BASE_SHA, "replay-arms": arms, subscription: "Claude token", sha: KIT_SHA };

    expect(() => replayRunContextOf(outputs, { repo: "acme/shop", runId: 9001, runAttempt: 1 })).toThrow(/replay-arms/);
  });
});

describe("How a replay Ticket's run ended, for the Loop to land on the replay issue", () => {
  /** A run whose job failed, leaving this failure report. */
  const failed = (report: unknown): ArmRunArtifacts =>
    ran({ job: line({ ran: true, job: { result: "failure", outputs: { "secrets-step": "success", model: "claude-opus-5-5", effort: "" } } }), failureReport: line(report) });
  const written = (files: ReturnType<typeof replayRunFiles>) => files.writes.flatMap((group) => group.files.map(({ path }) => path));

  it("is done once both arms' Implement and Review runs ran, whatever their gates and Verdicts", () => {
    const files = replayRunFiles(CONTEXT, { baseline: armRan("baseline"), variant: armRan("variant", { gates: line({ ticket: 12, arm: "variant", run: 9001, gates: "tests-failed", hiddenTests: "failed" }) }) }, KIT, ENDED_AT);

    expect(files.ended).toEqual({ issue: 140, ticket: 12, run: 9001, end: { kind: "done" }, subscription: "Claude token", resetsAt: null });
  });

  it("is a weekly-limit refusal when any arm's run was refused on the Subscription's weekly limit, with when it resets", () => {
    const refused = failed({ failure: "weekly-limit", detail: "You've hit your weekly limit", resetsAt: "2026-11-09T04:00:00.000Z" });
    const files = replayRunFiles(CONTEXT, { baseline: armRan("baseline"), variant: armRan("variant", { review: refused }) }, KIT, ENDED_AT);

    expect(files.ended).toMatchObject({ end: { kind: "weekly-limit" }, resetsAt: "2026-11-09T04:00:00.000Z" });
  });

  it("is an Infrastructure failure, naming the arm and the run, when any arm's run ended in any other", () => {
    const files = replayRunFiles(CONTEXT, { baseline: armRan("baseline", { implement: failed({ failure: "provider-error", detail: "overloaded" }) }), variant: armRan("variant") }, KIT, ENDED_AT);

    expect(files.ended.end).toEqual({ kind: "infrastructure", reason: "the baseline arm's Implement run ended in an Infrastructure failure (provider-error)" });
  });

  // #340: an arm's input step that fails on a GitHub read leaves #328's report, which the landing names.
  it("names the request and GitHub's answer when an arm's input step couldn't read the Ticket, which its record keeps too", () => {
    const unread = ran({
      job: line({ ran: true, job: { result: "failure", outputs: { "secrets-step": "skipped", model: "", effort: "" } } }),
      failureReport: line({ failure: "unread-inputs", detail: "GET /repos/acme/shop/pulls/112: 403 Resource not accessible by integration", refused: true }),
      transcript: null,
      transcriptGzip: null,
    });
    const files = replayRunFiles(CONTEXT, { baseline: armRan("baseline"), variant: armRan("variant", { review: unread }) }, KIT, ENDED_AT);
    const record = files.writes.flatMap((group) => group.files).find(({ path }) => path === "runs/acme/shop/2026-11/9001-1-review-replay-variant.json");

    expect(files.ended.end).toEqual({
      kind: "infrastructure",
      reason:
        "the variant arm's Review run ended in an Infrastructure failure (unread-inputs): GET /repos/acme/shop/pulls/112: 403 Resource not accessible by integration",
    });
    expect(JSON.parse(Buffer.from(record?.content ?? []).toString("utf8"))).toMatchObject({ infrastructureFailure: "unread-inputs" });
  });

  // The record job runs even when the workflow run was cancelled, so a Ticket never stays in progress for good.
  it("is an Infrastructure failure when an arm's run left no account of how it went, as when the workflow run was cancelled", () => {
    const files = replayRunFiles(CONTEXT, { baseline: armRan("baseline"), variant: armRan("variant", { implement: ran({ job: null, transcript: null, transcriptGzip: null }) }) }, KIT, ENDED_AT);

    expect(files.ended.end).toEqual({ kind: "infrastructure", reason: "the variant arm's Implement run left no account of how it went, as when its workflow run is cancelled" });
  });

  it("is told with no rubrics to read, so the replay-record job leaves it before anything else can fail", () => {
    const arms = { baseline: armRan("baseline"), variant: armRan("variant", { implement: ran({ job: null, transcript: null, transcriptGzip: null }) }) };

    expect(replayRunEnded(CONTEXT, arms, ENDED_AT)).toEqual({
      issue: 140,
      ticket: 12,
      run: 9001,
      end: { kind: "infrastructure", reason: "the variant arm's Implement run left no account of how it went, as when its workflow run is cancelled" },
      subscription: "Claude token",
      resetsAt: null,
    });
  });

  it("keeps a Ticket's patches and gates only from the run it's done in, since each arm has one place for them, and every run's records", () => {
    const files = replayRunFiles(CONTEXT, { baseline: armRan("baseline"), variant: armRan("variant", { review: failed({ failure: "crash", detail: "boom" }) }) }, KIT, ENDED_AT);

    expect(written(files).filter((path) => path.startsWith("replays/"))).toEqual([]);
    expect(written(files).filter((path) => path.startsWith("runs/"))).toHaveLength(6);
  });

  it("reads back from the file the replay-record job leaves for the Loop, and nothing else does", () => {
    const { ended } = replayRunFiles(CONTEXT, { baseline: armRan("baseline"), variant: armRan("variant") }, KIT, ENDED_AT);

    expect(readReplayRunEnded(JSON.stringify(ended))).toEqual(ended);
    expect(() => readReplayRunEnded(JSON.stringify({ ...ended, end: { kind: "infrastructure" } }))).toThrow(/doesn't read/);
    expect(() => readReplayRunEnded("not json")).toThrow(/doesn't read/);
  });

  it("is done when an arm's Review never started because its Implement run's patch wasn't laid, which writes no Review record", () => {
    const notRun = ran({ job: line({ ran: false, why: "its patch changes .fabrik/config.json" }), transcript: null, transcriptGzip: null });
    const files = replayRunFiles(CONTEXT, { baseline: armRan("baseline"), variant: armRan("variant", { review: notRun }) }, KIT, ENDED_AT);

    expect(files.ended.end).toEqual({ kind: "done" });
    expect(written(files)).not.toContain("runs/acme/shop/2026-11/9001-1-review-replay-variant.json");
  });
});
