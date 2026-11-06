import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leaveFailureReport, streamWatch } from "./launch.ts";

const line = (message: unknown) => JSON.stringify(message);
const init = line({ type: "system", subtype: "init", apiKeySource: "none" });
const assistant = line({ type: "assistant", message: { content: [{ type: "text", text: "Working on it" }] } });

const OVERAGE_SIGNALS: readonly (readonly [string, string])[] = [
  [
    "a rate-limit event using overage",
    line({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day", isUsingOverage: true } }),
  ],
  ["a message with overage in use", line({ type: "system", subtype: "status", overageInUse: true })],
  [
    "a rate-limit event of the overage type",
    line({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "overage" } }),
  ],
];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fabrik-stream-watch-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function watching(lines: readonly string[], options?: { rotation: boolean }) {
  const abort = new AbortController();
  const watch = streamWatch(join(dir, "transcript.jsonl"), abort, options);
  for (const text of lines) watch.onAgentStreamEvent({ type: "raw", line: text, iteration: 1, timestamp: new Date() });
  return { abort, watch };
}

describe("The stream watch", () => {
  it("aborts a run whose init message the metered-billing check refuses", () => {
    const { abort } = watching([line({ type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" })]);

    expect(abort.signal.aborted).toBe(true);
  });

  it("lets a run whose stream shows no overage go on, with rotation on", () => {
    const { abort } = watching(
      [init, assistant, line({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day", isUsingOverage: false } })],
      { rotation: true },
    );

    expect(abort.signal.aborted).toBe(false);
  });

  it.each(OVERAGE_SIGNALS)("aborts the run on %s, with rotation on", (_, overage) => {
    const { abort } = watching([init, assistant, overage], { rotation: true });

    expect(abort.signal.aborted).toBe(true);
  });

  it.each(OVERAGE_SIGNALS)("lets the run go on after %s, with rotation off", (_, overage) => {
    const { abort } = watching([init, assistant, overage], { rotation: false });

    expect(abort.signal.aborted).toBe(false);
  });

  it.each(OVERAGE_SIGNALS)("lets the run go on after %s, when it isn't told rotation is on", (_, overage) => {
    const { abort } = watching([init, assistant, overage]);

    expect(abort.signal.aborted).toBe(false);
  });

  it("keeps the whole stream in the transcript, the overage line included", async () => {
    const overage = OVERAGE_SIGNALS[0]?.[1] ?? "";
    watching([init, overage], { rotation: true });

    expect(await readFile(join(dir, "transcript.jsonl"), "utf8")).toBe(`${init}\n${overage}\n`);
  });
});

describe("The failure report an overage abort leaves", () => {
  it.each(OVERAGE_SIGNALS)("is usage-credits after %s", async (_, overage) => {
    const { abort, watch } = watching([init, assistant, overage], { rotation: true });
    const path = join(dir, "agent-failure.json");

    await leaveFailureReport(abort.signal.reason, watch, { path, title: "Infrastructure failure" });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      failure: "usage-credits",
      detail: expect.stringContaining("usage credits"),
    });
  });

  it("is usage-credits even when the run had also hit a rejected rate limit", async () => {
    const { abort, watch } = watching(
      [
        init,
        line({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "overage" } }),
        line({ type: "result", subtype: "success", is_error: true, result: "API Error" }),
      ],
      { rotation: true },
    );
    const path = join(dir, "agent-failure.json");

    await leaveFailureReport(abort.signal.reason, watch, { path, title: "Infrastructure failure" });

    expect(JSON.parse(await readFile(path, "utf8")).failure).toBe("usage-credits");
  });

  it("isn't usage-credits with rotation off, where the stream watch kills nothing", async () => {
    const { watch } = watching([init, OVERAGE_SIGNALS[1]?.[1] ?? ""], { rotation: false });
    const path = join(dir, "agent-failure.json");

    await leaveFailureReport(new Error("agent exited 1"), watch, { path, title: "Infrastructure failure" });

    expect(JSON.parse(await readFile(path, "utf8")).failure).toBe("crash");
  });
});
