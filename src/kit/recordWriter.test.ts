import { describe, expect, it } from "vitest";
import { noWait, storeWith } from "../__fixtures__/store.ts";
import type { ReplayArm, RunRecord, RunRecordFiles } from "./runRecord.ts";
import { recordWriteSummary, storeCommitMessage, writeRunRecord } from "./recordWriter.ts";

const RECORD_PATH = "runs/acme/widgets/2026-11/9001-1-triage.json";
const TRANSCRIPT_PATH = "transcripts/acme/widgets/2026-11/9001-1-triage.jsonl.gz";
const TRANSCRIPT = new Uint8Array([0x1f, 0x8b, 8, 0]);

/** The record a passing Triage run on #12 gets; only its path and content matter here. */
function files(overrides: Partial<RunRecordFiles> = {}): RunRecordFiles {
  const record = { schema: 4, repo: "acme/widgets", runId: 9001, runAttempt: 1, role: "triage", issue: 12, replay: null } as unknown as RunRecord;
  return { record, recordPath: RECORD_PATH, transcriptPath: TRANSCRIPT_PATH, ...overrides };
}

describe("Writing a run's Run record to the store", () => {
  it("writes the gzipped transcript, then the record", async () => {
    const store = storeWith();

    const write = await writeRunRecord(store, files(), TRANSCRIPT, noWait);

    expect(write).toEqual({ kind: "written", written: [TRANSCRIPT_PATH, RECORD_PATH], existing: [] });
    expect(store.writes).toEqual([TRANSCRIPT_PATH, RECORD_PATH]);
    expect(Buffer.from(store.held.get(TRANSCRIPT_PATH) ?? "", "base64")).toEqual(Buffer.from(TRANSCRIPT));
    expect(JSON.parse(Buffer.from(store.held.get(RECORD_PATH) ?? "", "base64").toString("utf8"))).toEqual(files().record);
  });

  it("never overwrites a file the store already holds, and still writes the other", async () => {
    const store = storeWith({ files: [TRANSCRIPT_PATH] });

    const write = await writeRunRecord(store, files(), TRANSCRIPT, noWait);

    expect(write).toEqual({ kind: "written", written: [RECORD_PATH], existing: [TRANSCRIPT_PATH] });
    expect(store.held.get(TRANSCRIPT_PATH)).toBe("earlier");
  });

  it("fails on a write the store refuses for a file that isn't there", async () => {
    const store = storeWith({ refused: [RECORD_PATH] });

    await expect(writeRunRecord(store, files(), TRANSCRIPT, noWait)).rejects.toThrow(/422/);
  });

  it("retries a write a parallel commit beat, waiting longer each time", async () => {
    const store = storeWith({ conflicts: { [RECORD_PATH]: 3 } });
    const waits: number[] = [];

    const write = await writeRunRecord(store, files(), TRANSCRIPT, async (ms) => {
      waits.push(ms);
    });

    expect(write).toEqual({ kind: "written", written: [TRANSCRIPT_PATH, RECORD_PATH], existing: [] });
    expect(store.writes).toEqual([TRANSCRIPT_PATH, RECORD_PATH, RECORD_PATH, RECORD_PATH, RECORD_PATH]);
    expect(waits).toHaveLength(3);
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
    expect(waits[2]).toBeGreaterThan(waits[1] ?? 0);
  });

  it("gives up on a write parallel commits keep beating, having written nothing over another file", async () => {
    const store = storeWith({ conflicts: { [TRANSCRIPT_PATH]: 100 } });

    await expect(writeRunRecord(store, files(), TRANSCRIPT, noWait)).rejects.toThrow(/409/);
    expect(store.held.has(RECORD_PATH)).toBe(false);
  });

  it("writes nothing to a store that isn't private", async () => {
    const store = storeWith({ private: false });

    expect(await writeRunRecord(store, files(), TRANSCRIPT, noWait)).toEqual({ kind: "public-store" });
    expect(store.writes).toEqual([]);
  });

  it("writes nothing when no agent run ended, red checks say", async () => {
    const store = storeWith();

    expect(await writeRunRecord(store, null, null, noWait)).toEqual({ kind: "no-record" });
    expect(store.writes).toEqual([]);
  });

  it("writes only the record when no transcript survived the run", async () => {
    const store = storeWith();

    const write = await writeRunRecord(store, files({ transcriptPath: null }), null, noWait);

    expect(write).toEqual({ kind: "written", written: [RECORD_PATH], existing: [] });
  });
});

describe("The step summary's line on the Run record", () => {
  it("names the setup step when the Fabrik App has no token for the store", () => {
    expect(recordWriteSummary({ kind: "no-store-token" })).toBe(
      "No Run record written: the Fabrik App couldn't get a token for jrey8343/fabrik-runs. " +
        "Run Setup again, giving it your time zone, to create the store, then install the Fabrik App on jrey8343/fabrik-runs.",
    );
  });

  it("says why nothing was written to a store that isn't private", () => {
    expect(recordWriteSummary({ kind: "public-store" })).toBe(
      "No Run record written: jrey8343/fabrik-runs isn't private, and the Kit writes nothing to a store others can read. Make it private.",
    );
  });

  it("says no agent run ended when there's no record", () => {
    expect(recordWriteSummary({ kind: "no-record" })).toBe("No Run record: no agent run ended in this run.");
  });

  it("names what was written and what the store already held", () => {
    expect(recordWriteSummary({ kind: "written", written: [RECORD_PATH], existing: [TRANSCRIPT_PATH] })).toBe(
      `Written to jrey8343/fabrik-runs: ${RECORD_PATH}. Already there, left as it was: ${TRANSCRIPT_PATH}.`,
    );
  });

  it("says only what a re-run found already there, when it wrote nothing", () => {
    expect(recordWriteSummary({ kind: "written", written: [], existing: [TRANSCRIPT_PATH, RECORD_PATH] })).toBe(
      `Already there, left as it was: ${TRANSCRIPT_PATH}, ${RECORD_PATH}.`,
    );
  });
});

describe("The store commit of a run's files", () => {
  const run = { repo: "acme/widgets", runId: 9001, runAttempt: 1, role: "implement", replay: null } as const;

  it("names the repo, the run and its role", () => {
    expect(storeCommitMessage(run)).toBe("acme/widgets run 9001-1 (implement)");
  });

  it("names a Replay arm's run's arm too, so the two arms of one workflow run each name their own", () => {
    const arm = (arm: ReplayArm) => storeCommitMessage({ ...run, replay: { issue: 300, arm, ticket: 7, candidateSha: null } });

    expect([arm("baseline"), arm("variant")]).toEqual([
      "acme/widgets run 9001-1 (implement, replay baseline)",
      "acme/widgets run 9001-1 (implement, replay variant)",
    ]);
  });
});
