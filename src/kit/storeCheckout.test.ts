import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { aRecordWithTranscript } from "../__fixtures__/retroEvidence.ts";
import { aScoreFile } from "../__fixtures__/weeklySummary.ts";
import { RUN_RECORD_SCHEMA, recordPathOf, replayGatesPath } from "./runRecord.ts";
import { readStoreReplayGates, readStoreReplayPatches, readStoreRunRecords, readStoreScoreFiles, readStoreTranscripts } from "./storeCheckout.ts";

/** A checkout of the store holding these files, by their paths in it. */
async function aCheckoutWith(files: Readonly<Record<string, string | Uint8Array>>): Promise<string> {
  const store = await mkdtemp(join(tmpdir(), "fabrik-store-"));
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(store, path)), { recursive: true });
    await writeFile(join(store, path), contents);
  }
  return store;
}

describe("Reading the store's checkout", () => {
  const record = aRecordWithTranscript({ repo: "owner/product", runId: 1001, role: "review", endedAt: "2026-11-01T00:00:00Z" });
  const scorePath = "scores/owner/product/2026-11/1001-1-implement-abc123.json";

  it("reads every Run record and score file at the current schema, each by its path in the store", async () => {
    const store = await aCheckoutWith({
      [recordPathOf(record)]: JSON.stringify(record),
      "runs/owner/product/2026-11/1002-1-triage.json": JSON.stringify({ ...record, schema: 7 }),
      [scorePath]: JSON.stringify(aScoreFile()),
      "scores/owner/product/2026-11/1003-1-implement-def456.json": JSON.stringify({ ...aScoreFile(), schema: 3 }),
    });

    expect((await readStoreRunRecords(store, ["Claude token", "Claude token 2"])).records).toEqual({ [recordPathOf(record)]: record });
    expect(await readStoreScoreFiles(store)).toEqual({ [scorePath]: aScoreFile() });
  });

  // A store whose caller pins an older release than the Product repos' (#474).
  it("counts the Run records it can't read, with the newest schema among them a newer Kit wrote", async () => {
    const store = await aCheckoutWith({
      [recordPathOf(record)]: JSON.stringify(record),
      "runs/owner/product/2026-11/1002-1-triage.json": JSON.stringify({ ...record, schema: RUN_RECORD_SCHEMA + 1 }),
      "runs/owner/product/2026-11/1003-1-triage.json": JSON.stringify({ ...record, schema: RUN_RECORD_SCHEMA + 2 }),
      "runs/owner/product/2026-11/1004-1-triage.json": JSON.stringify("not a record"),
    });

    expect((await readStoreRunRecords(store, ["Claude token"])).unreadable).toEqual({ count: 3, newestSchema: RUN_RECORD_SCHEMA + 2 });
  });

  it("counts no Run record it can't read, and no newer schema, when it reads them all or none is a newer Kit's", async () => {
    const readable = await aCheckoutWith({ [recordPathOf(record)]: JSON.stringify(record) });
    const unknown = await aCheckoutWith({ [recordPathOf(record)]: JSON.stringify({ ...record, schema: 0 }) });

    expect((await readStoreRunRecords(readable, ["Claude token"])).unreadable).toEqual({ count: 0, newestSchema: null });
    expect((await readStoreRunRecords(unknown, ["Claude token"])).unreadable).toEqual({ count: 1, newestSchema: null });
  });

  it("reads a schema 1 score file, written before Replays, as no replay's, at the current schema", async () => {
    const { replay: _, ...older } = aScoreFile();
    const store = await aCheckoutWith({ [scorePath]: JSON.stringify({ ...older, schema: 1 }) });

    expect(await readStoreScoreFiles(store)).toEqual({ [scorePath]: { ...aScoreFile(), schema: 2, replay: null } });
  });

  it("reads a schema 1 Run record, written before runs were given a Subscription, as on the first listed one", async () => {
    const { subscription: _, ...unnamed } = record;
    const store = await aCheckoutWith({ [recordPathOf(record)]: JSON.stringify({ ...unnamed, schema: 1 }) });

    expect((await readStoreRunRecords(store, ["Claude token 2", "Claude token"])).records).toEqual({
      [recordPathOf(record)]: { ...record, subscription: "Claude token 2" },
    });
  });

  it("reads a run's transcript by the path its Run record names, as its lines", async () => {
    const lines = ['{"type":"system","subtype":"init"}', '{"type":"result","subtype":"success"}'];
    const store = await aCheckoutWith({ [record.transcript!]: gzipSync(lines.map((line) => `${line}\n`).join("")) });

    const readTranscript = await readStoreTranscripts(store);

    expect(readTranscript(record.transcript!)).toEqual(lines);
    expect(readTranscript(record.transcript!.replace("1001", "1002"))).toBeNull();
  });

  it("reads nothing from a part of the store the checkout doesn't hold", async () => {
    const store = await aCheckoutWith({});

    expect(await readStoreRunRecords(store, ["Claude token"])).toEqual({ records: {}, unreadable: { count: 0, newestSchema: null } });
    expect(await readStoreScoreFiles(store)).toEqual({});
    expect((await readStoreTranscripts(store))(record.transcript!)).toBeNull();
  });

  // Beside each arm's patch, which a Replay's results read back for every Ticket done (#156).
  it("reads each Replay arm's gates, leaving out a file that doesn't read as one, and none when there are none", async () => {
    const gates = { ticket: 12, arm: "variant", run: 9001, gates: "tests-failed", hiddenTests: "passed" };
    const store = await aCheckoutWith({
      [replayGatesPath("owner/product", { issue: 140, ticket: 12, arm: "variant", run: 9001 })]: JSON.stringify(gates),
      [replayGatesPath("owner/product", { issue: 140, ticket: 12, arm: "baseline", run: 9001 })]: JSON.stringify({ ...gates, arm: "baseline", gates: "green" }),
      "replays/owner/product/140/12-variant-9001.patch": "diff --git a/x b/x\n",
    });

    expect(await readStoreReplayGates(store)).toEqual([gates]);
    expect(await readStoreReplayGates(await aCheckoutWith({}))).toEqual([]);
  });

  // So a Replay's results link only a patch that was written (#156).
  it("lists each Replay arm's patch by its path in the store, and none when there are none", async () => {
    const store = await aCheckoutWith({
      "replays/owner/product/140/12-variant-9001.patch": "diff --git a/x b/x\n",
      [replayGatesPath("owner/product", { issue: 140, ticket: 12, arm: "baseline", run: 9001 })]: "{}",
    });

    expect(await readStoreReplayPatches(store)).toEqual(["replays/owner/product/140/12-variant-9001.patch"]);
    expect(await readStoreReplayPatches(await aCheckoutWith({}))).toEqual([]);
  });
});
