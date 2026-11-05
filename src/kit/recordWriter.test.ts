import { describe, expect, it } from "vitest";
import { GitHubError } from "../github/client.ts";
import type { RunRecord, RunRecordFiles } from "./runRecord.ts";
import { recordWriteSummary, writeRunRecord } from "./recordWriter.ts";

const RECORD_PATH = "runs/acme/widgets/2026-11/9001-1-triage.json";
const TRANSCRIPT_PATH = "transcripts/acme/widgets/2026-11/9001-1-triage.jsonl.gz";
const TRANSCRIPT = new Uint8Array([0x1f, 0x8b, 8, 0]);

/** The record a passing Triage run on #12 gets; only its path and content matter here. */
function files(overrides: Partial<RunRecordFiles> = {}): RunRecordFiles {
  const record = { schema: 1, repo: "acme/widgets", runId: 9001, runAttempt: 1, role: "triage", issue: 12 } as unknown as RunRecord;
  return { record, recordPath: RECORD_PATH, transcriptPath: TRANSCRIPT_PATH, ...overrides };
}

/**
 * The fabrik-runs store through the Contents API: its visibility, the files it
 * already holds, how many parallel commits beat each write to a path, and the
 * paths it refuses (422) for some other reason. Its 422 for a file already
 * there says nothing of a `sha`: the writer looks rather than reading the text.
 */
function storeWith(options: { private?: boolean; files?: string[]; conflicts?: Record<string, number>; refused?: string[] } = {}) {
  const held = new Map<string, string>((options.files ?? []).map((path) => [path, "earlier"]));
  const conflicts = { ...options.conflicts };
  const writes: string[] = [];
  return {
    held,
    writes,
    async rest(method: string, path: string, body?: unknown): Promise<unknown> {
      if (method === "GET" && path === "/repos/jrey8343/fabrik-runs") return { private: options.private ?? true };
      const contents = /^\/repos\/jrey8343\/fabrik-runs\/contents\/(.+)$/.exec(path);
      if (method === "GET" && contents !== null) {
        const file = decodeURIComponent(contents[1] ?? "");
        if (!held.has(file)) throw new GitHubError(`GET ${path} failed: 404 Not Found`, 404);
        return { path: file, sha: "s".repeat(40) };
      }
      const put = contents;
      if (method === "PUT" && put !== null) {
        const file = decodeURIComponent(put[1] ?? "");
        const { content, sha } = body as { content: string; sha?: string };
        writes.push(file);
        if ((conflicts[file] ?? 0) > 0) {
          conflicts[file] = (conflicts[file] ?? 0) - 1;
          throw new GitHubError(`PUT ${path} failed: 409 is at abc but expected def`, 409);
        }
        if ((held.has(file) && sha === undefined) || (options.refused ?? []).includes(file)) {
          throw new GitHubError(`PUT ${path} failed: 422 Invalid request.`, 422);
        }
        held.set(file, content);
        return { content: { path: file } };
      }
      throw new Error(`Unexpected call: ${method} ${path}`);
    },
  };
}

const noWait = async () => {};

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
        "Run fabrik-setup to create the store, then install the Fabrik App on jrey8343/fabrik-runs.",
    );
  });

  it("says why nothing was written to a store that isn't private", () => {
    expect(recordWriteSummary({ kind: "public-store" })).toBe(
      "No Run record written: jrey8343/fabrik-runs isn't private, and records never go to a store others can read. Make it private.",
    );
  });

  it("says no agent run ended when there's no record", () => {
    expect(recordWriteSummary({ kind: "no-record" })).toBe("No Run record: no agent run ended in this run.");
  });

  it("names what was written and what the store already held", () => {
    expect(recordWriteSummary({ kind: "written", written: [RECORD_PATH], existing: [TRANSCRIPT_PATH] })).toBe(
      `Run record written to jrey8343/fabrik-runs: ${RECORD_PATH}. Already there, left as it was: ${TRANSCRIPT_PATH}.`,
    );
  });
});
