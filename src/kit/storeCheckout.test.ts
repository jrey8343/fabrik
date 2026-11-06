import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { aRecordWithTranscript } from "../__fixtures__/retroEvidence.ts";
import { aScoreFile } from "../__fixtures__/weeklySummary.ts";
import { recordPathOf } from "./runRecord.ts";
import { readStoreRunRecords, readStoreScoreFiles, readStoreTranscripts } from "./storeCheckout.ts";

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

  it("reads every Run record at the current schema and every schema 1 score file, each by its path in the store", async () => {
    const store = await aCheckoutWith({
      [recordPathOf(record)]: JSON.stringify(record),
      "runs/owner/product/2026-11/1002-1-triage.json": JSON.stringify({ ...record, schema: 5 }),
      [scorePath]: JSON.stringify(aScoreFile()),
      "scores/owner/product/2026-11/1003-1-implement-def456.json": JSON.stringify({ ...aScoreFile(), schema: 2 }),
    });

    expect(await readStoreRunRecords(store, ["Claude token", "Claude token 2"])).toEqual({ [recordPathOf(record)]: record });
    expect(await readStoreScoreFiles(store)).toEqual({ [scorePath]: aScoreFile() });
  });

  it("reads a schema 1 Run record, written before runs were given a Subscription, as on the first listed one", async () => {
    const { subscription: _, ...unnamed } = record;
    const store = await aCheckoutWith({ [recordPathOf(record)]: JSON.stringify({ ...unnamed, schema: 1 }) });

    expect(await readStoreRunRecords(store, ["Claude token 2", "Claude token"])).toEqual({
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

    expect(await readStoreRunRecords(store, ["Claude token"])).toEqual({});
    expect(await readStoreScoreFiles(store)).toEqual({});
    expect((await readStoreTranscripts(store))(record.transcript!)).toBeNull();
  });
});
