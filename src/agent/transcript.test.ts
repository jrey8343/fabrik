import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { transcriptWriter } from "./transcript.ts";

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
