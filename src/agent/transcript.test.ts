import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readTranscriptGzip, transcriptWriter } from "./transcript.ts";

describe("the agent's transcript", () => {
  it("holds every stream line in order, each on disk as soon as it arrives", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "fabrik-transcript-")), "transcript.jsonl");
    const write = transcriptWriter(path);

    write('{"type":"system","subtype":"init"}');
    // A job killed at its timeout runs no finally, so what arrived must already be there.
    expect(await readFile(path, "utf8")).toBe('{"type":"system","subtype":"init"}\n');

    write('{"type":"assistant"}');
    write('{"type":"result"}');
    expect(await readFile(path, "utf8")).toBe(
      ['{"type":"system","subtype":"init"}', '{"type":"assistant"}', '{"type":"result"}', ""].join("\n"),
    );
  });
});

describe("reading back the gzipped transcript", () => {
  const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ type: "assistant", turn: i, text: `turn ${i} `.repeat(20) }));
  const gzip = gzipSync(`${lines.join("\n")}\n`);

  it("gives every line of a whole transcript, and the gzip as it came", () => {
    expect(readTranscriptGzip(gzip)).toEqual({ lines, gzip });
  });

  it("keeps the whole lines of a transcript a timeout cut off, gzipped again so the store's copy opens", () => {
    const cut = gzip.subarray(0, Math.floor(gzip.length / 2));

    const read = readTranscriptGzip(cut);

    expect(read).not.toBeNull();
    expect(read!.lines.length).toBeGreaterThan(0);
    expect(read!.lines.length).toBeLessThan(lines.length);
    expect(read!.lines).toEqual(lines.slice(0, read!.lines.length));
    expect(gunzipSync(read!.gzip).toString("utf8")).toBe(`${read!.lines.join("\n")}\n`);
  });

  it("gives no transcript for bytes that aren't gzip at all", () => {
    expect(readTranscriptGzip(Buffer.from("not a gzip"))).toBeNull();
  });

  it("gives no transcript when the cut came before a whole line", () => {
    expect(readTranscriptGzip(Buffer.alloc(0))).toBeNull();
    expect(readTranscriptGzip(gzip.subarray(0, 12))).toBeNull();
  });
});
